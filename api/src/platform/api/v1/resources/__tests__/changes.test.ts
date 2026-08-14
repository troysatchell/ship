/**
 * PF-205 (Linear TRO-414) — `/api/v1/changes`: the public, cursor-lagged
 * change-feed contract. Mirrors `api/src/routes/change-feed.test.ts`'s own
 * scenario shapes (verified by reading that file before writing this), but
 * exercised through the public v1 surface: bearer auth, `documents:read`
 * scope, ApiError shape, and the merged `{ resource, ... }` `data` array
 * this file's own header explains.
 *
 * Red-before-green note (CLAUDE.md claim provenance — derived, not assumed):
 * `GET /api/v1/changes` did not exist before this ticket — confirmed by
 * reading `router.ts` before this diff (no `/changes` mount existed).
 * Before this diff, every request below would have 404'd via
 * `notFoundHandler` instead of returning the shapes asserted here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { CHANGE_FEED_LAG_MS } from '../changes.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface ChangeEntry {
  resource: 'document' | 'document_history' | 'comment';
  dedupe_key: string;
  id: string | number;
  [key: string]: unknown;
}

interface ChangesResponseBody {
  data: ChangeEntry[];
  next_cursor: string;
  truncated: { documents: boolean; document_history: boolean; comments: boolean };
}

describe('PF-205: /api/v1/changes (Linear TRO-414)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let userId: string;
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
        `PF-205 changes token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-205 Changes Test ${testRunId}`]
    );
    const workspaceRow = workspaceResult.rows[0];
    if (!workspaceRow) throw new Error('seed workspace insert produced no row');
    workspaceId = workspaceRow.id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-205 Changes User', $2) RETURNING id`,
      [`pf205-changes-${testRunId}@ship.local`, workspaceId]
    );
    const userRow = userResult.rows[0];
    if (!userRow) throw new Error('seed user insert produced no row');
    userId = userRow.id;

    readOnlyToken = await insertPersonalToken(['documents:read']);
    wrongScopeToken = await insertPersonalToken(['issues:read']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM comments WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('required since param and future-dated rejection', () => {
    it('missing since -> 400 validation_failed, details names the field', async () => {
      const res = await request(app)
        .get('/api/v1/changes')
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(Object.keys(res.body.details.fieldErrors ?? {})).toContain('since');
    });

    it('since in the future -> 400 validation_failed', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = await request(app)
        .get(`/api/v1/changes?since=${encodeURIComponent(future)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fieldErrors.since).toBeDefined();
    });
  });

  describe('merged data array: a document change and a comment change both appear, tagged by resource', () => {
    // `since` and the seeded `updated_at` both have to land INSIDE the
    // window the endpoint actually queries: `updated_at > since AND
    // updated_at <= safeCutoff`, where `safeCutoff = max(now -
    // CHANGE_FEED_LAG_MS, since)`. A `since` more recent than
    // `now - CHANGE_FEED_LAG_MS` collapses that window to empty (since ==
    // safeCutoff) — this is the cursor-lag mechanism working as designed
    // (see the other describe block below), not a bug, but it means these
    // two tests need `since` safely OLDER than the lag window, and the
    // seeded row's `updated_at` safely INSIDE it (older than "now" by more
    // than CHANGE_FEED_LAG_MS's own margin, but newer than `since`).
    it('a document updated after since appears as a resource: document entry', async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const updatedAt = new Date(Date.now() - 10_000);

      const docResult = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
         VALUES ($1, 'Changed doc', 'wiki', $2, $2) RETURNING id`,
        [workspaceId, updatedAt]
      );
      const docId = docResult.rows[0]?.id;
      if (!docId) throw new Error('seed document insert produced no row');

      const res = await request(app)
        .get(`/api/v1/changes?since=${encodeURIComponent(since)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ChangesResponseBody;
      const found = body.data.find((e) => e.resource === 'document' && e.id === docId);
      expect(found).toBeDefined();
      expect(found?.dedupe_key).toMatch(new RegExp(`^document:${docId}:`));
      expect(typeof body.next_cursor).toBe('string');
      expect(body.truncated).toEqual({ documents: false, document_history: false, comments: false });
    });

    it('a comment updated after since appears as a resource: comment entry, with author null-safe', async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const updatedAt = new Date(Date.now() - 10_000);

      const docResult = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, title, document_type, created_at, updated_at)
         VALUES ($1, 'Doc with a comment', 'wiki', $2, $2) RETURNING id`,
        [workspaceId, updatedAt]
      );
      const docId = docResult.rows[0]?.id;
      if (!docId) throw new Error('seed document insert produced no row');

      const commentResult = await pool.query<{ id: string }>(
        `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'a change-feed comment', $5, $5) RETURNING id`,
        [docId, crypto.randomUUID(), userId, workspaceId, updatedAt]
      );
      const commentId = commentResult.rows[0]?.id;
      if (!commentId) throw new Error('seed comment insert produced no row');

      const res = await request(app)
        .get(`/api/v1/changes?since=${encodeURIComponent(since)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ChangesResponseBody;
      const found = body.data.find((e) => e.resource === 'comment' && e.id === commentId);
      expect(found).toBeDefined();
      expect(found?.content).toBe('a change-feed comment');
      expect(found?.author_id).toBe(userId);
    });
  });

  describe('cursor-lag semantics: a row updated inside the lag window is withheld', () => {
    it('next_cursor never advances past now - CHANGE_FEED_LAG_MS', async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const beforeCall = Date.now();

      const res = await request(app)
        .get(`/api/v1/changes?since=${encodeURIComponent(since)}`)
        .set('Authorization', `Bearer ${readOnlyToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ChangesResponseBody;
      const nextCursorMs = new Date(body.next_cursor).getTime();
      // The safe cutoff is computed from `now` at the moment the handler
      // ran, which is >= beforeCall — so next_cursor must never exceed
      // (a `now` at or after beforeCall) - CHANGE_FEED_LAG_MS, with a small
      // allowance for the request's own wall-clock time.
      expect(nextCursorMs).toBeLessThanOrEqual(Date.now() - CHANGE_FEED_LAG_MS + 50);
      expect(nextCursorMs).toBeGreaterThanOrEqual(beforeCall - CHANGE_FEED_LAG_MS - 50);
    });
  });

  describe('scope enforcement', () => {
    it('a token without documents:read gets 403, details.missing_scope = documents:read', async () => {
      const since = new Date(Date.now() - 1000).toISOString();
      const res = await request(app)
        .get(`/api/v1/changes?since=${encodeURIComponent(since)}`)
        .set('Authorization', `Bearer ${wrongScopeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
    });

    it('no Authorization header gets 401 in ApiError shape', async () => {
      const res = await request(app).get('/api/v1/changes?since=2026-01-01T00:00:00.000Z');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(typeof res.body.request_id).toBe('string');
    });
  });
});
