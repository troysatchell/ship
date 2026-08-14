/**
 * `/api/v1/audit` OpenAPI registration — PF-501 (Linear TRO-432).
 *
 * Wires `resources/audit.ts`'s existing request Zod schema into a single
 * `v1Registry.registerPath` call, following the same pattern as
 * `platform/openapi/schemas/webhooks.ts` (PF-302) — deliberately does not
 * modify `resources/audit.ts`'s route-handling logic.
 */

import { ListAuditQuerySchema } from '../../api/v1/resources/audit.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `resources/audit.ts`'s `serializeAuditRow()` return shape
 * exactly — the §2.7 column list, verbatim. */
const AuditRowResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Audit row id.' }),
  request_id: z.string().openapi({ description: 'The request_id assigned to the audited call (X-Request-Id).' }),
  app_client_id: z.string().nullable().openapi({
    description: 'The calling oauth_apps.client_id, or null for a personal-token call or an unauthenticated request.',
  }),
  user_id: z.string().uuid().nullable().openapi({
    description: 'The calling user id, or null for a Client Credentials call or an unauthenticated request.',
  }),
  method: z.string().openapi({ description: 'HTTP method of the audited call.' }),
  route: z.string().openapi({ description: 'The literal request path (no query string) of the audited call.' }),
  scope_used: z.string().nullable().openapi({
    description: 'The scope requireScope(...) checked for this route, or null for a route with no scope requirement.',
  }),
  status: z.number().int().openapi({ description: 'HTTP response status of the audited call.' }),
  latency_ms: z.number().int().openapi({ description: 'Server-side latency of the audited call, in milliseconds.' }),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 timestamp the audit row was written.' }),
}).openapi('PublicApiAuditRow');

v1Registry.register('PublicApiAuditRow', AuditRowResponseSchema);

/** Matches the list route's `res.status(200).json({ data, next_cursor })`
 * body exactly. */
const AuditListResponseSchema = z.object({
  data: z.array(AuditRowResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('PublicApiAuditList');

v1Registry.register('PublicApiAuditList', AuditListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description:
    'The bearer token lacks the audit:read scope, OR it holds the scope but the caller is neither a workspace admin, a platform super-admin, nor a first-party app credential (resources/audit.ts\'s "admin/owner-scoped" design).',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

// ─── GET /audit ────────────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/audit',
  tags: ['Audit'],
  summary: 'List the public API audit trail',
  description:
    'Cursor-paginated log of every /api/v1 call (PLUGFORGE.MD §2.7): request_id, app client_id, user_id, method, route, scope checked, status, and latency. Admin/owner-scoped: requires the audit:read scope AND the caller to be a workspace admin, a platform super-admin ("owner"), or a first-party app credential. A workspace admin sees only their own workspace\'s rows; a super-admin sees every workspace. Optional ?app_client_id= filters to one app.',
  security: BEARER_SECURITY,
  request: {
    query: ListAuditQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of public API audit rows.',
      content: { 'application/json': { schema: AuditListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});
