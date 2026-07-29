/**
 * Migration runner — the logic behind `pnpm db:migrate`.
 *
 * Extracted from migrate.ts so it can be exercised by tests against a throwaway
 * database. migrate.ts remains the CLI entry point (env loading, pool creation,
 * exit codes); everything that decides *what gets applied* lives here.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';

export interface MigrationRunOptions {
  schemaPath: string;
  migrationsDir: string;
  /** Sink for progress output. Defaults to console.log; tests pass a no-op. */
  log?: (message: string) => void;
}

export interface MigrationRunResult {
  /** Migration versions applied by this run, in the order they were applied. */
  applied: string[];
  /** Migration versions already recorded in schema_migrations before this run. */
  alreadyApplied: string[];
}

/**
 * Postgres SQLSTATE codes meaning "the object you asked me to create is
 * already there". schema.sql is initial-setup DDL that is re-applied on every
 * deploy, so these are expected *there*.
 *
 * They are never expected from a numbered migration: a migration that cannot
 * be applied twice is a migration that has not been made idempotent, and
 * treating that as benign is what let DB-1 abandon 32 files while exiting 0.
 */
const DUPLICATE_OBJECT_SQLSTATES = new Set([
  '42P04', // duplicate_database
  '42P06', // duplicate_schema
  '42P07', // duplicate_table (also index, view, sequence)
  '42701', // duplicate_column
  '42710', // duplicate_object (trigger, constraint, type, operator, ...)
  '42723', // duplicate_function
]);

function isDuplicateObjectError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DUPLICATE_OBJECT_SQLSTATES.has(code);
}

/**
 * Migration files in the order they must be applied.
 *
 * Read errors propagate. Swallowing them here would reproduce DB-1 in a second
 * form: a missing or unreadable migrations directory — a `dist/db/migrations`
 * the build failed to copy, say — would apply schema.sql, apply nothing else,
 * and report success. "No migrations to run" and "I could not find out what to
 * run" must not look the same to the caller.
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Ensures numeric order: 001_, 002_, etc.
}

/**
 * Applies schema.sql, the initial-setup DDL.
 *
 * A duplicate-object error here is tolerated because schema.sql is re-applied
 * on every deploy and every object it creates may already exist. Note that
 * `pool.query` sends the file as one simple query, so Postgres runs it as a
 * single implicit transaction: if it throws, nothing in it was applied. That is
 * only safe because the error we tolerate is precisely "it was already there".
 * Any other error means the file did not apply and must not be swallowed.
 */
export async function applySchema(
  pool: Pool,
  schemaPath: string,
  log: (message: string) => void = console.log
): Promise<void> {
  const schema = readFileSync(schemaPath, 'utf-8');
  try {
    await pool.query(schema);
    log('✅ Schema applied');
  } catch (error) {
    if (!isDuplicateObjectError(error)) {
      throw error;
    }
    log('ℹ️  Schema objects already exist, continuing...');
  }
}

/** Creates the schema_migrations bookkeeping table if it does not exist. */
export async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
}

/**
 * Applies every migration file not yet recorded in schema_migrations.
 * Each file runs in its own transaction, together with the row that records it.
 */
export async function runPendingMigrations(
  pool: Pool,
  migrationsDir: string,
  log: (message: string) => void = console.log
): Promise<MigrationRunResult> {
  const appliedResult = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const alreadyApplied = appliedResult.rows.map(r => r.version as string);
  const alreadyAppliedSet = new Set(alreadyApplied);

  const files = listMigrationFiles(migrationsDir);
  if (files.length === 0) {
    log('ℹ️  No migration files found');
  }

  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (alreadyAppliedSet.has(version)) {
      continue; // Already applied
    }

    log(`  Running migration: ${file}`);
    const migrationSql = readFileSync(join(migrationsDir, file), 'utf-8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migrationSql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      log(`  ✅ ${file} applied`);
      applied.push(version);
    } catch (err) {
      await client.query('ROLLBACK');
      // Name the file in the message. The old handler reported every migration
      // failure as "Database schema already exists", which is why this bug went
      // unnoticed through 32 skipped files.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file} failed: ${detail}`, { cause: err });
    } finally {
      client.release();
    }
  }

  return { applied, alreadyApplied };
}

/**
 * Full migration sequence: schema.sql, then every pending numbered migration.
 *
 * Errors propagate. The only error tolerated anywhere in this sequence is a
 * duplicate-object error from schema.sql, handled inside applySchema. Anything
 * else reaches the caller, which is what makes `pnpm db:migrate` exit non-zero
 * rather than reporting a success it did not achieve.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunOptions
): Promise<MigrationRunResult> {
  const log = options.log ?? console.log;

  log('Running database migrations...');

  await applySchema(pool, options.schemaPath, log);
  await ensureMigrationsTable(pool);

  const result = await runPendingMigrations(pool, options.migrationsDir, log);

  if (result.applied.length === 0) {
    log('✅ All migrations already applied');
  } else {
    log(`✅ ${result.applied.length} migration(s) applied successfully`);
  }
  return result;
}
