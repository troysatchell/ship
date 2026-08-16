/**
 * Regression test for TRO-591.
 *
 * PF-201's `/api/v1` keyset pagination (`api/src/platform/api/v1/pagination.ts`)
 * combines the `(created_at, id)` cursor with `workspace_id = $1 AND
 * document_type = '<type>' AND deleted_at IS NULL` in every real list query
 * (`resources/issues.ts`, `resources/sprints.ts`, `resources/documents.ts`).
 * No existing index matched that whole shape — `idx_documents_ticket_number`
 * (038) is scoped to `document_type = 'issue'` only and doesn't carry
 * `created_at`/`id`; nothing at all indexed `document_type = 'sprint'`
 * combined with `workspace_id`. `EXPLAIN ANALYZE` against a large-workspace
 * volume (15,110 issues / 3,035 sprints seeded into one workspace — see this
 * ticket's CHANGES.md entry) showed a full `Seq Scan`/`Bitmap Heap Scan` +
 * sort on every page (5.4ms-10.5ms) before migration 052, dropping to a
 * sort-free `Index Scan` reading only the returned rows (~0.04-0.07ms) after.
 *
 * Same pattern as `db-6-7-8-10-indexes.test.ts` (DB-7/DB-10): this is an
 * index-EXISTENCE test, red before migration 052 exists. Builds a throwaway
 * database, applies every real migration file except 052, confirms the index
 * is absent, then applies the full migrations directory (052 included) on the
 * same database and confirms it now exists with the expected definition.
 * Never runs against the worktree's own DATABASE_URL.
 */
import { randomBytes } from 'crypto';
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

// The migration under test. Excluding it from the "before" fixture directory
// is what makes the red assertion below true by construction rather than by
// assumption.
const MIGRATION_PREFIX = '052_documents_workspace_type_created_at_index';
const INDEX_NAME = 'idx_documents_workspace_type_created_at';

/** Same helper shape as migrationRunner.test.ts / db-6-7-8-10-indexes.test.ts. */
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

interface IndexRow {
  indexname: string;
  indexdef: string;
}

async function findIndex(pool: pg.Pool, indexName: string): Promise<IndexRow | undefined> {
  const result = await pool.query<IndexRow>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [indexName]
  );
  return result.rows[0];
}

/** Copies every real migration file except the given prefix into a fresh temp dir. */
function migrationsDirExcluding(excludePrefixes: string[]): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'tro591-migrations-'));
  const dir = join(fixtureRoot, 'migrations');
  mkdirSync(dir);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    if (excludePrefixes.some((prefix) => file.startsWith(prefix))) continue;
    cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return fixtureRoot;
}

const silent = () => {};

describe('documents pagination composite index (TRO-591)', () => {
  const dbName = throwawayDatabaseName('idxcheck591');
  let pool: pg.Pool;
  let beforeFixtureRoot: string;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });
    beforeFixtureRoot = migrationsDirExcluding([MIGRATION_PREFIX]);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
    if (beforeFixtureRoot) rmSync(beforeFixtureRoot, { recursive: true, force: true });
  }, HOOK_TIMEOUT);

  it(
    'red: the composite index does not exist on a database migrated without 052',
    async () => {
      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: join(beforeFixtureRoot, 'migrations'),
        log: silent,
      });

      expect(
        await findIndex(pool, INDEX_NAME),
        `${INDEX_NAME} should not exist before migration 052 runs`
      ).toBeUndefined();
    },
    HOOK_TIMEOUT
  );

  it(
    'green: applying the real migrations directory (052 included) creates the composite index',
    async () => {
      // Same database, same connection - proves 052 applies cleanly on top of
      // a database that already ran every earlier migration, not just on a
      // fresh one.
      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: MIGRATIONS_DIR,
        log: silent,
      });

      const index = await findIndex(pool, INDEX_NAME);
      expect(index, 'composite pagination index should exist after migration 052').toBeDefined();
      expect(index?.indexdef).toContain('workspace_id');
      expect(index?.indexdef).toContain('document_type');
      expect(index?.indexdef).toContain('created_at');
      expect(index?.indexdef.toUpperCase()).toContain('DESC');
      expect(index?.indexdef).toContain('id');
      expect(index?.indexdef).toContain('deleted_at IS NULL');
    },
    HOOK_TIMEOUT
  );
});
