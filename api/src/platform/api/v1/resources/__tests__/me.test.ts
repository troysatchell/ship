/**
 * PF-201 (Linear TRO-400) — `GET /api/v1/me`: `{ user, app, scopes }`,
 * proven against BOTH token classes `bearerAuth` accepts.
 *
 * - Personal-token principal (`api_tokens`): fixture pattern copied from
 *   `documents.test.ts`/`issues.test.ts` — direct SQL insert, `sha256`-hashed.
 * - Client-Credentials principal (PF-104/TRO-416, `oauth_tokens` with
 *   `user_id IS NULL`): minted via the REAL `issueClientCredentialsToken`
 *   (`../../../../oauth/token.js`) against a real confidential `oauth_apps`
 *   row created via `createOAuthApp` — the same fixture pattern
 *   `token.test.ts` uses, per this ticket's brief ("mint a client-credentials
 *   token via token.ts's issueClientCredentialsToken in your test setup").
 *   This exercises the real grant logic end-to-end (client auth, scope
 *   resolution, token insertion with `user_id: NULL`) rather than
 *   hand-constructing an `oauth_tokens` row that only resembles one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp, type OAuthAppSummary } from '../../../../oauth/appRegistration.js';
import { issueClientCredentialsToken } from '../../../../oauth/token.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface MeBody {
  user: { id: string; email: string; name: string } | null;
  app: { id: string; client_id: string; name: string; is_first_party: boolean } | null;
  scopes: string[];
}

describe('PF-201: GET /api/v1/me (Linear TRO-400)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let userId: string;
  let userEmail: string;

  let personalToken: string;
  let personalTokenScopes: string[];

  let oauthApp: OAuthAppSummary;
  let clientCredentialsToken: string;
  let clientCredentialsScopes: string[];

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-201 Me Test ${testRunId}`]
    );
    workspaceId = workspaceResult.rows[0]?.id ?? '';

    userEmail = `pf201-me-${testRunId}@ship.local`;
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-201 Me Test User', $2) RETURNING id`,
      [userEmail, workspaceId]
    );
    userId = userResult.rows[0]?.id ?? '';

    // ── Personal-token principal ──────────────────────────────────────
    personalTokenScopes = ['issues:read', 'sprints:read'];
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-201 me personal token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        personalTokenScopes,
      ]
    );
    personalToken = raw;

    // ── Client-Credentials principal ──────────────────────────────────
    const created = await createOAuthApp({
      workspaceId,
      ownerUserId: userId,
      name: `PF-201 Me Test App ${testRunId}`,
      clientType: 'confidential',
      redirectUris: [],
      requestedScopes: ['documents:read', 'issues:read'],
    });
    oauthApp = created.app;
    if (!created.clientSecret) {
      throw new Error('expected createOAuthApp to return a raw secret for a confidential client');
    }

    const grant = await issueClientCredentialsToken({
      clientId: oauthApp.client_id,
      clientSecret: created.clientSecret,
      scope: undefined, // requested scope omitted -> falls back to the app's full requested_scopes
    });
    if (!grant.ok) {
      throw new Error(`issueClientCredentialsToken did not succeed: ${grant.error} ${grant.errorDescription}`);
    }
    clientCredentialsToken = grant.accessToken;
    clientCredentialsScopes = grant.scopes;
  });

  afterAll(async () => {
    // oauth_apps -> oauth_tokens cascades ON DELETE CASCADE (app_id FK).
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  describe('personal-token principal', () => {
    it('user populated, app null, scopes = the token\'s scopes', async () => {
      const res = await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${personalToken}`);

      expect(res.status).toBe(200);
      const body = res.body as MeBody;
      expect(body.app).toBeNull();
      expect(body.user).toEqual({ id: userId, email: userEmail, name: 'PF-201 Me Test User' });
      expect(body.scopes).toEqual(personalTokenScopes);
    });
  });

  describe('client-credentials principal (real oauth_tokens row minted via issueClientCredentialsToken)', () => {
    it('user null, app populated, scopes = the token\'s actual granted scopes', async () => {
      const res = await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${clientCredentialsToken}`);

      expect(res.status).toBe(200);
      const body = res.body as MeBody;
      expect(body.user).toBeNull();
      expect(body.app).toEqual({
        id: oauthApp.id,
        client_id: oauthApp.client_id,
        name: oauthApp.name,
        is_first_party: false,
      });
      expect(body.scopes).toEqual(clientCredentialsScopes);
      expect(body.scopes).toEqual(['documents:read', 'issues:read']);
    });
  });

  describe('no scope required', () => {
    it('a personal token with an UNRELATED single scope (not issues:read/sprints:read/documents:read) still gets 200', async () => {
      const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
      await pool.query(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          workspaceId,
          `PF-201 me webhooks-only token ${crypto.randomBytes(4).toString('hex')}`,
          sha256Hex(raw),
          raw.slice(0, 12),
          ['webhooks:manage'],
        ]
      );

      const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${raw}`);

      expect(res.status).toBe(200);
      const body = res.body as MeBody;
      expect(body.scopes).toEqual(['webhooks:manage']);
    });
  });

  describe('unauthenticated', () => {
    it('no Authorization header -> 401 in ApiError shape', async () => {
      const res = await request(app).get('/api/v1/me');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(typeof res.body.request_id).toBe('string');
    });
  });
});
