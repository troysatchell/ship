/**
 * OpenAPI registration for the RFC 6749 authorization endpoint (PF-103,
 * TRO-412) — `GET /oauth/authorize` + `POST /oauth/authorize/decision`.
 *
 * TRO-551: this is the first pair of routes in the codebase registered
 * OUTSIDE the `/api` prefix. Both are mounted at the application root in
 * `api/src/app.ts` (`app.use('/oauth', createOAuthAuthorizeRouter(...))`),
 * not under `/api` — see `api/src/routes/oauth-authorize.ts`'s module
 * header for why (a browser-navigated RFC 6749 surface, not a JSON API
 * resource). `path` below is therefore already the FULL mount path
 * (`/oauth/authorize`, not `/authorize`), and `servers: ROOT_SERVER`
 * (`../registry.js`) overrides the registry's document-level `servers:
 * [{ url: '/api' }]` for these two operations specifically — see that
 * export's own comment for the OpenAPI 3.0 semantics and why the MCP
 * executor (`api/src/mcp/server.ts`) has to read the same field back.
 *
 * Neither endpoint requires authentication to REACH (an anonymous request
 * to `GET /oauth/authorize` redirects to `/login`, same as any other
 * unauthenticated entry point) — `security: []` follows the exact
 * precedent already in this registry for `POST /auth/login`
 * (`auth.ts`).
 *
 * Neither endpoint returns JSON. Success is always a redirect (`Location`
 * header, no body); failure is either a redirect carrying an
 * `error=<code>` query param (once `redirect_uri` has been verified safe to
 * redirect to) or a minimal static HTML error page (when it has not been —
 * the open-redirect guard documented in `oauth-authorize.ts`). Documented
 * here as such rather than forcing a JSON response shape that does not
 * exist.
 */

import { z, registry, ROOT_SERVER } from '../registry.js';

// ============== Shared field shapes ==============
// Every field below is a plain OAuth query/form parameter — none of them are
// re-validated at the OpenAPI layer beyond "is a string"; the real RFC 6749
// validation (exact redirect_uri match, S256-only, registered scopes, ...)
// lives in api/src/platform/oauth/authorize.ts, same split as every other
// handler in this codebase (schema documents shape, handler enforces rules).

const OAuthAuthorizeFieldsSchema = z.object({
  client_id: z.string().openapi({
    description: 'Public client identifier of a registered OAuth app.',
    example: 'ship_app_3f9c2b1a7e6d4508',
  }),
  redirect_uri: z.string().openapi({
    description: 'Must exactly match one of the app\'s registered redirect URIs (no prefix/substring match).',
  }),
  response_type: z.string().optional().openapi({
    description: 'Must be exactly "code" — this endpoint only supports the authorization_code grant.',
    example: 'code',
  }),
  code_challenge: z.string().optional().openapi({
    description: 'PKCE code challenge (required in practice — its absence redirects with error=invalid_request).',
  }),
  code_challenge_method: z.string().optional().openapi({
    description: 'Must be exactly "S256" — this endpoint is S256-only, "plain" is rejected.',
    example: 'S256',
  }),
  scope: z.string().optional().openapi({
    description: 'Space-delimited scopes. Each must already be registered on the app, or the request is rejected with error=invalid_scope.',
  }),
  state: z.string().optional().openapi({
    description: 'Opaque value round-tripped unchanged onto the redirect (success or error).',
  }),
});

const RedirectLocationHeaderSchema = z.object({
  Location: z.string().openapi({ description: 'Target of the redirect.' }),
});

// ============== GET /oauth/authorize ==============

registry.registerPath({
  method: 'get',
  path: '/oauth/authorize',
  tags: ['OAuth'],
  summary: 'RFC 6749 authorization endpoint',
  description:
    'Browser-navigated entry point for the authorization_code + PKCE (S256-only) grant. Validates ' +
    'the request against the registered OAuth app, then redirects to /login (no session) or ' +
    '/oauth-consent (session present). Never returns JSON. Mounted outside /api — see the ' +
    'servers override on this operation.',
  security: [], // No auth required to REACH this endpoint — see module header.
  servers: ROOT_SERVER,
  request: {
    query: OAuthAuthorizeFieldsSchema,
  },
  responses: {
    302: {
      description:
        'Redirects to /oauth-consent (session present) or /login?returnTo=... (no session), or — ' +
        'once redirect_uri is verified safe — reports a validation failure via redirect to that ' +
        'redirect_uri with an error= query param (unsupported_response_type, invalid_request, or ' +
        'invalid_scope).',
      headers: RedirectLocationHeaderSchema,
    },
    400: {
      description:
        'client_id/redirect_uri missing, or redirect_uri is not registered for this app, or the ' +
        'app/client_id is unknown — the open-redirect guard: never a redirect, a static HTML error ' +
        'page (there is no redirect_uri safe to send the caller to).',
      content: { 'text/html': { schema: z.string() } },
    },
    403: {
      description:
        'The authenticated user\'s workspace does not own this OAuth app — static HTML error page, ' +
        'not a redirect (same open-redirect-guard reasoning as 400).',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});

// ============== POST /oauth/authorize/decision ==============

// Plain `z.object({ ...shape, ... })` rather than `.extend(...)` — matches
// `oauth-apps.ts`'s documented reasoning (see its `OAuthAppCreatedResponseSchema`
// comment): `.extend()` on a schema that has ever been given a component
// `$ref` (via `.openapi('Name')` + `registry.register`) makes the generator
// emit an `allOf: [$ref, {...}]` pair whose second member carries a stray
// `default: undefined`, which this repo's hand-rolled `jsonToYaml()` turns
// into invalid YAML. `OAuthAuthorizeFieldsSchema` below is never registered
// as a named component (no `$ref` involved either way), so this isn't a live
// bug here — kept as plain composition anyway to match the established
// convention rather than re-litigate it per file.
const OAuthAuthorizeDecisionBodySchema = z.object({
  ...OAuthAuthorizeFieldsSchema.shape,
  decision: z.enum(['approve', 'deny']).openapi({
    description: 'The consent page Approve/Deny form field.',
  }),
});

registry.registerPath({
  method: 'post',
  path: '/oauth/authorize/decision',
  tags: ['OAuth'],
  summary: 'Consent page Approve/Deny form target',
  description:
    'Target of the /oauth-consent page\'s plain HTML <form> POST (never fetch() — see the module ' +
    'header on oauth-authorize.ts for why, including why this endpoint carries no CSRF token). ' +
    'Re-validates every field from scratch rather than trusting the GET\'s prior validation. On ' +
    'decision=approve, issues a single-use authorization code and redirects with ?code=...; on ' +
    'decision=deny, redirects with ?error=access_denied. Mounted outside /api — see the servers ' +
    'override on this operation.',
  security: [], // Re-validates the session itself; see module header.
  servers: ROOT_SERVER,
  request: {
    body: {
      content: {
        'application/x-www-form-urlencoded': {
          schema: OAuthAuthorizeDecisionBodySchema,
        },
      },
    },
  },
  responses: {
    303: {
      description:
        'Redirects to the registered redirect_uri, either with ?code=... (approve) or ' +
        '?error=access_denied (deny) — or to /login?returnTo=... if the session is missing/expired.',
      headers: RedirectLocationHeaderSchema,
    },
    400: {
      description:
        'client_id/redirect_uri missing or unregistered, unknown client_id, or an invalid ' +
        '"decision" value — open-redirect guard, static HTML error page, never a redirect.',
      content: { 'text/html': { schema: z.string() } },
    },
    403: {
      description: 'The authenticated user\'s workspace does not own this OAuth app.',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});
