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
import { UuidSchema, DateTimeSchema, ErrorResponseSchema } from './common.js';

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

export const OAuthAppCreatedResponseSchema = z.object({
  success: z.literal(true),
  data: OAuthAppSchema.omit({ has_secret: true }).extend({
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
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
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
      content: { 'application/json': { schema: ErrorResponseSchema } },
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
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
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
    'rotate and this returns 400.',
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
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/oauth-apps/{id}',
  tags: ['OAuth Apps'],
  summary: 'Revoke an OAuth app',
  description: 'Sets revoked_at on the app. Idempotent-safe: revoking an already-revoked app returns 409.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'OAuth app revoked',
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'OAuth app not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'OAuth app already revoked',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
