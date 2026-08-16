/**
 * `webhooks` resource client (PF-401, PLUGFORGE.MD §2.8) — `// create/list/
 * delete subs, deliveries, replay` per the `WebhooksClient` comment in the
 * PRD's own `ShipClient` sketch.
 *
 * SCOPE CHECK (done before writing a line of this file, per this ticket's
 * own brief): does `/api/v1/webhooks*` exist server-side today? No.
 * Verified two ways, not assumed:
 *   1. `api/src/platform/api/v1/router.ts` (read in full) mounts exactly
 *      four v1 resource routers — `documentsRouter`, `issuesRouter`,
 *      `sprintsRouter`, `meRouter` — plus the inline `/health` and
 *      `/openapi.json` handlers. No `webhooksRouter`, no `.use('/webhooks',
 *      ...)` anywhere in that file.
 *   2. `api/src/db/migrations/` has no `webhook_subscriptions` or
 *      `webhook_deliveries` table (`grep -rl "webhook_subscriptions\|
 *      webhook_deliveries" api/src/db/` returns nothing) — migrations
 *      044-046 that PLUGFORGE.MD's original ticket numbering earmarked for
 *      this went to OAuth work instead (`043_oauth_tokens_and_codes.sql`
 *      through `046_oauth_device_codes_polling.sql`).
 * This matches the ticket brief's own prediction exactly: PF-302
 * (subscriptions CRUD), PF-304 (deliverer + retries + DLQ), PF-305
 * (delivery log API), and PF-306 (replay) are separate, not-yet-built
 * tickets. `api/src/platform/webhooks/events.ts` (the 8-event-type registry,
 * PF-300) and `api/src/platform/webhooks/signer.ts` (the HMAC signer,
 * PF-303) DO already exist — this client's `events` field type below is
 * typed against that real, merged registry (values duplicated here, not
 * imported — see the zero-dependency note on `WebhookEventType`), even
 * though nothing can subscribe to them over HTTP yet.
 *
 * CONSEQUENCE FOR THIS TICKET'S AC: "integration tests for each client
 * against a test server" cannot be satisfied for this client — there is no
 * server route to integration-test against. This file is method-signature-
 * and-type-shape work only, built against PLUGFORGE.MD §2.8 and the
 * PF-302/304/305/306 ticket descriptions (the fields on `WebhookSubscription`/
 * `WebhookDelivery` below are inferred from that prose, not verified against
 * a real Zod schema or response body — flagged per-field below). No test in
 * this package fakes a server response for this client or claims it passed
 * an integration test; see `sdk/src/resources/__tests__/webhooks.test.ts`
 * for what IS tested here (request-shape only, mocked `fetch`, explicitly
 * labeled as such) and `CHANGES.md`/the PR body for the same caveat spelled
 * out for a human reviewer.
 *
 * UPDATE — PF-405 (Linear TRO-422). PF-302 landed for real, concurrently
 * with this ticket, with FIVE server routes — `POST /webhooks`,
 * `GET /webhooks`, `GET /webhooks/{id}`, `DELETE /webhooks/{id}`,
 * `POST /webhooks/{id}/rotate` (`platform/openapi/schemas/webhooks.ts`,
 * verified against `platform/api/v1/resources/webhooks.ts`, both read in
 * full before touching this file again). PF-405's own parity fitness test
 * (`sdk/src/__tests__/parity.test.ts`) walks the real, generated
 * `/api/v1/openapi.json` document and would fail on any operation with no
 * SDK method — which `GET /webhooks/{id}` and `POST /webhooks/{id}/rotate`
 * were, until `getSubscription()`/`rotateSecret()` below closed that gap.
 * `listDeliveries()`/`replayDelivery()` still target routes PF-305/PF-306
 * have not built (`/webhooks/deliveries*` — confirmed absent from the real,
 * merged PF-302 registration) — parity.test.ts's `SDK_EXEMPTIONS` table
 * carries those two forward with that exact reason, same mechanism as
 * `iterate()`'s exemption. See parity.test.ts's own header for the full
 * correspondence rule.
 *
 * UPDATE — PF-305 (Linear TRO-442). `GET /webhooks/deliveries` is now a
 * real, merged route (`platform/api/v1/resources/webhooks.ts`) —
 * `listDeliveries()`'s query params (`limit`, `cursor`, `subscription_id`,
 * `status`) already match that route's real `ListWebhookDeliveriesQuerySchema`
 * exactly, so this method needed no signature change; `parity.test.ts` moved
 * it from `SDK_EXEMPTIONS` to a real `SDK_TO_OPERATION` entry.
 * `replayDelivery()` is unaffected — still targets PF-306, not yet built.
 *
 * UPDATE — PF-306 (Linear TRO-446). `POST /webhooks/deliveries/:id/replay`
 * is now a real, merged route (`platform/api/v1/resources/webhooks.ts`) —
 * `replayDelivery()` below needed no signature change (it already took just
 * `id` and returned a `WebhookDelivery`), so `parity.test.ts` moved it from
 * `SDK_EXEMPTIONS` to a real `SDK_TO_OPERATION` entry, per that table's own
 * "delete this line" instruction. `replayed_from_id` (non-null on a replay
 * row, pointing at the delivery it replayed — migration 050) IS now declared
 * on `WebhookDelivery` (CodeRabbit, PR #229's review, fixed).
 *
 * UPDATE — TRO-599 (this ticket; rule 28 of
 * `.claude/skills/ship-factory/references/lessons.md` was written from this
 * exact pattern recurring twice — PF-405's `WebhookSubscription` gap and
 * PF-305's `WebhookDelivery` gap this file used to carry below). Both
 * response-shape gaps are now FIXED, verified field-for-field against
 * `serializeSubscription()`/`serializeDelivery()`
 * (`platform/api/v1/resources/webhooks.ts`, including the two routes' own
 * literal response-object construction) and cross-checked against the
 * independent `platform/openapi/schemas/webhooks.ts` Zod schemas (both read
 * in full, and the generated `/api/v1` OpenAPI document introspected
 * directly, before touching this file):
 *   - `WebhookSubscription` now has `app_id`, singular `event_type`,
 *     `target_url`, and no `updated_at` (the real serializer never sets
 *     one — `webhook_subscriptions`, migration 047, has no `updated_at`
 *     column at all).
 *   - `CreatedWebhookSubscription` (the `POST /` and `POST /:id/rotate`
 *     response) now also declares `warning: string` — present on every
 *     real response from both routes (`{ ...serializeSubscription(row),
 *     secret, warning }`, literally at both call sites) but never declared
 *     here before. Not one of TRO-599's two NAMED instances (the ticket
 *     names `WebhookSubscription`/`WebhookDelivery` specifically), but the
 *     same class of defect on the same interface family, found by reading
 *     the routes' actual response construction rather than trusting that
 *     two-item list as exhaustive — see `CHANGES.md`'s TRO-599 entry for
 *     why this was fixed rather than only flagged.
 *   - `WebhookDelivery.status`'s real 4th value is `'dead'`, not the old
 *     guessed `'dead_letter'`, and the interface now also declares
 *     `event_id`, `idempotency_key`, `response_excerpt`, and
 *     `next_attempt_at` — all four present on every real
 *     `GET /webhooks/deliveries` and `POST /webhooks/deliveries/:id/replay`
 *     response, none previously declared.
 * The existing mocked-`fetch` request-shape suite
 * (`sdk/src/resources/__tests__/webhooks.test.ts`) and a new real-server
 * round-trip regression suite
 * (`sdk/src/resources/__tests__/webhooks.liveServer.test.ts`) both assert
 * the corrected shapes now. A new response-shape fitness test
 * (`sdk/src/__tests__/webhookResponseShape.test.ts`) locks the declared
 * field set (names AND nullability) of both interfaces against the real,
 * generated OpenAPI schemas, so a third recurrence of this bug class fails
 * a test instead of requiring a third manual disclosure — see that file's
 * own header for why it is scoped to webhooks specifically rather than
 * generalized to every SDK resource in this same ticket.
 *
 * UPDATE — TRO-607 (this ticket; found while verifying TRO-599, explicitly
 * OUT OF SCOPE for that ticket which targeted only the two RESPONSE types):
 * `CreateWebhookSubscriptionBody` below (`createSubscription()`'s request
 * body) has been FIXED. Was `url`/plural `events`; is now `app_id`/singular
 * `event_type`/`target_url`, matching the real `POST /api/v1/webhooks` route's
 * `CreateWebhookSubscriptionRequestSchema` (`platform/api/v1/resources/webhooks.ts`,
 * verified by reading that file in full). All three fields are required. A
 * regression test added to `sdk/src/__tests__/webhooks.liveServer.test.ts`
 * calls the method against a real server with the corrected body shape,
 * confirming the fix end-to-end.
 */
import type { RequestClient } from '../internal/requestClient.js';
import type { ListPage } from '../types.js';

const SUBSCRIPTIONS_PATH = '/api/v1/webhooks';
const DELIVERIES_PATH = '/api/v1/webhooks/deliveries';

/**
 * The 8 event types PF-300's registry (`api/src/platform/webhooks/events.ts`,
 * real, already-merged code — read in full before writing this) actually
 * enumerates (`EVENT_TYPES`, that file's own export). Duplicated here rather
 * than imported, for the same zero-runtime/zero-workspace-dependency reason
 * `../types.ts`'s `DocumentType`/`IssueState` etc. are duplicated rather
 * than imported from `@ship/shared` or `api/`.
 */
export type WebhookEventType =
  | 'document.created'
  | 'document.updated'
  | 'document.deleted'
  | 'issue.created'
  | 'issue.assigned'
  | 'issue.status_changed'
  | 'sprint.started'
  | 'sprint.completed';

/**
 * A webhook subscription, as returned by `listSubscriptions()`,
 * `getSubscription()`, `deleteSubscription()`'s underlying route, and (sans
 * the extra fields) the base of `CreatedWebhookSubscription`. NEVER carries
 * the raw secret — see `CreatedWebhookSubscription` below for the
 * create/rotate-only exception. VERIFIED (TRO-599) against
 * `serializeSubscription()` and `WebhookSubscriptionRow`
 * (`platform/api/v1/resources/webhooks.ts`), and cross-checked against the
 * independent `WebhookSubscriptionResponseSchema` Zod schema
 * (`platform/openapi/schemas/webhooks.ts`) — both agree exactly. A
 * subscription belongs to an `app_id` (`oauth_apps`, migration 047), not
 * directly to a workspace or user, and the row has no `updated_at` column
 * at all — every field below is required (never optional, never absent).
 */
export interface WebhookSubscription {
  readonly id: string;
  readonly app_id: string;
  readonly event_type: WebhookEventType;
  readonly target_url: string;
  readonly active: boolean;
  readonly created_at: string;
}

/**
 * `createSubscription()`'s and `rotateSecret()`'s response — everything
 * `WebhookSubscription` has, plus the raw `whsec_`-prefixed secret and a
 * human-readable reminder to save it. VERIFIED (TRO-599) against both
 * routes' literal response construction (`{ ...serializeSubscription(row),
 * secret: plaintextSecret, warning: 'Save this secret now. It will not be
 * shown again.' }`, `platform/api/v1/resources/webhooks.ts`) and the
 * independent `WebhookSubscriptionCreatedResponseSchema` Zod schema
 * (`platform/openapi/schemas/webhooks.ts`) — both agree exactly, including
 * `warning`, which this interface did not declare before TRO-599. Shown
 * exactly once, at creation or rotation — the secret is never recoverable
 * via any other call.
 */
export interface CreatedWebhookSubscription extends WebhookSubscription {
  readonly secret: string;
  readonly warning: string;
}

/**
 * `createSubscription()`'s request body. VERIFIED (TRO-607) against
 * `CreateWebhookSubscriptionRequestSchema` (`platform/api/v1/resources/webhooks.ts`),
 * which requires `app_id` (uuid), singular `event_type`, and `target_url`.
 * All three fields are required (never optional). The subscription belongs to
 * an `app_id` (`oauth_apps`, migration 047), not directly to a workspace or
 * user — the caller supplies it in every create request.
 */
export interface CreateWebhookSubscriptionBody {
  readonly app_id: string;
  readonly event_type: WebhookEventType;
  readonly target_url: string;
}

export interface ListWebhookSubscriptionsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export type WebhookSubscriptionList = ListPage<WebhookSubscription>;

/**
 * A single delivery ATTEMPT log row (migration 048's row-per-attempt
 * design — a retried delivery leaves multiple rows, one per
 * `attempt_number`, sharing `event_id`), as returned by `listDeliveries()`
 * and `replayDelivery()`. VERIFIED (TRO-599) against `serializeDelivery()`
 * and `WebhookDeliveryRow` (`platform/api/v1/resources/webhooks.ts`), and
 * cross-checked against the independent `WebhookDeliveryResponseSchema` Zod
 * schema (`platform/openapi/schemas/webhooks.ts`) — both agree exactly.
 * Every field is required (never absent); the five marked nullable below
 * can genuinely be `null` in a real response, verified against both the
 * serializer and the OpenAPI schema's own nullable typing.
 */
export interface WebhookDelivery {
  readonly id: string;
  readonly subscription_id: string;
  /** The event this attempt delivers — shared across every attempt
   *  (same `attempt_number` series) of the same logical delivery. */
  readonly event_id: string;
  readonly event_type: WebhookEventType;
  /** Stable across every attempt of the same logical delivery — the value
   *  sent in the `Idempotency-Key` header. */
  readonly idempotency_key: string;
  readonly attempt_number: number;
  /** This attempt's own lifecycle state: `pending` (scheduled, not yet
   *  executed), `success` (2xx), `failed` (5xx/timeout, a retry was
   *  scheduled), or `dead` (permanent failure — 4xx, or the 6th failed
   *  attempt). The real 4th value is `dead`, NOT `dead_letter` — the guess
   *  this interface carried before TRO-599; a client checking
   *  `=== 'dead_letter'` never matched a real dead-lettered row. */
  readonly status: 'pending' | 'success' | 'failed' | 'dead';
  /** The subscriber's HTTP response status, or `null` if this attempt never
   *  got a response (still pending, or a network/timeout failure). */
  readonly response_status: number | null;
  /** Up to 2000 characters of the subscriber's response body, or `null` if
   *  there was none. */
  readonly response_excerpt: string | null;
  readonly latency_ms: number | null;
  /** When the next retry is due (only meaningful on a `failed` row with a
   *  pending sibling), or `null` if this attempt is terminal
   *  (`success`/`dead`) or itself still pending execution. */
  readonly next_attempt_at: string | null;
  /** Non-null only for a row created by `replayDelivery()` — the id of the
   *  delivery it replayed. Added for PF-306/TRO-446 (CodeRabbit, PR #229's
   *  review). */
  readonly replayed_from_id: string | null;
  readonly created_at: string;
}

export interface ListWebhookDeliveriesParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly subscription_id?: string;
  readonly status?: WebhookDelivery['status'];
}

export type WebhookDeliveryList = ListPage<WebhookDelivery>;

export class WebhooksClient {
  constructor(private readonly request: RequestClient) {}

  /** `GET /api/v1/webhooks` — list subscriptions. Real, merged PF-302
   *  route (`platform/api/v1/resources/webhooks.ts`) — never includes the
   *  signing secret. */
  async listSubscriptions(params: ListWebhookSubscriptionsParams = {}): Promise<WebhookSubscriptionList> {
    return this.request.get<WebhookSubscriptionList>(SUBSCRIPTIONS_PATH, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** `POST /api/v1/webhooks` — create a subscription. Real, merged PF-302
   *  route. The response is ONE of two places the raw secret is ever
   *  returned — the other is `rotateSecret()` below; every other method on
   *  this client never includes it. */
  async createSubscription(body: CreateWebhookSubscriptionBody): Promise<CreatedWebhookSubscription> {
    return this.request.post<CreatedWebhookSubscription>(SUBSCRIPTIONS_PATH, body);
  }

  /** `DELETE /api/v1/webhooks/:id`. Real, merged PF-302 route — deactivates
   *  (`active = false`) rather than a hard delete; idempotent `204`. */
  async deleteSubscription(id: string): Promise<void> {
    return this.request.delete(`${SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}`);
  }

  /** `GET /api/v1/webhooks/:id` (PF-405, Linear TRO-422 — the real PF-302
   *  route this client had no method for until now; see this file's
   *  header). Never includes the signing secret, same as `listSubscriptions()`. */
  async getSubscription(id: string): Promise<WebhookSubscription> {
    return this.request.get<WebhookSubscription>(`${SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}`);
  }

  /** `POST /api/v1/webhooks/:id/rotate` (PF-405, Linear TRO-422 — same gap
   *  as `getSubscription()` above). Mints a new `whsec_...` secret and
   *  returns it in plaintext exactly once, no grace period — the old
   *  secret stops validating immediately (`platform/api/v1/resources/
   *  webhooks.ts`'s own header). */
  async rotateSecret(id: string): Promise<CreatedWebhookSubscription> {
    return this.request.post<CreatedWebhookSubscription>(`${SUBSCRIPTIONS_PATH}/${encodeURIComponent(id)}/rotate`, {});
  }

  /** `GET /api/v1/webhooks/deliveries` — paginated, filterable by
   *  `subscription_id`/`status`. Real, merged PF-305 route (Linear
   *  TRO-442, `platform/api/v1/resources/webhooks.ts`). The response-shape
   *  gap this method's return type used to have (`status`'s `'dead_letter'`
   *  vs the real `'dead'`, and four missing fields) is fixed as of TRO-599
   *  — see `WebhookDelivery`'s own doc comment above. */
  async listDeliveries(params: ListWebhookDeliveriesParams = {}): Promise<WebhookDeliveryList> {
    return this.request.get<WebhookDeliveryList>(DELIVERIES_PATH, {
      limit: params.limit,
      cursor: params.cursor,
      subscription_id: params.subscription_id,
      status: params.status,
    });
  }

  /** `POST /api/v1/webhooks/deliveries/:id/replay` (PF-306, Linear TRO-446)
   *  — re-emits a logged delivery, carrying its ORIGINAL `Idempotency-Key`
   *  (never a freshly generated one), and returns the NEW delivery row this
   *  creates (the original is never mutated), with `replayed_from_id` set to
   *  the original's id. Works regardless of the original delivery's status,
   *  `dead` (DLQ) included. Real, merged route. The response-shape gap this
   *  method's return type used to have is fixed as of TRO-599 (unrelated to
   *  replay itself) — see `WebhookDelivery`'s own doc comment above. */
  async replayDelivery(id: string): Promise<WebhookDelivery> {
    return this.request.post<WebhookDelivery>(`${DELIVERIES_PATH}/${encodeURIComponent(id)}/replay`, {});
  }
}
