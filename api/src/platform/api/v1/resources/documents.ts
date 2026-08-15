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
import { encodeCursor, decodeCursor, preciseTimestamp, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';
import { createDocument } from '../../../../services/documentService.js';

export const documentsRouter: RouterType = Router();

/**
 * PF-205 (Linear TRO-414) — four read-only sub-resources added below the
 * original three PF-200 routes: `GET /:id/associations`,
 * `GET /:id/reverse-associations`, `GET /:id/backlinks`,
 * `GET /:id/comments`. Each mirrors one of the agent's 10 reads
 * (`agent/src/shipClient.ts:381-413`, `getAssociations`/
 * `getReverseAssociations`/`getBacklinks`/`getComments`), which today hit
 * INTERNAL routes (`api/src/routes/associations.ts`,
 * `api/src/routes/backlinks.ts`, `api/src/routes/comments.ts`) — this file
 * does not import from any of them (the one-way `platform/api/v1/**` ->
 * `api/src/routes/**` boundary ban, this file's own module header above),
 * it reimplements the read queries against the same tables, verified against
 * each internal route's SQL before writing this.
 *
 * `resolveWorkspaceOrThrow`/`resolveWorkspaceOrNull` below follow
 * `resources/webhooks.ts`'s identical helper-pair pattern (see that file's
 * own doc comments) — introduced here because these four new routes all need
 * the same "confirm the anchor document exists in the caller's workspace,
 * else 404" check the three original routes above do not share a name for.
 * The three original routes are left untouched (their inline
 * principal/workspace checks are unchanged) — this is additive, not a
 * refactor of working code outside this ticket's scope.
 */

async function resolveWorkspaceOrNull(req: Request, requestId: string): Promise<string | null> {
  const principal = req.principal;
  if (!principal) {
    // Unreachable in practice — bearerAuth never calls next() without
    // setting req.principal — but TypeScript can't see that guarantee
    // statically (req.principal is typed optional).
    throw serverError(requestId);
  }
  return resolvePrincipalWorkspaceId(principal);
}

async function resolveWorkspaceOrThrow(req: Request, requestId: string): Promise<string> {
  const workspaceId = await resolveWorkspaceOrNull(req, requestId);
  if (!workspaceId) {
    throw notFoundError(requestId, 'No workspace is associated with this credential.');
  }
  return workspaceId;
}

/**
 * Confirms `id` is a well-formed UUID that names a document in
 * `workspaceId` (not deleted). Throws `not_found` otherwise — matching
 * `GET /:id`'s existing "malformed or missing id both 404" convention
 * (PF-200 test design AC-4), applied here as the shared anchor-document
 * check every sub-resource route needs before querying its own join table.
 */
async function assertDocumentExists(id: string, workspaceId: string, requestId: string): Promise<void> {
  if (!UUID_RE.test(id)) {
    throw notFoundError(requestId);
  }
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM documents WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [id, workspaceId]
  );
  if (!result.rows[0]) {
    throw notFoundError(requestId);
  }
}

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
  /** `created_at::text` — cursor-internal only (TRO-602), never serialized
   *  into a response body. See `pagination.ts`'s `PreciseTimestamp` header. */
  created_at_precise: string;
}

// `Omit<..., 'created_at_precise'>`, not `DocumentRow` itself: this is also
// called from POST /'s create path with a row shaped by
// services/documentService.ts's OWN, unrelated `DocumentRow` type (a
// same-named but structurally different interface, from a create response
// that never builds a cursor) — that row has no `created_at_precise` field,
// and never needs one, since serialization only ever reads the fields below.
function serializeDocument(row: Omit<DocumentRow, 'created_at_precise'>) {
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
      `SELECT id, title, document_type, properties, created_at, updated_at, created_at::text AS created_at_precise
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

// ─── Sub-resource list query params (shared shape, limit/cursor only) ──────
//
// `export`ed (PF-202/PF-203 convention — every route's request/response zod
// schema is exported for `platform/openapi/schemas/documents.ts` to
// `registerPath` with) so all four sub-resource routes below share one
// OpenAPI-registered query schema rather than four structurally-identical
// copies.

export const SubResourceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
});

// ─── GET /api/v1/documents/:id/associations ────────────────────────────
//
// Mirrors `getAssociations()` (`shipClient.ts:381-387`) -> internal
// `GET /api/documents/:id/associations` (`associations.ts`). Deliberately
// returns ONLY `related_id`/`relationship_type` (plus id/created_at/metadata
// for pagination and completeness) — NOT the internal route's
// `related_title`/`related_document_type` join columns. `shipClient.ts`'s
// own `AssociationForwardEdge` docstring explains why: that internal route
// checks access on the ANCHOR document only, never on each joined
// `related_id`, so a private document's title could leak through. This is a
// NEW public v1 endpoint, so it must not reintroduce that leak — the caller
// is expected to re-fetch each `related_id` through `GET /:id` (which DOES
// check access) before trusting anything about it, same discipline
// `expansion.ts` already follows against the internal route.

documentsRouter.get(
  '/:id/associations',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    const parseResult = SubResourceListQuerySchema.safeParse(req.query);
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

    const workspaceId = await resolveWorkspaceOrThrow(req, requestId);
    await assertDocumentExists(id, workspaceId, requestId);

    const values: unknown[] = [id];
    const whereClauses = ['da.document_id = $1'];
    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(da.created_at, da.id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);

    const result = await pool.query<{
      id: string;
      document_id: string;
      related_id: string;
      relationship_type: string;
      created_at: Date;
      /** `created_at::text` — cursor-internal only (TRO-602). */
      created_at_precise: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT da.id, da.document_id, da.related_id, da.relationship_type, da.created_at, da.created_at::text AS created_at_precise, da.metadata
       FROM document_associations da
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY da.created_at DESC, da.id DESC
       LIMIT $${values.length}`,
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
      data: page.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        related_id: row.related_id,
        relationship_type: row.relationship_type,
        metadata: row.metadata ?? {},
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: nextCursor,
    });
  })
);

// ─── GET /api/v1/documents/:id/reverse-associations ────────────────────
//
// Mirrors `getReverseAssociations()` (`shipClient.ts:389-398`) -> internal
// `GET /api/documents/:id/reverse-associations`. Same title-leak avoidance
// as `/associations` above — `document_id` (the row pointing AT this
// document) and `relationship_type` only, no joined title/type.

documentsRouter.get(
  '/:id/reverse-associations',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    const parseResult = SubResourceListQuerySchema.safeParse(req.query);
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

    const workspaceId = await resolveWorkspaceOrThrow(req, requestId);
    await assertDocumentExists(id, workspaceId, requestId);

    const values: unknown[] = [id, workspaceId];
    const whereClauses = ['da.related_id = $1', 'd.workspace_id = $2', 'd.deleted_at IS NULL'];
    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(da.created_at, da.id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);

    const result = await pool.query<{
      id: string;
      document_id: string;
      related_id: string;
      relationship_type: string;
      created_at: Date;
      /** `created_at::text` — cursor-internal only (TRO-602). */
      created_at_precise: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT da.id, da.document_id, da.related_id, da.relationship_type, da.created_at, da.created_at::text AS created_at_precise, da.metadata
       FROM document_associations da
       JOIN documents d ON d.id = da.document_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY da.created_at DESC, da.id DESC
       LIMIT $${values.length}`,
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
      data: page.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        related_id: row.related_id,
        relationship_type: row.relationship_type,
        metadata: row.metadata ?? {},
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: nextCursor,
    });
  })
);

// ─── GET /api/v1/documents/:id/backlinks ────────────────────────────────
//
// Mirrors `getBacklinks()` (`shipClient.ts:403-405`) -> internal
// `GET /api/documents/:id/backlinks` (`backlinks.ts`, `document_links`
// table). Unlike the two association routes above, `shipClient.ts`'s own
// `BacklinkEntry` docstring notes the internal route IS already
// visibility-filtered server-side on the joined source document — but that
// filter is session-user-based (`VISIBILITY_FILTER_SQL` + `req.userId`),
// which a bearer-token `Principal` does not carry the same way. This route
// scopes the join to the caller's own `workspace_id` only, matching every
// other v1 list route's already-established workspace-only precedent (see
// this file's header note on `assertDocumentExists`/the sub-resource
// helpers) — title/document_type are included in the response, same as the
// internal route, since both are ordinary fields of a document already
// known to be in the caller's own workspace.

documentsRouter.get(
  '/:id/backlinks',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    const parseResult = SubResourceListQuerySchema.safeParse(req.query);
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

    const workspaceId = await resolveWorkspaceOrThrow(req, requestId);
    await assertDocumentExists(id, workspaceId, requestId);

    const values: unknown[] = [id, workspaceId];
    const whereClauses = ['dl.target_id = $1', 'd.workspace_id = $2', 'd.deleted_at IS NULL'];
    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(dl.created_at, dl.id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);

    const result = await pool.query<{
      id: string;
      created_at: Date;
      /** `created_at::text` — cursor-internal only (TRO-602). */
      created_at_precise: string;
      document_id: string;
      document_type: string;
      title: string;
      ticket_number: number | null;
    }>(
      `SELECT dl.id, dl.created_at, dl.created_at::text AS created_at_precise, d.id as document_id, d.document_type, d.title, d.ticket_number
       FROM document_links dl
       JOIN documents d ON dl.source_id = d.id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY dl.created_at DESC, dl.id DESC
       LIMIT $${values.length}`,
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
      data: page.map((row) => ({
        id: row.document_id,
        document_type: row.document_type,
        title: row.title,
        display_id:
          row.ticket_number !== null && row.document_type === 'issue'
            ? `#${row.ticket_number}`
            : null,
      })),
      next_cursor: nextCursor,
    });
  })
);

// ─── GET /api/v1/documents/:id/comments ─────────────────────────────────
//
// Mirrors `getComments()` (`shipClient.ts:407-413`) -> internal
// `GET /api/documents/:id/comments` (`comments.ts`).

documentsRouter.get(
  '/:id/comments',
  bearerAuth,
  rateLimitBuckets,
  requireScope('documents:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const id = String(req.params.id);

    const parseResult = SubResourceListQuerySchema.safeParse(req.query);
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

    const workspaceId = await resolveWorkspaceOrThrow(req, requestId);
    await assertDocumentExists(id, workspaceId, requestId);

    const values: unknown[] = [id, workspaceId];
    const whereClauses = ['c.document_id = $1', 'c.workspace_id = $2'];
    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(c.created_at, c.id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);

    const result = await pool.query<{
      id: string;
      document_id: string;
      comment_id: string;
      parent_id: string | null;
      author_id: string | null;
      author_name: string | null;
      author_email: string | null;
      content: string;
      resolved_at: Date | null;
      created_at: Date;
      /** `created_at::text` — cursor-internal only (TRO-602). */
      created_at_precise: string;
      updated_at: Date;
    }>(
      `SELECT c.id, c.document_id, c.comment_id, c.parent_id, c.author_id,
              u.name as author_name, u.email as author_email,
              c.content, c.resolved_at, c.created_at, c.created_at::text AS created_at_precise, c.updated_at
       FROM comments c
       LEFT JOIN users u ON u.id = c.author_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $${values.length}`,
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
      data: page.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        comment_id: row.comment_id,
        parent_id: row.parent_id,
        content: row.content,
        resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
        author: row.author_id
          ? { id: row.author_id, name: row.author_name, email: row.author_email }
          : null,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      next_cursor: nextCursor,
    });
  })
);
