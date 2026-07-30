/**
 * Regression tests for `ensureDatabase.ts` (TRO-247 / RULE-6 — one-command
 * local start).
 *
 * `scripts/dev.sh` and `start.sh` need to create the target database without
 * depending on `psql`/`createdb` being on PATH — see the module's own header
 * for why (Docker Postgres with the port published to the host has neither
 * binary available, but is reachable over plain TCP either way). These tests
 * exercise the real logic against throwaway databases created beside
 * DATABASE_URL, never against DATABASE_URL itself.
 */
import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSafeDatabaseName, ensureDatabase, unreachableMessage } from '../ensureDatabase.js';

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

const { adminUrl, urlFor, base } = databaseNames();

/**
 * A fresh, unguessable database name per test. Deliberately random rather
 * than deterministic — see `migrationRunner.test.ts`'s identical rationale:
 * a fixed name collides with a concurrent run of this same suite.
 */
function throwawayDatabaseName(role: string): string {
  const tail = `_${role}_${randomBytes(6).toString('hex')}`;
  const head = base.slice(0, 63 - tail.length);
  return `${head}${tail}`;
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const res = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = $1', [
      name,
    ]);
    return res.rows.length > 0;
  } finally {
    await admin.end();
  }
}

const createdDatabases: string[] = [];

afterAll(async () => {
  for (const name of createdDatabases) {
    await dropDatabase(name);
  }
});

describe('assertSafeDatabaseName', () => {
  it('accepts plain identifiers', () => {
    expect(assertSafeDatabaseName('ship_wt_tro_247')).toBe('ship_wt_tro_247');
    expect(assertSafeDatabaseName('_leading_underscore')).toBe('_leading_underscore');
  });

  it('rejects a name that would break out of the interpolated CREATE DATABASE statement', () => {
    expect(() => assertSafeDatabaseName('ship_dev; DROP TABLE users; --')).toThrow(/unsafe database name/);
  });

  it('rejects a name starting with a digit', () => {
    expect(() => assertSafeDatabaseName('123abc')).toThrow(/unsafe database name/);
  });

  it('rejects a name over the 63-byte Postgres identifier limit', () => {
    expect(() => assertSafeDatabaseName('a'.repeat(64))).toThrow(/unsafe database name/);
  });
});

describe('ensureDatabase — real Postgres (TRO-247 / RULE-6)', () => {
  it('creates the database when it does not exist yet', async () => {
    const name = throwawayDatabaseName('create');
    createdDatabases.push(name);

    expect(await databaseExists(name)).toBe(false);

    const result = await ensureDatabase(urlFor(name));

    expect(result).toEqual({ name, created: true });
    expect(await databaseExists(name)).toBe(true);
  });

  it('is idempotent: a second call on an existing database is a no-op that reports created: false', async () => {
    const name = throwawayDatabaseName('idempotent');
    createdDatabases.push(name);

    const first = await ensureDatabase(urlFor(name));
    expect(first.created).toBe(true);

    const second = await ensureDatabase(urlFor(name));
    expect(second).toEqual({ name, created: false });
    expect(await databaseExists(name)).toBe(true);
  });

  it('rejects a database name it cannot safely interpolate, without ever reaching the server', async () => {
    await expect(ensureDatabase(urlFor('123-unsafe-name'))).rejects.toThrow(/unsafe database name/);
  });

  it('fails loudly with an actionable message when Postgres is unreachable', async () => {
    // Nothing listens on this port on loopback, so the connection is refused
    // immediately (ECONNREFUSED) rather than timing out — no fixed sleep needed.
    const unreachableUrl = 'postgresql://nobody:nothing@127.0.0.1:1/does_not_matter';

    await expect(ensureDatabase(unreachableUrl)).rejects.toThrow(/Cannot reach PostgreSQL at 127\.0\.0\.1:1/);
  });
});

describe('unreachableMessage', () => {
  it('names both the local and Docker recovery paths', () => {
    const message = unreachableMessage('localhost', '5433');
    expect(message).toContain('localhost:5433');
    expect(message).toContain('docker-compose.local.yml');
    expect(message).toContain('DATABASE_URL=');
  });
});
