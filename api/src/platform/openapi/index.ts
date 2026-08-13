/**
 * v1 OpenAPI Module Entry Point — PF-202 (Linear TRO-402).
 *
 * Provides the generated `/api/v1` OpenAPI 3.1 document. Mirrors
 * `api/src/openapi/index.ts`: import `./schemas/index.js` first (registers
 * every path as an import side effect), THEN compute the document, so
 * `v1OpenApiDocument` is never read before every `registerPath` call above
 * it has run.
 */

import './schemas/index.js';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { generateV1OpenAPIDocument } from './registry.js';

// Re-export the registry and generator, same convention as
// `api/src/openapi/index.ts`.
export { v1Registry, generateV1OpenAPIDocument } from './registry.js';

/** Generated once at module load (the registry only changes at deploy
 * time), matching `api/src/swagger.ts`'s `swaggerSpec` caching pattern —
 * `platform/api/v1/router.ts` serves this directly rather than calling
 * `generateV1OpenAPIDocument()` per request. */
export const v1OpenApiDocument: OpenAPIObject = generateV1OpenAPIDocument();
