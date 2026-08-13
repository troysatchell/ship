/**
 * Regression tests for PF-103 / TRO-412 — `/oauth/authorize` + consent
 * decision. Per the ticket's own NOTE and this file's placement
 * (`api/src/platform/oauth/__tests__/`), these are the tests `gate.sh`
 * actually executes; the additive Playwright e2e spec
 * (`e2e/oauth-authorize.spec.ts`) is NOT the proof — see CHANGES.md
 * (TRO-412) for what it covers and its execution status.
 *
 * Per the test-design comment on this ticket (2026-08-10):
 *   AC-1 — records code_challenge (+method), rejects anything but S256.
 *   AC-2 — validates redirect_uri by EXACT match (open-redirect guard).
 *   AC-3 — deny path returns error=access_denied, no code, no row.
 * AC-4 (CSP frame-ancestors) is deliberately NOT a case here — this ticket's
 * consent page is a web-app (Vite/React) route, not Express-server-rendered
 * (see CHANGES.md), so the test-design comment's own "if Express-server-
 * rendered" condition does not hold. The additive e2e spec covers it
 * best-effort; not gate-executed either way (see that spec's header).
 *
 * Fixture pattern (workspace/user/session via direct SQL, session cookie via
 * supertest) copied from `api/src/routes/documents.test.ts`. Runs against
 * this worktree's real `DATABASE_URL` (`source .factory-env` first) — same
 * hazard as every other api test file (`api/src/test/setup.ts` truncates 16
 * tables in `beforeAll`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';
import { SESSION_INACTIVITY_LIMIT_MS } from '../../../middleware/auth.js';

describe('/oauth/authorize + /oauth/authorize/decision (PF-103)', () => {
  const app = createApp(); // default corsOrigin: http://localhost:5173
  const WEB_ORIGIN = 'http://localhost:5173';
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `oauth-authz-${testRunId}@ship.local`;
  const testWorkspaceName = `OAuth Authorize Test ${testRunId}`;
  const REGISTERED_REDIRECT_URI = `https://client.example.com/callback-${testRunId}`;

  let sessionCookie: string;
  let testWorkspaceId: string;
  let testUserId: string;
  let testAppId: string;
  let testClientId: string;

  // Second, unrelated workspace + session — exclusively for the
  // cross-workspace rejection test below. Never touches testAppId/
  // REGISTERED_REDIRECT_URI's fixtures.
  let otherWorkspaceId: string;
  let otherUserId: string;
  let otherSessionCookie: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = workspaceResult.rows[0].id;

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'OAuth Authz Test User') RETURNING id`,
      [testEmail]
    );
    testUserId = userResult.rows[0].id;

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

    // A registered OAuth app to authorize against. Created directly via SQL
    // (PF-102's actual registration route is not available in this
    // worktree — see CHANGES.md TRO-412) — the same fixture strategy every
    // other route test in this repo already uses for its own dependencies.
    testClientId = `ship_app_test_${testRunId}`;
    const appResult = await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes, owner_user_id)
       VALUES ($1, 'PF-103 Test Client', $2, 'public', $3, $4, $5)
       RETURNING id`,
      [testWorkspaceId, testClientId, [REGISTERED_REDIRECT_URI], ['documents:read'], testUserId]
    );
    testAppId = appResult.rows[0].id;

    // Second workspace/user/session, deliberately not a member of
    // testWorkspaceId and with no relation to testAppId.
    const otherWorkspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`OAuth Authorize Test (other) ${testRunId}`]
    );
    otherWorkspaceId = otherWorkspaceResult.rows[0].id;

    const otherUserResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'OAuth Authz Other-Workspace User') RETURNING id`,
      [`oauth-authz-other-${testRunId}@ship.local`]
    );
    otherUserId = otherUserResult.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [otherWorkspaceId, otherUserId]
    );

    const otherSessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [otherSessionId, otherUserId, otherWorkspaceId]
    );
    otherSessionCookie = `session_id=${otherSessionId}`;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_authorization_codes WHERE app_id = $1', [testAppId]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [testAppId]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[testUserId, otherUserId]]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = ANY($1)', [[testUserId, otherUserId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[testUserId, otherUserId]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[testWorkspaceId, otherWorkspaceId]]);
  });

  beforeEach(async () => {
    // Isolate each case's row-count assertions from the others.
    await pool.query('DELETE FROM oauth_authorization_codes WHERE app_id = $1', [testAppId]);
  });

  async function authCodeRowCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM oauth_authorization_codes WHERE app_id = $1',
      [testAppId]
    );
    const [row] = result.rows;
    if (!row) throw new Error('COUNT(*) query returned no rows');
    return Number(row.count);
  }

  /** Narrows supertest's `string | undefined` Location header to `string`,
   * failing the test with a clear message rather than a TypeScript cast
   * (lessons.md RULE-16: no `as`/`!` — destructure and assert explicitly). */
  function requireLocation(res: request.Response): string {
    const location: unknown = res.headers.location;
    expect(location, 'response should carry a Location header').toBeTruthy();
    if (typeof location !== 'string') {
      throw new Error('Location header missing or not a string');
    }
    return location;
  }

  describe('AC-1: records code_challenge (+method), S256-only', () => {
    it('valid S256 request + consent-approve redirects to redirect_uri with a code, and records the challenge hashed at rest', async () => {
      const codeChallenge = 'test-challenge-value-abc123';
      const state = 'xyz-state-1';

      // Step 1: GET /oauth/authorize — validates and hands off to the
      // web app's consent page.
      const authorizeRes = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          scope: 'documents:read',
          state,
        })
        .set('Cookie', sessionCookie);

      expect(authorizeRes.status).toBeGreaterThanOrEqual(300);
      expect(authorizeRes.status).toBeLessThan(400);
      const consentLocation = new URL(requireLocation(authorizeRes));
      expect(consentLocation.origin).toBe(WEB_ORIGIN);
      expect(consentLocation.pathname).toBe('/oauth-consent');
      expect(consentLocation.searchParams.get('client_id')).toBe(testClientId);
      expect(consentLocation.searchParams.get('code_challenge')).toBe(codeChallenge);
      expect(consentLocation.searchParams.get('code_challenge_method')).toBe('S256');

      // Step 2: consent-approve — the consent page's form target.
      const decisionRes = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', sessionCookie)
        .type('form')
        .send({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          scope: 'documents:read',
          state,
          decision: 'approve',
        });

      expect(decisionRes.status).toBeGreaterThanOrEqual(300);
      expect(decisionRes.status).toBeLessThan(400);
      const finalLocation = new URL(requireLocation(decisionRes));
      expect(`${finalLocation.origin}${finalLocation.pathname}`).toBe(REGISTERED_REDIRECT_URI);
      expect(finalLocation.searchParams.get('state')).toBe(state);
      const issuedCode = finalLocation.searchParams.get('code');
      expect(issuedCode).toBeTruthy();
      if (!issuedCode) throw new Error('no code param on the redirect target');

      // The created row: challenge + method recorded, single-use (consumed_at
      // NULL), and — critically — only the hash is stored, never the raw code.
      const rowResult = await pool.query<{
        code_hash: string;
        code_challenge: string;
        code_challenge_method: string;
        consumed_at: Date | null;
        redirect_uri: string;
      }>(
        'SELECT code_hash, code_challenge, code_challenge_method, consumed_at, redirect_uri FROM oauth_authorization_codes WHERE app_id = $1',
        [testAppId]
      );
      expect(rowResult.rows).toHaveLength(1);
      const [row] = rowResult.rows;
      if (!row) throw new Error('expected exactly one oauth_authorization_codes row');
      expect(row.code_challenge).toBe(codeChallenge);
      expect(row.code_challenge_method).toBe('S256');
      expect(row.consumed_at).toBeNull();
      expect(row.redirect_uri).toBe(REGISTERED_REDIRECT_URI);

      // The raw code is never stored anywhere: the stored hash must not equal
      // the plaintext code, and must equal its SHA-256 digest (the only
      // column that could hold the code at all is code_hash).
      expect(row.code_hash).not.toBe(issuedCode);
      expect(row.code_hash).toBe(crypto.createHash('sha256').update(issuedCode).digest('hex'));
    });

    it('rejects code_challenge_method=plain — no redirect-with-code, no row created', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'plain',
        })
        .set('Cookie', sessionCookie);

      // redirect_uri IS registered, so RFC 6749 says report the error via
      // redirect to it — never a code, never the consent page.
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.has('code')).toBe(false);
      expect(location.pathname).not.toBe('/oauth-consent');

      expect(await authCodeRowCount()).toBe(0);
    });
  });

  describe('AC-2: redirect_uri exact match (open-redirect guard)', () => {
    it('rejects a trailing-slash variant — never redirects to it or to the registered URI, no row created', async () => {
      const mismatched = `${REGISTERED_REDIRECT_URI}/`;
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId,
          redirect_uri: mismatched,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
        })
        .set('Cookie', sessionCookie);

      // Open-redirect guard: redirect_uri could not be verified, so this
      // response must not redirect anywhere at all.
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();

      expect(await authCodeRowCount()).toBe(0);
    });

    it('rejects an unknown client_id the same way — no redirect anywhere', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: 'ship_app_does_not_exist',
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
        })
        .set('Cookie', sessionCookie);

      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });
  });

  describe('AC-3: deny path returns error=access_denied', () => {
    it('redirects to redirect_uri with error=access_denied, no code, no row created', async () => {
      const state = 'deny-state-1';
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', sessionCookie)
        .type('form')
        .send({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
          state,
          decision: 'deny',
        });

      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.has('code')).toBe(false);
      expect(location.searchParams.get('state')).toBe(state);

      expect(await authCodeRowCount()).toBe(0);
    });
  });

  describe('response_type must be "code" (CodeRabbit review finding, TRO-412)', () => {
    it('missing response_type is rejected via redirect once redirect_uri is trusted', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          // response_type omitted entirely.
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
        })
        .set('Cookie', sessionCookie);

      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('unsupported_response_type');
      expect(location.searchParams.has('code')).toBe(false);

      expect(await authCodeRowCount()).toBe(0);
    });
  });

  describe('scope must be a subset of the app\'s registered scopes (CodeRabbit review finding, TRO-412, critical)', () => {
    it('requesting a scope the app never registered is rejected — no code, no row created', async () => {
      // testAppId is registered with only ['documents:read'] (beforeAll).
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', sessionCookie)
        .type('form')
        .send({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
          scope: 'admin:write',
          decision: 'approve',
        });

      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(`${location.origin}${location.pathname}`).toBe(REGISTERED_REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('invalid_scope');
      expect(location.searchParams.has('code')).toBe(false);

      expect(await authCodeRowCount()).toBe(0);
    });

    it('a subset of the registered scopes is accepted and recorded exactly as requested', async () => {
      // testAppId's requested_scopes is ['documents:read'] — request exactly
      // that (a real subset check, not just "anything goes because it's the
      // app's only scope").
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', sessionCookie)
        .type('form')
        .send({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
          scope: 'documents:read',
          decision: 'approve',
        });

      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(location.searchParams.get('code')).toBeTruthy();

      const rowResult = await pool.query<{ scopes: string[] }>(
        'SELECT scopes FROM oauth_authorization_codes WHERE app_id = $1',
        [testAppId]
      );
      expect(rowResult.rows).toHaveLength(1);
      const [row] = rowResult.rows;
      if (!row) throw new Error('expected exactly one oauth_authorization_codes row');
      expect(row.scopes).toEqual(['documents:read']);
    });
  });

  describe('the consenting user must belong to the app\'s own workspace (CodeRabbit review finding, TRO-412)', () => {
    it('rejects consent from a user in a different workspace — no redirect anywhere, no row created', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId, // registered under testWorkspaceId
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
        })
        .set('Cookie', otherSessionCookie); // session in otherWorkspaceId

      // Cross-tenant boundary violation: never redirect, even to the
      // registered redirect_uri — this user simply isn't entitled to act on
      // this app at all.
      expect(res.status).toBe(403);
      expect(res.headers.location).toBeUndefined();

      expect(await authCodeRowCount()).toBe(0);
    });

    it('the POST decision endpoint enforces the same boundary independently', async () => {
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', otherSessionCookie)
        .type('form')
        .send({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
          decision: 'approve',
        });

      expect(res.status).toBe(403);
      expect(res.headers.location).toBeUndefined();

      expect(await authCodeRowCount()).toBe(0);
    });
  });

  describe('unauthenticated request', () => {
    it('GET /oauth/authorize with no session redirects to /login with a returnTo back into the flow', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: testClientId,
          redirect_uri: REGISTERED_REDIRECT_URI,
          response_type: 'code',
          code_challenge: 'irrelevant-challenge',
          code_challenge_method: 'S256',
        });
      // No .set('Cookie', ...) — genuinely anonymous.

      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = new URL(requireLocation(res));
      expect(location.origin).toBe(WEB_ORIGIN);
      expect(location.pathname).toBe('/login');
      const returnTo = location.searchParams.get('returnTo');
      expect(returnTo).toBeTruthy();
      expect(returnTo).toContain('/oauth-consent');
    });

    // Exercises getSessionPrincipal's two READ checks (authorize.ts:196-215)
    // directly — this function re-implements authMiddleware's inactivity and
    // absolute-age checks inline rather than calling it (see that function's
    // own header comment for why), so nothing else in this file's fixtures
    // proves those two checks actually work.
    it('a session past ABSOLUTE_SESSION_TIMEOUT_MS redirects to /login, same as no session at all', async () => {
      const staleSessionId = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
         VALUES ($1, $2, $3, now() + interval '1 hour', now(), now() - ($4 * interval '1 millisecond'))`,
        [staleSessionId, testUserId, testWorkspaceId, ABSOLUTE_SESSION_TIMEOUT_MS + 60_000]
      );

      try {
        const res = await request(app)
          .get('/oauth/authorize')
          .query({
            client_id: testClientId,
            redirect_uri: REGISTERED_REDIRECT_URI,
            response_type: 'code',
            code_challenge: 'irrelevant-challenge',
            code_challenge_method: 'S256',
          })
          .set('Cookie', `session_id=${staleSessionId}`);

        expect(res.status).toBeGreaterThanOrEqual(300);
        expect(res.status).toBeLessThan(400);
        const location = new URL(requireLocation(res));
        expect(location.origin).toBe(WEB_ORIGIN);
        expect(location.pathname).toBe('/login');
      } finally {
        await pool.query('DELETE FROM sessions WHERE id = $1', [staleSessionId]);
      }
    });

    it('a session past SESSION_INACTIVITY_LIMIT_MS redirects to /login, same as no session at all', async () => {
      const idleSessionId = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
         VALUES ($1, $2, $3, now() + interval '1 hour', now() - ($4 * interval '1 millisecond'), now())`,
        [idleSessionId, testUserId, testWorkspaceId, SESSION_INACTIVITY_LIMIT_MS + 60_000]
      );

      try {
        const res = await request(app)
          .get('/oauth/authorize')
          .query({
            client_id: testClientId,
            redirect_uri: REGISTERED_REDIRECT_URI,
            response_type: 'code',
            code_challenge: 'irrelevant-challenge',
            code_challenge_method: 'S256',
          })
          .set('Cookie', `session_id=${idleSessionId}`);

        expect(res.status).toBeGreaterThanOrEqual(300);
        expect(res.status).toBeLessThan(400);
        const location = new URL(requireLocation(res));
        expect(location.origin).toBe(WEB_ORIGIN);
        expect(location.pathname).toBe('/login');
      } finally {
        await pool.query('DELETE FROM sessions WHERE id = $1', [idleSessionId]);
      }
    });
  });
});
