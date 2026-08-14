/**
 * `/api/v1/changes` — PF-205 (Linear TRO-414, PLUGFORGE.MD §4).
 *
 * The public change-feed contract — the agent's `getChangeFeed()` read
 * (`agent/src/shipClient.ts:360-367`, hitting the INTERNAL
 * `GET /api/change-feed`, `api/src/routes/change-feed.ts`). This file is a
 * public, scoped, cursor-lag-preserving mirror of that route, not an import
 * of it: `platform/api/v1/**` must never import from `api/src/routes/**`
 * (`router.ts`'s own header, PLUGFORGE.MD §2.1's one-way boundary rule,
 * mechanically enforced by `platform/__tests__/boundary-lint.test.ts`). Every
 * constant and query below is a deliberate, documented duplicate of
 * `change-feed.ts`'s, verified against that file before writing this —
 * not a guess at equivalent behavior.
 *
 * Deliberately NOT the webhooks feature (`resources/webhooks.ts`,
 * `platform/webhooks/`): webhooks PUSH deliveries to a subscriber's
 * `target_url`; this is a PULL-based feed a caller polls with `?since=`.
 * Architect note (this ticket's brief) is explicit the two must not be
 * conflated — no shared code, scope, or route path between them.
 *
 * ── Cursor-lag semantics, copied verbatim from change-feed.ts's own header ──
 *
 * A naive "advance the cursor to now() on every poll" design PERMANENTLY
 * misses a row whose transaction commits after the cursor has already moved
 * past its timestamp (`updated_at`/`document_history.id` are assigned before
 * commit, so a slower, earlier-timestamped transaction can commit after a
 * faster, later-timestamped one a poll already saw). The fix: never advance
 * the cursor to "now" — advance it to `now - CHANGE_FEED_LAG_MS`, holding
 * back anything more recent than that safe cutoff for a later poll. This is a
 * tunable safety margin, not a proof: it holds as long as `CHANGE_FEED_LAG_MS`
 * exceeds the longest write transaction's duration — identical to the
 * internal route's own caveat.
 *
 * ── Wire shape — why `data`/`next_cursor`, not three parallel arrays ──
 *
 * The internal route returns `{ next_cursor, documents, documents_truncated,
 * history, history_truncated, comments, comments_truncated }` — three
 * separate arrays. PF-203's fitness test (check (d),
 * `platform/api/v1/__tests__/route-fitness.test.ts`) requires every GET
 * "collection" route (no `{param}` in its path — this route qualifies) to
 * register a `{ data: [...], next_cursor }` response shape. Rather than
 * bolting on an unused `data: []` field to fake that shape, this route
 * merges the three categories into one genuinely paginated `data` array,
 * each entry tagged with a `resource` discriminator
 * (`'document' | 'document_history' | 'comment'`) — a real, honest list, and
 * a natural shape for a *public* change feed (a single ordered event stream,
 * not three feeds a caller has to interleave themselves). No information is
 * lost: every field the internal route returns per category survives on its
 * corresponding `data` entry, and the three `*_truncated` flags survive as
 * `truncated.{documents,document_history,comments}`. Ordering is
 * category-then-time (documents, then history, then comments, each already
 * `ORDER BY ... ASC` within its category) — NOT a cross-category timestamp
 * merge-sort, which nothing in the PRD or the internal contract asks for and
 * which `next_cursor`'s own min-across-categories computation (below,
 * unchanged from the internal route) does not depend on either way.
 *
 * ── Scope and visibility ──
 *
 * `documents:read` — this feed surfaces document/history/comment changes,
 * and PLUGFORGE.MD §4's PF-205 block treats `documents:read` as the
 * governing scope for every document-shaped read that doesn't warrant its
 * own scope (see `resources/people.ts`'s identical reasoning).
 *
 * Deliberately does NOT reproduce `change-feed.ts`'s
 * `getVisibilityContext`/`VISIBILITY_FILTER_SQL` per-user visibility
 * filtering — scoped only by `workspace_id` (+ `deleted_at IS NULL`/
 * `archived_at IS NULL` where applicable), matching every existing v1 list
 * route's (`documents.ts`, `issues.ts`, `sprints.ts`) already-established
 * precedent of workspace-only scoping. Flagged in this ticket's final report
 * as a pre-existing gap inherited from that precedent, not a new hole
 * introduced here — the internal route's `req.userId`-based visibility
 * check has no direct analogue for a bearer-token `Principal`, which may be
 * a Client Credentials app token with no `user` at all.
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
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';

export const changesRouter: RouterType = Router();

function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/** Duplicated from `api/src/routes/change-feed.ts`'s `CHANGE_FEED_LAG_MS` —
 * see this file's header for why it is a duplicate, not an import. Exported
 * for tests, same as the internal constant. */
export const CHANGE_FEED_LAG_MS = 5_000;

/** Duplicated from `change-feed.ts`'s `MAX_CHANGE_FEED_LIMIT` /
 * `DEFAULT_CHANGE_FEED_LIMIT`. */
export const MAX_CHANGES_LIMIT = 500;
const DEFAULT_CHANGES_LIMIT = 100;

/** `GET /api/v1/changes` query params. `since` is REQUIRED (unlike the
 * keyset `cursor` param on other v1 list routes) — this mirrors
 * `change-feed.ts`'s own contract exactly, per the architect note to "keep
 * its cursor-lagged semantics" rather than reinvent it as opaque keyset
 * pagination. `export`ed so `platform/openapi/schemas/changes.ts` can
 * register it. */
export const GetChangesQuerySchema = z.object({
  since: z.string().datetime({ message: 'since must be an ISO 8601 datetime string' }),
  limit: z.coerce.number().int().min(1).max(MAX_CHANGES_LIMIT).optional(),
});

interface ChangedDocumentRow {
  id: string;
  document_type: string;
  title: string;
  updated_at: Date;
  created_by: string | null;
}

interface ChangedHistoryRow {
  id: number;
  document_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  automated_by: string | null;
  created_at: Date;
}

interface ChangedCommentRow {
  id: string;
  document_id: string;
  comment_id: string;
  parent_id: string | null;
  author_id: string | null;
  content: string;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ─── GET /api/v1/changes ─────────────────────────────────────────────────

changesRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = GetChangesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'Invalid query parameters.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }
    const { since, limit } = parseResult.data;
    const effectiveLimit = limit ?? DEFAULT_CHANGES_LIMIT;

    const sinceDate = new Date(since);
    const now = new Date();
    if (sinceDate.getTime() > now.getTime()) {
      throw validationFailedError(requestId, 'Invalid query parameters.', {
        fieldErrors: { since: ['since must not be in the future'] },
      });
    }

    const principal = req.principal;
    if (!principal) {
      throw serverError(requestId);
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      res.status(200).json({
        data: [],
        next_cursor: now.toISOString(),
        truncated: { documents: false, document_history: false, comments: false },
      });
      return;
    }

    // The safe cutoff this poll is willing to trust — never advanced past
    // `now - CHANGE_FEED_LAG_MS`. See file header for why.
    const rawSafeCutoff = new Date(now.getTime() - CHANGE_FEED_LAG_MS);
    // Never move the returned cursor backwards relative to what the caller
    // already sent — a caller polling faster than the lag window elapses
    // would otherwise regress its own cursor.
    const safeCutoff = rawSafeCutoff.getTime() > sinceDate.getTime() ? rawSafeCutoff : sinceDate;

    const documentsResult = await pool.query<ChangedDocumentRow>(
      `SELECT d.id, d.document_type, d.title, d.updated_at, d.created_by
       FROM documents d
       WHERE d.workspace_id = $1
         AND d.deleted_at IS NULL
         AND d.updated_at > $2
         AND d.updated_at <= $3
       ORDER BY d.updated_at ASC
       LIMIT $4`,
      [workspaceId, sinceDate, safeCutoff, effectiveLimit]
    );

    const historyResult = await pool.query<ChangedHistoryRow>(
      `SELECT dh.id, dh.document_id, dh.field, dh.old_value, dh.new_value,
              dh.changed_by, dh.automated_by, dh.created_at
       FROM document_history dh
       JOIN documents d ON d.id = dh.document_id
       WHERE d.workspace_id = $1
         AND d.deleted_at IS NULL
         AND dh.created_at > $2
         AND dh.created_at <= $3
       ORDER BY dh.created_at ASC
       LIMIT $4`,
      [workspaceId, sinceDate, safeCutoff, effectiveLimit]
    );

    const commentsResult = await pool.query<ChangedCommentRow>(
      `SELECT c.id, c.document_id, c.comment_id, c.parent_id, c.author_id,
              c.content, c.resolved_at, c.created_at, c.updated_at
       FROM comments c
       JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = $1
         AND d.deleted_at IS NULL
         AND c.updated_at > $2
         AND c.updated_at <= $3
       ORDER BY c.updated_at ASC
       LIMIT $4`,
      [workspaceId, sinceDate, safeCutoff, effectiveLimit]
    );

    // Same truncation-aware cursor cap as change-feed.ts: if a category hit
    // `limit`, rows between its last delivered row and `safeCutoff` were
    // never sent — capping the cursor there means the next poll re-covers
    // that gap. `dedupe_key` (on every data entry) lets a caller collapse
    // any already-seen rows a re-covered window resends.
    let nextCursor = safeCutoff;
    const lastDocumentRow = documentsResult.rows[documentsResult.rows.length - 1];
    if (documentsResult.rows.length === effectiveLimit && lastDocumentRow && lastDocumentRow.updated_at.getTime() < nextCursor.getTime()) {
      nextCursor = lastDocumentRow.updated_at;
    }
    const lastHistoryRow = historyResult.rows[historyResult.rows.length - 1];
    if (historyResult.rows.length === effectiveLimit && lastHistoryRow && lastHistoryRow.created_at.getTime() < nextCursor.getTime()) {
      nextCursor = lastHistoryRow.created_at;
    }
    const lastCommentRow = commentsResult.rows[commentsResult.rows.length - 1];
    if (commentsResult.rows.length === effectiveLimit && lastCommentRow && lastCommentRow.updated_at.getTime() < nextCursor.getTime()) {
      nextCursor = lastCommentRow.updated_at;
    }

    const data = [
      ...documentsResult.rows.map((row) => ({
        resource: 'document' as const,
        dedupe_key: `document:${row.id}:${row.updated_at.toISOString()}`,
        id: row.id,
        document_type: row.document_type,
        title: row.title,
        updated_at: row.updated_at.toISOString(),
        created_by: row.created_by,
      })),
      ...historyResult.rows.map((row) => ({
        resource: 'document_history' as const,
        dedupe_key: `history:${row.id}`,
        id: row.id,
        document_id: row.document_id,
        field: row.field,
        old_value: row.old_value,
        new_value: row.new_value,
        changed_by: row.changed_by,
        automated_by: row.automated_by,
        created_at: row.created_at.toISOString(),
      })),
      ...commentsResult.rows.map((row) => ({
        resource: 'comment' as const,
        dedupe_key: `comment:${row.id}:${row.updated_at.toISOString()}`,
        id: row.id,
        document_id: row.document_id,
        comment_id: row.comment_id,
        parent_id: row.parent_id,
        author_id: row.author_id,
        content: row.content,
        resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
    ];

    res.status(200).json({
      data,
      next_cursor: nextCursor.toISOString(),
      truncated: {
        documents: documentsResult.rows.length === effectiveLimit,
        document_history: historyResult.rows.length === effectiveLimit,
        comments: commentsResult.rows.length === effectiveLimit,
      },
    });
  })
);
