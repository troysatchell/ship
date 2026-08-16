/**
 * Authentication schemas - Login, session, and API tokens
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema } from './common.js';
import { ScopeRegistry } from '../../platform/scopes/registry.js';

// ============== Login ==============

export const LoginRequestSchema = z.object({
  email: z.string().email().openapi({
    description: 'User email address',
    example: 'user@example.com',
  }),
  password: z.string().min(1).openapi({
    description: 'User password',
  }),
}).openapi('LoginRequest');

registry.register('LoginRequest', LoginRequestSchema);

export const LoginResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
    is_admin: z.boolean().optional(),
  }),
  workspace: z.object({
    id: UuidSchema,
    name: z.string(),
    slug: z.string(),
  }).nullable().optional(),
}).openapi('LoginResponse');

registry.register('LoginResponse', LoginResponseSchema);

// ============== Session ==============

export const SessionResponseSchema = z.object({
  user: z.object({
    id: UuidSchema,
    email: z.string().email(),
    name: z.string(),
    is_admin: z.boolean().optional(),
  }),
  workspace: z.object({
    id: UuidSchema,
    name: z.string(),
    slug: z.string(),
    person_id: UuidSchema.optional().openapi({
      description: 'Person document ID for current user',
    }),
    role: z.string().optional(),
  }).nullable(),
}).openapi('SessionResponse');

registry.register('SessionResponse', SessionResponseSchema);

// ============== API Token ==============

// scopes (PF-107 / TRO-430 / TRO-491): non-null on a "scoped personal
// token" — the second token class the v1 bearer middleware accepts
// (`api/src/platform/oauth/bearerAuth.ts`). Null/absent = the pre-existing
// legacy unscoped internal token, unchanged behavior, never valid at
// `/api/v1`. The enum is DERIVED from ScopeRegistry at module load, not
// copied — registry.ts is import-free and registers every scope at load,
// so `names()` is complete by the time this module evaluates. Adding a
// scope is still a single `ScopeRegistry.register(...)` call there; this
// doc updates itself. Runtime enforcement stays in the route handler
// (`api/src/routes/api-tokens.ts` `scopeSchema` refine).
const scopeNames = ScopeRegistry.names();
if (scopeNames.length === 0) {
  throw new Error('ScopeRegistry has no scopes registered at OpenAPI schema load — import order regression');
}
export const ScopeNameSchema = z.enum(scopeNames as [string, ...string[]]).openapi({
  description: 'A scope name registered in ScopeRegistry.',
  example: 'documents:read',
});
const APITokenScopesSchema = z.array(ScopeNameSchema).nullable().openapi({
  description: 'Scopes granted to this token. Null = legacy unscoped token, never valid at /api/v1.',
  example: ['documents:read'],
});

export const APITokenSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  prefix: z.string().openapi({
    description: 'Token prefix for identification (first 8 chars)',
    example: 'ship_abc',
  }),
  last_used_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
  expires_at: DateTimeSchema.nullable(),
  scopes: APITokenScopesSchema,
}).openapi('APIToken');

registry.register('APIToken', APITokenSchema);

export const CreateAPITokenSchema = z.object({
  name: z.string().min(1).max(100).openapi({
    description: 'Descriptive name for the token',
    example: 'CI/CD Pipeline',
  }),
  expires_in_days: z.number().int().min(1).max(365).optional().openapi({
    description: 'Days until token expires (default: never)',
  }),
  scopes: z.array(ScopeNameSchema).min(1).optional().openapi({
    description:
      'Scopes to grant this token, from ScopeRegistry (e.g. "documents:read"). Omit for a legacy unscoped token — never valid at /api/v1.',
    example: ['documents:read'],
  }),
}).openapi('CreateAPIToken');

registry.register('CreateAPIToken', CreateAPITokenSchema);

export const CreateAPITokenResponseSchema = z.object({
  token: APITokenSchema,
  secret: z.string().openapi({
    description: 'Full token value. Only shown once at creation time.',
    example: 'ship_abc123xyz789...',
  }),
}).openapi('CreateAPITokenResponse');

registry.register('CreateAPITokenResponse', CreateAPITokenResponseSchema);

// ============== Register Auth Endpoints ==============

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  tags: ['Authentication'],
  summary: 'Login',
  description: 'Authenticate with email and password. Sets a session cookie on success.',
  security: [], // No auth required for login
  request: {
    body: {
      content: {
        'application/json': {
          schema: LoginRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: {
        'application/json': {
          schema: LoginResponseSchema,
        },
      },
    },
    401: {
      description: 'Invalid credentials',
      content: {
        'application/json': {
          schema: z.object({ error: z.literal('Invalid credentials') }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/logout',
  tags: ['Authentication'],
  summary: 'Logout',
  description: 'End the current session and clear the session cookie.',
  responses: {
    200: {
      description: 'Logout successful',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/session',
  tags: ['Authentication'],
  summary: 'Get current session',
  description: 'Get information about the current authenticated user and workspace.',
  responses: {
    200: {
      description: 'Session information',
      content: {
        'application/json': {
          schema: SessionResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api-tokens',
  tags: ['API Tokens'],
  summary: 'List API tokens',
  description: 'List all API tokens for the current user.',
  responses: {
    200: {
      description: 'List of API tokens',
      content: {
        'application/json': {
          schema: z.array(APITokenSchema),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api-tokens',
  tags: ['API Tokens'],
  summary: 'Create API token',
  description: 'Create a new API token. The full token is only returned once at creation.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateAPITokenSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created API token',
      content: {
        'application/json': {
          schema: CreateAPITokenResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api-tokens/{id}',
  tags: ['API Tokens'],
  summary: 'Delete API token',
  request: {
    params: z.object({
      id: UuidSchema,
    }),
  },
  responses: {
    204: {
      description: 'Token deleted',
    },
    404: {
      description: 'Token not found',
    },
  },
});
