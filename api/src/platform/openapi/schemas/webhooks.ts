/**
 * `/api/v1/webhooks` OpenAPI registration — PF-302 (Linear TRO-431).
 *
 * Wires `resources/webhooks.ts`'s existing request Zod schemas into
 * `v1Registry.registerPath` calls, for all five routes: `POST /webhooks`,
 * `GET /webhooks`, `GET /webhooks/{id}`, `DELETE /webhooks/{id}`,
 * `POST /webhooks/{id}/rotate`. Same pattern as
 * `platform/openapi/schemas/documents.ts` (PF-202) — deliberately does not
 * modify `resources/webhooks.ts`'s route-handling logic.
 *
 * `WebhookSubscriptionCreatedResponseSchema` (the `POST /` and
 * `POST /:id/rotate` response shape) is the one schema in this file with a
 * `secret` field — matching `resources/webhooks.ts#serializeSubscription`
 * plus the two routes' own `{ ...serialized, secret, warning }` spread,
 * verified against that file before writing this (PF-302's own AC: "secret
 * ... returned once"). `WebhookSubscriptionResponseSchema` (every other
 * response) has no such field — there is no way to add one without editing
 * this file, which is exactly the guarantee PF-302's "secret non-recoverable
 * via API after creation" AC needs documented, not just implemented.
 */

import {
  CreateWebhookSubscriptionRequestSchema,
  ListWebhookSubscriptionsQuerySchema,
  ListWebhookDeliveriesQuerySchema,
  WebhookEventTypeSchema,
} from '../../api/v1/resources/webhooks.js';
import { v1Registry, z } from '../registry.js';
import { ApiErrorSchema, BEARER_SECURITY } from './common.js';

/** Matches `serializeSubscription()`'s return shape exactly
 * (`platform/api/v1/resources/webhooks.ts`) — never a `secret` field. */
const WebhookSubscriptionResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Webhook subscription id.' }),
  app_id: z.string().uuid().openapi({ description: 'The oauth_apps id this subscription belongs to.' }),
  event_type: WebhookEventTypeSchema,
  target_url: z.string().url(),
  active: z.boolean(),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 creation timestamp.' }),
}).openapi('WebhookSubscription');

v1Registry.register('WebhookSubscription', WebhookSubscriptionResponseSchema);

/** `POST /webhooks` and `POST /webhooks/{id}/rotate`'s response shape — the
 * ONLY two operations whose 200/201 response ever carries a plaintext
 * secret. */
const WebhookSubscriptionCreatedResponseSchema = WebhookSubscriptionResponseSchema.extend({
  secret: z.string().openapi({
    description:
      'The plaintext whsec_... signing secret. Returned exactly once — this response is the only place it ever appears; it is encrypted at rest (AES-256-GCM) and cannot be recovered via any subsequent API call.',
  }),
  warning: z.string().openapi({ description: 'Human-readable reminder to save the secret now.' }),
}).openapi('WebhookSubscriptionCreated');

v1Registry.register('WebhookSubscriptionCreated', WebhookSubscriptionCreatedResponseSchema);

/** Matches the list route's `res.status(200).json({ data, next_cursor })`
 * body exactly. */
const WebhookSubscriptionListResponseSchema = z.object({
  data: z.array(WebhookSubscriptionResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('WebhookSubscriptionList');

v1Registry.register('WebhookSubscriptionList', WebhookSubscriptionListResponseSchema);

/** Matches `serializeDelivery()`'s return shape exactly
 * (`platform/api/v1/resources/webhooks.ts`) — PF-305 (Linear TRO-442). One
 * row per delivery ATTEMPT (migration 048's row-per-attempt design), never
 * the raw event payload. */
const WebhookDeliveryResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: 'Delivery attempt id.' }),
  subscription_id: z.string().uuid().openapi({ description: 'The webhook_subscriptions id this attempt belongs to.' }),
  event_id: z.string().uuid().openapi({ description: 'The event this attempt delivers. Shared across every attempt (same attempt_number series) of the same logical delivery.' }),
  event_type: WebhookEventTypeSchema,
  idempotency_key: z.string().openapi({ description: 'Stable across every attempt of the same logical delivery — the value sent in the Idempotency-Key header.' }),
  attempt_number: z.number().int().min(1).openapi({ description: '1-indexed attempt number for this logical delivery. A retried delivery has multiple rows sharing event_id, one per attempt_number.' }),
  status: z.enum(['pending', 'success', 'failed', 'dead']).openapi({ description: "This attempt's own state: pending (scheduled, not yet executed), success (2xx), failed (5xx/timeout, a retry was scheduled), or dead (permanent failure — 4xx, or the 6th failed attempt)." }),
  response_status: z.number().int().nullable().openapi({ description: "The subscriber's HTTP response status, or null if this attempt never got a response (still pending, or a network/timeout failure)." }),
  response_excerpt: z.string().nullable().openapi({ description: "Up to 2000 characters of the subscriber's response body, or null if there was none." }),
  latency_ms: z.number().int().nullable().openapi({ description: 'Round-trip latency for this attempt in milliseconds, or null if it never completed.' }),
  next_attempt_at: z.string().datetime().nullable().openapi({ description: 'When the next retry is due (only meaningful on a failed row with a pending sibling), or null if this attempt is terminal (success/dead) or itself still pending execution.' }),
  created_at: z.string().datetime().openapi({ description: 'ISO 8601 timestamp this attempt row was created (its own enqueue time).' }),
}).openapi('WebhookDelivery');

v1Registry.register('WebhookDelivery', WebhookDeliveryResponseSchema);

/** Matches the delivery-log route's `res.status(200).json({ data, next_cursor })`
 * body exactly. */
const WebhookDeliveryListResponseSchema = z.object({
  data: z.array(WebhookDeliveryResponseSchema),
  next_cursor: z.string().nullable().openapi({
    description: 'Opaque keyset cursor for the next page (pass back as ?cursor=), or null when this is the last page.',
  }),
}).openapi('WebhookDeliveryList');

v1Registry.register('WebhookDeliveryList', WebhookDeliveryListResponseSchema);

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid bearer token.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const FORBIDDEN_RESPONSE = {
  description: 'The bearer token lacks the webhooks:manage scope.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const NOT_FOUND_RESPONSE = {
  description: 'No subscription with this id exists in the caller\'s workspace, or the id is malformed.',
  content: { 'application/json': { schema: ApiErrorSchema } },
};

const IdParam = {
  params: z.object({
    id: z.string().openapi({ description: 'Webhook subscription id. A non-UUID value 404s rather than validation-failing.' }),
  }),
};

// ─── POST /webhooks ───────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'post',
  path: '/webhooks',
  tags: ['Webhooks'],
  summary: 'Create a webhook subscription',
  description:
    'Creates a subscription for app_id to event_type deliveries at target_url, generates a whsec_... signing secret, and returns it in plaintext exactly once. The secret is encrypted at rest (AES-256-GCM) and cannot be retrieved again — save it now. app_id must belong to the caller\'s own workspace. Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: {
    body: {
      content: { 'application/json': { schema: CreateWebhookSubscriptionRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'The created subscription, including the plaintext secret (shown exactly once).',
      content: { 'application/json': { schema: WebhookSubscriptionCreatedResponseSchema } },
    },
    400: {
      description: 'Invalid request body, or app_id does not reference an app in the caller\'s workspace.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── GET /webhooks ────────────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/webhooks',
  tags: ['Webhooks'],
  summary: 'List webhook subscriptions',
  description:
    'Cursor-paginated list of webhook subscriptions belonging to apps in the caller\'s workspace. Never includes the signing secret (plaintext or ciphertext). Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: {
    query: ListWebhookSubscriptionsQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of webhook subscriptions.',
      content: { 'application/json': { schema: WebhookSubscriptionListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters or cursor.',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── GET /webhooks/deliveries ─────────────────────────────────────────────
//
// PF-305 (Linear TRO-442). Registered here as a distinct OpenAPI path from
// `/webhooks/{id}` — the two never collide at this layer (OpenAPI paths are
// keyed by their literal string, unlike Express's ordered route matching,
// where `resources/webhooks.ts` registers this route BEFORE `GET /:id` for
// exactly that reason — see that file's own header).

v1Registry.registerPath({
  method: 'get',
  path: '/webhooks/deliveries',
  tags: ['Webhooks'],
  summary: 'List webhook delivery attempts',
  description:
    'Cursor-paginated delivery log: one row per delivery ATTEMPT (a retried delivery leaves multiple rows, one per attempt_number, sharing event_id), scoped to subscriptions belonging to apps in the caller\'s workspace. Filterable by subscription_id and status. Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: {
    query: ListWebhookDeliveriesQuerySchema,
  },
  responses: {
    200: {
      description: 'A page of delivery attempts.',
      content: { 'application/json': { schema: WebhookDeliveryListResponseSchema } },
    },
    400: {
      description: 'Invalid query parameters (a malformed, non-UUID subscription_id, or a status value outside pending/success/failed/dead) or an invalid cursor. A well-formed but unrecognized or cross-workspace subscription_id is NOT an error — it matches nothing and returns 200 with an empty data page (same fail-closed convention as the rest of this resource).',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
  },
});

// ─── GET /webhooks/{id} ───────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'get',
  path: '/webhooks/{id}',
  tags: ['Webhooks'],
  summary: 'Get a webhook subscription by id',
  description:
    'Fetch a single webhook subscription by id, scoped to the caller\'s workspace. Never includes the signing secret. Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: IdParam,
  responses: {
    200: {
      description: 'The subscription.',
      content: { 'application/json': { schema: WebhookSubscriptionResponseSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});

// ─── DELETE /webhooks/{id} ────────────────────────────────────────────────

v1Registry.registerPath({
  method: 'delete',
  path: '/webhooks/{id}',
  tags: ['Webhooks'],
  summary: 'Deactivate a webhook subscription',
  description:
    'Deactivates the subscription (active = false) rather than deleting the row, so a future delivery log can still reference it. Idempotent: deactivating an already-inactive subscription still returns 204. Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: IdParam,
  responses: {
    204: {
      description: 'The subscription was deactivated (or was already inactive).',
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});

// ─── POST /webhooks/{id}/rotate ───────────────────────────────────────────

v1Registry.registerPath({
  method: 'post',
  path: '/webhooks/{id}/rotate',
  tags: ['Webhooks'],
  summary: 'Rotate a webhook subscription\'s signing secret',
  description:
    'Generates a new whsec_... signing secret, returns it in plaintext exactly once, and overwrites the stored ciphertext in place — no grace period (same precedent as PF-102\'s OAuth app-secret rotation): the old secret stops validating new HMAC signatures immediately. Requires the webhooks:manage scope.',
  security: BEARER_SECURITY,
  request: IdParam,
  responses: {
    200: {
      description: 'The subscription, including the new plaintext secret (shown exactly once).',
      content: { 'application/json': { schema: WebhookSubscriptionCreatedResponseSchema } },
    },
    401: UNAUTHORIZED_RESPONSE,
    403: FORBIDDEN_RESPONSE,
    404: NOT_FOUND_RESPONSE,
  },
});
