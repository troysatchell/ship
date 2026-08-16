/**
 * Regression suite for TRO-408 / PF-102 (OAuth app registration).
 *
 * Test design source: Linear TRO-408 comment "Test design (pre-implementation —
 * ship-test-designer, 2026-08-10)". AC-1..AC-5 below map 1:1 onto that comment's numbering.
 *
 * PM triage amendment (also TRO-408 comments, 2026-08-10): registration takes `client_type`
 * ('confidential' | 'public'); public apps get no secret at all (nothing to show once) and
 * rotation is a 400 for them.
 *
 * AC-4/AC-5 exercise `verifyAppCredentials` directly rather than through an HTTP token endpoint —
 * `/oauth/token` is PF-104, not built by this ticket ("whatever auth path exists" per the test
 * design comment). `verifyAppCredentials` is the credential-check primitive PF-104 will call.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../../../app.js'
import { pool } from '../../../db/client.js'
import { verifyAppCredentials } from '../appRegistration.js'
import { InternalErrorResponseSchema } from '../../../openapi/schemas/common.js'
import { generateOpenAPIDocument } from '../../../openapi/index.js'

describe('OAuth app registration (PF-102)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const adminEmail = `oauth-apps-admin-${testRunId}@ship.local`
  const testWorkspaceName = `OAuth Apps Test ${testRunId}`

  let workspaceId: string
  let adminUserId: string
  let sessionCookie: string
  let csrfToken: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    workspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'OAuth Apps Admin')
       RETURNING id`,
      [adminEmail]
    )
    adminUserId = userResult.rows[0].id

    // workspace ADMIN role — this endpoint is gated by workspaceAdminMiddleware, not plain membership.
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspaceId, adminUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, adminUserId, workspaceId]
    )
    sessionCookie = `session_id=${sessionId}`

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie)
    csrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [adminUserId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [adminUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [adminUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  function createAppRequest(body: Record<string, unknown>) {
    return request(app)
      .post('/api/oauth-apps')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(body)
  }

  // ============== AC-1 ==============
  // "creation ... returns client_id + raw secret exactly once; SHA-256 hash at rest"
  it('AC-1: creation returns client_id + raw secret exactly once, SHA-256 hashed at rest', async () => {
    const res = await createAppRequest({
      name: `AC-1 App ${testRunId}`,
      client_type: 'confidential',
      redirect_uris: ['https://example.com/callback'],
    })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.client_id).toMatch(/^ship_app_/)
    expect(typeof res.body.data.client_secret).toBe('string')
    expect(res.body.data.client_secret).toMatch(/^ship_appsec_/)

    const rawSecret: string = res.body.data.client_secret
    const clientId: string = res.body.data.client_id
    const expectedHash = crypto.createHash('sha256').update(rawSecret).digest('hex')

    const rowResult = await pool.query(
      `SELECT client_id, client_secret_hash FROM oauth_apps WHERE client_id = $1`,
      [clientId]
    )
    const row = rowResult.rows[0]
    expect(row).toBeDefined()
    expect(row.client_secret_hash).toBe(expectedHash)

    // The raw secret must not appear anywhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(rawSecret)
  })

  it('AC-1 (PM amendment): public apps get no secret at all', async () => {
    const res = await createAppRequest({
      name: `AC-1 Public App ${testRunId}`,
      client_type: 'public',
      redirect_uris: ['https://example.com/callback'],
    })

    expect(res.status).toBe(201)
    expect(res.body.data.client_id).toMatch(/^ship_app_/)
    expect(res.body.data.client_secret).toBeNull()

    const rowResult = await pool.query(
      `SELECT client_secret_hash FROM oauth_apps WHERE client_id = $1`,
      [res.body.data.client_id]
    )
    expect(rowResult.rows[0].client_secret_hash).toBeNull()
  })

  // ============== AC-2 ==============
  // "raw secret absent from logs"
  it('AC-2: raw secret never appears in a logged line on creation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const res = await createAppRequest({
        name: `AC-2 App ${testRunId}`,
        client_type: 'confidential',
      })
      expect(res.status).toBe(201)
      const rawSecret: string = res.body.data.client_secret
      expect(typeof rawSecret).toBe('string')

      // CodeRabbit (TRO-408 review): the original check only inspected
      // string args, so a leak inside a logged Error/object (e.g.
      // `console.error('failed', { body })`) would slip past undetected.
      // Serialize every arg — strings as-is, Errors via message + stack,
      // everything else via JSON.stringify (falling back to String() for
      // anything that isn't serializable, e.g. a circular reference).
      const serializeArg = (arg: unknown): string => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }

      const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      const leaked = allCalls.some((callArgs) =>
        callArgs.some((arg) => serializeArg(arg).includes(rawSecret))
      )
      expect(leaked).toBe(false)
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  // ============== AC-3 ==============
  // "raw secret absent from any subsequent response" (shown-once)
  it('AC-3: raw secret is absent from any later response for the same app', async () => {
    const createRes = await createAppRequest({
      name: `AC-3 App ${testRunId}`,
      client_type: 'confidential',
    })
    expect(createRes.status).toBe(201)
    const rawSecret: string = createRes.body.data.client_secret
    const appId: string = createRes.body.data.id

    const getRes = await request(app)
      .get(`/api/oauth-apps/${appId}`)
      .set('Cookie', sessionCookie)
    expect(getRes.status).toBe(200)
    expect(JSON.stringify(getRes.body)).not.toContain(rawSecret)

    const listRes = await request(app)
      .get('/api/oauth-apps')
      .set('Cookie', sessionCookie)
    expect(listRes.status).toBe(200)
    expect(JSON.stringify(listRes.body)).not.toContain(rawSecret)
  })

  // ============== AC-4 ==============
  // "rotation endpoint (old secret invalidated immediately — no-grace-period)"
  it('AC-4: rotation invalidates the old secret immediately, no grace period', async () => {
    const createRes = await createAppRequest({
      name: `AC-4 App ${testRunId}`,
      client_type: 'confidential',
    })
    expect(createRes.status).toBe(201)
    const clientId: string = createRes.body.data.client_id
    const oldSecret: string = createRes.body.data.client_secret
    const appId: string = createRes.body.data.id

    // sanity: old secret authenticates before rotation
    const before = await verifyAppCredentials({ clientId, clientSecret: oldSecret })
    expect(before.ok).toBe(true)

    const rotateRes = await request(app)
      .post(`/api/oauth-apps/${appId}/rotate`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(rotateRes.status).toBe(200)
    const newSecret: string = rotateRes.body.data.client_secret
    expect(typeof newSecret).toBe('string')
    expect(newSecret).not.toBe(oldSecret)

    const oldAfterRotation = await verifyAppCredentials({ clientId, clientSecret: oldSecret })
    expect(oldAfterRotation.ok).toBe(false)
    if (!oldAfterRotation.ok) {
      expect(oldAfterRotation.reason).toBe('invalid_secret')
    }

    const newAfterRotation = await verifyAppCredentials({ clientId, clientSecret: newSecret })
    expect(newAfterRotation.ok).toBe(true)
  })

  it('AC-4 (PM amendment): rotating a public app returns 400 with a clear message', async () => {
    const createRes = await createAppRequest({
      name: `AC-4 Public App ${testRunId}`,
      client_type: 'public',
    })
    expect(createRes.status).toBe(201)
    const appId: string = createRes.body.data.id

    const rotateRes = await request(app)
      .post(`/api/oauth-apps/${appId}/rotate`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)

    expect(rotateRes.status).toBe(400)
    expect(rotateRes.body.success).toBe(false)
    expect(typeof rotateRes.body.error.message).toBe('string')
    expect(rotateRes.body.error.message.length).toBeGreaterThan(0)
  })

  // ============== AC-5 ==============
  // "revocation"
  it('AC-5: revocation sets revoked_at and blocks subsequent authentication', async () => {
    const createRes = await createAppRequest({
      name: `AC-5 App ${testRunId}`,
      client_type: 'confidential',
    })
    expect(createRes.status).toBe(201)
    const clientId: string = createRes.body.data.client_id
    const secret: string = createRes.body.data.client_secret
    const appId: string = createRes.body.data.id

    const revokeRes = await request(app)
      .delete(`/api/oauth-apps/${appId}`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(revokeRes.status).toBe(200)

    const rowResult = await pool.query(`SELECT revoked_at FROM oauth_apps WHERE id = $1`, [appId])
    expect(rowResult.rows[0].revoked_at).not.toBeNull()

    const authAfterRevoke = await verifyAppCredentials({ clientId, clientSecret: secret })
    expect(authAfterRevoke.ok).toBe(false)
    if (!authAfterRevoke.ok) {
      expect(authAfterRevoke.reason).toBe('revoked')
    }
  })

  it('AC-5: revoking an already-revoked app returns 409 and does not clobber the timestamp', async () => {
    const createRes = await createAppRequest({
      name: `AC-5 Double-Revoke App ${testRunId}`,
      client_type: 'confidential',
    })
    expect(createRes.status).toBe(201)
    const appId: string = createRes.body.data.id

    const firstRevoke = await request(app)
      .delete(`/api/oauth-apps/${appId}`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(firstRevoke.status).toBe(200)

    const firstRow = await pool.query(`SELECT revoked_at FROM oauth_apps WHERE id = $1`, [appId])
    const firstRevokedAt: string = firstRow.rows[0].revoked_at

    const secondRevoke = await request(app)
      .delete(`/api/oauth-apps/${appId}`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(secondRevoke.status).toBe(409)
    expect(secondRevoke.body.success).toBe(false)

    const secondRow = await pool.query(`SELECT revoked_at FROM oauth_apps WHERE id = $1`, [appId])
    expect(secondRow.rows[0].revoked_at).toEqual(firstRevokedAt)
  })

  // CodeRabbit (TRO-408 review): :id previously reached `WHERE id = $1` against a UUID column
  // unvalidated, so a malformed ID produced a Postgres cast error caught as a 500 rather than a
  // clean 4xx. Covers all three :id routes.
  it('rejects a malformed app ID with 400, not a 500', async () => {
    const malformedId = 'not-a-uuid'

    const getRes = await request(app)
      .get(`/api/oauth-apps/${malformedId}`)
      .set('Cookie', sessionCookie)
    expect(getRes.status).toBe(400)

    const rotateRes = await request(app)
      .post(`/api/oauth-apps/${malformedId}/rotate`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(rotateRes.status).toBe(400)

    const revokeRes = await request(app)
      .delete(`/api/oauth-apps/${malformedId}`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
    expect(revokeRes.status).toBe(400)
  })

  // ============== Auth boundary (not a numbered AC, but is what makes this an "admin endpoint") ==============
  it('rejects registration from a non-admin workspace member', async () => {
    const memberEmail = `oauth-apps-member-${testRunId}@ship.local`
    const memberResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Member') RETURNING id`,
      [memberEmail]
    )
    const memberUserId = memberResult.rows[0].id
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, memberUserId]
    )
    const memberSessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [memberSessionId, memberUserId, workspaceId]
    )
    let memberCookie = `session_id=${memberSessionId}`
    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', memberCookie)
    const memberCsrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) memberCookie = `${memberCookie}; ${connectSidCookie}`

    // try/finally (CodeRabbit, TRO-408 review): if the assertion below throws, the member
    // fixture rows must still be cleaned up rather than leaking into every later test in this
    // file (or the next run against this worktree's database).
    try {
      const res = await request(app)
        .post('/api/oauth-apps')
        .set('Cookie', memberCookie)
        .set('x-csrf-token', memberCsrfToken)
        .send({ name: 'Should be rejected', client_type: 'confidential' })

      expect(res.status).toBe(403)
    } finally {
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [memberUserId])
      await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [memberUserId])
      await pool.query('DELETE FROM users WHERE id = $1', [memberUserId])
    }
  })

  // TRO-493 (PF-102 follow-up): every error response this route emits is
  // `{success: false, error: {code, message, details?}}` — CodeRabbit found
  // the route's own OpenAPI registration had been pointing at the wrong
  // shared schema (`ErrorResponseSchema`, a flat `{error: string, ...}` that
  // `documents.ts`/`issues.ts` actually return) instead of one that matches
  // this route's real, and this codebase's dominant, `{success, error:{...}}`
  // convention. This parses real response bodies from three different error
  // paths (validation/400, not-found/404, forbidden/403) against the
  // corrected `InternalErrorResponseSchema` — a schema-shape assertion, not
  // just a status-code one, which is the class of drift a status-code-only
  // check can never catch.
  it('every error response matches InternalErrorResponseSchema (TRO-493)', async () => {
    const validationRes = await request(app)
      .post('/api/oauth-apps')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ client_type: 'confidential' }) // missing required `name`
    expect(validationRes.status).toBe(400)

    const notFoundRes = await request(app)
      .get(`/api/oauth-apps/${crypto.randomUUID()}`)
      .set('Cookie', sessionCookie)

    const noSessionRes = await request(app).get('/api/oauth-apps')

    for (const res of [validationRes, notFoundRes, noSessionRes]) {
      const parsed = InternalErrorResponseSchema.safeParse(res.body)
      expect(parsed.success, `status ${res.status} body ${JSON.stringify(res.body)}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true)
    }

    // The validation-error case is the one whose `details` shape actually
    // varies (zod's own `flatten()`) — assert it concretely rather than
    // only via the generic schema's `z.record(z.unknown())`.
    expect(validationRes.body.error.details).toHaveProperty('fieldErrors')
  })

  // TRO-493: the assertion above proves the *runtime* body matches
  // InternalErrorResponseSchema, but that alone can't catch this bug's real
  // shape — the runtime shape never changed; only the OpenAPI *documentation*
  // pointed at the wrong schema. This checks the generated document's own
  // `$ref` directly, so reverting oauth-apps.ts's registration back to
  // `ErrorResponseSchema` fails this test even though every other assertion
  // in this file would still pass.
  it("the generated OpenAPI doc references InternalErrorResponse for oauth-apps errors, not the mismatched ErrorResponse (TRO-493)", () => {
    const doc = generateOpenAPIDocument()
    const responses = doc.paths?.['/oauth-apps']?.post?.responses as
      | Record<string, { content?: { 'application/json'?: { schema?: { $ref?: string } } } }>
      | undefined
    const ref = responses?.['400']?.content?.['application/json']?.schema?.$ref
    expect(ref, 'POST /oauth-apps 400 response schema $ref').toBe(
      '#/components/schemas/InternalErrorResponse'
    )
  })
})
