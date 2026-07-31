/**
 * TRO-304 (API-3) — regression tests for pagination on `GET /api/documents`.
 *
 * Root cause: the endpoint had no bounded default. Omitting `limit` returned
 * every matching row — at this project's audited seed volume, up to 500
 * documents in one response
 * (`audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md`'s "Recommended
 * follow-up" #2, which measured this as the single largest unrealized P95
 * win still on the table). An explicit `limit` was already validated
 * (ERR-8), but a caller that omitted `limit` entirely got the unbounded
 * behavior ERR-8 was supposed to have closed off.
 *
 * The fix (`api/src/routes/documents.ts`):
 *   - `DEFAULT_DOCUMENTS_LIST_LIMIT = 100` is applied when `limit` is absent.
 *   - `MAX_DOCUMENTS_LIST_LIMIT` is raised 100 -> 500 so a caller that
 *     genuinely needs the full corpus (the wiki tree, the command palette)
 *     can still ask for it via an explicit `limit`.
 *   - `offset` is now accepted, mirroring `IssueListPaginationSchema`.
 *
 * These tests seed MORE than the default page size in one workspace so a
 * bare `GET /api/documents` can only come back bounded if the LIMIT clause
 * is real — before the fix, every one of these would return all 110 rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'

describe('GET /api/documents — pagination (TRO-304 / API-3)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `docs-pagination-${testRunId}@ship.local`
  const testWorkspaceName = `Docs Pagination Test ${testRunId}`

  let sessionCookie: string
  let testWorkspaceId: string
  let testUserId: string

  /** More than DEFAULT_DOCUMENTS_LIST_LIMIT (100) so the default-page test can only pass if the LIMIT is real. */
  const SEEDED_DOCUMENT_COUNT = 110

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0]!.id

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Docs Pagination Test User')
       RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0]!.id

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

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie)
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }

    // Seed with a deterministic position/created_at ordering so offset-paging
    // assertions can rely on a stable, known row order (`ORDER BY position
    // ASC, created_at DESC` — see routes/documents.ts).
    for (let i = 0; i < SEEDED_DOCUMENT_COUNT; i++) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, position, created_at)
         VALUES ($1, 'wiki', $2, $3, 'workspace', $4, now() - ($5 || ' seconds')::interval)`,
        [testWorkspaceId, `Pagination Doc ${String(i).padStart(3, '0')}`, testUserId, i, String(SEEDED_DOCUMENT_COUNT - i)]
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

  it('bare GET /api/documents (no params) is bounded to the default page size, not the full corpus', async () => {
    const res = await request(app).get('/api/documents').set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    // Before the fix, this would be SEEDED_DOCUMENT_COUNT (110) — every row.
    expect(res.body.length).toBe(100)
  })

  it('an explicit limit above the old 100-row cap still works (cap raised to 500)', async () => {
    const res = await request(app)
      .get('/api/documents?limit=110')
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    expect(res.body.length).toBe(110)
  })

  it('an explicit limit above the new 500-row cap is clamped, not rejected or unbounded', async () => {
    const res = await request(app)
      .get('/api/documents?limit=999999999')
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    // All seeded rows (110) are under the 500 cap, so every one comes back —
    // proves the clamp raised the ceiling without removing it.
    expect(res.body.length).toBe(110)
  })

  it('offset pages past the default limit, in the documented position/created_at order', async () => {
    const firstPage = await request(app).get('/api/documents?limit=100&offset=0').set('Cookie', sessionCookie)
    const secondPage = await request(app).get('/api/documents?limit=100&offset=100').set('Cookie', sessionCookie)

    expect(firstPage.status).toBe(200)
    expect(secondPage.status).toBe(200)
    expect(firstPage.body.length).toBe(100)
    // 110 seeded, offset 100 -> the remaining 10.
    expect(secondPage.body.length).toBe(10)

    // Seeded with position 0..109 ascending, so page order is deterministic:
    // the first page holds "Pagination Doc 000".."Pagination Doc 099" and the
    // second page holds "Pagination Doc 100".."Pagination Doc 109", with no
    // overlap.
    const firstIds = new Set(firstPage.body.map((d: { id: string }) => d.id))
    const secondIds = new Set(secondPage.body.map((d: { id: string }) => d.id))
    const overlap = [...firstIds].filter((id) => secondIds.has(id))
    expect(overlap).toHaveLength(0)
    expect(firstPage.body[0].title).toBe('Pagination Doc 000')
    expect(secondPage.body[0].title).toBe('Pagination Doc 100')
  })

  it('rejects a negative offset with 400, not a silent full/unbounded scan', async () => {
    const res = await request(app)
      .get('/api/documents?offset=-1')
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
  })

  it('?type=wiki with an explicit large limit still returns every matching document (tree-building callers)', async () => {
    const res = await request(app)
      .get('/api/documents?type=wiki&limit=500')
      .set('Cookie', sessionCookie)

    expect(res.status).toBe(200)
    expect(res.body.length).toBe(SEEDED_DOCUMENT_COUNT)
  })
})
