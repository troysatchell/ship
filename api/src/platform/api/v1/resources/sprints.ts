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
import { notFoundError, serverError, validationFailedError } from '../errors.js';
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

// ─── GET /api/v1/sprints/:id ─────────────────────────────────────────────
//
// PF-205 (Linear TRO-414). Claim-provenance note (checked, not assumed): the
// PRD block (PLUGFORGE.MD §4) describes this as "sprint-cadence/week-dates
// carried on GET /api/v1/sprints/:id (already exists, extend the
// response)" — but `GET /api/v1/sprints/:id` did NOT already exist before
// this ticket (this file, pre-TRO-414, registered only `GET /`; confirmed by
// reading the whole file, not inferred from the PRD's own wording, and by
// `git log` / `grep` finding no `sprintsRouter.get('/:id'` anywhere in the
// repo before this commit). This route is built fresh, extended immediately
// with the cadence/week-dates fields the PRD asks for — same net effect the
// PRD describes, via a different starting point than its prose claimed.
//
// Response shape: `serializeSprint()`'s existing id/title/document_type/
// properties/created_at/updated_at envelope, PLUS the cadence fields:
// `sprint_number`/`owner_id`/`status` (lifted from `properties`, matching
// `WeekProperties`'s field names — verified against
// `shared/src/types/document.ts` before writing this) and
// `workspace_sprint_start_date`/`start_date`/`end_date` (the workspace's own
// sprint-cadence anchor, plus this sprint's own computed calendar window).
//
// `computeSprintWindow` below duplicates the day-math `routes/weeks.ts`'s
// `isSprintActive` and `routes/team.ts`'s several inline copies already use
// (`sprintDurationDays = 7`, UTC-midnight-normalized start, `+ (n-1)*7`
// days) — not imported, because `platform/api/v1/**` may never import from
// `api/src/routes/**` (this resource's sibling `resources/documents.ts` has
// the full boundary-rule citation). This mirrors the existing codebase
// convention of duplicating this exact math inline (`team.ts` alone repeats
// it 6 times) rather than introducing a new violation.
//
// Deliberately does NOT replicate `weeks.ts`'s `GET /:id` snapshot-taking
// side effect (`takeSprintSnapshot`) — that is write behavior belonging to
// the internal route, out of scope for a read-only v1 endpoint, and it lives
// in `api/src/routes/**` where this file cannot reach it anyway.

const SPRINT_DURATION_DAYS = 7;

/** Computes this sprint's own calendar window from the workspace's sprint
 * anchor date and its `sprint_number` — UTC-midnight-normalized, matching
 * `team.ts`/`weeks.ts`'s existing date math exactly (see this route's own
 * header for the duplication rationale). Returns `YYYY-MM-DD` date-only
 * strings, same format `team.ts`'s equivalent computation already returns. */
function computeSprintWindow(
  workspaceStartDate: Date,
  sprintNumber: number
): { start_date: string; end_date: string } {
  const start = new Date(
    Date.UTC(
      workspaceStartDate.getUTCFullYear(),
      workspaceStartDate.getUTCMonth(),
      workspaceStartDate.getUTCDate()
    )
  );
  start.setUTCDate(start.getUTCDate() + (sprintNumber - 1) * SPRINT_DURATION_DAYS);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + SPRINT_DURATION_DAYS - 1);

  const startIso = start.toISOString().split('T')[0];
  const endIso = end.toISOString().split('T')[0];
  if (!startIso || !endIso) {
    // Unreachable — `toISOString()` on a valid Date always contains 'T' —
    // guarded only so TypeScript's noUncheckedIndexedAccess is satisfied
    // without a non-null assertion (lessons.md rule 16).
    throw new Error('computeSprintWindow: failed to format start/end date');
  }
  return { start_date: startIso, end_date: endIso };
}

interface SprintDetailRow {
  id: string;
  title: string;
  properties: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  workspace_sprint_start_date: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

sprintsRouter.get(
  '/:id',
  bearerAuth,
  rateLimitBuckets,
  requireScope('sprints:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    if (!UUID_RE.test(id)) {
      // Malformed id -> not_found, matching resources/documents.ts's
      // GET /:id convention (PF-200 test design AC-4).
      throw notFoundError(requestId);
    }

    const principal = req.principal;
    if (!principal) {
      throw serverError(requestId);
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      throw notFoundError(requestId);
    }

    const result = await pool.query<SprintDetailRow>(
      `SELECT d.id, d.title, d.properties, d.created_at, d.updated_at,
              w.sprint_start_date as workspace_sprint_start_date
       FROM documents d
       JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.id = $1 AND d.workspace_id = $2 AND d.document_type = 'sprint'
         AND d.deleted_at IS NULL`,
      [id, workspaceId]
    );

    const row = result.rows[0];
    if (!row) {
      throw notFoundError(requestId);
    }

    const props = row.properties ?? {};
    const sprintNumberRaw = props.sprint_number;
    const sprintNumber = typeof sprintNumberRaw === 'number' ? sprintNumberRaw : 1;
    const { start_date, end_date } = computeSprintWindow(row.workspace_sprint_start_date, sprintNumber);

    res.status(200).json({
      id: row.id,
      title: row.title,
      document_type: 'sprint' as const,
      properties: props,
      sprint_number: sprintNumber,
      owner_id: typeof props.owner_id === 'string' ? props.owner_id : null,
      status: typeof props.status === 'string' ? props.status : null,
      workspace_sprint_start_date: row.workspace_sprint_start_date.toISOString().split('T')[0],
      start_date,
      end_date,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  })
);
