/**
 * TRO-172 / audit finding API-1 — regression tests for the `/api` rate limiter.
 *
 * The defect: `apiLimiter` allowed 100 requests per 60 s **per IP** in production
 * while the SPA issues 4-16 XHRs per navigation, and `trust proxy 1` behind
 * CloudFront collapses every user sharing an agency NAT egress into one key.
 * The audit measured 511,872 responses / 100% HTTP 429 / zero 2xx at c=10.
 *
 * The configuration under test is the PRODUCTION one. `apiLimiter` resolves a
 * different `max` for test (10,000) and dev (1,000), so a check run under
 * NODE_ENV=test proves nothing about production — hence `loadAppWithNodeEnv`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'
import type { Express, Request } from 'express'
import {
  apiRateLimitKey,
  createApiRateLimiters,
  readSessionIdCookie,
  resolveApiRateLimits,
} from '../rate-limit.js'

/**
 * Worst realistic single-user burst, derived from the audit's browser trace:
 * the heaviest flow (login) costs 16 `/api` requests, and a user navigating
 * every 3 s performs 20 navigations per minute. 16 x 20 = 320 req/min.
 */
const WORST_CASE_BURST_PER_MINUTE = 320

/**
 * Upper bound, so "raise the ceiling" can never be quietly turned into
 * "remove the limiter". A per-identity budget above this is not a rate limit.
 */
const SANE_CEILING_PER_MINUTE = 5000

/** Session ids are 64 lowercase hex chars (`crypto.randomBytes(32).toString('hex')`). */
const sessionIdLike = (fill: string) => fill.repeat(64).slice(0, 64)

/**
 * Load a fresh copy of the app with NODE_ENV forced, because the limiter's
 * `max` is resolved once at module load. CAIA startup discovery is stubbed: it
 * reaches AWS Secrets Manager when NODE_ENV=production and is irrelevant here.
 */
async function loadAppWithNodeEnv(nodeEnv: string): Promise<Express> {
  const prevNodeEnv = process.env.NODE_ENV
  const prevSecret = process.env.SESSION_SECRET
  process.env.NODE_ENV = nodeEnv
  process.env.SESSION_SECRET = prevSecret ?? 'tro-172-regression-only-secret'
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

describe('API-1: /api rate limiter', () => {
  describe('production ceiling', () => {
    let prodApp: Express

    beforeAll(async () => {
      prodApp = await loadAppWithNodeEnv('production')
    })

    it('advertises a per-minute budget that covers a realistic navigation burst', async () => {
      const res = await request(prodApp).get('/api/csrf-token')

      expect(res.status).toBe(200)
      const limit = Number(res.headers['ratelimit-limit'])
      expect(Number.isFinite(limit)).toBe(true)
      expect(limit).toBeGreaterThanOrEqual(WORST_CASE_BURST_PER_MINUTE)
      expect(limit).toBeLessThanOrEqual(SANE_CEILING_PER_MINUTE)
    })

    it('serves a realistic navigation burst with zero 429s', async () => {
      const statuses: number[] = []
      for (let i = 0; i < WORST_CASE_BURST_PER_MINUTE; i++) {
        const res = await request(prodApp)
          .get('/api/csrf-token')
          .set('Cookie', `session_id=${sessionIdLike('c')}`)
        statuses.push(res.status)
      }

      const throttled = statuses.filter((s) => s === 429).length
      expect(throttled, `${throttled}/${statuses.length} requests were throttled`).toBe(0)
    })
  })

  describe('keying', () => {
    it('gives two sessions from the same IP independent budgets', async () => {
      const { createApp } = await import('../../app.js')
      const app = createApp()
      const sessionA = sessionIdLike('a')
      const sessionB = sessionIdLike('b')

      let remainingA = Number.NaN
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .get('/api/csrf-token')
          .set('Cookie', `session_id=${sessionA}`)
        expect(res.status).toBe(200)
        remainingA = Number(res.headers['ratelimit-remaining'])
      }

      const resB = await request(app)
        .get('/api/csrf-token')
        .set('Cookie', `session_id=${sessionB}`)
      expect(resB.status).toBe(200)
      const remainingB = Number(resB.headers['ratelimit-remaining'])

      // Per-IP keying would make B the 4th request in A's bucket, so B's
      // remaining budget would be LOWER than A's. Per-session keying gives B a
      // fresh bucket, so it must be HIGHER.
      expect(remainingB).toBeGreaterThan(remainingA)
    })
  })

  describe('resolveApiRateLimits', () => {
    it('sizes production against the measured worst-case navigation burst', () => {
      const limits = resolveApiRateLimits({ NODE_ENV: 'production' })

      expect(limits.windowMs).toBe(60 * 1000)
      expect(limits.identityLimit).toBeGreaterThanOrEqual(WORST_CASE_BURST_PER_MINUTE)
      expect(limits.identityLimit).toBeLessThanOrEqual(SANE_CEILING_PER_MINUTE)
    })

    it('keeps a per-source-IP flood ceiling above the per-identity budget', () => {
      const limits = resolveApiRateLimits({ NODE_ENV: 'production' })

      // The flood ceiling must not bind before the per-identity one for a
      // single user, but it must still be finite — removing it would let a
      // client with rotating forged cookies bypass limiting entirely.
      expect(limits.sourceIpLimit).toBeGreaterThan(limits.identityLimit)
      expect(Number.isFinite(limits.sourceIpLimit)).toBe(true)
    })

    it('leaves the permissive test and dev budgets alone', () => {
      expect(resolveApiRateLimits({ NODE_ENV: 'test' }).identityLimit).toBe(10000)
      expect(resolveApiRateLimits({ NODE_ENV: 'development' }).identityLimit).toBe(1000)
      expect(resolveApiRateLimits({ NODE_ENV: 'production', E2E_TEST: '1' }).identityLimit).toBe(10000)
    })

    it('mounts both limiters', () => {
      expect(createApiRateLimiters({ NODE_ENV: 'production' })).toHaveLength(2)
    })
  })

  describe('apiRateLimitKey', () => {
    const asRequest = (headers: Record<string, string>, ip = '203.0.113.7') =>
      ({ headers, ip, socket: { remoteAddress: ip } }) as unknown as Request

    it('separates two sessions arriving from the same IP', () => {
      const a = apiRateLimitKey(asRequest({ cookie: `session_id=${sessionIdLike('a')}` }))
      const b = apiRateLimitKey(asRequest({ cookie: `session_id=${sessionIdLike('b')}` }))

      expect(a).not.toBe(b)
    })

    it('keeps one session on one bucket across IPs', () => {
      const cookie = `session_id=${sessionIdLike('a')}`
      const office = apiRateLimitKey(asRequest({ cookie }, '203.0.113.7'))
      const home = apiRateLimitKey(asRequest({ cookie }, '198.51.100.4'))

      expect(office).toBe(home)
    })

    it('never puts the raw session id in the bucket key', () => {
      const sessionId = sessionIdLike('a')
      const key = apiRateLimitKey(asRequest({ cookie: `session_id=${sessionId}` }))

      expect(key).not.toContain(sessionId)
    })

    it('separates API tokens, and falls back to the IP when nothing identifies the caller', () => {
      const token = apiRateLimitKey(asRequest({ authorization: 'Bearer ship_token_one' }))
      const otherToken = apiRateLimitKey(asRequest({ authorization: 'Bearer ship_token_two' }))
      const anonymous = apiRateLimitKey(asRequest({}))

      expect(token).not.toBe(otherToken)
      expect(anonymous).not.toBe(token)
      expect(anonymous).toContain('203.0.113.7')
    })

    it('ignores a cookie that is not shaped like a session id', () => {
      const anonymous = apiRateLimitKey(asRequest({}))

      expect(apiRateLimitKey(asRequest({ cookie: 'session_id=not-a-session' }))).toBe(anonymous)
      expect(apiRateLimitKey(asRequest({ cookie: 'session_id=' }))).toBe(anonymous)
      expect(apiRateLimitKey(asRequest({ cookie: 'other=1; session_idx=abc' }))).toBe(anonymous)
    })
  })

  describe('readSessionIdCookie', () => {
    it('finds session_id among other cookies and rejects malformed values', () => {
      const sessionId = sessionIdLike('a')

      expect(readSessionIdCookie(`connect.sid=xyz; session_id=${sessionId}; theme=dark`)).toBe(sessionId)
      expect(readSessionIdCookie(`session_id="${sessionId}"`)).toBe(sessionId)
      expect(readSessionIdCookie(undefined)).toBeNull()
      expect(readSessionIdCookie('session_id=%E0%A4%A')).toBeNull()
      expect(readSessionIdCookie(`session_id=${sessionId.toUpperCase()}`)).toBeNull()
    })
  })
})
