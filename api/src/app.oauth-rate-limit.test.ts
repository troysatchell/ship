/**
 * TRO-588 — regression coverage for `/oauth/*`'s missing rate-limit gap.
 *
 * The defect: `/oauth/authorize`, `/oauth/token`, `/oauth/device/*`
 * (PF-103/104/106) sat outside both the legacy `/api/` limiters
 * (`perSourceIpLimiter`/`perIdentityLimiter` mount only on `/api/`,
 * `app.ts:375-376`) and PF-500's `/api/v1`-only buckets — genuinely zero
 * rate-limit coverage, confirmed by reading `app.ts`'s mount points before
 * writing this fix, not assumed from the ticket's own description.
 *
 * Same structure as `app.spa-static-rate-limit.test.ts` (TRO-308): loads the
 * real `createApp()` wiring via `vi.resetModules()` so each test gets a
 * fresh, zeroed `MemoryStore` counter, and proves the limiter mounted in
 * production code actually throttles — not just that `createOAuthRateLimiter`
 * works as a standalone function. Requests target an unmatched `/oauth/*`
 * path rather than a real OAuth route: `app.use('/oauth', oauthRateLimiter)`
 * is mounted ahead of all three OAuth routers, so it counts every `/oauth/*`
 * request regardless of whether a route eventually matches — this isolates
 * the limiter's own behavior from OAuth business logic (DB writes, PKCE
 * validation, etc.), same isolation principle as the SPA-static test hitting
 * a static file rather than exercising app logic.
 */
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'http';
import type { Express } from 'express';
import { resolveOAuthRateLimit } from './middleware/rate-limit.js';

// Test-tier limit, read from the same function app.ts uses to build the real
// limiter — not hardcoded here, so this test can't silently drift from the
// production code it exercises.
const { limit: TEST_TIER_LIMIT } = resolveOAuthRateLimit({ NODE_ENV: 'test' });

/** Mirrors app.spa-static-rate-limit.test.ts's loadFreshApp() exactly. */
async function loadFreshApp(): Promise<Express> {
  vi.resetModules();
  const { createApp } = await import('./app.js');
  return createApp();
}

function bindServer(app: Express): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('TRO-588: /oauth/* is rate-limited', () => {
  /**
   * RED BEFORE / GREEN AFTER: against the commit this ticket started from
   * (no oauthRateLimiter mounted anywhere in app.ts), this loop never saw a
   * 429 — /oauth/* had no rate limiter at all, every request reached the
   * unmatched-route 404 handler. After the fix, request #(TEST_TIER_LIMIT+1)
   * is throttled instead.
   */
  it('returns 429 once the /oauth per-source-IP budget is exceeded', async () => {
    const server = await bindServer(await loadFreshApp());
    try {
      const statuses: number[] = [];
      let throttledAt: number | null = null;
      let throttledBody: unknown;

      for (let i = 0; i < TEST_TIER_LIMIT + 5; i++) {
        const res = await request(server).get(`/oauth/tro-588-fixture-route?i=${i}`);
        statuses.push(res.status);
        if (res.status === 429 && throttledAt === null) {
          throttledAt = statuses.length;
          throttledBody = res.body;
        }
      }

      expect(
        throttledAt,
        `never saw a 429 in ${statuses.length} requests; last statuses: ${statuses.slice(-5).join(', ')}`
      ).not.toBeNull();
      expect(throttledAt).toBe(TEST_TIER_LIMIT + 1);
      expect(throttledBody).toMatchObject({
        error: expect.stringContaining('Too many requests'),
      });

      // Everything before the throttle point reached the unmatched-route 404
      // handler (proving the limiter itself, not some other failure, is what
      // changes at the throttle point).
      expect(statuses.slice(0, TEST_TIER_LIMIT)).toEqual(new Array(TEST_TIER_LIMIT).fill(404));
    } finally {
      await closeServer(server);
    }
  });

  /**
   * The /oauth limiter is a SEPARATE bucket from perSourceIpLimiter/
   * perIdentityLimiter and from spaStaticLimiter (own Redis prefix,
   * REDIS_KEY_PREFIX_OAUTH — see createOAuthRateLimiter's doc). Exhausting
   * it from this test's source IP must not throttle unrelated /api/* traffic
   * — a device-login polling flood should never be able to take the whole
   * API down with it.
   */
  it('does not throttle /api/* traffic once the /oauth budget is exhausted', async () => {
    const server = await bindServer(await loadFreshApp());
    try {
      for (let i = 0; i < TEST_TIER_LIMIT; i++) {
        await request(server).get(`/oauth/tro-588-fixture-route?warm=${i}`);
      }
      const exhausted = await request(server).get('/oauth/tro-588-fixture-route?warm=final');
      expect(exhausted.status, 'setup failed: /oauth budget was not actually exhausted').toBe(429);

      const res = await request(server).get('/api/csrf-token');
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  /**
   * The limiter is mounted on the bare `/oauth` prefix, ahead of all three
   * routers (authorize, token, device) — proves it covers a route on a
   * DIFFERENT one of those three routers than the fixture path above
   * exercises implicitly, so the mount isn't accidentally scoped to only
   * the first-registered router.
   */
  it('also covers /oauth/device/code, not just the bare /oauth prefix', async () => {
    const server = await bindServer(await loadFreshApp());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < TEST_TIER_LIMIT + 1; i++) {
        const res = await request(server).post('/oauth/device/code').send({});
        statuses.push(res.status);
      }
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.slice(0, TEST_TIER_LIMIT).every((s) => s !== 429)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});
