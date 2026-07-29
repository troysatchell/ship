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

/** Migration files in the order they must be applied. */
export function listMigrationFiles(migrationsDir: string): string[] {
  try {
    return readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // Ensures numeric order: 001_, 002_, etc.
  } catch {
    return [];
  }
}

/** Applies schema.sql, the initial-setup DDL. */
export async function applySchema(pool: Pool, schemaPath: string): Promise<void> {
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);
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

  const applied: string[] = [];
  for (const file of listMigrationFiles(migrationsDir)) {
    const version = file.replace('.sql', '');
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
      throw err;
    } finally {
      client.release();
    }
  }

  return { applied, alreadyApplied };
}

/**
 * Full migration sequence: schema.sql, then every pending numbered migration.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunOptions
): Promise<MigrationRunResult> {
  const log = options.log ?? console.log;
  const empty: MigrationRunResult = { applied: [], alreadyApplied: [] };

  try {
    log('Running database migrations...');

    await applySchema(pool, options.schemaPath);
    log('✅ Schema applied');

    await ensureMigrationsTable(pool);

    const result = await runPendingMigrations(pool, options.migrationsDir, log);

    if (result.applied.length === 0) {
      log('✅ All migrations already applied');
    } else {
      log(`✅ ${result.applied.length} migration(s) applied successfully`);
    }
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // "already exists" errors from schema.sql are fine
    if (errorMessage.includes('already exists')) {
      log('Database schema already exists, continuing...');
      return empty;
    }
    throw error;
  }
}
