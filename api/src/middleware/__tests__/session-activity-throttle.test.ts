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

// Mock pool before importing auth middleware
vi.mock('../../db/client.js', () => ({
  pool: {
    query: vi.fn(),
  },
}));

import {
  authMiddleware,
  SESSION_ACTIVITY_UPDATE_THRESHOLD_MS,
  SESSION_INACTIVITY_LIMIT_MS,
} from '../auth.js';
import { pool } from '../../db/client.js';
import { Request, Response, NextFunction } from 'express';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

const SESSION_ID = 'throttle-session';

function createMockReqRes(cookies: Record<string, string> = { session_id: SESSION_ID }) {
  const req = { cookies } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

/** Queue the session row plus the workspace-membership row the middleware reads. */
function mockValidSession(opts: { lastActivityMsAgo: number; sessionAgeMs?: number }) {
  const now = Date.now();
  vi.mocked(pool.query)
    .mockResolvedValueOnce({
      rows: [
        {
          id: SESSION_ID,
          user_id: 'user-123',
          workspace_id: 'ws-123',
          last_activity: new Date(now - opts.lastActivityMsAgo),
          created_at: new Date(now - (opts.sessionAgeMs ?? 0)),
          is_super_admin: false,
        },
      ],
    } as never)
    .mockResolvedValue({ rows: [{ id: 'membership-1' }] } as never);
}

/** Every statement the middleware issued, whitespace-normalized. */
function statements(): string[] {
  return vi
    .mocked(pool.query)
    .mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}

function activityWrites(): string[] {
  return statements().filter((sql) => sql.startsWith('UPDATE sessions SET last_activity'));
}

describe('session activity write throttle (TRO-179 / DB-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(pool.query).toHaveBeenCalledWith(
        'UPDATE sessions SET last_activity = $1 WHERE id = $2',
        [expect.any(Date), SESSION_ID]
      );
      const writtenAt = vi
        .mocked(pool.query)
        .mock.calls.find((call) =>
          String(call[0]).startsWith('UPDATE sessions SET last_activity')
        )![1] as [Date, string];
      expect(writtenAt[0].getTime()).toBeGreaterThanOrEqual(before);
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
      expect(pool.query).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
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
      expect(pool.query).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
