/**
 * `/api/v1/documents` — PF-200 (Linear TRO-398, PLUGFORGE.MD §4).
 *
 * `GET /` (cursor-paginated, keyset), `GET /:id`, `POST /`. Zod
 * request/response schemas live here, adjacent to the handlers, in the
 * shape PF-202's v1 OpenAPI registry consumes: `DocumentTypeSchema`,
 * `ListDocumentsQuerySchema` and `CreateDocumentRequestSchema` are `export`ed
 * (PF-202, Linear TRO-402) purely so `platform/openapi/schemas/documents.ts`
 * can import and `registerPath` them — no `.openapi()` annotations live in
 * this file, and no route-handling logic changed to add the exports.
 *
 * PF-202 also adds a Zod response schema, but that lives in
 * `platform/openapi/schemas/documents.ts`, not here — this file's response
 * shape stays a plain `serializeDocument()` object, matching the rest of
 * this route's already-established (and unmodified-by-PF-202) behavior.
 *

 * `require('documents:read'/'documents:write')` is `requireScope(...)` here
 * — see that module's header for why the exported name differs from the
 * PRD's literal `require(...)` prose (a global-shadowing avoidance, not a
 * scope change).
 *
 * POST goes through `services/documentService.ts`'s `createDocument` — a
 * thin domain-service call, not inline SQL in this file — so PF-301's later
 * consolidation of every `documents` write path is a move, not a rewrite.
 * GET list/GET :id stay as direct, read-only queries in this file: PF-301's
 * own scope (PLUGFORGE.MD §2.6) is explicitly the *write* path only.
 */

import { Router } from 'express';
import type { Request, Router as RouterType } from 'express';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../../../oauth/bearerAuth.js';
import { requireScope } from '../../../scopes/requireScope.js';
import { rateLimitBuckets } from '../../../ratelimit/middleware.js';
import { asyncHandler } from '../errorMiddleware.js';
import {
  notFoundError,
  serverError,
  validationFailedError,
} from '../errors.js';
import { encodeCursor, decodeCursor, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';
import { createDocument } from '../../../../services/documentService.js';

export const documentsRouter: RouterType = Router();

/**
 * Same defensive fallback pattern as `errorMiddleware.ts`'s own
 * `requestIdOf` (not exported from there — this is a two-line duplicate
 * rather than reaching across a module boundary for it): every request
 * reaching a `documentsRouter` handler already ran `requestIdMiddleware`
 * (mounted first on `v1Router`), so the fallback is not expected to be
 * exercised in practice, but `req.requestId` is typed optional.
 */
function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

// schema.sql:100's `document_type` enum, verbatim.
const DOCUMENT_TYPES = [
  'wiki',
  'issue',
  'program',
  'project',
  'sprint',
  'person',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
] as const;

export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);

/** `GET /api/v1/documents` query params. */
export const ListDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
  type: DocumentTypeSchema.optional(),
});

/** `POST /api/v1/documents` request body. `title` is required at this public
 * surface — a deliberate, distinct-from-internal-API decision (the internal
 * `routes/documents.ts` create schema defaults `title` to `'Untitled'`; the
 * PF-200 test design comment's AC-4 requires a missing `title` to be a
 * `validation_failed` error here). */
export const CreateDocumentRequestSchema = z.object({
  title: z.string().min(1, 'title is required'),
  document_type: DocumentTypeSchema.optional().default('wiki'),
  properties: z.record(z.unknown()).optional(),
});

/** The public response shape for one document — id/title/type plus
 * properties and timestamps. Deliberately narrower than the full internal
 * `documents` row (no `content`, `yjs_state`, `visibility`, etc.) — §2.4's
 * "own this mapping explicitly" applies to what a public resource exposes,
 * not just how it queries. */
interface DocumentRow {
  id: string;
  title: string;
  document_type: string;
  properties: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function serializeDocument(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    document_type: row.document_type,
    properties: row.properties ?? {},
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── GET /api/v1/documents ──────────────────────────────────────────────

documentsRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = ListDocumentsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'Invalid query parameters.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }
    const { limit, cursor, type } = parseResult.data;

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
      // No resolvable workspace (e.g. a user who has never joined one) —
      // fail closed to an empty page, never to "every workspace".
      res.status(200).json({ data: [], next_cursor: null });
      return;
    }

    const values: unknown[] = [workspaceId];
    const whereClauses = ['workspace_id = $1', 'deleted_at IS NULL'];

    if (type) {
      values.push(type);
      whereClauses.push(`document_type = $${values.length}`);
    }

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    // Fetch one extra row to know whether a next page exists, without a
    // separate COUNT query.
    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<DocumentRow>(
      `SELECT id, title, document_type, properties, created_at, updated_at
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
      data: page.map(serializeDocument),
      next_cursor: nextCursor,
    });
  })
);

// ─── GET /api/v1/documents/:id ──────────────────────────────────────────

documentsRouter.get(
  '/:id',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    // `String(...)`, not a destructure — matches `routes/documents.ts`'s
    // established convention for this exact repo quirk: `@types/express`
    // is pinned to v5's type definitions (`ParamsDictionary`'s index
    // signature is `string | string[]`, for Express 5's `*name` wildcard
    // params) even though the runtime `express` package is v4.22.1, so
    // under this tsconfig's `noUncheckedIndexedAccess`, `req.params.id` is
    // `string | string[] | undefined` — never actually an array or
    // undefined for a single named `:id` segment, but TypeScript can't see
    // that. `String(...)` collapses it to a plain string for the UUID
    // regex test below and the query parameter; a malformed value (an
    // array or `undefined`) still safely fails the regex and 404s.
    const id = String(req.params.id);

    if (!UUID_RE.test(id)) {
      // Malformed id -> not_found, not validation_failed (PF-200 test
      // design AC-4: "malformed/nonexistent id -> code: 'not_found'").
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

    const result = await pool.query<DocumentRow>(
      `SELECT id, title, document_type, properties, created_at, updated_at
       FROM documents
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [id, workspaceId]
    );

    const row = result.rows[0];
    if (!row) {
      throw notFoundError(requestId);
    }

    res.status(200).json(serializeDocument(row));
  })
);

// ─── POST /api/v1/documents ─────────────────────────────────────────────

documentsRouter.post(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:write'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);

    const parseResult = CreateDocumentRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'The request could not be validated.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }

    const principal = req.principal;
    if (!principal) {
      throw serverError(requestId);
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      throw notFoundError(
        requestId,
        'No workspace is associated with this credential.',
      );
    }

    const created = await createDocument({
      workspaceId,
      title: parseResult.data.title,
      documentType: parseResult.data.document_type,
      properties: parseResult.data.properties ?? {},
      createdByUserId: principal.user?.id ?? null,
    });

    res.status(201).json(serializeDocument(created));
  })
);
