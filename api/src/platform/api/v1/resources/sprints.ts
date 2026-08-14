/**
 * `/api/v1/sprints` — PF-201 (Linear TRO-400, PLUGFORGE.MD §4).
 *
 * `GET /` (cursor-paginated, keyset) over `documents WHERE document_type =
 * 'sprint'`. The ticket's AC for this resource is just "sprints list" (no
 * typed-field-lifting requirement the way issues has one for
 * state/priority/assignee_id) — so this follows `resources/documents.ts`'s
 * list pattern almost verbatim, filtered to `document_type = 'sprint'`
 * instead of accepting a `?type=` query param, and reusing its exact
 * `{id, title, document_type, properties, created_at, updated_at}` envelope.
 *
 * Property-name note (for anyone extending this into a typed view later):
 * `shared/src/types/document.ts`'s `WeekProperties` interface (the type used
 * for `document_type: 'sprint'` — internally called "week" in the type
 * system, confusingly; `WeekDocument.document_type` is literally `'sprint'`)
 * names `sprint_number: number`, `owner_id: string`, `status?: 'planning' |
 * 'active' | 'completed'` as the closest analogues to issues'
 * state/priority. Left un-lifted here because the ticket does not ask for
 * it and `routes/weeks.ts`'s own `extractSprintFromRow` computes `status`
 * with additional logic (rollup counts, program joins) this read-only v1
 * list has no need to replicate for an unrequested AC.
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
import { encodeCursor, decodeCursor, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';

export const sprintsRouter: RouterType = Router();

function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/** `export`ed (PF-203, Linear TRO-404 — closing the registration gap this
 * ticket's brief flagged) so `platform/openapi/schemas/sprints.ts` can
 * import and `registerPath` it. No route-handling logic changed. */
export const ListSprintsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
});

interface SprintRow {
  id: string;
  title: string;
  properties: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function serializeSprint(row: SprintRow) {
  return {
    id: row.id,
    title: row.title,
    document_type: 'sprint' as const,
    properties: row.properties ?? {},
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ─── GET /api/v1/sprints ────────────────────────────────────────────────

sprintsRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('sprints:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = ListSprintsQuerySchema.safeParse(req.query);
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
      throw serverError(requestId);
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      res.status(200).json({ data: [], next_cursor: null });
      return;
    }

    const values: unknown[] = [workspaceId];
    const whereClauses = [
      'workspace_id = $1',
      "document_type = 'sprint'",
      'deleted_at IS NULL',
    ];

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<SprintRow>(
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
      data: page.map(serializeSprint),
      next_cursor: nextCursor,
    });
  })
);
