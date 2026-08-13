/**
 * Registers the two `/api/v1` routes that aren't a resource under
 * `resources/` — PF-202 (Linear TRO-402).
 *
 *  - `GET /health` (PF-001, already live on `main`).
 *  - `GET /openapi.json` (this ticket) — the document this file is part of
 *    building documents ITSELF as a route. That isn't circular: this
 *    `registerPath` call only adds an entry describing the response shape
 *    (an opaque JSON object); it doesn't need to read the generated document
 *    to register the path that serves it.
 *
 * Both are public — `security: NO_SECURITY` — per PF-202's architect note
 * ("public, no auth — PF-907 verifies public resolvability on the deployed
 * instance") and PF-001's existing behavior for `/health`.
 */

import { v1Registry, z } from '../registry.js';
import { NO_SECURITY } from './common.js';

const HealthResponseSchema = z.object({
  status: z.literal('ok'),
}).openapi('HealthStatus');

v1Registry.register('HealthStatus', HealthResponseSchema);

v1Registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Platform'],
  summary: 'Health check',
  description: 'Public, unauthenticated liveness check for the /api/v1 surface (PF-001).',
  security: NO_SECURITY,
  responses: {
    200: {
      description: 'The API is up.',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
});

/** Deliberately untyped-by-shape (`z.record(z.unknown())`) rather than a
 * schema describing every OpenAPI document field — this endpoint's response
 * IS this generator's own output, so a fully-typed Zod schema for it would
 * either duplicate the OpenAPI 3.1 meta-schema or go stale the moment a new
 * resource's path is added. `record(unknown())` documents "a JSON object",
 * which is honest about what this endpoint promises beyond that. */
const OpenApiDocumentResponseSchema = z.record(z.unknown()).openapi('OpenApiDocument');

v1Registry.register('OpenApiDocument', OpenApiDocumentResponseSchema);

v1Registry.registerPath({
  method: 'get',
  path: '/openapi.json',
  tags: ['Platform'],
  summary: 'Get the /api/v1 OpenAPI 3.1 document',
  description: 'The generated OpenAPI 3.1 document describing every route on /api/v1 (PF-202). Public, no auth.',
  security: NO_SECURITY,
  responses: {
    200: {
      description: 'The OpenAPI 3.1 document.',
      content: { 'application/json': { schema: OpenApiDocumentResponseSchema } },
    },
  },
});
