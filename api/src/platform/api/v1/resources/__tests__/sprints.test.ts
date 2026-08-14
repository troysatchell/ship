/**
 * PF-201 (Linear TRO-400) — `/api/v1/sprints`: cursor-paginated list over
 * `documents WHERE document_type = 'sprint'`. Same fixture pattern as
 * `documents.test.ts`/`issues.test.ts` (real `createApp()`, direct SQL
 * fixtures, personal tokens).
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

interface SprintBody {
  id: string;
  title: string;
  document_type: string;
  properties?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface ListResponseBody {
  data: SprintBody[];
  next_cursor: string | null;
}

describe('PF-201: /api/v1/sprints (Linear TRO-400)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const BASE_MS = Date.parse('2026-02-02T00:00:00.000Z');

  let workspaceId: string;
  let userId: string;
  /** scopes = ['sprints:read'] only. */
  let readOnlyToken: string;
  /** scopes = ['documents:read'] only — the "lacks sprints:read" case. */
  let wrongScopeToken: string;

  let seedSprintIds: string[];

  async function insertPersonalToken(scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-201 sprints token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  async function insertSprint(
    title: string,
    createdAt: Date,
    properties: Record<string, unknown>
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, properties, created_at, updated_at)
       VALUES ($1, $2, 'sprint', $3, $4, $4) RETURNING id`,
      [workspaceId, title, JSON.stringify(properties), createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('seed insertSprint produced no row');
    return row.id;
  }

  /** Fixed, known anchor date (not CURRENT_DATE) so PF-205's cadence/
   * week-dates test below can compute an exact expected start_date/end_date
   * rather than depending on whatever day the suite happens to run. */
  const WORKSPACE_SPRINT_START_DATE = '2026-01-05'; // a Monday

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, $2) RETURNING id`,
      [`PF-201 Sprints Test ${testRunId}`, WORKSPACE_SPRINT_START_DATE]
    );
    workspaceId = workspaceResult.rows[0]?.id ?? '';

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-201 Sprints Test User', $2) RETURNING id`,
      [`pf201-sprints-${testRunId}@ship.local`, workspaceId]
    );
    userId = userResult.rows[0]?.id ?? '';

    readOnlyToken = await insertPersonalToken(['sprints:read']);
    wrongScopeToken = await insertPersonalToken(['documents:read']);

    seedSprintIds = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertSprint(`Sprint ${i}`, new Date(BASE_MS + i * 1000), {
        sprint_number: i + 1,
        owner_id: userId,
        status: 'planning',
      });
      seedSprintIds.push(id);
    }

    // A non-sprint document, to confirm the resource filters by document_type.
    await pool.query(
      `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
       VALUES ($1, 'Not a sprint', 'issue', $2, $2)`,
      [workspaceId, new Date(BASE_MS + 500)]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('list', () => {
    it('returns only document_type = sprint documents, with the documents.ts envelope shape', async () => {
      const res = await request(app)
        .get('/api/v1/sprints')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data.length).toBeGreaterThanOrEqual(3);
      const ids = body.data.map((s) => s.id);
      for (const seedId of seedSprintIds) {
        expect(ids).toContain(seedId);
      }
      for (const item of body.data) {
        expect(item.document_type).toBe('sprint');
      }
      const found = body.data.find((s) => s.id === seedSprintIds[0]);
      expect(found?.title).toBe('Sprint 0');
      expect(found?.properties).toMatchObject({ sprint_number: 1, status: 'planning' });
    });

    it('paginates with limit and returns a next_cursor when more rows remain', async () => {
      const res = await request(app)
        .get('/api/v1/sprints?limit=1')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(body.data).toHaveLength(1);
      expect(typeof body.next_cursor).toBe('string');
    });
  });

  // PF-205 (Linear TRO-414). Claim-provenance note: `GET /api/v1/sprints/:id`
  // did NOT already exist before this ticket, despite the PRD block's
  // "already exists, extend the response" phrasing — confirmed by reading
  // this whole file (pre-TRO-414, it registered only `GET /`) and by
  // `sprintsRouter`'s route list before this diff. Before this diff, every
  // request below would have 404'd via `notFoundHandler` (a generic
  // not_found ApiError from the v1-level catch-all) rather than the
  // route-level not_found / 200 shapes asserted here.
  describe('GET /:id — sprint-cadence/week-dates (PF-205, TRO-414)', () => {
    it('200 with sprint_number/owner_id/status lifted, plus the computed cadence window', async () => {
      const targetId = seedSprintIds[0];
      if (!targetId) throw new Error('seedSprintIds[0] missing');

      const res = await request(app)
        .get(`/api/v1/sprints/${targetId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(targetId);
      expect(res.body.title).toBe('Sprint 0');
      expect(res.body.document_type).toBe('sprint');
      expect(res.body.sprint_number).toBe(1);
      expect(res.body.owner_id).toBe(userId);
      expect(res.body.status).toBe('planning');
      // Fixed anchor date (see WORKSPACE_SPRINT_START_DATE above) makes this
      // an exact, non-flaky expectation — not "some date near today".
      expect(res.body.workspace_sprint_start_date).toBe(WORKSPACE_SPRINT_START_DATE);
      expect(res.body.start_date).toBe('2026-01-05');
      expect(res.body.end_date).toBe('2026-01-11');
    });

    it('a later sprint_number computes a correspondingly later window', async () => {
      const targetId = seedSprintIds[1];
      if (!targetId) throw new Error('seedSprintIds[1] missing');

      const res = await request(app)
        .get(`/api/v1/sprints/${targetId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      expect(res.body.sprint_number).toBe(2);
      expect(res.body.start_date).toBe('2026-01-12');
      expect(res.body.end_date).toBe('2026-01-18');
    });

    it('a non-existent (but well-formed) id returns 404 in ApiError shape', async () => {
      const res = await request(app)
        .get(`/api/v1/sprints/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(typeof res.body.request_id).toBe('string');
    });

    it('a malformed (non-UUID) id returns 404 in ApiError shape', async () => {
      const res = await request(app)
        .get('/api/v1/sprints/not-a-uuid')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('an issue id (wrong document_type) returns 404, not the issue', async () => {
      const notASprint = await pool.query<{ id: string }>(
        `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'issue' LIMIT 1`,
        [workspaceId]
      );
      const issueId = notASprint.rows[0]?.id;
      if (!issueId) throw new Error('expected the seeded "Not a sprint" issue document to exist');

      const res = await request(app)
        .get(`/api/v1/sprints/${issueId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('a token without sprints:read gets 403, details.missing_scope = sprints:read', async () => {
      const targetId = seedSprintIds[0];
      const res = await request(app)
        .get(`/api/v1/sprints/${targetId}`)
        .set('Authorization', `Bearer ${wrongScopeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'sprints:read' });
    });
  });

  describe('scope enforcement', () => {
    it('a token without sprints:read gets 403, details.missing_scope = sprints:read', async () => {
      const res = await request(app)
        .get('/api/v1/sprints')
        .set('Authorization', `Bearer ${wrongScopeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'sprints:read' });
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const res = await request(app).get('/api/v1/sprints');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(typeof res.body.request_id).toBe('string');
    });
  });
});
