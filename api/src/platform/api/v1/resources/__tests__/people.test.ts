/**
 * PF-205 (Linear TRO-414) — `/api/v1/people`: cursor-paginated list of
 * person-typed documents, typed fields (`user_id`/`is_archived`/
 * `is_pending`/`reports_to`/`role`) lifted to the top level.
 *
 * Fixture pattern copied from `resources/issues.test.ts` (real `createApp()`,
 * direct SQL fixtures, personal tokens via `api_tokens`).
 *
 * Red-before-green note (CLAUDE.md claim provenance — derived, not assumed):
 * `GET /api/v1/people` did not exist before this ticket — confirmed by
 * reading `router.ts` and `resources/people.ts` before this diff (neither
 * existed on `main`), not by a live pre-fix test run. Before this diff, any
 * request to this path fell through to `notFoundHandler` (a `not_found`
 * ApiError), which every assertion below would fail against.
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

interface PersonBody {
  id: string;
  name: string;
  document_type: string;
  user_id: string | null;
  email: string | null;
  is_archived: boolean;
  is_pending: boolean;
  reports_to: string | null;
  role: string | null;
}

interface ListResponseBody {
  data: PersonBody[];
  next_cursor: string | null;
}

describe('PF-205: /api/v1/people (Linear TRO-414)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const BASE_MS = Date.parse('2026-03-01T00:00:00.000Z');

  let workspaceId: string;
  let userId: string;
  let linkedUserId: string;
  /** scopes = ['documents:read'] — the scope this resource is documented to
   * reuse (no people:read exists). */
  let readOnlyToken: string;
  let wrongScopeToken: string;

  async function insertPersonalToken(scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-205 people token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  async function insertPerson(
    name: string,
    createdAt: Date,
    properties: Record<string, unknown>,
    archived: boolean = false
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, properties, archived_at, created_at, updated_at)
       VALUES ($1, $2, 'person', $3, $4, $5, $5) RETURNING id`,
      [workspaceId, name, JSON.stringify(properties), archived ? createdAt : null, createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('seed insertPerson produced no row');
    return row.id;
  }

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-205 People Test ${testRunId}`]
    );
    const workspaceRow = workspaceResult.rows[0];
    if (!workspaceRow) throw new Error('seed workspace insert produced no row');
    workspaceId = workspaceRow.id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-205 Test User', $2) RETURNING id`,
      [`pf205-people-${testRunId}@ship.local`, workspaceId]
    );
    const userRow = userResult.rows[0];
    if (!userRow) throw new Error('seed user insert produced no row');
    userId = userRow.id;

    const linkedResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-205 Linked User', $2) RETURNING id`,
      [`pf205-linked-${testRunId}@ship.local`, workspaceId]
    );
    const linkedRow = linkedResult.rows[0];
    if (!linkedRow) throw new Error('seed linked user insert produced no row');
    linkedUserId = linkedRow.id;

    readOnlyToken = await insertPersonalToken(['documents:read']);
    wrongScopeToken = await insertPersonalToken(['issues:read']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, linkedUserId]]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('typed fields: user_id/is_archived/is_pending/reports_to/role are top-level', () => {
    it('a fully-populated person returns every typed field at the top level, name from title', async () => {
      const personId = await insertPerson('Jordan Rivera', new Date(BASE_MS + 1000), {
        user_id: linkedUserId,
        email: 'jordan@ship.local',
        pending: 'true',
        reports_to: userId,
        role: 'engineer',
      });

      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const found = body.data.find((p) => p.id === personId);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Jordan Rivera');
      expect(found?.document_type).toBe('person');
      expect(found?.user_id).toBe(linkedUserId);
      expect(found?.email).toBe('jordan@ship.local');
      expect(found?.is_pending).toBe(true);
      expect(found?.reports_to).toBe(userId);
      expect(found?.role).toBe('engineer');
      expect(found?.is_archived).toBe(false);
    });

    it('a bare person (no properties) falls back to null user_id/email/reports_to/role, is_pending false', async () => {
      const personId = await insertPerson('Bare Person', new Date(BASE_MS + 2000), {});

      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const found = body.data.find((p) => p.id === personId);
      expect(found).toBeDefined();
      expect(found?.user_id).toBeNull();
      expect(found?.email).toBeNull();
      expect(found?.is_pending).toBe(false);
      expect(found?.reports_to).toBeNull();
      expect(found?.role).toBeNull();
    });

    it('an archived person reports is_archived: true', async () => {
      const personId = await insertPerson('Archived Person', new Date(BASE_MS + 3000), {}, true);

      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const found = body.data.find((p) => p.id === personId);
      expect(found).toBeDefined();
      expect(found?.is_archived).toBe(true);
    });
  });

  describe('list only returns document_type = person', () => {
    it('a wiki document seeded in the same workspace never appears', async () => {
      await pool.query(
        `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
         VALUES ($1, 'Not a person', 'wiki', $2, $2)`,
        [workspaceId, new Date(BASE_MS + 4000)]
      );

      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        expect(item.document_type).toBe('person');
      }
    });
  });

  describe('cursor pagination', () => {
    it('paginates with limit and walks to page 2 without repeating a row', async () => {
      await insertPerson('Pagination A', new Date(BASE_MS + 10000), {});
      await insertPerson('Pagination B', new Date(BASE_MS + 11000), {});

      const page1 = await request(app)
        .get('/api/v1/people?limit=1')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(page1.status).toBe(200);
      const page1Body = page1.body as ListResponseBody;
      expect(page1Body.data).toHaveLength(1);
      expect(typeof page1Body.next_cursor).toBe('string');

      const page2 = await request(app)
        .get(`/api/v1/people?limit=1&cursor=${encodeURIComponent(page1Body.next_cursor as string)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(page2.status).toBe(200);
      const page2Body = page2.body as ListResponseBody;
      expect(page2Body.data).toHaveLength(1);
      expect(page2Body.data[0]?.id).not.toBe(page1Body.data[0]?.id);
    });
  });

  describe('scope enforcement', () => {
    it('documents:read is sufficient (no separate people:read scope exists)', async () => {
      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
    });

    it('a token without documents:read gets 403, details.missing_scope = documents:read', async () => {
      const res = await request(app)
        .get('/api/v1/people')
        .set('Authorization', `Bearer ${wrongScopeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const res = await request(app).get('/api/v1/people');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(typeof res.body.request_id).toBe('string');
    });
  });
});
