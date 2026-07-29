/**
 * Regression test for API-3 / TRO-174 — response compression.
 *
 * The `compression` middleware was never registered in `api/src/app.ts`, so every
 * JSON list response shipped uncompressed even when the client advertised gzip
 * support. `/api/issues` was the worst case at ~380 KB.
 *
 * This asserts the middleware contract at the app level, exercised through a real
 * route via supertest:
 *   - gzip advertised + payload over threshold  -> `Content-Encoding: gzip`
 *   - gzip NOT advertised                       -> no `Content-Encoding`
 *   - payload under threshold                   -> no `Content-Encoding`
 *
 * NOTE ON MEASUREMENT: do not try to confirm this fix with a localhost latency
 * benchmark. Loopback transfer time is ~0, so gzip's CPU cost makes P95 flat or
 * marginally worse while the payload is genuinely 15x smaller. Validate by bytes
 * on the wire (see CHANGES.md, TRO-174).
 *
 * supertest/superagent transparently decompresses the body, so each test also
 * asserts the decoded payload is intact — a `Content-Encoding` header on a
 * corrupted body would otherwise look like a pass.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'

// Must match the `threshold` configured in api/src/app.ts.
const COMPRESSION_THRESHOLD_BYTES = 1024

describe('Response compression (API-3)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `compression-test-${testRunId}@ship.local`

  let sessionCookie: string
  let testWorkspaceId: string
  let testUserId: string

  // Long titles, not long `content`. TRO-173/TRO-182 removes `content` from the
  // /api/issues list projection; `title` survives any list projection, so this
  // payload stays over the threshold regardless of which branch lands first.
  const ISSUE_COUNT = 15
  const TITLE_PADDING = 'compression regression padding '.repeat(10)

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Compression Test ${testRunId}`]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Compression Test User')
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

    for (let i = 0; i < ISSUE_COUNT; i++) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
         VALUES ($1, 'issue', $2, $3, 'workspace', $4)`,
        [
          testWorkspaceId,
          `Issue ${i} ${TITLE_PADDING}`,
          testUserId,
          JSON.stringify({ state: 'todo', priority: 'medium' }),
        ]
      )
    }
  })

  it('serves /api/issues uncompressed when the client does not advertise gzip', async () => {
    const response = await request(app)
      .get('/api/issues')
      .set('Cookie', sessionCookie)
      .set('Accept-Encoding', 'identity')

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body.length).toBeGreaterThanOrEqual(ISSUE_COUNT)

    // Guards the test against becoming vacuous. If a payload reduction (e.g.
    // TRO-173 dropping `content` from this projection) ever takes the uncompressed
    // body under the threshold, the gzip assertion below would pass for the wrong
    // reason — nothing to compress rather than compression working. Fail loudly.
    const uncompressedBytes = Number(response.headers['content-length'])
    expect(
      uncompressedBytes,
      `Uncompressed /api/issues must exceed the ${COMPRESSION_THRESHOLD_BYTES}-byte ` +
        `compression threshold for this test to be meaningful. Got ${uncompressedBytes} ` +
        `bytes from ${ISSUE_COUNT} issues. Increase ISSUE_COUNT or TITLE_PADDING.`
    ).toBeGreaterThan(COMPRESSION_THRESHOLD_BYTES)
  })

  it('gzips /api/issues when the client advertises gzip support', async () => {
    const response = await request(app)
      .get('/api/issues')
      .set('Cookie', sessionCookie)
      .set('Accept-Encoding', 'gzip')

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')

    // Body must survive the round trip, not merely carry the header.
    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body.length).toBeGreaterThanOrEqual(ISSUE_COUNT)
    expect(response.body[0]).toHaveProperty('title')
  })

  it('leaves responses below the size threshold uncompressed', async () => {
    const response = await request(app)
      .get('/health')
      .set('Accept-Encoding', 'gzip')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
    // ~20 bytes: compressing it would add bytes and CPU for no benefit.
    expect(response.headers['content-encoding']).toBeUndefined()
  })
})
