/**
 * `/api/v1/documents` OpenAPI registration — PF-202 (Linear TRO-402).
 *
 * Wires PF-200's existing request Zod schemas
 * (`platform/api/v1/resources/documents.ts`) into `v1Registry.registerPath`
 * calls, for all three routes: `GET /documents`, `GET /documents/{id}`,
 * `POST /documents`. Deliberately does NOT modify that file's
 * route-handling logic — the only change there was adding `export` to the
 * three schema consts this file imports.
 *
 * The response schemas below (`DocumentResponseSchema`,
 * `DocumentListResponseSchema`) are new: `resources/documents.ts` never had
 * a Zod schema for its response, only a `DocumentRow` TS interface and a
 * `serializeDocument()` function that builds the plain object. This file's
 * `DocumentResponseSchema` matches `serializeDocument()`'s actual output
 * field-for-field (verified by reading that function, `documents.ts:100-109`,
 * before writing this) — not a guess at the shape.
 *
 * Every operation here requires `documents:read` or `documents:write`
 * (`requireScope`, mounted on all three routes in `documents.ts`), so all
 * three document 401/403 responses alongside their success case.
 */

import {
  ListDocumentsQuerySchema,
  CreateDocumentRequestSchema,
  UpdateDocumentRequestSchema,
  DocumentTypeSchema,
  SubResourceListQuerySchema,
} from '../../api/v1/resources/documents.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `serializeDocument()`'s return shape in
 * `platform/api/v1/resources/documents.ts` exactly: id/title/document_type,
 * `properties` defaulted to `{}` (never null), `content`/`visibility`/
 * `created_by`/`completed_at` (TRO-605), and `created_at`/`updated_at` as
 * `Date#toISOString()` strings. `content` is TipTap JSON (`schema.sql:113`) —
 * an arbitrary JSON value, so `z.unknown()`, same as `properties`'s own
 * per-key values — EXCEPT it is `null` for a `visibility: 'private'`
 * document the caller did not create (`serializeDocument()`'s own doc
 * comment has the full reasoning: this route has no other visibility
 * enforcement, a pre-existing disclosed gap, but `content` is new to this
 * ticket and can carry a private document's real body text, so it alone is
 * masked). `visibility` is the `'private' | 'workspace'` text enum
 * (`schema.sql:158`). `yjs_state` deliberately stays unregistered — see
 * that field's own exclusion note in `resources/documents.ts`. */
const DocumentResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Document id.' }),
  title: z.string(),
  document_type: DocumentTypeSchema,
  properties: z.record(z.unknown()),
  content: z.unknown().openapi({ description: "TipTap JSON document content (not the Yjs binary collaboration state, which stays internal-only). Null when visibility is 'private' and the caller is not the document's creator." }),
  visibility: z.enum(['private', 'workspace']).openapi({ description: "'private' or 'workspace'. NOTE (CodeRabbit finding, TRO-605): this route does not currently gate on visibility for most fields — id/title/document_type/properties/visibility/created_by/timestamps are returned for any document in the caller's workspace regardless of this value (a pre-existing, disclosed gap, see resources/documents.ts). Only `content` is actually restricted: it is null for a 'private' document the caller did not create." }),
  created_by: z.string().uuid().nullable().openapi({ description: 'User id of the document creator, or null.' }),
  completed_at: z.string().datetime().nullable().openapi({ description: 'ISO 8601 timestamp when this document (e.g. an issue) was marked done, or null.' }),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 creation timestamp.' }),
  updated_at: z.string().datetime().openapi({ description: 'ISO 8601 last-updated timestamp.' }),
}).openapi('Document');

v1Registry.register('Document', DocumentResponseSchema);

/** Matches the list route's `res.status(200).json({ data, next_cursor })`
 * body exactly (`documents.ts`'s `GET /` handler). */
const DocumentListResponseSchema = z.object({
  data: z.array(DocumentResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('DocumentList');

v1Registry.register('DocumentList', DocumentListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the required scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

// ─── GET /documents ──────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/documents',
  tags: ['Documents'],
  summary: 'List documents',
  description: 'Cursor-paginated list of documents in the caller\'s workspace (PF-200), optionally filtered by document_type. Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: {
    query: ListDocumentsQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of documents.',
      content: { 'application/json': { schema: DocumentListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── GET /documents/{id} ─────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/documents/{id}',
  tags: ['Documents'],
  summary: 'Get a document by id',
  description: 'Fetch a single document by id within the caller\'s workspace. A malformed or non-existent id both produce a not_found error (PF-200 test design AC-4). Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Document id. A non-UUID value 404s rather than validation-failing.' }),
    }),
  },
  responses: {
    200: {
      description: 'The document.',
      content: { 'application/json': { schema: DocumentResponseSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: {
      description: 'No document with this id exists in the caller\'s workspace, or the id is malformed.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// ─── POST /documents ─────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'post',
  path: '/documents',
  tags: ['Documents'],
  summary: 'Create a document',
  description: 'Creates a document in the caller\'s workspace. title is required at this public surface — unlike the internal API, which defaults it to "Untitled" (PF-200 AC-4). Requires the documents:write scope.',
  security: BEARER_SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: CreateDocumentRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'The created document.',
      content: { 'application/json': { schema: DocumentResponseSchema } },
    },
    400: {
      description: 'Invalid request body (e.g. missing title).',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── PATCH /documents/{id} ────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'patch',
  path: '/documents/{id}',
  tags: ['Documents'],
  summary: 'Update a document\'s content',
  description: 'Overwrites a document\'s content field (PF-703, TRO-435) — a deliberately narrow update surface (content only, no title/properties, no document_type filter). Built for the agent gate\'s sdk-mode write path (GateShipClient.setStandupContent). Requires the documents:write scope.',
  security: BEARER_SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Document id. A non-UUID value 404s rather than validation-failing.' }),
    }),
    body: {
      content: { 'application/json': { schema: UpdateDocumentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The updated document.',
      content: { 'application/json': { schema: DocumentResponseSchema } },
    },
    400: {
      description: 'Invalid request body.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: {
      description: 'No document with this id exists in the caller\'s workspace, the id is malformed, or the document is private and the caller is not its creator (TRO-611).',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// ─── PF-205 (Linear TRO-414) — four read-only sub-resources ──────────────
//
// Mirrors the agent's remaining `agent/src/shipClient.ts` document-scoped
// reads. See `resources/documents.ts`'s own header comments on each route
// for why the association responses deliberately omit a joined title/type
// (avoiding the leak `shipClient.ts`'s `AssociationForwardEdge` docstring
// documents against the internal route).

const NOT_FOUND_RESPONSE = {
  description: 'No document with this id exists in the caller\'s workspace, or the id is malformed.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const VALIDATION_RESPONSE = {
  description: 'Invalid query parameters or cursor.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const AssociationEdgeResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'The document_associations row id.' }),
  document_id: z.string().uuid(),
  related_id: z.string().uuid(),
  relationship_type: z.string().openapi({ description: "e.g. 'parent', 'project', 'sprint', 'program', 'blocks'." }),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
}).openapi('AssociationEdge');

v1Registry.register('AssociationEdge', AssociationEdgeResponseSchema);

const AssociationEdgeListResponseSchema = z.object({
  data: z.array(AssociationEdgeResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('AssociationEdgeList');

v1Registry.register('AssociationEdgeList', AssociationEdgeListResponseSchema);

const DocumentIdParam = {
  params: z.object({
    id: z.string().openapi({ description: 'Document id. A non-UUID value 404s rather than validation-failing.' }),
  }),
  query: SubResourceListQuerySchema,
};

v1Registry.registerPath({
  method: 'get',
  path: '/documents/{id}/associations',
  tags: ['Documents'],
  summary: "List a document's forward associations",
  description: 'Cursor-paginated associations FROM this document (document_id = {id}). Deliberately excludes the joined related document\'s title/type — re-fetch each related_id via GET /documents/{id} to check access before trusting it. Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: DocumentIdParam,
  responses: {
    200: {
      description: 'A page of association edges.',
      content: { 'application/json': { schema: AssociationEdgeListResponseSchema } },
    },
    400: VALIDATION_RESPONSE,
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});

v1Registry.registerPath({
  method: 'get',
  path: '/documents/{id}/reverse-associations',
  tags: ['Documents'],
  summary: "List a document's reverse associations",
  description: 'Cursor-paginated associations pointing AT this document (related_id = {id}) — e.g. every issue in a sprint. Same title/type-leak avoidance as /associations. Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: DocumentIdParam,
  responses: {
    200: {
      description: 'A page of association edges.',
      content: { 'application/json': { schema: AssociationEdgeListResponseSchema } },
    },
    400: VALIDATION_RESPONSE,
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});

const BacklinkEntryResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'The id of the document that links to this one.' }),
  document_type: z.string(),
  title: z.string(),
  display_id: z.string().nullable().openapi({ description: "e.g. '#42' for an issue; null for other document types." }),
}).openapi('BacklinkEntry');

v1Registry.register('BacklinkEntry', BacklinkEntryResponseSchema);

const BacklinkListResponseSchema = z.object({
  data: z.array(BacklinkEntryResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('BacklinkList');

v1Registry.register('BacklinkList', BacklinkListResponseSchema);

v1Registry.registerPath({
  method: 'get',
  path: '/documents/{id}/backlinks',
  tags: ['Documents'],
  summary: 'List documents that link to this document',
  description: 'Cursor-paginated documents whose content links to this one (document_links, scoped to the caller\'s workspace). Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: DocumentIdParam,
  responses: {
    200: {
      description: 'A page of backlinks.',
      content: { 'application/json': { schema: BacklinkListResponseSchema } },
    },
    400: VALIDATION_RESPONSE,
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});

const CommentAuthorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
}).nullable();

const CommentResponseSchema = z.object({
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  comment_id: z.string().uuid().openapi({ description: 'Thread identifier (matches the TipTap comment mark).' }),
  parent_id: z.string().uuid().nullable(),
  content: z.string(),
  resolved_at: z.string().datetime().nullable(),
  author: CommentAuthorSchema.openapi({ description: 'null if the author\'s user row no longer exists.' }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('Comment');

v1Registry.register('Comment', CommentResponseSchema);

const CommentListResponseSchema = z.object({
  data: z.array(CommentResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('CommentList');

v1Registry.register('CommentList', CommentListResponseSchema);

v1Registry.registerPath({
  method: 'get',
  path: '/documents/{id}/comments',
  tags: ['Documents'],
  summary: 'List comments on a document',
  description: 'Cursor-paginated comments on this document, oldest-page-first by created_at descending (same keyset order as every other v1 list). Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: DocumentIdParam,
  responses: {
    200: {
      description: 'A page of comments.',
      content: { 'application/json': { schema: CommentListResponseSchema } },
    },
    400: VALIDATION_RESPONSE,
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});
