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
 * by grep in `api/src/platform/webhooks/__tests__/publish-boundary.test.ts`.
 *
 * ── Publish timing: never before COMMIT (CodeRabbit, this PR) ────────────────
 * `documents.ts`/`issues.ts`'s create/update handlers wrap their write in an
 * explicit `BEGIN`/`COMMIT` and do more work after the row is written (association
 * inserts, sprint/program junction rows) that can still fail and roll the whole
 * transaction back. Publishing the moment the row is written — inside that still-
 * open transaction — would mean a subscriber sees `document.created` for a
 * document that a later failure in the SAME request then rolled back and never
 * actually persisted. So: whenever a caller passes a transaction `client`, it MUST
 * also pass `pendingEvents` (a plain array it owns) — this file pushes the derived
 * publish call onto that array instead of firing it, and the caller is
 * responsible for invoking every queued function AFTER `client.query('COMMIT')`
 * succeeds, and never invoking them on a path that rolls back. Passing `client`
 * without `pendingEvents` throws, so a future call site can't silently regress to
 * the before-commit timing this fix removes. Callers that never pass `client`
 * (projects.ts/programs.ts's create/update, and every router's plain-`pool`
 * delete) have no enclosing transaction to roll back, so those still publish
 * immediately — deferring them would only add complexity with no correctness
 * benefit.
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
 * Sprint derivation is implemented and unit-tested here even though none of the
 * *consolidated* primary create/update/delete endpoints (`POST /`, `PATCH /:id`,
 * `DELETE /:id` on each of the four routers) reaches it in practice — every one
 * of those filters to its own `document_type` (`updateDocument`'s
 * `documentTypeFilter: 'project'`/`'program'`, `createDocument`'s hardcoded
 * `documentType: 'issue'`/`'project'`/`'program'`, etc.), never `'sprint'`. That
 * is narrower than "no route in these four files ever writes a sprint document"
 * — CodeRabbit correctly caught that broader claim as false: `projects.ts`'s
 * `POST /:id/sprints` (a secondary, non-consolidated endpoint) genuinely creates
 * `document_type = 'sprint'` documents, alongside `routes/weeks.ts` and
 * `team.ts`'s allocation endpoint — see CHANGES.md's "secondary write sites
 * within the four consolidated routers" for the full list. If a sprint document
 * is ever updated through `documents.ts`'s generic `PATCH /api/documents/:id`
 * (the one primary endpoint with no `document_type` filter at all, which applies
 * to any `document_type`, including
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

/**
 * Fires `dispatch` immediately when there is no transaction client (nothing to
 * roll back), or queues it onto `pendingEvents` when there is — see the file
 * header's "Publish timing" note. Throws if `client` is present without
 * `pendingEvents`: that combination means a caller is inside a transaction but
 * has no way to defer, which would silently reintroduce publish-before-commit.
 */
function dispatchOrQueue(
  client: Queryable | undefined,
  pendingEvents: Array<() => void> | undefined,
  dispatch: () => void
): void {
  if (client === undefined) {
    dispatch();
    return;
  }
  if (!pendingEvents) {
    throw new Error(
      'documentService: a transaction client was passed without pendingEvents. ' +
        'Events must be deferred until after client.query(\'COMMIT\') succeeds, never fired ' +
        'while the transaction is still open — pass a pendingEvents array and flush it ' +
        'after COMMIT (never on a rollback path).'
    );
  }
  pendingEvents.push(dispatch);
}

/**
 * Runs every queued dispatch from a `pendingEvents` array (see
 * `CreateDocumentParams.pendingEvents`) after the caller's own
 * `client.query('COMMIT')` has succeeded. Call sites should use this rather
 * than iterating `pendingEvents` themselves (CodeRabbit, this PR): the write
 * this event describes already committed by the time flush runs, so a
 * subscriber that throws — `IEventBus.publish()` deliberately does not catch a
 * handler's own error, see `eventBus.ts`'s header comment — must not surface as
 * a failed request for a write that actually succeeded. Logs and continues to
 * the next queued event rather than losing the rest of the batch to one bad
 * subscriber. There is no ROLLBACK left to run at this point regardless; the
 * only options are "swallow and log" or "let the client wrongly see a 500 for
 * a commit that already happened," and the latter is strictly worse.
 */
export function flushPendingEvents(pendingEvents: Array<() => void>): void {
  for (const dispatch of pendingEvents) {
    try {
      dispatch();
    } catch (err) {
      console.error('documentService.flushPendingEvents: a post-commit event dispatch threw', err);
    }
  }
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
  /**
   * Required whenever `client` is passed: the derived event is pushed here
   * instead of published immediately. Flush (call every queued function) after
   * `client.query('COMMIT')` succeeds; never flush on a rollback path. See the
   * file header's "Publish timing" note.
   */
  pendingEvents?: Array<() => void>;
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

  dispatchOrQueue(params.client, params.pendingEvents, () => publishDocumentCreated(row));

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
  /** Required whenever `client` is passed — see `CreateDocumentParams.pendingEvents`. */
  pendingEvents?: Array<() => void>;
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
  dispatchOrQueue(params.client, params.pendingEvents, () =>
    publishDocumentUpdated(row, params.previousProperties ?? null, changedFields)
  );

  return row;
}

export interface DeleteDocumentParams {
  id: string;
  workspaceId: string;
  /** Matches the route's own filter, e.g. `'issue'`. Omit for an unfiltered delete. */
  documentTypeFilter?: string;
  client?: Queryable;
  /** Required whenever `client` is passed — see `CreateDocumentParams.pendingEvents`. */
  pendingEvents?: Array<() => void>;
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

  dispatchOrQueue(params.client, params.pendingEvents, () => {
    getEventBus().publish('document.deleted', row.workspace_id, {
      id: row.id,
      document_type: row.document_type,
    });
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
    const prevStatus = prevProps.status;
    const newStatus = newProps.status;
    const sprintNumber = Number(newProps.sprint_number);
    const isRealTransition =
      (newStatus === 'active' && prevStatus === 'planning') ||
      (newStatus === 'completed' && isSprintStatus(prevStatus) && prevStatus !== 'completed');

    if (isRealTransition && !Number.isFinite(sprintNumber)) {
      // A genuine planning->active or ->completed transition, but
      // `properties.sprint_number` is missing or not numeric — the event is
      // skipped silently below rather than published with a garbage
      // `sprint_number`. Logged (CodeRabbit, this PR) so a data-quality gap
      // like this is diagnosable instead of a webhook subscriber just never
      // seeing an event it should have.
      console.warn(
        `documentService: sprint ${row.id} had a real status transition (${String(prevStatus)} -> ` +
          `${String(newStatus)}) but properties.sprint_number was not a finite number ` +
          `(${JSON.stringify(newProps.sprint_number)}) — sprint.${newStatus === 'active' ? 'started' : 'completed'} not published`
      );
    }

    if (newStatus === 'active' && prevStatus === 'planning' && Number.isFinite(sprintNumber)) {
      bus.publish('sprint.started', row.workspace_id, {
        id: row.id,
        sprint_number: sprintNumber,
        status: 'active',
        previous_status: 'planning',
      });
    } else if (
      newStatus === 'completed' &&
      isSprintStatus(prevStatus) &&
      prevStatus !== 'completed' &&
      Number.isFinite(sprintNumber)
    ) {
      // `isSprintStatus` narrows `prevStatus` to the exact literal union
      // `sprint.completed`'s schema requires — no `as` cast needed. Without this
      // guard, a stored `properties.status` outside the three known values
      // (data drift, or a future status this file doesn't know about yet) would
      // reach `bus.publish()` and only be caught there, by the schema throwing —
      // correct but a needlessly late place to catch a value this function can
      // already see is wrong (CodeRabbit, this PR).
      bus.publish('sprint.completed', row.workspace_id, {
        id: row.id,
        sprint_number: sprintNumber,
        status: 'completed',
        previous_status: prevStatus,
      });
    }
  }
}

const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;
type SprintStatus = (typeof SPRINT_STATUSES)[number];

function isSprintStatus(value: unknown): value is SprintStatus {
  return typeof value === 'string' && (SPRINT_STATUSES as readonly string[]).includes(value);
}
