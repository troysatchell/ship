/**
 * TRO-179 (DB-2) — `sessions.last_activity` write throttling, and the expiry
 * semantics that depend on it.
 *
 * `authMiddleware` used to run `UPDATE sessions SET last_activity = $1 WHERE id = $2`
 * unconditionally on every authenticated request, so a single page load (5-13 requests)
 * fired 5-13 writes against the *same* row. The sliding-cookie refresh three lines below
 * was already throttled to 60s; the database write now uses the same threshold.
 *
 * Throttling makes the recorded `last_activity` lag real request activity by at most
 * `SESSION_ACTIVITY_UPDATE_THRESHOLD_MS`. The expiry comparison therefore carries the
 * same amount as grace, so the rounding error can only ever *extend* a session, never
 * end one early. These tests pin both halves: the write is skipped inside the window,
 * and the inactivity window is still enforced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';

// Declared with the promise-returning signature: `vi.mocked(pool.query)` would resolve to
// pg's callback overload, whose return type is `void`, forcing a cast on every mocked
// result and switching off checking of the row shapes these tests assert about.
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(),
}));

// Mock pool before importing auth middleware
vi.mock('../../db/client.js', () => ({
  pool: {
    query: queryMock,
  },
}));

import {
  authMiddleware,
  SESSION_ACTIVITY_UPDATE_THRESHOLD_MS,
  SESSION_INACTIVITY_LIMIT_MS,
} from '../auth.js';
import { Request, Response, NextFunction } from 'express';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';
import { pgResult } from '../../test/pg-result.js';

const SESSION_ID = 'throttle-session';

// Typed as Partial<> first, then asserted once, so the members set here are checked
// against the real Express shapes. A full Request/Response cannot be constructed without
// a live socket, which is why the single assertion remains.
function createMockReqRes(cookies: Record<string, string> = { session_id: SESSION_ID }) {
  const req: Partial<Request> = { cookies };
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  };
  const next: NextFunction = vi.fn();
  return { req: req as Request, res: res as Response, next };
}

/** Queue the session row plus the workspace-membership row the middleware reads. */
function mockValidSession(opts: { lastActivityMsAgo: number; sessionAgeMs?: number }) {
  const now = Date.now();
  queryMock
    .mockResolvedValueOnce(
      pgResult([
        {
          id: SESSION_ID,
          user_id: 'user-123',
          workspace_id: 'ws-123',
          last_activity: new Date(now - opts.lastActivityMsAgo),
          created_at: new Date(now - (opts.sessionAgeMs ?? 0)),
          is_super_admin: false,
        },
      ])
    )
    .mockResolvedValue(pgResult([{ id: 'membership-1' }]));
}

/** Every statement the middleware issued, whitespace-normalized. */
function statements(): string[] {
  return queryMock.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}

function activityWrites(): string[] {
  return statements().filter((sql) => sql.startsWith('UPDATE sessions SET last_activity'));
}

describe('session activity write throttle (TRO-179 / DB-2)', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clearing only wipes recorded calls, leaving a
    // queued mockResolvedValueOnce (or the persistent mockResolvedValue default set by
    // mockValidSession) to leak into the next test. Every test here happens to drain its
    // own once-queue today, but that is exactly the fragile invariant TRO-277/TEST-12
    // exists to not depend on — enforced across the suite by mock-isolation.test.ts.
    vi.resetAllMocks();
  });

  describe('database write throttling', () => {
    it('skips the sessions.last_activity write when activity was recorded inside the throttle window', async () => {
      const { req, res, next } = createMockReqRes();
      mockValidSession({ lastActivityMsAgo: SESSION_ACTIVITY_UPDATE_THRESHOLD_MS - 1_000 });

      await authMiddleware(req, res, next);

      expect(
        activityWrites(),
        'a request inside the throttle window must not rewrite the session row'
      ).toHaveLength(0);
      expect(
        statements(),
        'authenticated request prelude should be SELECT session + SELECT membership only'
      ).toHaveLength(2);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('writes sessions.last_activity once the throttle window has elapsed', async () => {
      const { req, res, next } = createMockReqRes();
      mockValidSession({ lastActivityMsAgo: SESSION_ACTIVITY_UPDATE_THRESHOLD_MS + 1_000 });

      const before = Date.now();
      await authMiddleware(req, res, next);

      expect(activityWrites(), 'a request past the throttle window must refresh the row').toHaveLength(1);
      // The predicate is repeated in SQL so that concurrent requests cannot each land a
      // write: Postgres, not the application's possibly-stale read, decides.
      expect(queryMock).toHaveBeenCalledWith(
        'UPDATE sessions SET last_activity = $1 WHERE id = $2 AND last_activity < $3',
        [expect.any(Date), SESSION_ID, expect.any(Date)]
      );

      const writeCall = queryMock.mock.calls.find((call) =>
        String(call[0]).startsWith('UPDATE sessions SET last_activity')
      );
      expect(writeCall, 'the throttled write should have been issued').toBeDefined();

      const params: unknown[] = Array.isArray(writeCall?.[1]) ? writeCall[1] : [];
      expect(params, 'the write must be parameterized, never interpolated').toHaveLength(3);
      const [writtenAt, , cutoff] = params;
      expect(writtenAt, 'last_activity is written as a Date').toBeInstanceOf(Date);
      expect(cutoff, 'the SQL cutoff is a Date').toBeInstanceOf(Date);

      if (writtenAt instanceof Date && cutoff instanceof Date) {
        expect(writtenAt.getTime()).toBeGreaterThanOrEqual(before);
        // The cutoff is exactly one throttle interval behind the written timestamp, so
        // the SQL predicate and the application check test the same condition.
        expect(writtenAt.getTime() - cutoff.getTime()).toBe(SESSION_ACTIVITY_UPDATE_THRESHOLD_MS);
      }
      expect(next).toHaveBeenCalled();
    });

    it('refreshes the sliding cookie on the same threshold as the write', async () => {
      const { req, res, next } = createMockReqRes();
      mockValidSession({ lastActivityMsAgo: SESSION_ACTIVITY_UPDATE_THRESHOLD_MS + 1_000 });

      await authMiddleware(req, res, next);

      expect(res.cookie).toHaveBeenCalledWith(
        'session_id',
        SESSION_ID,
        expect.objectContaining({ maxAge: SESSION_INACTIVITY_LIMIT_MS, httpOnly: true })
      );
    });
  });

  describe('expiry semantics under a throttled write', () => {
    it('still serves a session whose recorded inactivity is inside the throttle grace', async () => {
      // The recorded value may trail real activity by up to the throttle interval, so a
      // session recorded as idle for 15m+1s may in truth have been used 1 second ago.
      // Rejecting it here would log out a user the web client still considers active.
      const { req, res, next } = createMockReqRes();
      mockValidSession({ lastActivityMsAgo: SESSION_TIMEOUT_MS + 1_000 });

      await authMiddleware(req, res, next);

      expect(next, 'recorded inactivity inside the grace window must not expire a session').toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(statements()).not.toContain('DELETE FROM sessions WHERE id = $1');
      // Past the throttle window, so the row is refreshed back to now.
      expect(activityWrites()).toHaveLength(1);
    });

    it('expires a session once recorded inactivity passes the inactivity limit', async () => {
      const { req, res, next } = createMockReqRes();
      mockValidSession({ lastActivityMsAgo: SESSION_INACTIVITY_LIMIT_MS + 1_000 });

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('inactivity') }),
        })
      );
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
      expect(next).not.toHaveBeenCalled();
    });

    it('grace applies to inactivity only, not to the 12-hour absolute cap', async () => {
      const { req, res, next } = createMockReqRes();
      mockValidSession({
        lastActivityMsAgo: 0,
        sessionAgeMs: ABSOLUTE_SESSION_TIMEOUT_MS + 1_000,
      });

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
