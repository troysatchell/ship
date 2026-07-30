/**
 * Regression tests for `verifyMigrations.ts` (TRO-247 / RULE-6 — one-command
 * local start).
 *
 * These exercise the real migration set against a throwaway database, then
 * simulate the DB-1 (TRO-178) failure shape directly — a `schema_migrations`
 * row missing for a file that exists on disk — to prove the check actually
 * detects it, rather than only asserting that today's fixed runner behaves.
 */
import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrationRunner.js';
import { verifyMigrations } from '../verifyMigrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');
const SCHEMA_PATH = join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

const HOOK_TIMEOUT = 120_000;
const MAX_IDENTIFIER_BYTES = 63;

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

/** Deliberately independent of listMigrationFiles(), which verifyMigrations relies on internally. */
function expectedVersionsFromDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.replace(/\.sql$/, ''))
    .sort();
}

const silent = () => {};

describe('verifyMigrations — the explicit N/N check (TRO-247 / RULE-6)', () => {
  const dbName = throwawayDatabaseName('verify');
  let pool: pg.Pool;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: urlFor(dbName) });
    await runMigrations(pool, { schemaPath: SCHEMA_PATH, migrationsDir: MIGRATIONS_DIR, log: silent });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
  }, HOOK_TIMEOUT);

  it(
    'reports every migration file on disk as applied against a fully-migrated database',
    async () => {
      const expected = expectedVersionsFromDisk();
      expect(expected.length, 'the migrations directory should contain real migration files').toBeGreaterThan(10);

      const result = await verifyMigrations(urlFor(dbName), MIGRATIONS_DIR);

      expect(result.missing).toEqual([]);
      expect(result.expected).toBe(expected.length);
      expect(result.applied).toBe(expected.length);
    },
    HOOK_TIMEOUT
  );

  it(
    'detects a DB-1-shaped gap: a migration file on disk with no schema_migrations row',
    async () => {
      // Simulate the exact DB-1 (TRO-178) symptom directly, rather than only
      // trusting that today's runner never produces it: delete one recorded
      // version out from under an otherwise fully-migrated database.
      const expected = expectedVersionsFromDisk();
      const victim = expected[expected.length - 1];
      expect(victim, 'the real migrations directory must not be empty').toBeDefined();

      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [victim]);
      try {
        const result = await verifyMigrations(urlFor(dbName), MIGRATIONS_DIR);

        expect(result.missing).toEqual([victim]);
        expect(result.applied).toBe(expected.length - 1);
        expect(result.expected).toBe(expected.length);
      } finally {
        // Restore so the next test (and the shared pool) sees a clean state.
        await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [victim]);
      }
    },
    HOOK_TIMEOUT
  );
});
