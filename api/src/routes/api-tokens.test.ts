import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { hashToken } from './api-tokens.js';

describe('API Tokens', () => {
  describe('hashToken', () => {
    it('returns consistent hash for same input', () => {
      const token = 'ship_abc123';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('returns different hash for different input', () => {
      const hash1 = hashToken('ship_abc123');
      const hash2 = hashToken('ship_def456');
      expect(hash1).not.toBe(hash2);
    });

    it('returns 64-character hex string (SHA-256)', () => {
      const hash = hashToken('ship_testtoken');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('is deterministic for token validation', () => {
      // This is how we validate tokens - hash the incoming token and compare to stored hash
      const originalToken = 'ship_secrettoken123';
      const storedHash = hashToken(originalToken);

      // User submits their token
      const submittedToken = 'ship_secrettoken123';
      const submittedHash = hashToken(submittedToken);

      expect(storedHash).toBe(submittedHash);
    });
  });

  /**
   * PF-107 AC-6 (Linear TRO-430, test-design comment 2026-08-10) — real DB +
   * real HTTP layer, not mocked: the assertion is about a *persisted row*
   * (`scopes` column), which a mocked `pool.query` cannot meaningfully prove.
   * Uses the same session+CSRF fixture pattern as `auth.test.ts`/`issues.test.ts`.
   */
  describe('POST /api/api-tokens — scopes parameter (PF-107 / TRO-430)', () => {
    const app = createApp();
    const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const testEmail = `api-tokens-scopes-${testRunId}@ship.local`;

    let sessionCookie: string;
    let csrfToken: string;

    beforeAll(async () => {
      const workspaceResult = await pool.query(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
        [`API Tokens Scopes Test ${testRunId}`]
      );
      const testWorkspaceId = workspaceResult.rows[0].id;

      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'API Tokens Test User')
         RETURNING id`,
        [testEmail]
      );
      const testUserId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
        [testWorkspaceId, testUserId]
      );

      const crypto = await import('crypto');
      const sessionId = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [sessionId, testUserId, testWorkspaceId]
      );
      sessionCookie = `session_id=${sessionId}`;

      const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
      csrfToken = csrfRes.body.token;
      const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      if (connectSidCookie) {
        sessionCookie = `${sessionCookie}; ${connectSidCookie}`;
      }
    });

    it('POST with scopes: [documents:read] persists that scopes array on the api_tokens row', async () => {
      const res = await request(app)
        .post('/api/api-tokens')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: `scoped-token-${testRunId}`, scopes: ['documents:read'] });

      expect(res.status).toBe(201);
      const tokenId = res.body.data.id;

      const row = await pool.query('SELECT scopes FROM api_tokens WHERE id = $1', [tokenId]);
      expect(row.rows[0].scopes).toEqual(['documents:read']);
    });

    it('control: POST without a scopes param persists scopes IS NULL (legacy, unchanged)', async () => {
      const res = await request(app)
        .post('/api/api-tokens')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: `unscoped-token-${testRunId}` });

      expect(res.status).toBe(201);
      const tokenId = res.body.data.id;

      const row = await pool.query('SELECT scopes FROM api_tokens WHERE id = $1', [tokenId]);
      expect(row.rows[0].scopes).toBeNull();
    });

    it('rejects a scopes array containing a scope ScopeRegistry does not know about', async () => {
      const res = await request(app)
        .post('/api/api-tokens')
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ name: `bad-scope-token-${testRunId}`, scopes: ['not:a:real:scope'] });

      expect(res.status).toBe(400);
    });
  });
});
