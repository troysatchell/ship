import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import type { Express, Request, Response } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import { bearerAuth } from '../bearerAuth.js';
import { requireScope } from '../../scopes/requireScope.js';

/**
 * PF-107 (Linear TRO-430) — v1 bearer middleware + `require(scope)` factory.
 * Test design (ship-test-designer, TRO-430 comment, 2026-08-10) maps one
 * test per AC clause below. Uses a scratch Express app, not `createApp()` —
 * `bearerAuth`/`requireScope` are plain middleware with no dependency on the
 * session/CSRF stack `createApp()` wires up, and no protected `/api/v1`
 * route exists yet for them to sit in front of (PF-200 onward adds those).
 */

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Typed as a named function first, then wrapped with `vi.fn(...)` — typing
// the mock variable as bare `ReturnType<typeof vi.fn>` (no type argument)
// resolves to `vi.fn`'s LAST overload with no argument context, which is
// too generic (`Mock<Procedure | Constructable>`) for Express's
// `RequestHandler` overloads to accept. Inferring from a concrete
// `(req: Request, res: Response) => void` avoids that.
function makeSpyHandler(impl: (req: Request, res: Response) => void) {
  return vi.fn(impl);
}

describe('PF-107: bearerAuth + requireScope', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `pf107-${testRunId}@ship.local`;

  let app: Express;
  let principalHandler: ReturnType<typeof makeSpyHandler>;
  let scopedHandler: ReturnType<typeof makeSpyHandler>;

  let testUserId: string;
  let testAppId: string;
  let testAppClientId: string;

  // Class 1 — OAuth access token, scopes=['documents:read'], unrevoked/unexpired.
  let oauthTokenDocsRead: string;
  // Class 2 — scoped personal token, scopes=['documents:read'], unrevoked/unexpired.
  let personalTokenDocsRead: string;
  // Class 2 — legacy unscoped personal token, scopes IS NULL (the landmine CLAUDE.md flags).
  let personalTokenLegacyNullScopes: string;
  // Class 2 — scopes=['issues:read'] only, used for AC-3's missing-scope case.
  let personalTokenIssuesReadOnly: string;
  // Class 2 — scopes=['documents:read'], expires_at in the past.
  let personalTokenExpired: string;
  // Class 1 — scopes=['documents:read'], revoked_at set.
  let oauthTokenRevoked: string;
  // Class 2 — scopes=['documents:read'], revoked_at set.
  let personalTokenRevoked: string;
  // Never inserted anywhere — no hash in either table matches this.
  const garbageToken = 'ship_this_token_was_never_issued_by_anything';

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-107 Test ${testRunId}`]
    );
    const testWorkspaceId = workspaceResult.rows[0].id;

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'PF-107 Test User')
       RETURNING id`,
      [testEmail]
    );
    testUserId = userResult.rows[0].id;

    testAppClientId = `ship_app_pf107_${testRunId}`;
    const appResult = await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, client_secret_hash, is_first_party)
       VALUES ($1, 'PF-107 Test App', $2, 'confidential', $3, false)
       RETURNING id`,
      [testWorkspaceId, testAppClientId, sha256Hex('unused-secret')]
    );
    testAppId = appResult.rows[0].id;

    async function insertOauthToken(opts: {
      scopes: string[];
      userId: string | null;
      expiresAt: Date;
      revokedAt: Date | null;
    }): Promise<string> {
      const raw = `oauth_at_${crypto.randomBytes(24).toString('hex')}`;
      await pool.query(
        `INSERT INTO oauth_tokens (app_id, user_id, scopes, access_token_hash, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testAppId, opts.userId, opts.scopes, sha256Hex(raw), opts.expiresAt, opts.revokedAt]
      );
      return raw;
    }

    async function insertPersonalToken(opts: {
      scopes: string[] | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }): Promise<string> {
      const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
      await pool.query(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, expires_at, revoked_at, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          testUserId,
          testWorkspaceId,
          `PF-107 personal token ${crypto.randomBytes(4).toString('hex')}`,
          sha256Hex(raw),
          raw.slice(0, 12),
          opts.expiresAt,
          opts.revokedAt,
          opts.scopes,
        ]
      );
      return raw;
    }

    const farFuture = new Date(Date.now() + 60 * 60 * 1000);
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000);

    oauthTokenDocsRead = await insertOauthToken({
      scopes: ['documents:read'],
      userId: testUserId,
      expiresAt: farFuture,
      revokedAt: null,
    });
    oauthTokenRevoked = await insertOauthToken({
      scopes: ['documents:read'],
      userId: testUserId,
      expiresAt: farFuture,
      revokedAt: new Date(),
    });
    personalTokenDocsRead = await insertPersonalToken({
      scopes: ['documents:read'],
      expiresAt: null,
      revokedAt: null,
    });
    personalTokenLegacyNullScopes = await insertPersonalToken({
      scopes: null,
      expiresAt: null,
      revokedAt: null,
    });
    personalTokenIssuesReadOnly = await insertPersonalToken({
      scopes: ['issues:read'],
      expiresAt: null,
      revokedAt: null,
    });
    personalTokenExpired = await insertPersonalToken({
      scopes: ['documents:read'],
      expiresAt: pastExpiry,
      revokedAt: null,
    });
    personalTokenRevoked = await insertPersonalToken({
      scopes: ['documents:read'],
      expiresAt: null,
      revokedAt: new Date(),
    });

    principalHandler = makeSpyHandler((req, res) => {
      res.status(200).json({ principal: req.principal ?? null });
    });
    scopedHandler = makeSpyHandler((_req, res) => {
      res.status(200).json({ ok: true });
    });

    app = express();
    app.get('/scratch/principal', bearerAuth, principalHandler);
    app.get('/scratch/documents-read', bearerAuth, requireScope('documents:read'), scopedHandler);
  });

  describe('AC-1: middleware unit tests covering both token classes', () => {
    it('class 1 (OAuth access token): req.principal = { app, user, scopes }', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${oauthTokenDocsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.principal).toEqual({
        app: { id: testAppId, clientId: testAppClientId, name: 'PF-107 Test App', isFirstParty: false },
        user: { id: testUserId, email: testEmail, name: 'PF-107 Test User' },
        scopes: ['documents:read'],
      });
    });

    it('class 2 (scoped personal token): req.principal = { app: null, user, scopes }', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${personalTokenDocsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.principal).toEqual({
        app: null,
        user: { id: testUserId, email: testEmail, name: 'PF-107 Test User' },
        scopes: ['documents:read'],
      });
    });
  });

  describe("AC-2: legacy api_tokens rows with scopes IS NULL are never valid at /api/v1", () => {
    it('rejects with 401 invalid_token; downstream handler is never called', async () => {
      principalHandler.mockClear();

      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${personalTokenLegacyNullScopes}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.details).toEqual({ reason: 'invalid_token' });
      expect(principalHandler).not.toHaveBeenCalled();
    });
  });

  describe("AC-3: require('documents:read') rejects a token lacking it, names it in details.missing_scope", () => {
    it('a token with only issues:read gets 403, code forbidden, details.missing_scope=documents:read', async () => {
      scopedHandler.mockClear();

      const res = await request(app)
        .get('/scratch/documents-read')
        .set('Authorization', `Bearer ${personalTokenIssuesReadOnly}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
      expect(scopedHandler).not.toHaveBeenCalled();
    });

    it('control: a token that DOES have documents:read reaches the handler with 200', async () => {
      scopedHandler.mockClear();

      const res = await request(app)
        .get('/scratch/documents-read')
        .set('Authorization', `Bearer ${personalTokenDocsRead}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(scopedHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-4: 401 variants — missing / invalid / expired', () => {
    it('case a: no Authorization header -> 401, details.reason=missing_token', async () => {
      const res = await request(app).get('/scratch/principal');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.details).toEqual({ reason: 'missing_token' });
    });

    it('case b: Authorization: Bearer garbage (no matching hash) -> 401, details.reason=invalid_token', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${garbageToken}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.details).toEqual({ reason: 'invalid_token' });
    });

    it('case c: a hash-matching row with expires_at in the past -> 401, details.reason=expired_token', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${personalTokenExpired}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.details).toEqual({ reason: 'expired_token' });
    });
  });

  describe('PM triage (TRO-430, 2026-08-10): revoked tokens map to details.reason=invalid_token, not a distinct reason', () => {
    it('a revoked OAuth access token is rejected as invalid_token (same shape as an unknown token)', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${oauthTokenRevoked}`);

      expect(res.status).toBe(401);
      expect(res.body.details).toEqual({ reason: 'invalid_token' });
    });

    it('a revoked scoped personal token is rejected as invalid_token (same shape as an unknown token)', async () => {
      const res = await request(app)
        .get('/scratch/principal')
        .set('Authorization', `Bearer ${personalTokenRevoked}`);

      expect(res.status).toBe(401);
      expect(res.body.details).toEqual({ reason: 'invalid_token' });
    });
  });

  it('every §2.5 ApiError response from this middleware carries a request_id key', async () => {
    const res = await request(app).get('/scratch/principal');
    expect(res.body).toHaveProperty('request_id');
  });
});
