import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/**
 * Shared path/query validation (ERR-5, ERR-8).
 *
 * Request **bodies** are already validated up front with zod and return a clean
 * 400 with detail on failure (see `createDocumentSchema` etc. in
 * `routes/documents.ts`). Path and query params bypassed that layer entirely:
 * `GET /api/documents/not-a-uuid` reached Postgres, failed an `invalid input
 * syntax for type uuid` cast, and surfaced as an uncaught 500 (ERR-5). A
 * `limit` query param was accepted with any value and simply never applied
 * (ERR-8) — negative and huge values both returned the full, unpaginated
 * payload.
 *
 * This module extends the same zod approach to params and query instead of
 * inventing a new one, so it should be reused rather than re-implemented
 * per route.
 */

const uuidSchema = z.string().uuid();

/**
 * Sends the same `{ error, details: [{ path, message }] }` shape the existing
 * body-validation 400s already use (see `routes/documents.ts`'s
 * `schema.safeParse(req.body)` branches).
 */
function sendInvalidParam(res: Response, path: string, message: string): void {
  res.status(400).json({
    error: 'Invalid input',
    details: [{ path: [path], message, code: 'invalid_string' }],
  });
}

/**
 * `router.param` callback that validates a `:id`-style path segment as a
 * UUID. Register once per router:
 *
 *   router.param('id', validateUuidParam);
 *
 * and every route in that router using `:id` is guarded — a malformed value
 * (`not-a-uuid`, `not-a-number`, ...) gets a 400 instead of reaching the
 * database. A well-formed but nonexistent id is untouched by this check and
 * still falls through to the route's own 404 handling.
 */
export function validateUuidParam(
  req: Request,
  res: Response,
  next: NextFunction,
  value: string,
  name: string
): void {
  if (!uuidSchema.safeParse(value).success) {
    sendInvalidParam(res, name, 'Invalid uuid');
    return;
  }
  next();
}

/**
 * Zod schema for an optional `limit` query param.
 *
 * - Absent: passes through as `undefined` — callers that never send `limit`
 *   keep whatever behavior they had before this schema existed.
 * - Non-numeric or non-positive (`-1`, `0`, `"abc"`): fails validation, so the
 *   route can return 400.
 * - Above `max`: clamped down to `max` rather than rejected, so a client
 *   asking for an unreasonable amount gets the largest page the endpoint is
 *   willing to serve instead of either an error or (ERR-8's bug) everything.
 */
export function limitQuerySchema(max: number) {
  return z.coerce
    .number({ invalid_type_error: 'limit must be a number' })
    .int('limit must be an integer')
    .positive('limit must be greater than 0')
    .optional()
    .transform((value) => (value === undefined ? value : Math.min(value, max)));
}
