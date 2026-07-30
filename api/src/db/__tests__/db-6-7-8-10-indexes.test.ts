/**
 * Regression tests for TRO-183 [DB-7, DB-10].
 *
 * DB-7: the issue-permalink lookup (`GET /api/issues/by-ticket/:number`,
 * `issues.ts` `WHERE d.ticket_number = $1 AND d.workspace_id = $2 AND
 * d.document_type = 'issue'`) seq-scanned the whole `documents` table -
 * measured at 500 rows examined / 66 buffers / 495 rows removed by filter to
 * return 1 row. Fixed by migration 038, a partial index matching that exact
 * predicate.
 *
 * DB-10: no index backed `ORDER BY ... updated_at DESC`, used by list queries
 * in issues.ts, documents.ts, weeks.ts, projects.ts, programs.ts, dashboard.ts
 * and search.ts. Fixed by migration 039.
 *
 * These are index-EXISTENCE tests, red before migrations 038/039 exist. To
 * prove that honestly rather than assert it, this suite builds a throwaway
 * database, applies every migration file EXCEPT 038/039 (the real files
 * copied from disk, not a hand-written stand-in) and confirms both indexes
 * are absent - then applies the full migrations directory (038/039
 * included) on the same database and confirms both now exist with the
 * expected definition. Never runs against the worktree's own DATABASE_URL.
 */
import { randomBytes } from 'crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

// The two migrations under test. Excluding them from the "before" fixture
// directory is what makes the red assertion below true by construction
// rather than by assumption.
const DB7_MIGRATION_PREFIX = '038_documents_ticket_number_index';
const DB10_MIGRATION_PREFIX = '039_documents_updated_at_index';

/** Same helper shape as migrationRunner.test.ts - see that file for the full rationale. */
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

/** Copies every real migration file except the given prefixes into a fresh temp dir. */
function migrationsDirExcluding(excludePrefixes: string[]): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'tro183-migrations-'));
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

describe('documents indexes (TRO-183 / DB-7, DB-10)', () => {
  const dbName = throwawayDatabaseName('idxcheck');
  let pool: pg.Pool;
  let beforeFixtureRoot: string;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });
    beforeFixtureRoot = migrationsDirExcluding([DB7_MIGRATION_PREFIX, DB10_MIGRATION_PREFIX]);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
    if (beforeFixtureRoot) rmSync(beforeFixtureRoot, { recursive: true, force: true });
  }, HOOK_TIMEOUT);

  it(
    'red: neither index exists on a database migrated without 038/039',
    async () => {
      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: join(beforeFixtureRoot, 'migrations'),
        log: silent,
      });

      expect(
        await findIndex(pool, 'idx_documents_ticket_number'),
        'idx_documents_ticket_number should not exist before migration 038 runs'
      ).toBeUndefined();
      expect(
        await findIndex(pool, 'idx_documents_workspace_updated_at'),
        'idx_documents_workspace_updated_at should not exist before migration 039 runs'
      ).toBeUndefined();
    },
    HOOK_TIMEOUT
  );

  it(
    'green: applying the real migrations directory (038/039 included) creates both indexes',
    async () => {
      // Same database, same connection - proves 038/039 apply cleanly on top
      // of a database that already ran every earlier migration, not just on
      // a fresh one.
      await runMigrations(pool, {
        schemaPath: SCHEMA_PATH,
        migrationsDir: MIGRATIONS_DIR,
        log: silent,
      });

      const ticketNumberIndex = await findIndex(pool, 'idx_documents_ticket_number');
      expect(ticketNumberIndex, 'DB-7 partial index should exist after migration 038').toBeDefined();
      expect(ticketNumberIndex?.indexdef).toContain('workspace_id');
      expect(ticketNumberIndex?.indexdef).toContain('ticket_number');
      expect(ticketNumberIndex?.indexdef).toContain("document_type = 'issue'::document_type");

      const updatedAtIndex = await findIndex(pool, 'idx_documents_workspace_updated_at');
      expect(updatedAtIndex, 'DB-10 index should exist after migration 039').toBeDefined();
      expect(updatedAtIndex?.indexdef).toContain('workspace_id');
      expect(updatedAtIndex?.indexdef).toContain('updated_at');
      expect(updatedAtIndex?.indexdef.toUpperCase()).toContain('DESC');
    },
    HOOK_TIMEOUT
  );
});
