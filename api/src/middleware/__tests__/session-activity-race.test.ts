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
 *
 * TRO-288 — the burst must GENUINELY overlap, not merely hope to.
 *
 * `Promise.all(calls.map(...))` dispatches all `BURST` `authMiddleware()` calls in the
 * same synchronous tick, so on an idle box the session-lookup SELECTs reliably land in
 * flight together. But "reliably on an idle box" is not "always": this repo's CI runner
 * is a 2-vCPU `ubuntu-latest` job with Postgres running as a co-located service
 * container sharing those same 2 vCPUs (`.github/workflows/ci.yml`), a far more
 * contended environment than a idle dev machine. Under contention, connection
 * acquisition and query dispatch can serialize enough that a later request's SELECT
 * lands *after* an earlier request's UPDATE has already committed — that request then
 * correctly reads the just-refreshed `last_activity`, correctly concludes no write is
 * due, and never sends one. That collapses `updateStatements` to 1, which fails the
 * "did the burst actually race" precondition below — this was confirmed directly (not
 * merely inferred) by re-running the burst fully sequentially against unmodified code:
 * `updateStatements=1, rowsModified=1`, i.e. the precondition check fails while the
 * exactly-once check still passes. The exactly-once assertion itself held in every
 * timing pattern tried (fully concurrent, half-staggered, fully sequential) — Postgres's
 * predicate re-check arbitrates correctly regardless of arrival order, exactly as DB-2
 * intended. So the fragile half of this test was never "exactly once"; it was "did the
 * burst race at all".
 *
 * `createArrivalBarrier` below removes that dependency structurally. It holds every
 * session-lookup SELECT until all `BURST` concurrent callers have asked to send one,
 * then releases them together. Concurrency argument: while any of the `BURST` calls is
 * waiting at the barrier, none of them has yet sent its SELECT, so none has read
 * anything, so none can have decided a write is due, so no UPDATE can exist yet. That
 * makes it structurally impossible for any of the `BURST` SELECTs to observe anything
 * other than the original stale `last_activity` — not "unlikely under contention", but
 * unreachable by construction, independent of how slow or reordered the surrounding
 * scheduling is.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, SESSION_ACTIVITY_UPDATE_THRESHOLD_MS } from '../auth.js';
import { pool } from '../../db/client.js';
import { sqlOf } from '../../test/sql-of.js';

const BURST = 10;

/**
 * Holds every call whose SQL satisfies `isBarriered` until `count` such calls have
 * arrived, then releases all of them in the same tick. See the module docblock
 * (TRO-288) for the concurrency argument this exists to make structural.
 */
function createArrivalBarrier(isBarriered: (sql: string) => boolean, count: number) {
  let arrived = 0;
  let releaseFn: (() => void) | undefined;
  const allArrived = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  return function gate(sql: string, dispatch: () => unknown): unknown {
    if (!isBarriered(sql)) return dispatch();
    arrived += 1;
    if (arrived === count) releaseFn?.();
    return allArrived.then(dispatch);
  };
}

/** Matches the session-lookup SELECT in `authMiddleware` (auth.ts), the read whose
 * timing determines whether a request sees the burst's stale `last_activity` or an
 * already-refreshed one.
 *
 * DB-3 / TRO-180 named this statement, so it is now sent as `{ name, text, values }`
 * rather than a bare string — callers must extract the SQL text with `sqlOf` before
 * calling this, rather than passing `pool.query`'s first argument straight through. */
function isSessionLookup(sql: string): boolean {
  return sql.replace(/\s+/g, ' ').trim().startsWith('SELECT s.id, s.user_id, s.workspace_id');
}

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

    // TRO-288 — install the arrival barrier UNDERNEATH the spy, not through it.
    // `pool.query` is overloaded (promise, callback, and stream forms); vitest's
    // `mockImplementation` collapses an overloaded method to its last signature
    // (the callback form), which is the wrong shape for how this codebase actually
    // calls it. Reassigning the property directly sidesteps that entirely: `spy`
    // below observes and calls through to whatever `pool.query` currently is,
    // exactly as it did before this change, with the barrier as an invisible layer
    // underneath it.
    const trueQuery = pool.query;
    const gateArrival = createArrivalBarrier(isSessionLookup, BURST);
    pool.query = function barrieredQuery(...args: unknown[]): unknown {
      const sql = sqlOf(args[0]);
      // review-pattern-ok: pool.query's overloads collapse to a single signature
      // under Parameters<>/ReturnType<>, so a precise cast is required to forward
      // to the real implementation this codebase's 1-2 arg promise-based calls
      // actually use; `unknown` types on both sides, not `any`.
      const dispatch = () => (trueQuery as (...a: unknown[]) => unknown).apply(pool, args);
      return gateArrival(sql, dispatch);
    } as typeof pool.query;

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
        .map((call, i) => ({ sql: sqlOf(call[0]).replace(/\s+/g, ' ').trim(), i }))
        .filter(({ sql }) => sql.startsWith('UPDATE sessions SET last_activity'));
      updateStatements = updates.length;
      rowsModified = updates.reduce((total, { i }) => total + rowCountOf(settled[i]), 0);
    } finally {
      spy.mockRestore();
      pool.query = trueQuery;
    }

    // The burst must genuinely race, or this test proves nothing: if the requests were
    // serialized, only one would ever judge the write due and the row-count assertion
    // below would pass even against an unconditional UPDATE. Before TRO-288 this was a
    // hope resting on Promise.all's synchronous dispatch; the arrival barrier above now
    // makes it structurally true (see the module docblock), so this should never fail —
    // it stays as the check that would catch it if the barrier itself ever regressed.
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

// TRO-288 — dedicated coverage for the arrival barrier itself, isolated from the
// database. This is what would catch a regression in the barrier's own logic (e.g.
// releasing on the wrong count, or failing to pass through non-matching calls) without
// needing a full concurrent-burst repro to notice.
describe('createArrivalBarrier (TRO-288 test-harness helper)', () => {
  it('holds every matching call until `count` have arrived, then releases them together', async () => {
    const dispatched: string[] = [];
    const gate = createArrivalBarrier((sql) => sql === 'MATCH', 3);
    const dispatch = (label: string) => () => {
      dispatched.push(label);
      return label;
    };

    const first = gate('MATCH', dispatch('a'));
    const second = gate('MATCH', dispatch('b'));
    // Only 2 of 3 required arrivals — neither may have dispatched yet.
    expect(dispatched, 'must not release before all `count` calls arrive').toEqual([]);

    const third = gate('MATCH', dispatch('c'));
    // The 3rd arrival is what releases all three.
    await Promise.all([first, second, third]);
    expect(dispatched.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('passes non-matching calls straight through without waiting on the barrier', async () => {
    // A barrier that will never see enough matching calls to release — if a
    // non-matching call were (incorrectly) subject to it, this would hang and the
    // test would time out rather than resolve.
    const gate = createArrivalBarrier((sql) => sql === 'MATCH', 5);
    const result = await gate('SOMETHING ELSE ENTIRELY', () => 'dispatched-immediately');
    expect(result).toBe('dispatched-immediately');
  });
});
