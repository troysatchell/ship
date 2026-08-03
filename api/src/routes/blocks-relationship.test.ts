import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { generateOpenAPIDocument } from '../openapi/registry.js'
import '../openapi/schemas/index.js'

/**
 * Regression tests for FG-15 / TRO-333: Ship could express containment
 * (parent/project/sprint/program) but had no way to say "issue A blocks
 * issue B" — a dependency graph distinct from the containment tree.
 *
 * Migration 041 adds 'blocks' to the relationship_type enum. This suite
 * proves the ticket's stated acceptance criteria, including the PM-review
 * scope amendment (2026-08-03) that supersedes the original edit #2: 'blocks'
 * must NOT leak into belongs_to (document-crud.ts's containment-only
 * filter).
 */
describe('blocks relationship (FG-15 / TRO-333)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `blocks-${testRunId}@ship.local`
  const testWorkspaceName = `Blocks Test ${testRunId}`

  let sessionCookie: string
  let csrfToken: string
  let testWorkspaceId: string
  let testUserId: string
  let issueAId: string
  let issueBId: string
  let issueCId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Blocks Test User')
       RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const issueA = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, ticket_number, created_by)
       VALUES ($1, 'issue', 'Blocks Test Issue A', 9101, $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    issueAId = issueA.rows[0].id

    const issueB = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, ticket_number, created_by)
       VALUES ($1, 'issue', 'Blocks Test Issue B', 9102, $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    issueBId = issueB.rows[0].id

    const issueC = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, ticket_number, created_by)
       VALUES ($1, 'issue', 'Blocks Test Issue C', 9103, $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    issueCId = issueC.rows[0].id

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

  it('proof 1: POSTs a blocks association and round-trips it through GET', async () => {
    // Red before green: on the pre-migration enum / pre-edit zod schema, this
    // 400s with a zod "invalid_enum_value" error — 'blocks' was not a
    // recognized relationship_type at the validation layer.
    const postRes = await request(app)
      .post(`/api/documents/${issueAId}/associations`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ related_id: issueBId, relationship_type: 'blocks' })

    expect(postRes.status).toBe(201)
    expect(postRes.body.relationship_type).toBe('blocks')
    expect(postRes.body.document_id).toBe(issueAId)
    expect(postRes.body.related_id).toBe(issueBId)

    const getRes = await request(app)
      .get(`/api/documents/${issueAId}/associations`)
      .set('Cookie', sessionCookie)

    expect(getRes.status).toBe(200)
    const blocksEdge = getRes.body.find((a: { relationship_type: string; related_id: string }) => a.relationship_type === 'blocks' && a.related_id === issueBId)
    expect(blocksEdge, 'the blocks association must round-trip through GET').toBeDefined()
  })

  it('proof 2: the reverse query returns "blocked by" correctly', async () => {
    const reverseRes = await request(app)
      .get(`/api/documents/${issueBId}/reverse-associations?type=blocks`)
      .set('Cookie', sessionCookie)

    expect(reverseRes.status).toBe(200)
    const blockedByA = reverseRes.body.find((a: { document_id: string; relationship_type: string }) => a.document_id === issueAId && a.relationship_type === 'blocks')
    expect(blockedByA, 'issue B must show issue A in its reverse "blocked by" query').toBeDefined()
  })

  it('proof 3: FG-14 cycle protection rejects a blocks cycle', async () => {
    // A already blocks B (proof 1). B blocks A must be rejected as a cycle —
    // exercising migration 040's trigger against the newly-added 'blocks'
    // type specifically, not just the containment types it was built and
    // tested against in association-cycle-protection.test.ts.
    const res = await request(app)
      .post(`/api/documents/${issueBId}/associations`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ related_id: issueAId, relationship_type: 'blocks' })

    // The route's catch-all wraps a DB error as a 500 with a generic message
    // (associations.ts has no special-case for a trigger exception), so the
    // authoritative assertion is the DB-level rejection, not a specific
    // status code on this layer.
    expect(res.status).toBeGreaterThanOrEqual(400)

    const directInsert = pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'blocks')`,
      [issueBId, issueAId]
    )
    await expect(directInsert).rejects.toThrow(/Circular blocks reference detected/)
  })

  it('proof 5 (scope amendment): a blocks association does not leak into belongs_to, while GET .../associations still returns it', async () => {
    // C has no blocks edge yet — isolate from A/B's cycle-protection state.
    const postRes = await request(app)
      .post(`/api/documents/${issueCId}/associations`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ related_id: issueAId, relationship_type: 'blocks' })
    expect(postRes.status).toBe(201)

    // Red before the document-crud.ts containment filter: without it, this
    // 'blocks' edge would appear in the issue's belongs_to array returned by
    // GET /api/issues/:id, which 10+ web components consume as containment.
    const issueRes = await request(app)
      .get(`/api/issues/${issueCId}`)
      .set('Cookie', sessionCookie)

    expect(issueRes.status).toBe(200)
    const leaked = (issueRes.body.belongs_to || []).some((b: { type: string }) => b.type === 'blocks')
    expect(leaked, 'belongs_to must never contain a "blocks" entry').toBe(false)

    // But the generic associations GET must still show it — the edge exists,
    // it just isn't containment.
    const assocRes = await request(app)
      .get(`/api/documents/${issueCId}/associations?type=blocks`)
      .set('Cookie', sessionCookie)
    expect(assocRes.status).toBe(200)
    expect(assocRes.body.some((a: { relationship_type: string; related_id: string }) => a.relationship_type === 'blocks' && a.related_id === issueAId)).toBe(true)
  })

  it('proof 4: the generated OpenAPI document accepts "blocks" as a relationship_type', () => {
    const doc = generateOpenAPIDocument()
    const postOp = doc.paths?.['/documents/{id}/associations']?.post
    expect(postOp, 'POST /documents/{id}/associations must be registered').toBeDefined()

    const bodySchema = postOp?.requestBody as
      | { content?: Record<string, { schema?: { properties?: Record<string, { enum?: unknown[] }> } }> }
      | undefined
    const relationshipTypeEnum = bodySchema?.content?.['application/json']?.schema?.properties?.relationship_type?.enum

    expect(relationshipTypeEnum, 'relationship_type must be an inline enum in the generated spec').toBeDefined()
    expect(relationshipTypeEnum).toContain('blocks')
  })
})
