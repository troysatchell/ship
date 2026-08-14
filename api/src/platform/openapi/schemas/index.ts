/**
 * v1 OpenAPI Schema Index — PF-202 (Linear TRO-402).
 *
 * Import all schema modules to register them with `v1Registry`. Mirrors
 * `api/src/openapi/schemas/index.ts`'s "import all schemas to trigger
 * registration" pattern. `common` first (others depend on `ApiErrorSchema`
 * and the security-requirement constants).
 */

export * from './common.js';
export * from './platform.js';
export * from './documents.js';

// Add new /api/v1 resource schema files above this line, and export them
// here — PF-201 (issues/sprints/me) is the next ticket expected to do so.
// See this directory's README for the scope boundary this ticket drew.

export { v1Registry, generateV1OpenAPIDocument } from '../registry.js';
