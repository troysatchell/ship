import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { pool } from '../db/client.js'
import { createApp } from '../app.js'
import { sqlOf } from '../test/sql-of.js'

/**
 * Regression tests for FG-14 / TRO-332: document_associations had no cycle
 * protection at all. A-blocks-B-blocks-A (or the same shape with any other
 * relationship_type) was insertable through the existing API, and the moment
 * any code walks the association graph outward it loops until something times
 * out or the heap runs out.
 *
 * Migration 040 (`040_prevent_circular_associations.sql`) adds a
 * BEFORE INSERT OR UPDATE trigger, `prevent_circular_association_trigger`,
 * scoped PER relationship_type (see that migration's comment for the scope
 * reasoning) with a depth cap so a pathological graph fails fast.
 *
 * These tests write directly against `document_associations` via `pool`
 * (mirroring circular-reference.test.ts's style for the analogous
 * documents.parent_id trigger) because the defect and its fix both live at
 * the database layer — the API's own self-reference pre-check
 * (associations.ts:120) is a different, narrower guard that never reaches
 * this trigger for a 3+ node cycle.
 */
describe('document_associations cycle protection (FG-14 / TRO-332)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testWorkspaceName = `Assoc Cycle Test ${testRunId}`

  let testWorkspaceId: string
  let docAId: string
  let docBId: string
  let docCId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const docA = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title) VALUES ($1, 'wiki', 'Cycle Doc A') RETURNING id`,
      [testWorkspaceId]
    )
    docAId = docA.rows[0].id

    const docB = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title) VALUES ($1, 'wiki', 'Cycle Doc B') RETURNING id`,
      [testWorkspaceId]
    )
    docBId = docB.rows[0].id

    const docC = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title) VALUES ($1, 'wiki', 'Cycle Doc C') RETURNING id`,
      [testWorkspaceId]
    )
    docCId = docC.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [testWorkspaceId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [testWorkspaceId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId])
  })

  it('has actually applied the migration — the trigger exists on document_associations', async () => {
    // Verified against a database that has run the migration, not assumed
    // from the file (ticket proof item 4; DB-1 means `pnpm db:migrate` can
    // silently under-apply).
    const result = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'document_associations'::regclass AND tgname = 'prevent_circular_association_trigger'`
    )
    expect(result.rows.length, 'migration 040 must have run against this database').toBe(1)
  })

  it('rejects a two-node cycle: A blocks B, then B blocks A', async () => {
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'project')`,
      [docAId, docBId]
    )

    // Red before green: on unpatched document_associations (no migration 040)
    // this second insert succeeds silently — the whole point of this test.
    await expect(
      pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'project')`,
        [docBId, docAId]
      )
    ).rejects.toThrow(/Circular project reference detected/)
  })

  it('rejects a three-node cycle: A -> B -> C -> A', async () => {
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'sprint')`,
      [docAId, docBId]
    )
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'sprint')`,
      [docBId, docCId]
    )

    await expect(
      pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'sprint')`,
        [docCId, docAId]
      )
    ).rejects.toThrow(/Circular sprint reference detected/)
  })

  it('allows a legitimate deep chain within the depth cap', async () => {
    // 10 nodes, chained via 'program' — well under the 100-node cap.
    const chainIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const res = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title) VALUES ($1, 'wiki', $2) RETURNING id`,
        [testWorkspaceId, `Chain ${testRunId}-${i}`]
      )
      chainIds.push(res.rows[0].id)
    }

    for (let i = 0; i < chainIds.length - 1; i++) {
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'program')`,
        [chainIds[i], chainIds[i + 1]]
      )
    }

    const result = await pool.query(
      `SELECT count(*) FROM document_associations WHERE relationship_type = 'program' AND document_id = ANY($1::uuid[])`,
      [chainIds]
    )
    expect(Number(result.rows[0].count)).toBe(9)

    await pool.query('DELETE FROM document_associations WHERE document_id = ANY($1::uuid[])', [chainIds])
    await pool.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [chainIds])
  })

  it('does not cross-contaminate relationship types: a parent cycle is independent of an existing project edge covering the same pair', async () => {
    // A is already the project of B (from an earlier test in this file, or
    // fresh here) — a 'parent' edge from B to A must still be allowed, and
    // only a same-type 'parent' cycle back should be rejected.
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'parent') ON CONFLICT DO NOTHING`,
      [docAId, docCId]
    )

    // Cross-type coexistence: C is already reachable from A via 'parent'
    // above, and A is reachable from B via 'project'/'sprint' from earlier
    // tests — none of that should block a fresh, same-type-safe edge.
    await expect(
      pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'parent') ON CONFLICT DO NOTHING`,
        [docCId, docBId]
      )
    ).resolves.toBeDefined()

    // But a same-type 'parent' cycle back to A must still be rejected.
    await expect(
      pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'parent')`,
        [docBId, docAId]
      )
    ).rejects.toThrow(/Circular parent reference detected/)
  })
})

/**
 * Regression tests for TRO-344: `POST /:id/associations` used to map EVERY
 * exception in its catch-all — the circular-association trigger above, a
 * plain database failure, the max-depth check — to a bare
 * `500 {"error":"Failed to create association"}`. The frontend
 * (`useBlockingAssociations.ts`) inferred "this must be a cycle" from any 500
 * on this route, by elimination, since every other rejection path was
 * already a distinct 4xx — a correct-today-but-fragile derived inference.
 *
 * The fix (api/src/routes/associations.ts, `isCircularAssociationError`)
 * recognizes the trigger's specific message text
 * (`/^Circular \S+ reference detected:/`, matching migration 040's
 * `RAISE EXCEPTION 'Circular % reference detected: ...'`) and maps only that
 * case to a dedicated `409 {"error": "CIRCULAR_ASSOCIATION"}`, leaving every
 * other failure — including an unrelated forced 500 — on `500`.
 *
 * These tests go through the real Express route (supertest), unlike the
 * trigger tests above which write directly against `document_associations`
 * via `pool` — the thing under test here is the route's error mapping, not
 * the trigger itself.
 */
describe('POST /:id/associations — dedicated error code for the cycle guard (TRO-344)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `assoc-cycle-code-${testRunId}@ship.local`
  const testWorkspaceName = `Assoc Cycle Code Test ${testRunId}`

  let testWorkspaceId: string
  let testUserId: string
  let sessionCookie: string
  let csrfToken: string
  let docAId: string
  let docBId: string

  beforeAll(async () => {
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    )
    testWorkspaceId = workspaceResult.rows[0].id

    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Assoc Cycle Code Test User')
       RETURNING id`,
      [testEmail]
    )
    testUserId = userResult.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    )

    const docA = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'issue', 'Cycle Code Doc A', $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    docAId = docA.rows[0].id

    const docB = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by) VALUES ($1, 'issue', 'Cycle Code Doc B', $2) RETURNING id`,
      [testWorkspaceId, testUserId]
    )
    docBId = docB.rows[0].id

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

  it('a real cycle attempt returns 409 with the specific CIRCULAR_ASSOCIATION code', async () => {
    // A blocks B, then attempt B blocks A — the second call closes a cycle.
    const first = await request(app)
      .post(`/api/documents/${docAId}/associations`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ related_id: docBId, relationship_type: 'blocks' })
    expect(first.status, 'setup edge A-blocks-B must itself succeed').toBe(201)

    const res = await request(app)
      .post(`/api/documents/${docBId}/associations`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ related_id: docAId, relationship_type: 'blocks' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CIRCULAR_ASSOCIATION')
  })

  it('an unrelated forced 500 (a mocked DB error on the INSERT) still returns 500, not the cycle code', async () => {
    // Intercept only the INSERT this route performs; every other call
    // (session lookup, canAccessDocument, the related-doc existence check)
    // passes through to the real pool.query unchanged. Mirrors the
    // reassign-then-restore pattern in session-activity-race.test.ts, which
    // exists because pool.query's overloaded signatures collapse under
    // vi.spyOn(...).mockImplementation and this needs the real shape.
    const trueQuery = pool.query
    pool.query = function forcedFailureQuery(...args: unknown[]): unknown {
      const sql = sqlOf(args[0])
      if (sql.trim().startsWith('INSERT INTO document_associations')) {
        return Promise.reject(new Error('simulated database failure, unrelated to the cycle guard'))
      }
      // review-pattern-ok: pool.query's overloads collapse to a single
      // signature under Parameters<>/ReturnType<>, so forwarding to the real
      // implementation needs an unknown-typed cast on both sides, not `any`.
      return (trueQuery as (...a: unknown[]) => unknown).apply(pool, args)
    } as typeof pool.query

    try {
      const res = await request(app)
        .post(`/api/documents/${docAId}/associations`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ related_id: docBId, relationship_type: 'blocks' })

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('Failed to create association')
      expect(res.body.error).not.toBe('CIRCULAR_ASSOCIATION')
    } finally {
      pool.query = trueQuery
    }
  })
})
