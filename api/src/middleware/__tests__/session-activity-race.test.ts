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
 *
 * TRO-300 — gating DISPATCH order is not the same guarantee as gating READ order.
 *
 * TRO-288's barrier above was observed to fail in real CI three separate times after
 * landing (PRs #62, #63, #66; identical signature each time, pulled from the CI job's
 * uploaded `api-tests.json`: `AssertionError: the burst did not race ... expected 1 to
 * be greater than 1` at this file's precondition check — the exact failure mode TRO-288
 * was written to eliminate). Not reproduced locally despite deliberately escalating
 * attempts (documented in full in TRO-300's CHANGES.md entry: CPU-pinning the Postgres
 * container down to a single core, real Docker-VM-level contention from sibling
 * containers pinned to that same core, and finally running Node itself inside a Linux
 * container `--cpuset-cpus`-pinned to the identical 2 cores as Postgres — matching this
 * repo's actual CI topology as closely as this hardware allows — 100+ runs total, zero
 * repro). That gap between "confirmed real in CI" and "not reproducible on available
 * dev hardware" is itself the finding this fix responds to, not proof of a specific
 * trigger.
 *
 * The mechanistic gap (derived, not directly observed — no debugger was attached to a
 * failing CI run): `createArrivalBarrier` only holds each SELECT's DISPATCH (the JS-level
 * call into `pool.query`) until all `BURST` callers have asked to send one. Tracing
 * `pg-pool`'s `Pool.prototype.query` → `connect` → `_pulseQueue` (node_modules/.pnpm/
 * pg-pool@3.10.1/node_modules/pg-pool/index.js), that dispatch step really is
 * synchronous JS work draining through `process.nextTick`, so all `BURST` SELECTs do
 * leave the Node process in the same tick, before any of their responses can be
 * processed — confirmed by reading, not assumed. But leaving Node "together" only
 * bounds when the bytes are WRITTEN to each connection's socket. It says nothing about
 * when Postgres's own per-connection backend PROCESS is scheduled to actually READ and
 * EXECUTE that statement — and per-backend scheduling is arbitrated by the OS, not by
 * anything this barrier (or any client-side code) controls. Under real contention
 * (`.github/workflows/ci.yml`'s 2-vCPU runner, Postgres as a co-located service
 * container sharing those same 2 vCPUs, and — specific to this middleware's actual code
 * path — an intervening, unbarriered `workspace_memberships` lookup between the
 * session-lookup SELECT and the eventual UPDATE, inline in `authMiddleware` itself
 * (`auth.ts`'s `if (session.workspace_id && !session.is_super_admin)` block, which this
 * fixture's session always satisfies)), one connection's
 * entire SELECT-membership-check-decide-UPDATE-commit cycle can plausibly finish before
 * a different, already-dispatched connection's SELECT is ever scheduled to execute —
 * meaning that SELECT, whenever it finally runs, correctly reads the just-committed
 * fresh value and correctly declines to write. That collapses `updateStatements` back
 * toward 1, reproducing this file's original failure through a channel the TRO-288
 * barrier never gated.
 *
 * `createCompletionBarrier` below closes that gap by moving what is held from DISPATCH
 * to RESULT DELIVERY. Every barriered call's underlying query is sent immediately (no
 * send-side delay at all — timing of the send no longer matters), but the PROMISE each
 * caller is awaiting does not settle until every one of the `BURST` calls' underlying
 * queries has itself settled. Concurrency argument, and this one does not depend on
 * dispatch order, network timing, or Postgres backend scheduling: no caller can resume
 * past its `await pool.query(...)` — and therefore no caller can act on its read or
 * reach the write decision — until literally every other barriered caller's read has
 * ALSO already completed. Since none of the `BURST` callers can have issued an UPDATE
 * before every one of them has resumed, no UPDATE can exist while any of the `BURST`
 * SELECTs is still executing, regardless of the real order or speed at which Postgres
 * actually ran them. That makes the "all `BURST` SELECTs observe the same stale row"
 * precondition true by construction, independent of every layer of scheduling in the
 * stack — not just the client-side dispatch layer TRO-288 addressed.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, SESSION_ACTIVITY_UPDATE_THRESHOLD_MS } from '../auth.js';
import { pool } from '../../db/client.js';

const BURST = 10;

/**
 * Holds the RESULT of every call whose SQL satisfies `isBarriered` until all `count`
 * such calls' underlying queries have themselves settled (resolved OR rejected), then
 * releases every result together. Each underlying query is dispatched immediately —
 * nothing about WHEN it is sent is delayed or synchronized — only when its caller is
 * allowed to see the outcome and act on it.
 *
 * See the module docblock (TRO-300) for why this has to gate completion rather than
 * dispatch: TRO-288's `createArrivalBarrier` (superseded by this function) synchronized
 * only the client-side send, which this repo's CI runner demonstrated is not the same
 * guarantee as synchronizing when Postgres actually executes each statement. Gating
 * completion instead removes that dependency entirely — the concurrency argument holds
 * regardless of dispatch order, network timing, or database backend scheduling, because
 * it is enforced only in this process's own promise resolution, never by observing or
 * assuming anything about how fast or in what order the real queries actually ran.
 *
 * A rejected underlying query still counts toward `count` — an error must not leave the
 * other `count - 1` callers hung on a barrier that can never release. Reviewer-caught
 * (CodeRabbit, TRO-300): counting the rejection is not enough on its own. The FIRST
 * version of this function fed `resultPromise` straight into
 * `Promise.all([resultPromise, allCompleted])`; `Promise.all` rejects as soon as ANY of
 * its inputs rejects, without waiting for the others — so a rejecting call could still
 * settle (with its rejection) before every other barriered call had completed, which is
 * exactly the "act before everyone else has read" gap this barrier exists to close, just
 * on the error path instead of the success path. Fixed by never letting the tracked
 * promise itself reject: `outcome` below always FULFILLS, with a tagged value that
 * records whether the underlying query resolved or threw. `Promise.all([outcome,
 * allCompleted])` can then only settle once both genuinely have, on every path, and the
 * final `.then` re-throws the original error only after that join — preserving each
 * caller's real result or error, just never delivering it early.
 */
function createCompletionBarrier(isBarriered: (sql: string) => boolean, count: number) {
  let completed = 0;
  let releaseFn: (() => void) | undefined;
  const allCompleted = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  return function gate(sql: string, dispatch: () => unknown): unknown {
    if (!isBarriered(sql)) return dispatch();

    const resultPromise = Promise.resolve(dispatch());
    // Never rejects — a thrown error becomes a tagged fulfillment, so it cannot make
    // `Promise.all` below short-circuit ahead of `allCompleted`.
    const outcome: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> =
      resultPromise.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error })
      );

    outcome.then(() => {
      completed += 1;
      if (completed === count) releaseFn?.();
    });

    return Promise.all([outcome, allCompleted]).then(([settled]) => {
      if (!settled.ok) throw settled.error;
      return settled.value;
    });
  };
}

/** Matches the session-lookup SELECT in `authMiddleware` (auth.ts), the read whose
 * timing determines whether a request sees the burst's stale `last_activity` or an
 * already-refreshed one. */
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

    // TRO-288 / TRO-300 — install the completion barrier UNDERNEATH the spy, not
    // through it. `pool.query` is overloaded (promise, callback, and stream forms);
    // vitest's `mockImplementation` collapses an overloaded method to its last
    // signature (the callback form), which is the wrong shape for how this codebase
    // actually calls it. Reassigning the property directly sidesteps that entirely:
    // `spy` below observes and calls through to whatever `pool.query` currently is,
    // exactly as it did before this change, with the barrier as an invisible layer
    // underneath it.
    const trueQuery = pool.query;
    const gateCompletion = createCompletionBarrier(isSessionLookup, BURST);
    pool.query = function barrieredQuery(...args: unknown[]): unknown {
      const sql = String(args[0]);
      // review-pattern-ok: pool.query's overloads collapse to a single signature
      // under Parameters<>/ReturnType<>, so a precise cast is required to forward
      // to the real implementation this codebase's 1-2 arg promise-based calls
      // actually use; `unknown` types on both sides, not `any`.
      const dispatch = () => (trueQuery as (...a: unknown[]) => unknown).apply(pool, args);
      return gateCompletion(sql, dispatch);
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
        .map((call, i) => ({ sql: String(call[0]).replace(/\s+/g, ' ').trim(), i }))
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
    // hope resting on Promise.all's synchronous dispatch; TRO-288's arrival barrier made
    // dispatch order structural but (per TRO-300) that is not the same guarantee as
    // read order under real Postgres scheduling contention. The completion barrier
    // above makes it structurally true regardless of scheduling anywhere in the stack
    // (see the module docblock), so this should never fail — it stays as the check that
    // would catch it if the barrier itself ever regressed.
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

/** A promise plus its resolve/reject functions, exposed for a test to settle on its own schedule. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  // `resolveFn`/`rejectFn` start undefined and are populated synchronously by the
  // executor below (Promise executors always run synchronously) — typed as optional
  // rather than asserted non-null, matching `createCompletionBarrier`'s `releaseFn`.
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (error: unknown) => rejectFn?.(error),
  };
}

// TRO-288 / TRO-300 — dedicated coverage for the completion barrier itself, isolated
// from the database. This is what would catch a regression in the barrier's own logic
// (e.g. releasing on the wrong count, gating dispatch instead of completion, or failing
// to pass through non-matching calls) without needing a full concurrent-burst repro to
// notice — and, per the TRO-300 module docblock, a full concurrent-burst repro is
// exactly what this project could NOT reliably produce on demand even under deliberate
// load, which is the whole reason this coverage has to be deterministic instead.
describe('createCompletionBarrier (TRO-288 / TRO-300 test-harness helper)', () => {
  it(
    'dispatches every matching call immediately, but holds each result until every ' +
      'call has settled — even when the underlying queries settle in a scrambled, ' +
      'out-of-dispatch order',
    async () => {
      // This is the TRO-300 regression case: TRO-288's `createArrivalBarrier` only
      // synchronized DISPATCH, so if the underlying queries settle out of dispatch
      // order (exactly what real Postgres backend scheduling can do under CI
      // contention — see the module docblock), the FIRST caller to settle would have
      // resumed and been able to act while the others were still mid-flight. Run the
      // old barrier's logic through this same scenario and it fails immediately
      // (confirmed by hand before this fix landed): the first `.then(dispatch)` to
      // settle resolves on its own, without waiting for the rest. This test proves the
      // replacement does not have that gap — deterministically, via manually-controlled
      // deferreds, with no real timer, real query, or real scheduling involved.
      const deferred = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
      const dispatched: number[] = [];
      const settledOrder: number[] = [];

      const gate = createCompletionBarrier((sql) => sql === 'MATCH', 3);
      const results = deferred.map((d, i) => {
        const dispatch = () => {
          dispatched.push(i);
          return d.promise;
        };
        // `gate(...)` returns `unknown` (it forwards whatever `dispatch` produces), so
        // this awaits it directly rather than chaining `.then` on an `unknown` value.
        return (async () => {
          const value = await gate('MATCH', dispatch);
          settledOrder.push(i);
          return value;
        })();
      });

      // All 3 underlying queries must be sent immediately — nothing about send timing
      // is gated. Flush the microtask queue once so the synchronous `dispatch` calls
      // above have had a chance to run before we assert on them.
      await Promise.resolve();
      expect(dispatched.sort(), 'every call must dispatch immediately, not on release').toEqual([
        0, 1, 2,
      ]);

      // Resolve deliberately OUT OF DISPATCH ORDER — call 2 first, matching the real
      // failure shape (a later-dispatched connection's query finishes first). Flushing
      // microtasks after each one and checking `settledOrder` proves none of the three
      // outer promises has resolved yet, even though its own underlying query has.
      deferred[2]?.resolve('c');
      await Promise.resolve();
      await Promise.resolve();
      expect(settledOrder, 'must not release before every call has settled').toEqual([]);

      deferred[0]?.resolve('a');
      await Promise.resolve();
      await Promise.resolve();
      expect(settledOrder, 'must not release before every call has settled').toEqual([]);

      // The last (2nd-dispatched) call settling is what releases all three together.
      deferred[1]?.resolve('b');
      const values = await Promise.all(results);
      expect(values).toEqual(['a', 'b', 'c']);
      expect(settledOrder.slice().sort()).toEqual([0, 1, 2]);
    }
  );

  it('passes non-matching calls straight through without waiting on the barrier', async () => {
    // A barrier that will never see enough matching calls to release — if a
    // non-matching call were (incorrectly) subject to it, this would hang and the
    // test would time out rather than resolve.
    const gate = createCompletionBarrier((sql) => sql === 'MATCH', 5);
    const result = await gate('SOMETHING ELSE ENTIRELY', () => 'dispatched-immediately');
    expect(result).toBe('dispatched-immediately');
  });

  it(
    'does not let a rejecting call settle before every barriered call has completed, ' +
      'and still delivers every caller its own real outcome',
    async () => {
      // TRO-300 / CodeRabbit — this is the case the first version of this fix missed:
      // `Promise.all([resultPromise, allCompleted])` rejects as soon as ANY input
      // rejects, so a rejecting call could settle (with its rejection) before every
      // other barriered call had completed — the same "act before everyone else has
      // read" gap this barrier exists to close, just reachable through the error path
      // instead of the success path. Both underlying queries are kept pending (via
      // deferreds, not real timers) until both calls have been invoked, so this proves
      // the ordering property directly rather than by chance: reject the "bad" one
      // first and assert NEITHER caller has settled yet, then resolve the "ok" one and
      // assert both settle together, each with its own real outcome.
      const ok = createDeferred<string>();
      const bad = createDeferred<string>();
      const settledOrder: string[] = [];

      const gate = createCompletionBarrier((sql) => sql === 'MATCH', 2);

      const okResult = (async () => {
        const value = await gate('MATCH', () => ok.promise);
        settledOrder.push('ok');
        return value;
      })();
      const badResult = (async () => {
        try {
          return await gate('MATCH', () => bad.promise);
        } catch (error) {
          settledOrder.push('bad-rejected');
          throw error;
        }
      })();
      // Both calls are now invoked (both dispatches have fired); avoid an unhandled
      // rejection warning while `badResult` is deliberately left pending below.
      badResult.catch(() => {});

      // Reject the "bad" call first. Before the fix, this alone would be enough to
      // settle `badResult` immediately — short-circuiting the barrier on the error path.
      bad.reject(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(
        settledOrder,
        'a rejection must not settle before every barriered call has completed'
      ).toEqual([]);

      // Only once the "ok" call ALSO completes should either caller see its outcome.
      ok.resolve('fine');
      await expect(badResult).rejects.toThrow('boom');
      await expect(okResult).resolves.toBe('fine');
      expect(settledOrder.sort()).toEqual(['bad-rejected', 'ok']);
    }
  );
});
