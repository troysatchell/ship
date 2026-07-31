/**
 * DB-3 / TRO-180 — "61% of all database time is query planning, not execution".
 *
 * The audit's evidence (`audit/AUDIT_REPORT.md`, DB-3): node-postgres sends every
 * `pool.query(text, values)` call unnamed, so Postgres re-parses and re-plans it on
 * every single execution — 622 parse entries (91.5ms) + 622 bind entries (169.5ms)
 * across one capture, against only 167.2ms of actual execution. Naming a statement via
 * `pool.query({ name, text, values })` lets Postgres cache its plan after 5 executions
 * ON THE SAME POOLED CONNECTION (see CHANGES.md for the measured effect and the
 * pooling caveat — this test cannot observe server-side plan caching, only that the
 * application now asks for it).
 *
 * This ticket named the three statements the evidence identifies as hottest by
 * volume: the session-lookup SELECT and the `last_activity` UPDATE in
 * `middleware/auth.ts` (n=107 and n=121 respectively in one audit capture — dwarfing
 * any single list-endpoint query, because they run on every authenticated request
 * regardless of route), and the workspace-admin role check in
 * `middleware/visibility.ts` (a single call site reached by nearly every list/get
 * route via `getVisibilityContext`).
 *
 * The list/detail endpoint queries the audit also measured (e.g. `/api/issues`) were
 * deliberately NOT converted: `api/src/routes/issues.ts` and `documents.ts` build
 * their SQL text conditionally per applied filter, and node-postgres's own client
 * rejects reusing a statement name for different text on the same connection
 * ("Prepared statements must be unique") — naming those as literally written would
 * risk a runtime error under normal filtered traffic, not just miss the win.
 *
 * Red-before-green: every `toHaveBeenCalledWith({ name, ... })` assertion below fails
 * against the pre-fix code, which called `pool.query(text, values)` with two
 * positional arguments instead of one object — confirmed by reverting the three
 * production call sites and re-running this file (see PR description / final report).
 *
 * This file only proves the *shape* of the call (a stable name is present, sent every
 * time, and the query still behaves correctly) — it cannot prove Postgres actually
 * caches the plan. That is proven separately via EXPLAIN ANALYZE (Tier 2 measurement,
 * CHANGES.md), which is the only way to observe planner behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(textOrConfig: unknown, values?: unknown) => Promise<QueryResult>>(),
}));

vi.mock('../../db/client.js', () => ({
  pool: {
    query: queryMock,
  },
}));

import { authMiddleware, SESSION_ACTIVITY_UPDATE_THRESHOLD_MS } from '../auth.js';
import { isWorkspaceAdmin } from '../visibility.js';
import { Request, Response, NextFunction } from 'express';
import { pgResult } from '../../test/pg-result.js';

// Typed as Partial<> first, then asserted once (not `as unknown as`) — the members
// set here are still checked against the real Express shapes. Matches the idiom in
// session-activity-throttle.test.ts.
function createMockReqRes(cookies: Record<string, string> = {}) {
  const req: Partial<Request> = { cookies };
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
  };
  const next: NextFunction = vi.fn();
  return { req: req as Request, res: res as Response, next };
}

describe('named prepared statements (DB-3 / TRO-180)', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks — an unconsumed mockResolvedValueOnce would
    // otherwise leak into the next test and shift its query sequence (TRO-277/TEST-12).
    vi.resetAllMocks();
  });

  describe('middleware/auth.ts session lookup', () => {
    it('names the session-lookup SELECT so Postgres can cache its plan', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'sess-1' });
      const now = new Date();
      queryMock
        .mockResolvedValueOnce(
          pgResult([
            {
              id: 'sess-1',
              user_id: 'user-1',
              workspace_id: 'ws-1',
              last_activity: now,
              created_at: now,
              is_super_admin: false,
            },
          ])
        )
        // Membership check — activity is current, so the throttled write does not fire.
        .mockResolvedValueOnce(pgResult([{ id: 'membership-1' }]));

      await authMiddleware(req, res, next);

      const [firstCallArg] = queryMock.mock.calls[0] ?? [];
      expect(
        firstCallArg,
        'the session-lookup SELECT must be a named query, not a bare (text, values) pair'
      ).toMatchObject({
        name: 'auth_session_lookup',
        text: expect.stringContaining('FROM sessions s'),
        values: ['sess-1'],
      });

      // The shape change must not change behavior: a valid session still authenticates.
      expect(req.userId).toBe('user-1');
      expect(req.workspaceId).toBe('ws-1');
      expect(next).toHaveBeenCalled();
    });

    it('reuses the exact same name on a second, independent request', async () => {
      // Two separate requests must send the identical `name` (Postgres keys its
      // per-connection plan cache by name+text; a name that drifted per-request would
      // defeat the whole point of naming it).
      for (const sessionId of ['sess-a', 'sess-b']) {
        const { req, res, next } = createMockReqRes({ session_id: sessionId });
        const now = new Date();
        queryMock
          .mockResolvedValueOnce(
            pgResult([
              {
                id: sessionId,
                user_id: 'user-x',
                workspace_id: 'ws-x',
                last_activity: now,
                created_at: now,
                is_super_admin: true, // super-admin: skips the membership-revocation query
              },
            ])
          );
        await authMiddleware(req, res, next);
      }

      const names = queryMock.mock.calls.map((call) => {
        const arg = call[0];
        return arg && typeof arg === 'object' && 'name' in arg ? (arg as { name?: string }).name : undefined;
      });
      expect(names).toEqual(['auth_session_lookup', 'auth_session_lookup']);
    });
  });

  describe('middleware/auth.ts session activity write', () => {
    it('names the last_activity UPDATE so Postgres can cache its plan', async () => {
      const { req, res, next } = createMockReqRes({ session_id: 'sess-2' });
      const now = new Date();
      const staleActivity = new Date(now.getTime() - SESSION_ACTIVITY_UPDATE_THRESHOLD_MS - 1_000);
      queryMock
        .mockResolvedValueOnce(
          pgResult([
            {
              id: 'sess-2',
              user_id: 'user-2',
              workspace_id: 'ws-2',
              last_activity: staleActivity,
              created_at: now,
              is_super_admin: false,
            },
          ])
        )
        .mockResolvedValueOnce(pgResult([{ id: 'membership-2' }])) // membership check
        .mockResolvedValueOnce(pgResult([])); // the activity write itself

      await authMiddleware(req, res, next);

      const writeCall = queryMock.mock.calls.find((call) => {
        const arg = call[0];
        return (
          arg &&
          typeof arg === 'object' &&
          'text' in arg &&
          typeof (arg as { text?: unknown }).text === 'string' &&
          (arg as { text: string }).text.startsWith('UPDATE sessions SET last_activity')
        );
      });

      expect(writeCall, 'the throttled write should have fired past the threshold').toBeDefined();
      expect(writeCall?.[0]).toMatchObject({
        name: 'auth_session_touch_activity',
        text: 'UPDATE sessions SET last_activity = $1 WHERE id = $2 AND last_activity < $3',
        values: [expect.any(Date), 'sess-2', expect.any(Date)],
      });

      // Behavior preserved: the request is still authenticated and the sliding
      // cookie still refreshes alongside the row.
      expect(next).toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalled();
    });
  });

  describe('middleware/visibility.ts workspace-admin check', () => {
    it('names the role lookup and still reports admin correctly', async () => {
      queryMock.mockResolvedValueOnce(pgResult([{ role: 'admin' }]));

      const isAdmin = await isWorkspaceAdmin('user-3', 'ws-3');

      expect(isAdmin, 'behavior must be unchanged: admin role still resolves to true').toBe(true);
      expect(queryMock).toHaveBeenCalledWith({
        name: 'workspace_admin_role_lookup',
        text: 'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        values: ['ws-3', 'user-3'],
      });
    });

    it('still reports non-admin correctly for a member role', async () => {
      queryMock.mockResolvedValueOnce(pgResult([{ role: 'member' }]));

      const isAdmin = await isWorkspaceAdmin('user-4', 'ws-4');

      expect(isAdmin).toBe(false);
    });

    it('still reports non-admin correctly when no membership row exists', async () => {
      queryMock.mockResolvedValueOnce(pgResult([]));

      const isAdmin = await isWorkspaceAdmin('user-5', 'ws-5');

      expect(isAdmin).toBe(false);
    });
  });
});
