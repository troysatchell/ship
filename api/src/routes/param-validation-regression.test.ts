/**
 * TRO-192 / TRO-195 — regression tests for audit findings ERR-5 and ERR-8.
 *
 * Root cause (shared): request **bodies** are validated up front with zod and
 * return a clean 400 (see `createDocumentSchema` in `routes/documents.ts`).
 * Path and query params bypassed that layer entirely:
 *
 * - ERR-5: `GET /api/documents/not-a-uuid` reached Postgres, failed an
 *   `invalid input syntax for type uuid` cast, and surfaced as an uncaught
 *   500 (`audit/error-handling/raw/probe3-api.txt`). Same for
 *   `GET /api/documents/:id/backlinks`, `GET /api/weeks/:id`, and
 *   `?type=bogus` on the documents list.
 * - ERR-8: `?limit=-1` and `?limit=999999999` on the documents list both
 *   returned the full, unpaginated payload — the route never read `limit`
 *   from the query at all.
 *
 * The fix is `api/src/middleware/paramValidation.ts`, applied via
 * `router.param('id', validateUuidParam)` in documents.ts/backlinks.ts/
 * weeks.ts, plus a `limit`/`type` query schema on the documents list route.
 * These tests hit the actual endpoints (not the middleware in isolation) so
 * they prove the fix is wired in, not just that the helper works.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'

describe('Path/query param validation (ERR-5, ERR-8)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `param-validation-${testRunId}@ship.local`
  const testWorkspaceName = `Param Validation Test ${testRunId}`

  let sessionCookie: string
  let testWorkspaceId: string
  let testUserId: string
  /** Seeded so the `limit` tests have more rows than the requested limit to prove enforcement. */
  const SEEDED_DOCUMENT_COUNT = 12

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Param Validation Test User')
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
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }

    // Seed enough workspace-visible wiki documents that an explicit `limit`
    // below this count can only be satisfied if the LIMIT clause is real.
    for (let i = 0; i < SEEDED_DOCUMENT_COUNT; i++) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
         VALUES ($1, 'wiki', $2, $3, 'workspace')`,
        [testWorkspaceId, `Param Validation Doc ${i}`, testUserId]
      )
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  describe('ERR-5: malformed uuid path params', () => {
    it('GET /api/documents/:id with a malformed uuid returns 400, not 500', async () => {
      const res = await request(app)
        .get('/api/documents/not-a-uuid')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid input')
      expect(res.body.details?.[0]?.path).toEqual(['id'])
    })

    it('GET /api/documents/:id with a well-formed but absent uuid still returns 404', async () => {
      const fakeId = crypto.randomUUID()
      const res = await request(app)
        .get(`/api/documents/${fakeId}`)
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(404)
    })

    it('GET /api/documents/:id/backlinks with a malformed uuid returns 400, not 500', async () => {
      const res = await request(app)
        .get('/api/documents/not-a-uuid/backlinks')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid input')
    })

    it('GET /api/weeks/:id with a malformed value ("not-a-number", the literal probe input) returns 400, not 500', async () => {
      const res = await request(app)
        .get('/api/weeks/not-a-number')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid input')
    })

    it('GET /api/weeks/:id with a well-formed but absent uuid still returns 404', async () => {
      const fakeId = crypto.randomUUID()
      const res = await request(app)
        .get(`/api/weeks/${fakeId}`)
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(404)
    })
  })

  describe('ERR-5: bogus enum query param', () => {
    it('GET /api/documents?type=bogus returns 400, not 500', async () => {
      const res = await request(app)
        .get('/api/documents?type=bogus')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid input')
      expect(res.body.details?.[0]?.path).toEqual(['type'])
    })

    it('GET /api/documents?type=wiki (the only value the web client sends) still returns 200', async () => {
      const res = await request(app)
        .get('/api/documents?type=wiki')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('ERR-8: unbounded limit query param', () => {
    it('GET /api/documents?limit=-1 returns 400', async () => {
      const res = await request(app)
        .get('/api/documents?limit=-1')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid input')
    })

    it('GET /api/documents?limit=0 returns 400', async () => {
      const res = await request(app)
        .get('/api/documents?limit=0')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
    })

    it('GET /api/documents?limit=abc (non-numeric where a number is required) returns 400', async () => {
      const res = await request(app)
        .get('/api/documents?limit=abc')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(400)
    })

    it('GET /api/documents?limit=5 actually restricts the row count returned', async () => {
      const res = await request(app)
        .get('/api/documents?limit=5')
        .set('Cookie', sessionCookie)

      // Before the fix, `limit` was never read from the query at all, so this
      // would come back with all SEEDED_DOCUMENT_COUNT (12) rows instead of 5.
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(5)
    })

    it('GET /api/documents?limit=999999999 no longer crashes and does not error', async () => {
      const res = await request(app)
        .get('/api/documents?limit=999999999')
        .set('Cookie', sessionCookie)

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      // All seeded rows are well under the server's cap, so every one comes back.
      expect(res.body.length).toBe(SEEDED_DOCUMENT_COUNT)
    })
  })
})
