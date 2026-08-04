import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'

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
