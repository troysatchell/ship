/**
 * TRO-179 / TRO-177, CodeRabbit MAJOR — the throttled `last_activity` write must be
 * decided by the database, not by each request's own read.
 *
 * Gating the write only in application code is not enough. A page load fires 5-13
 * requests in parallel; when the burst straddles the throttle threshold they all SELECT
 * the same pre-write `last_activity`, all conclude the write is due, and an unconditional
 * `UPDATE ... WHERE id = $2` lets every one of them land a write — degrading back to the
 * per-request row churn this change exists to remove. `AND last_activity < $3` makes
 * Postgres arbitrate: under READ COMMITTED the losers re-evaluate the qualification
 * against the committed row version, fail it, and affect zero rows.
 *
 * This exercises `authMiddleware` directly rather than through supertest. Driving it over
 * HTTP does NOT reproduce the race — a `Promise.all` of supertest requests serializes
 * enough that the first write commits before the rest read, so only one request ever
 * judges the write due and the assertion below passes even against the broken version.
 * Calling the middleware directly puts all the SELECTs in flight together, which is the
 * real production shape.
 *
 * Conditions: real `pool` (this file deliberately does not mock the db client),
 * NODE_ENV=test, worktree-exclusive PostgreSQL.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, SESSION_ACTIVITY_UPDATE_THRESHOLD_MS } from '../auth.js';
import { pool } from '../../db/client.js';

const BURST = 10;

/** Rows a query result reports as modified, validated at runtime rather than cast. */
function rowCountOf(result: unknown): number {
  if (typeof result !== 'object' || result === null || !('rowCount' in result)) return 0;
  const { rowCount } = result;
  return typeof rowCount === 'number' ? rowCount : 0;
}

/** First row or a clear failure — `noUncheckedIndexedAccess` is on, and `!` is not. */
function firstRow<T>(result: { rows: T[] }, what: string): T {
  const row = result.rows[0];
  if (!row) throw new Error(`fixture setup failed: expected ${what} to be inserted`);
  return row;
}

function createMockReqRes(sessionId: string) {
  const req: Partial<Request> = { cookies: { session_id: sessionId } };
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  };
  const next: NextFunction = vi.fn();
  return { req: req as Request, res: res as Response, next };
}

describe('concurrent session-activity writes (TRO-179 / TRO-177)', () => {
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Activity Race ${runId}`]
    );
    workspaceId = firstRow(workspace, 'the test workspace').id;

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Race User') RETURNING id`,
      [`activity-race-${runId}@ship.local`]
    );
    userId = firstRow(user, 'the test user').id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    );
  });

  /** A session parked just past the throttle threshold, so the whole burst judges the write due. */
  async function createStaleSession(): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity)
       VALUES ($1, $2, $3, now() + interval '1 hour',
               now() - make_interval(secs => $4))`,
      [sessionId, userId, workspaceId, SESSION_ACTIVITY_UPDATE_THRESHOLD_MS / 1000 + 1]
    );
    return sessionId;
  }

  it('modifies the session row exactly once when a concurrent burst crosses the threshold', async () => {
    const sessionId = await createStaleSession();
    // Warm the pool FIRST. With a cold pool, establishing connections is slow relative to
    // query execution, so the first client services one request's whole SELECT-SELECT-UPDATE
    // chain before the other queued queries ever reach the server — they then read the
    // already-updated row and the race never happens. Production runs a warm pool
    // (idleTimeoutMillis 30s), so grabbing and releasing BURST clients up front is what
    // makes this test model production rather than a cold start.
    const warm = await Promise.all(Array.from({ length: BURST }, () => pool.connect()));
    warm.forEach((client) => client.release());

    const spy = vi.spyOn(pool, 'query');
    let updateStatements: number;
    let rowsModified: number;

    try {
      const calls = Array.from({ length: BURST }, () => createMockReqRes(sessionId));
      await Promise.all(calls.map(({ req, res, next }) => authMiddleware(req, res, next)));

      // Every request must have been served — the point is to remove writes, not requests.
      for (const { res, next } of calls) {
        expect(next, 'each concurrent request must be authenticated').toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(401);
      }

      const settled: unknown[] = spy.mock.settledResults.map((result) =>
        result.type === 'fulfilled' ? result.value : undefined
      );
      const updates = spy.mock.calls
        .map((call, i) => ({ sql: String(call[0]).replace(/\s+/g, ' ').trim(), i }))
        .filter(({ sql }) => sql.startsWith('UPDATE sessions SET last_activity'));
      updateStatements = updates.length;
      rowsModified = updates.reduce((total, { i }) => total + rowCountOf(settled[i]), 0);
    } finally {
      spy.mockRestore();
    }

    // The burst must genuinely race, or this test proves nothing: if the requests were
    // serialized, only one would ever judge the write due and the row-count assertion
    // below would pass even against an unconditional UPDATE.
    expect(
      updateStatements,
      'the burst did not race — every request should have read the same pre-write row'
    ).toBeGreaterThan(1);

    expect(
      rowsModified,
      `${updateStatements} concurrent requests judged the write due; exactly one row ` +
        `version should result, not one per request`
    ).toBe(1);

    // And the row really was refreshed, so the session stays alive.
    // ::float8 — node-pg returns bare `numeric` as a string.
    const row = await pool.query<{ inactivity_s: number }>(
      `SELECT extract(epoch from (now() - last_activity))::float8 AS inactivity_s
       FROM sessions WHERE id = $1`,
      [sessionId]
    );
    expect(row.rows, 'the session row must still exist').toHaveLength(1);
    expect(
      row.rows[0]?.inactivity_s,
      'the burst must have refreshed last_activity'
    ).toBeLessThan(SESSION_ACTIVITY_UPDATE_THRESHOLD_MS / 1000);
  });
});
