import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { checkRateLimit, RATE_LIMIT } from '../services/ai-analysis.js'

interface RateLimitErrorBody {
  error: string
}

/**
 * Regression test for TRO-286 (TEST-14) Part 2.
 *
 * `api/src/services/ai-analysis.ts:39` enforces `RATE_LIMIT = 120` requests/hour.
 * `api/src/routes/ai.ts` used to hard-code a *second*, independent copy of that
 * number in its 429 body: "Max 10 analysis requests per hour." Both literals were
 * introduced in the same original commit (8c0de05), so the message was wrong from
 * day one -- it never reflected the enforced value.
 *
 * `e2e/ai-analysis-api.spec.ts` sent 11 rapid requests expecting a 429 and never
 * got one (real limit is 120/hour), which is what surfaced the mismatch. That e2e
 * test cannot assert the real limit truthfully without either 121 requests (120 of
 * which would attempt a real Bedrock call) or an injectable rate limit -- a
 * production-seam decision left to a maintainer (see CHANGES.md). This vitest test
 * covers the part that doesn't require that decision: the copy and the enforcement
 * must name the same number, and the route must actually return it once the limit
 * is exhausted. It exhausts the in-memory limiter directly (no HTTP, no Bedrock
 * calls) and only crosses the HTTP boundary once, for the request that is expected
 * to be rejected before reaching analyzePlan().
 */
describe('AI rate limit copy matches enforcement', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `ai-ratelimit-test-${testRunId}@ship.local`
  const testWorkspaceName = `AI Rate Limit Test ${testRunId}`

  let sessionCookie: string
  let csrfToken: string
  let testUserId: string
  let testWorkspaceId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'AI Rate Limit Test User')
       RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    )
    sessionCookie = `session_id=${sessionId}`

    const csrfRes = await request(app)
      .get('/api/csrf-token')
      .set('Cookie', sessionCookie)
    csrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  it('enforces exactly RATE_LIMIT (120) requests/hour', () => {
    const userId = `rate-limit-unit-${testRunId}`

    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(checkRateLimit(userId), `request ${i + 1} of ${RATE_LIMIT} should be allowed`).toBe(true)
    }

    expect(checkRateLimit(userId), `request ${RATE_LIMIT + 1} should be rejected`).toBe(false)
  })

  it('returns a 429 body naming the same limit it enforces', async () => {
    // Exhaust the shared in-memory limiter directly for this session's user --
    // no HTTP calls, no Bedrock calls. Once exhausted, the route must reject the
    // *next* request before it ever reaches analyzePlan().
    for (let i = 0; i < RATE_LIMIT; i++) {
      checkRateLimit(testUserId)
    }

    const res = await request(app)
      .post('/api/ai/analyze-plan')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ content: { type: 'doc', content: [] } })

    const body = res.body as RateLimitErrorBody

    expect(res.status, 'rate-limited request should return 429').toBe(429)
    expect(body.error, 'error body should name the real enforced limit, not a stale copy').toBe(
      `Rate limit exceeded. Max ${RATE_LIMIT} analysis requests per hour.`
    )
    // Pin the concrete number too: if RATE_LIMIT's value ever changes silently,
    // this fails alongside the message-format assertion above.
    expect(RATE_LIMIT).toBe(120)
  })
})
