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
  DocumentTypeSchema,
  SubResourceListQuerySchema,
} from '../../api/v1/resources/documents.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `serializeDocument()`'s return shape in
 * `platform/api/v1/resources/documents.ts` exactly: id/title/document_type,
 * `properties` defaulted to `{}` (never null), and `created_at`/`updated_at`
 * as `Date#toISOString()` strings. */
const DocumentResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Document id.' }),
  title: z.string(),
  document_type: DocumentTypeSchema,
  properties: z.record(z.unknown()),
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
