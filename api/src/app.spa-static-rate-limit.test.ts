/**
 * TRO-308 (js/missing-rate-limiting, app.ts:440 on main) — regression
 * coverage for the SPA static-file/catch-all rate-limit gap.
 *
 * The defect: `app.ts`'s "Static SPA (single-origin deployments)" section
 * (`express.static(webDist, ...)` + `app.get('*', ...)`) is mounted OUTSIDE
 * the `/api/` prefix `perSourceIpLimiter`/`perIdentityLimiter` cover, and had
 * no rate-limit coverage of its own. It only activates when `web/dist` exists
 * on disk (`existsSync(webDist)`), which is never true in local dev/test —
 * exactly why the previous rate-limiting ticket (TRO-307), and every other
 * test in this suite, never exercised this code path.
 *
 * This file builds a minimal fake `web/dist` (a directory with an
 * `index.html`) so `createApp()`'s static-file branch actually activates,
 * then proves `createSpaStaticLimiter` (see its doc in
 * `middleware/rate-limit.ts`) really throttles that route — not just that a
 * limiter object exists somewhere in `app.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'http';
import type { Express } from 'express';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveSpaStaticLimit } from './middleware/rate-limit.js';

// Mirrors the exact join app.ts uses to locate web/dist (this file lives in
// the same directory, api/src, as app.ts).
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const indexHtmlPath = join(webDist, 'index.html');
const INDEX_HTML_MARKER = 'TRO-308-SPA-STATIC-RATE-LIMIT-TEST-FIXTURE';

// Test-tier limit, read from the same function app.ts uses to build the real
// limiter — not hardcoded here, so this test can't silently drift from the
// production code it is exercising.
const { limit: TEST_TIER_LIMIT } = resolveSpaStaticLimit({ NODE_ENV: 'test' });

let ownsDistDir = false;
let ownsIndexHtml = false;

beforeAll(() => {
  if (!existsSync(webDist)) {
    mkdirSync(webDist, { recursive: true });
    ownsDistDir = true;
  }
  if (!existsSync(indexHtmlPath)) {
    writeFileSync(indexHtmlPath, `<!doctype html><html><body>${INDEX_HTML_MARKER}</body></html>`);
    ownsIndexHtml = true;
  }
});

afterAll(() => {
  // Only remove what THIS file created. If web/dist already existed (e.g. a
  // real `pnpm build:web` ran earlier, as gate.sh's full build step does),
  // leave it alone rather than destroying a real build other steps rely on.
  if (ownsDistDir) {
    rmSync(webDist, { recursive: true, force: true });
  } else if (ownsIndexHtml) {
    rmSync(indexHtmlPath, { force: true });
  }
});

/**
 * Loads a fresh copy of `app.ts` via `vi.resetModules()`. The module-scope
 * `spaStaticLimiter` (a `MemoryStore`-backed counter, same as
 * `perSourceIpLimiter`/`perIdentityLimiter`) is a singleton for the life of
 * one module load — a plain re-call of `createApp()` without resetting
 * modules would share the SAME running count across tests, and the
 * "429 at request N" assertions below would silently depend on test
 * execution order. Each test that cares about an exact count gets its own
 * zeroed counter instead.
 *
 * No CAIA mock needed here (unlike `app.test.ts`'s / `rate-limit-
 * coverage.test.ts`'s helpers of the same shape): those force
 * `NODE_ENV=production`, which routes CAIA startup discovery to AWS Secrets
 * Manager. This suite stays on the ambient test `NODE_ENV`, same as
 * `rate-limit.test.ts`'s "keying" test, which also calls `createApp()`
 * directly with no CAIA mock.
 */
async function loadFreshApp(): Promise<Express> {
  vi.resetModules();
  const { createApp } = await import('./app.js');
  return createApp();
}

/**
 * Binds one server per test instead of letting `request(app)` bind a
 * throwaway server per call — TEST-12 / TRO-277 identified ephemeral-port
 * churn as this suite's most frequent source of flakiness under concurrent
 * build load. Mirrors the same helper shape used in rate-limit.test.ts /
 * rate-limit-coverage.test.ts.
 */
function bindServer(app: Express): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('TRO-308: SPA static-file/catch-all route is rate-limited', () => {
  it('confirms the fake web/dist actually activated the static-SPA branch', async () => {
    // Sanity check on the test fixture itself, not the fix: if this fails,
    // every other assertion in this file is meaningless (createApp() fell
    // back to its no-op branch instead of mounting the static section).
    const server = await bindServer(await loadFreshApp());
    try {
      const res = await request(server).get('/some-app-page');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      // Only assert on OUR fixture's exact content when we actually wrote
      // index.html ourselves (see beforeAll). Under a full `gate.sh` run,
      // `pnpm build` builds a REAL web/dist before tests run, so this file
      // finds a real index.html already there and — correctly — leaves it
      // alone rather than clobbering a real build (see the afterAll
      // cleanup's ownership check). The status/content-type assertions
      // above are still a genuine proof the static-SPA branch activated
      // (Express's default 404 JSON handler would not produce either).
      if (ownsIndexHtml) {
        expect(res.text).toContain(INDEX_HTML_MARKER);
      }
    } finally {
      await closeServer(server);
    }
  });

  /**
   * RED BEFORE / GREEN AFTER: against the commit this ticket started from
   * (no `spaStaticLimiter` mounted in the static-SPA block), this request
   * loop never sees a 429 — the route had no rate limiter at all, so it
   * served every request. After the fix, request #(TEST_TIER_LIMIT + 1) is
   * throttled.
   */
  it('returns 429 once the per-source-IP static-file budget is exceeded', async () => {
    const server = await bindServer(await loadFreshApp());
    try {
      const statuses: number[] = [];
      let throttledAt: number | null = null;
      let throttledBody: unknown;

      for (let i = 0; i < TEST_TIER_LIMIT + 5; i++) {
        const res = await request(server).get(`/some-app-page?i=${i}`);
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

      // Everything before the throttle point succeeded; nothing before it
      // was already the wrong shape (e.g. a 500 masquerading as "not yet
      // limited").
      expect(statuses.slice(0, TEST_TIER_LIMIT)).toEqual(new Array(TEST_TIER_LIMIT).fill(200));
    } finally {
      await closeServer(server);
    }
  });

  /**
   * The SPA static limiter is a SEPARATE bucket from perSourceIpLimiter /
   * perIdentityLimiter (see createSpaStaticLimiter's doc in
   * middleware/rate-limit.ts for why). Exhausting the static-file budget
   * from this test's source IP must not throttle unrelated `/api/*` traffic
   * from the same IP — otherwise a page-load flood would take the API down
   * with it, which is exactly the cross-contamination a separate bucket
   * exists to prevent.
   */
  it('does not throttle /api/* traffic once the static-file budget is exhausted', async () => {
    const server = await bindServer(await loadFreshApp());
    try {
      // Exhaust the static-file budget first.
      for (let i = 0; i < TEST_TIER_LIMIT; i++) {
        await request(server).get(`/some-app-page?warm=${i}`);
      }
      const exhausted = await request(server).get('/some-app-page?warm=final');
      expect(exhausted.status, 'setup failed: static-file budget was not actually exhausted').toBe(429);

      const res = await request(server).get('/api/csrf-token');
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});
