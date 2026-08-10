import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../app.js';
import { v1Routes } from '../router.js';
import { asyncHandler } from '../errorMiddleware.js';

/**
 * PF-002 — `/api/v1` error middleware (PLUGFORGE.MD §2.5, §4). Test design:
 * ship-test-designer, Linear TRO-397 comment, 2026-08-10, "AC-2"/"AC-3".
 *
 * Scratch routes are attached to `v1Routes` (not `v1Router` directly) — see
 * `router.ts`'s stack-order comment for why that split exists: routes on
 * `v1Routes` are tried before the terminal `notFoundHandler`/`errorMiddleware`
 * regardless of when they are registered relative to `router.ts`'s own
 * top-level code, which is what makes attaching them from a test file (after
 * the module has already been imported) actually reachable.
 */
describe('PF-002: /api/v1 error middleware', () => {
  const app = createApp();

  it('AC-2: an unmatched /api/v1 route produces the exact §2.5 not_found shape', async () => {
    const res = await request(app).get('/api/v1/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBe('not_found');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.request_id.length).toBeGreaterThan(0);
    // request_id in the body must be the SAME id PF-001's middleware put on
    // the response header — the dispatch brief: "every failure path carries
    // request_id (PF-001's middleware provides it)".
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
  });

  it('AC-3: a thrown error on a v1 route produces the §2.5 server_error shape, with no stack/SQL leaked', async () => {
    // Scratch-only route: never a real resource, exists purely to exercise
    // the "thrown-error path" AC. Prefixed so it can never collide with a
    // real /api/v1 resource path a later ticket adds.
    v1Routes.get('/__pf002_test_throws_sync', () => {
      throw new Error('leaked stack: SELECT * FROM users');
    });

    const res = await request(app).get('/api/v1/__pf002_test_throws_sync');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBe('server_error');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.request_id).toBe(res.headers['x-request-id']);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('SELECT');
    expect(raw).not.toContain('leaked stack');
    expect(raw).not.toContain('.ts:'); // a stack-frame file:line marker
    expect(raw).not.toContain(' at '); // a stack-frame "  at fn (...)" marker
  });

  it('additional coverage: a REJECTED promise on an async v1 route also produces the sanitized server_error shape', async () => {
    // Not one of the test-design comment's two specified cases (which use a
    // synchronous throw) — additive coverage for `asyncHandler`
    // (`errorMiddleware.ts`). Express 4 (this repo's version) only
    // auto-forwards a *synchronous* throw inside a route handler to
    // `next(err)`; a rejected promise from an `async` handler is not caught
    // automatically, which is why `asyncHandler` exists at all and why every
    // real, DB-backed `/api/v1` route a later ticket adds will need it.
    v1Routes.get(
      '/__pf002_test_throws_async',
      asyncHandler(async () => {
        throw new Error('leaked stack: SELECT * FROM users (async)');
      })
    );

    const res = await request(app).get('/api/v1/__pf002_test_throws_async');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('server_error');
    expect(typeof res.body.request_id).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('SELECT');
  });
});
