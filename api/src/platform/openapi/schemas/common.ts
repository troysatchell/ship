/**
 * Shared v1 OpenAPI schema pieces — PF-202 (Linear TRO-402).
 *
 * `ApiErrorSchema` is a Zod mirror of `platform/api/v1/errors.ts`'s
 * `ApiErrorBody` interface (PLUGFORGE.MD §2.5's wire shape, verbatim) — the
 * exact JSON body `errorMiddleware.ts` sends for every `/api/v1` failure.
 * Kept in sync by hand with that interface rather than derived from it,
 * because `ApiErrorBody` is a plain TS interface (no Zod schema exists for
 * it — `errorMiddleware.ts` builds the object directly via `ApiError#toJSON`)
 * and introducing a Zod schema there would mean `errors.ts` importing from
 * `platform/openapi/`, which is the wrong direction: this documentation
 * module should depend on the runtime error contract, not the other way
 * around.
 */

import { v1Registry, z } from '../registry.js';

/** `platform/api/v1/errors.ts`'s `ApiErrorCode` union, verbatim. */
export const ApiErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
]).openapi({
  description: 'Machine-readable error code (PLUGFORGE.MD §2.5).',
});

/** The exact §2.5 wire shape every `/api/v1` failure response body is. */
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().openapi({ description: 'Human-readable error message.' }),
  details: z.record(z.unknown()).optional().openapi({
    description: 'Additional error context. Shape varies by code — e.g. validation_failed carries fieldErrors, forbidden carries missing_scope.',
  }),
  request_id: z.string().openapi({
    description: 'Correlates this response with the server-side log line for the same request.',
  }),
}).openapi('ApiError');

v1Registry.register('ApiError', ApiErrorSchema);

/** `security: []` for a route registered with no auth requirement — every
 * other route defaults to `BEARER_SECURITY`. Named for clarity at each call
 * site rather than leaving a bare `[]` to be misread as "not yet decided". */
export const NO_SECURITY: Array<Record<string, string[]>> = [];

/** The standard `security` requirement for a `/api/v1` route gated by
 * `bearerAuth` (every route except health/openapi.json). */
export const BEARER_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
