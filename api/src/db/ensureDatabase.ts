#!/usr/bin/env npx tsx
/**
 * Ensures the database named in DATABASE_URL exists, creating it if not.
 *
 * WHY THIS EXISTS (TRO-247 / RULE-6 — one-command local start)
 *
 * `scripts/dev.sh` used to shell out to `psql`/`createdb` to do this. Those
 * binaries are absent on any machine that only runs Postgres via Docker with
 * the port published to the host — this project's own factory machine is one
 * (`docker-compose.local.yml` maps `ship-audit-pg` to `localhost:5433`; see
 * `.claude/skills/ship-factory/references/lessons.md` #8). TCP is reachable
 * either way, so a plain `pg` connection works uniformly for a native install
 * and for Docker, whereas psql/createdb only ever covered the former — a
 * one-command start has to work on both without the caller telling it which.
 *
 * Connects to the same server's `postgres` maintenance database (present on
 * every Postgres install this project targets, native or the official Docker
 * image) because you cannot `CREATE DATABASE` on the connection you want to
 * create.
 */
import { Client } from 'pg';
import { resolveDatabaseSsl } from './ssl.js';

/** Postgres identifiers are limited to 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Database names cannot be bound as query parameters, so whatever comes out
 * of DATABASE_URL is interpolated directly into `CREATE DATABASE`. Validate it
 * first — the same defense `migrationRunner.test.ts` and `worktree.sh` use for
 * the identifiers they interpolate.
 */
export function assertSafeDatabaseName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || Buffer.byteLength(name, 'utf-8') > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Refusing to interpolate unsafe database name into CREATE DATABASE: "${name}". ` +
        `Expected a plain identifier (letters, digits, underscore; not starting with a digit).`
    );
  }
  return name;
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT';
}

/**
 * Actionable message for "Postgres is not reachable at all" — as opposed to
 * "reachable, but the query failed", which is a different, rarer problem left
 * to propagate with whatever detail Postgres gave it.
 */
export function unreachableMessage(host: string, port: string): string {
  return [
    `ERROR: Cannot reach PostgreSQL at ${host}:${port}.`,
    'Start it, then re-run ./start.sh:',
    '  - Local install:  start your Postgres service (e.g. `pg_ctl start`, or `brew services start postgresql`)',
    '  - Docker:         docker compose -f docker-compose.local.yml up -d postgres',
    'Or point at a different server: DATABASE_URL=postgresql://user:pass@host:port/dbname ./start.sh',
  ].join('\n');
}

export interface EnsureDatabaseResult {
  name: string;
  created: boolean;
}

/**
 * Ensures `databaseUrl`'s target database exists, creating it if missing.
 * Idempotent: calling this again once the database exists is a no-op.
 */
export async function ensureDatabase(databaseUrl: string): Promise<EnsureDatabaseResult> {
  const target = new URL(databaseUrl);
  const name = assertSafeDatabaseName(target.pathname.replace(/^\//, ''));

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';

  const client = new Client({
    connectionString: adminUrl.toString(),
    // No-arg form is the repo-wide convention (see ssl.test.ts): it reads
    // process.env.NODE_ENV / process.env.DATABASE_URL itself. Equivalent to
    // passing databaseUrl explicitly here, since adminUrl only swaps the
    // pathname — the sslmode query parameter it checks is unchanged.
    ssl: resolveDatabaseSsl(),
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
  } catch (error) {
    if (isConnectionError(error)) {
      throw new Error(unreachableMessage(target.hostname, target.port || '5432'));
    }
    throw error;
  }

  try {
    const existing = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [name]
    );
    if (existing.rows.length > 0) {
      return { name, created: false };
    }
    await client.query(`CREATE DATABASE ${name}`);
    return { name, created: true };
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

  const result = await ensureDatabase(databaseUrl);
  console.log(
    result.created ? `✅ Database "${result.name}" created` : `ℹ️  Database "${result.name}" already exists`
  );
}

// Only run when executed directly (`npx tsx ensureDatabase.ts`), not when
// imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
