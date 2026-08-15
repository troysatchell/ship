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

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface DocumentBody {
  id: string;
  title: string;
  document_type: string;
  properties?: Record<string, unknown>;
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
});
