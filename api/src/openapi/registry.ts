/**
 * OpenAPI Registry - Central registration point for all Zod schemas
 *
 * Uses @asteasolutions/zod-to-openapi to auto-generate OpenAPI specs from Zod schemas.
 * All route schemas should be registered here for full API documentation.
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { OpenAPIObject, ServerObject } from 'openapi3-ts/oas30';

// Extend Zod with OpenAPI methods
extendZodWithOpenApi(z);

// Create the global registry
export const registry = new OpenAPIRegistry();

// Re-export z for use in schema definitions
export { z };

// Security schemes
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'API token authentication. Get your token from Settings > API Tokens.',
});

registry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'session',
  description: 'Session cookie authentication. Automatically set after login.',
});

/**
 * Per-operation server override for routes mounted OUTSIDE the global `/api`
 * prefix below (TRO-551). Every existing endpoint in this registry lives
 * under `/api` (`app.ts` mounts its router there), so `registerPath({ path:
 * '/issues', ... })` correctly resolves to `/api/issues` against the
 * document-level `servers: [{ url: '/api' }]`. A route mounted at the
 * application root instead — e.g. `/oauth/authorize`, the RFC 6749
 * authorization endpoint (`app.ts`: `app.use('/oauth', ...)`) — needs its
 * OWN `path` to already be the full mount path (`/oauth/authorize`, not
 * `/api/oauth/authorize`), and the operation has to say so explicitly.
 *
 * Per OpenAPI 3.0 §4.8.10.1, an operation-level `servers` array REPLACES the
 * document-level one for that operation — it does not add to it — so
 * Swagger UI resolves a "Try it out" call against exactly this array, not
 * `/api` + path. `url: '/'` (not `''` — a real, if minimal, URL per the
 * Server Object's own `format: uri-reference` rather than an empty string
 * some OpenAPI tooling other than this repo's own generator/executor may
 * not render as a real "root" server entry — CodeRabbit review, TRO-551)
 * reads as "root path; `path` is already the complete mount path."
 *
 * Pass this on any `registerPath({ ..., servers: ROOT_SERVER })` call for a
 * non-`/api` route. The MCP tool executor (`api/src/mcp/server.ts`,
 * `resolveServerPrefix`) reads the SAME generated `servers` field from
 * `/api/openapi.json` at runtime and builds its request URL from it instead
 * of assuming `/api` — keep that reader in sync with this writer's
 * convention if either changes. `resolveServerPrefix` already strips a
 * single trailing slash from any override, so `'/'` resolves to the same
 * empty-prefix behavior `''` did — this is a presentation fix, not a
 * behavior change (`api/src/mcp/server.test.ts` covers the slash-stripping
 * case directly).
 */
export const ROOT_SERVER: ServerObject[] = [
  {
    url: '/',
    description: 'Mounted at the application root — outside the /api prefix.',
  },
];

/**
 * Generate the complete OpenAPI document from registered schemas
 */
export function generateOpenAPIDocument(): OpenAPIObject {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Ship API',
      version: '1.0.0',
      description: `
Ship is a project and sprint management platform with real-time collaboration.

## Authentication

All endpoints (except /auth/login and /health) require authentication via:
- **Session Cookie**: Automatically set after login (15-minute timeout, 12-hour absolute)
- **Bearer Token**: API tokens from Settings > API Tokens

## Core Concepts

- **Documents**: Everything in Ship is a document (wikis, issues, projects, sprints, etc.)
- **Document Type**: Each document has a \`document_type\` that determines its properties
- **Belongs To**: Documents can be associated via \`belongs_to\` array (programs, projects, sprints, parent issues)

## WebSocket Collaboration

Real-time editing available at \`/collaboration/{docType}:{docId}\` using Yjs CRDT protocol.
      `.trim(),
      contact: {
        name: 'Ship Team',
      },
    },
    servers: [
      {
        url: '/api',
        description: 'API base path',
      },
    ],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  });
}
