/**
 * Regression tests for DB-1 / TRO-178.
 *
 * The bug: runMigrations() wrapped BOTH the schema.sql application and the
 * migration loop in one try/catch whose handler matched any error message
 * containing "already exists". A non-idempotent migration (010_oauth_state.sql
 * re-creating a table schema.sql had already created) therefore looked like a
 * benign schema.sql re-run: the handler logged "Database schema already
 * exists, continuing...", returned normally, and abandoned the remaining 32
 * migration files while the process exited 0.
 *
 * These tests run against throwaway databases created from DATABASE_URL, never
 * against DATABASE_URL itself.
 */
import { randomBytes } from 'crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

/**
 * Database names cannot be bound as query parameters, so they are interpolated.
 * Derive them from DATABASE_URL and validate against a strict identifier
 * pattern before any of them reaches a CREATE/DROP DATABASE statement.
 */
function databaseNames(): { adminUrl: string; urlFor: (name: string) => string; base: string } {
  const source = process.env.DATABASE_URL;
  if (!source) {
    throw new Error('DATABASE_URL must be set; these tests create throwaway databases beside it.');
  }
  const base = new URL(source).pathname.replace(/^\//, '');
  const urlFor = (name: string) => {
    const u = new URL(source);
    u.pathname = `/${name}`;
    return u.toString();
  };
  return { adminUrl: urlFor('postgres'), urlFor, base };
}

/** Postgres identifiers are limited to 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63;

function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Refusing to interpolate unsafe database identifier: ${name}`);
  }
  return name;
}

const { adminUrl, urlFor, base } = databaseNames();

/**
 * A fresh, unguessable database name per suite run.
 *
 * Deliberately random rather than derived-and-fixed. A deterministic name is
 * safe against *other* tickets — it is prefixed with this worktree's own
 * exclusive database — but it collides with itself: two runs of this suite at
 * once (a gate run alongside a manual one) would have the second run drop and
 * recreate the database the first is still using. A random name per run cannot
 * do that to anybody, including me.
 */
function throwawayDatabaseName(role: string): string {
  const tail = `_${role}_${randomBytes(6).toString('hex')}`;
  const head = base.slice(0, MAX_IDENTIFIER_BYTES - tail.length);
  return assertSafeIdentifier(`${head}${tail}`);
}

/**
 * The name is generated, never taken from input, and still validated before
 * interpolation — database identifiers cannot be bound as query parameters, so
 * validation is the only thing standing between this and injection.
 */
async function createDatabase(name: string): Promise<void> {
  assertSafeIdentifier(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // No preceding DROP: a randomly named database cannot already exist, so
    // there is nothing here that could destroy someone else's state.
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

/**
 * No `WITH (FORCE)`. FORCE terminates other sessions, which would turn "my
 * teardown found an unexpected connection" into "my teardown disconnected
 * something and deleted its database". If a drop fails because a client is
 * still attached, that is a fact worth surfacing.
 */
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

/**
 * Versions recorded in schema_migrations, sorted in JS rather than left in the
 * order Postgres's `ORDER BY` returned them.
 *
 * Why: Postgres's default collation and JavaScript's `Array.prototype.sort()`
 * disagree on at least one pair of migration names — `020_document_associations`
 * vs `020b_sprint_assignee_ids`. Postgres orders `020b_...` first; JS orders
 * `020_...` first (observed directly: `SELECT v FROM (VALUES
 * ('020_document_associations'),('020b_sprint_assignee_ids')) t(v) ORDER BY v`
 * returns 020b first, while `[...].sort()` on the same two strings returns
 * 020_ first). The callers below compare this result against
 * `expectedVersionsFromDisk()`, which is JS-sorted — so leaving this list in
 * SQL order made the comparison collation-dependent instead of correctness-
 * dependent, and it failed on a migration set that was actually complete.
 *
 * Sorting here (not by dropping the SQL `ORDER BY`, which stays for anyone
 * reading the query in isolation) makes both sides of every comparison use the
 * same JS collation, while the comparison itself stays a strict, ordered
 * `toEqual` — still full identity, not a count or a subset check, so a runner
 * that skips or duplicates a migration still fails it.
 */
async function recordedVersions(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return res.rows.map(r => r.version).sort();
}

/**
 * Expected migration versions, read straight off disk.
 *
 * Deliberately NOT via listMigrationFiles(): that is a function under test
 * here, and deriving the expectation from it would make a wrong implementation
 * agree with an equally wrong expectation and still report green.
 */
function expectedVersionsFromDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.replace(/\.sql$/, ''))
    .sort();
}

const silent = () => {};

describe('migration runner — real migration set (DB-1 / TRO-178)', () => {
  const dbName = throwawayDatabaseName('migset');
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
    'applies every migration file against a fresh database',
    async () => {
      const expected = expectedVersionsFromDisk();
      expect(
        expected.length,
        'the migrations directory should contain migration files to apply'
      ).toBeGreaterThan(10);

      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: MIGRATIONS_DIR,
        log: silent,
      });

      // Compare by identity, not count: a count check would let a runner that
      // applied a different subset of the same size through.
      expect(await recordedVersions(pool)).toEqual([...expected].sort());
    },
    HOOK_TIMEOUT
  );

  it(
    'is a clean no-op on a second invocation, not a silent abandon',
    async () => {
      const expected = expectedVersionsFromDisk();

      const result = await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: MIGRATIONS_DIR,
        log: silent,
      });

      expect(result.applied).toEqual([]);
      expect(await recordedVersions(pool)).toEqual([...expected].sort());
    },
    HOOK_TIMEOUT
  );
});

describe('migration runner — error handling (DB-1 / TRO-178)', () => {
  const dbName = throwawayDatabaseName('migfail');
  let pool: pg.Pool;
  let fixtureRoot: string;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });

    fixtureRoot = mkdtempSync(join(tmpdir(), 'tro178-migrations-'));
    mkdirSync(join(fixtureRoot, 'migrations'));
    // An idempotent stand-in for schema.sql.
    writeFileSync(
      join(fixtureRoot, 'schema.sql'),
      'CREATE TABLE IF NOT EXISTS tro178_schema_marker (id INT);\n'
    );
    writeFileSync(
      join(fixtureRoot, 'migrations', '001_first.sql'),
      'CREATE TABLE tro178_widget (id INT);\n'
    );
    // Fails with: relation "tro178_widget" already exists — the exact message
    // class the old catch treated as benign.
    writeFileSync(
      join(fixtureRoot, 'migrations', '002_conflicts.sql'),
      'CREATE TABLE tro178_widget (id INT);\n'
    );
    writeFileSync(
      join(fixtureRoot, 'migrations', '003_after_the_failure.sql'),
      'CREATE TABLE tro178_after (id INT);\n'
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  }, HOOK_TIMEOUT);

  it(
    'rejects when a migration fails with an "already exists" error instead of swallowing it',
    async () => {
      await expect(
        runMigrations(pool, {
          schemaPath: join(fixtureRoot, 'schema.sql'),
          migrationsDir: join(fixtureRoot, 'migrations'),
          log: silent,
        })
      ).rejects.toThrow(/already exists/);

      // The failing migration must not be recorded, and the run must not have
      // pretended the later migrations were unnecessary.
      const recorded = await recordedVersions(pool);
      expect(recorded).toContain('001_first');
      expect(recorded).not.toContain('002_conflicts');
      expect(recorded).not.toContain('003_after_the_failure');

      const after = await pool.query<{ present: string | null }>(
        "SELECT to_regclass('public.tro178_after') AS present"
      );
      const [afterRow] = after.rows;
      expect(afterRow, 'to_regclass should return exactly one row').toBeDefined();
      expect(
        afterRow?.present,
        'migration 003 must not have been applied after 002 failed'
      ).toBeNull();
    },
    HOOK_TIMEOUT
  );

  it(
    'rejects when the migrations directory cannot be read, rather than applying nothing',
    async () => {
      // "No migrations to run" and "I could not find out what to run" must not
      // look the same: the second reported as success is DB-1 in another form.
      await expect(
        runMigrations(pool, {
          schemaPath: join(fixtureRoot, 'schema.sql'),
          migrationsDir: join(fixtureRoot, 'no-such-directory'),
          log: silent,
        })
      ).rejects.toThrow(/ENOENT|no such file or directory/i);
    },
    HOOK_TIMEOUT
  );

  it(
    'rejects a migrations directory containing an unnumbered file, before applying anything',
    async () => {
      // Ordering is the only correctness guarantee a migration sequence has.
      // 'hotfix.sql' sorts after every numbered file and would silently run
      // last; the run must refuse instead of picking an order.
      const root = mkdtempSync(join(tmpdir(), 'tro178-badname-'));
      try {
        mkdirSync(join(root, 'migrations'));
        writeFileSync(
          join(root, 'schema.sql'),
          'CREATE TABLE IF NOT EXISTS tro178_badname_marker (id INT);\n'
        );
        writeFileSync(
          join(root, 'migrations', '001_ok.sql'),
          'CREATE TABLE IF NOT EXISTS tro178_badname_ok (id INT);\n'
        );
        writeFileSync(
          join(root, 'migrations', 'hotfix.sql'),
          'CREATE TABLE IF NOT EXISTS tro178_badname_hotfix (id INT);\n'
        );

        await expect(
          runMigrations(pool, {
            schemaPath: join(root, 'schema.sql'),
            migrationsDir: join(root, 'migrations'),
            log: silent,
          })
        ).rejects.toThrow(/hotfix\.sql/);

        // Validation happens before the loop, so even the well-named migration
        // must not have been applied.
        const ok = await pool.query<{ present: string | null }>(
          "SELECT to_regclass('public.tro178_badname_ok') AS present"
        );
        const [okRow] = ok.rows;
        expect(okRow, 'to_regclass should return exactly one row').toBeDefined();
        expect(
          okRow?.present,
          'no migration should be applied from a directory that failed validation'
        ).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT
  );

  it(
    'refuses to report success when a rolled-back schema batch applied nothing',
    async () => {
      // pool.query sends schema.sql as one simple query, so Postgres runs it as
      // a single implicit transaction: a duplicate-object error at any statement
      // discards the whole batch. Tolerating that and returning normally — which
      // this runner used to do — is DB-1 inside the DB-1 fix.
      //
      // This test replaces one that asserted the opposite ("still tolerates
      // duplicate-object errors raised by schema.sql itself"). That assertion
      // described the defect: it passed precisely because nothing was applied
      // and nobody was told.
      const root = mkdtempSync(join(tmpdir(), 'tro178-schema-'));
      try {
        mkdirSync(join(root, 'migrations'));
        // First statement is non-idempotent, second is the object that a silent
        // rollback would quietly fail to create.
        writeFileSync(
          join(root, 'schema.sql'),
          'CREATE TABLE tro178_dup (id INT);\n' +
            'CREATE TABLE IF NOT EXISTS tro178_rollback_victim (id INT);\n'
        );
        const options = {
          schemaPath: join(root, 'schema.sql'),
          migrationsDir: join(root, 'migrations'),
          log: silent,
        };

        // Pass 1 creates both tables and succeeds.
        await runMigrations(pool, options);
        await pool.query('DROP TABLE tro178_rollback_victim');

        // Pass 2: 'CREATE TABLE tro178_dup' now conflicts, the batch rolls back,
        // and tro178_rollback_victim is therefore NOT recreated. The run must
        // fail rather than claim success for work it did not do.
        await expect(runMigrations(pool, options)).rejects.toThrow(/already exists/);

        const victim = await pool.query<{ present: string | null }>(
          "SELECT to_regclass('public.tro178_rollback_victim') AS present"
        );
        const [victimRow] = victim.rows;
        expect(victimRow, 'to_regclass should return exactly one row').toBeDefined();
        expect(
          victimRow?.present,
          'the rolled-back batch really did apply nothing — which is why it must not report success'
        ).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT
  );

  it(
    'creates objects that are still missing when earlier ones already exist',
    async () => {
      // The invariant a silent rollback breaks: applying the schema to a
      // partially-populated database must still create what is absent. This is
      // green today because schema.sql is idempotent, and it fails the moment a
      // non-idempotent statement is added while the error is being tolerated.
      const root = mkdtempSync(join(tmpdir(), 'tro178-partial-'));
      try {
        mkdirSync(join(root, 'migrations'));
        await pool.query('CREATE TABLE IF NOT EXISTS tro178_partial_existing (id INT)');
        await pool.query('DROP TABLE IF EXISTS tro178_partial_missing');

        writeFileSync(
          join(root, 'schema.sql'),
          'CREATE TABLE IF NOT EXISTS tro178_partial_existing (id INT);\n' +
            'CREATE TABLE IF NOT EXISTS tro178_partial_missing (id INT);\n'
        );

        await runMigrations(pool, {
          schemaPath: join(root, 'schema.sql'),
          migrationsDir: join(root, 'migrations'),
          log: silent,
        });

        const created = await pool.query<{ present: string | null }>(
          "SELECT to_regclass('public.tro178_partial_missing') AS present"
        );
        const [createdRow] = created.rows;
        expect(createdRow, 'to_regclass should return exactly one row').toBeDefined();
        expect(
          createdRow?.present,
          'the object that did not exist yet must have been created'
        ).not.toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT
  );
});
