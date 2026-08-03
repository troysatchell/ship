import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { CHANGE_FEED_LAG_MS } from './change-feed.js'

/**
 * Regression tests for FG-1 / TRO-312: Ship had no way to answer "what
 * changed since a cursor" — the input FleetGraph's proactive mode needs.
 *
 * `GET /api/change-feed?since=<iso>&limit=<n>` deliberately does NOT use a
 * naive high-water mark advanced to "now" on every poll — see change-feed.ts's
 * module docstring for why that permanently misses a row whose transaction
 * commits after the cursor has already advanced past its timestamp. Instead
 * the returned `next_cursor` lags "now" by `CHANGE_FEED_LAG_MS`.
 */
describe('change feed (FG-1 / TRO-312)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `changefeed-${testRunId}@ship.local`
  const otherEmail = `changefeed-other-${testRunId}@ship.local`
  const testWorkspaceName = `Change Feed Test ${testRunId}`
  const otherWorkspaceName = `Change Feed Other Workspace ${testRunId}`

  let sessionCookie: string
  let testWorkspaceId: string
  let otherWorkspaceId: string
  let testUserId: string
  let otherUserId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const otherWorkspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [otherWorkspaceName]
    )
    otherWorkspaceId = otherWorkspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Change Feed Test User') RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    const otherUserResult = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Change Feed Other User') RETURNING id`,
      [otherEmail]
    )
    otherUserId = otherUserResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [testWorkspaceId, testUserId, otherUserId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, testUserId, testWorkspaceId]
    )
    sessionCookie = `session_id=${sessionId}`
  })

  afterAll(async () => {
    await pool.query('DELETE FROM comments WHERE workspace_id IN ($1, $2)', [testWorkspaceId, otherWorkspaceId])
    await pool.query('DELETE FROM document_history WHERE document_id IN (SELECT id FROM documents WHERE workspace_id IN ($1, $2))', [testWorkspaceId, otherWorkspaceId])
    await pool.query('DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id IN ($1, $2))', [testWorkspaceId, otherWorkspaceId])
    await pool.query('DELETE FROM documents WHERE workspace_id IN ($1, $2)', [testWorkspaceId, otherWorkspaceId])
    await pool.query('DELETE FROM sessions WHERE user_id IN ($1, $2)', [testUserId, otherUserId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id IN ($1, $2)', [testUserId, otherUserId])
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, otherUserId])
    await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [testWorkspaceId, otherWorkspaceId])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('proof 1: a change committing inside the lag window is deferred, then returned once the window elapses — never using a plain "now" high-water mark', async () => {
    const baseTime = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(baseTime)

    const since = new Date(baseTime - 60_000).toISOString()

    const docRes = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'wiki', 'Late Commit Doc', $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    const lateDocId = docRes.rows[0].id
    // Simulate a transaction that only just committed (its updated_at is "now"),
    // i.e. still inside the safety window and not yet trustworthy.
    await pool.query(`UPDATE documents SET updated_at = $1 WHERE id = $2`, [new Date(baseTime), lateDocId])

    const poll1 = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(since)}`)
      .set('Cookie', sessionCookie)

    expect(poll1.status).toBe(200)
    expect(
      poll1.body.documents.some((d: { id: string }) => d.id === lateDocId),
      'a change inside the lag window must be deferred, not returned immediately'
    ).toBe(false)
    // Red before the fix: a naive implementation advances next_cursor to
    // "now" here, which is exactly what permanently loses the row below.
    expect(new Date(poll1.body.next_cursor).getTime()).toBeLessThanOrEqual(baseTime - CHANGE_FEED_LAG_MS + 1)

    // Advance real wall-clock time (simulated) past the lag window without an
    // actual sleep — only the Date global is faked, so the HTTP/DB round trip
    // above and below still ran on real timers.
    vi.setSystemTime(baseTime + CHANGE_FEED_LAG_MS + 1_000)

    const poll2 = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(poll1.body.next_cursor)}`)
      .set('Cookie', sessionCookie)

    expect(poll2.status).toBe(200)
    expect(
      poll2.body.documents.some((d: { id: string }) => d.id === lateDocId),
      'once the lag window has elapsed, the deferred change must appear'
    ).toBe(true)
  })

  it('proof 2: never returns a document the calling user cannot see (private doc from another user, or another workspace)', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()

    const privateDoc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility) VALUES ($1, 'wiki', 'Private Other-User Doc', $2, 'private') RETURNING id`,
      [testWorkspaceId, otherUserId]
    )
    const privateDocId = privateDoc.rows[0].id
    await pool.query(`UPDATE documents SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [privateDocId])

    const otherWorkspaceDoc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'wiki', 'Other Workspace Doc', $2) RETURNING id`,
      [otherWorkspaceId, otherUserId]
    )
    const otherWorkspaceDocId = otherWorkspaceDoc.rows[0].id
    await pool.query(`UPDATE documents SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [otherWorkspaceDocId])

    // Sanity check the fixtures are visible to a DB-level query at all (rules
    // out "the test asserts an absence that was never actually going to be
    // present for an unrelated reason").
    const sanity = await pool.query(
      `SELECT id FROM documents WHERE id = ANY($1::uuid[])`,
      [[privateDocId, otherWorkspaceDocId]]
    )
    expect(sanity.rows.length).toBe(2)

    const res = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(since)}`)
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    const returnedIds = res.body.documents.map((d: { id: string }) => d.id)
    expect(returnedIds).not.toContain(privateDocId)
    expect(returnedIds).not.toContain(otherWorkspaceDocId)
  })

  it('proof 3: the same change carries an identical dedupe_key across polls with overlapping windows', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()

    const docRes = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'wiki', 'Dedupe Doc', $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    const dedupeDocId = docRes.rows[0].id
    await pool.query(`UPDATE documents SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [dedupeDocId])

    // Two overlapping polls: both use the SAME `since`, so both windows cover
    // this change.
    const pollA = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(since)}`)
      .set('Cookie', sessionCookie)
    const pollB = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(since)}`)
      .set('Cookie', sessionCookie)

    expect(pollA.status).toBe(200)
    expect(pollB.status).toBe(200)

    const itemA = pollA.body.documents.find((d: { id: string }) => d.id === dedupeDocId)
    const itemB = pollB.body.documents.find((d: { id: string }) => d.id === dedupeDocId)

    expect(itemA, 'change must appear in the first overlapping poll').toBeDefined()
    expect(itemB, 'change must appear in the second overlapping poll').toBeDefined()
    expect(
      itemB.dedupe_key,
      'the same underlying change must carry the identical dedupe_key across overlapping polls, so a consumer can de-duplicate rather than double-act on it'
    ).toBe(itemA.dedupe_key)
  })

  it('includes document_history and comments in the window, each with their own dedupe_key', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()

    const docRes = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'issue', 'History And Comments Doc', $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    const docId = docRes.rows[0].id

    const historyRes = await pool.query(
      `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by) VALUES ($1, 'state', 'todo', 'in_progress', $2) RETURNING id`,
      [docId, testUserId]
    )
    const historyId = historyRes.rows[0].id
    await pool.query(`UPDATE document_history SET created_at = now() - interval '10 seconds' WHERE id = $1`, [historyId])

    const commentRes = await pool.query(
      `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content) VALUES ($1, gen_random_uuid(), $2, $3, 'a test comment') RETURNING id`,
      [docId, testUserId, testWorkspaceId]
    )
    const commentId = commentRes.rows[0].id
    await pool.query(`UPDATE comments SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [commentId])

    const res = await request(app)
      .get(`/api/change-feed?since=${encodeURIComponent(since)}`)
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    const historyItem = res.body.history.find((h: { id: number }) => h.id === historyId)
    const commentItem = res.body.comments.find((c: { id: string }) => c.id === commentId)

    expect(historyItem, 'document_history change must appear in the feed').toBeDefined()
    expect(historyItem.dedupe_key).toBe(`history:${historyId}`)
    expect(commentItem, 'comment must appear in the feed').toBeDefined()
    expect(commentItem.dedupe_key).toBe(`comment:${commentId}:${new Date(commentItem.updated_at).toISOString()}`)
  })

  it('rejects a missing or malformed since parameter', async () => {
    const missing = await request(app).get('/api/change-feed').set('Cookie', sessionCookie)
    expect(missing.status).toBe(400)

    const malformed = await request(app).get('/api/change-feed?since=not-a-date').set('Cookie', sessionCookie)
    expect(malformed.status).toBe(400)
  })
})
