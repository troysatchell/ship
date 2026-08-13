/**
 * Regression test for TRO-430 / PF-107 — GitHub Actions job
 * "e2e · agent detection latency + grounded chat" 500'd deterministically on
 * `POST /api/api-tokens` (`INTERNAL_ERROR`, "Failed to create API token"),
 * thrown from `e2e/fixtures/agentEnv.ts:215` inside `mintApiToken()`.
 *
 * ROOT CAUSE (observed, reproduced below): `e2e/fixtures/isolated-env.ts`'s
 * `runMigrations(dbUrl)` — the function `agentEnv.ts`'s `setUpDatabase`
 * calls to bootstrap the scratch database `mintApiToken` then hits — applied
 * `schema.sql` and then wrote every migration file's NAME into
 * `schema_migrations` marking it "applied" WITHOUT EVER EXECUTING the file's
 * SQL (its own comment: "schema.sql includes all table definitions from all
 * migrations, so running migrations again would fail"). That assumption is
 * true for every migration through 042 (each only `CREATE TABLE`s a new
 * table, which schema.sql already mirrors in full for a fresh database) and
 * false for 043_oauth_tokens_and_codes.sql:132 — `ALTER TABLE api_tokens ADD
 * COLUMN IF NOT EXISTS scopes TEXT[]` — an ALTER on an EXISTING table, which
 * per CLAUDE.md ("never modify schema.sql directly for existing tables...
 * all changes to existing tables go in migration files") is deliberately NOT
 * mirrored into schema.sql. This branch's `api/src/routes/api-tokens.ts` is
 * the first code to INSERT into `api_tokens.scopes`, so it is the first
 * thing to notice that column was never actually added to any database that
 * (pre-fix) fixture built — DB-1's exact failure mode ("applied nothing,
 * reported success"), reintroduced in a second migration-runner
 * implementation that was never updated when `api/src/db/migrationRunner.ts`
 * was hardened against exactly this (see that file's own
 * DUPLICATE_OBJECT_SQLSTATES / TRO-279 comments — that hardening is what
 * makes the fix, "delegate to the real runner instead of re-deriving
 * whether it's safe to run twice," correct).
 *
 * The fix (e2e/fixtures/isolated-env.ts) makes that fixture's `runMigrations`
 * delegate to `api/src/db/migrationRunner.ts`'s real, file-executing
 * `runMigrations` — the exact function `pnpm db:migrate` itself uses —
 * instead of the shortcut above. This test lives in `api/src` (not `e2e/`)
 * so it stays inside `api/tsconfig.json`'s `rootDir` (`./src` — a file under
 * `e2e/` cannot be imported from here without breaking `pnpm --filter api
 * type-check`, confirmed while writing this test), so rather than importing
 * the fixture module directly it reproduces the two DB-bootstrap shapes
 * in question — "schema.sql, migrations marked applied without running them"
 * (what the fixture built before the fix) vs. "the real migrationRunner"
 * (what it builds after) — and drives `POST /api/api-tokens` through the
 * real Express app against each, with the IDENTICAL request sequence
 * `e2e/fixtures/agentEnv.ts`'s `mintApiToken` uses (GET /api/csrf-token ->
 * POST /api/auth/login -> GET /api/csrf-token -> POST /api/api-tokens,
 * body `{ name: ... }`, no `scopes` field).
 *
 * Red-before (TRO-430, captured before the fix landed, both by running this
 * exact scenario and — even more directly — by pointing this same test at
 * the real, unmodified `e2e/fixtures/isolated-env.ts` `runMigrations` export
 * before it was edited): `POST /api/api-tokens` returned 500 `INTERNAL_ERROR`,
 * and the route's own `console.error('Create API token error:', error)`
 * (api-tokens.ts:117) logged the underlying Postgres error, captured here via
 * a `console.error` spy: `column "scopes" of relation "api_tokens" does not
 * exist` (SQLSTATE 42703). Green-after: against a database built by the real
 * migrationRunner, the identical request succeeds (201, `scopes: null`).
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { pool as appPool } from '../client.js';
import { runMigrations as applyRealMigrations } from '../migrationRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');
const SCHEMA_PATH = join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

const HOOK_TIMEOUT = 60_000;
const SEED_PASSWORD = 'tro-430-fixture-password';

/** Same helper shape as migrations-042-043.test.ts / migrationRunner.test.ts — see those files for the full rationale. */
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

/**
 * Reproduces e2e/fixtures/isolated-env.ts's PRE-FIX `runMigrations`
 * (TRO-430): applies schema.sql, then writes every migration FILENAME into
 * schema_migrations marking it "applied" without ever executing the file's
 * SQL. Deliberately reimplemented here (not imported from e2e/) so this test
 * stays inside api/tsconfig.json's rootDir — see this file's header.
 */
async function bootstrapLikePreFixE2eFixture(pool: pg.Pool): Promise<void> {
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  await pool.query(schema);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  const { readdirSync } = await import('fs');
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    const version = file.replace(/\.sql$/, '');
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
  }
}

/** Minimal workspace + user + membership — enough for POST /api/auth/login to succeed. */
async function seedLoginableUser(pool: pg.Pool, email: string): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('TRO-430 fixture workspace') RETURNING id`
  );
  const workspaceId = workspace.rows[0]?.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, last_workspace_id)
     VALUES ($1, $2, 'TRO-430 Fixture User', $3) RETURNING id`,
    [email, passwordHash, workspaceId]
  );
  const userId = user.rows[0]?.id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, userId]
  );
}

/** Node's `IncomingHttpHeaders` types 'set-cookie' as `string[] | undefined`, but supertest/superagent's
 * own header typing in this codebase collapses it to `string` (see api-tokens.test.ts's `?.[0]` usage,
 * tolerant of either shape) — normalize explicitly here since `mergeCookieJar` needs a real array either way. */
function toCookieArray(setCookie: unknown): string[] {
  if (Array.isArray(setCookie)) return setCookie as string[];
  if (typeof setCookie === 'string') return [setCookie];
  return [];
}

/** Minimal `Set-Cookie` jar merge — same shape as agentEnv.ts's own `mergeCookies`. */
function mergeCookieJar(existing: string, setCookieValues: readonly string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of setCookieValues) {
    const firstPair = raw.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eq = firstPair.indexOf('=');
    if (eq > 0) jar.set(firstPair.slice(0, eq), firstPair.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Drives the exact request sequence e2e/fixtures/agentEnv.ts's mintApiToken
 * uses against the real Express app, and returns the raw supertest response
 * for POST /api/api-tokens (never throws on a non-201 — the caller decides
 * how to report that, since a 500 here is the very thing under test).
 */
async function mintApiTokenLikeAgentEnvFixture(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
  tokenName: string
): Promise<request.Response> {
  const csrfRes1 = await request(app).get('/api/csrf-token');
  expect(csrfRes1.status).toBe(200);
  let csrfToken = (csrfRes1.body as { token: string }).token;
  let cookie = mergeCookieJar('', toCookieArray(csrfRes1.headers['set-cookie']));

  const loginRes = await request(app)
    .post('/api/auth/login')
    .set('Cookie', cookie)
    .set('x-csrf-token', csrfToken)
    .send({ email, password });
  expect(loginRes.status, `login should succeed: ${JSON.stringify(loginRes.body)}`).toBe(200);
  cookie = mergeCookieJar(cookie, toCookieArray(loginRes.headers['set-cookie']));

  const csrfRes2 = await request(app).get('/api/csrf-token').set('Cookie', cookie);
  expect(csrfRes2.status).toBe(200);
  csrfToken = (csrfRes2.body as { token: string }).token;
  cookie = mergeCookieJar(cookie, toCookieArray(csrfRes2.headers['set-cookie']));

  // Body shape identical to agentEnv.ts:212 — `{ name: ... }`, no `scopes` field.
  return request(app)
    .post('/api/api-tokens')
    .set('Cookie', cookie)
    .set('x-csrf-token', csrfToken)
    .send({ name: tokenName });
}

describe('TRO-430 regression: e2e agent-fixture DB bootstrap vs POST /api/api-tokens scopes', () => {
  const app = createApp();
  /** Saved so the app's real singleton pool is always restored, whatever happens below. */
  const originalQuery = appPool.query.bind(appPool);

  afterEach(() => {
    vi.restoreAllMocks();
    appPool.query = originalQuery;
  });

  describe('database bootstrapped the OLD way (schema.sql + migrations marked applied without running them)', () => {
    const dbName = throwawayDatabaseName('brokenboot');
    let pool: pg.Pool;

    beforeAll(async () => {
      await createDatabase(dbName);
      pool = new pg.Pool({ connectionString: urlFor(dbName) });
      await bootstrapLikePreFixE2eFixture(pool);
      await seedLoginableUser(pool, 'tro-430-broken@ship.local');
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await pool?.end();
      await dropDatabase(dbName);
    }, HOOK_TIMEOUT);

    it(
      'schema.sql alone does not define api_tokens.scopes (only migration 043 does, via ALTER TABLE)',
      async () => {
        const col = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'api_tokens' AND column_name = 'scopes'`
        );
        expect(col.rows).toHaveLength(0);
      },
      HOOK_TIMEOUT
    );

    it(
      'reproduces TRO-430: POST /api/api-tokens 500s INTERNAL_ERROR, underlying error is the missing scopes column',
      async () => {
        appPool.query = pool.query.bind(pool) as typeof appPool.query;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const tokenRes = await mintApiTokenLikeAgentEnvFixture(
          app,
          'tro-430-broken@ship.local',
          SEED_PASSWORD,
          `e2e-agent-fixture-regression-${Date.now()}`
        );

        expect(tokenRes.status).toBe(500);
        expect(tokenRes.body).toEqual({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create API token' },
        });

        // The response is sanitized by design — recover the real error from
        // the route's own console.error('Create API token error:', error)
        // (api-tokens.ts:117).
        const loggedCall = consoleErrorSpy.mock.calls.find(([label]) => label === 'Create API token error:');
        expect(loggedCall, 'route should have logged the underlying error server-side').toBeDefined();
        const underlyingError = loggedCall?.[1] as { message?: string } | undefined;
        expect(underlyingError?.message).toBe('column "scopes" of relation "api_tokens" does not exist');
      },
      HOOK_TIMEOUT
    );
  });

  describe('database bootstrapped by the real migrationRunner (what pnpm db:migrate — and, after the TRO-430 fix, the e2e fixture — actually run)', () => {
    const dbName = throwawayDatabaseName('realboot');
    let pool: pg.Pool;

    beforeAll(async () => {
      await createDatabase(dbName);
      pool = new pg.Pool({ connectionString: urlFor(dbName) });
      await applyRealMigrations(pool, { schemaPath: SCHEMA_PATH, migrationsDir: MIGRATIONS_DIR, log: () => {} });
      await seedLoginableUser(pool, 'tro-430-fixed@ship.local');
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await pool?.end();
      await dropDatabase(dbName);
    }, HOOK_TIMEOUT);

    it(
      'api_tokens.scopes exists (migration 043 actually ran)',
      async () => {
        const col = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'api_tokens' AND column_name = 'scopes'`
        );
        expect(col.rows).toHaveLength(1);
      },
      HOOK_TIMEOUT
    );

    it(
      'POST /api/api-tokens succeeds with the identical request sequence and body',
      async () => {
        appPool.query = pool.query.bind(pool) as typeof appPool.query;

        const tokenRes = await mintApiTokenLikeAgentEnvFixture(
          app,
          'tro-430-fixed@ship.local',
          SEED_PASSWORD,
          `e2e-agent-fixture-regression-${Date.now()}`
        );

        expect(tokenRes.status, `expected 201, got ${tokenRes.status}: ${JSON.stringify(tokenRes.body)}`).toBe(201);
        expect(tokenRes.body.success).toBe(true);
        expect(tokenRes.body.data.scopes).toBeNull();
        expect(typeof tokenRes.body.data.token).toBe('string');
      },
      HOOK_TIMEOUT
    );
  });
});
