/**
 * `/api/v1/changes` OpenAPI registration — PF-205 (Linear TRO-414).
 *
 * Wires `resources/changes.ts`'s `GetChangesQuerySchema` into a
 * `v1Registry.registerPath` call. Response schema matches the route
 * handler's actual `res.status(200).json(...)` shape field-for-field
 * (verified by reading `resources/changes.ts` before writing this) — a
 * discriminated union over `resource` for the three change categories,
 * since this endpoint merges `documents`/`document_history`/`comments` into
 * one `data` array (see that file's header for why: PF-203's fitness check
 * (d) requires a `{ data: [...], next_cursor }` shape for any GET collection
 * route, and this is a real merge, not a fake `data` field bolted onto the
 * internal route's three-array shape).
 */

import { GetChangesQuerySchema } from '../../api/v1/resources/changes.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

const ChangedDocumentEntrySchema = z.object({
  resource: z.literal('document'),
  dedupe_key: z.string(),
  id: z.string().uuid(),
  document_type: z.string(),
  title: z.string(),
  updated_at: z.string().datetime(),
  created_by: z.string().uuid().nullable(),
}).openapi('ChangedDocumentEntry');

const ChangedHistoryEntrySchema = z.object({
  resource: z.literal('document_history'),
  dedupe_key: z.string(),
  id: z.number().openapi({ description: 'document_history.id (a SERIAL, not a UUID).' }),
  document_id: z.string().uuid(),
  field: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  changed_by: z.string().uuid().nullable(),
  automated_by: z.string().nullable(),
  created_at: z.string().datetime(),
}).openapi('ChangedHistoryEntry');

const ChangedCommentEntrySchema = z.object({
  resource: z.literal('comment'),
  dedupe_key: z.string(),
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  comment_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable(),
  author_id: z.string().uuid().nullable(),
  content: z.string(),
  resolved_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi('ChangedCommentEntry');

v1Registry.register('ChangedDocumentEntry', ChangedDocumentEntrySchema);
v1Registry.register('ChangedHistoryEntry', ChangedHistoryEntrySchema);
v1Registry.register('ChangedCommentEntry', ChangedCommentEntrySchema);

const ChangeEntrySchema = z.union([
  ChangedDocumentEntrySchema,
  ChangedHistoryEntrySchema,
  ChangedCommentEntrySchema,
]).openapi('ChangeEntry');

v1Registry.register('ChangeEntry', ChangeEntrySchema);

const ChangesResponseSchema = z.object({
  data: z.array(ChangeEntrySchema),
  next_cursor: z.string().datetime().openapi({
    description: 'ISO 8601 timestamp — pass back as ?since= on the next poll. Cursor-lagged: never advanced past (now - 5s), so a slower in-flight transaction cannot be permanently missed. See resources/changes.ts for the full mechanism.',
  }),
  truncated: z.object({
    documents: z.boolean(),
    document_history: z.boolean(),
    comments: z.boolean(),
  }).openapi({ description: 'True per category if that category hit the limit and rows remain for a later poll.' }),
}).openapi('ChangesPage');

v1Registry.register('ChangesPage', ChangesResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the required scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

v1Registry.registerPath({
  method: 'get',
  path: '/changes',
  tags: ['Changes'],
  summary: 'Poll the public change feed',
  description: 'A pull-based, cursor-lagged change feed over documents/document_history/comments in the caller\'s workspace — distinct from webhooks (which push deliveries). since is required; pass the previous response\'s next_cursor as the next since. Requires the documents:read scope.',
  security: BEARER_SECURITY,
  request: {
    query: GetChangesQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of change events.',
      content: { 'application/json': { schema: ChangesResponseSchema } },
    },
    400: {
      description: 'Invalid or missing since, or since is in the future.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});
