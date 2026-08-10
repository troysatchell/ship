import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

/**
 * PF-001 — platform scaffold + `/api/v1` router (PLUGFORGE.MD §4).
 *
 * Test design (ship-test-designer, Linear TRO-396 comment, 2026-08-10) maps
 * one test per AC clause below. Uses the real `createApp()` — not a
 * standalone router-only test app — because AC-3 needs an existing internal
 * route alongside the new v1 one to prove the v1 middleware didn't leak.
 */

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('PF-001: /api/v1 platform router', () => {
  const app = createApp();

  it('AC-1: GET /api/v1/health 200s with an X-Request-Id header (UUIDv4)', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(UUID_V4_RE);
  });

  it('AC-2: a cross-origin fetch of /api/v1/health succeeds with credential-less CORS headers', async () => {
    // Set/restore explicitly rather than relying on whatever happens to be in
    // the ambient environment when this suite runs (finding #2, PR #170
    // review) — the assertion below checks an EXACT value, so an inherited
    // env var would make this test pass for the wrong reason.
    const previous = process.env.PUBLIC_API_CORS_ORIGIN;
    delete process.env.PUBLIC_API_CORS_ORIGIN;
    try {
      const res = await request(app).get('/api/v1/health').set('Origin', 'http://example.com');

      expect(res.status).toBe(200);
      // Default PUBLIC_API_CORS_ORIGIN (unset here) resolves to '*' — any
      // origin is allowed. Assert the exact configured value, not merely
      // that the header is present (finding #2, PR #170 review) — a
      // present-but-wrong value (e.g. the app-global single-origin policy's
      // value) would have passed the old `toBeDefined()` assertion.
      expect(res.headers['access-control-allow-origin']).toBe('*');
      // Public CORS is deliberately credentials: false (§2.1) — there is no
      // cookie for this header to protect, and setting it would misstate what
      // the public API authenticates with.
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.PUBLIC_API_CORS_ORIGIN;
      } else {
        process.env.PUBLIC_API_CORS_ORIGIN = previous;
      }
    }
  });

  it('CodeRabbit #1: an unmatched /api/v1/* path does not fall through to the app-global session CORS', async () => {
    // v1Router only defines GET /health today (PF-002's 404 fallthrough
    // hasn't landed yet), so an unmatched path like this one falls through
    // past `app.use('/api/v1', v1Router)` to whatever is mounted after it —
    // which, before this fix, was the app-global single-origin
    // `credentials: true` cors(). That overwrote Access-Control-Allow-Origin
    // with the single-origin value and added
    // Access-Control-Allow-Credentials: true onto a response that had
    // already been served the public, credential-less CORS policy.
    // Asserting on headers, not status: the route 404ing is fine and
    // expected pre-PF-002 — what must never happen is the session CORS
    // policy leaking onto a public-surface request.
    const res = await request(app)
      .get('/api/v1/nonexistent')
      .set('Origin', 'http://example.com');

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('CodeRabbit #1: an /oauth path does not fall through to the app-global session CORS', async () => {
    // /oauth has no router mounted yet (added by a later ticket, E1) — every
    // /oauth request 404s today. Same hazard as the unmatched /api/v1/* case
    // above: nothing terminates the request inside the public-CORS-covered
    // section, so it used to fall through to the app-global session cors().
    const res = await request(app)
      .get('/oauth/token')
      .set('Origin', 'http://example.com');

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('CodeRabbit follow-up: a lookalike path (/api/v10) is NOT treated as public surface and still gets the app-global session CORS', async () => {
    // `req.path.startsWith('/api/v1')` would wrongly match `/api/v10...` too —
    // caught in gate.sh's local CodeRabbit pass on the fix above. The guard
    // must match on a path-segment boundary (exact prefix, or prefix + `/`),
    // the same way Express's own `app.use('/api/v1', ...)` mount already
    // does. `createApp()`'s default `corsOrigin` is `http://localhost:5173`.
    const res = await request(app)
      .get('/api/v10/whatever')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('AC-3: internal routes are untouched by the v1 request-id/CORS middleware', async () => {
    // An existing internal route guarded by authMiddleware
    // (api/src/middleware/auth.ts), requested with no session cookie and no
    // bearer token.
    const res = await request(app).get('/api/documents');

    expect(res.status).toBe(401);
    // The PRE-EXISTING internal auth-failure shape (authMiddleware, "No
    // session found" branch) — NOT the future v1 ApiError shape from §2.5
    // ({ code, message, details?, request_id } with no `success` wrapper).
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'No session found',
      },
    });
    expect(res.body.request_id).toBeUndefined();
    expect(res.body.code).toBeUndefined();
    // The v1 request-id middleware is mounted only on /api/v1 and /oauth —
    // an internal route must not carry its header.
    expect(res.headers['x-request-id']).toBeUndefined();
  });
});
