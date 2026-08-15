/**
 * `/api/v1/people` — PF-205 (Linear TRO-414, PLUGFORGE.MD §4).
 *
 * One of the agent's 10 reads (`agent/src/shipClient.ts:360-455`, `getPeople()`
 * -> internal `GET /api/team/people`, `api/src/routes/team.ts:729-767`). A
 * TYPED view over `documents WHERE document_type = 'person'` — same pattern
 * as `resources/issues.ts` lifting `state`/`priority`/`assignee_id` out of
 * `properties`, applied here to `user_id`/`is_archived`/`is_pending`/
 * `reports_to`/`role`. Verified against `team.ts`'s own query
 * (`team.ts:745-760`) before writing this: `person` documents store
 * `user_id`, `email`, `reports_to`, `role`, and `pending` in `properties`,
 * plus `archived_at` as a real top-level `documents` column.
 *
 * Scope: `documents:read`, NOT a new `people:read` — PLUGFORGE.MD §4's PF-205
 * block is explicit ("people are documents — documents:read covers them;
 * architect may split a people:read if consent UX wants it") and no evidence
 * of a consent-UX requirement exists anywhere in this repo (grepped for
 * "consent" across `docs/`, `PLUGFORGE.MD`, `shared/src` — no hits tied to
 * person-directory visibility). Inventing a scope on spec here would be
 * exactly the unmarked-inference failure CLAUDE.md's claim-provenance rule
 * warns against — this is a documented absence-of-evidence, not a guess.
 *
 * Field naming: this file uses v1's established snake_case convention
 * (`user_id`, `is_archived`, `is_pending`, `reports_to`) rather than
 * `team.ts`'s internal camelCase (`isArchived`, `isPending`, `reportsTo`) —
 * matching `resources/issues.ts`'s `assignee_id` precedent, not the internal
 * route's response shape (v1 is a separate public contract, PLUGFORGE.MD
 * §2.1).
 *
 * Deliberately does NOT replicate `team.ts`'s `includeArchived` query filter
 * or its `VISIBILITY_FILTER_SQL` join: no existing v1 list route
 * (`documents.ts`, `issues.ts`, `sprints.ts`) applies per-user visibility
 * filtering or an archived-exclusion default — every one of them scopes only
 * by `workspace_id` (+ `deleted_at IS NULL` for documents.ts). This resource
 * follows that same, already-established v1 precedent for consistency rather
 * than inventing a new filtering behavior unique to this one resource;
 * `is_archived` is exposed as a top-level field specifically so a caller can
 * filter client-side. Flagged in this ticket's final report as a pre-existing
 * gap inherited from the pattern, not something new introduced here.
 */

import { Router } from 'express';
import type { Request, Router as RouterType } from 'express';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../../../oauth/bearerAuth.js';
import { requireScope } from '../../../scopes/requireScope.js';
import { rateLimitBuckets } from '../../../ratelimit/middleware.js';
import { asyncHandler } from '../errorMiddleware.js';
import { serverError, validationFailedError } from '../errors.js';
import { encodeCursor, decodeCursor, preciseTimestamp, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';

export const peopleRouter: RouterType = Router();

/** Same defensive fallback pattern as `resources/documents.ts`'s own
 * `requestIdOf` — see that file's header for why this is a two-line
 * duplicate rather than a shared import. */
function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/** `GET /api/v1/people` query params — identical shape to `issues.ts`'s list
 * query (limit/cursor only; `document_type` is fixed to `'person'` by this
 * resource, matching that file's precedent). `export`ed so
 * `platform/openapi/schemas/people.ts` can register it. */
export const ListPeopleQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
});

/** The `properties` JSONB keys this resource reads — verified against
 * `team.ts:745-760`'s own SELECT. */
interface PersonRowProperties {
  user_id?: string | null;
  email?: string | null;
  pending?: string | boolean;
  reports_to?: string | null;
  role?: string | null;
}

interface PersonRow {
  id: string;
  title: string;
  properties: PersonRowProperties | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** `created_at::text` — cursor-internal only (TRO-602). */
  created_at_precise: string;
}

/** `pending` round-trips through JSONB as either the string `'true'` (how
 * `team.ts`'s own `d.properties->>'pending' = 'true'` comparison treats it)
 * or a real boolean, depending on how it was originally written — normalized
 * here rather than assumed to be one or the other. */
function isPendingValue(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

function serializePerson(row: PersonRow) {
  const props = row.properties ?? {};
  return {
    id: row.id,
    name: row.title,
    document_type: 'person' as const,
    user_id: props.user_id ?? null,
    email: props.email ?? null,
    is_archived: row.archived_at !== null,
    is_pending: isPendingValue(props.pending),
    reports_to: props.reports_to ?? null,
    role: props.role ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ─── GET /api/v1/people ─────────────────────────────────────────────────

peopleRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = ListPeopleQuerySchema.safeParse(req.query);
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
      "document_type = 'person'",
      'deleted_at IS NULL',
    ];

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    // Fetch one extra row to know whether a next page exists, without a
    // separate COUNT query — same strategy as documents.ts/issues.ts.
    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<PersonRow>(
      `SELECT id, title, properties, archived_at, created_at, updated_at, created_at::text AS created_at_precise
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
      data: page.map(serializePerson),
      next_cursor: nextCursor,
    });
  })
);
