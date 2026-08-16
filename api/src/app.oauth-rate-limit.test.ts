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
 * TWO test strategies, same split as `rate-limit-v1-exemption.test.ts`'s
 * "prod-shaped app" vs. "isolated small-cap app" distinction:
 *
 *  - The 429-driving tests below build a MINIMAL standalone Express app
 *    mounting `createOAuthRateLimiter` directly with an explicit small
 *    `limitOverrides.limit` (the same `limitOverrides` seam TRO-494 added to
 *    `createApiRateLimiters` for the identical reason) — NOT the real
 *    `createApp()`. The ambient test tier (`resolveOAuthRateLimit`'s
 *    `isTestEnv` branch) is deliberately permissive (10,000), because
 *    `platform/oauth/__tests__/token.test.ts` alone drives dozens of real
 *    `/oauth/token` requests through one shared app instance across its
 *    `it()` blocks — a small ambient test-tier cap here previously made
 *    THOSE unrelated tests start failing with 429s partway through the
 *    file, caught by a full `gate.sh` run (see CHANGES.md's TRO-588 entry).
 *  - `confirms the real app wiring actually mounts the limiter` uses the
 *    real `createApp()` (via `vi.resetModules()`, same pattern as
 *    `app.spa-static-rate-limit.test.ts`) and checks for the
 *    `express-rate-limit`-set `RateLimit-Limit` response header instead of
 *    exhausting the (now permissive) real limit — proving the middleware is
 *    actually wired into production `app.ts`, not just that the standalone
 *    function works in isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { createOAuthRateLimiter } from './middleware/rate-limit.js';

/**
 * Small, explicitly-overridden cap — see this file's header for why the
 * ambient test tier itself must stay permissive. 5 is arbitrary but small
 * (fast test) and matches `rate-limit-v1-exemption.test.ts`'s own
 * `SOURCE_IP_TEST_CAP` precedent for the identical kind of seam.
 */
const SMALL_CAP = 5;

function buildIsolatedOAuthApp(): Express {
  const app = express();
  app.use('/oauth', createOAuthRateLimiter({ NODE_ENV: 'test' }, undefined, { limit: SMALL_CAP }));
  // Two routes standing in for two of the three real /oauth-mounted
  // routers, proving the limiter (mounted once, on the bare /oauth prefix)
  // covers both rather than being accidentally scoped to whichever route
  // happens to be registered first.
  app.get('/oauth/authorize', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/oauth/device/code', (_req, res) => res.status(200).json({ ok: true }));
  return app;
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
   * (no oauthRateLimiter mounted anywhere in app.ts), a loop like this never
   * saw a 429 — /oauth/* had no rate limiter at all. Verified directly this
   * session: `git stash`-ing just the app.ts mount change and re-running
   * this suite's shape (before the limitOverrides rework) reproduced exactly
   * that — every request reached the route handler, never a 429.
   */
  it('returns 429 once the /oauth per-source-IP budget is exceeded', async () => {
    const server = await bindServer(buildIsolatedOAuthApp());
    try {
      const statuses: number[] = [];
      let throttledAt: number | null = null;
      let throttledBody: unknown;

      for (let i = 0; i < SMALL_CAP + 5; i++) {
        const res = await request(server).get(`/oauth/authorize?i=${i}`);
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
      expect(throttledAt).toBe(SMALL_CAP + 1);
      expect(throttledBody).toMatchObject({
        error: expect.stringContaining('Too many requests'),
      });
      expect(statuses.slice(0, SMALL_CAP)).toEqual(new Array(SMALL_CAP).fill(200));
    } finally {
      await closeServer(server);
    }
  });

  /**
   * Proves the limiter is mounted once on the bare `/oauth` prefix — ahead
   * of every router — not accidentally scoped to only the first-registered
   * route. `/oauth/device/code` stands in for a different one of the three
   * real routers than the fixture above exercises.
   */
  it('also throttles /oauth/device/code, not just the first-registered route', async () => {
    const server = await bindServer(buildIsolatedOAuthApp());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < SMALL_CAP + 1; i++) {
        const res = await request(server).post('/oauth/device/code').send({});
        statuses.push(res.status);
      }
      expect(statuses.at(-1)).toBe(429);
      expect(statuses.slice(0, SMALL_CAP).every((s) => s === 200)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  /**
   * The /oauth limiter is a SEPARATE bucket from perSourceIpLimiter/
   * perIdentityLimiter and from spaStaticLimiter (own Redis prefix,
   * REDIS_KEY_PREFIX_OAUTH — see createOAuthRateLimiter's doc). Exhausting
   * it from this test's source IP must not throttle unrelated traffic on a
   * different prefix — a device-login polling flood should never be able to
   * take an unrelated route down with it.
   */
  it('does not throttle an unrelated prefix once the /oauth budget is exhausted', async () => {
    const app = buildIsolatedOAuthApp();
    app.get('/unrelated', (_req, res) => res.status(200).json({ ok: true }));
    const server = await bindServer(app);
    try {
      for (let i = 0; i < SMALL_CAP; i++) {
        await request(server).get(`/oauth/authorize?warm=${i}`);
      }
      const exhausted = await request(server).get('/oauth/authorize?warm=final');
      expect(exhausted.status, 'setup failed: /oauth budget was not actually exhausted').toBe(429);

      const res = await request(server).get('/unrelated');
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  /**
   * Confirms createOAuthRateLimiter is actually mounted in the REAL app.ts
   * wiring, not just that the standalone function works — same "loads a
   * fresh copy of the real app" approach as app.spa-static-rate-limit.test.ts.
   * Uses the ambient (permissive, 10,000) test tier deliberately: this test
   * only needs to see the limiter's own response headers on one request, not
   * exhaust it, which is what keeps this file from re-introducing the exact
   * cross-test-file interference this ticket's own CHANGES.md entry
   * describes finding and fixing.
   */
  it('confirms the real app wiring actually mounts the limiter', async () => {
    vi.resetModules();
    const { createApp } = await import('./app.js');
    const server = await bindServer(createApp());
    try {
      const res = await request(server).get('/oauth/authorize');
      // express-rate-limit's standardHeaders: true sets these on every
      // response that passed through it, 429 or not — their presence alone
      // proves the middleware ran, regardless of the route's own status.
      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers).toHaveProperty('ratelimit-remaining');
    } finally {
      await closeServer(server);
    }
  });
});
