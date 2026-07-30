import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';

// `pool.query` is overloaded and TypeScript resolves `vi.mocked(pool.query)` to pg's
// CALLBACK overload, whose return type is `void` — which is why every mocked result in
// this file used to be cast with `as any`. Declaring the mock with its promise-returning
// signature up front makes all 16 of those casts unnecessary, and restores type checking
// on the row shapes the tests assert about (findings TS-4, TS-8).
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(),
}));

// Mock pool before importing auth middleware
vi.mock('../db/client.js', () => ({
  pool: {
    query: queryMock,
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { pool } from '../db/client.js';
import { Request, Response, NextFunction } from 'express';
import { ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';
// The enforced inactivity window is SESSION_TIMEOUT_MS plus the throttle interval the
// `last_activity` write now runs on, so that a lagging recorded value cannot expire a
// session early (TRO-179 / TRO-177). Boundary cases below are expressed against it.
import { SESSION_INACTIVITY_LIMIT_MS } from '../middleware/auth.js';
import { pgResult } from '../test/pg-result.js';

// Helper to create mock request/response
function createMockReqRes(cookies: Record<string, string> = {}) {
  const req = { cookies } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clearing only wipes recorded calls, so an
    // unconsumed `mockResolvedValueOnce` survives into the next test and silently
    // shifts its query sequence by one. That is a live hazard now that the middleware
    // issues a variable number of queries (the last_activity write is throttled).
    vi.resetAllMocks();
  });

  describe('session validation', () => {
    it('returns 401 when no session cookie is present', async () => {
      const { req, res, next } = createMockReqRes({});
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: 'No session found' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when session does not exist in database', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'invalid-session' });
      queryMock.mockResolvedValueOnce(pgResult([]));
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Invalid session' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('attaches session info to request for valid session', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      queryMock
        .mockResolvedValueOnce(
          pgResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: false,
          }])
        )
        // Session + membership only: last_activity is current, so the throttled
        // write does not fire.
        .mockResolvedValueOnce(pgResult([{ id: 'membership-1' }]));

      await authMiddleware(req, res, next);
      expect(req.sessionId).toBe('valid-session');
      expect(req.userId).toBe('user-123');
      expect(req.workspaceId).toBe('ws-123');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('session timeout handling', () => {
    // The enforced bound is SESSION_INACTIVITY_LIMIT_MS — the 15-minute window plus the
    // interval the last_activity write is throttled on, so a lagging recorded value
    // cannot expire a session early. Both edges are pinned in
    // middleware/__tests__/session-activity-throttle.test.ts.
    it('returns 401 when session exceeds 15-minute inactivity timeout', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'stale-session' });
      const now = new Date();
      const staleActivity = new Date(now.getTime() - SESSION_INACTIVITY_LIMIT_MS - 1000);
      queryMock.mockResolvedValueOnce(pgResult([{
          id: 'stale-session',
          user_id: 'user-123',
          workspace_id: 'ws-123',
          last_activity: staleActivity,
          created_at: now,
          is_super_admin: false,
        }]));

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('inactivity'),
          }),
        })
      );
    });

    it('returns 401 when session exceeds 12-hour absolute timeout', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'old-session' });
      const now = new Date();
      const oldCreatedAt = new Date(now.getTime() - ABSOLUTE_SESSION_TIMEOUT_MS - 1000);
      queryMock.mockResolvedValueOnce(pgResult([{
          id: 'old-session',
          user_id: 'user-123',
          workspace_id: 'ws-123',
          last_activity: now,
          created_at: oldCreatedAt,
          is_super_admin: false,
        }]));

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('expired'),
          }),
        })
      );
    });

    it('deletes expired session from database', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'expired-session' });
      const now = new Date();
      const staleActivity = new Date(now.getTime() - SESSION_INACTIVITY_LIMIT_MS - 1000);
      queryMock
        .mockResolvedValueOnce(pgResult([{
            id: 'expired-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: staleActivity,
            created_at: now,
            is_super_admin: false,
          }]))
        .mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      // Asserted through `pool.query` rather than `queryMock` — they are the same
      // function object, and keeping the original reference here keeps this assertion
      // legible as unchanged in review.
      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE id = $1',
        ['expired-session']
      );
    });
  });

  describe('workspace access verification', () => {
    it('returns 403 when user no longer has workspace access', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      queryMock
        .mockResolvedValueOnce(pgResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: false,
          }]))
        .mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('revoked'),
          }),
        })
      );
    });

    it('skips workspace check for super-admin users', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'admin-session' });
      const now = new Date();
      queryMock
        .mockResolvedValueOnce(
          pgResult([{
            id: 'admin-session',
            user_id: 'admin-123',
            workspace_id: 'ws-123',
            last_activity: now,
            created_at: now,
            is_super_admin: true,
          }])
        );

      await authMiddleware(req, res, next);
      expect(req.isSuperAdmin).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 on database error', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'some-session' });
      queryMock.mockRejectedValueOnce(new Error('DB connection failed'));
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Authentication failed' }),
        })
      );
    });
  });

  describe('sliding cookie expiration', () => {
    it('refreshes cookie when activity is beyond 60s threshold', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Last activity was 90 seconds ago (beyond 60s threshold)
      const lastActivity = new Date(now.getTime() - 90 * 1000);
      queryMock
        .mockResolvedValueOnce(pgResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: lastActivity,
            created_at: now,
            is_super_admin: false,
          }]))
        .mockResolvedValueOnce(pgResult([{ id: 'membership-1' }]))
        .mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      expect(res.cookie).toHaveBeenCalledWith('session_id', 'valid-session', {
        httpOnly: true,
        secure: false, // NODE_ENV is 'test', not 'production'
        sameSite: 'strict',
        // Matches the server-side window, so the browser cannot drop the cookie
        // before the server would have rejected the session.
        maxAge: SESSION_INACTIVITY_LIMIT_MS,
        path: '/',
      });
      expect(next).toHaveBeenCalled();
    });

    it('does NOT refresh cookie when activity is within 60s threshold', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'valid-session' });
      const now = new Date();
      // Last activity was 30 seconds ago (within 60s threshold)
      const lastActivity = new Date(now.getTime() - 30 * 1000);
      queryMock
        .mockResolvedValueOnce(
          pgResult([{
            id: 'valid-session',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            last_activity: lastActivity,
            created_at: now,
            is_super_admin: false,
          }])
        )
        // Inside the throttle window, so neither the cookie nor the row is refreshed.
        .mockResolvedValueOnce(pgResult([{ id: 'membership-1' }]));

      await authMiddleware(req, res, next);
      expect(res.cookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('bearer token authentication', () => {
    function createMockReqResWithAuth(authHeader: string | undefined) {
      const req = {
        cookies: {},
        headers: { authorization: authHeader },
        get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? authHeader : undefined),
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;
      return { req, res, next };
    }

    it('authenticates with valid bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer ship_validtoken123');

      // Mock token validation query
      queryMock
        .mockResolvedValueOnce(pgResult([{
            id: 'token-1',
            user_id: 'user-123',
            workspace_id: 'ws-123',
            is_super_admin: false,
          }]))
        // Mock update last_used_at
        .mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      expect(req.userId).toBe('user-123');
      expect(req.workspaceId).toBe('ws-123');
      expect(req.isApiToken).toBe(true);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 for invalid bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer invalid_token');

      // Mock token not found
      queryMock.mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Invalid or expired API token' }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 for revoked bearer token', async () => {
      const { req, res, next } = createMockReqResWithAuth('Bearer ship_revokedtoken');

      // Mock token found but revoked (revoked_at is set)
      queryMock.mockResolvedValueOnce(pgResult([])); // No results means revoked/expired

      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('prefers bearer token over session cookie when both present', async () => {
      // Create request with both session cookie and auth header
      const req = {
        cookies: { session_id: 'some-session' },
        headers: { authorization: 'Bearer ship_tokentoken' },
        get: vi.fn((name: string) => name.toLowerCase() === 'authorization' ? 'Bearer ship_tokentoken' : undefined),
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      queryMock
        .mockResolvedValueOnce(pgResult([{
            id: 'token-1',
            user_id: 'api-user',
            workspace_id: 'api-ws',
            is_super_admin: false,
          }]))
        .mockResolvedValueOnce(pgResult([]));

      await authMiddleware(req, res, next);
      // Should use token auth, not session
      expect(req.userId).toBe('api-user');
      expect(req.isApiToken).toBe(true);
      expect(next).toHaveBeenCalled();
    });
  });
});
