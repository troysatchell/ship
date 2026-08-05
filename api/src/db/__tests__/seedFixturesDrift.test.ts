/**
 * Regression test for TRO-345.
 *
 * The bug (verified against the graded DB, FG-23/TRO-341, 2026-08-04):
 * `seed.ts`'s Test Case 1 and Test Case 3 fixtures (FLEETGRAPH.MD's "Test
 * Cases" table, rows 1 and 3) SELECTed their trigger state from whichever
 * issues *already happened* to be associated with the sprint that resolves
 * as "current" at the moment the seed script runs — not from issues the
 * fixture created itself. `currentSprintNumber` is `sprint_start_date` plus
 * real elapsed wall-clock time; the issue-to-sprint associations are frozen
 * at whatever moment the base issue set was created. Six-plus days apart,
 * the two drift out of alignment: the sprint that is "current" today can
 * have zero non-done issues concentrated on one assignee (Test Case 1's
 * `if (engineerRow && cnt >= 3)` guard then silently skips its whole block —
 * no error, no console line) and zero 'done' issues at all (Test Case 3
 * logs "0 issues closed" against a row that requires 3).
 *
 * This test constructs that exact drifted precondition rather than assuming
 * a fresh database happens to trigger it (a fresh, single seed run is
 * internally consistent — sprint creation, issue assignment, and the FG-3
 * fixture block all read the SAME `currentSprintNumber` in one invocation,
 * so nothing can drift within it):
 *
 *   1. Seed a throwaway database once (fresh — succeeds for all 4 test
 *      cases, since nothing has drifted yet).
 *   2. Undo ONLY Test Case 1/3's own footprint (their marker-tagged issues
 *      and Test Case 1's standup) and push `workspaces.sprint_start_date`
 *      back 7 days — simulating "base data that is now a week stale" the
 *      same way the graded DB's 2026-07-28-vs-2026-08-04 gap did, without
 *      waiting real calendar days.
 *   3. Re-run seed against that now-drifted database — the FIRST time Test
 *      Cases 1/3 are attempted against misaligned data, matching the graded
 *      DB's actual situation the day this bug was found.
 *
 * Assertions are written against the Ship-state FLEETGRAPH.MD's Test Cases
 * table describes (an engineer with 3 assigned issues showing the right
 * narrative; a week with 4 success criteria and 3 issues closed within it)
 * rather than against this fix's own `fg3_fixture` marker, so they would
 * hold for any correct implementation, not just this one. The marker IS
 * used, deliberately, in the idempotency check at the end and in step 2's
 * setup — those two spots need to know precisely what to undo/re-count.
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

/** Same pattern as seedFixtures.test.ts / migrationRunner.test.ts: database
 * identifiers cannot be bound as query parameters, so they are validated
 * before interpolation. */
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
  const tail = `_fg3drift_${randomBytes(6).toString('hex')}`;
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

/** Same three-way split as seedFixtures.test.ts: spawn failure, killed by
 * signal/timeout, and non-zero exit are different failures with different
 * fixes, and collapsing them into one message hides which one happened. */
function assertSeedSucceeded(result: SpawnSyncReturns<string>): void {
  if (result.error) {
    throw new Error(`seed.ts failed to spawn: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(
      `seed.ts was killed by signal ${result.signal} (likely the 100000ms timeout). stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`seed.ts exited ${result.status}. stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`);
  }
}

function runSeed(scratchUrl: string): SpawnSyncReturns<string> {
  return spawnSync(TSX_BIN, ['src/db/seed.ts'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl, NODE_ENV: 'test' },
    encoding: 'utf-8',
    timeout: 100_000,
  });
}

/** Mirrors seed.ts's own "current sprint" / "current week" formula
 * (sprint_start_date + real elapsed time) exactly, deliberately, so this
 * test resolves the SAME sprint seed.ts itself resolves at assertion time
 * — not a re-derivation that could silently drift from the source file. */
function resolveCurrentSprint(sprintStartDate: Date): { currentSprintNumber: number; weekStart: Date; weekEnd: Date } {
  const today = new Date();
  const daysSinceStart = Math.floor((today.getTime() - sprintStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const currentSprintNumber = Math.max(1, Math.floor(daysSinceStart / 7) + 1);
  const weekStart = new Date(sprintStartDate);
  weekStart.setUTCDate(weekStart.getUTCDate() + (currentSprintNumber - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { currentSprintNumber, weekStart, weekEnd };
}

/**
 * Resolves "the" Ship Core sprint document for a given sprint number the
 * same way seed.ts's own `sprints.find(s => s.programId === X && s.number
 * === Y)` effectively does — NOT a plain unique lookup, because it isn't
 * one: Ship Core has multiple projects, sprints are keyed by
 * `(sprint_number, project_id)` (seed.ts's `existingSprint` check, ~line
 * 462), and sprints are distributed across those projects by round-robin
 * position *within that invocation's own -3..+3 window* (~line 441). A
 * database that has been seeded across two invocations with different
 * "current sprint" windows (exactly what this test constructs) can
 * therefore hold two distinct sprint documents that share the same title
 * and sprint_number under the same program — one from each invocation's
 * round-robin mapping — which a query scoped only by (program, number)
 * cannot tell apart.
 *
 * The one seed.ts's FG-3 code actually acted on this run is always the most
 * recently created: `sprints.find()` only ever considers what THIS
 * invocation's own sprint-creation loop just built (one entry per
 * (program, number) per run), so if a run created a new document for that
 * number it is the one used; if it found and reused an existing one, that
 * existing one is still the most recent match there is. `ORDER BY
 * created_at DESC LIMIT 1` is correct either way.
 */
async function resolveShipCoreSprint(
  pool: pg.Pool,
  shipCoreProgramId: string,
  workspaceId: string,
  sprintNumber: number
): Promise<{ id: string } | undefined> {
  const result = await pool.query<{ id: string }>(
    `SELECT d.id FROM documents d
     JOIN document_associations da ON da.document_id = d.id AND da.related_id = $1 AND da.relationship_type = 'program'
     WHERE d.workspace_id = $2 AND d.document_type = 'sprint' AND (d.properties->>'sprint_number')::int = $3
     ORDER BY d.created_at DESC
     LIMIT 1`,
    [shipCoreProgramId, workspaceId, sprintNumber]
  );
  return result.rows[0];
}

describe('seed.ts Test Case 1 / Test Case 3 fixtures against drifted base data (TRO-345)', () => {
  const dbName = throwawayDatabaseName();
  const scratchUrl = urlFor(dbName);
  let pool: pg.Pool;
  let workspaceId: string;
  let shipCoreProgramId: string;

  beforeAll(async () => {
    await createDatabase(dbName);
    pool = new pg.Pool({ connectionString: scratchUrl });
    await runMigrations(pool, { schemaPath: SCHEMA_PATH, migrationsDir: MIGRATIONS_DIR, log: () => {} });

    // ---- Invocation 1: fresh seed. Internally consistent (nothing has had
    // a chance to drift yet), so this run alone would already pass a naive
    // version of this test — the drift step below is what actually
    // reproduces the bug. ----
    assertSeedSucceeded(runSeed(scratchUrl));

    const ws = await pool.query<{ id: string }>(`SELECT id FROM workspaces WHERE name = 'Ship Workspace'`);
    const wsRow = ws.rows[0];
    if (!wsRow) {
      throw new Error('seed.ts should have created the "Ship Workspace" workspace on invocation 1');
    }
    workspaceId = wsRow.id;

    const program = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'program' AND properties->>'prefix' = 'SHIP'`,
      [workspaceId]
    );
    const programRow = program.rows[0];
    if (!programRow) {
      throw new Error('seed.ts should have created the Ship Core program on invocation 1');
    }
    shipCoreProgramId = programRow.id;

    // ---- Construct the drifted precondition. ----
    // Undo ONLY Test Case 1/3's own footprint: their marker-tagged issues
    // (cascades to the document_history/comments/associations rows they
    // created) and Test Case 1's standup. Test Cases 2/4's rows, and the
    // general started_at/completed_at backfill, are left exactly as
    // invocation 1 produced them — this test is about Test Case 1/3
    // specifically, not a full reset.
    //
    // Deliberately not asserted non-zero here: against the pre-fix version
    // of seed.ts (no `fg3_fixture` marker exists at all yet), this always
    // deletes 0 rows — that is expected, not a setup failure. The real
    // proof that the drifted database ends up in the right (or wrong)
    // state lives in the `it()` blocks below, which assert the Ship-state
    // FLEETGRAPH.MD actually requires, not this fixture's own bookkeeping.
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1 AND properties->>'fg3_fixture' IN ('tc1', 'tc3')`, [workspaceId]);
    await pool.query(
      `DELETE FROM documents WHERE workspace_id = $1 AND document_type = 'standup' AND title LIKE '%(FG-3 fixture)%'`,
      [workspaceId]
    );

    // Push sprint_start_date back exactly one sprint-width (7 days). This
    // advances the CURRENT invocation's currentSprintNumber by exactly 1
    // relative to invocation 1's, without changing the current week's real
    // calendar boundaries (the two shifts cancel out) — so "current" now
    // resolves to what was invocation 1's "+1" sprint. That sprint's own
    // static shipCoreIssues template (seed.ts's shipCoreIssues array,
    // sprintOffset: 1) holds exactly 4 issues, all non-done, split 2-and-2
    // across the two Ship Core team members by the existing assignment
    // loop — nobody reaches Test Case 1's >= 3 threshold, and none are
    // 'done' for Test Case 3. This deterministically reproduces "0 eligible
    // in the sprint that resolves as current" without any randomness or
    // waiting on real time.
    await pool.query(`UPDATE workspaces SET sprint_start_date = sprint_start_date - INTERVAL '7 days' WHERE id = $1`, [workspaceId]);

    // ---- Invocation 2: the drifted run — the one this ticket is about. ----
    assertSeedSucceeded(runSeed(scratchUrl));
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await pool?.end();
    await dropDatabase(dbName);
  }, HOOK_TIMEOUT);

  it('Test Case 1: some engineer has 3 current-sprint issues showing the exact narrative FLEETGRAPH.MD row 1 requires', async () => {
    const { currentSprintNumber } = resolveCurrentSprint(
      (await pool.query<{ sprint_start_date: Date }>(`SELECT sprint_start_date FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!
        .sprint_start_date
    );
    const sprintRow = await resolveShipCoreSprint(pool, shipCoreProgramId, workspaceId, currentSprintNumber);
    expect(sprintRow, `a Ship Core sprint numbered ${currentSprintNumber} (today's "current") must exist`).toBeTruthy();
    if (!sprintRow) throw new Error('unreachable — asserted above');

    // Find an engineer with >= 3 non-done issues in the current sprint —
    // the exact precondition Test Case 1's original SELECT-based logic
    // checked. Before the fix, this returns 0 rows against the drifted
    // sprint constructed in beforeAll.
    const engineers = await pool.query<{ assignee_id: string; cnt: string }>(
      `SELECT d.properties->>'assignee_id' as assignee_id, count(*) as cnt
       FROM documents d
       JOIN document_associations da ON da.document_id = d.id AND da.related_id = $1 AND da.relationship_type = 'sprint'
       WHERE d.workspace_id = $2 AND d.document_type = 'issue'
         AND d.properties->>'assignee_id' IS NOT NULL AND d.properties->>'state' != 'done'
       GROUP BY d.properties->>'assignee_id'
       HAVING count(*) >= 3`,
      [sprintRow.id, workspaceId]
    );
    expect(
      engineers.rows.length,
      'Test Case 1 needs an engineer with >= 3 non-done issues in the CURRENT sprint — 0 here means the ' +
        "fixture either didn't fire or created rows in the wrong (stale) sprint"
    ).toBeGreaterThan(0);
    const engineerRow = engineers.rows[0];
    if (!engineerRow) throw new Error('unreachable — asserted above');

    const engineerIssues = await pool.query<{ id: string; state: string; updated_at: Date }>(
      `SELECT d.id, d.properties->>'state' as state, d.updated_at
       FROM documents d
       JOIN document_associations da ON da.document_id = d.id AND da.related_id = $1 AND da.relationship_type = 'sprint'
       WHERE d.workspace_id = $2 AND d.document_type = 'issue' AND d.properties->>'assignee_id' = $3
         AND d.properties->>'state' != 'done'`,
      [sprintRow.id, workspaceId, engineerRow.assignee_id]
    );
    const issueIds = engineerIssues.rows.map(r => r.id);

    // "one moved to in review" — a state-change document_history row.
    const inReviewIssues = engineerIssues.rows.filter(r => r.state === 'in_review');
    expect(inReviewIssues.length, 'one of the engineer’s current-sprint issues must be in_review').toBeGreaterThan(0);
    const history = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM document_history WHERE document_id = ANY($1) AND field = 'state' AND new_value = 'in_review'`,
      [issueIds]
    );
    expect(Number(history.rows[0]!.count), 'the in_review transition must be recorded in document_history').toBeGreaterThan(0);

    // "they commented on another" — a comment authored by this engineer.
    const comments = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM comments WHERE document_id = ANY($1) AND author_id = $2`,
      [issueIds, engineerRow.assignee_id]
    );
    expect(Number(comments.rows[0]!.count), 'the engineer must have commented on one of their current-sprint issues').toBeGreaterThan(0);

    // "the third has not moved in 6 days".
    const staleIssues = engineerIssues.rows.filter(r => r.updated_at.getTime() < Date.now() - 6 * 24 * 60 * 60 * 1000);
    expect(staleIssues.length, 'one of the engineer’s current-sprint issues must not have moved in 6+ days').toBeGreaterThan(0);
  });

  it('Test Case 3: the current week has 4 success criteria and >= 3 issues closed inside it', async () => {
    const { currentSprintNumber, weekStart, weekEnd } = resolveCurrentSprint(
      (await pool.query<{ sprint_start_date: Date }>(`SELECT sprint_start_date FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!
        .sprint_start_date
    );
    const sprintRow = await resolveShipCoreSprint(pool, shipCoreProgramId, workspaceId, currentSprintNumber);
    expect(sprintRow, `a Ship Core sprint numbered ${currentSprintNumber} (today's "current") must exist`).toBeTruthy();
    if (!sprintRow) throw new Error('unreachable — asserted above');

    const criteriaRow = await pool.query<{ success_criteria: unknown }>(
      `SELECT properties->'success_criteria' as success_criteria FROM documents WHERE id = $1`,
      [sprintRow.id]
    );
    const successCriteria = criteriaRow.rows[0]?.success_criteria;
    expect(
      Array.isArray(successCriteria) ? successCriteria.length : -1,
      'the current week must carry exactly 4 success criteria'
    ).toBe(4);

    const closed = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM documents d
       JOIN document_associations da ON da.document_id = d.id AND da.related_id = $1 AND da.relationship_type = 'sprint'
       WHERE d.workspace_id = $2 AND d.document_type = 'issue' AND d.properties->>'state' = 'done'
         AND d.completed_at >= $3 AND d.completed_at < $4`,
      [sprintRow.id, workspaceId, weekStart, weekEnd]
    );
    expect(
      Number(closed.rows[0]!.count),
      'Test Case 3 needs >= 3 issues closed inside the current week — 0 here means the fixture either ' +
        "didn't fire or backdated the wrong (stale) sprint's issues"
    ).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent against the drifted database: re-seeding does not duplicate rows or re-run Test Case 1/3', async () => {
    const before = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM documents`);

    const result = runSeed(scratchUrl);
    assertSeedSucceeded(result);
    expect(result.stdout).toMatch(/Test Case 1 fixture already seeded/);
    expect(result.stdout).toMatch(/Test Case 3 fixture already seeded/);

    const after = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM documents`);
    expect(Number(after.rows[0]!.count), 're-seeding the already-fixtured drifted database must not create new rows').toBe(
      Number(before.rows[0]!.count)
    );

    const tc1Count = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM documents WHERE workspace_id = $1 AND properties->>'fg3_fixture' = 'tc1'`,
      [workspaceId]
    );
    const tc3Count = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM documents WHERE workspace_id = $1 AND properties->>'fg3_fixture' = 'tc3'`,
      [workspaceId]
    );
    expect(Number(tc1Count.rows[0]!.count), 'Test Case 1 must still hold exactly the 3 issues it created, no duplicates').toBe(3);
    expect(Number(tc3Count.rows[0]!.count), 'Test Case 3 must still hold exactly the 3 issues it created, no duplicates').toBe(3);
  }, HOOK_TIMEOUT);
});
