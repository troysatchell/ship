/**
 * `/api/v1/issues` — PF-201 (Linear TRO-400, PLUGFORGE.MD §4).
 *
 * `GET /` (cursor-paginated, keyset) over `documents WHERE document_type =
 * 'issue'` — a TYPED view: `state`/`priority`/`assignee_id` are lifted out of
 * the `properties` JSONB blob into top-level response fields, rather than
 * left for the caller to dig `properties.state` etc. out themselves (the
 * ticket's own AC wording). Read-only in this ticket — no POST/PATCH here
 * (`issues:write` is registered in `ScopeRegistry` for a later ticket to use,
 * not consumed by this file).
 *
 * Property-name provenance (derived, not guessed — CLAUDE.md's claim-
 * provenance rule): `shared/src/types/document.ts`'s `IssueProperties`
 * interface names these exact keys — `state: IssueState`, `priority:
 * IssuePriority`, `assignee_id?: string | null` — and the internal
 * `api/src/routes/issues.ts`'s `extractIssueListItemFromRow` reads the same
 * three keys off `documents.properties` with the same fallback defaults
 * ('backlog' / 'medium' / null) used below. Both sources agree; neither was
 * guessed. The PRD block's prose says "assignee" — the actual property name
 * in both `shared/src/types` and the JSONB is `assignee_id`, not `assignee`;
 * this file uses the real key.
 *
 * Follows `resources/documents.ts`'s conventions exactly (see that file's
 * header for the fuller rationale): cursor pagination (`../pagination.ts`),
 * `resolvePrincipalWorkspaceId` for workspace scoping, `requireScope`, the
 * `ApiError` shape, the `{data, next_cursor}` list envelope. No `.openapi()`
 * annotations / `registerPath` call yet — PF-202's v1 OpenAPI registry has
 * not landed (see this ticket's CHANGES.md entry for the checked-immediately-
 * before-finishing confirmation).
 *
 * Deliberately does NOT include a raw `properties` field alongside the typed
 * ones: this is meant to read as a typed resource, not a JSONB passthrough
 * with three fields duplicated — matching how the internal
 * `extractSprintFromRow`/`extractIssueListItemFromRow` in `routes/weeks.ts`/
 * `routes/issues.ts` also flatten every known property to the top level
 * rather than leaving a nested blob next to the flattened copies.
 */

import { Router } from 'express';
import type { Request, Router as RouterType } from 'express';
import { z } from 'zod';
import type { IssueState, IssuePriority } from '@ship/shared';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../../../oauth/bearerAuth.js';
import { requireScope } from '../../../scopes/requireScope.js';
import { rateLimitBuckets } from '../../../ratelimit/middleware.js';
import { asyncHandler } from '../errorMiddleware.js';
import { forbiddenError, notFoundError, serverError, validationFailedError } from '../errors.js';
import { encodeCursor, decodeCursor, preciseTimestamp, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';
import { updateDocument, flushPendingEvents, type DocumentEventFields } from '../../../../services/documentService.js';
import { getTimestampUpdates, logDocumentChange } from '../../../../utils/document-crud.js';

export const issuesRouter: RouterType = Router();

/** Same defensive fallback pattern as `resources/documents.ts`'s own
 * `requestIdOf` — see that file's header for why this is a two-line
 * duplicate rather than a shared import. */
function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/** `GET /api/v1/issues` query params — identical shape to `documents.ts`'s
 * list query, minus `type` (fixed to `'issue'` by this resource).
 *
 * `export`ed (PF-203, Linear TRO-404 — closing the registration gap this
 * ticket's brief flagged: this resource predates PF-202 and was never
 * retrofitted) purely so `platform/openapi/schemas/issues.ts` can import and
 * `registerPath` it, matching `resources/documents.ts`'s existing
 * export-for-schema-file convention. No route-handling logic changed. */
export const ListIssuesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
  // PF-205 (Linear TRO-414) — mirrors `getIssuesByAssignee()`
  // (`agent/src/shipClient.ts:415-426`) -> internal
  // `GET /api/issues?assignee_id=...`. A plain equality filter on the
  // `assignee_id` property — the internal route additionally accepts the
  // literal strings `'null'`/`'unassigned'` to mean "no assignee"
  // (`routes/issues.ts:400-401`), which this v1 filter deliberately does NOT
  // replicate: the PRD block asks only for "an `?assignee_id=` filter", and
  // this file's `assignee_id` is always a UUID column value here (never a
  // sentinel string) per this resource's own `IssueRowProperties` typing.
  assignee_id: z.string().uuid().optional(),
});

/** The `properties` JSONB keys this resource reads — a narrow slice of the
 * full `IssueProperties` (`shared/src/types/document.ts`), matching exactly
 * what the ticket's AC asks to be lifted to the top level. */
interface IssueRowProperties {
  state?: IssueState;
  priority?: IssuePriority;
  assignee_id?: string | null;
}

interface IssueRow {
  id: string;
  title: string;
  properties: IssueRowProperties | null;
  created_at: Date;
  updated_at: Date;
  /** `created_at::text` — cursor-internal only (TRO-602). */
  created_at_precise: string;
}

/** `updateDocument<T>()` (`documentService.ts`) requires `T extends
 *  DocumentEventFields` (`id`/`workspace_id`/`document_type`/`title`/
 *  `properties`/`created_by`) so it can derive `document.updated`/
 *  `issue.status_changed` events from the returned row — its `properties`
 *  is typed `Record<string, unknown> | null`, incompatible with plain
 *  `IssueRow`'s narrower `IssueRowProperties | null` (an interface can't
 *  extend both without a property-type clash, confirmed by trying it: `tsc`
 *  rejects the extension outright). Adds only the two timestamp fields the
 *  `PATCH /:id` handler below needs for its response — it builds that
 *  response from `newProps` (the object it already constructed and sent to
 *  Postgres) plus `id`/`title`/`created_at`/`updated_at` off this row,
 *  rather than reusing `serializeIssue()` (which expects the narrower
 *  `IssueRowProperties` type `GET /` already returns). */
interface IssuePatchRow extends DocumentEventFields {
  created_at: Date;
  updated_at: Date;
}

/** `IssueState`'s exact literal values (`@ship/shared`), as a zod enum —
 *  PF-703 (Linear TRO-435), for `PATCH /:id`'s body validation. `export`ed
 *  so `platform/openapi/schemas/issues.ts` can register it, same
 *  export-for-schema-file convention as `ListIssuesQuerySchema` above. */
export const IssueStateSchema = z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);

/** `PATCH /api/v1/issues/:id` request body (PF-703, Linear TRO-435) — the
 * gate's sdk-mode `applyIssueTransition` write
 * (`agent/src/shipClient.ts`'s `GateShipClient`). `state` only: this route
 * exists for exactly one caller (`gate.ts`'s `acceptProposedTransition`,
 * itself only ever applying transitions where `field === 'state'` — see
 * that function's own "only field: 'state' is supported today" comment).
 *
 * Deliberately does NOT replicate the internal `PATCH /api/issues/:id`
 * route's (`routes/issues.ts`) title/priority/assignee_id/belongs_to
 * fields, or its "incomplete children" confirmation gate for closing a
 * parent issue with open sub-issues (`confirm_orphan_children`) — a
 * disclosed scope narrowing (CHANGES.md, TRO-435), same "disclosed
 * limitation" posture PF-702 used for sdk-mode `getDocument()`, not a
 * silent gap. A future ticket that needs the fuller update surface (or a
 * public-API equivalent of the orphan-children confirmation flow) extends
 * this schema and handler rather than this ticket porting a 240-line
 * handler for a caller that only ever sends `state`. */
export const UpdateIssueRequestSchema = z.object({
  state: IssueStateSchema,
});

/** Defaults match `IssueState`/`IssuePriority`'s implicit defaults elsewhere
 * in this codebase: `createIssueSchema` (`routes/issues.ts`) defaults
 * `state: 'backlog'`, `priority: 'medium'` at creation time, and
 * `extractIssueListItemFromRow` falls back to the same two values when
 * `properties` predates those defaults. `assignee_id` has no default state —
 * `null` means genuinely unassigned. */
function serializeIssue(row: IssueRow) {
  const props = row.properties ?? {};
  return {
    id: row.id,
    title: row.title,
    document_type: 'issue' as const,
    state: props.state ?? 'backlog',
    priority: props.priority ?? 'medium',
    assignee_id: props.assignee_id ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ─── GET /api/v1/issues ─────────────────────────────────────────────────

issuesRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('issues:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = ListIssuesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'Invalid query parameters.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }
    const { limit, cursor, assignee_id } = parseResult.data;

    let decodedCursor: KeysetCursor | null = null;
    if (cursor !== undefined) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw validationFailedError(requestId, 'Invalid cursor.', {
          fieldErrors: { cursor: ['cursor is not a valid opaque cursor'] },
        });
      }
    }

    const principal = req.principal;
    if (!principal) {
      // Unreachable in practice — bearerAuth never calls next() without
      // setting req.principal — but TypeScript can't see that guarantee
      // statically (req.principal is typed optional).
      throw serverError(requestId);
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      // No resolvable workspace — fail closed to an empty page, never to
      // "every workspace" (see workspaceContext.ts's header).
      res.status(200).json({ data: [], next_cursor: null });
      return;
    }

    const values: unknown[] = [workspaceId];
    const whereClauses = [
      'workspace_id = $1',
      "document_type = 'issue'",
      'deleted_at IS NULL',
    ];

    if (assignee_id) {
      values.push(assignee_id);
      whereClauses.push(`properties->>'assignee_id' = $${values.length}`);
    }

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    // Fetch one extra row to know whether a next page exists, without a
    // separate COUNT query — identical strategy to documents.ts.
    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<IssueRow>(
      `SELECT id, title, properties, created_at, updated_at, created_at::text AS created_at_precise
       FROM documents
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParamIndex}`,
      values
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({ id: lastRow.id, created_at: preciseTimestamp(lastRow.created_at_precise) })
        : null;

    res.status(200).json({
      data: page.map(serializeIssue),
      next_cursor: nextCursor,
    });
  })
);

// ─── PATCH /api/v1/issues/:id ────────────────────────────────────────────
//
// PF-703 (Linear TRO-435) — see UpdateIssueRequestSchema's own doc comment
// for the deliberate `state`-only scope narrowing versus the internal
// route's fuller update surface.

issuesRouter.patch(
  '/:id',
  bearerAuth,
  rateLimitBuckets,
  requireScope('issues:write'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    const parseResult = UpdateIssueRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'Invalid request body.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }

    const principal = req.principal;
    if (!principal) {
      // Unreachable in practice — see the identical guard on GET / above.
      throw serverError(requestId);
    }
    if (!principal.user) {
      // A Client Credentials (app-only) token has no acting user —
      // document_history.changed_by (logDocumentChange below) needs a real
      // human to attribute the row to, and this ticket's whole point (the
      // agent gate's human-attributed writes) has no caller that could ever
      // legitimately hit this branch. Reject rather than write a history row
      // with a fabricated or absent actor.
      throw forbiddenError(requestId, 'This operation requires a personal (human) token — an app-only credential has no user to attribute the change to.');
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      throw notFoundError(requestId);
    }

    const existing = await pool.query<{ properties: IssueRowProperties | null }>(
      `SELECT properties FROM documents
       WHERE id = $1 AND workspace_id = $2 AND document_type = 'issue' AND deleted_at IS NULL`,
      [id, workspaceId]
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw notFoundError(requestId);
    }

    const currentProps = existingRow.properties ?? {};
    const { state: newState } = parseResult.data;
    const oldState = currentProps.state ?? null;

    // Whole-object replacement (matches routes/issues.ts's own internal
    // PATCH convention) rather than a jsonb_set — preserves every other
    // properties key (priority, assignee_id, estimate, ...) untouched.
    const newProps: IssueRowProperties = { ...currentProps, state: newState };
    const setClauses: string[] = ['properties = $1'];
    const values: unknown[] = [JSON.stringify(newProps)];

    // Same started_at/completed_at/reopened_at/cancelled_at bookkeeping the
    // internal route applies (`utils/document-crud.ts`'s `getTimestampUpdates`,
    // reused directly rather than reimplemented) — every one of these is a
    // pure SQL expression with no bind parameter, so it does not consume a
    // `values` slot. `oldState` (not defaulted to 'backlog') matches
    // routes/issues.ts's own `currentProps.state || null` call exactly.
    const timestampUpdates = getTimestampUpdates(oldState, newState);
    for (const [col, expr] of Object.entries(timestampUpdates)) {
      setClauses.push(`${col} = ${expr}`);
    }
    setClauses.push('updated_at = now()');

    // Transactional (matches routes/issues.ts's own internal PATCH):
    // logDocumentChange (document_history) and the UPDATE itself must
    // commit or roll back together — a history row for a state change that
    // never actually persisted (or vice versa) would be worse than either
    // failing cleanly. `updateDocument`'s own event publish is deferred via
    // `pendingEvents` until AFTER COMMIT for the identical reason
    // `documentService.ts`'s header comment states ("never before COMMIT").
    const client = await pool.connect();
    let updated: IssuePatchRow;
    try {
      await client.query('BEGIN');

      await logDocumentChange(id, 'state', oldState, newState, principal.user.id, undefined, client);

      const pendingEvents: Array<() => void> = [];
      updated = await updateDocument<IssuePatchRow>({
        id,
        workspaceId,
        setClauses,
        values,
        documentTypeFilter: 'issue',
        // Widening cast, not a narrowing one: every field IssueRowProperties
        // declares is already a subtype of `unknown` (its own optional
        // state/priority/assignee_id), so this loses no safety — only the
        // STATIC shape lacks an index signature, which is what
        // Record<string, unknown> requires structurally.
        previousProperties: currentProps as Record<string, unknown>,
        client,
        pendingEvents,
      });

      await client.query('COMMIT');
      flushPendingEvents(pendingEvents);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Built from `newProps` (already known — this is what was just sent to
    // Postgres) plus the DB round-trip's own id/title/timestamps, rather
    // than `serializeIssue()` — see IssuePatchRow's own doc comment for why
    // that helper's narrower `IssueRowProperties` type doesn't fit this
    // route's `updateDocument<T extends DocumentEventFields>` return type.
    res.status(200).json({
      id: updated.id,
      title: updated.title,
      document_type: 'issue' as const,
      state: newProps.state ?? 'backlog',
      priority: newProps.priority ?? 'medium',
      assignee_id: newProps.assignee_id ?? null,
      created_at: updated.created_at.toISOString(),
      updated_at: updated.updated_at.toISOString(),
    });
  })
);
