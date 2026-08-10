/**
 * PF-004 / TRO-401 — the legacy `/api/` rate limiters (API-1 / TRO-172,
 * `rate-limit.ts`) mount via `app.use('/api/', ...)` in `app.ts:328-329`, so
 * `/api/v1/*` inherits both the per-source-IP flood ceiling and the
 * per-identity budget. PF-500's per-app/per-token buckets are meant to govern
 * `/api/v1` instead, so this ticket exempts the public router from the two
 * legacy limiters while leaving every internal `/api/*` route capped exactly
 * as before.
 *
 * PATH SHAPE, VERIFIED (not assumed) before writing the skip predicate:
 * probed a throwaway Express app with `app.use('/api/', mw)` and requested
 * `/api/v1/health` — inside `mw`, `req.path` is `/v1/health` and
 * `req.baseUrl` is `/api`; Express strips the mount prefix before the
 * middleware ever sees the request. `/api/v10/x` -> `/v10/x`,
 * `/api/v1foo/x` -> `/v1foo/x`. The skip predicate in `rate-limit.ts`
 * therefore matches the MOUNT-RELATIVE `/v1` shape, not `/api/v1` — and must
 * be segment-boundary-safe (`/v1` or `/v1/...`, never a bare `startsWith`)
 * so `/v10` and `/v1foo` are never accidentally exempted. Mirrors the
 * app-global CORS guard's `isPublicSurfacePath` (PF-001, `app.ts:375-376`),
 * which does the equivalent check one layer up where `req.path` is still
 * `/api/v1/...` (unmounted, root-level middleware).
 *
 * PROD-SHAPED, not test-env defaults: `createApiRateLimiters({NODE_ENV:
 * 'production'})` resolves `identityLimit: 600`, `sourceIpLimit: 6000`,
 * `windowMs: 60_000` (`rate-limit.ts:130-132`). The AC is explicit that a
 * sequential-request test under test-env defaults (10,000 / 100,000) proves
 * nothing — every hammer below runs against those exact production numbers.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createServer, type Server } from 'http'
import { createApiRateLimiters } from '../rate-limit.js'
import { v1Router } from '../../platform/api/v1/router.js'

/** Session ids are 64 lowercase hex chars (`crypto.randomBytes(32).toString('hex')`). */
const sessionIdLike = (fill: string) => fill.repeat(64).slice(0, 64)

/** One past the production per-identity budget (600, rate-limit.ts:131). */
const REQUESTS_PAST_IDENTITY_LIMIT = 601

/**
 * Mirrors `app.ts:328-330`'s exact prefix-mount shape: both legacy limiters
 * mounted at `/api/`, then the real `v1Router` mounted at `/api/v1` — plus
 * one bare internal `/api/*` route standing in for the ~30 routers app.ts
 * mounts there, so AC-2 has an internal target to hammer.
 */
function buildProdShapedApp(): Express {
  const app = express()
  const [perSourceIpLimiter, perIdentityLimiter] = createApiRateLimiters({ NODE_ENV: 'production' })
  app.use('/api/', perSourceIpLimiter)
  app.use('/api/', perIdentityLimiter)
  app.use('/api/v1', v1Router)
  app.get('/api/internal-example', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

/**
 * Sequentially issues `count` requests on one bound server / one session
 * key. Binding once (rather than letting `supertest(app)` bind a throwaway
 * server per call) avoids the ephemeral-port churn TEST-12 identified as
 * this suite's most frequent source of flakiness under concurrent build
 * load (see the identical pattern in `rate-limit-coverage.test.ts`).
 */
async function hammer(
  app: Express,
  path: string,
  sessionId: string,
  count: number
): Promise<{ status: number; body: unknown }[]> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const responses: { status: number; body: unknown }[] = []
  try {
    for (let i = 0; i < count; i++) {
      const res = await request(server).get(path).set('Cookie', `session_id=${sessionId}`)
      responses.push({ status: res.status, body: res.body })
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return responses
}

describe('PF-004 / TRO-401: /api/v1 exemption from the legacy /api/ limiters', () => {
  it('AC-1: v1 requests bypass both legacy limiters past the prod identity cap', async () => {
    const app = buildProdShapedApp()
    const sessionId = sessionIdLike('1')

    const responses = await hammer(app, '/api/v1/health', sessionId, REQUESTS_PAST_IDENTITY_LIMIT)

    const throttled = responses.filter((r) => r.status === 429)
    expect(
      throttled.length,
      `expected 0/${responses.length} throttled responses to /api/v1/health, got ${throttled.length}`
    ).toBe(0)
    // Confirm the request actually reached the route rather than failing some
    // other way that would also produce "no 429".
    expect(responses.every((r) => r.status === 200)).toBe(true)
  }, 30_000)

  it('AC-2: internal /api/ routes remain capped at the prod identity limit, with the unchanged legacy 429 shape', async () => {
    const app = buildProdShapedApp()
    const sessionId = sessionIdLike('2')

    const responses = await hammer(app, '/api/internal-example', sessionId, REQUESTS_PAST_IDENTITY_LIMIT)

    const throttledIndex = responses.findIndex((r) => r.status === 429)
    expect(
      throttledIndex,
      `never saw a 429 in ${responses.length} requests to /api/internal-example — an over-wide /api/v1 exemption would produce exactly this symptom`
    ).not.toBe(-1)
    expect(throttledIndex + 1).toBe(REQUESTS_PAST_IDENTITY_LIMIT)

    // The existing legacy limiter shape (rate-limit.ts's perIdentityLimiter
    // `message` option) — NOT the new v1 ApiError §2.5 shape
    // ({ code, message, details?, request_id }) — proving the exemption did
    // not leak into internal routes. `toEqual` on an exact object already
    // rejects any extra key (so it subsumes a separate `not.toHaveProperty`
    // check on `code`/`request_id`), and needs no cast off `unknown` — no
    // `as` conversion, per this repo's ban on decoupling a test from the
    // response shape it claims to verify (lessons.md rule 16 / TS-8).
    expect(responses[throttledIndex]?.body).toEqual({ error: 'Too many requests. Please slow down.' })
  }, 30_000)
})
