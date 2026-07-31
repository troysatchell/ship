/**
 * TRO-307 — CodeQL `js/missing-rate-limiting` reports 352 open alerts (as of
 * 2026-07-31, via `gh api repos/troysatchell/ship/code-scanning/alerts`)
 * across nearly every file in `api/src/routes/`, including 18 in
 * `weekly-plans.ts`, 50 in `weeks.ts`, 24 in `admin.ts`, and 6 in `search.ts`
 * — the four files this ticket names.
 *
 * INVESTIGATION FINDING, stated plainly because it changes what "the fix" is:
 * every one of those routes is mounted under `/api/`, and `api/src/app.ts`
 * has applied `createApiRateLimiters()`'s two limiters to every `/api/*`
 * request since TRO-172 (commit 9aa2d1c) — before any of these CodeQL alerts
 * were raised. This is OBSERVED, not inferred from the alert text: the
 * "production ceiling" describe block below hammers one flagged route per
 * named file past the documented production `identityLimit` (600,
 * `rate-limit.ts:118`) on the CURRENT code (no code change needed to make
 * these pass — they already pass on `main`) and gets HTTP 429 back at
 * request #601 every time.
 *
 * So the ticket's premise — "these routes previously had [no rate limiting]"
 * — does not hold at the level of "does a request past the limit get
 * throttled." What's real is that CodeQL's static analysis doesn't credit
 * this app-level chain: `api/src/app.ts` built the limiter array in a
 * different file (`middleware/rate-limit.ts`) via `createApiRateLimiters()`
 * and mounted it with `app.use('/api/', ...apiLimiters)` — a spread of a
 * function's return value into a variadic call, one file removed from the
 * `rateLimit()` calls that produced it. That is a DERIVED explanation, not
 * verified against the actual CodeQL query (no `codeql` CLI is available in
 * this environment to test it directly) — but it is the shape TRO-307's fix
 * removes: two explicit, non-spread `app.use('/api/', <limiter>)` calls in
 * `app.ts`, functionally identical (proven by every pre-existing test in
 * `rate-limit.test.ts` and `app.test.ts` passing unchanged).
 *
 * The "mounts via explicit non-spread app.use calls" describe block below IS
 * genuine red-before-green: it read `main`'s `app.ts` (spread present,
 * explicit per-limiter `app.use` calls absent) and failed for the right
 * reason before this ticket's app.ts edit, and passes after it.
 *
 * The "production ceiling" describe block is a PIN, not red-before-green —
 * same category as the TRO-302 tests lower in `rate-limit.test.ts`: it
 * documents and protects behavior that was already correct, so a future
 * change (e.g. someone "simplifying" app.ts back to a spread, or narrowing
 * the `/api/` mount to miss one of these routers) cannot silently remove
 * protection CodeQL — rightly or wrongly — is watching for.
 */
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createServer, type Server } from 'http'
import type { Express } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_TS_PATH = join(__dirname, '../../app.ts')

/** Session ids are 64 lowercase hex chars (`crypto.randomBytes(32).toString('hex')`). */
const sessionIdLike = (fill: string) => fill.repeat(64).slice(0, 64)

/**
 * Load a fresh copy of the app with NODE_ENV forced, because the limiter's
 * `max` is resolved once at module load. Mirrors `loadAppWithNodeEnv` in
 * `rate-limit.test.ts` — duplicated rather than imported/exported because
 * that helper is a private fixture of a different finding's test file (API-1
 * / TRO-172), and this finding (TRO-307) should not have to change that
 * file's exports to get a copy of it.
 */
async function loadAppWithNodeEnv(nodeEnv: string): Promise<Express> {
  const prevNodeEnv = process.env.NODE_ENV
  const prevSecret = process.env.SESSION_SECRET
  process.env.NODE_ENV = nodeEnv
  process.env.SESSION_SECRET = prevSecret ?? 'tro-307-regression-only-secret'
  vi.resetModules()
  vi.doMock('../../services/caia.js', () => ({
    initializeCAIA: async () => {},
    isCAIAConfigured: async () => false,
  }))
  try {
    const { createApp } = await import('../../app.js')
    return createApp()
  } finally {
    process.env.NODE_ENV = prevNodeEnv
    if (prevSecret === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = prevSecret
    vi.doUnmock('../../services/caia.js')
    vi.resetModules()
  }
}

/**
 * Sequentially requests one route until a 429 arrives or `maxRequests` is
 * exhausted, on one bound server / one session key. Binding once (rather than
 * letting `supertest(app)` bind a throwaway server per call) avoids the
 * ephemeral-port churn TEST-12 identified as this suite's most frequent
 * source of flakiness under concurrent build load.
 */
async function hammerUntilThrottled(
  app: Express,
  path: string,
  sessionId: string,
  maxRequests: number
): Promise<{ statuses: number[]; throttledAt: number | null; server: Server }> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const statuses: number[] = []
  let throttledAt: number | null = null
  for (let i = 0; i < maxRequests; i++) {
    const res = await request(server).get(path).set('Cookie', `session_id=${sessionId}`)
    statuses.push(res.status)
    if (res.status === 429) {
      throttledAt = statuses.length
      break
    }
  }
  return { statuses, throttledAt, server }
}

describe('TRO-307: /api rate-limiter application is CodeQL-legible', () => {
  describe('app.ts mounts via explicit non-spread app.use calls (red-before-green)', () => {
    it('does not spread the limiter array into app.use(\'/api/\', ...)', () => {
      const source = readFileSync(APP_TS_PATH, 'utf8')

      // The anti-pattern this ticket removes: `app.use('/api/', ...apiLimiters)`.
      // A spread of any identifier directly into this specific mount call is
      // exactly the shape that made the limiter's origin (a `rateLimit()` call
      // in a different file, returned as an array) opaque to static analysis.
      const spreadIntoApiMount = /app\.use\(\s*['"]\/api\/['"]\s*,\s*\.\.\./
      expect(
        spreadIntoApiMount.test(source),
        'app.ts should not mount the /api/ rate limiters via a spread of an array — see the TRO-307 comment above perSourceIpLimiter in app.ts'
      ).toBe(false)
    })

    it('mounts both limiters as two explicit, individually named app.use(\'/api/\', ...) calls', () => {
      const source = readFileSync(APP_TS_PATH, 'utf8')

      // Two separate statements, not one call with two arguments — so each
      // mount site textually names one rate limiter with no indirection
      // between "the app.use call" and "the identifier it applies".
      expect(source).toMatch(/app\.use\(\s*['"]\/api\/['"]\s*,\s*perSourceIpLimiter\s*\)/)
      expect(source).toMatch(/app\.use\(\s*['"]\/api\/['"]\s*,\s*perIdentityLimiter\s*\)/)
    })
  })

  describe('production ceiling already covers the routes CodeQL flagged (pin, not red-before-green)', () => {
    // 601: one past the documented production identityLimit of 600
    // (rate-limit.ts:118 / MEASURED_WORST_CASE_BURST_PER_MINUTE-derived ceiling).
    const REQUESTS_PAST_LIMIT = 601

    it.each([
      // One representative flagged route per file this ticket names, matching
      // a CodeQL alert's exact reported line.
      { file: 'weekly-plans.ts:329', path: '/api/weekly-plans' },
      { file: 'weeks.ts:587', path: '/api/weeks' },
      { file: 'admin.ts:14', path: '/api/admin/workspaces' },
      { file: 'search.ts:17', path: '/api/search/mentions' },
    ])(
      'GET $path ($file) returns 429 once the production identity budget is exceeded',
      async ({ path }) => {
        const app = await loadAppWithNodeEnv('production')
        const sessionId = sessionIdLike(path.length % 10 === 0 ? '1' : '2')
        const { statuses, throttledAt, server } = await hammerUntilThrottled(
          app,
          path,
          sessionId,
          REQUESTS_PAST_LIMIT
        )
        try {
          expect(
            throttledAt,
            `never saw a 429 in ${statuses.length} requests to ${path}; last statuses: ${statuses.slice(-5).join(', ')}`
          ).not.toBeNull()
          expect(throttledAt).toBe(601)
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
      },
      30_000
    )
  })
})
