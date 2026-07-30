#!/usr/bin/env npx tsx
/**
 * Verifies every migration file on disk is actually recorded as applied in
 * the target database — the explicit "N/N applied" check TRO-247 (RULE-6)
 * asks a one-command start to make visible.
 *
 * WHY THIS EXISTS SEPARATELY FROM migrate.ts
 *
 * migrate.ts (DB-1 / TRO-178) now throws and exits non-zero on any migration
 * failure, so "the runner reported success" is trustworthy on its own. But
 * `.claude/CLAUDE.md`'s claim-provenance rule is not "trust a fixed exit
 * code" — it is "check the specific case, not the category": DB-1 itself was
 * a category-level bug whose instance-level behaviour (against a fresh
 * database) was the opposite of the claim. This queries the count
 * independently rather than trusting migrate.ts's own bookkeeping, and it
 * reuses migrationRunner.ts's own `listMigrationFiles` — the exact file
 * discovery the fixed runner uses — so "verified via the fixed runner" is
 * literally true rather than merely asserted.
 *
 * Read-only: this never applies a migration, only reports on what already ran.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import { listMigrationFiles } from './migrationRunner.js';
import { resolveDatabaseSsl } from './ssl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrationVerification {
  expected: number;
  applied: number;
  missing: string[];
}

/**
 * Compares the migration files on disk against the versions recorded in
 * `schema_migrations` for a single database.
 */
export async function verifyMigrations(databaseUrl: string, migrationsDir: string): Promise<MigrationVerification> {
  const files = listMigrationFiles(migrationsDir).map(f => f.replace(/\.sql$/, ''));

  const client = new Client({
    connectionString: databaseUrl,
    ssl: resolveDatabaseSsl(), // repo-wide convention — see ssl.test.ts
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const result = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const appliedSet = new Set(result.rows.map(r => r.version));
    const missing = files.filter(f => !appliedSet.has(f));
    return { expected: files.length, applied: files.length - missing.length, missing };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  const migrationsDir = join(__dirname, 'migrations');
  const result = await verifyMigrations(databaseUrl, migrationsDir);

  if (result.missing.length > 0) {
    console.error(
      `ERROR: schema_migrations is missing ${result.missing.length} migration(s) present on disk: ` +
        `${result.missing.join(', ')}. This is the DB-1 failure shape — a runner that exits 0 without ` +
        `applying everything. Re-run: DATABASE_URL=... pnpm --filter @ship/api db:migrate`
    );
    process.exit(1);
  }

  console.log(`✅ Migrations: ${result.applied}/${result.expected} applied`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
