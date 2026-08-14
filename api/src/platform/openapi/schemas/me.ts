/**
 * `/api/v1/me` OpenAPI registration — PF-203 (Linear TRO-404).
 *
 * Closes the same class of gap as `schemas/issues.ts`/`schemas/sprints.ts`:
 * `meRouter` (PF-201, Linear TRO-400) predates PF-202 and was never
 * retrofitted. Unlike the other two, `resources/me.ts` has no request Zod
 * schema to import (no query params, no body) — the response schema below is
 * built directly from `platform/oauth/principal.ts`'s `Principal` interface
 * and `resources/me.ts`'s handler (verified by reading both before writing
 * this), not guessed.
 *
 * `security: BEARER_SECURITY` — `/me` DOES require a valid bearer token
 * (`bearerAuth` is wired ahead of the handler in `resources/me.ts`), it just
 * does not require any particular SCOPE (see that file's header for the
 * deliberate design decision, and `route-fitness.test.ts`'s
 * `KNOWN_EXEMPTIONS` table for how PF-203's fitness test encodes the same
 * exception). OpenAPI's `security` requirement only names which scheme is
 * required (`bearerAuth`), not a per-route scope for an HTTP-bearer scheme —
 * so this registration is identical in shape to every other authenticated
 * route despite the no-scope design.
 */

import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

const MeUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
}).nullable();

const MeAppSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string(),
  name: z.string(),
  is_first_party: z.boolean(),
}).nullable();

/** Matches `meRouter`'s `GET /` handler body exactly
 * (`resources/me.ts:72-85`): `user` populated XOR `app` populated depending
 * on token class (both populated for an authorization_code-grant token —
 * see that file's header), `scopes` always present. */
const MeResponseSchema = z.object({
  user: MeUserSchema,
  app: MeAppSchema,
  scopes: z.array(z.string()),
}).openapi('Me');

v1Registry.register('Me', MeResponseSchema);

// ─── GET /me ─────────────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/me',
  tags: ['Platform'],
  summary: 'Get the calling principal',
  description: 'Identity introspection for the calling bearer token (PF-201): { user, app, scopes }. Requires a valid bearer token but, deliberately, no specific scope — see resources/me.ts for the rationale.',
  security: BEARER_SECURITY,
  responses: {
    200: {
      description: 'The calling principal.',
      content: { 'application/json': { schema: MeResponseSchema } },
    },
    401: {
      description: 'Missing or invalid bearer token.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});
