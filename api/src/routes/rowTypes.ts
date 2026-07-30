/**
 * Row interfaces for `pool.query<T>(...)` calls in the route handlers.
 *
 * TS-2 (TRO-207): `pg`'s `query()` defaults its row generic to `any`, so every
 * unannotated call site made `.rows[i].anything` implicitly `any` all the way
 * to the HTTP response. These interfaces describe the actual column lists the
 * routes select, verified against `api/src/db/schema.sql` and the SQL text
 * itself — not guessed.
 *
 * `DocumentRow` is the full `documents` table shape (schema.sql:106-162), for
 * `SELECT *` / `RETURNING *` call sites. Narrower interfaces below describe
 * specific projections (joins, aggregates, computed columns). Aggregate
 * columns from `COUNT(*)`/`SUM(...)` come back from node-postgres as `string`
 * (bigint), not `number` — modeled as such rather than guessed as numeric.
 *
 * `properties` is typed per-query using the matching `*Properties` type from
 * `@ship/shared` (already the authoritative shape for that JSONB column) when
 * the query is scoped to one `document_type`; `Record<string, unknown>` when
 * a query can return mixed document types.
 */
import type {
  IssueProperties,
  ProjectProperties,
  ProgramProperties,
  WeekProperties,
} from '@ship/shared';

/** Full `documents` row — see schema.sql:106-162. */
export interface DocumentRow {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  content: unknown;
  yjs_state: Buffer | null;
  parent_id: string | null;
  position: number;
  properties: Record<string, unknown>;
  ticket_number: number | null;
  archived_at: Date | null;
  deleted_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  reopened_at: Date | null;
  converted_to_id: string | null;
  converted_from_id: string | null;
  converted_at: Date | null;
  converted_by: string | null;
  original_type: string | null;
  conversion_count: number;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  visibility: 'private' | 'workspace';
}

/** `documents` row narrowed to `document_type = 'project'`. */
export interface ProjectDocumentRow extends DocumentRow {
  properties: ProjectProperties;
}

/** `documents` row narrowed to `document_type = 'issue'`. */
export interface IssueDocumentRow extends DocumentRow {
  properties: IssueProperties;
}

/** `documents` row narrowed to `document_type = 'program'`. */
export interface ProgramDocumentRow extends DocumentRow {
  properties: ProgramProperties;
}

/** `documents` row narrowed to `document_type = 'sprint'` (a "Week" in product terms). */
export interface SprintDocumentRow extends DocumentRow {
  properties: WeekProperties;
}
