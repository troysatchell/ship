/**
 * Regression tests for PF-104 / TRO-416 — `POST /oauth/token`
 * (authorization_code + PKCE, client_credentials) — AND PF-105 / TRO-421
 * (refresh rotation + family invalidation), added in the same file rather
 * than a new one: both tickets exercise the identical route and share the
 * exact same workspace/user/apps fixtures and `postToken`/`introspect`
 * helpers below, and PF-105's own tests build directly on a real
 * `authorization_code` redemption (below) to obtain the refresh token they
 * rotate. Per `ship-qa`/lessons.md §13, this file
 * (`api/src/platform/oauth/__tests__/`) is what `gate.sh` actually executes;
 * there is no additive Playwright e2e spec for either ticket (see
 * CHANGES.md for why — PF-201's `/api/v1/me` does not exist yet, so the
 * graded scenario's last hop cannot run against a real route; PF-105's own
 * "stolen-token story" e2e drill is PF-800's job, not this ticket's).
 *
 * "Token works" is proven here by running the request through the REAL
 * production `bearerAuth` middleware (`../bearerAuth.js`) mounted on a tiny
 * scratch Express app — the strongest form of "introspectable server-side"
 * available without PF-201, and a stronger proof than a raw DB row check
 * (it exercises the exact code path `/api/v1/*` will use once PF-201 lands).
 *
 * Fixture pattern (workspace/user via direct SQL, apps via the real
 * `createOAuthApp`) follows `authorize.test.ts`. Runs against this
 * worktree's real `DATABASE_URL` (`source .factory-env` first) — same
 * hazard as every other api test file (`api/src/test/setup.ts` truncates 16
 * tables in `beforeAll`; `oauth_apps`/`oauth_authorization_codes`/
 * `oauth_tokens` are NOT in that list, so this file cleans up its own rows).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { issueAuthorizationCode, hashAuthorizationCode } from '../authorize.js';
import { createOAuthApp, type OAuthAppSummary } from '../appRegistration.js';
import { bearerAuth } from '../bearerAuth.js';
import { redeemAuthorizationCode, rotateRefreshToken } from '../token.js';

describe('/oauth/token (PF-104)', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `oauth-token-${testRunId}@ship.local`;
  const testWorkspaceName = `OAuth Token Test ${testRunId}`;

  const PUBLIC_REDIRECT_URI = `https://public-client.example.com/callback-${testRunId}`;
  const CONFIDENTIAL_REDIRECT_URI = `https://confidential-client.example.com/callback-${testRunId}`;
  const OTHER_REDIRECT_URI = `https://other-client.example.com/callback-${testRunId}`;

  let testWorkspaceId: string;
  let testUserId: string;

  let publicApp: OAuthAppSummary;
  let confidentialApp: OAuthAppSummary;
  let confidentialAppSecret: string;
  let otherPublicApp: OAuthAppSummary;

  // A tiny scratch app mounting the REAL bearerAuth middleware — see file
  // header for why this is the "token works" proof for this ticket.
  const introspectionApp = express();
  introspectionApp.get('/scratch-protected', bearerAuth, (req, res) => {
    res.json({ principal: req.principal ?? null });
  });

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = requireRow(workspaceResult.rows[0], 'workspace insert').id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'OAuth Token Test User') RETURNING id`,
      [testEmail]
    );
    testUserId = requireRow(userResult.rows[0], 'user insert').id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    );

    const publicResult = await createOAuthApp({
      workspaceId: testWorkspaceId,
      ownerUserId: testUserId,
      name: `PF-104 Public Test Client ${testRunId}`,
      clientType: 'public',
      redirectUris: [PUBLIC_REDIRECT_URI],
      requestedScopes: ['documents:read', 'issues:read'],
    });
    publicApp = publicResult.app;

    const confidentialResult = await createOAuthApp({
      workspaceId: testWorkspaceId,
      ownerUserId: testUserId,
      name: `PF-104 Confidential Test Client ${testRunId}`,
      clientType: 'confidential',
      redirectUris: [CONFIDENTIAL_REDIRECT_URI],
      requestedScopes: ['documents:read', 'issues:write'],
    });
    confidentialApp = confidentialResult.app;
    if (!confidentialResult.clientSecret) {
      throw new Error('expected createOAuthApp to return a raw secret for a confidential client');
    }
    confidentialAppSecret = confidentialResult.clientSecret;

    // A second, unrelated public app — exclusively for the "client_id
    // mismatch between authorize and token requests" case below. Never
    // used to mint a code of its own.
    const otherResult = await createOAuthApp({
      workspaceId: testWorkspaceId,
      ownerUserId: testUserId,
      name: `PF-104 Other Test Client ${testRunId}`,
      clientType: 'public',
      redirectUris: [OTHER_REDIRECT_URI],
      requestedScopes: ['documents:read'],
    });
    otherPublicApp = otherResult.app;
  });

  afterAll(async () => {
    // Cascades to oauth_authorization_codes and oauth_tokens for these apps
    // (both FKs are ON DELETE CASCADE on app_id).
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [testWorkspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
  });

  // ── Narrowing helpers (lessons.md RULE-16/RULE-21: no `!`/`as any`, and
  //    response bodies must be explicitly checked, not cast). ──────────────

  function requireRow<T>(row: T | undefined, label: string): T {
    if (row === undefined) {
      throw new Error(`expected a row from ${label}`);
    }
    return row;
  }

  function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
      throw new Error(`expected ${label} to be a string, got ${typeof value}`);
    }
    return value;
  }

  function requireNumber(value: unknown, label: string): number {
    if (typeof value !== 'number') {
      throw new Error(`expected ${label} to be a number, got ${typeof value}`);
    }
    return value;
  }

  interface TokenSuccessBody {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token: string | undefined;
  }

  function requireTokenSuccessBody(body: unknown): TokenSuccessBody {
    const b = body as Record<string, unknown>;
    return {
      access_token: requireString(b.access_token, 'access_token'),
      token_type: requireString(b.token_type, 'token_type'),
      expires_in: requireNumber(b.expires_in, 'expires_in'),
      scope: requireString(b.scope, 'scope'),
      refresh_token: b.refresh_token === undefined ? undefined : requireString(b.refresh_token, 'refresh_token'),
    };
  }

  interface TokenErrorBody {
    error: string;
    error_description: string;
  }

  function requireTokenErrorBody(body: unknown): TokenErrorBody {
    const b = body as Record<string, unknown>;
    return {
      error: requireString(b.error, 'error'),
      error_description: requireString(b.error_description, 'error_description'),
    };
  }

  // ── PKCE + fixture helpers ────────────────────────────────────────────

  function makePkcePair(): { codeVerifier: string; codeChallenge: string } {
    // RFC 7636 §4.1: 43-128 chars from the unreserved set. base64url of 32
    // random bytes is a 43-char string entirely within that set.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  async function issueCodeFor(
    forApp: OAuthAppSummary,
    redirectUri: string,
    scopes: string[]
  ): Promise<{ code: string; codeVerifier: string }> {
    const { codeVerifier, codeChallenge } = makePkcePair();
    const code = await issueAuthorizationCode({
      appId: forApp.id,
      userId: testUserId,
      scopes,
      codeChallenge,
      redirectUri,
    });
    return { code, codeVerifier };
  }

  function postToken(fields: Record<string, string | undefined>): request.Test {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) cleaned[key] = value;
    }
    return request(app).post('/oauth/token').type('form').send(cleaned);
  }

  function authCodeBody(params: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
  }): Record<string, string | undefined> {
    return {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code_verifier: params.codeVerifier,
    };
  }

  async function introspect(accessToken: string): Promise<request.Response> {
    return request(introspectionApp).get('/scratch-protected').set('Authorization', `Bearer ${accessToken}`);
  }

  async function tokenRowForCode(authorizationCodeId: string): Promise<{
    id: string;
    revoked_at: Date | null;
    access_token_hash: string;
  } | null> {
    const result = await pool.query<{ id: string; revoked_at: Date | null; access_token_hash: string }>(
      `SELECT id, revoked_at, access_token_hash FROM oauth_tokens WHERE authorization_code_id = $1`,
      [authorizationCodeId]
    );
    return result.rows[0] ?? null;
  }

  async function codeIdAndConsumedAt(rawCode: string): Promise<{ id: string; consumed_at: Date | null }> {
    const result = await pool.query<{ id: string; consumed_at: Date | null }>(
      `SELECT id, consumed_at FROM oauth_authorization_codes WHERE code_hash = $1`,
      [hashAuthorizationCode(rawCode)]
    );
    return requireRow(result.rows[0], 'oauth_authorization_codes lookup');
  }

  // ── PF-105 refresh-rotation helpers ──────────────────────────────────

  interface OauthTokenRow {
    id: string;
    family_id: string;
    parent_id: string | null;
    revoked_at: Date | null;
  }

  async function tokenRowByAccessToken(accessToken: string): Promise<OauthTokenRow | null> {
    const result = await pool.query<OauthTokenRow>(
      `SELECT id, family_id, parent_id, revoked_at FROM oauth_tokens WHERE access_token_hash = $1`,
      [crypto.createHash('sha256').update(accessToken).digest('hex')]
    );
    return result.rows[0] ?? null;
  }

  async function familyRevocationStates(familyId: string): Promise<OauthTokenRow[]> {
    const result = await pool.query<OauthTokenRow>(
      `SELECT id, family_id, parent_id, revoked_at FROM oauth_tokens WHERE family_id = $1 ORDER BY created_at`,
      [familyId]
    );
    return result.rows;
  }

  function refreshTokenBody(params: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
    scope?: string;
  }): Record<string, string | undefined> {
    return {
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      scope: params.scope,
    };
  }

  /** Same shape as `TokenSuccessBody`, but with `refresh_token` narrowed to
   * a definite `string` — every PF-105 test below needs one to rotate, and
   * this avoids repeating the same null-check in each test body. */
  interface MintedTokenPair extends Omit<TokenSuccessBody, 'refresh_token'> {
    refresh_token: string;
  }

  /** Runs a real `authorization_code` redemption end-to-end and hands back
   * the resulting access+refresh pair — the starting fixture every PF-105
   * test below needs, since a refresh token can only be minted by first
   * running the grant PF-104 already covers. */
  async function mintInitialTokenPair(
    forApp: OAuthAppSummary,
    redirectUri: string,
    scopes: string[],
    clientSecret?: string
  ): Promise<MintedTokenPair> {
    const { code, codeVerifier } = await issueCodeFor(forApp, redirectUri, scopes);
    const res = await postToken(
      authCodeBody({ code, redirectUri, clientId: forApp.client_id, clientSecret, codeVerifier })
    );
    expect(res.status).toBe(200);
    const body = requireTokenSuccessBody(res.body);
    if (!body.refresh_token) {
      throw new Error('expected authorization_code grant to return a refresh_token');
    }
    return { ...body, refresh_token: body.refresh_token };
  }

  // ── authorization_code grant ─────────────────────────────────────────

  describe('authorization_code grant — happy path', () => {
    it('public client: exchanges a valid code + verifier for a working access token', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        authCodeBody({ code, redirectUri: PUBLIC_REDIRECT_URI, clientId: publicApp.client_id, codeVerifier })
      );

      expect(res.status).toBe(200);
      const body = requireTokenSuccessBody(res.body);
      expect(body.token_type).toBe('Bearer');
      expect(body.scope).toBe('documents:read');
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.expires_in).toBeLessThanOrEqual(3600);
      expect(body.refresh_token).toBeTruthy();

      // The code is now consumed.
      const { id: codeId, consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).not.toBeNull();

      // Exactly one token row, linked back to the code, not revoked.
      const tokenRow = await tokenRowForCode(codeId);
      expect(tokenRow).not.toBeNull();
      expect(tokenRow?.revoked_at ?? null).toBeNull();
      expect(tokenRow?.access_token_hash).toBe(
        crypto.createHash('sha256').update(body.access_token).digest('hex')
      );

      // The token actually authenticates a real request through the
      // production bearerAuth middleware.
      const introspectRes = await introspect(body.access_token);
      expect(introspectRes.status).toBe(200);
      const principal = introspectRes.body.principal as {
        app: { clientId: string; isFirstParty: boolean } | null;
        user: { id: string } | null;
        scopes: string[];
      };
      expect(principal.app?.clientId).toBe(publicApp.client_id);
      expect(principal.user?.id).toBe(testUserId);
      expect(principal.scopes).toEqual(['documents:read']);
    });

    it('confidential client: exchanges a valid code + verifier + correct client_secret', async () => {
      const { code, codeVerifier } = await issueCodeFor(confidentialApp, CONFIDENTIAL_REDIRECT_URI, [
        'issues:write',
      ]);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: CONFIDENTIAL_REDIRECT_URI,
          clientId: confidentialApp.client_id,
          clientSecret: confidentialAppSecret,
          codeVerifier,
        })
      );

      expect(res.status).toBe(200);
      const body = requireTokenSuccessBody(res.body);
      expect(body.scope).toBe('issues:write');

      const introspectRes = await introspect(body.access_token);
      expect(introspectRes.status).toBe(200);
      const principal = introspectRes.body.principal as { app: { clientId: string } | null };
      expect(principal.app?.clientId).toBe(confidentialApp.client_id);
    });
  });

  describe('negative: wrong code_verifier -> 400 invalid_grant', () => {
    it('rejects a mismatched verifier without consuming the code', async () => {
      const { code } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const wrongVerifier = crypto.randomBytes(32).toString('base64url');

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: PUBLIC_REDIRECT_URI,
          clientId: publicApp.client_id,
          codeVerifier: wrongVerifier,
        })
      );

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');

      // Not burned: the code is still unconsumed and could still be
      // redeemed with the CORRECT verifier (this is not "reuse").
      const { consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).toBeNull();
    });
  });

  describe('negative: reused code -> invalid_grant + revokes tokens issued from it', () => {
    it('a second redemption of an already-consumed code fails and revokes the first token', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const body = authCodeBody({
        code,
        redirectUri: PUBLIC_REDIRECT_URI,
        clientId: publicApp.client_id,
        codeVerifier,
      });

      const firstRes = await postToken(body);
      expect(firstRes.status).toBe(200);
      const firstToken = requireTokenSuccessBody(firstRes.body);

      // Sanity: the first token works before the reuse attempt.
      expect((await introspect(firstToken.access_token)).status).toBe(200);

      const secondRes = await postToken(body);
      expect(secondRes.status).toBe(400);
      expect(requireTokenErrorBody(secondRes.body).error).toBe('invalid_grant');

      const { id: codeId } = await codeIdAndConsumedAt(code);
      const tokenRow = await tokenRowForCode(codeId);
      expect(tokenRow).not.toBeNull();
      expect(tokenRow?.revoked_at ?? null).not.toBeNull();

      // The revocation has a real, observable effect: the original token no
      // longer authenticates anything.
      const introspectAfter = await introspect(firstToken.access_token);
      expect(introspectAfter.status).toBe(401);
    });
  });

  describe('negative: wrong redirect_uri -> 400 invalid_grant', () => {
    it('rejects a redirect_uri that does not match the one on the code', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: `${PUBLIC_REDIRECT_URI}/wrong`,
          clientId: publicApp.client_id,
          codeVerifier,
        })
      );

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');

      const { consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).toBeNull();
    });
  });

  describe('negative: expired code -> invalid_grant', () => {
    it('rejects a code past its expiry, even with a correct verifier', async () => {
      const { codeVerifier, codeChallenge } = makePkcePair();
      const rawCode = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO oauth_authorization_codes
           (code_hash, app_id, user_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'S256', $6, now() - interval '1 minute')`,
        [
          hashAuthorizationCode(rawCode),
          publicApp.id,
          testUserId,
          ['documents:read'],
          codeChallenge,
          PUBLIC_REDIRECT_URI,
        ]
      );

      const res = await postToken(
        authCodeBody({
          code: rawCode,
          redirectUri: PUBLIC_REDIRECT_URI,
          clientId: publicApp.client_id,
          codeVerifier,
        })
      );

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');
    });
  });

  describe('negative: unknown / malformed client', () => {
    it('unknown client_id -> 401 invalid_client', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: PUBLIC_REDIRECT_URI,
          clientId: 'ship_app_does_not_exist',
          codeVerifier,
        })
      );

      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });

    it('missing client_id entirely -> 400 invalid_request', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: PUBLIC_REDIRECT_URI,
        code_verifier: codeVerifier,
        // client_id omitted
      });

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_request');
    });

    it('confidential client with no client_secret -> 401 invalid_client', async () => {
      const { code, codeVerifier } = await issueCodeFor(confidentialApp, CONFIDENTIAL_REDIRECT_URI, [
        'issues:write',
      ]);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: CONFIDENTIAL_REDIRECT_URI,
          clientId: confidentialApp.client_id,
          codeVerifier,
          // client_secret omitted
        })
      );

      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });

    it('confidential client with the WRONG client_secret -> 401 invalid_client', async () => {
      const { code, codeVerifier } = await issueCodeFor(confidentialApp, CONFIDENTIAL_REDIRECT_URI, [
        'issues:write',
      ]);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: CONFIDENTIAL_REDIRECT_URI,
          clientId: confidentialApp.client_id,
          clientSecret: 'ship_appsec_totally-wrong-secret',
          codeVerifier,
        })
      );

      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });
  });

  describe('negative: client_id mismatch between authorize and token requests -> invalid_grant', () => {
    it('rejects a code redeemed under a different (but valid) client_id', async () => {
      // Code issued to publicApp; redeemed presenting otherPublicApp's own
      // (real, registered) client_id instead.
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        authCodeBody({
          code,
          redirectUri: PUBLIC_REDIRECT_URI,
          clientId: otherPublicApp.client_id,
          codeVerifier,
        })
      );

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');

      const { consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).toBeNull();
    });
  });

  describe('genuine concurrent redemption of the same code', () => {
    it('exactly one token is ever minted (no double-issue), and the detected race revokes it', async () => {
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const body = authCodeBody({
        code,
        redirectUri: PUBLIC_REDIRECT_URI,
        clientId: publicApp.client_id,
        codeVerifier,
      });

      // Fired via Promise.all (not awaited sequentially). Observed empirically
      // (debug-traced while writing this test): at this timing scale, one
      // full HTTP request/DB-transaction round trip routinely finishes before
      // the other's very first read even runs — dispatching two requests
      // together is not the same guarantee as forcing them to interleave
      // inside the critical section (lessons.md's "a barrier that gates
      // DISPATCH is not the same guarantee as one that gates EXECUTION").
      // This test is therefore an end-to-end smoke test of the OBSERVABLE
      // outcome across the full route, whichever internal branch actually
      // fires; the "genuine concurrent redemption of the same code (DB-level
      // race)" test below is what actually forces and proves the atomic-
      // UPDATE race the module header's argument depends on.
      const [resA, resB] = await Promise.all([postToken(body), postToken(body)]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const [winner, loser] = resA.status === 200 ? [resA, resB] : [resB, resA];
      const winnerBody = requireTokenSuccessBody(winner.body);
      expect(requireTokenErrorBody(loser.body).error).toBe('invalid_grant');

      const { id: codeId, consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).not.toBeNull();

      // No double-issue: exactly one oauth_tokens row was ever created for
      // this code, regardless of which request "won".
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oauth_tokens WHERE authorization_code_id = $1`,
        [codeId]
      );
      expect(Number(requireRow(countResult.rows[0], 'token count').count)).toBe(1);

      // The winner's HTTP response carries a real, well-formed token — its
      // transaction genuinely committed. But per token.ts's module header,
      // this module cannot reliably tell "a live race against the
      // legitimate client's own retry" apart from "a race against someone
      // who also had the correct code_verifier" (an attacker with full
      // access to the client's PKCE material), so ANY detected reuse —
      // including one arising from this exact race — revokes the code's
      // whole token family. The winner's token is therefore already dead by
      // the time this assertion runs: fail-safe under ambiguity, not a bug.
      expect((await introspect(winnerBody.access_token)).status).toBe(401);
    });
  });

  describe('genuine concurrent redemption of the same code (forced, deterministic race)', () => {
    /**
     * Polls a real, observable database fact (how many backends are
     * currently blocked trying to update this exact table/column) with a
     * bounded deadline — not a fixed sleep (lessons.md rule 17). `ship` is a
     * superuser in this local dev container (confirmed:
     * `SELECT rolsuper FROM pg_roles WHERE rolname = 'ship'`), so
     * `pg_stat_activity.query` shows other backends' real query text, not
     * just its own.
     */
    async function waitForBlockedRedemptions(target: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await pool.query<{ blocked: string }>(
          `SELECT count(*)::text AS blocked FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%oauth_authorization_codes%consumed_at%'`
        );
        const blocked = Number(requireRow(result.rows[0], 'pg_stat_activity poll').blocked);
        if (blocked >= target) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting for ${target} blocked redemption(s) on pg_stat_activity; last saw ${blocked}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it('calls the REAL redeemAuthorizationCode twice, forced to genuinely race: exactly one wins, no double-issue', async () => {
      // The test above dispatches two HTTP requests together and hopes they
      // interleave — empirically (debug-traced while writing this suite)
      // they usually do NOT: one request's entire DB round trip (SELECT
      // through COMMIT) routinely finishes before the other's first SELECT
      // even resolves, even when both are fired via `Promise.all` with zero
      // HTTP involved. That is a real, useful test (it proves the
      // end-to-end route is safe under whatever interleaving actually
      // happens), but it does NOT prove the atomic-UPDATE race in
      // token.ts's module header actually gets exercised — a version of
      // `redeemAuthorizationCode` with the `AND consumed_at IS NULL` guard
      // silently dropped from its UPDATE would still pass that test (and
      // was confirmed, manually, to do so while writing this suite).
      //
      // This test forces the race instead of hoping for it, WITHOUT adding
      // any test-only hook to production code: a third connection takes an
      // exclusive row lock on the code before either real redemption call
      // starts. A plain SELECT never blocks on a row lock (so both calls'
      // validation reads succeed immediately, both observing
      // `consumed_at: null`), but each call's own atomic UPDATE — the
      // actual single-use gate — blocks on this lock. Once BOTH are
      // observed genuinely queued for it (`waitForBlockedRedemptions`
      // above), the lock is released and the two blocked UPDATEs contend
      // for the row for real, exactly the scenario the module header
      // describes.
      const { code, codeVerifier } = await issueCodeFor(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const { id: codeId } = await codeIdAndConsumedAt(code);

      const params = {
        code,
        redirectUri: PUBLIC_REDIRECT_URI,
        clientId: publicApp.client_id,
        clientSecret: undefined,
        codeVerifier,
      };

      const lockClient = await pool.connect();
      try {
        await lockClient.query('BEGIN');
        await lockClient.query('SELECT id FROM oauth_authorization_codes WHERE id = $1 FOR UPDATE', [codeId]);

        const racePromise = Promise.all([redeemAuthorizationCode(params), redeemAuthorizationCode(params)]);

        await waitForBlockedRedemptions(2);

        // Releasing here is what lets the race actually happen — both
        // blocked UPDATEs are now free to contend for the row lock.
        await lockClient.query('COMMIT');

        const [resultA, resultB] = await racePromise;
        expect([resultA.ok, resultB.ok].sort()).toEqual([false, true]);
      } finally {
        lockClient.release();
      }

      const { consumed_at } = await codeIdAndConsumedAt(code);
      expect(consumed_at).not.toBeNull();

      // No double-issue: exactly one oauth_tokens row was ever created for
      // this code, no matter which call actually won the forced race.
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oauth_tokens WHERE authorization_code_id = $1`,
        [codeId]
      );
      expect(Number(requireRow(countResult.rows[0], 'token count').count)).toBe(1);
    });
  });

  // ── client_credentials grant ─────────────────────────────────────────

  describe('client_credentials grant', () => {
    it('confidential client: issues a token with user_id null, no refresh_token, scopes subset', async () => {
      const res = await postToken({
        grant_type: 'client_credentials',
        client_id: confidentialApp.client_id,
        client_secret: confidentialAppSecret,
        scope: 'documents:read',
      });

      expect(res.status).toBe(200);
      const body = requireTokenSuccessBody(res.body);
      expect(body.scope).toBe('documents:read');
      expect(body.refresh_token).toBeUndefined();
      expect('refresh_token' in (res.body as Record<string, unknown>)).toBe(false);

      const rowResult = await pool.query<{ user_id: string | null; access_token_hash: string }>(
        `SELECT user_id, access_token_hash FROM oauth_tokens WHERE access_token_hash = $1`,
        [crypto.createHash('sha256').update(body.access_token).digest('hex')]
      );
      const row = requireRow(rowResult.rows[0], 'client_credentials token row');
      expect(row.user_id).toBeNull();

      const introspectRes = await introspect(body.access_token);
      expect(introspectRes.status).toBe(200);
      const principal = introspectRes.body.principal as {
        app: { clientId: string } | null;
        user: unknown;
        scopes: string[];
      };
      expect(principal.app?.clientId).toBe(confidentialApp.client_id);
      expect(principal.user).toBeNull();
      expect(principal.scopes).toEqual(['documents:read']);
    });

    it('scope exceeding the app\'s registered scopes -> 400 invalid_scope', async () => {
      const res = await postToken({
        grant_type: 'client_credentials',
        client_id: confidentialApp.client_id,
        client_secret: confidentialAppSecret,
        scope: 'admin:write',
      });

      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_scope');
    });

    it('a public client (no secret) -> 401 invalid_client', async () => {
      const res = await postToken({
        grant_type: 'client_credentials',
        client_id: publicApp.client_id,
        scope: 'documents:read',
      });

      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });
  });

  // ── refresh_token grant (PF-105 / TRO-421) ───────────────────────────

  describe('refresh_token grant — happy path', () => {
    it('rotation issues a new access+refresh pair in the same family, and invalidates the parent', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const parentRow = await tokenRowByAccessToken(initial.access_token);
      if (parentRow === null) throw new Error('expected a token row for the initial access token');
      expect(parentRow.revoked_at).toBeNull();

      const rotateRes = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id })
      );
      expect(rotateRes.status).toBe(200);
      const rotated = requireTokenSuccessBody(rotateRes.body);
      expect(rotated.scope).toBe('documents:read');
      expect(rotated.access_token).not.toBe(initial.access_token);
      expect(rotated.refresh_token).toBeTruthy();
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      // The parent row is invalidated (single-use gate tripped).
      const parentAfter = await tokenRowByAccessToken(initial.access_token);
      expect(parentAfter?.revoked_at ?? null).not.toBeNull();

      // The child exists, in the same family, pointing back at the parent,
      // and is itself NOT revoked.
      const childRow = await tokenRowByAccessToken(rotated.access_token);
      expect(childRow).not.toBeNull();
      expect(childRow?.family_id).toBe(parentRow.family_id);
      expect(childRow?.parent_id).toBe(parentRow.id);
      expect(childRow?.revoked_at ?? null).toBeNull();

      // The new access token is real and works.
      expect((await introspect(rotated.access_token)).status).toBe(200);
    });

    it('confidential client: rotates with the correct client_secret', async () => {
      const initial = await mintInitialTokenPair(
        confidentialApp,
        CONFIDENTIAL_REDIRECT_URI,
        ['issues:write'],
        confidentialAppSecret
      );

      const res = await postToken(
        refreshTokenBody({
          refreshToken: initial.refresh_token,
          clientId: confidentialApp.client_id,
          clientSecret: confidentialAppSecret,
        })
      );

      expect(res.status).toBe(200);
      const rotated = requireTokenSuccessBody(res.body);
      expect(rotated.scope).toBe('issues:write');
      expect((await introspect(rotated.access_token)).status).toBe(200);
    });

    it('requesting a narrower scope than originally granted is honored', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, [
        'documents:read',
        'issues:read',
      ]);

      const res = await postToken(
        refreshTokenBody({
          refreshToken: initial.refresh_token,
          clientId: publicApp.client_id,
          scope: 'documents:read',
        })
      );

      expect(res.status).toBe(200);
      expect(requireTokenSuccessBody(res.body).scope).toBe('documents:read');
    });
  });

  describe('negative: reuse of a rotated refresh token -> revokes the whole family', () => {
    it('presenting an already-rotated refresh token again fails and kills the active child access token', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const parentRow = await tokenRowByAccessToken(initial.access_token);
      if (parentRow === null) throw new Error('expected a token row for the initial access token');

      const rotateRes = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id })
      );
      expect(rotateRes.status).toBe(200);
      const rotated = requireTokenSuccessBody(rotateRes.body);

      // Sanity: the child access token works before the reuse attempt.
      expect((await introspect(rotated.access_token)).status).toBe(200);

      // Reuse: present the OLD (already-rotated) refresh token again.
      const reuseRes = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id })
      );
      expect(reuseRes.status).toBe(400);
      expect(requireTokenErrorBody(reuseRes.body).error).toBe('invalid_grant');

      // Family revocation has a real, observable effect: the active child's
      // access token no longer authenticates anything (the specific AC this
      // test is named for: "family revocation kills active access tokens").
      expect((await introspect(rotated.access_token)).status).toBe(401);

      // Every row sharing this family_id is now revoked — not just the one
      // that was directly reused.
      const familyRows = await familyRevocationStates(parentRow.family_id);
      expect(familyRows.length).toBeGreaterThanOrEqual(2);
      for (const row of familyRows) {
        expect(row.revoked_at, `row ${row.id} in family ${parentRow.family_id} should be revoked`).not.toBeNull();
      }
    });

    it('a third rotation attempt against the now-fully-revoked family also fails (idempotent)', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      await postToken(refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id }));
      // First reuse attempt (already proven above to revoke the family).
      await postToken(refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id }));

      // Trying the SAME already-revoked refresh token a third time must
      // still fail cleanly, not throw or double-revoke incorrectly.
      const thirdRes = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id })
      );
      expect(thirdRes.status).toBe(400);
      expect(requireTokenErrorBody(thirdRes.body).error).toBe('invalid_grant');
    });
  });

  describe('genuine concurrent rotation of the same refresh token', () => {
    it('exactly one rotation succeeds; the detected race revokes the whole family, including the winner\'s own new token', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const parentRow = await tokenRowByAccessToken(initial.access_token);
      if (parentRow === null) throw new Error('expected a token row for the initial access token');
      const body = refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id });

      // Fired via Promise.all — an end-to-end smoke test of the observable
      // outcome across the full route, same caveat as token.ts's own
      // authorization_code concurrency test: dispatching together does not
      // guarantee the two requests actually interleave inside the critical
      // section. The forced, deterministic test below is what actually
      // proves the atomic-UPDATE race.
      const [resA, resB] = await Promise.all([postToken(body), postToken(body)]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const [winner, loser] = resA.status === 200 ? [resA, resB] : [resB, resA];
      const winnerBody = requireTokenSuccessBody(winner.body);
      expect(requireTokenErrorBody(loser.body).error).toBe('invalid_grant');

      // No double-issue: exactly one child row was ever created for this parent.
      const childCountResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oauth_tokens WHERE parent_id = $1`,
        [parentRow.id]
      );
      expect(Number(requireRow(childCountResult.rows[0], 'child count').count)).toBe(1);

      // Fail-safe under ambiguity: even the winner's brand-new access token
      // is already dead, because the loser's detected-reuse response
      // revoked the whole family (same trade-off as PF-104's own
      // concurrent-redemption test — see token.ts's module header).
      expect((await introspect(winnerBody.access_token)).status).toBe(401);

      const familyRows = await familyRevocationStates(parentRow.family_id);
      for (const row of familyRows) {
        expect(row.revoked_at, `row ${row.id} should be revoked after the race`).not.toBeNull();
      }
    });
  });

  describe('genuine concurrent rotation of the same refresh token (forced, deterministic race)', () => {
    /** Same polling pattern as token.ts's authorization_code equivalent —
     * a real, observable database fact (blocked backends), not a fixed
     * sleep (lessons.md rule 17). Scoped to `current_database()` and
     * excludes this poller's own backend (CodeRabbit finding, applied): the
     * factory runs many ticket worktrees against the SAME Postgres cluster,
     * each with its own database but a SHARED, cluster-wide
     * `pg_stat_activity` — an unscoped `query ILIKE` match could count a
     * sibling worktree's own concurrent run of this identical test as one of
     * THIS run's two expected blocked backends, corrupting the proof this
     * test exists to make. PF-104's own equivalent helper
     * (`waitForBlockedRedemptions` above) has the identical gap; left
     * unchanged as out of this ticket's scope — flagged here for whoever
     * next touches it. */
    async function waitForBlockedRotations(target: number, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await pool.query<{ blocked: string }>(
          `SELECT count(*)::text AS blocked FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND datname = current_database()
             AND pid <> pg_backend_pid()
             AND query ILIKE '%oauth_tokens%revoked_at%'`
        );
        const blocked = Number(requireRow(result.rows[0], 'pg_stat_activity poll').blocked);
        if (blocked >= target) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting for ${target} blocked rotation(s) on pg_stat_activity; last saw ${blocked}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it('calls the REAL rotateRefreshToken twice, forced to genuinely race: exactly one wins, no double-issue', async () => {
      // Same rationale as token.ts's forced authorization_code race test:
      // dispatching two HTTP requests together does not reliably force them
      // to interleave inside the atomic UPDATE — this test forces it
      // instead, without any test-only hook in production code. A third
      // connection takes an exclusive row lock on the parent token row
      // before either real rotation call starts; each call's own plain
      // SELECT (the validation read) succeeds immediately, but each call's
      // atomic UPDATE — the actual single-use gate — blocks on this lock.
      // Once BOTH are observed genuinely queued for it, the lock is
      // released and the two blocked UPDATEs contend for the row for real.
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);
      const parentRow = await tokenRowByAccessToken(initial.access_token);
      if (parentRow === null) throw new Error('expected a token row for the initial access token');

      const params = {
        refreshToken: initial.refresh_token,
        clientId: publicApp.client_id,
        clientSecret: undefined,
        scope: undefined,
      };

      const lockClient = await pool.connect();
      // Tracked explicitly (CodeRabbit finding on this test) so a throw
      // between BEGIN and COMMIT — e.g. waitForBlockedRotations timing
      // out — rolls back and releases the lock instead of returning a
      // connection to the pool while still holding an open transaction
      // and row lock.
      let transactionOpen = false;
      // Declared here, not inside the try block (CodeRabbit finding,
      // applied): `racePromise` is created and observed immediately once it
      // exists, so that if something throws later in the try block (e.g.
      // `waitForBlockedRotations` timing out) before the success path's own
      // `await racePromise`, the finally block below can still observe its
      // eventual settlement instead of leaving it an unhandled rejection.
      // Hoisted outside the try so it's safely `undefined` — not a TDZ
      // ReferenceError — if the try block throws before `racePromise` is
      // even created.
      let settled: Promise<unknown> | undefined;
      try {
        await lockClient.query('BEGIN');
        transactionOpen = true;
        await lockClient.query('SELECT id FROM oauth_tokens WHERE id = $1 FOR UPDATE', [parentRow.id]);

        const racePromise = Promise.all([rotateRefreshToken(params), rotateRefreshToken(params)]);
        settled = racePromise.catch(() => undefined);

        await waitForBlockedRotations(2);

        // Releasing here is what lets the race actually happen — both
        // blocked UPDATEs are now free to contend for the row lock.
        await lockClient.query('COMMIT');
        transactionOpen = false;

        const [resultA, resultB] = await racePromise;
        expect([resultA.ok, resultB.ok].sort()).toEqual([false, true]);
      } finally {
        if (transactionOpen) {
          await lockClient.query('ROLLBACK').catch(() => {});
        }
        if (settled) {
          await settled;
        }
        lockClient.release();
      }

      // No double-issue: exactly one child row was ever created, no matter
      // which call actually won the forced race.
      const childCountResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oauth_tokens WHERE parent_id = $1`,
        [parentRow.id]
      );
      expect(Number(requireRow(childCountResult.rows[0], 'child count').count)).toBe(1);

      // Zero active (non-revoked) tokens remain in the family after the
      // race resolves — the loser's detected-reuse response revokes the
      // WHOLE family, including the winner's own newly-committed child, per
      // this module's documented fail-safe-under-ambiguity design (comment
      // was previously misstated as "exactly one active"; corrected to
      // match this assertion — CodeRabbit finding).
      const familyRows = await familyRevocationStates(parentRow.family_id);
      const activeRows = familyRows.filter((row) => row.revoked_at === null);
      expect(activeRows).toHaveLength(0);
    });
  });

  describe('refresh_token grant — other negative cases', () => {
    it('unknown refresh_token -> 400 invalid_grant', async () => {
      const res = await postToken(
        refreshTokenBody({ refreshToken: 'ship_rt_does-not-exist', clientId: publicApp.client_id })
      );
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');
    });

    it('expired refresh_token -> 400 invalid_grant, and is NOT treated as reuse', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      await pool.query(
        `UPDATE oauth_tokens SET refresh_token_expires_at = now() - interval '1 minute'
         WHERE refresh_token_hash = $1`,
        [crypto.createHash('sha256').update(initial.refresh_token).digest('hex')]
      );

      const res = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: publicApp.client_id })
      );
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');

      // Expiry is not evidence of theft: the row itself must not have been
      // revoked by this rejection (distinct from the reuse-detection path).
      const row = await tokenRowByAccessToken(initial.access_token);
      expect(row?.revoked_at ?? null).toBeNull();
    });

    it('client_id mismatch (a different, validly-registered client) -> 400 invalid_grant', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: otherPublicApp.client_id })
      );
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');
    });

    it('confidential client, no client_secret -> 401 invalid_client', async () => {
      const initial = await mintInitialTokenPair(
        confidentialApp,
        CONFIDENTIAL_REDIRECT_URI,
        ['issues:write'],
        confidentialAppSecret
      );

      const res = await postToken(
        refreshTokenBody({ refreshToken: initial.refresh_token, clientId: confidentialApp.client_id })
      );
      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });

    it('scope exceeding originally granted -> 400 invalid_scope', async () => {
      const initial = await mintInitialTokenPair(publicApp, PUBLIC_REDIRECT_URI, ['documents:read']);

      const res = await postToken(
        refreshTokenBody({
          refreshToken: initial.refresh_token,
          clientId: publicApp.client_id,
          scope: 'issues:write',
        })
      );
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_scope');
    });

    it('missing refresh_token -> 400 invalid_request', async () => {
      const res = await postToken({ grant_type: 'refresh_token', client_id: publicApp.client_id });
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_request');
    });

    it('missing client_id -> 400 invalid_request', async () => {
      const res = await postToken({ grant_type: 'refresh_token', refresh_token: 'ship_rt_whatever' });
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_request');
    });
  });

  // ── grant_type handling ───────────────────────────────────────────────

  describe('grant_type handling', () => {
    it('missing grant_type -> 400 invalid_request', async () => {
      const res = await postToken({ client_id: publicApp.client_id });
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_request');
    });

    it('unsupported grant_type -> 400 unsupported_grant_type', async () => {
      const res = await postToken({ grant_type: 'password', client_id: publicApp.client_id });
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('unsupported_grant_type');
    });
  });
});
