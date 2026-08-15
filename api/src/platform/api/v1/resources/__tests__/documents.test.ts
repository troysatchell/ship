/**
 * PF-200 (Linear TRO-398) — `/api/v1/documents`: cursor-paginated list,
 * get-by-id, create.
 *
 * Test design source: Linear TRO-398 comment "Test design (pre-implementation
 * — ship-test-designer, 2026-08-10)". AC-1..AC-4 below map 1:1 onto that
 * comment's numbering. Uses the real `createApp()` (matches
 * `v1-router.test.ts`/`error-middleware.test.ts`'s pattern) rather than a
 * scratch app — the route under test needs the real `/api/v1` mount, real
 * `bearerAuth`/`requireScope`, and a real database.
 *
 * Workspace-scoping note (see `../workspaceContext.ts`'s header for the full
 * writeup): a scoped personal token resolves its workspace via
 * `users.last_workspace_id`, so every fixture user in this file is created
 * with `last_workspace_id` pointing at this file's own test workspace.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/appRegistration.js';
import { issueClientCredentialsToken } from '../../../../oauth/token.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface DocumentBody {
  id: string;
  title: string;
  document_type: string;
  properties?: Record<string, unknown>;
  content?: unknown;
  visibility?: string;
  created_by?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ListResponseBody {
  data: DocumentBody[];
  next_cursor: string | null;
}

describe('PF-200: /api/v1/documents (Linear TRO-398)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

  let workspaceId: string;
  let userId: string;
  /** scopes = ['documents:read'] only — also the AC-3 "lacks write" case. */
  let readOnlyToken: string;
  /** scopes = ['documents:read', 'documents:write']. */
  let writeToken: string;

  /** The 5 seeded documents' ids, oldest (index 0) to newest (index 4). */
  let seedDocIds: string[];

  async function insertPersonalToken(scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-200 token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  async function insertDocument(
    title: string,
    createdAt: Date,
    documentType: string = 'wiki'
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [workspaceId, title, documentType, createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('seed insertDocument produced no row');
    return row.id;
  }

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-200 Test ${testRunId}`]
    );
    workspaceId = workspaceResult.rows[0]?.id ?? '';

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-200 Test User', $2) RETURNING id`,
      [`pf200-${testRunId}@ship.local`, workspaceId]
    );
    userId = userResult.rows[0]?.id ?? '';

    readOnlyToken = await insertPersonalToken(['documents:read']);
    writeToken = await insertPersonalToken(['documents:read', 'documents:write']);

    // AC-1 seed: 5 documents with distinct created_at timestamps.
    seedDocIds = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertDocument(`Seed Doc ${i}`, new Date(BASE_MS + i * 1000));
      seedDocIds.push(id);
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('AC-1: cursor-paginated list — stable across a mid-iteration insertion', () => {
    it('no duplicate/skipped ids across pages after an insert between the page boundary; next_cursor round-trips opaquely', async () => {
      const limit = 2;

      const page1 = await request(app)
        .get(`/api/v1/documents?limit=${limit}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(page1.status).toBe(200);
      const page1Body = page1.body as ListResponseBody;
      expect(page1Body.data).toHaveLength(2);
      expect(typeof page1Body.next_cursor).toBe('string');
      const cursorAfterPage1 = page1Body.next_cursor;
      if (cursorAfterPage1 === null) throw new Error('expected a next_cursor after page 1');

      // Insert mid-iteration: created_at falls strictly between seed doc 2
      // (BASE_MS + 2000, the last row of page 2) and seed doc 3 (BASE_MS +
      // 3000, the last row of page 1) — i.e. exactly the page-1/page-2
      // boundary the captured cursor anchors to.
      const midIterationId = await insertDocument(
        'Mid-iteration insert',
        new Date(BASE_MS + 2500)
      );

      // Walk every remaining page using ONLY the cursor the server returned
      // — this test never decodes/parses it, only passes it back verbatim.
      const restIds: string[] = [];
      let cursor: string | null = cursorAfterPage1;
      let guard = 0;
      while (cursor !== null) {
        guard += 1;
        if (guard > 10) throw new Error('pagination did not terminate — possible infinite loop');
        const res = await request(app)
          .get(`/api/v1/documents?limit=${limit}&cursor=${encodeURIComponent(cursor)}`)
          .set('Authorization', `Bearer ${readOnlyToken}`);
        expect(res.status).toBe(200);
        const body = res.body as ListResponseBody;
        restIds.push(...body.data.map((d) => d.id));
        cursor = body.next_cursor;
      }

      const allIds = [...page1Body.data.map((d) => d.id), ...restIds];

      // No duplicates anywhere in the full walk.
      expect(new Set(allIds).size).toBe(allIds.length);

      // Every one of the 5 pre-insertion seed docs appears EXACTLY once —
      // the keyset-stability guarantee under a concurrent insert.
      for (const id of seedDocIds) {
        expect(allIds.filter((x) => x === id)).toHaveLength(1);
      }

      // The mid-iteration insert itself is visible exactly once (it ranks
      // after the captured cursor, so it must appear on a later page).
      expect(allIds.filter((x) => x === midIterationId)).toHaveLength(1);
    });
  });

  describe('TRO-602: cursor precision — rows within the same millisecond are never silently dropped', () => {
    /** Inserts a document with `created_at` set to `baseMs` PLUS a raw
     *  microsecond offset, computed entirely in SQL (`interval` arithmetic)
     *  rather than via a JS `Date` — a `Date` cannot represent sub-
     *  millisecond precision at all, so passing one in (as `insertDocument`
     *  above does, and as this exact bug's root cause does at read time)
     *  could never produce a genuine same-millisecond/different-microsecond
     *  pair to seed with. This makes the collision deterministic instead of
     *  dependent on real insert timing happening to land within 1ms (which
     *  the ticket's own reproduction notes as merely "reliably
     *  reproducible", not guaranteed) — a flaky proof of a bug this
     *  specific would be worse than no proof at all. */
    async function insertDocumentAtPreciseTime(
      title: string,
      baseMs: number,
      microsecondOffset: number
    ): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
         VALUES (
           $1, $2, 'wiki',
           to_timestamp($3 / 1000.0) + ($4 || ' microseconds')::interval,
           to_timestamp($3 / 1000.0) + ($4 || ' microseconds')::interval
         )
         RETURNING id`,
        [workspaceId, title, baseMs, microsecondOffset]
      );
      const row = result.rows[0];
      if (!row) throw new Error('seed insertDocumentAtPreciseTime produced no row');
      return row.id;
    }

    it('two rows in the same millisecond, at different microsecond offsets, are both returned across pages', async () => {
      // A base far enough from every other test's seed data (5000s offset,
      // well past AC-1's BASE_MS+0..4000ms range and its BASE_MS+2500ms
      // mid-iteration insert) that this collision pair can never be
      // adjacent to, or mistaken for, unrelated seeded rows.
      const collisionBaseMs = BASE_MS + 5_000_000;

      // Same millisecond (collisionBaseMs), microsecond offsets 100 and 900
      // — genuinely different `timestamptz` values Postgres orders
      // correctly, but whose shared millisecond-truncated ISO string
      // (`Date#toISOString()`) would have been indistinguishable under the
      // pre-fix cursor encoding (TRO-602's actual bug).
      const earlierId = await insertDocumentAtPreciseTime('TRO-602 collision A', collisionBaseMs, 100);
      const laterId = await insertDocumentAtPreciseTime('TRO-602 collision B', collisionBaseMs, 900);

      // limit=1 forces a page boundary to land exactly between these two
      // rows (ORDER BY created_at DESC, id DESC — laterId page 1, earlierId
      // page 2) — the precise scenario where a truncated cursor would put
      // earlierId on the wrong side of the boundary and drop it forever.
      const page1 = await request(app)
        .get('/api/v1/documents?limit=1')
        .set('Authorization', `Bearer ${readOnlyToken}`);
      expect(page1.status).toBe(200);
      const page1Body = page1.body as ListResponseBody;
      expect(page1Body.data[0]?.id).toBe(laterId);
      expect(page1Body.next_cursor).not.toBeNull();

      const page2 = await request(app)
        .get(`/api/v1/documents?limit=1&cursor=${encodeURIComponent(page1Body.next_cursor as string)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);
      expect(page2.status).toBe(200);
      const page2Body = page2.body as ListResponseBody;
      expect(
        page2Body.data.map((d) => d.id),
        'earlierId was silently dropped across the millisecond-collision page boundary (TRO-602)'
      ).toContain(earlierId);
    });
  });

  describe('AC-2: GET /:id', () => {
    it('200 with the seeded document body matching id/title/type', async () => {
      const targetId = seedDocIds[0];
      if (!targetId) throw new Error('seedDocIds[0] missing');

      const res = await request(app)
        .get(`/api/v1/documents/${targetId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as DocumentBody;
      expect(body.id).toBe(targetId);
      expect(body.title).toBe('Seed Doc 0');
      expect(body.document_type).toBe('wiki');
    });

    it('a non-existent (but well-formed) id returns 404 in ApiError shape', async () => {
      const res = await request(app)
        .get(`/api/v1/documents/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
      expect(typeof res.body.request_id).toBe('string');
      expect(res.body.request_id.length).toBeGreaterThan(0);
    });
  });

  describe('AC-3: POST — via the domain service path, require(documents:write)', () => {
    it('a valid POST with documents:write -> 201 + created id; a follow-up GET confirms persistence', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ title: 'Created via v1 POST', document_type: 'wiki' });

      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe('string');

      const getRes = await request(app)
        .get(`/api/v1/documents/${res.body.id}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(res.body.id);
      expect(getRes.body.title).toBe('Created via v1 POST');
      expect(getRes.body.document_type).toBe('wiki');
    });

    it('the same POST with a documents:read-only token -> 403, details.missing_scope = documents:write', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${readOnlyToken}`)
        .send({ title: 'Should never be created' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'documents:write' });
    });
  });

  describe('AC-4: 404/validation errors in ApiError shape', () => {
    it('POST with a body missing the required title field -> validation_failed, details names the field', async () => {
      const res = await request(app)
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ document_type: 'wiki' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
      expect(typeof res.body.request_id).toBe('string');
      expect(res.body.request_id.length).toBeGreaterThan(0);
      expect(res.body.details).toBeDefined();
      // "details names the offending field" — zod's flattened fieldErrors
      // keys by field name, so `title` must be a key.
      expect(Object.keys(res.body.details.fieldErrors ?? {})).toContain('title');
    });

    it('GET with a malformed (non-UUID) id -> not_found ApiError shape', async () => {
      const res = await request(app)
        .get('/api/v1/documents/not-a-uuid')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(typeof res.body.request_id).toBe('string');
      expect(res.body.request_id.length).toBeGreaterThan(0);
    });
  });

  describe('additional coverage: ?type= filter (architect note — PF-205 needs it too)', () => {
    it('only returns documents matching the requested document_type', async () => {
      const issueId = await insertDocument('An issue doc', new Date(BASE_MS + 20000), 'issue');

      const res = await request(app)
        .get('/api/v1/documents?type=issue')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((d) => d.id);
      expect(ids).toContain(issueId);
      for (const seedId of seedDocIds) {
        expect(ids).not.toContain(seedId);
      }
    });
  });

  // PF-205 (Linear TRO-414) — the four new sub-resources: forward/reverse
  // associations, backlinks, comments. Claim-provenance note: these routes
  // did not exist before this ticket (confirmed by reading this router file
  // before the diff), so every assertion below would previously 404 via
  // notFoundHandler rather than the shapes asserted here.
  describe('PF-205: GET /:id/associations', () => {
    it('returns forward edges FROM the anchor document, without a joined title/type (leak avoidance)', async () => {
      const anchorId = await insertDocument('Association anchor', new Date(BASE_MS + 40000));
      const relatedId = await insertDocument('Related doc', new Date(BASE_MS + 40001));
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'blocks')`,
        [anchorId, relatedId]
      );

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}/associations`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as { data: Array<Record<string, unknown>>; next_cursor: string | null };
      expect(body.data).toHaveLength(1);
      const edge = body.data[0];
      expect(edge?.document_id).toBe(anchorId);
      expect(edge?.related_id).toBe(relatedId);
      expect(edge?.relationship_type).toBe('blocks');
      expect(edge).not.toHaveProperty('related_title');
      expect(edge).not.toHaveProperty('related_document_type');
    });

    it('a non-existent anchor id -> 404 not_found', async () => {
      const res = await request(app)
        .get(`/api/v1/documents/${crypto.randomUUID()}/associations`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });
  });

  describe('PF-205: GET /:id/reverse-associations', () => {
    it('returns edges pointing AT the anchor document', async () => {
      const anchorId = await insertDocument('Reverse anchor', new Date(BASE_MS + 41000));
      const pointerId = await insertDocument('Pointer doc', new Date(BASE_MS + 41001));
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'sprint')`,
        [pointerId, anchorId]
      );

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}/reverse-associations`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as { data: Array<Record<string, unknown>>; next_cursor: string | null };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.document_id).toBe(pointerId);
      expect(body.data[0]?.related_id).toBe(anchorId);
      expect(body.data[0]?.relationship_type).toBe('sprint');
    });
  });

  describe('PF-205: GET /:id/backlinks', () => {
    it('returns documents that link to the anchor, with display_id for an issue source', async () => {
      const anchorId = await insertDocument('Backlink target', new Date(BASE_MS + 42000));
      const sourceResult = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, title, document_type, ticket_number, created_at, updated_at)
         VALUES ($1, 'Linking issue', 'issue', 777, $2, $2) RETURNING id`,
        [workspaceId, new Date(BASE_MS + 42001)]
      );
      const sourceId = sourceResult.rows[0]?.id;
      if (!sourceId) throw new Error('seed source document insert produced no row');
      await pool.query(
        `INSERT INTO document_links (source_id, target_id) VALUES ($1, $2)`,
        [sourceId, anchorId]
      );

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}/backlinks`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as { data: Array<Record<string, unknown>>; next_cursor: string | null };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(sourceId);
      expect(body.data[0]?.document_type).toBe('issue');
      expect(body.data[0]?.title).toBe('Linking issue');
      expect(body.data[0]?.display_id).toBe('#777');
    });

    it('a non-issue source has display_id: null', async () => {
      const anchorId = await insertDocument('Backlink target 2', new Date(BASE_MS + 43000));
      const sourceId = await insertDocument('Linking wiki page', new Date(BASE_MS + 43001), 'wiki');
      await pool.query(
        `INSERT INTO document_links (source_id, target_id) VALUES ($1, $2)`,
        [sourceId, anchorId]
      );

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}/backlinks`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as { data: Array<Record<string, unknown>>; next_cursor: string | null };
      const found = body.data.find((b) => b.id === sourceId);
      expect(found).toBeDefined();
      expect(found?.display_id).toBeNull();
    });
  });

  describe('PF-205: GET /:id/comments', () => {
    it('returns comments on the anchor document, with author info', async () => {
      const anchorId = await insertDocument('Commented doc', new Date(BASE_MS + 44000));
      const commentResult = await pool.query<{ id: string }>(
        `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content)
         VALUES ($1, $2, $3, $4, 'a v1 comment') RETURNING id`,
        [anchorId, crypto.randomUUID(), userId, workspaceId]
      );
      const commentId = commentResult.rows[0]?.id;
      if (!commentId) throw new Error('seed comment insert produced no row');

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}/comments`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as {
        data: Array<{ id: string; content: string; author: { id: string; name: string | null } | null }>;
        next_cursor: string | null;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(commentId);
      expect(body.data[0]?.content).toBe('a v1 comment');
      expect(body.data[0]?.author?.id).toBe(userId);

      await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);
    });

    it('a non-existent anchor id -> 404 not_found', async () => {
      const res = await request(app)
        .get(`/api/v1/documents/${crypto.randomUUID()}/comments`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });
  });

  // TRO-605 — widen GET /:id and GET / to include content/visibility/
  // created_by/completed_at, which `serializeDocument()` previously dropped
  // entirely (PF-702's sdk-mode agent reads were degrading silently as a
  // result — see TRO-605's Linear description). These fields did not exist
  // on the response body at all before this change, so every `.toEqual`/
  // `.toBe` assertion below against a real, non-default value would have
  // failed on the unfixed code with `undefined` on the left-hand side — a
  // genuine assertion failure, confirmed red before the fix (see this
  // ticket's PR description for the exact command and output).
  describe('TRO-605: content/visibility/created_by/completed_at round-trip', () => {
    /** Inserts a document with every TRO-605 field set to an explicit,
     *  non-default value, so a test asserting on it can't pass by accident
     *  against a column default (e.g. visibility's own DEFAULT 'workspace',
     *  or completed_at's implicit NULL). */
    async function insertFullyPopulatedDocument(params: {
      title: string;
      createdAt: Date;
      content: Record<string, unknown>;
      visibility: 'private' | 'workspace';
      createdBy: string;
      completedAt: Date;
    }): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO documents
           (workspace_id, title, document_type, content, visibility, created_by, completed_at, created_at, updated_at)
         VALUES ($1, $2, 'issue', $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        [
          workspaceId,
          params.title,
          JSON.stringify(params.content),
          params.visibility,
          params.createdBy,
          params.completedAt,
          params.createdAt,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error('seed insertFullyPopulatedDocument produced no row');
      return row.id;
    }

    it('GET /:id returns the real content/visibility/created_by/completed_at values, not defaults', async () => {
      const content = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TRO-605 round-trip body' }] }],
      };
      const completedAt = new Date(BASE_MS + 60_000);
      const docId = await insertFullyPopulatedDocument({
        title: 'TRO-605 widened doc',
        createdAt: new Date(BASE_MS + 59_000),
        content,
        visibility: 'workspace',
        createdBy: userId,
        completedAt,
      });

      const res = await request(app)
        .get(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as DocumentBody;
      expect(body.content).toEqual(content);
      expect(body.visibility).toBe('workspace');
      expect(body.created_by).toBe(userId);
      expect(body.completed_at).toBe(completedAt.toISOString());
    });

    it('a document that was never completed returns completed_at: null (not omitted, not a default)', async () => {
      const anchorId = await insertDocument('TRO-605 never completed', new Date(BASE_MS + 61_000));

      const res = await request(app)
        .get(`/api/v1/documents/${anchorId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as DocumentBody;
      expect(body).toHaveProperty('completed_at');
      expect(body.completed_at).toBeNull();
      // The column default applies here (schema.sql:158) — this document's
      // visibility was never set explicitly, distinguishing "field is wired
      // up" from "field happens to equal the value this test hardcodes".
      expect(body.visibility).toBe('workspace');
      expect(body.created_by).toBeNull();
    });

    it('GET / (list) carries the same widened fields on every row, not just GET /:id', async () => {
      const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'list row' }] }] };
      const docId = await insertFullyPopulatedDocument({
        title: 'TRO-605 list row',
        createdAt: new Date(BASE_MS + 62_000),
        content,
        visibility: 'workspace',
        createdBy: userId,
        completedAt: new Date(BASE_MS + 62_500),
      });

      const res = await request(app)
        .get(`/api/v1/documents?type=issue`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const row = body.data.find((d) => d.id === docId);
      expect(row, 'seeded row not found on the list response').toBeDefined();
      expect(row?.content).toEqual(content);
      expect(row?.visibility).toBe('workspace');
      expect(row?.created_by).toBe(userId);
      expect(typeof row?.completed_at).toBe('string');
    });

    it('never exposes yjs_state, even though the underlying row has one set', async () => {
      const docId = await insertDocument('TRO-605 has yjs state', new Date(BASE_MS + 63_000));
      await pool.query('UPDATE documents SET yjs_state = $1 WHERE id = $2', [
        Buffer.from([1, 2, 3]),
        docId,
      ]);

      const res = await request(app)
        .get(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('yjs_state');
    });

    // Claim-provenance note (CLAUDE.md), UPDATED after a CodeRabbit finding
    // on this ticket's own PR: GET / and GET /:id scope ONLY by workspace_id
    // (+ deleted_at IS NULL) — this route has never enforced visibility-based
    // access control for title/properties/visibility/created_by/timestamps,
    // confirmed by reading the handler directly (`resources/people.ts`'s own
    // header documents the same pre-existing, disclosed gap). That part is
    // UNCHANGED by this ticket and NOT fixed here — retrofitting full access
    // control onto every field is a materially bigger, auth-semantics change
    // this ticket does not take on (see `serializeDocument()`'s own doc
    // comment for the full reasoning).
    //
    // What IS fixed, in response to that CodeRabbit finding: `content` is a
    // NEW field this ticket adds, and unlike title/properties it can carry a
    // private document's actual body text — shipping it unmasked would turn
    // an existing metadata leak into a content leak, a real escalation in
    // harm this ticket alone would introduce. So `content` (and ONLY
    // `content`) is masked to `null` for a private document the caller did
    // not create; every other field's pre-existing behavior is unchanged.
    describe("visibility: 'private' — content is masked for a non-creator, every other field's pre-existing (unfixed, disclosed) behavior is unchanged", () => {
      let otherUserId: string;
      const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'private body' }] }] };

      beforeAll(async () => {
        const otherUserResult = await pool.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, name, last_workspace_id)
           VALUES ($1, 'test-hash', 'TRO-605 Other User', $2) RETURNING id`,
          [`tro605-other-${testRunId}@ship.local`, workspaceId]
        );
        const id = otherUserResult.rows[0]?.id;
        if (!id) throw new Error('seed other-user insert produced no row');
        otherUserId = id;
      });

      afterAll(async () => {
        await pool.query('DELETE FROM users WHERE id = $1', [otherUserId]);
      });

      it("GET /:id masks content to null for a DIFFERENT user's private document, but still returns visibility/created_by (the pre-existing, unfixed, disclosed metadata leak)", async () => {
        const docId = await insertFullyPopulatedDocument({
          title: 'TRO-605 private doc',
          createdAt: new Date(BASE_MS + 64_000),
          content,
          visibility: 'private',
          createdBy: otherUserId,
          completedAt: new Date(BASE_MS + 64_500),
        });

        // readOnlyToken belongs to `userId`, NOT `otherUserId` — a different
        // principal than the document's creator.
        const res = await request(app)
          .get(`/api/v1/documents/${docId}`)
          .set('Authorization', `Bearer ${readOnlyToken}`);

        expect(
          res.status,
          'this route has never filtered by visibility for non-content fields (documented pre-existing ' +
            'gap) — a private document from another user in the same workspace was, and still is, ' +
            'returned as 200'
        ).toBe(200);
        const body = res.body as DocumentBody;
        expect(body.visibility).toBe('private');
        expect(body.created_by).toBe(otherUserId);
        expect(body.title).toBe('TRO-605 private doc');
        // The fix: content itself is masked, unlike every other field above.
        expect(body.content, 'content must be masked for a private document the caller did not create').toBeNull();
      });

      it('GET /:id returns the REAL content for a private document the caller DID create (creator is never masked from their own content)', async () => {
        const docId = await insertFullyPopulatedDocument({
          title: 'TRO-605 own private doc',
          createdAt: new Date(BASE_MS + 65_000),
          content,
          visibility: 'private',
          createdBy: userId, // readOnlyToken's own principal
          completedAt: new Date(BASE_MS + 65_500),
        });

        const res = await request(app)
          .get(`/api/v1/documents/${docId}`)
          .set('Authorization', `Bearer ${readOnlyToken}`);

        expect(res.status).toBe(200);
        const body = res.body as DocumentBody;
        expect(body.visibility).toBe('private');
        expect(body.created_by).toBe(userId);
        expect(body.content).toEqual(content);
      });

      it('GET / (list) also masks content for a DIFFERENT user\'s private document row', async () => {
        const docId = await insertFullyPopulatedDocument({
          title: 'TRO-605 private list row',
          createdAt: new Date(BASE_MS + 66_000),
          content,
          visibility: 'private',
          createdBy: otherUserId,
          completedAt: new Date(BASE_MS + 66_500),
        });

        const res = await request(app)
          .get('/api/v1/documents?type=issue')
          .set('Authorization', `Bearer ${readOnlyToken}`);

        expect(res.status).toBe(200);
        const body = res.body as ListResponseBody;
        const row = body.data.find((d) => d.id === docId);
        expect(row, 'seeded private row not found on the list response').toBeDefined();
        expect(row?.visibility).toBe('private');
        expect(row?.created_by).toBe(otherUserId);
        expect(row?.content).toBeNull();
      });

      // CodeRabbit finding (2nd round, this ticket): `row.created_by === viewerUserId`
      // alone would treat an ownerless private document (created_by IS NULL)
      // as visible to a caller with no linked user at all (viewerUserId also
      // null) — null === null. A client-credentials OAuth token is exactly
      // that: `principal.user` is null (Client Credentials grants have no
      // acting user — principal.ts's own doc comment).
      it('a private, ownerless document (created_by IS NULL) is masked for a client-credentials (app-only, no linked user) caller', async () => {
        const created = await createOAuthApp({
          workspaceId,
          ownerUserId: userId,
          name: `TRO-605 null-viewer app ${testRunId}`,
          clientType: 'confidential',
          redirectUris: [],
          requestedScopes: ['documents:read'],
        });
        if (!created.clientSecret) {
          throw new Error('expected createOAuthApp to return a raw secret for a confidential client');
        }
        const grant = await issueClientCredentialsToken({
          clientId: created.app.client_id,
          clientSecret: created.clientSecret,
          scope: undefined,
        });
        if (!grant.ok) {
          throw new Error(`issueClientCredentialsToken did not succeed: ${grant.error} ${grant.errorDescription}`);
        }

        const docResult = await pool.query<{ id: string }>(
          `INSERT INTO documents (workspace_id, title, document_type, content, visibility, created_by, created_at, updated_at)
           VALUES ($1, 'TRO-605 ownerless private doc', 'issue', $2, 'private', NULL, $3, $3)
           RETURNING id`,
          [workspaceId, JSON.stringify(content), new Date(BASE_MS + 67_000)]
        );
        const docId = docResult.rows[0]?.id;
        if (!docId) throw new Error('seed ownerless-private-document insert produced no row');

        const res = await request(app)
          .get(`/api/v1/documents/${docId}`)
          .set('Authorization', `Bearer ${grant.accessToken}`);

        expect(res.status).toBe(200);
        const body = res.body as DocumentBody;
        expect(body.visibility).toBe('private');
        expect(body.created_by).toBeNull();
        expect(
          body.content,
          'null created_by must never be treated as matching a null viewerUserId'
        ).toBeNull();

        await pool.query('DELETE FROM oauth_apps WHERE id = $1', [created.app.id]);
      });
    });
  });

  // PF-703 (Linear TRO-435) — the agent gate's sdk-mode write path
  // (GateShipClient.setStandupContent). See UpdateDocumentRequestSchema's
  // own doc comment for the deliberate content-only scope narrowing.
  describe('PATCH /api/v1/documents/:id (PF-703, TRO-435)', () => {
    it('overwrites content and bumps updated_at; a follow-up GET reflects the untouched title/document_type', async () => {
      const docId = await insertDocument('PATCH content doc', new Date(BASE_MS + 50000), 'standup');
      const newContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'patched' }] }] };

      const res = await request(app)
        .patch(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ content: newContent });

      expect(res.status).toBe(200);
      const body = res.body as DocumentBody;
      expect(body.id).toBe(docId);
      expect(body.title).toBe('PATCH content doc');
      expect(body.document_type).toBe('standup');
      // updated_at must have moved past the fixed seed timestamp
      // (CodeRabbit, this PR) — the response's own updated_at is real proof,
      // not just "a 200 came back."
      expect(new Date(body.updated_at as string).getTime()).toBeGreaterThan(BASE_MS + 50000);
      // TRO-605: the PATCH response itself now carries `content` too (it
      // goes through the same, now-widened `serializeDocument()` as GET) —
      // real proof at the HTTP layer, not only via the direct SQL read below.
      expect(body.content).toEqual(newContent);

      const row = await pool.query<{ content: unknown; title: string }>(
        `SELECT content, title FROM documents WHERE id = $1`,
        [docId]
      );
      expect(row.rows[0]?.content).toEqual(newContent);
      // properties/title are untouched by a content-only PATCH.
      expect(row.rows[0]?.title).toBe('PATCH content doc');

      // A follow-up GET reflects title/document_type (unchanged) AND the
      // patched content — TRO-605 widened GET /:id's response to include
      // `content` (previously it did not; see TRO-605's CHANGES.md entry).
      // This assertion used to be `expect('content' in getBody).toBe(false)`
      // — updated because the API's own documented response shape changed,
      // not weakened: it now asserts a stronger, real round-trip instead of
      // asserting the field's absence.
      const getRes = await request(app)
        .get(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);
      expect(getRes.status).toBe(200);
      const getBody = getRes.body as DocumentBody;
      expect(getBody.title).toBe('PATCH content doc');
      expect(getBody.document_type).toBe('standup');
      expect(getBody.content).toEqual(newContent);
    });

    it('a well-formed but nonexistent id -> 404 not_found', async () => {
      const res = await request(app)
        .patch(`/api/v1/documents/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ content: { type: 'doc', content: [] } });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('a malformed (non-UUID) id -> 404 not_found (CodeRabbit, this PR — assertDocumentExists\'s UUID_RE guard, exercised directly for PATCH)', async () => {
      const res = await request(app)
        .patch('/api/v1/documents/not-a-uuid')
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ content: { type: 'doc', content: [] } });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('a missing content field -> 400 validation_failed', async () => {
      const docId = await insertDocument('PATCH missing content doc', new Date(BASE_MS + 51000));

      const res = await request(app)
        .patch(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('a request body with an unrecognized extra field -> 400 validation_failed (strict schema)', async () => {
      const docId = await insertDocument('PATCH strict schema doc', new Date(BASE_MS + 51500));

      const res = await request(app)
        .patch(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ content: { type: 'doc', content: [] }, title: 'Sneaky title change' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');

      // Never silently applied.
      const row = await pool.query<{ title: string }>(`SELECT title FROM documents WHERE id = $1`, [docId]);
      expect(row.rows[0]?.title).toBe('PATCH strict schema doc');
    });

    it('a documents:read-only token -> 403, details.missing_scope = documents:write', async () => {
      const docId = await insertDocument('PATCH missing scope doc', new Date(BASE_MS + 52000));

      const res = await request(app)
        .patch(`/api/v1/documents/${docId}`)
        .set('Authorization', `Bearer ${readOnlyToken}`)
        .send({ content: { type: 'doc', content: [] } });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'documents:write' });
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const docId = await insertDocument('PATCH no auth doc', new Date(BASE_MS + 53000));

      const res = await request(app)
        .patch(`/api/v1/documents/${docId}`)
        .send({ content: { type: 'doc', content: [] } });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });
  });
});
