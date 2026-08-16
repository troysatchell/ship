/**
 * OAuth app registration schemas (PF-102, TRO-408).
 *
 * Internal admin endpoint — `/api/oauth-apps` (session-authed, workspace-admin
 * gated), registered in this EXISTING internal OpenAPI registry, not the
 * separate `/api/v1` platform registry PF-202 adds later. See
 * `api/src/routes/oauth-apps.ts` for the handlers and
 * `api/src/platform/oauth/appRegistration.ts` for the DB logic.
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema, InternalErrorResponseSchema } from './common.js';

// ============== OAuth App ==============

export const OAuthClientTypeSchema = z.enum(['confidential', 'public']).openapi({
  description:
    'confidential apps hold a client secret and authenticate with it at the token endpoint; ' +
    'public apps (browser SPAs) cannot keep a secret safe and use PKCE instead — they never ' +
    'receive a secret.',
});

export const OAuthAppSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  client_id: z.string().openapi({
    description: 'Public client identifier, e.g. ship_app_...',
    example: 'ship_app_3f9c2b1a7e6d4508',
  }),
  client_type: OAuthClientTypeSchema,
  // CodeRabbit (TRO-408 review) suggested restricting registration to
  // HTTPS-only redirect URIs (with a loopback exception). Deliberately
  // deferred: PLUGFORGE.MD §2.1's own PKCE demo example allows
  // `http://localhost:5174`, and the actual security-relevant check —
  // validating a presented `redirect_uri` against this exact registered set
  // — is PF-103's job (`/oauth/authorize`), not registration's. Scheme
  // restriction at registration time is a reasonable future hardening step
  // but belongs with PF-103, where the redirect_uri matching logic already
  // lives, not bolted onto this ticket's create endpoint.
  redirect_uris: z.array(z.string().url()),
  requested_scopes: z.array(z.string()),
  is_first_party: z.boolean(),
  created_at: DateTimeSchema,
  revoked_at: DateTimeSchema.nullable(),
  has_secret: z.boolean().openapi({
    description: 'Whether a confidential-client secret is configured. Never the secret itself.',
  }),
}).openapi('OAuthApp');

registry.register('OAuthApp', OAuthAppSchema);

// ============== Create App ==============

export const CreateOAuthAppSchema = z.object({
  name: z.string().min(1).max(200),
  client_type: OAuthClientTypeSchema,
  redirect_uris: z.array(z.string().url()).max(20).optional(),
  requested_scopes: z.array(z.string().min(1)).max(50).optional(),
}).openapi('CreateOAuthApp');

registry.register('CreateOAuthApp', CreateOAuthAppSchema);

// Carries the full `OAuthApp` shape (not `.omit(...)`) so the create
// response carries the same fields as the detail/list shapes plus the
// once-only secret — CodeRabbit (TRO-408 review) caught this drifting from
// the handler, which originally omitted `is_first_party`/`revoked_at` here;
// the handler now returns the full shape to match.
//
// Deliberately `z.object({ ...OAuthAppSchema.shape, ... })` rather than
// `OAuthAppSchema.extend({...})`: extending an already-`.openapi()`-tagged
// schema makes @asteasolutions/zod-to-openapi emit an `allOf: [$ref, {...}]`
// pair whose second member unconditionally carries a literal
// `default: undefined` own-property (ObjectTransformer's `extendedFrom`
// branch always does `{ ...,  default: defaultValue }`, regardless of
// whether a `.default()` was ever set). `JSON.stringify` drops that
// undefined-valued key silently, which is why openapi.json looks fine, but
// the repo's hand-rolled `jsonToYaml()` (api/src/swagger.ts) walks the raw
// object with `Object.entries` and does not — it emits a bare `default:`
// line at the wrong indentation, which is invalid YAML. Building the merged
// shape as a plain `z.object()` avoids the `extendedFrom` bookkeeping
// entirely, so no such stray key is ever produced. (The generator-level bug
// itself is tracked separately as TRO-490 — this only avoids triggering it.)
export const OAuthAppCreatedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    ...OAuthAppSchema.shape,
    client_secret: z.string().nullable().openapi({
      description:
        'Raw client secret, returned exactly once on creation. null for public clients ' +
        '(they have no secret at all). Never returned by any other endpoint.',
      example: 'ship_appsec_9a1c...redacted...4f',
    }),
    warning: z.string().optional(),
  }),
}).openapi('OAuthAppCreatedResponse');

registry.register('OAuthAppCreatedResponse', OAuthAppCreatedResponseSchema);

export const OAuthAppListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(OAuthAppSchema),
}).openapi('OAuthAppListResponse');

registry.register('OAuthAppListResponse', OAuthAppListResponseSchema);

export const OAuthAppDetailResponseSchema = z.object({
  success: z.literal(true),
  data: OAuthAppSchema,
}).openapi('OAuthAppDetailResponse');

registry.register('OAuthAppDetailResponse', OAuthAppDetailResponseSchema);

export const OAuthAppSecretRotatedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    client_secret: z.string().openapi({
      description:
        'New raw client secret, returned exactly once. The previous secret is invalid ' +
        'immediately — there is no grace period.',
    }),
    warning: z.string(),
  }),
}).openapi('OAuthAppSecretRotatedResponse');

registry.register('OAuthAppSecretRotatedResponse', OAuthAppSecretRotatedResponseSchema);

export const OAuthAppRevokedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    message: z.string(),
  }),
}).openapi('OAuthAppRevokedResponse');

registry.register('OAuthAppRevokedResponse', OAuthAppRevokedResponseSchema);

// ============== Register OAuth App Endpoints ==============

registry.registerPath({
  method: 'post',
  path: '/oauth-apps',
  tags: ['OAuth Apps'],
  summary: 'Register a new OAuth app',
  description:
    'Admin endpoint (workspace-admin only) to register an OAuth app. Confidential apps receive ' +
    'a raw client secret exactly once in this response — it is SHA-256 hashed at rest and never ' +
    'shown or returned again. Public apps receive no secret at all; they authenticate with PKCE.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateOAuthAppSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'OAuth app created, with the raw secret if confidential',
      content: {
        'application/json': {
          schema: OAuthAppCreatedResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/oauth-apps',
  tags: ['OAuth Apps'],
  summary: 'List OAuth apps',
  description: "List the current workspace's registered OAuth apps. Never includes a secret.",
  responses: {
    200: {
      description: 'List of OAuth apps',
      content: {
        'application/json': {
          schema: OAuthAppListResponseSchema,
        },
      },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/oauth-apps/{id}',
  tags: ['OAuth Apps'],
  summary: 'Get OAuth app details',
  description: 'Get a single OAuth app by ID. Never includes a secret.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'OAuth app details',
      content: {
        'application/json': {
          schema: OAuthAppDetailResponseSchema,
        },
      },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/oauth-apps/{id}/rotate',
  tags: ['OAuth Apps'],
  summary: 'Rotate an OAuth app client secret',
  description:
    'Generates a new client secret for a confidential app, returned exactly once. The previous ' +
    'secret is invalid immediately — there is no grace period. Public apps have no secret to ' +
    'rotate and this returns 400. Two concurrent rotations of the same app never both succeed ' +
    '(TRO-492): exactly one wins, and the loser gets 409 with a retry-able message rather than a ' +
    '200 wrapping a secret that is already dead.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'New secret generated',
      content: {
        'application/json': {
          schema: OAuthAppSecretRotatedResponseSchema,
        },
      },
    },
    400: {
      description: 'App is public (no secret to rotate) or already revoked',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    409: {
      description:
        'Lost a race against a concurrent rotation of the same app (TRO-492) — retry the request.',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/oauth-apps/{id}',
  tags: ['OAuth Apps'],
  summary: 'Revoke an OAuth app',
  description:
    'Sets revoked_at on the app. Repeated revocation does not change the original revocation ' +
    'timestamp — it returns 409 instead.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'OAuth app revoked',
      content: {
        'application/json': {
          schema: OAuthAppRevokedResponseSchema,
        },
      },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
    409: {
      description: 'OAuth app already revoked',
      content: { 'application/json': { schema: InternalErrorResponseSchema } },
    },
  },
});
