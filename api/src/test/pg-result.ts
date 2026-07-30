import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Build a correctly shaped `pg` result for a mocked `pool.query`.
 *
 * Mocked queries were previously fed object literals cast with `as any`, which switched
 * off checking on the exact thing the test is asserting about — the row shape. A renamed
 * or removed column then goes unnoticed until runtime (findings TS-4, non-null and cast
 * count; TS-8, test-side casts decoupling tests from real shapes).
 *
 * Usage: `vi.mocked(pool.query).mockResolvedValueOnce(pgResult([{ id: 'x' }]))`
 */
export function pgResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}
