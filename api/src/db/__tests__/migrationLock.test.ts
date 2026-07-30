/**
 * Regression tests for DB-12 / TRO-279.
 *
 * The bug: `CREATE TABLE IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`) is
 * check-then-create and not atomic. Two `pnpm db:migrate` processes racing
 * against the same fresh database can both pass the existence check and both
 * attempt the create; one loses on the catalog's unique index
 * (`pg_type_typname_nsp_index`, SQLSTATE 23505). Because applySchema used to
 * run schema.sql as a single implicit transaction, a duplicate-object error
 * partway through rolled the whole batch back — so a losing run could apply
 * nothing while still exiting 0 once 42710 landed in the tolerated-error set.
 * `Dockerfile:35` runs migrations on every container boot, so a rolling
 * deploy or scale-out makes this concurrency reachable in production, not
 * just in a test harness.
 *
 * The fix: the whole run (schema.sql + the migration loop) is now wrapped in
 * one Postgres session-level advisory lock, taken before anything else
 * touches the database. A second runner blocks at the lock and only proceeds
 * once the first has fully committed or failed, so it always reads an
 * accurate schema_migrations and finds nothing left to do.
 *
 * These tests run against throwaway databases created from DATABASE_URL,
 * never against DATABASE_URL itself — see databaseNames()/throwawayDatabaseName()
 * below, copied from migrationRunner.test.ts's established pattern.
 */
import { randomBytes } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_ADVISORY_LOCK_KEY, runMigrations } from '../migrationRunner.js';

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
 * A fresh, unguessable database name per suite run — random rather than
 * derived-and-fixed so two concurrent invocations of this suite (a gate run
 * alongside a manual one) cannot collide on the same throwaway database. See
 * migrationRunner.test.ts's identical rationale.
 */
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

/** No `WITH (FORCE)` — see migrationRunner.test.ts's rationale. */
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

async function recordedVersions(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  return res.rows.map(r => r.version);
}

const silent = () => {};

describe('migration runner — concurrent invocations do not race (DB-12 / TRO-279)', () => {
  const dbName = throwawayDatabaseName('lockset');
  let pools: pg.Pool[];

  beforeAll(async () => {
    await createDatabase(dbName);
    // Six separate pools against the same database, one per simulated
    // `pnpm db:migrate` process/container instance — deliberately NOT one
    // shared pool, since the real-world race is between separate OS
    // processes each with their own connection pool.
    pools = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: urlFor(dbName) }));
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await Promise.all(pools?.map(p => p.end()) ?? []);
    await dropDatabase(dbName);
  }, HOOK_TIMEOUT);

  it(
    'six simultaneous runMigrations() calls against one database all succeed, applying every migration exactly once',
    async () => {
      const results = await Promise.allSettled(
        pools.map(pool =>
          runMigrations(pool, { schemaPath: SCHEMA_PATH, migrationsDir: MIGRATIONS_DIR, log: silent })
        )
      );

      const rejections = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(
        rejections.map(r => (r.reason instanceof Error ? r.reason.message : String(r.reason))),
        'all six concurrent runs must exit successfully; the advisory lock should ' +
          'serialize them rather than let any race the catalog'
      ).toEqual([]);

      // One consistent, complete set of applied migrations — not a partial
      // subset any single racing run might have believed was "already there".
      const versions = await recordedVersions(pools[0] as pg.Pool);
      expect(new Set(versions).size, 'no migration version should be recorded twice').toBe(
        versions.length
      );
      expect(versions.length).toBeGreaterThan(10);
    },
    HOOK_TIMEOUT
  );
});

describe('migration runner — advisory lock release (DB-12 / TRO-279)', () => {
  const dbName = throwawayDatabaseName('lockrelease');
  let pool: pg.Pool;
  let failingRoot: string;
  let fixedRoot: string;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });

    // First fixture: schema + one migration that always fails. Used for the
    // deliberately-failing run.
    failingRoot = mkdtempSync(join(tmpdir(), 'tro279-lock-failing-'));
    mkdirSync(join(failingRoot, 'migrations'));
    writeFileSync(
      join(failingRoot, 'schema.sql'),
      'CREATE TABLE IF NOT EXISTS tro279_schema_marker (id INT);\n'
    );
    writeFileSync(
      join(failingRoot, 'migrations', '001_first.sql'),
      'CREATE TABLE tro279_widget (id INT);\n'
    );
    // Non-idempotent by construction: creates the same table 001 just
    // created. Fails every time it is attempted — that is the point.
    writeFileSync(
      join(failingRoot, 'migrations', '002_conflicts.sql'),
      'CREATE TABLE tro279_widget (id INT);\n'
    );

    // Second fixture: same schema, only the migration that actually
    // succeeds. Used for the "successful second run" half of the assertion —
    // 001 will already be recorded from the first run, so this run's job is
    // just to prove it can still acquire the lock and complete cleanly.
    fixedRoot = mkdtempSync(join(tmpdir(), 'tro279-lock-fixed-'));
    mkdirSync(join(fixedRoot, 'migrations'));
    writeFileSync(
      join(fixedRoot, 'schema.sql'),
      'CREATE TABLE IF NOT EXISTS tro279_schema_marker (id INT);\n'
    );
    writeFileSync(join(fixedRoot, 'migrations', '001_first.sql'), 'CREATE TABLE tro279_widget (id INT);\n');
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
    if (failingRoot) rmSync(failingRoot, { recursive: true, force: true });
    if (fixedRoot) rmSync(fixedRoot, { recursive: true, force: true });
  }, HOOK_TIMEOUT);

  it(
    'releases the lock on the error path: a failing run is followed by a successful run against the same database',
    async () => {
      await expect(
        runMigrations(pool, {
          schemaPath: join(failingRoot, 'schema.sql'),
          migrationsDir: join(failingRoot, 'migrations'),
          log: silent,
        })
      ).rejects.toThrow(/already exists/);

      // If the lock leaked on that failure, pg_try_advisory_lock would
      // return false here (someone still holds it) — a deterministic check,
      // not an inference from timing.
      const probe = new pg.Client({ connectionString: urlFor(dbName) });
      await probe.connect();
      let lockWasFree: boolean;
      try {
        const res = await probe.query<{ pg_try_advisory_lock: boolean }>(
          'SELECT pg_try_advisory_lock($1)',
          [MIGRATION_ADVISORY_LOCK_KEY]
        );
        const [row] = res.rows;
        expect(row, 'pg_try_advisory_lock should return exactly one row').toBeDefined();
        lockWasFree = row?.pg_try_advisory_lock ?? false;
        if (lockWasFree) {
          await probe.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
        }
      } finally {
        await probe.end();
      }
      expect(
        lockWasFree,
        'the advisory lock must be free after a failed run, not still held by the failed session'
      ).toBe(true);

      // And a subsequent run against the same (now partially-populated)
      // database, using a migrations directory that no longer contains the
      // broken migration, must be able to acquire the lock and succeed
      // cleanly — the concrete, end-to-end version of the same claim.
      const secondRun = await runMigrations(pool, {
        schemaPath: join(fixedRoot, 'schema.sql'),
        migrationsDir: join(fixedRoot, 'migrations'),
        log: silent,
      });
      // 001 was already recorded by the first (partially successful) run,
      // so this run applies nothing new — but it must complete, not hang.
      expect(secondRun.applied).toEqual([]);
      expect(secondRun.alreadyApplied).toContain('001_first');
    },
    HOOK_TIMEOUT
  );
});

describe('advisory lock semantics this fix depends on (DB-12 / TRO-279)', () => {
  it(
    'releases a session-level advisory lock when the holding session ends, even without an explicit unlock',
    async () => {
      // This is the crash-safety backstop the concurrency argument leans on:
      // a runner that dies while holding MIGRATION_ADVISORY_LOCK_KEY must not
      // leave every future `pnpm db:migrate` blocked forever. Postgres
      // documents that session-level advisory locks are released when their
      // session ends (cleanly or otherwise); this proves it against the
      // actual database this repo runs on, rather than trusting the docs.
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      // No pg_advisory_unlock call — simulating a process that dies while
      // holding the lock. Ending the connection without unlocking first is
      // the point of the test.
      await holder.end();

      const second = new pg.Client({ connectionString: adminUrl });
      await second.connect();
      try {
        const res = await second.query<{ pg_try_advisory_lock: boolean }>(
          'SELECT pg_try_advisory_lock($1)',
          [MIGRATION_ADVISORY_LOCK_KEY]
        );
        const [row] = res.rows;
        expect(row, 'pg_try_advisory_lock should return exactly one row').toBeDefined();
        expect(
          row?.pg_try_advisory_lock,
          'a second session must be able to acquire the lock once the holding session ended'
        ).toBe(true);
        await second.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      } finally {
        await second.end();
      }
    },
    HOOK_TIMEOUT
  );
});
