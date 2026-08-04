/**
 * Regression tests for FG-3 / TRO-314.
 *
 * The bug: the dev-database seed was a Week 4 load-testing fixture ("500+
 * documents, 100+ issues, 20+ users, 10+ sprints") that never recorded any
 * activity — document_history and comments were both always 0 rows, no issue
 * ever had started_at/completed_at set (even the ones marked 'done'), and no
 * week ever had plan_approval set. The code that writes all of these exists
 * and runs in normal use; the seed simply never exercised it. Four of six
 * FleetGraph use cases (FLEETGRAPH.MD Test Cases 1-4) have no reachable
 * trigger state without this.
 *
 * These tests run `pnpm db:seed`'s actual CLI (`tsx src/db/seed.ts`) against a
 * throwaway scratch database, never against DATABASE_URL itself or a shared
 * dev database — the hazard this ticket's own body names explicitly
 * ("running Ship's tests wipes whatever database they are aimed at").
 * Migrations are applied first via runMigrations(), the same helper
 * migrationRunner.test.ts uses, so the scratch database matches what a real
 * `pnpm dev` (migrate, then seed) produces — not just seed.ts's own internal
 * schema.sql re-application.
 */
import { randomBytes } from 'crypto';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrationRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');
const SCHEMA_PATH = join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const API_ROOT = join(__dirname, '../../..');
const TSX_BIN = join(API_ROOT, 'node_modules/.bin/tsx');

const HOOK_TIMEOUT = 120_000;

/** Same pattern as migrationRunner.test.ts: database identifiers cannot be
 * bound as query parameters, so they are validated before interpolation. */
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

function throwawayDatabaseName(): string {
  const tail = `_fg3seed_${randomBytes(6).toString('hex')}`;
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
 * `result.status` alone conflates three different failures: the process
 * never started (`result.error`, e.g. ENOENT), it was killed before exiting
 * (`result.signal`, e.g. SIGTERM from the `timeout` option — `status` is then
 * `null`, which already fails a `!== 0` check but with no explanation why),
 * or it ran and exited non-zero. Surfacing which one actually happened is the
 * difference between a useful failure message and a guessing game.
 */
function assertSeedSucceeded(result: SpawnSyncReturns<string>): void {
  if (result.error) {
    throw new Error(`seed.ts failed to spawn: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(
      `seed.ts was killed by signal ${result.signal} (likely the ${100_000}ms timeout). stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`seed.ts exited ${result.status}. stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`);
  }
}

describe('seed.ts FG-3 fixture trigger states (TRO-314)', () => {
  const dbName = throwawayDatabaseName();
  const scratchUrl = urlFor(dbName);
  let pool: pg.Pool;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: scratchUrl });
    // Migrate first so this scratch database matches what `pnpm dev` (migrate
    // then seed) actually produces, not just seed.ts's own schema.sql
    // re-application.
    await runMigrations(pool, { schemaPath: SCHEMA_PATH, migrationsDir: MIGRATIONS_DIR, log: () => {} });

    const result = spawnSync(TSX_BIN, ['src/db/seed.ts'], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl,
        NODE_ENV: 'test',
      },
      encoding: 'utf-8',
      timeout: 100_000,
    });

    assertSeedSucceeded(result);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
  }, HOOK_TIMEOUT);

  it('records a non-empty document_history trail (issues AND weekly plans)', async () => {
    const total = await pool.query('SELECT COUNT(*) FROM document_history');
    // Red before the fix: this was unconditionally 0 (the ticket's own
    // verified baseline).
    expect(Number(total.rows[0].count)).toBeGreaterThan(0);

    const fields = await pool.query<{ field: string; document_type: string }>(
      `SELECT dh.field, d.document_type
       FROM document_history dh
       JOIN documents d ON d.id = dh.document_id`
    );
    const types = new Set(fields.rows.map(r => r.document_type));
    expect(types.has('issue'), 'document_history must include an issue-level change').toBe(true);
    expect(types.has('weekly_plan'), 'document_history must include a weekly_plan-level change').toBe(true);
  });

  it('records comments, including at least two carrying an @ mention', async () => {
    const total = await pool.query('SELECT COUNT(*) FROM comments');
    expect(Number(total.rows[0].count)).toBeGreaterThan(0);

    const mentioned = await pool.query(`SELECT content FROM comments WHERE content LIKE '%@%'`);
    expect(
      mentioned.rows.length,
      'at least two comments should carry a literal @Name mention (comments.content is plain TEXT, no structured mention mark)'
    ).toBeGreaterThanOrEqual(2);
  });

  it('populates started_at/completed_at coherently on every closed issue, with some closing in the current week', async () => {
    const doneIssues = await pool.query<{ id: string; started_at: Date | null; completed_at: Date | null }>(
      `SELECT id, started_at, completed_at FROM documents WHERE document_type = 'issue' AND properties->>'state' = 'done'`
    );
    expect(doneIssues.rows.length, 'the seed should produce at least one done issue to backfill').toBeGreaterThan(0);

    for (const issue of doneIssues.rows) {
      const { started_at: startedAt, completed_at: completedAt } = issue;
      expect(startedAt, `issue ${issue.id} (done) must have started_at set`).not.toBeNull();
      expect(completedAt, `issue ${issue.id} (done) must have completed_at set`).not.toBeNull();
      if (!startedAt || !completedAt) {
        throw new Error(`issue ${issue.id} is missing started_at/completed_at — the assertions above should already have failed`);
      }
      // Coherent ordering: started <= completed. Deliberately NOT checked
      // against created_at — this seed (like the rest of seed.ts) never
      // backdates documents.created_at to match an issue's conceptual
      // sprint, so created_at is always ~"whenever this seed ran" regardless
      // of which past sprint the issue's properties place it in.
      expect(new Date(completedAt).getTime()).toBeGreaterThanOrEqual(new Date(startedAt).getTime());
    }

    const closedRecently = await pool.query(
      `SELECT COUNT(*) FROM documents WHERE document_type = 'issue' AND properties->>'state' = 'done' AND completed_at > NOW() - INTERVAL '7 days'`
    );
    expect(Number(closedRecently.rows[0].count), 'at least one done issue should close inside the current week').toBeGreaterThan(0);
  });

  it('sets plan_approval on several weeks, including one approved-then-edited (changed_since_approved)', async () => {
    const withApproval = await pool.query<{ id: string; plan_approval: unknown }>(
      `SELECT id, properties->'plan_approval' as plan_approval FROM documents WHERE document_type = 'sprint' AND properties ? 'plan_approval'`
    );
    expect(withApproval.rows.length, '"several" weeks should carry plan_approval').toBeGreaterThanOrEqual(3);

    const states = withApproval.rows.map((r) => {
      const approval = r.plan_approval;
      const isRecord = typeof approval === 'object' && approval !== null;
      const state = isRecord ? (approval as Record<string, unknown>).state : undefined;
      expect(typeof state, `week ${r.id}'s plan_approval must be an object with a string state, got: ${JSON.stringify(approval)}`).toBe('string');
      return state;
    });
    expect(states, 'one week must show the changed_since_approved transition (approved, then edited)').toContain('changed_since_approved');
  });

  it('leaves at least one person with no reports_to, exercising the escalation-degrades path', async () => {
    const noManager = await pool.query(
      `SELECT COUNT(*) FROM documents WHERE document_type = 'person' AND (properties->>'reports_to') IS NULL`
    );
    expect(Number(noManager.rows[0].count)).toBeGreaterThanOrEqual(1);

    const total = await pool.query(`SELECT COUNT(*) FROM documents WHERE document_type = 'person'`);
    const withManager = await pool.query(
      `SELECT COUNT(*) FROM documents WHERE document_type = 'person' AND (properties->>'reports_to') IS NOT NULL`
    );
    // Not everyone has one either — a fully-populated hierarchy would silently
    // reintroduce the gap this scope item exists to keep open.
    expect(Number(withManager.rows[0].count)).toBeLessThan(Number(total.rows[0].count));
  });

  it('is idempotent: a second seed run against the same database does not error or duplicate the fixture block', async () => {
    const before = await pool.query('SELECT COUNT(*) FROM document_history');

    const result = spawnSync(TSX_BIN, ['src/db/seed.ts'], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: scratchUrl, NODE_ENV: 'test' },
      encoding: 'utf-8',
      timeout: 100_000,
    });

    assertSeedSucceeded(result);
    expect(result.stdout).toMatch(/already seeded/);

    const after = await pool.query('SELECT COUNT(*) FROM document_history');
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count));
  }, HOOK_TIMEOUT);
});
