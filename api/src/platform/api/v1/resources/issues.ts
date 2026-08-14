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
import { serverError, validationFailedError } from '../errors.js';
import { encodeCursor, decodeCursor, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';

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
}

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
    const { limit, cursor } = parseResult.data;

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

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    // Fetch one extra row to know whether a next page exists, without a
    // separate COUNT query — identical strategy to documents.ts.
    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<IssueRow>(
      `SELECT id, title, properties, created_at, updated_at
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
        ? encodeCursor({ id: lastRow.id, created_at: lastRow.created_at.toISOString() })
        : null;

    res.status(200).json({
      data: page.map(serializeIssue),
      next_cursor: nextCursor,
    });
  })
);
