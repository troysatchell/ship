/**
 * Document schemas - Base document type and document-type-specific properties
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema, BelongsToResponseSchema } from './common.js';

// ============== Document Types ==============

export const DocumentTypeSchema = z.enum([
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
]).openapi({
  description: 'Type of document',
});

registry.register('DocumentType', DocumentTypeSchema);

// ============== Base Document ==============

export const BaseDocumentSchema = z.object({
  id: UuidSchema.openapi({ description: 'Document ID' }),
  title: z.string().openapi({ description: 'Document title' }),
  document_type: DocumentTypeSchema,
  content: z.record(z.unknown()).nullable().openapi({
    description: 'TipTap JSON content',
  }),
  properties: z.record(z.unknown()).openapi({
    description: 'Type-specific properties (see individual document type schemas)',
  }),
  parent_id: UuidSchema.nullable().optional().openapi({
    description: 'Parent document ID for hierarchical wiki pages',
  }),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  archived_at: DateTimeSchema.nullable().optional(),
  deleted_at: DateTimeSchema.nullable().optional(),
  created_by: UuidSchema.optional().openapi({ description: 'User ID who created this document' }),
}).openapi('Document');

registry.register('Document', BaseDocumentSchema);

// ============== Document List Item (lighter response) ==============

export const DocumentListItemSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  document_type: DocumentTypeSchema,
  parent_id: UuidSchema.nullable().optional(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
}).openapi('DocumentListItem');

registry.register('DocumentListItem', DocumentListItemSchema);

// ============== Create/Update Document ==============

export const CreateDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional().default('Untitled').openapi({
    description: 'Document title. Defaults to "Untitled".',
  }),
  document_type: DocumentTypeSchema,
  content: z.record(z.unknown()).optional().openapi({
    description: 'TipTap JSON content',
  }),
  properties: z.record(z.unknown()).optional().openapi({
    description: 'Type-specific properties',
  }),
  parent_id: UuidSchema.nullable().optional().openapi({
    description: 'Parent document ID (for hierarchical wikis)',
  }),
  visibility: z.enum(['private', 'workspace']).optional().default('workspace').openapi({
    description: 'Document visibility scope',
  }),
}).openapi('CreateDocument');

registry.register('CreateDocument', CreateDocumentSchema);

export const UpdateDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.record(z.unknown()).optional(),
  properties: z.record(z.unknown()).optional(),
  parent_id: UuidSchema.nullable().optional(),
  visibility: z.enum(['private', 'workspace']).optional(),
}).openapi('UpdateDocument');

registry.register('UpdateDocument', UpdateDocumentSchema);

// ============== Register Document Endpoints ==============

registry.registerPath({
  method: 'get',
  path: '/documents',
  tags: ['Documents'],
  summary: 'List documents',
  description: 'List documents with optional filtering by type and parent. Paginated (TRO-304): ' +
    'omitting `limit` returns a 100-document page, not the full corpus — pass an explicit ' +
    '`limit` (up to 500) and `offset` to page through or fetch more.',
  request: {
    query: z.object({
      type: DocumentTypeSchema.optional().openapi({
        description: 'Filter by document type',
      }),
      parent_id: UuidSchema.optional().openapi({
        description: 'Filter by parent document ID',
      }),
      limit: z.coerce.number().int().min(1).max(500).optional().openapi({
        description: 'Maximum documents to return (1-500). Omit for a 100-document default page ' +
          '(TRO-304) — pass an explicit value up to 500 to fetch more in one request.',
        example: 100,
      }),
      offset: z.coerce.number().int().min(0).max(100000).optional().openapi({
        description: 'Number of documents to skip, applied after ordering (0-100000). Use with ' +
          '`limit` to page through results.',
        example: 100,
      }),
    }),
  },
  responses: {
    200: {
      description: 'List of documents',
      content: {
        'application/json': {
          schema: z.array(DocumentListItemSchema),
        },
      },
    },
    400: {
      description: 'Invalid type, parent_id, limit, or offset',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            details: z.array(z.object({
              path: z.array(z.union([z.string(), z.number()])).optional(),
              message: z.string(),
            })).optional(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/documents/{id}',
  tags: ['Documents'],
  summary: 'Get document by ID',
  description: 'Retrieve a single document with full content and properties.',
  request: {
    params: z.object({
      id: UuidSchema.openapi({ description: 'Document ID' }),
    }),
  },
  responses: {
    200: {
      description: 'Document details',
      content: {
        'application/json': {
          schema: BaseDocumentSchema,
        },
      },
    },
    404: {
      description: 'Document not found',
      content: {
        'application/json': {
          schema: z.object({ error: z.literal('Document not found') }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/documents',
  tags: ['Documents'],
  summary: 'Create document',
  description: 'Create a new document of any type.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created document',
      content: {
        'application/json': {
          schema: BaseDocumentSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            details: z.array(z.object({
              path: z.array(z.union([z.string(), z.number()])),
              message: z.string(),
            })).optional(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/documents/{id}',
  tags: ['Documents'],
  summary: 'Update document',
  description: 'Update document title, content, or properties.',
  request: {
    params: z.object({
      id: UuidSchema,
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateDocumentSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated document',
      content: {
        'application/json': {
          schema: BaseDocumentSchema,
        },
      },
    },
    404: {
      description: 'Document not found',
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/documents/{id}',
  tags: ['Documents'],
  summary: 'Delete document',
  description: 'Soft-delete a document. Can be restored later.',
  request: {
    params: z.object({
      id: UuidSchema,
    }),
  },
  responses: {
    204: {
      description: 'Document deleted',
    },
    404: {
      description: 'Document not found',
    },
  },
});
