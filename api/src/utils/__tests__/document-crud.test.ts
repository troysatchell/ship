/**
 * Regression test for TRO-183 [DB-8].
 *
 * `getBelongsToAssociationsBatch` filtered with `da.document_id = ANY($1)`,
 * which gives the planner no way to see the array's cardinality at plan
 * time - measured at rows=25 estimated vs rows=707 actual (a 28x
 * underestimate) against the audit's seeded volume, and it kept picking a
 * sequential scan over the unused `idx_document_associations_document_id`
 * index as a result.
 *
 * The fix rewrites the filter as a `JOIN (VALUES ...)`, which gives the
 * planner the batch's literal size. This is NOT a red-before-green test -
 * behavior must not change - so it runs the pre-TRO-183 query (`= ANY($1)`,
 * copied here before it was replaced) side by side with the live function
 * and asserts the resulting maps are identical, including: multiple
 * relationship types on one document, a document with zero associations,
 * and a caller passing a duplicate id (which `= ANY($1)` treats as a no-op
 * set-membership test, so the rewrite must too).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../db/client.js';
import { getBelongsToAssociationsBatch, type BelongsToEntry } from '../document-crud.js';

interface OldBatchRow {
  document_id: string;
  id: string;
  type: 'program' | 'project' | 'sprint' | 'parent';
  title: string | null;
  color: string | null;
}

/** The pre-TRO-183 query: `document_id = ANY($1)`, unchanged from before the rewrite. */
async function oldGetBelongsToAssociationsBatch(
  documentIds: string[]
): Promise<Map<string, BelongsToEntry[]>> {
  if (documentIds.length === 0) return new Map();

  const result = await pool.query<OldBatchRow>(
    `SELECT da.document_id, da.related_id as id, da.relationship_type as type,
            d.title, d.properties->>'color' as color
     FROM document_associations da
     LEFT JOIN documents d ON da.related_id = d.id
     WHERE da.document_id = ANY($1)
     ORDER BY da.document_id, da.relationship_type, da.created_at`,
    [documentIds]
  );

  const map = new Map<string, BelongsToEntry[]>();
  for (const row of result.rows) {
    let entries = map.get(row.document_id);
    if (!entries) {
      entries = [];
      map.set(row.document_id, entries);
    }
    entries.push({
      id: row.id,
      type: row.type,
      title: row.title || undefined,
      color: row.color || undefined,
    });
  }
  return map;
}

/** Map -> plain object so `toEqual` gives a readable diff on failure. */
function toPlainObject<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries(map.entries());
}

describe('getBelongsToAssociationsBatch (TRO-183 / DB-8)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let workspaceId: string;
  let programId: string;
  let projectId: string;
  let issueWithBothId: string;
  let issueWithOneId: string;
  let issueWithNoneId: string;

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`DB-8 Batch Test ${testRunId}`]
    );
    workspaceId = workspace.rows[0].id;

    const program = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, properties)
       VALUES ($1, 'program', 'DB-8 Program', 'workspace', $2) RETURNING id`,
      [workspaceId, JSON.stringify({ color: '#ff0000' })]
    );
    programId = program.rows[0].id;

    const project = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility)
       VALUES ($1, 'project', 'DB-8 Project', 'workspace') RETURNING id`,
      [workspaceId]
    );
    projectId = project.rows[0].id;

    const issueWithBoth = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility)
       VALUES ($1, 'issue', 'DB-8 Issue With Both', 'workspace') RETURNING id`,
      [workspaceId]
    );
    issueWithBothId = issueWithBoth.rows[0].id;

    const issueWithOne = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility)
       VALUES ($1, 'issue', 'DB-8 Issue With One', 'workspace') RETURNING id`,
      [workspaceId]
    );
    issueWithOneId = issueWithOne.rows[0].id;

    const issueWithNone = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility)
       VALUES ($1, 'issue', 'DB-8 Issue With None', 'workspace') RETURNING id`,
      [workspaceId]
    );
    issueWithNoneId = issueWithNone.rows[0].id;

    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program'), ($1, $3, 'project')`,
      [issueWithBothId, programId, projectId]
    );
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
      [issueWithOneId, projectId]
    );
    // issueWithNoneId deliberately has no associations.
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  it('matches the old = ANY($1) query across multiple documents with varied association counts', async () => {
    const ids = [issueWithBothId, issueWithOneId, issueWithNoneId];
    const [oldMap, newMap] = await Promise.all([
      oldGetBelongsToAssociationsBatch(ids),
      getBelongsToAssociationsBatch(ids),
    ]);

    expect(toPlainObject(newMap)).toEqual(toPlainObject(oldMap));

    // Pin the actual shape too, in case both implementations agreed on a
    // wrong answer.
    expect(newMap.get(issueWithBothId)).toEqual(
      expect.arrayContaining([
        { id: programId, type: 'program', title: 'DB-8 Program', color: '#ff0000' },
        { id: projectId, type: 'project', title: 'DB-8 Project', color: undefined },
      ])
    );
    expect(newMap.get(issueWithBothId)).toHaveLength(2);
    expect(newMap.get(issueWithOneId)).toEqual([
      { id: projectId, type: 'project', title: 'DB-8 Project', color: undefined },
    ]);
    // A document with zero associations gets no entry in the map at all -
    // callers do `associationsMap.get(id) || []`.
    expect(newMap.has(issueWithNoneId)).toBe(false);
  });

  it('treats a duplicate id in the input the same way = ANY($1) does (no duplicated rows)', async () => {
    const idsWithDuplicate = [issueWithBothId, issueWithBothId, issueWithOneId];
    const [oldMap, newMap] = await Promise.all([
      oldGetBelongsToAssociationsBatch(idsWithDuplicate),
      getBelongsToAssociationsBatch(idsWithDuplicate),
    ]);

    expect(toPlainObject(newMap)).toEqual(toPlainObject(oldMap));
    expect(newMap.get(issueWithBothId)).toHaveLength(2);
  });

  it('returns an empty map for an empty id list, same as before', async () => {
    const result = await getBelongsToAssociationsBatch([]);
    expect(result.size).toBe(0);
  });
});
