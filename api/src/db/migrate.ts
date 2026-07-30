#!/usr/bin/env npx ts-node
/**
 * Database migration script
 * 1. Runs schema.sql for initial table setup
 * 2. Runs numbered migration files from migrations/ folder
 * 3. Tracks completed migrations in schema_migrations table
 *
 * The logic lives in migrationRunner.ts so it can be exercised by tests against
 * a throwaway database. This file is the CLI wrapper: env loading, pool
 * lifecycle, and the process exit code.
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { loadProductionSecrets } from '../config/ssm.js';
import { runMigrations } from './migrationRunner.js';

// Load .env.local for local development
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate() {
  await loadProductionSecrets();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  let failed = false;
  try {
    await runMigrations(pool, {
      schemaPath: join(__dirname, 'schema.sql'),
      migrationsDir: join(__dirname, 'migrations'),
    });
  } catch (error) {
    console.error('Database migration failed:', error);
    failed = true;
  } finally {
    await pool.end();
  }

  if (failed) {
    process.exit(1);
  }
}

migrate();
