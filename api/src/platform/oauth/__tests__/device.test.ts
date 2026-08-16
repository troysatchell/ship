/**
 * Regression tests for PF-106 / TRO-425 — RFC 8628 Device Authorization
 * Grant: `POST /oauth/device/code`, `POST /oauth/device/verify`, and the
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code` branch of
 * `POST /oauth/token`. This file (`api/src/platform/oauth/__tests__/`) is
 * what `gate.sh` actually executes — same convention as `authorize.test.ts`
 * and `token.test.ts`.
 *
 * ── Time, with no real waits (this ticket's own explicit AC) ──
 * `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime()` — the
 * exact pattern `routes/change-feed.test.ts` already established for a real
 * supertest+DB integration test: only `Date.now()`/`new Date()` are faked,
 * so the HTTP/DB round trips underneath still run on real timers (nothing
 * hangs). Every "elapsed time" assertion below moves the fake clock forward
 * instead of sleeping.
 *
 * Fixture pattern (workspace/user/session via direct SQL, apps via the real
 * `createOAuthApp`, session cookie via supertest) copied from
 * `token.test.ts`/`authorize.test.ts`. Runs against this worktree's real
 * `DATABASE_URL` (`source .factory-env` first) — same hazard as every other
 * api test file (`api/src/test/setup.ts` truncates 16 tables in
 * `beforeAll`; `oauth_apps`/`oauth_device_codes`/`oauth_tokens` are NOT in
 * that list, so this file cleans up its own rows).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createOAuthApp, type OAuthAppSummary } from '../appRegistration.js';
import { bearerAuth } from '../bearerAuth.js';
import { DEVICE_CODE_TTL_MS, DEFAULT_DEVICE_POLL_INTERVAL_SECONDS, DEVICE_SLOW_DOWN_INCREMENT_SECONDS } from '../device.js';

describe('/oauth/device/* (PF-106)', () => {
  const app = createApp(); // default corsOrigin: http://localhost:5173
  const WEB_ORIGIN = 'http://localhost:5173';
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `oauth-device-${testRunId}@ship.local`;
  const testWorkspaceName = `OAuth Device Test ${testRunId}`;

  let sessionCookie: string;
  let testWorkspaceId: string;
  let testUserId: string;

  let publicApp: OAuthAppSummary;

  // A tiny scratch app mounting the REAL bearerAuth middleware — same
  // "token works" proof `token.test.ts` uses.
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
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'OAuth Device Test User') RETURNING id`,
      [testEmail]
    );
    testUserId = requireRow(userResult.rows[0], 'user insert').id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    );

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, testUserId, testWorkspaceId]
    );
    sessionCookie = `session_id=${sessionId}`;

    // Device-flow clients are inherently public (RFC 8628 §1 — a CLI can't
    // hold a secret safely); no redirect_uris needed for this grant.
    const publicResult = await createOAuthApp({
      workspaceId: testWorkspaceId,
      ownerUserId: testUserId,
      name: `PF-106 Test Client ${testRunId}`,
      clientType: 'public',
      requestedScopes: ['documents:read', 'issues:read'],
    });
    publicApp = publicResult.app;
  });

  afterAll(async () => {
    // Cascades to oauth_device_codes and oauth_tokens (both FKs are ON
    // DELETE CASCADE on app_id).
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [testWorkspaceId]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Narrowing helpers (lessons.md RULE-16/RULE-21: no `!`/`as any`). ────

  function requireRow<T>(row: T | undefined, label: string): T {
    if (row === undefined) throw new Error(`expected a row from ${label}`);
    return row;
  }

  function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`expected ${label} to be a string, got ${typeof value}`);
    return value;
  }

  function requireNumber(value: unknown, label: string): number {
    if (typeof value !== 'number') throw new Error(`expected ${label} to be a number, got ${typeof value}`);
    return value;
  }

  interface DeviceCodeResponseBody {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }

  function requireDeviceCodeBody(body: unknown): DeviceCodeResponseBody {
    const b = body as Record<string, unknown>;
    return {
      device_code: requireString(b.device_code, 'device_code'),
      user_code: requireString(b.user_code, 'user_code'),
      verification_uri: requireString(b.verification_uri, 'verification_uri'),
      verification_uri_complete: requireString(b.verification_uri_complete, 'verification_uri_complete'),
      expires_in: requireNumber(b.expires_in, 'expires_in'),
      interval: requireNumber(b.interval, 'interval'),
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

  function requireLocation(res: request.Response): string {
    const location: unknown = res.headers.location;
    expect(location, 'response should carry a Location header').toBeTruthy();
    return requireString(location, 'Location header');
  }

  function requestDeviceCode(clientId: string, scope?: string): request.Test {
    const fields: Record<string, string> = { client_id: clientId };
    if (scope) fields.scope = scope;
    return request(app).post('/oauth/device/code').type('form').send(fields);
  }

  function pollToken(deviceCode: string): request.Test {
    return request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  }

  function submitVerifyDecision(
    userCode: string,
    decision: 'approve' | 'deny',
    cookie?: string
  ): request.Test {
    const req = request(app).post('/oauth/device/verify').type('form').send({ user_code: userCode, decision });
    return cookie ? req.set('Cookie', cookie) : req;
  }

  async function deviceCodeRow(
    deviceCode: string
  ): Promise<{ status: string; interval_seconds: number; token_issued_at: Date | null } | undefined> {
    const hash = crypto.createHash('sha256').update(deviceCode).digest('hex');
    const result = await pool.query<{ status: string; interval_seconds: number; token_issued_at: Date | null }>(
      `SELECT status, interval_seconds, token_issued_at FROM oauth_device_codes WHERE device_code_hash = $1`,
      [hash]
    );
    return result.rows[0];
  }

  async function introspect(accessToken: string): Promise<request.Response> {
    return request(introspectionApp).get('/scratch-protected').set('Authorization', `Bearer ${accessToken}`);
  }

  // ── POST /oauth/device/code ──────────────────────────────────────────

  describe('POST /oauth/device/code', () => {
    it('issues a human-typable user_code, a device_code, and the default 5s interval', async () => {
      const res = await requestDeviceCode(publicApp.client_id, 'documents:read');
      expect(res.status).toBe(200);
      const body = requireDeviceCodeBody(res.body);

      expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      // No 0/O/1/I anywhere (the ticket's explicit unambiguous-charset AC).
      expect(body.user_code).not.toMatch(/[0O1I]/);
      expect(body.device_code.length).toBeGreaterThan(32);
      expect(body.interval).toBe(DEFAULT_DEVICE_POLL_INTERVAL_SECONDS);
      expect(body.expires_in).toBe(Math.floor(DEVICE_CODE_TTL_MS / 1000));
      expect(body.verification_uri).toBe(`${WEB_ORIGIN}/oauth-device-verify`);
      expect(body.verification_uri_complete).toBe(
        `${WEB_ORIGIN}/oauth-device-verify?user_code=${encodeURIComponent(body.user_code)}`
      );
    });

    it('rejects an unknown client_id with invalid_client', async () => {
      const res = await requestDeviceCode('ship_app_does_not_exist');
      expect(res.status).toBe(401);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_client');
    });

    it('rejects a scope the app never registered with invalid_scope', async () => {
      const res = await requestDeviceCode(publicApp.client_id, 'admin:write');
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_scope');
    });
  });

  // ── Full poll-to-approval flow ───────────────────────────────────────

  describe('poll-to-approval flow (AC: integration test polling to approval, slow_down honored)', () => {
    it('pending -> slow_down (interval increases, twice) -> approve -> real token -> reused device_code is invalid_grant', async () => {
      const baseTime = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(baseTime);

      const codeRes = await requestDeviceCode(publicApp.client_id, 'documents:read');
      expect(codeRes.status).toBe(200);
      const { device_code: deviceCode, user_code: userCode } = requireDeviceCodeBody(codeRes.body);

      // First poll: no prior poll exists yet, so it is NEVER throttled
      // (RFC 8628 rate-limits consecutive polls, not time-since-issuance) —
      // pending, not slow_down.
      const poll1 = await pollToken(deviceCode);
      expect(poll1.status).toBe(400);
      expect(requireTokenErrorBody(poll1.body).error).toBe('authorization_pending');

      const rowAfterPoll1 = requireRow(await deviceCodeRow(deviceCode), 'device code row after poll 1');
      expect(rowAfterPoll1.interval_seconds).toBe(DEFAULT_DEVICE_POLL_INTERVAL_SECONDS);

      // Second poll, 2s later: well inside the 5s interval -> slow_down, and
      // the interval must ACTUALLY increase server-side (the ticket's own
      // AC), not just return the error code.
      vi.setSystemTime(baseTime + 2_000);
      const poll2 = await pollToken(deviceCode);
      expect(poll2.status).toBe(400);
      expect(requireTokenErrorBody(poll2.body).error).toBe('slow_down');

      const rowAfterPoll2 = requireRow(await deviceCodeRow(deviceCode), 'device code row after poll 2');
      expect(rowAfterPoll2.interval_seconds).toBe(
        DEFAULT_DEVICE_POLL_INTERVAL_SECONDS + DEVICE_SLOW_DOWN_INCREMENT_SECONDS
      );

      // Third poll, only 3s after poll 2: still inside the NEW (10s)
      // interval -> slow_down AGAIN, interval increases AGAIN. Proves the
      // increase compounds rather than being a one-time bump, and that an
      // early poll is genuinely rejected against the updated interval, not
      // the original one.
      vi.setSystemTime(baseTime + 2_000 + 3_000);
      const poll3 = await pollToken(deviceCode);
      expect(poll3.status).toBe(400);
      expect(requireTokenErrorBody(poll3.body).error).toBe('slow_down');

      const rowAfterPoll3 = requireRow(await deviceCodeRow(deviceCode), 'device code row after poll 3');
      expect(rowAfterPoll3.interval_seconds).toBe(
        DEFAULT_DEVICE_POLL_INTERVAL_SECONDS + 2 * DEVICE_SLOW_DOWN_INCREMENT_SECONDS
      );

      // Approve via the verify-page endpoint. Deliberately submits the
      // user_code lowercased, with the hyphen stripped and stray whitespace
      // added, to prove `normalizeUserCode` actually normalizes rather than
      // requiring an exact-format paste.
      const mangledUserCode = ` ${userCode.replace('-', '').toLowerCase()} `;
      const approveRes = await submitVerifyDecision(mangledUserCode, 'approve', sessionCookie);
      expect(approveRes.status).toBe(303);
      expect(requireLocation(approveRes)).toBe(`${WEB_ORIGIN}/oauth-device-verify?result=approved`);

      // Fourth poll, 15s after poll 3's last_polled_at (>= the 15s interval
      // poll 3 left behind) -> not throttled, status is now 'approved' and
      // never yet redeemed -> a real token pair, same shape
      // `redeemAuthorizationCode` returns for the authorization_code grant.
      vi.setSystemTime(baseTime + 2_000 + 3_000 + 15_000);
      const poll4 = await pollToken(deviceCode);
      expect(poll4.status).toBe(200);
      const tokenBody = requireTokenSuccessBody(poll4.body);
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('documents:read');
      expect(tokenBody.refresh_token).toBeDefined();

      const rowAfterPoll4 = requireRow(await deviceCodeRow(deviceCode), 'device code row after poll 4');
      expect(rowAfterPoll4.token_issued_at).not.toBeNull();

      // The minted access token is real and usable, introspected through
      // the REAL production bearerAuth middleware (same proof shape as
      // token.test.ts).
      const introspectRes = await introspect(tokenBody.access_token);
      expect(introspectRes.status).toBe(200);
      expect(introspectRes.body.principal.user?.id).toBe(testUserId);

      // Fifth poll, immediately after (no time advance needed): the
      // already-redeemed check runs BEFORE the throttle check, so this is
      // invalid_grant regardless of interval timing — and, separately,
      // proves no second token pair was minted.
      const poll5 = await pollToken(deviceCode);
      expect(poll5.status).toBe(400);
      expect(requireTokenErrorBody(poll5.body).error).toBe('invalid_grant');

      const tokenCountResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oauth_tokens WHERE access_token_hash = $1`,
        [crypto.createHash('sha256').update(tokenBody.access_token).digest('hex')]
      );
      expect(Number(requireRow(tokenCountResult.rows[0], 'token count').count)).toBe(1);
    });

    it('deny path: a denied device_code polls as access_denied, never issues a token', async () => {
      const codeRes = await requestDeviceCode(publicApp.client_id, 'documents:read');
      const { device_code: deviceCode, user_code: userCode } = requireDeviceCodeBody(codeRes.body);

      const denyRes = await submitVerifyDecision(userCode, 'deny', sessionCookie);
      expect(denyRes.status).toBe(303);
      expect(requireLocation(denyRes)).toBe(`${WEB_ORIGIN}/oauth-device-verify?result=denied`);

      const pollRes = await pollToken(deviceCode);
      expect(pollRes.status).toBe(400);
      expect(requireTokenErrorBody(pollRes.body).error).toBe('access_denied');

      const row = requireRow(await deviceCodeRow(deviceCode), 'device code row after deny');
      expect(row.status).toBe('denied');
      expect(row.token_issued_at).toBeNull();
    });
  });

  // ── Expiry path (separate test, per this ticket's own instructions) ────

  describe('expiry path', () => {
    it('a device_code past expires_at polls as expired_token and the verify page rejects it too', async () => {
      const baseTime = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(baseTime);

      const codeRes = await requestDeviceCode(publicApp.client_id, 'documents:read');
      const { device_code: deviceCode, user_code: userCode } = requireDeviceCodeBody(codeRes.body);

      // Past DEVICE_CODE_TTL_MS, no real wait — only the faked Date moves.
      vi.setSystemTime(baseTime + DEVICE_CODE_TTL_MS + 60_000);

      const pollRes = await pollToken(deviceCode);
      expect(pollRes.status).toBe(400);
      expect(requireTokenErrorBody(pollRes.body).error).toBe('expired_token');

      const row = requireRow(await deviceCodeRow(deviceCode), 'device code row after expiry');
      expect(row.status).toBe('expired');

      // A human who was mid-way through typing the code when it expired
      // gets a clear "expired" outcome too, not "not found".
      const verifyRes = await submitVerifyDecision(userCode, 'approve', sessionCookie);
      expect(verifyRes.status).toBe(303);
      expect(requireLocation(verifyRes)).toBe(`${WEB_ORIGIN}/oauth-device-verify?error=expired`);
    });
  });

  // ── TRO-589: user_code hashed at rest ────────────────────────────────
  // device_code_hash has always been hashed; user_code — the human-typed
  // 8-char code, same table — was found stored in plaintext (this ticket's
  // own PF-106/TRO-425 landing agent's security self-review). Queries the
  // DB directly (not through this module's own lookup helpers, which would
  // trivially "pass" either way) to prove the column itself never holds the
  // plaintext value.

  describe('TRO-589: user_code is hashed at rest', () => {
    it('stores a SHA-256 hash of user_code, not the plaintext code returned to the client', async () => {
      const codeRes = await requestDeviceCode(publicApp.client_id, 'documents:read');
      expect(codeRes.status).toBe(200);
      const { device_code: deviceCode, user_code: plaintextUserCode } = requireDeviceCodeBody(codeRes.body);

      const rowResult = await pool.query<{ user_code: string }>(
        `SELECT user_code FROM oauth_device_codes WHERE device_code_hash = $1`,
        [crypto.createHash('sha256').update(deviceCode).digest('hex')]
      );
      const storedUserCode = requireRow(rowResult.rows[0], 'device code row (user_code column)').user_code;

      // The DB column must not hold the plaintext value the human sees/types.
      expect(storedUserCode).not.toBe(plaintextUserCode);
      // It must be exactly the SHA-256 hex digest of that plaintext value —
      // same deterministic hash-at-rest pattern device_code_hash already
      // uses — proving this is a real, reversible-by-rehashing lookup key,
      // not some other transformation (a salted hash would break lookups;
      // a truncation/encoding wouldn't satisfy "hashed").
      expect(storedUserCode).toBe(crypto.createHash('sha256').update(plaintextUserCode).digest('hex'));
      expect(storedUserCode).toMatch(/^[0-9a-f]{64}$/);

      // And the hash still works for its actual purpose: a human typing the
      // plaintext code at the verify page must still resolve to this row.
      const approveRes = await submitVerifyDecision(plaintextUserCode, 'approve', sessionCookie);
      expect(approveRes.status).toBe(303);
      expect(requireLocation(approveRes)).toBe(`${WEB_ORIGIN}/oauth-device-verify?result=approved`);
    });
  });

  // ── Misc negative cases ───────────────────────────────────────────────

  describe('negative cases', () => {
    it('polling an unknown device_code is invalid_grant', async () => {
      const res = await pollToken(`not-a-real-device-code-${testRunId}`);
      expect(res.status).toBe(400);
      expect(requireTokenErrorBody(res.body).error).toBe('invalid_grant');
    });

    it('verify decision with no session redirects to /login with a returnTo', async () => {
      const codeRes = await requestDeviceCode(publicApp.client_id, 'documents:read');
      const { user_code: userCode } = requireDeviceCodeBody(codeRes.body);

      const res = await submitVerifyDecision(userCode, 'approve');
      expect(res.status).toBe(303);
      const location = requireLocation(res);
      expect(location).toContain(`${WEB_ORIGIN}/login?returnTo=`);
      expect(location).toContain(encodeURIComponent('/oauth-device-verify'));
    });

    it('verify decision for an unrecognized user_code redirects with error=not_found', async () => {
      const res = await submitVerifyDecision('ZZZZ-ZZZZ', 'approve', sessionCookie);
      expect(res.status).toBe(303);
      expect(requireLocation(res)).toBe(`${WEB_ORIGIN}/oauth-device-verify?error=not_found`);
    });
  });
});
