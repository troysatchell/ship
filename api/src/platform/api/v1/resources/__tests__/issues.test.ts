/**
 * PF-201 (Linear TRO-400) — `/api/v1/issues`: cursor-paginated list, typed
 * `state`/`priority`/`assignee_id` fields lifted to the top level.
 *
 * Fixture pattern copied from `resources/documents.test.ts` (real
 * `createApp()`, direct SQL fixtures, personal tokens via `api_tokens`) —
 * see that file's header for the full rationale (real `/api/v1` mount, real
 * `bearerAuth`/`requireScope`, real database).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface IssueBody {
  id: string;
  title: string;
  document_type: string;
  state: string;
  priority: string;
  assignee_id: string | null;
  properties?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface ListResponseBody {
  data: IssueBody[];
  next_cursor: string | null;
}

describe('PF-201: /api/v1/issues (Linear TRO-400)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const BASE_MS = Date.parse('2026-02-01T00:00:00.000Z');

  let workspaceId: string;
  let userId: string;
  let assigneeUserId: string;
  /** scopes = ['issues:read'] only. */
  let readOnlyToken: string;
  /** scopes = ['documents:read'] only — the AC-3 "lacks issues:read" case. */
  let wrongScopeToken: string;
  /** scopes = ['issues:write'] (PF-703, TRO-435). */
  let writeToken: string;
  /** Client Credentials, scopes = ['issues:write'] — no acting user (PF-703's own
   *  forbidden-app-token guard). */
  let appOnlyWriteToken: string;

  async function insertPersonalToken(scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-201 issues token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  function onlyRow<T>(rows: T[]): T {
    const [row] = rows;
    if (row === undefined) {
      throw new Error(`Expected exactly one row, got ${rows.length}.`);
    }
    return row;
  }

  /** Same fixture pattern as `audit.test.ts`'s `insertOauthApp`/
   *  `insertOauthClientCredentialsToken` (PF-501) — a Client Credentials
   *  token, `user_id: NULL`, for PF-703's "an app-only credential has no
   *  user to attribute a document_history row to" guard. */
  async function insertAppOnlyToken(scopes: string[]): Promise<string> {
    const clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
    const appResult = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, is_first_party)
       VALUES ($1, $2, $3, 'confidential', false) RETURNING id`,
      [workspaceId, `PF-703 app-only test app ${testRunId}`, clientId]
    );
    const appId = onlyRow(appResult.rows).id;

    const raw = `oauth_at_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO oauth_tokens (app_id, user_id, scopes, access_token_hash, expires_at)
       VALUES ($1, NULL, $2, $3, now() + interval '1 hour')`,
      [appId, scopes, sha256Hex(raw)]
    );
    return raw;
  }

  async function insertIssue(
    title: string,
    createdAt: Date,
    properties: Record<string, unknown>
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, properties, created_at, updated_at)
       VALUES ($1, $2, 'issue', $3, $4, $4) RETURNING id`,
      [workspaceId, title, JSON.stringify(properties), createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('seed insertIssue produced no row');
    return row.id;
  }

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-201 Issues Test ${testRunId}`]
    );
    const workspaceRow = workspaceResult.rows[0];
    if (!workspaceRow) throw new Error('seed workspace insert produced no row');
    workspaceId = workspaceRow.id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-201 Test User', $2) RETURNING id`,
      [`pf201-issues-${testRunId}@ship.local`, workspaceId]
    );
    const userRow = userResult.rows[0];
    if (!userRow) throw new Error('seed user insert produced no row');
    userId = userRow.id;

    const assigneeResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-201 Assignee', $2) RETURNING id`,
      [`pf201-assignee-${testRunId}@ship.local`, workspaceId]
    );
    const assigneeRow = assigneeResult.rows[0];
    if (!assigneeRow) throw new Error('seed assignee insert produced no row');
    assigneeUserId = assigneeRow.id;

    readOnlyToken = await insertPersonalToken(['issues:read']);
    wrongScopeToken = await insertPersonalToken(['documents:read']);
    writeToken = await insertPersonalToken(['issues:write']);
    appOnlyWriteToken = await insertAppOnlyToken(['issues:write']);

    // A non-issue document, to confirm the resource filters by document_type.
    await pool.query(
      `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
       VALUES ($1, 'Not an issue', 'wiki', $2, $2)`,
      [workspaceId, new Date(BASE_MS + 500)]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, assigneeUserId]]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('typed fields: state/priority/assignee_id are top-level, not nested in properties', () => {
    it('a seeded issue with full properties returns state/priority/assignee_id at the top level', async () => {
      const issueId = await insertIssue('Typed field issue', new Date(BASE_MS + 1000), {
        state: 'in_progress',
        priority: 'urgent',
        assignee_id: assigneeUserId,
        source: 'internal',
      });

      const res = await request(app)
        .get('/api/v1/issues')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const found = body.data.find((i) => i.id === issueId);
      expect(found).toBeDefined();
      // The regression this proves: a naive port of documents.ts's
      // serializeDocument would return `properties: {...}` with state/
      // priority/assignee_id buried inside it and NO top-level fields at
      // all — this assertion fails against that shape.
      expect(found?.state).toBe('in_progress');
      expect(found?.priority).toBe('urgent');
      expect(found?.assignee_id).toBe(assigneeUserId);
      expect(found?.document_type).toBe('issue');
      // Not left ALSO buried in a nested properties blob — this resource is
      // a typed view, not a raw JSONB passthrough (see issues.ts's header).
      expect(found?.properties).toBeUndefined();
    });

    it('an issue with no properties set falls back to state=backlog, priority=medium, assignee_id=null', async () => {
      const issueId = await insertIssue('Bare issue', new Date(BASE_MS + 2000), {});

      const res = await request(app)
        .get('/api/v1/issues')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const found = body.data.find((i) => i.id === issueId);
      expect(found).toBeDefined();
      expect(found?.state).toBe('backlog');
      expect(found?.priority).toBe('medium');
      expect(found?.assignee_id).toBeNull();
    });
  });

  describe('list only returns document_type = issue', () => {
    it('a wiki document seeded in the same workspace never appears', async () => {
      const res = await request(app)
        .get('/api/v1/issues')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        expect(item.document_type).toBe('issue');
      }
    });
  });

  describe('cursor pagination', () => {
    it('paginates with limit and returns a next_cursor when more rows remain', async () => {
      // At least 3 issues already exist from the tests above; add 2 more
      // with distinct, later timestamps for a deterministic page-1 walk.
      await insertIssue('Pagination A', new Date(BASE_MS + 10000), { state: 'todo' });
      await insertIssue('Pagination B', new Date(BASE_MS + 11000), { state: 'todo' });

      const res = await request(app)
        .get('/api/v1/issues?limit=1')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data).toHaveLength(1);
      expect(typeof body.next_cursor).toBe('string');
    });

    it('walks to page 2 with the returned next_cursor and never repeats a row', async () => {
      const res = await request(app)
        .get('/api/v1/issues?limit=1')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data).toHaveLength(1);
      expect(typeof body.next_cursor).toBe('string');

      const page2 = await request(app)
        .get(`/api/v1/issues?limit=1&cursor=${encodeURIComponent(body.next_cursor as string)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(page2.status).toBe(200);
      const body2 = page2.body as ListResponseBody;
      expect(body2.data).toHaveLength(1);
      // Page 2's row is strictly older (keyset order is created_at DESC, id
      // DESC) than page 1's, and never a repeat of it.
      expect(body2.data[0]?.id).not.toBe(body.data[0]?.id);
    });

    it('rejects a malformed cursor with 400 validation_failed', async () => {
      const res = await request(app)
        .get('/api/v1/issues?cursor=not-a-real-cursor')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fieldErrors.cursor).toBeDefined();
    });
  });

  // PF-205 (Linear TRO-414). Confirmed red-before-green live: written and
  // run against the pre-fix `ListIssuesQuerySchema` (no `assignee_id` field,
  // no WHERE-clause branch) — both assertions below failed for the right
  // reason (both assignees' issues came back, unfiltered: 3 vs the expected
  // 1 with the "does not include" assertion actually failing), not an
  // import/typo error. Then the `assignee_id` schema field + WHERE clause
  // were added and this re-ran green.
  describe('?assignee_id= filter (PF-205, TRO-414)', () => {
    it('only returns issues whose assignee_id matches the query param', async () => {
      const targetId = await insertIssue('Filtered by assignee', new Date(BASE_MS + 30000), {
        state: 'todo',
        assignee_id: assigneeUserId,
      });
      const otherAssignee = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, last_workspace_id)
         VALUES ($1, 'test-hash', 'PF-205 Other Assignee', $2) RETURNING id`,
        [`pf205-other-assignee-${testRunId}@ship.local`, workspaceId]
      );
      const otherAssigneeId = otherAssignee.rows[0]?.id;
      if (!otherAssigneeId) throw new Error('seed other-assignee insert produced no row');
      const otherId = await insertIssue('Different assignee', new Date(BASE_MS + 31000), {
        state: 'todo',
        assignee_id: otherAssigneeId,
      });

      const res = await request(app)
        .get(`/api/v1/issues?assignee_id=${assigneeUserId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((i) => i.id);
      expect(ids).toContain(targetId);
      expect(ids).not.toContain(otherId);
      for (const item of body.data) {
        expect(item.assignee_id).toBe(assigneeUserId);
      }

      await pool.query('DELETE FROM users WHERE id = $1', [otherAssigneeId]);
    });

    it('a malformed (non-UUID) assignee_id -> 400 validation_failed', async () => {
      const res = await request(app)
        .get('/api/v1/issues?assignee_id=not-a-uuid')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fieldErrors.assignee_id).toBeDefined();
    });
  });

  describe('scope enforcement', () => {
    it('a token without issues:read gets 403, details.missing_scope = issues:read', async () => {
      const res = await request(app)
        .get('/api/v1/issues')
        .set('Authorization', `Bearer ${wrongScopeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'issues:read' });
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const res = await request(app).get('/api/v1/issues');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(typeof res.body.request_id).toBe('string');
    });
  });

  // PF-703 (Linear TRO-435) — the agent gate's sdk-mode write path
  // (GateShipClient.applyIssueTransition). See UpdateIssueRequestSchema's
  // own doc comment for the deliberate state-only scope narrowing.
  describe('PATCH /api/v1/issues/:id (PF-703, TRO-435)', () => {
    it('applies a state transition, sets started_at, logs document_history attributed to the caller, and preserves other properties', async () => {
      const issueId = await insertIssue('PATCH transition issue', new Date(BASE_MS + 40000), {
        state: 'todo',
        priority: 'high',
        assignee_id: assigneeUserId,
      });

      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM document_history WHERE document_id = $1`,
        [issueId]
      );

      const res = await request(app)
        .patch(`/api/v1/issues/${issueId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ state: 'in_progress' });

      expect(res.status).toBe(200);
      const body = res.body as IssueBody;
      expect(body.id).toBe(issueId);
      expect(body.state).toBe('in_progress');
      // Untouched by this PATCH (state-only body) — the whole-object
      // replacement (`{ ...currentProps, state: newState }`) must not clobber
      // sibling properties keys.
      expect(body.priority).toBe('high');
      expect(body.assignee_id).toBe(assigneeUserId);

      const row = await pool.query<{ started_at: Date | null; completed_at: Date | null }>(
        `SELECT started_at, completed_at FROM documents WHERE id = $1`,
        [issueId]
      );
      expect(row.rows[0]?.started_at).not.toBeNull();
      expect(row.rows[0]?.completed_at).toBeNull();

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM document_history WHERE document_id = $1`,
        [issueId]
      );
      expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);

      const historyRow = await pool.query<{
        field: string;
        old_value: string | null;
        new_value: string | null;
        changed_by: string;
        automated_by: string | null;
      }>(
        `SELECT field, old_value, new_value, changed_by, automated_by FROM document_history
         WHERE document_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [issueId]
      );
      expect(historyRow.rows[0]?.field).toBe('state');
      expect(historyRow.rows[0]?.old_value).toBe('todo');
      expect(historyRow.rows[0]?.new_value).toBe('in_progress');
      // Attributed to the bearer token's OWN user — never a fabricated or
      // absent actor (this is the human-attribution proof at the unit
      // level; the live-DB gate test proves it end-to-end through the
      // agent's own GateShipClient).
      expect(historyRow.rows[0]?.changed_by).toBe(userId);
      expect(historyRow.rows[0]?.automated_by).toBeNull();
    });

    it('a transition to done sets completed_at', async () => {
      const issueId = await insertIssue('PATCH done issue', new Date(BASE_MS + 41000), {
        state: 'in_review',
      });

      const res = await request(app)
        .patch(`/api/v1/issues/${issueId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ state: 'done' });

      expect(res.status).toBe(200);
      const row = await pool.query<{ completed_at: Date | null }>(
        `SELECT completed_at FROM documents WHERE id = $1`,
        [issueId]
      );
      expect(row.rows[0]?.completed_at).not.toBeNull();
    });

    it('a well-formed but nonexistent id -> 404 not_found', async () => {
      const res = await request(app)
        .patch('/api/v1/issues/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ state: 'in_progress' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('an issue belonging to a DIFFERENT workspace -> 404, never updated (workspace isolation)', async () => {
      const otherWorkspace = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
        [`PF-703 other workspace ${testRunId}`]
      );
      const otherWorkspaceId = onlyRow(otherWorkspace.rows).id;
      const otherIssue = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, title, document_type, properties, created_at, updated_at)
         VALUES ($1, 'Other workspace issue', 'issue', $2, $3, $3) RETURNING id`,
        [otherWorkspaceId, JSON.stringify({ state: 'todo' }), new Date(BASE_MS + 42000)]
      );
      const otherIssueId = onlyRow(otherIssue.rows).id;

      const res = await request(app)
        .patch(`/api/v1/issues/${otherIssueId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ state: 'in_progress' });

      expect(res.status).toBe(404);

      const row = await pool.query<{ state: string }>(
        `SELECT properties->>'state' AS state FROM documents WHERE id = $1`,
        [otherIssueId]
      );
      expect(row.rows[0]?.state).toBe('todo');

      await pool.query('DELETE FROM workspaces WHERE id = $1', [otherWorkspaceId]);
    });

    it('an unrecognized state value -> 400 validation_failed', async () => {
      const issueId = await insertIssue('PATCH bad state issue', new Date(BASE_MS + 43000), {
        state: 'todo',
      });

      const res = await request(app)
        .patch(`/api/v1/issues/${issueId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ state: 'not_a_real_state' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('a token without issues:write gets 403, details.missing_scope = issues:write', async () => {
      const issueId = await insertIssue('PATCH missing scope issue', new Date(BASE_MS + 44000), {
        state: 'todo',
      });

      const res = await request(app)
        .patch(`/api/v1/issues/${issueId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`)
        .send({ state: 'in_progress' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'issues:write' });
    });

    it('an app-only (Client Credentials) token gets 403 — no acting user to attribute the change to', async () => {
      const issueId = await insertIssue('PATCH app-only issue', new Date(BASE_MS + 45000), {
        state: 'todo',
      });

      const res = await request(app)
        .patch(`/api/v1/issues/${issueId}`)
        .set('Authorization', `Bearer ${appOnlyWriteToken}`)
        .send({ state: 'in_progress' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');

      // Never applied — the guard runs before the UPDATE.
      const row = await pool.query<{ state: string }>(
        `SELECT properties->>'state' AS state FROM documents WHERE id = $1`,
        [issueId]
      );
      expect(row.rows[0]?.state).toBe('todo');
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const issueId = await insertIssue('PATCH no auth issue', new Date(BASE_MS + 46000), {
        state: 'todo',
      });

      const res = await request(app).patch(`/api/v1/issues/${issueId}`).send({ state: 'in_progress' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });
  });
});
