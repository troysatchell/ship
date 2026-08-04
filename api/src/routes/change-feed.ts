import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { authMiddleware, authed } from '../middleware/auth.js';
import { getVisibilityContext, VISIBILITY_FILTER_SQL } from '../middleware/visibility.js';
import { limitQuerySchema } from '../middleware/paramValidation.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

// FG-1 / TRO-312: "what changed since a cursor" — the input the agent's
// proactive mode needs and Ship's API had no way to answer. `document_history`
// and `comments` don't have their own visibility column, so both are
// permission-filtered by joining back to `documents` and reusing the same
// VISIBILITY_FILTER_SQL every list route already uses.
//
// The naive design — a high-water mark on `updated_at`/`document_history.id`,
// advanced to `now()` on every poll — PERMANENTLY misses a row whose
// transaction commits after the cursor has already advanced past its
// timestamp: `updated_at` (and `document_history.id`, a SERIAL) are both
// assigned before commit, so a slower transaction with an earlier timestamp
// can commit after a faster, later-timestamped one that a poll already saw.
// Once the cursor has moved past that timestamp, `updated_at > cursor` can
// never see it again.
//
// The fix: never advance the cursor to "now" — advance it to
// `now - CHANGE_FEED_LAG_MS`. A row more recent than that "safe cutoff" is
// deliberately withheld from the response and left for a later poll, once
// enough wall-clock time has passed that its transaction (and any
// earlier-timestamped sibling still in flight) is guaranteed to have
// committed. This is a tunable safety margin, not a proof: it holds as long
// as CHANGE_FEED_LAG_MS exceeds the longest write transaction's duration.

/** Exported for tests: how far behind "now" the safe cursor lags. */
export const CHANGE_FEED_LAG_MS = 5_000;

/** Exported for tests: caps `limit` the same way documents/issues list routes do. */
export const MAX_CHANGE_FEED_LIMIT = 500;
const DEFAULT_CHANGE_FEED_LIMIT = 100;

const changeFeedQuerySchema = z.object({
  since: z.string().datetime({ message: 'since must be an ISO 8601 datetime string' }),
  limit: limitQuerySchema(MAX_CHANGE_FEED_LIMIT),
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

// GET /api/change-feed?since=<iso>&limit=<n>
router.get('/', authMiddleware, authed(async (req, res) => {
  try {
    const parsedQuery = changeFeedQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: 'Invalid input', details: parsedQuery.error.errors });
      return;
    }
    const { since, limit } = parsedQuery.data;
    const userId = req.userId;
    const workspaceId = req.workspaceId;

    const sinceDate = new Date(since);
    const effectiveLimit = limit ?? DEFAULT_CHANGE_FEED_LIMIT;

    const now = new Date();
    if (sinceDate.getTime() > now.getTime()) {
      res.status(400).json({ error: 'Invalid input', details: [{ path: ['since'], message: 'since must not be in the future' }] });
      return;
    }

    const { isAdmin } = await getVisibilityContext(userId, workspaceId);

    // The safe cutoff this poll is willing to trust. Never advanced past
    // `now - CHANGE_FEED_LAG_MS`; see the module docstring for why.
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
         AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
         AND d.updated_at > $4
         AND d.updated_at <= $5
       ORDER BY d.updated_at ASC
       LIMIT $6`,
      [workspaceId, userId, isAdmin, sinceDate, safeCutoff, effectiveLimit]
    );

    const historyResult = await pool.query<ChangedHistoryRow>(
      `SELECT dh.id, dh.document_id, dh.field, dh.old_value, dh.new_value,
              dh.changed_by, dh.automated_by, dh.created_at
       FROM document_history dh
       JOIN documents d ON d.id = dh.document_id
       WHERE d.workspace_id = $1
         AND d.deleted_at IS NULL
         AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
         AND dh.created_at > $4
         AND dh.created_at <= $5
       ORDER BY dh.created_at ASC
       LIMIT $6`,
      [workspaceId, userId, isAdmin, sinceDate, safeCutoff, effectiveLimit]
    );

    const commentsResult = await pool.query<ChangedCommentRow>(
      `SELECT c.id, c.document_id, c.comment_id, c.parent_id, c.author_id,
              c.content, c.resolved_at, c.created_at, c.updated_at
       FROM comments c
       JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = $1
         AND d.deleted_at IS NULL
         AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}
         AND c.updated_at > $4
         AND c.updated_at <= $5
       ORDER BY c.updated_at ASC
       LIMIT $6`,
      [workspaceId, userId, isAdmin, sinceDate, safeCutoff, effectiveLimit]
    );

    // If a category hit `limit`, rows between the last one actually returned
    // and `safeCutoff` were never delivered for it. Advancing the shared
    // cursor past them would silently skip those rows forever — the exact
    // permanent-miss failure mode this endpoint exists to avoid, just moved
    // from the timestamp layer to the pagination layer. Capping the cursor at
    // the earliest "last delivered" timestamp across any truncated category
    // means the next poll re-covers that gap; a category that was NOT
    // truncated may re-deliver a few already-seen rows in that re-covered
    // window, which is exactly what `dedupe_key` exists for.
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

    res.json({
      next_cursor: nextCursor.toISOString(),
      documents: documentsResult.rows.map((row) => ({
        dedupe_key: `document:${row.id}:${row.updated_at.toISOString()}`,
        id: row.id,
        document_type: row.document_type,
        title: row.title,
        updated_at: row.updated_at,
        created_by: row.created_by,
      })),
      documents_truncated: documentsResult.rows.length === effectiveLimit,
      history: historyResult.rows.map((row) => ({
        dedupe_key: `history:${row.id}`,
        id: row.id,
        document_id: row.document_id,
        field: row.field,
        old_value: row.old_value,
        new_value: row.new_value,
        changed_by: row.changed_by,
        automated_by: row.automated_by,
        created_at: row.created_at,
      })),
      history_truncated: historyResult.rows.length === effectiveLimit,
      comments: commentsResult.rows.map((row) => ({
        dedupe_key: `comment:${row.id}:${row.updated_at.toISOString()}`,
        id: row.id,
        document_id: row.document_id,
        comment_id: row.comment_id,
        parent_id: row.parent_id,
        author_id: row.author_id,
        content: row.content,
        resolved_at: row.resolved_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      comments_truncated: commentsResult.rows.length === effectiveLimit,
    });
  } catch (err) {
    console.error('Change feed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}));

export default router;
