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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrationFiles, runMigrations } from '../migrationRunner.js';

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

function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`Refusing to interpolate unsafe database identifier: ${name}`);
  }
  return name;
}

const { adminUrl, urlFor, base } = databaseNames();

async function recreateDatabase(name: string): Promise<void> {
  assertSafeIdentifier(name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
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
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function recordedVersions(pool: pg.Pool): Promise<string[]> {
  const res = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return res.rows.map(r => r.version as string);
}

const silent = () => {};

describe('migration runner — real migration set (DB-1 / TRO-178)', () => {
  const dbName = `${base}_migrations`;
  let pool: pg.Pool;

  beforeAll(async () => {
    await recreateDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
  }, HOOK_TIMEOUT);

  it(
    'applies every migration file against a fresh database',
    async () => {
      const expected = listMigrationFiles(MIGRATIONS_DIR).map(f => f.replace(/\.sql$/, ''));
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
      const expected = listMigrationFiles(MIGRATIONS_DIR).map(f => f.replace(/\.sql$/, ''));

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
  const dbName = `${base}_migfail`;
  let pool: pg.Pool;
  let fixtureRoot: string;

  beforeAll(async () => {
    await recreateDatabase(dbName);
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

      const after = await pool.query(
        "SELECT to_regclass('public.tro178_after') AS present"
      );
      expect(
        after.rows[0].present,
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
    'still tolerates duplicate-object errors raised by schema.sql itself',
    async () => {
      // schema.sql is initial-setup DDL that is re-applied on every deploy. A
      // non-idempotent statement there must remain survivable — narrowing the
      // catch must not turn a routine re-run into a failed deploy.
      const root = mkdtempSync(join(tmpdir(), 'tro178-schema-'));
      try {
        mkdirSync(join(root, 'migrations'));
        writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE tro178_dup (id INT);\n');
        const options = {
          schemaPath: join(root, 'schema.sql'),
          migrationsDir: join(root, 'migrations'),
          log: silent,
        };

        await runMigrations(pool, options);
        await expect(runMigrations(pool, options)).resolves.toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT
  );
});
