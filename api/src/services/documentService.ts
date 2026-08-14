/**
 * The domain write path for `documents` rows (PLUGFORGE.MD §2.6, §4 PF-301).
 *
 * PF-200 landed this file with exactly one function, `createDocument()`, backing
 * only the `/api/v1/documents` POST route — written as a service function on
 * purpose so that PF-301 (this ticket) could redirect other call sites here as a
 * MOVE, not a REWRITE. This is that redirect: `createDocument()` is extended (not
 * replaced) with the columns the four internal resource routers need, and
 * `updateDocument()` / `deleteDocument()` are new, so that `documents.ts`,
 * `issues.ts`, `projects.ts`, and `programs.ts` can all delegate their primary
 * create/update/delete document-write SQL here instead of running it inline.
 *
 * `publish()` (via `IEventBus`, `platform/webhooks/eventBus.ts`) is called ONLY
 * from this file — never from a route handler. That is the ticket's AC, verified
 * by grep in `api/src/services/__tests__/publish-boundary.test.ts`.
 *
 * ── Design choice: routes keep building their own SQL fragments ──────────────
 * `documents.ts`, `issues.ts`, `projects.ts`, and `programs.ts` each build a
 * dynamic `UPDATE ... SET` clause whose exact columns depend on which fields the
 * request touched — including, in `issues.ts`, raw SQL fragments with no bind
 * parameter at all (`started_at = now()`, chosen by `getTimestampUpdates()` based
 * on the state transition). Unifying that column-selection logic itself into one
 * generic function across four routers with different validation, different RACI
 * fields, and different association side-tables would be a rewrite of business
 * logic this ticket did not audit line by line — exactly the kind of blast radius
 * PLUGFORGE.MD's own risk table warns against for PF-301 ("smallest-possible
 * consolidation"). Instead, `updateDocument()`/`deleteDocument()` take the
 * *already-built* SQL fragments (the same `updates`/`values` arrays the routes
 * already assemble) and are the single place that (a) executes the statement,
 * (b) derives `changed_fields`, and (c) fires the event. The route keeps 100% of
 * its existing validation/authz/business logic; only the `client.query('UPDATE
 * documents SET ...')` call itself moves here. This is the literal instruction in
 * TRO-426: "Handlers keep their existing validation/authz — they just delegate
 * the actual write+event to the service instead of doing inline SQL."
 *
 * ── Event derivation ───────────────────────────────────────────────────────
 * `document.created`/`document.updated`/`document.deleted` fire for every write
 * through this file. `issue.created` derives from `document_type === 'issue'` on
 * create. `issue.assigned`/`issue.status_changed` derive from a diff of
 * `properties.assignee_id` / `properties.state` between the caller-supplied
 * "before" state and the post-write row, for `document_type === 'issue'`.
 * `sprint.started`/`sprint.completed` derive the same way from
 * `properties.status` for `document_type === 'sprint'`, per PF-300's pinned field
 * names (`platform/webhooks/events.ts`'s header comment, "Discovery task").
 * Sprint derivation is implemented and unit-tested here even though, at time of
 * writing, no route in the four consolidated routers writes a sprint document in
 * practice (sprint documents are owned by `routes/weeks.ts`, out of scope for
 * this ticket — see the PR body / CHANGES.md "Excluded write sites" list). If a
 * sprint document is ever updated through `documents.ts`'s generic
 * `PATCH /api/documents/:id` (which applies to any `document_type`, including
 * `sprint`), the derivation already fires correctly; `weeks.ts`'s own dedicated
 * sprint routes remain inline SQL until a follow-up ticket redirects them.
 *
 * Collab-server Yjs persistence (`api/src/collaboration/index.ts`) never calls
 * into this file and is explicitly excluded from event publication — see
 * `docs/architecture.md` for the defended reasoning (same shape as this file's
 * exclusion list).
 */

import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client.js';
import { getEventBus } from '../platform/webhooks/eventBus.js';

/** Either the shared pool or a checked-out client already inside a transaction. */
type Queryable = Pool | PoolClient;

/**
 * A `documents` row as read back via `RETURNING *`. Not every column the table
 * has — only the ones this file and its callers actually touch — but every field
 * here is asserted to exist on the real row `RETURNING *` produces.
 */
export interface DocumentRow {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  content: unknown;
  parent_id: string | null;
  position: number;
  properties: Record<string, unknown> | null;
  ticket_number: number | null;
  archived_at: Date | null;
  deleted_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  visibility: string;
}

/** Backward-compatible alias — PF-200's original export name. */
export type DocumentRecord = DocumentRow;

/**
 * The minimal fields event derivation needs. `createDocument`/`updateDocument`
 * are generic over `T extends DocumentEventFields` (default `DocumentRow`) so a
 * caller with its own narrower-or-wider `RETURNING *` / `SELECT *` projection
 * type (e.g. `issues.ts`'s `IssueDetailRow`, extended with `workspace_id` /
 * `document_type` — both genuinely present on that row, just not previously
 * declared because that file never needed to read them) can pass that type as
 * `T` and get it back directly, instead of this file returning a `DocumentRow`
 * the caller then has to reconcile with its own row type. Every query this file
 * runs is `RETURNING *` or `SELECT *`, so `T`'s extra declared fields are always
 * genuinely present on the real row — this generic only widens what TypeScript
 * is told is there, never what SQL actually returns.
 */
export interface DocumentEventFields {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  properties: Record<string, unknown> | null;
  created_by: string | null;
}

export interface CreateDocumentParams {
  workspaceId: string;
  title: string;
  documentType: string;
  properties?: Record<string, unknown>;
  createdByUserId?: string | null;
  /** Omit to let the column default (`NULL`) apply, matching routes that never set it. */
  parentId?: string | null;
  /** Omit to let the column default (`'workspace'`) apply. */
  visibility?: string;
  /** Pass the parsed TipTap JSON (or `null`); omitted entirely if `undefined`. */
  content?: unknown;
  /** Issue documents only; omitted entirely (column default `NULL`) otherwise. */
  ticketNumber?: number;
  /** Pass the transaction's checked-out client to participate in an existing BEGIN/COMMIT. */
  client?: Queryable;
}

/**
 * Builds an `INSERT INTO documents (...)` whose column list matches exactly the
 * fields the caller passed — the same shape each of the four routers' INSERT
 * statements already has (documents.ts includes parent_id/visibility/content;
 * issues.ts includes ticket_number; projects.ts/programs.ts include neither).
 * Building the column list dynamically (rather than always inserting every
 * column, with `NULL`/default placeholders for the rest) preserves each site's
 * existing reliance on the column's own `DEFAULT` — e.g. `visibility`'s
 * `DEFAULT 'workspace'` — instead of silently inserting an explicit `NULL` a
 * caller never asked for.
 */
export async function createDocument<T extends DocumentEventFields = DocumentRow>(
  params: CreateDocumentParams
): Promise<T> {
  const db = params.client ?? pool;

  const columns = ['workspace_id', 'document_type', 'title', 'properties', 'created_by'];
  const values: unknown[] = [
    params.workspaceId,
    params.documentType,
    params.title,
    JSON.stringify(params.properties ?? {}),
    params.createdByUserId ?? null,
  ];

  if (params.parentId !== undefined) {
    columns.push('parent_id');
    values.push(params.parentId);
  }
  if (params.visibility !== undefined) {
    columns.push('visibility');
    values.push(params.visibility);
  }
  if (params.content !== undefined) {
    columns.push('content');
    values.push(params.content === null ? null : JSON.stringify(params.content));
  }
  if (params.ticketNumber !== undefined) {
    columns.push('ticket_number');
    values.push(params.ticketNumber);
  }

  const placeholders = columns.map((_, i) => `$${i + 1}`);

  const result = await db.query<T>(
    `INSERT INTO documents (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  );

  const row = result.rows[0];
  if (!row) {
    // INSERT ... RETURNING with no WHERE clause always produces exactly one
    // row on success; reaching here means the INSERT itself failed silently
    // somehow, which is a server bug, not a caller error.
    throw new Error('documentService.createDocument: INSERT ... RETURNING produced no row');
  }

  publishDocumentCreated(row);

  return row;
}

export interface UpdateDocumentParams {
  id: string;
  workspaceId: string;
  /**
   * The already-built `SET` fragments, e.g. `['title = $1', 'properties = $2',
   * 'started_at = now()', 'updated_at = now()']` — exactly what the calling
   * route already assembles today. `updated_at = now()` is expected to already
   * be included by the caller (every consolidated route already pushes it as
   * its own last step); this function does not add it implicitly, so the SQL
   * this function runs is byte-for-byte what the route used to run directly.
   */
  setClauses: string[];
  /** Positional values for `setClauses`' `$1..$n` placeholders, in order. */
  values: unknown[];
  /**
   * Extra `WHERE` condition matching the route's own filter, e.g. `'project'`
   * for `projects.ts` (`AND document_type = 'project'`). Omit for routes whose
   * original UPDATE had no such filter (documents.ts's generic PATCH, issues.ts).
   */
  documentTypeFilter?: string;
  /**
   * The document's `properties` BEFORE this update, as already fetched by the
   * caller for its own diffing/validation. Required for issue/sprint event
   * derivation; omit only when the update never touches `properties` (event
   * derivation is skipped in that case since `changed_fields` won't include it).
   */
  previousProperties?: Record<string, unknown> | null;
  client?: Queryable;
}

export async function updateDocument<T extends DocumentEventFields = DocumentRow>(
  params: UpdateDocumentParams
): Promise<T> {
  const db = params.client ?? pool;

  const conditions = [`id = $${params.values.length + 1}`, `workspace_id = $${params.values.length + 2}`];
  const values = [...params.values, params.id, params.workspaceId];

  if (params.documentTypeFilter !== undefined) {
    conditions.push(`document_type = $${values.length + 1}`);
    values.push(params.documentTypeFilter);
  }

  const result = await db.query<T>(
    `UPDATE documents SET ${params.setClauses.join(', ')}
     WHERE ${conditions.join(' AND ')}
     RETURNING *`,
    values
  );

  const row = result.rows[0];
  if (!row) {
    // Every consolidated call site already verified the row exists (and matches
    // workspace/type) via a SELECT immediately before building setClauses, so
    // reaching here means that guard and this statement disagree — a bug, not
    // an expected "not found" path (routes already returned 404 earlier).
    throw new Error(
      `documentService.updateDocument: UPDATE ... RETURNING produced no row for id=${params.id}`
    );
  }

  const changedFields = extractChangedFields(params.setClauses);
  publishDocumentUpdated(row, params.previousProperties ?? null, changedFields);

  return row;
}

export interface DeleteDocumentParams {
  id: string;
  workspaceId: string;
  /** Matches the route's own filter, e.g. `'issue'`. Omit for an unfiltered delete. */
  documentTypeFilter?: string;
  client?: Queryable;
}

/** Returns the deleted row, or `null` if no matching row existed (caller returns its own 404). */
export async function deleteDocument(params: DeleteDocumentParams): Promise<DocumentRow | null> {
  const db = params.client ?? pool;

  const conditions = ['id = $1', 'workspace_id = $2'];
  const values: unknown[] = [params.id, params.workspaceId];

  if (params.documentTypeFilter !== undefined) {
    conditions.push(`document_type = $3`);
    values.push(params.documentTypeFilter);
  }

  const result = await db.query<DocumentRow>(
    `DELETE FROM documents WHERE ${conditions.join(' AND ')} RETURNING *`,
    values
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  getEventBus().publish('document.deleted', row.workspace_id, {
    id: row.id,
    document_type: row.document_type,
  });

  return row;
}

// ─── Event derivation (private) ────────────────────────────────────────────

/** Column names touched by this UPDATE, parsed from the caller's `setClauses`. */
function extractChangedFields(setClauses: string[]): string[] {
  const raw = setClauses
    .map((clause) => clause.split('=')[0]?.trim())
    .filter((field): field is string => !!field);
  // `updated_at` is bookkeeping on every write, not a meaningful application
  // field — excluded from the event payload unless it's literally the only
  // thing that changed (schema requires `changed_fields.length >= 1`).
  const meaningful = raw.filter((field) => field !== 'updated_at');
  return meaningful.length > 0 ? meaningful : raw;
}

function publishDocumentCreated(row: DocumentEventFields): void {
  const bus = getEventBus();

  bus.publish('document.created', row.workspace_id, {
    id: row.id,
    document_type: row.document_type,
    title: row.title,
    created_by: row.created_by,
  });

  if (row.document_type === 'issue') {
    const props = row.properties ?? {};
    bus.publish('issue.created', row.workspace_id, {
      id: row.id,
      title: row.title,
      state: (props.state as string | undefined) ?? 'backlog',
      priority: (props.priority as string | undefined) ?? 'medium',
      assignee_id: (props.assignee_id as string | null | undefined) ?? null,
    });
  }
}

function publishDocumentUpdated(
  row: DocumentEventFields,
  previousProperties: Record<string, unknown> | null,
  changedFields: string[]
): void {
  const bus = getEventBus();

  bus.publish('document.updated', row.workspace_id, {
    id: row.id,
    document_type: row.document_type,
    title: row.title,
    changed_fields: changedFields,
  });

  // Issue/sprint events derive from a `properties` diff — pointless (and, for
  // sprint.started, structurally invalid — see events.ts's `.refine()`) unless
  // properties actually changed and we have a "before" snapshot to diff against.
  if (!changedFields.includes('properties') || previousProperties === null) {
    return;
  }

  const prevProps = previousProperties;
  const newProps = row.properties ?? {};

  if (row.document_type === 'issue') {
    const prevState = prevProps.state as string | undefined;
    const newState = newProps.state as string | undefined;
    if (prevState !== undefined && newState !== undefined && prevState !== newState) {
      bus.publish('issue.status_changed', row.workspace_id, {
        id: row.id,
        state: newState,
        previous_state: prevState,
      });
    }

    const prevAssignee = (prevProps.assignee_id as string | null | undefined) ?? null;
    const newAssignee = (newProps.assignee_id as string | null | undefined) ?? null;
    if (prevAssignee !== newAssignee) {
      bus.publish('issue.assigned', row.workspace_id, {
        id: row.id,
        assignee_id: newAssignee,
        previous_assignee_id: prevAssignee,
      });
    }
  }

  if (row.document_type === 'sprint') {
    const prevStatus = prevProps.status as string | undefined;
    const newStatus = newProps.status as string | undefined;
    const sprintNumber = Number(newProps.sprint_number);

    if (newStatus === 'active' && prevStatus === 'planning' && Number.isFinite(sprintNumber)) {
      bus.publish('sprint.started', row.workspace_id, {
        id: row.id,
        sprint_number: sprintNumber,
        status: 'active',
        previous_status: 'planning',
      });
    } else if (
      newStatus === 'completed' &&
      prevStatus !== undefined &&
      prevStatus !== 'completed' &&
      Number.isFinite(sprintNumber)
    ) {
      bus.publish('sprint.completed', row.workspace_id, {
        id: row.id,
        sprint_number: sprintNumber,
        status: 'completed',
        previous_status: prevStatus as 'planning' | 'active' | 'completed',
      });
    }
  }
}
