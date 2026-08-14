/**
 * Regression tests for PF-101 / TRO-406 — OAuth schema, migrations 042 + 043.
 *
 * AC (PLUGFORGE.MD §4, PF-101): "migrations apply cleanly on a fresh DB and on
 * a prod-shaped DB; `\d` evidence in gate output." Per the test-design comment
 * on TRO-406, this ticket is migration DDL, so the tests are migration-apply
 * assertions plus schema-shape checks (information_schema/pg_indexes), not
 * behavioral tests — TTL/enforcement behavior (access 1h / refresh 30d / codes
 * 10min) is application logic owned by PF-104/PF-105/PF-106 and is NOT
 * asserted here; this ticket only needs the columns that will carry those
 * values to exist.
 *
 * Both suites run the REAL migration runner (`runMigrations`, the function
 * behind `pnpm db:migrate`) against a throwaway database built from real
 * migration files copied off disk — never raw SQL executed by the test —
 * specifically so DB-1's silent-skip failure mode (exits 0 while
 * under-applying) is actually exercised rather than assumed away. Success is
 * read from `schema_migrations` and `information_schema`, never inferred from
 * the runner merely not throwing.
 *
 * Pattern (throwaway-database helpers, migrationsDirExcluding) copied from
 * db-6-7-8-10-indexes.test.ts / migrationRunner.test.ts — see those files for
 * the full rationale on random database names and identifier validation.
 */
import { createHash, randomBytes } from 'crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrationRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');
const SCHEMA_PATH = join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

const HOOK_TIMEOUT = 120_000;

// The two migrations under test (PF-101 / TRO-406's own).
const OAUTH_VERSIONS = ['042_oauth_apps', '043_oauth_tokens_and_codes'];

// Later migrations that ALTER a table 043 creates (oauth_tokens,
// oauth_device_codes, ...) and therefore cannot apply before it — must be
// excluded from the "prior, nothing from oauth yet" AC-2 fixture below for
// the same reason 042/043 themselves are excluded there, or that fixture's
// own setup step fails trying to alter a table that doesn't exist yet.
// Added by PF-104/TRO-416 (`044_oauth_tokens_authorization_code_id`, which
// adds `oauth_tokens.authorization_code_id`) after its migration broke this
// pre-existing test — `044`'s own migration-number-collision comment records
// why 044 was available to take. Extended by PF-105/TRO-421
// (`045_oauth_tokens_refresh_expiry`, which adds
// `oauth_tokens.refresh_token_expires_at`) for the identical reason — same
// grep-for-other-implementations discipline lessons.md's rule about a
// duplicate implementation of a hardened rule calls for, applied here to a
// hardened *test fixture* rather than production code. Further extended by
// PF-106/TRO-425 (`046_oauth_device_codes_polling`, which adds
// `oauth_device_codes.last_polled_at`/`token_issued_at` — originally
// numbered 045, renumbered to 046 because TRO-421/PF-105 independently
// claimed 045 first; see CHANGES.md) for the identical reason: it ALTERs
// `oauth_device_codes`, also created by 043. Extended again by PF-302/TRO-431
// (`047_webhook_subscriptions`, which CREATEs `webhook_subscriptions.app_id
// REFERENCES oauth_apps(id)`) — same reasoning, one step removed: it doesn't
// ALTER a 043 table, it FK-references `oauth_apps` (042's own table), so it
// equally cannot apply against the "prior, nothing from oauth yet" fixture
// below. Kept separate from `OAUTH_VERSIONS` above (which names PF-101's own
// two migrations specifically, and is used below in assertions scoped to
// just those two) — extend THIS list, not that one, whenever a later ticket
// adds another migration that depends on a table 042 or 043 creates.
const LATER_OAUTH_TOKENS_DEPENDENT_VERSIONS = [
  '044_oauth_tokens_authorization_code_id',
  '045_oauth_tokens_refresh_expiry',
  '046_oauth_device_codes_polling',
  '047_webhook_subscriptions',
];

/** Same helper shape as migrationRunner.test.ts — see that file for the full rationale. */
function databaseNames(): { adminUrl: string; urlFor: (name: string) => string; base: string } {
  const source = process.env.DATABASE_URL;
  if (!source) {
    throw new Error('DATABASE_URL must be set; this test creates a throwaway database beside it.');
  }
  const base = new URL(source).pathname.replace(/^\//, '');
  const urlFor = (name: string) => {
    const u = new URL(source);
    u.pathname = `/${name}`;
    return u.toString();
  };
  return { adminUrl: urlFor('postgres'), urlFor, base };
}

const MAX_IDENTIFIER_BYTES = 63;

function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Refusing to interpolate unsafe database identifier: ${name}`);
  }
  return name;
}

const { adminUrl, urlFor, base } = databaseNames();

function throwawayDatabaseName(role: string): string {
  const tail = `_${role}_${randomBytes(6).toString('hex')}`;
  const head = base.slice(0, MAX_IDENTIFIER_BYTES - tail.length);
  return assertSafeIdentifier(`${head}${tail}`);
}

async function createDatabase(name: string): Promise<void> {
  assertSafeIdentifier(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  assertSafeIdentifier(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

/** Copies every real migration file except the given version prefixes into a fresh temp dir. */
function migrationsDirExcluding(excludeVersions: string[]): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'tro406-migrations-'));
  const dir = join(fixtureRoot, 'migrations');
  mkdirSync(dir);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (excludeVersions.includes(version)) continue;
    cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return fixtureRoot;
}

const silent = () => {};

/**
 * Narrows a possibly-empty pg result to its single row, throwing loudly if
 * the query didn't return exactly one. `noUncheckedIndexedAccess` types
 * `rows[0]` as `T | undefined`; this is the destructure-and-assert-explicitly
 * alternative to a non-null assertion (`review-patterns.mjs`/G7b forbids `!`).
 */
function onlyRow<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`Expected exactly one row, got ${rows.length}.`);
  }
  return row;
}

describe('oauth schema migrations 042 + 043 (PF-101 / TRO-406)', () => {
  describe('AC-1: fresh database', () => {
    const dbName = throwawayDatabaseName('oauthfresh');
    let pool: pg.Pool;

    beforeAll(async () => {
      await createDatabase(dbName);
      pool = new pg.Pool({ connectionString: urlFor(dbName) });
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await pool?.end();
      await dropDatabase(dbName);
    }, HOOK_TIMEOUT);

    it(
      'applies schema.sql + every migration through 043 cleanly and records 042/043 in schema_migrations',
      async () => {
        const result = await runMigrations(pool, {
          schemaPath: SCHEMA_PATH,
          migrationsDir: MIGRATIONS_DIR,
          log: silent,
        });

        // DB-1's exact failure mode was "exits 0 while under-applying" — assert
        // the runner's OWN applied list, never just that the call didn't throw.
        expect(result.applied, 'runner should report 042 as applied, not silently skipped').toContain(
          '042_oauth_apps'
        );
        expect(
          result.applied,
          'runner should report 043 as applied, not silently skipped'
        ).toContain('043_oauth_tokens_and_codes');

        const recorded = await pool.query<{ version: string }>(
          'SELECT version FROM schema_migrations WHERE version = ANY($1)',
          [OAUTH_VERSIONS]
        );
        expect(recorded.rows.map((r) => r.version).sort()).toEqual([...OAUTH_VERSIONS].sort());
      },
      HOOK_TIMEOUT
    );

    it(
      'creates all four new OAuth tables',
      async () => {
        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = ANY($1)`,
          [['oauth_apps', 'oauth_authorization_codes', 'oauth_tokens', 'oauth_device_codes']]
        );
        expect(tables.rows.map((r) => r.table_name).sort()).toEqual(
          ['oauth_apps', 'oauth_authorization_codes', 'oauth_device_codes', 'oauth_tokens'].sort()
        );
      },
      HOOK_TIMEOUT
    );

    it(
      'adds api_tokens.scopes as a nullable text array column',
      async () => {
        const col = await pool.query<{ data_type: string; udt_name: string; is_nullable: string }>(
          `SELECT data_type, udt_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'api_tokens' AND column_name = 'scopes'`
        );
        expect(col.rows, 'api_tokens.scopes should exist').toHaveLength(1);
        const row = onlyRow(col.rows);
        expect(row.data_type).toBe('ARRAY');
        expect(row.udt_name).toBe('_text');
        // §2.2: "null = legacy unscoped internal token (unchanged behavior)"
        expect(row.is_nullable).toBe('YES');
      },
      HOOK_TIMEOUT
    );
  });

  describe('AC-2: prod-shaped database (migrations 001-041 already applied, pre-existing api_tokens row)', () => {
    const dbName = throwawayDatabaseName('oauthprod');
    let pool: pg.Pool;
    let priorMigrationsFixtureRoot: string;
    let preExistingTokenId: string;

    beforeAll(async () => {
      await createDatabase(dbName);
      pool = new pg.Pool({ connectionString: urlFor(dbName) });

      // "Prod-shaped": every migration through 041 already applied, nothing
      // from this ticket yet — the real state of an existing Ship database
      // the moment before this migration deploys. Real files copied off disk
      // (never hand-written SQL), same discipline as db-6-7-8-10-indexes.test.ts.
      priorMigrationsFixtureRoot = migrationsDirExcluding([
        ...OAUTH_VERSIONS,
        ...LATER_OAUTH_TOKENS_DEPENDENT_VERSIONS,
      ]);
      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: join(priorMigrationsFixtureRoot, 'migrations'),
        log: silent,
      });

      // A pre-existing api_tokens row, inserted BEFORE 043 runs — proves the
      // `ALTER TABLE api_tokens ADD COLUMN scopes` is safe against a non-empty
      // table. This is the actual distinction "prod-shaped" adds over "fresh".
      const workspace = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ('TRO-406 prod-shaped fixture workspace') RETURNING id`
      );
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ('tro-406-fixture@example.gov', 'TRO-406 Fixture User') RETURNING id`
      );
      const token = await pool.query<{ id: string }>(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
         VALUES ($1, $2, 'Pre-existing legacy token', $3, 'legacy1')
         RETURNING id`,
        [
          onlyRow(user.rows).id,
          onlyRow(workspace.rows).id,
          createHash('sha256').update('tro-406-fixture-token').digest('hex'),
        ]
      );
      preExistingTokenId = onlyRow(token.rows).id;
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await pool?.end();
      await dropDatabase(dbName);
      if (priorMigrationsFixtureRoot) rmSync(priorMigrationsFixtureRoot, { recursive: true, force: true });
    }, HOOK_TIMEOUT);

    it(
      'applies 042/043 on top of an already-migrated database and records them',
      async () => {
        const result = await runMigrations(pool, {
          schemaPath: SCHEMA_PATH,
          migrationsDir: MIGRATIONS_DIR,
          log: silent,
        });

        // `toContain`, not an exact-equals on `result.applied`: this run
        // uses the REAL, full `MIGRATIONS_DIR` (not a filtered copy), so any
        // later oauth_tokens-dependent migration excluded from the prior
        // fixture above (044, today) legitimately applies in this same run
        // too — that migration's own AC is proven separately
        // (`migrations-044-*.test.ts` if/when PF-104 adds one), not here.
        // This test's job is specifically "042/043 applied, not silently
        // skipped" (DB-1's failure mode), which `toContain` still proves.
        expect(result.applied, 'runner should apply 042').toContain('042_oauth_apps');
        expect(result.applied, 'runner should apply 043').toContain('043_oauth_tokens_and_codes');
        expect(result.alreadyApplied).not.toContain('042_oauth_apps');
        expect(result.alreadyApplied).not.toContain('043_oauth_tokens_and_codes');

        const recorded = await pool.query<{ version: string }>(
          'SELECT version FROM schema_migrations WHERE version = ANY($1)',
          [OAUTH_VERSIONS]
        );
        expect(recorded.rows.map((r) => r.version).sort()).toEqual([...OAUTH_VERSIONS].sort());
      },
      HOOK_TIMEOUT
    );

    it(
      'leaves the pre-existing api_tokens row unchanged in its other columns, with scopes IS NULL',
      async () => {
        const row = await pool.query<{ name: string; token_prefix: string; scopes: string[] | null }>(
          'SELECT name, token_prefix, scopes FROM api_tokens WHERE id = $1',
          [preExistingTokenId]
        );
        expect(row.rows).toHaveLength(1);
        const fixtureRow = onlyRow(row.rows);
        expect(fixtureRow.name).toBe('Pre-existing legacy token');
        expect(fixtureRow.token_prefix).toBe('legacy1');
        expect(fixtureRow.scopes).toBeNull();
      },
      HOOK_TIMEOUT
    );

    it(
      'creates unique indexes on oauth_apps.client_id, every oauth token-hash column, and oauth_device_codes.user_code',
      async () => {
        const uniqueIndexNames = [
          'idx_oauth_apps_client_id',
          'idx_oauth_authorization_codes_code_hash',
          'idx_oauth_tokens_access_token_hash',
          'idx_oauth_tokens_refresh_token_hash',
          'idx_oauth_device_codes_device_code_hash',
          'idx_oauth_device_codes_user_code',
        ];

        for (const indexName of uniqueIndexNames) {
          const index = await pool.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
            [indexName]
          );
          expect(index.rows, `${indexName} should exist`).toHaveLength(1);
          const indexRow = onlyRow(index.rows);
          expect(indexRow.indexdef.toUpperCase(), `${indexName} should be UNIQUE`).toContain(
            'UNIQUE INDEX'
          );
        }
      },
      HOOK_TIMEOUT
    );

    it(
      'creates FK-lookup indexes on oauth_apps.owner_user_id, oauth_authorization_codes.user_id, ' +
        'oauth_tokens.parent_id, and oauth_device_codes.user_id (CodeRabbit finding, PF-101)',
      async () => {
        const fkIndexNames = [
          'idx_oauth_apps_owner_user_id',
          'idx_oauth_authorization_codes_user_id',
          'idx_oauth_tokens_parent_id',
          'idx_oauth_device_codes_user_id',
        ];

        for (const indexName of fkIndexNames) {
          const index = await pool.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
            [indexName]
          );
          expect(index.rows, `${indexName} should exist`).toHaveLength(1);
        }
      },
      HOOK_TIMEOUT
    );
  });
});
