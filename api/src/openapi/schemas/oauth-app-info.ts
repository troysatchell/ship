/**
 * OpenAPI registration for `GET /oauth/app-info` (TRO-550, PF-103 follow-up).
 *
 * Restores a real, server-verified app name on the consent screen
 * (`web/src/pages/OAuthConsent.tsx`) without reintroducing the
 * consent-phishing hole that name replaced. Background: `/oauth-consent` is
 * a client-side SPA route, directly reachable with attacker-chosen query
 * params (it does not re-validate anything itself — the real RFC 6749
 * validation happens server-side in `oauth-authorize.ts`, both on the GET
 * that redirects here and again on the decision POST). A display name taken
 * from that query string is therefore not bound to the actual `client_id` at
 * all; a crafted link could set `app_name` to anything. PR #183 (TRO-412
 * PM-triaged review finding) fixed that by dropping the query param
 * entirely and showing generic "This application" copy instead. This
 * endpoint is the safe way back to a real name: it looks the name up
 * server-side, keyed only on `client_id` (a value that is meaningful
 * precisely because it's registered and public, same as GET
 * /oauth/authorize's own trust model), and never accepts a client-supplied
 * name at all — there is no `name` input to this endpoint anywhere.
 *
 * Mounted alongside `GET /oauth/authorize` / `POST /oauth/authorize/decision`
 * in `createOAuthAuthorizeRouter` (`api/src/routes/oauth-authorize.ts`), at
 * the application root under `/oauth` (app.ts) — same `ROOT_SERVER` override
 * as those two operations, for the same reason (TRO-551: `path` here is
 * already the full mount path, not `/api`-prefixed).
 *
 * Error shape: RFC 6749 §5.2's `{ error, error_description }` JSON body —
 * deliberately NOT the `/api/v1` `ApiError` class
 * (`api/src/platform/api/v1/errors.ts`). That file's own header states the PM
 * boundary decision from TRO-416 explicitly: the `ApiError` contract governs
 * `/api/v1` only, and "`/oauth` endpoints speak RFC 6749's own error shape
 * ... not this one." `oauth-token.ts` (PF-104/PF-105) follows the identical
 * rule for its own JSON (non-redirect) error responses. This endpoint is not
 * itself an RFC 6749-defined operation, but it lives in the same `/oauth`
 * family and returns JSON errors the same way its neighbor does, so it
 * follows that established, already-documented precedent rather than
 * introducing a third shape.
 */

import { z, registry, ROOT_SERVER } from '../registry.js';

const OAuthAppInfoQuerySchema = z.object({
  client_id: z.string().openapi({
    description: 'Public client identifier of a registered OAuth app.',
    example: 'ship_app_3f9c2b1a7e6d4508',
  }),
});

const OAuthAppInfoResponseSchema = z.object({
  name: z.string().openapi({
    description: "The registered OAuth app's display name, exactly as stored in oauth_apps.name.",
    example: 'Acme Reporting',
  }),
});

const OAuthAppInfoErrorResponseSchema = z.object({
  error: z.string().openapi({ description: 'RFC 6749 §5.2-style error code.' }),
  error_description: z.string().openapi({ description: 'Human-readable detail.' }),
});

registry.registerPath({
  method: 'get',
  path: '/oauth/app-info',
  tags: ['OAuth'],
  summary: "Look up a registered OAuth app's display name by client_id",
  description:
    'Server-verified app-name lookup for the consent screen (TRO-550). Returns the registered ' +
    'oauth_apps.name for a known, non-revoked client_id. This is the ONLY source of truth for the ' +
    'name the consent screen shows — the query string is never trusted for it (see ' +
    'OAuthConsent.tsx). Unknown and revoked client_ids both produce the same 404 — an attacker ' +
    'probing client_ids should not learn which case applied, matching GET /oauth/authorize\'s own ' +
    'getOAuthAppByClientId behavior. No auth required to reach: client_id is already a public, ' +
    'URL-visible identifier, and the name returned is exactly what is about to be shown to this ' +
    'same user before they decide anything. Mounted outside /api — see the servers override on ' +
    'this operation.',
  security: [], // No auth required to reach — see description.
  servers: ROOT_SERVER,
  request: {
    query: OAuthAppInfoQuerySchema,
  },
  responses: {
    200: {
      description: "The app's registered display name.",
      content: { 'application/json': { schema: OAuthAppInfoResponseSchema } },
    },
    400: {
      description: 'client_id is missing.',
      content: { 'application/json': { schema: OAuthAppInfoErrorResponseSchema } },
    },
    404: {
      description: 'client_id is unknown, or the app has been revoked.',
      content: { 'application/json': { schema: OAuthAppInfoErrorResponseSchema } },
    },
  },
});

export { OAuthAppInfoQuerySchema, OAuthAppInfoResponseSchema, OAuthAppInfoErrorResponseSchema };
