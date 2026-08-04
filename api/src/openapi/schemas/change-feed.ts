/**
 * Change feed schema — "what changed since a cursor" (FG-1 / TRO-312)
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema } from './common.js';
import { DocumentTypeSchema } from './documents.js';

// ============== Change Feed Items ==============

export const ChangedDocumentSchema = z.object({
  dedupe_key: z.string().openapi({ description: 'Stable key for de-duplicating this change across polls with overlapping windows' }),
  id: UuidSchema,
  document_type: DocumentTypeSchema,
  title: z.string(),
  updated_at: DateTimeSchema,
  created_by: UuidSchema.nullable(),
}).openapi('ChangedDocument');

registry.register('ChangedDocument', ChangedDocumentSchema);

export const ChangedHistoryEntrySchema = z.object({
  dedupe_key: z.string(),
  id: z.number().int(),
  document_id: UuidSchema,
  field: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  changed_by: UuidSchema.nullable(),
  automated_by: z.string().nullable().openapi({ description: 'Automation source (e.g. "claude"), or null for a human change' }),
  created_at: DateTimeSchema,
}).openapi('ChangedHistoryEntry');

registry.register('ChangedHistoryEntry', ChangedHistoryEntrySchema);

export const ChangedCommentSchema = z.object({
  dedupe_key: z.string(),
  id: UuidSchema,
  document_id: UuidSchema,
  comment_id: UuidSchema.openapi({ description: 'Thread identifier (matches the TipTap commentId mark)' }),
  parent_id: UuidSchema.nullable(),
  author_id: UuidSchema.nullable(),
  content: z.string(),
  resolved_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
}).openapi('ChangedComment');

registry.register('ChangedComment', ChangedCommentSchema);

export const ChangeFeedResponseSchema = z.object({
  next_cursor: DateTimeSchema.openapi({
    description: 'Pass as `since` on the next poll. Lagged behind "now" by a fixed safety window so a slow transaction cannot be permanently missed — see the endpoint description.',
  }),
  documents: z.array(ChangedDocumentSchema),
  documents_truncated: z.boolean().openapi({ description: 'True if `documents` hit `limit` and more may be pending in this window' }),
  history: z.array(ChangedHistoryEntrySchema),
  history_truncated: z.boolean(),
  comments: z.array(ChangedCommentSchema),
  comments_truncated: z.boolean(),
}).openapi('ChangeFeedResponse');

registry.register('ChangeFeedResponse', ChangeFeedResponseSchema);

// ============== Register Change Feed Endpoint ==============

registry.registerPath({
  method: 'get',
  path: '/change-feed',
  tags: ['Change Feed'],
  summary: 'List changes since a cursor',
  description: 'Workspace-scoped, permission-filtered feed of documents, document_history entries, and comments changed since `since`. The returned `next_cursor` is deliberately lagged behind "now" by a fixed safety window (not advanced to the request time) so that a transaction committing late is never permanently missed — pass it back as `since` on the next poll rather than using your own clock. Each item carries a `dedupe_key` stable across polls with overlapping windows.',
  request: {
    query: z.object({
      since: z.string().datetime().openapi({
        description: 'ISO 8601 datetime cursor — only changes strictly after this instant are returned',
        example: '2026-08-01T00:00:00.000Z',
      }),
      limit: z.coerce.number().int().positive().optional().openapi({
        description: 'Max rows per source (documents/history/comments each capped independently). Default 100, max 500.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Changes since the given cursor',
      content: {
        'application/json': {
          schema: ChangeFeedResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid since or limit',
    },
  },
});
