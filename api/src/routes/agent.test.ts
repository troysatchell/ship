import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { isAgentBaseUrlSecure } from './agent.js'

/**
 * Regression tests for TRO-320 / FG-9: the chat panel's proxy route.
 *
 * `POST /api/agent/chat` is the ONLY way the browser reaches the FleetGraph
 * agent — it has no session concept of its own (see agent.ts's module
 * docstring for the full architecture reasoning). These tests never hit a
 * real agent process: `global.fetch` is mocked so each case controls
 * exactly what "the agent" returns, matching this ticket's own instruction
 * ("mock the outbound fetch, don't hit a real agent process").
 */
describe('POST /api/agent/chat (TRO-320 / FG-9)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `agent-chat-${testRunId}@ship.local`
  const testWorkspaceName = `Agent Chat Test ${testRunId}`

  let sessionCookie: string
  let csrfToken: string
  let testWorkspaceId: string
  let testUserId: string

  const originalFetch = global.fetch
  const originalSecret = process.env.AGENT_INTERNAL_SECRET
  const VALID_BODY = { seedDocumentId: 'a8a08536-d4ef-44a9-a9c1-12d1efe39dc4', question: 'Why is this issue stalled?' }

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Agent Chat Test User') RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    )
    sessionCookie = `session_id=${sessionId}`

    // /api/agent is CSRF-protected (conditionalCsrf, app.ts) for session-cookie
    // auth — same pattern as blocks-relationship.test.ts.
    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie)
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

  beforeEach(() => {
    process.env.AGENT_INTERNAL_SECRET = 'test-internal-secret'
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.AGENT_INTERNAL_SECRET
    else process.env.AGENT_INTERNAL_SECRET = originalSecret
  })

  it('requires authentication — a valid CSRF pairing but no session cookie means 401, and the agent is never called', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')

    // A CSRF token/cookie pairing minted with no session at all — isolates
    // authMiddleware's own check from conditionalCsrf's, which runs first
    // at the mount (app.ts) and would otherwise 403 every unauthenticated
    // request before authMiddleware ever ran.
    const anonCsrfRes = await request(app).get('/api/csrf-token')
    const anonCsrfToken = anonCsrfRes.body.token
    const anonCookie = anonCsrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''

    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', anonCookie)
      .set('x-csrf-token', anonCsrfToken)
      .send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when seedDocumentId is missing, and never calls the agent', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ question: 'no seed here' })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when question is missing, and never calls the agent', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ seedDocumentId: VALID_BODY.seedDocumentId })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when question exceeds the max length, and never calls the agent', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ seedDocumentId: VALID_BODY.seedDocumentId, question: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 503 and never calls the agent when AGENT_INTERNAL_SECRET is not configured on this side', async () => {
    delete process.env.AGENT_INTERNAL_SECRET
    const fetchSpy = vi.spyOn(global, 'fetch')
    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(VALID_BODY)
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('agent_not_configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 503 and never calls the agent when AGENT_API_BASE_URL is a non-loopback http: URL (CWE-319 — refuses to send X-Internal-Secret in cleartext, CodeRabbit PR #120)', async () => {
    // AGENT_API_BASE_URL is a module-scope const resolved once at import —
    // same reload pattern as GET /inbox's own path-preservation test.
    const prevBaseUrl = process.env.AGENT_API_BASE_URL
    process.env.AGENT_API_BASE_URL = 'http://agent.example.com'
    vi.resetModules()
    let freshApp: import('express').Express
    try {
      const { createApp: createFreshApp } = await import('../app.js')
      freshApp = createFreshApp()
    } finally {
      if (prevBaseUrl === undefined) delete process.env.AGENT_API_BASE_URL
      else process.env.AGENT_API_BASE_URL = prevBaseUrl
    }

    try {
      // A fresh app instance has its own in-memory express-session store
      // (app.ts: `session({...})` with no `store` configured), so the outer
      // csrfToken/connect.sid pairing — minted against the ORIGINAL app —
      // does not resolve here. Mint a fresh pairing against freshApp, the
      // same way the outer beforeAll did. The bare `session_id=...` cookie
      // is unaffected: that's Ship's own DB-backed auth session, looked up
      // in the (real, shared) database, not held in any app instance's memory.
      const bareSessionCookie = sessionCookie.split(';')[0] ?? sessionCookie
      const freshCsrfRes = await request(freshApp).get('/api/csrf-token')
      const freshCsrfToken = freshCsrfRes.body.token
      const freshConnectSid = freshCsrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
      const combinedCookie = freshConnectSid ? `${bareSessionCookie}; ${freshConnectSid}` : bareSessionCookie

      const fetchSpy = vi.spyOn(global, 'fetch')

      const res = await request(freshApp)
        .post('/api/agent/chat')
        .set('Cookie', combinedCookie)
        .set('x-csrf-token', freshCsrfToken)
        .send(VALID_BODY)

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('agent_not_configured')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.resetModules()
    }
  })

  it('forwards seedDocumentId/question plus the SESSION\'S OWN userId (never a client-supplied one) with the X-Internal-Secret header, and relays a 200 response verbatim', async () => {
    const agentBody = {
      output: 'It is stalled because it is blocked by AUTH-12, which has not moved in 6 days.',
      citedSources: [
        { documentId: 'week-1', documentType: 'sprint', title: 'Week 12', reason: "the issue's week" },
        { documentId: 'issue-2', documentType: 'issue', title: 'AUTH-12', reason: 'blocks this issue' },
      ],
      expansionCapped: false,
    }
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(agentBody), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(VALID_BODY)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toContain('/chat')
    expect(calledInit.method).toBe('POST')
    expect((calledInit.headers as Record<string, string>)['X-Internal-Secret']).toBe('test-internal-secret')
    // CWE-522 (CodeRabbit PR #120): a redirect here is always a
    // configuration error, never legitimate — `fetch` must not silently
    // follow one and forward X-Internal-Secret to a different host.
    expect(calledInit.redirect).toBe('error')
    const sentBody = JSON.parse(calledInit.body as string)
    expect(sentBody).toEqual({
      seedDocumentId: VALID_BODY.seedDocumentId,
      question: VALID_BODY.question,
      // The session's own user, never something the client could spoof by
      // passing an askingUserId in the request body (the route only reads
      // seedDocumentId/question from req.body — see agent.ts).
      askingUserId: testUserId,
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual(agentBody)
    // CWE-524 (CodeRabbit PR #120): a per-user, per-question answer must
    // never be servable from a browser's own HTTP cache.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('degrades to a clean 502 when the agent returns 200 with a malformed citedSources element (crosses the trust boundary, so every element is validated)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        output: 'some answer',
        // Missing `reason` — the chat panel renders this field directly.
        citedSources: [{ documentId: 'd1', documentType: 'issue', title: 'X' }],
        expansionCapped: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unavailable')
  })

  it('degrades to a clean 502 (never the agent\'s raw body) when the agent responds with a non-OK status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    )

    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unavailable')
  })

  it('degrades to a clean 502 (never a hang) when the outbound call to the agent throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await request(app)
      .post('/api/agent/chat')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(VALID_BODY)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unreachable')
  })
})

/**
 * Regression tests for TRO-323 / FG-10: the ranked-inbox proxy route.
 *
 * `GET /api/agent/inbox` is the only way the browser reaches the agent's
 * itemStore.list() — same architecture as POST /api/agent/chat above (no
 * agent session concept, api/ proxies with the shared internal secret).
 * These tests never hit a real agent process: global.fetch is mocked so
 * each case controls exactly what "the agent" returns.
 */
describe('GET /api/agent/inbox (TRO-323 / FG-10)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `agent-inbox-${testRunId}@ship.local`
  const testWorkspaceName = `Agent Inbox Test ${testRunId}`

  let sessionCookie: string
  let testWorkspaceId: string
  let testUserId: string

  const originalFetch = global.fetch
  const originalSecret = process.env.AGENT_INTERNAL_SECRET

  const SAMPLE_ITEM = {
    id: 'blocking-approval:sprint-1:state',
    type: 'blocking_approval',
    summary: 'AUTH-12 is waiting on your approval',
    evidence: { documentId: 'issue-2', documentType: 'issue' },
    action: { label: 'Review AUTH-12', href: '/documents/issue-2' },
    blockedCount: 3,
    blockedSince: '2026-07-30T12:00:00.000Z',
  }

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Agent Inbox Test User') RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    )
    sessionCookie = `session_id=${sessionId}`
  })

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  beforeEach(() => {
    process.env.AGENT_INTERNAL_SECRET = 'test-internal-secret'
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.AGENT_INTERNAL_SECRET
    else process.env.AGENT_INTERNAL_SECRET = originalSecret
  })

  it('requires authentication — no session cookie means 401, and the agent is never called', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')

    const res = await request(app).get('/api/agent/inbox')

    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 503 and never calls the agent when AGENT_INTERNAL_SECRET is not configured on this side', async () => {
    delete process.env.AGENT_INTERNAL_SECRET
    const fetchSpy = vi.spyOn(global, 'fetch')
    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('agent_not_configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("forwards the SESSION'S OWN userId as recipientUserId (never a client-supplied one) with the X-Internal-Secret header, and relays a 200 response verbatim", async () => {
    const agentBody = { items: [SAMPLE_ITEM] }
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(agentBody), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string | URL, RequestInit]
    const urlString = calledUrl.toString()
    expect(urlString).toContain('/inbox')
    expect(urlString).toContain(`recipientUserId=${testUserId}`)
    expect(calledInit.method).toBe('GET')
    expect((calledInit.headers as Record<string, string>)['X-Internal-Secret']).toBe('test-internal-secret')
    // CWE-522 (CodeRabbit PR #120): same posture as POST /chat.
    expect(calledInit.redirect).toBe('error')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(agentBody)
    // CWE-524 (CodeRabbit PR #120): one person's ranked inbox must never be
    // servable from a browser cache to whoever uses the machine next.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('preserves a path component in AGENT_API_BASE_URL, the same way POST /chat already does (CodeRabbit PR #120) — `new URL(\'/inbox\', base)` would silently discard it', async () => {
    // AGENT_API_BASE_URL is read into a module-scope const at import time, so
    // getting a fresh value requires a fresh module graph (same pattern as
    // api/src/middleware/__tests__/rate-limit.test.ts's loadAppWithNodeEnv).
    // Reusing the OUTER sessionCookie/testUserId is safe: authMiddleware
    // resolves a session by looking it up in the (real, shared) database,
    // not by anything baked into a particular app instance.
    const prevBaseUrl = process.env.AGENT_API_BASE_URL
    process.env.AGENT_API_BASE_URL = 'https://agent.example.com/api'
    vi.resetModules()
    let freshApp: import('express').Express
    try {
      const { createApp: createFreshApp } = await import('../app.js')
      freshApp = createFreshApp()
    } finally {
      if (prevBaseUrl === undefined) delete process.env.AGENT_API_BASE_URL
      else process.env.AGENT_API_BASE_URL = prevBaseUrl
    }

    try {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      )

      const res = await request(freshApp).get('/api/agent/inbox').set('Cookie', sessionCookie)

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [calledUrl] = fetchSpy.mock.calls[0] as [string | URL, RequestInit]
      // The /api base path must survive into the outbound call — a bare
      // `/inbox` (origin-only, base path dropped) would fail this.
      expect(calledUrl.toString()).toContain('agent.example.com/api/inbox')
      expect(res.status).toBe(200)
    } finally {
      vi.resetModules()
    }
  })

  it('degrades to a clean 502 when the agent returns 200 with a malformed item (missing action.href) — crosses the trust boundary, so every item is validated', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        items: [{ ...SAMPLE_ITEM, action: { label: 'Review AUTH-12' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unavailable')
  })

  it('degrades to a clean 200 empty list when the agent has nothing for this recipient — not an error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [] })
  })

  it('degrades to a clean 502 (never the agent\'s raw body) when the agent responds with a non-OK status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    )

    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unavailable')
  })

  it('degrades to a clean 502 (never a hang) when the outbound call to the agent throws', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await request(app).get('/api/agent/inbox').set('Cookie', sessionCookie)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('agent_unreachable')
  })

  it('returns 503 and never calls the agent when AGENT_API_BASE_URL is a non-loopback http: URL (CWE-319 — refuses to send X-Internal-Secret in cleartext, CodeRabbit PR #120)', async () => {
    // AGENT_API_BASE_URL is a module-scope const resolved once at import —
    // same reload pattern as the "preserves a path component" test above.
    const prevBaseUrl = process.env.AGENT_API_BASE_URL
    process.env.AGENT_API_BASE_URL = 'http://agent.example.com'
    vi.resetModules()
    let freshApp: import('express').Express
    try {
      const { createApp: createFreshApp } = await import('../app.js')
      freshApp = createFreshApp()
    } finally {
      if (prevBaseUrl === undefined) delete process.env.AGENT_API_BASE_URL
      else process.env.AGENT_API_BASE_URL = prevBaseUrl
    }

    try {
      const fetchSpy = vi.spyOn(global, 'fetch')

      // GET /inbox needs no CSRF pairing (conditionalCsrf only protects
      // mutating methods) — reusing the outer, DB-backed sessionCookie
      // against a fresh app instance is safe, exactly like the "preserves a
      // path component" test above.
      const res = await request(freshApp).get('/api/agent/inbox').set('Cookie', sessionCookie)

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('agent_not_configured')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.resetModules()
    }
  })
})

describe('isAgentBaseUrlSecure (CWE-319, CodeRabbit PR #120)', () => {
  /**
   * Direct tests of the shared predicate both POST /chat and GET /inbox call
   * before making their outbound fetch — cheaper than a module reload per
   * case, and pins the exact hostname/scheme rules independently of either
   * route's own integration tests above (which prove the predicate is
   * actually wired in, not what it decides for a given URL).
   */
  it('rejects a non-loopback host over http:', () => {
    expect(isAgentBaseUrlSecure('http://agent.example.com')).toBe(false)
    expect(isAgentBaseUrlSecure('http://agent.example.com:3100')).toBe(false)
    expect(isAgentBaseUrlSecure('http://10.0.0.5:3100')).toBe(false)
  })

  it('allows the loopback hostnames over http:', () => {
    expect(isAgentBaseUrlSecure('http://localhost:3100')).toBe(true)
    expect(isAgentBaseUrlSecure('http://127.0.0.1:3100')).toBe(true)
    expect(isAgentBaseUrlSecure('http://[::1]:3100')).toBe(true)
  })

  it('allows any host over https: unconditionally', () => {
    expect(isAgentBaseUrlSecure('https://agent.example.com')).toBe(true)
    expect(isAgentBaseUrlSecure('https://10.0.0.5:3100')).toBe(true)
    expect(isAgentBaseUrlSecure('https://localhost:3100')).toBe(true)
  })

  it('rejects an unparseable base URL rather than throwing', () => {
    expect(() => isAgentBaseUrlSecure('not a url')).not.toThrow()
    expect(isAgentBaseUrlSecure('not a url')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isAgentBaseUrlSecure('ftp://agent.example.com')).toBe(false)
  })
})
