import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'

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
