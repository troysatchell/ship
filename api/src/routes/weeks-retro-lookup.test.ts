/**
 * Regression test for TRO-183 [DB-6].
 *
 * `GET /api/weeks` computed `has_retro` / `retro_outcome` / `retro_id` with
 * three separate correlated subqueries against `document_associations`, each
 * re-running the identical `related_id = d.id AND relationship_type =
 * 'sprint'` join. Two of the three (`retro_outcome`, `retro_id`) used
 * `LIMIT 1`, which made the planner favor a zero-startup-cost Seq Scan over
 * the existing `idx_document_associations_related_type` index - measured at
 * `Rows Removed by Filter: 803` per subquery, twice, on every row.
 *
 * `weeks.ts` now computes all three fields from one `LEFT JOIN LATERAL`
 * using `MAX()` instead of `LIMIT 1` (an aggregate has to see every matching
 * row regardless, so its cost model prefers the index - see the PR body for
 * before/after EXPLAIN).
 *
 * This is NOT a red-before-green test: the old and new SQL are both run here,
 * side by side, specifically to pin that behavior did not change. A sprint
 * has at most one weekly_review with a non-null `outcome` (enforced at
 * creation - see weeks.ts POST /:id/review), so this covers both the
 * has-a-match and no-match cases, which is the full domain for this
 * predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';

interface RetroLookupRow {
  has_retro: boolean;
  retro_outcome: string | null;
  retro_id: string | null;
}

/** The pre-TRO-183 query, standalone: `d.id` in the real mega-query becomes `$1` here. */
async function oldRetroLookup(sprintId: string): Promise<RetroLookupRow> {
  const result = await pool.query<RetroLookupRow>(
    `SELECT
       (SELECT COUNT(*) > 0 FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = $1 AND rda.relationship_type = 'sprint'
        WHERE rt.properties->>'outcome' IS NOT NULL) as has_retro,
       (SELECT rt.properties->>'outcome' FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = $1 AND rda.relationship_type = 'sprint'
        WHERE rt.properties->>'outcome' IS NOT NULL LIMIT 1) as retro_outcome,
       (SELECT rt.id FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = $1 AND rda.relationship_type = 'sprint'
        WHERE rt.properties->>'outcome' IS NOT NULL LIMIT 1) as retro_id`,
    [sprintId]
  );
  const [row] = result.rows;
  if (!row) throw new Error(`oldRetroLookup returned no row for sprint ${sprintId}`);
  return row;
}

/** The TRO-183 rewrite, standalone the same way. Copied from weeks.ts's LATERAL join. */
async function newRetroLookup(sprintId: string): Promise<RetroLookupRow> {
  const result = await pool.query<RetroLookupRow>(
    `SELECT
       (retro.id IS NOT NULL) as has_retro,
       retro.outcome as retro_outcome,
       retro.id as retro_id
     FROM (SELECT $1::uuid as id) d
     LEFT JOIN LATERAL (
       SELECT MAX(rt.id::text)::uuid AS id, MAX(rt.properties->>'outcome') AS outcome
       FROM document_associations rda
       JOIN documents rt ON rt.id = rda.document_id
       WHERE rda.related_id = d.id AND rda.relationship_type = 'sprint'
         AND rt.properties->>'outcome' IS NOT NULL
     ) retro ON true`,
    [sprintId]
  );
  const [row] = result.rows;
  if (!row) throw new Error(`newRetroLookup returned no row for sprint ${sprintId}`);
  return row;
}

describe('weeks.ts retro lookup rewrite (TRO-183 / DB-6)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let workspaceId: string;
  let sprintWithRetroId: string;
  let sprintWithoutRetroId: string;
  let reviewDocId: string;

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`DB-6 Retro Lookup Test ${testRunId}`]
    );
    workspaceId = workspace.rows[0].id;

    const sprintWithRetro = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'sprint', 'Sprint With Retro', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ sprint_number: 1 })]
    );
    sprintWithRetroId = sprintWithRetro.rows[0].id;

    const sprintWithoutRetro = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'sprint', 'Sprint Without Retro', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ sprint_number: 2 })]
    );
    sprintWithoutRetroId = sprintWithoutRetro.rows[0].id;

    // A weekly_review with a non-null `outcome`, associated to the sprint via
    // relationship_type='sprint' - the shape both the old and new SQL match on.
    const reviewDoc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'weekly_review', 'Sprint 1 Review', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ outcome: 'validated', plan_validated: true })]
    );
    reviewDocId = reviewDoc.rows[0].id;

    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'sprint')`,
      [reviewDocId, sprintWithRetroId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  it('matches the old subquery result when a matching review exists', async () => {
    const [oldResult, newResult] = await Promise.all([
      oldRetroLookup(sprintWithRetroId),
      newRetroLookup(sprintWithRetroId),
    ]);

    expect(newResult).toEqual(oldResult);
    // Pin the actual values too, not just old===new, in case both were wrong
    // in the same way.
    expect(newResult).toEqual({
      has_retro: true,
      retro_outcome: 'validated',
      retro_id: reviewDocId,
    });
  });

  it('matches the old subquery result when no review matches (the common case)', async () => {
    const [oldResult, newResult] = await Promise.all([
      oldRetroLookup(sprintWithoutRetroId),
      newRetroLookup(sprintWithoutRetroId),
    ]);

    expect(newResult).toEqual(oldResult);
    expect(newResult).toEqual({
      has_retro: false,
      retro_outcome: null,
      retro_id: null,
    });
  });
});
