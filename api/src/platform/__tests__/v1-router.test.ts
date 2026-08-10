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
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://example.com');

    expect(res.status).toBe(200);
    // Default PUBLIC_API_CORS_ORIGIN (unset in this test run) resolves to
    // '*' — any origin is allowed.
    expect(res.headers['access-control-allow-origin']).toBeDefined();
    // Public CORS is deliberately credentials: false (§2.1) — there is no
    // cookie for this header to protect, and setting it would misstate what
    // the public API authenticates with.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
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
