/**
 * `/api/v1` OpenAPI 3.1 registry + generator — PF-202 (Linear TRO-402,
 * PLUGFORGE.MD §4, §2.1).
 *
 * A SEPARATE `OpenAPIRegistry` instance from the existing internal one
 * (`api/src/openapi/registry.ts`), not a second consumer of the same
 * registry: §2.1's module layout is explicit that `/api/v1` and `/api/*`
 * are documented separately, and this document targets a different OpenAPI
 * major version (`3.1`, via `OpenApiGeneratorV31`) than the internal
 * registry's `3.0.0` (`OpenApiGeneratorV3`) — merging them into one registry
 * would force one document to describe both.
 *
 * `openapi3-ts@4.5.0` (already an `api` devDependency before this ticket —
 * verified via `node_modules/openapi3-ts/dist` before adding anything) ships
 * an `oas31` module, so no new dependency was needed for the OpenAPI-object
 * typings themselves.
 *
 * `extendZodWithOpenApi(z)` is idempotent — zod-to-openapi's own
 * implementation short-circuits when `ZodType.prototype.openapi` is already
 * defined (`@asteasolutions/zod-to-openapi/dist/index.mjs:52-57`, read
 * before relying on this) — so calling it again here, even though
 * `api/src/openapi/registry.ts` already calls it on the same `zod` module
 * singleton elsewhere in the process (this repo has one `zod` version,
 * `3.25.76`, deduped by pnpm), is safe and keeps this module self-contained
 * rather than depending on import order across two unrelated registries.
 */

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { OpenAPIObject } from 'openapi3-ts/oas31';

extendZodWithOpenApi(z);

/** The v1-only registry. Every `registerPath` call for `/api/v1/*` goes
 * here (see `schemas/*.ts`) — never onto the internal `registry` exported by
 * `api/src/openapi/registry.ts`. */
export const v1Registry = new OpenAPIRegistry();

// Re-export z (already extended above) for schema-registration files, same
// convention as the internal `api/src/openapi/registry.ts`.
export { z };

v1Registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'A public API bearer token: either an OAuth access token (PF-104, PLUGFORGE.MD §2.2 oauth_tokens) or a scoped personal access token (api_tokens.scopes, PF-107). GET /api/v1/me introspects the authenticated principal (PF-201, not yet registered in this document — see this directory\'s README).',
});

/**
 * Generates the `/api/v1` OpenAPI 3.1 document from every path registered
 * on `v1Registry`. Callers should import from `./index.js`, not this file
 * directly, unless they have already imported `./schemas/index.js`
 * themselves — this function only reads whatever is in `v1Registry` at call
 * time, it does not trigger registration.
 */
export function generateV1OpenAPIDocument(): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(v1Registry.definitions);

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Public API',
      version: '1.0.0',
      description: `
The public, versioned Ship API (PLUGFORGE.MD §2.1/§2.4) — distinct from the
internal \`/api/*\` surface documented at \`/api/openapi.json\`. Every
resource here is a typed view over the unified \`documents\` table.

## Authentication

Every endpoint except \`GET /health\` and \`GET /openapi.json\` requires a
bearer token: an OAuth access token or a scoped personal access token. See
\`bearerAuth\` below.

## Errors

Every failure response uses one shape (PLUGFORGE.MD §2.5):

\`\`\`
{ code, message, details?, request_id }
\`\`\`

## Pagination

List endpoints return \`{ data, next_cursor }\`. \`next_cursor\` is an opaque,
keyset-based cursor — pass it back verbatim as \`?cursor=\` for the next page;
\`null\` means there is no next page.
      `.trim(),
    },
    servers: [
      {
        url: '/api/v1',
        description: 'Public API base path',
      },
    ],
  });
}
