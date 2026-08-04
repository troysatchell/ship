/**
 * Common schemas used across multiple endpoints
 */

import { z, registry } from '../registry.js';

// ============== Base Types ==============

export const UuidSchema = z.string().uuid().openapi({
  description: 'UUID identifier',
  example: '550e8400-e29b-41d4-a716-446655440000',
});

export const DateTimeSchema = z.string().datetime().openapi({
  description: 'ISO 8601 datetime string',
  example: '2025-01-30T14:30:00.000Z',
});

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({
  description: 'ISO 8601 date string (YYYY-MM-DD)',
  example: '2025-01-30',
});

// ============== Error Response ==============

export const ErrorResponseSchema = z.object({
  error: z.string().openapi({ description: 'Error code or type' }),
  message: z.string().optional().openapi({ description: 'Human-readable error message' }),
  details: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])).optional(),
    message: z.string(),
  })).optional().openapi({ description: 'Validation error details' }),
}).openapi('ErrorResponse');

registry.register('ErrorResponse', ErrorResponseSchema);

// ============== Pagination ==============

export const PaginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({
    description: 'Page number (1-indexed)',
  }),
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({
    description: 'Items per page (max 100)',
  }),
}).openapi('PaginationParams');

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int().openapi({ description: 'Total number of items' }),
    page: z.number().int().openapi({ description: 'Current page number' }),
    limit: z.number().int().openapi({ description: 'Items per page' }),
    hasMore: z.boolean().openapi({ description: 'Whether more items exist' }),
  });

// ============== Belongs To (Document Associations) ==============

export const BelongsToTypeSchema = z.enum(['program', 'project', 'sprint', 'parent']).openapi({
  description: 'Type of document association (containment only — see the Association schema\'s relationship_type field for the full set, which also includes "blocks")',
});

// FG-15 / TRO-333: the full set of document_associations relationship types,
// including 'blocks' (a dependency edge, not containment). Deliberately kept
// separate from BelongsToTypeSchema — the belongs_to array on documents/issues
// means containment specifically, and 'blocks' must never appear there (see
// api/src/utils/document-crud.ts). Use this schema for the generic
// association CRUD surface (GET/POST/DELETE .../associations), where 'blocks'
// is a valid relationship_type.
export const RelationshipTypeSchema = z.enum(['program', 'project', 'sprint', 'parent', 'blocks']).openapi({
  description: 'Type of document association, including the "blocks" dependency edge',
});

export const BelongsToEntrySchema = z.object({
  id: UuidSchema.openapi({ description: 'ID of the related document' }),
  type: BelongsToTypeSchema,
}).openapi('BelongsToEntry');

registry.register('BelongsToEntry', BelongsToEntrySchema);

export const BelongsToResponseSchema = z.object({
  id: UuidSchema,
  type: BelongsToTypeSchema,
  title: z.string().optional().openapi({ description: 'Title of the related document' }),
  color: z.string().optional().openapi({ description: 'Color of the related document (hex)' }),
}).openapi('BelongsToResponse');

registry.register('BelongsToResponse', BelongsToResponseSchema);

// ============== Document Visibility ==============

export const DocumentVisibilitySchema = z.enum(['private', 'workspace']).openapi({
  description: 'Document visibility scope',
});

// ============== User Reference ==============

export const UserReferenceSchema = z.object({
  id: UuidSchema,
  name: z.string().openapi({ description: 'User display name' }),
  email: z.string().email().optional().openapi({ description: 'User email address' }),
}).openapi('UserReference');

registry.register('UserReference', UserReferenceSchema);

// ============== Success Response Wrapper ==============

export const SuccessResponseSchema = z.object({
  success: z.literal(true),
}).openapi('SuccessResponse');
