/**
 * Route-level coverage for `/api/programs` create/update/delete (TRO-426 / PF-301).
 *
 * Before this ticket, `programs.ts`'s POST/PATCH/DELETE handlers had zero
 * dedicated route tests — `rowTypes.test.ts` covers only the pure
 * `extractProgramFromRow` mapper function, never the HTTP layer. That's a real
 * pre-existing coverage gap this ticket inherited risk from: `programs.ts` is
 * one of the four routers this ticket redirects onto `documentService`, so its
 * write path changed, and nothing but this file would have caught a regression
 * in it. Real Postgres (no mocked pool), matching `routes/issues.test.ts` /
 * `routes/documents.test.ts`'s convention — proves the consolidated write path
 * against real SQL, not a hand-shaped mock response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { getEventBus, type EventEnvelope } from '../platform/webhooks/eventBus.js'

describe('Programs API', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `programs-test-${testRunId}@ship.local`
  const testWorkspaceName = `Programs Test ${testRunId}`

  let sessionCookie: string
  let csrfToken: string
  let testWorkspaceId: string
  let testUserId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      testWorkspaceName,
    ])
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Programs Test User')
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

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie)
    csrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) {
      sessionCookie = `${sessionCookie}; ${connectSidCookie}`
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [testWorkspaceId])
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId])
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  describe('POST /api/programs', () => {
    it('creates a program and publishes document.created via IEventBus', async () => {
      const bus = getEventBus()
      const documentCreatedEvents: EventEnvelope[] = []
      const unsubscribe = bus.subscribe('document.created', (event) => documentCreatedEvents.push(event))

      let res: request.Response
      try {
        res = await request(app)
          .post('/api/programs')
          .set('Cookie', sessionCookie)
          .set('x-csrf-token', csrfToken)
          .send({ title: 'Growth Program' })
      } finally {
        unsubscribe()
      }

      expect(res.status).toBe(201)
      // extractProgramFromRow() maps the `title` column to a `name` field.
      expect(res.body.name).toBe('Growth Program')
      expect(res.body.id).toBeDefined()

      const created = documentCreatedEvents.find((e) => (e.data as { id: string }).id === res.body.id)
      expect(created).toBeDefined()
      expect((created?.data as { document_type: string }).document_type).toBe('program')
      expect(created?.workspace_id).toBe(testWorkspaceId)

      // Confirm the row actually landed via documentService's dynamic INSERT
      // (not just the JSON response) — parent_id/content/ticket_number are all
      // omitted by programs.ts, so the column defaults should apply.
      const dbRow = await pool.query('SELECT document_type, parent_id, ticket_number FROM documents WHERE id = $1', [
        res.body.id,
      ])
      expect(dbRow.rows[0].document_type).toBe('program')
      expect(dbRow.rows[0].parent_id).toBeNull()
      expect(dbRow.rows[0].ticket_number).toBeNull()
    })
  })

  describe('PATCH /api/programs/:id', () => {
    let testProgramId: string

    beforeAll(async () => {
      const programResult = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
         VALUES ($1, 'program', 'Program To Update', $2, $3)
         RETURNING id`,
        [testWorkspaceId, JSON.stringify({ color: '#6366f1' }), testUserId]
      )
      testProgramId = programResult.rows[0].id
    })

    it('updates a program and publishes document.updated via IEventBus', async () => {
      const bus = getEventBus()
      const documentUpdatedEvents: EventEnvelope[] = []
      const unsubscribe = bus.subscribe('document.updated', (event) => documentUpdatedEvents.push(event))

      let res: request.Response
      try {
        res = await request(app)
          .patch(`/api/programs/${testProgramId}`)
          .set('Cookie', sessionCookie)
          .set('x-csrf-token', csrfToken)
          .send({ title: 'Renamed Program', color: '#00ff00' })
      } finally {
        unsubscribe()
      }

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Program')
      expect(res.body.color).toBe('#00ff00')

      const updated = documentUpdatedEvents.find((e) => (e.data as { id: string }).id === testProgramId)
      expect(updated).toBeDefined()
      expect((updated?.data as { changed_fields: string[] }).changed_fields).toEqual(
        expect.arrayContaining(['title', 'properties'])
      )
    })

    it('returns 404 for a non-existent program', async () => {
      const res = await request(app)
        .patch(`/api/programs/00000000-0000-0000-0000-000000000000`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ title: 'No Such Program' })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/programs/:id', () => {
    it('deletes a program and publishes document.deleted via IEventBus', async () => {
      const programResult = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by)
         VALUES ($1, 'program', 'Program To Delete', $2)
         RETURNING id`,
        [testWorkspaceId, testUserId]
      )
      const programId = programResult.rows[0].id

      const bus = getEventBus()
      const documentDeletedEvents: EventEnvelope[] = []
      const unsubscribe = bus.subscribe('document.deleted', (event) => documentDeletedEvents.push(event))

      let res: request.Response
      try {
        res = await request(app)
          .delete(`/api/programs/${programId}`)
          .set('Cookie', sessionCookie)
          .set('x-csrf-token', csrfToken)
      } finally {
        unsubscribe()
      }

      expect(res.status).toBe(204)

      const deleted = documentDeletedEvents.find((e) => (e.data as { id: string }).id === programId)
      expect(deleted).toBeDefined()
      expect((deleted?.data as { document_type: string }).document_type).toBe('program')

      const dbRow = await pool.query('SELECT id FROM documents WHERE id = $1', [programId])
      expect(dbRow.rows).toHaveLength(0)
    })

    it('returns 404 for a non-existent program', async () => {
      const res = await request(app)
        .delete(`/api/programs/00000000-0000-0000-0000-000000000000`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)

      expect(res.status).toBe(404)
    })
  })
})
