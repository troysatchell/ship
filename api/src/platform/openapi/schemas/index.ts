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
// issues/sprints/me (PF-201, Linear TRO-400) predated this registry landing
// and were never retrofitted — closed by PF-203 (Linear TRO-404), whose
// route-fitness test exists specifically to catch this class of drift going
// forward. See each file's header for what it registers.
export * from './issues.js';
export * from './sprints.js';
export * from './me.js';
export * from './webhooks.js';

// Add new /api/v1 resource schema files above this line, and export them
// here.

export { v1Registry, generateV1OpenAPIDocument } from '../registry.js';
