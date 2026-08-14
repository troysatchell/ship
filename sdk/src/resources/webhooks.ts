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
 * KNOWN, NOT FIXED BY PF-405: the real PF-302 response shape
 * (`app_id`, singular `event_type`, `target_url`, no `updated_at` — see
 * `platform/api/v1/resources/webhooks.ts`'s `serializeSubscription()`) does
 * not match this file's pre-existing `WebhookSubscription` interface
 * (`app_id`-less, plural `events`, `url`, `updated_at`) — that mismatch
 * predates PF-405 (PF-401 guessed the shape before PF-302 defined it for
 * real) and PF-405's fitness test is deliberately METHOD+PATH-level
 * (operation existence), not response-body-level, so it does not catch
 * this. Flagged here, in the PR body, and left as a follow-up rather than
 * silently fixed or silently ignored — see CHANGES.md's TRO-422 entry.
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
 * A webhook subscription as returned by `list()` (and, once PF-302 lands,
 * presumably a future `get()`). NEVER carries the raw secret — see
 * `CreatedWebhookSubscription` below for the create-only exception.
 * INFERRED, not verified: no server schema exists yet. Shape follows
 * PF-302's ticket prose ("`/api/v1/webhooks` CRUD gated by
 * `webhooks:manage``; ...; active flag") and this SDK's own established
 * per-resource envelope convention (id/created_at/updated_at on everything
 * else in this package).
 */
export interface WebhookSubscription {
  readonly id: string;
  readonly url: string;
  readonly events: readonly WebhookEventType[];
  readonly active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * `create()`'s response — everything `WebhookSubscription` has, plus the
 * raw `whsec_`-prefixed secret. INFERRED from PF-302's ticket prose,
 * verbatim: "`whsec_` secret returned once, AES-256-GCM at rest." Shown
 * exactly once, at creation, matching §2.9's portal design ("secret shown
 * exactly once, copy-to-clipboard, never re-displayed") and PF-102's
 * already-built precedent for OAuth app secrets (`appRegistration.ts`) —
 * the same shown-once pattern this ticket's client types assume PF-302 will
 * follow, not something this SDK enforces itself.
 */
export interface CreatedWebhookSubscription extends WebhookSubscription {
  readonly secret: string;
}

export interface CreateWebhookSubscriptionBody {
  readonly url: string;
  readonly events: readonly WebhookEventType[];
}

export interface ListWebhookSubscriptionsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export type WebhookSubscriptionList = ListPage<WebhookSubscription>;

/**
 * A single delivery attempt log row. INFERRED from PF-305's ticket prose,
 * verbatim: "every attempt visible with attempt_number, response_status,
 * latency_ms." `status` (the delivery's own lifecycle state, distinct from
 * `response_status`'s raw subscriber HTTP status code) is this file's
 * least-verified field — PF-305 says deliveries are filterable "by
 * subscription/status" but names no enum; the four values below are this
 * SDK's own inference from PF-304's retry/DLQ prose ("5xx/timeout retries,
 * 4xx dead-letters immediately, 6 failures -> DLQ"), not a value copied from
 * any schema, because none exists to copy from yet. Flagged here so a
 * future PF-405 parity check (or a human) can correct it against the real
 * server type the moment PF-304/305 land, rather than this guess silently
 * becoming load-bearing.
 */
export interface WebhookDelivery {
  readonly id: string;
  readonly subscription_id: string;
  readonly event_type: WebhookEventType;
  readonly status: 'pending' | 'success' | 'failed' | 'dead_letter';
  readonly attempt_number: number;
  readonly response_status: number | null;
  readonly latency_ms: number | null;
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

  /** `GET /api/v1/webhooks` — list subscriptions. Server route does not
   *  exist yet (PF-302); see this file's header. */
  async listSubscriptions(params: ListWebhookSubscriptionsParams = {}): Promise<WebhookSubscriptionList> {
    return this.request.get<WebhookSubscriptionList>(SUBSCRIPTIONS_PATH, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** `POST /api/v1/webhooks` — create a subscription; the response is the
   *  ONLY place the raw secret is ever returned. Server route does not
   *  exist yet (PF-302); see this file's header. */
  async createSubscription(body: CreateWebhookSubscriptionBody): Promise<CreatedWebhookSubscription> {
    return this.request.post<CreatedWebhookSubscription>(SUBSCRIPTIONS_PATH, body);
  }

  /** `DELETE /api/v1/webhooks/:id`. Server route does not exist yet
   *  (PF-302); see this file's header. */
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
   *  `subscription_id`/`status`. Server route does not exist yet (PF-305);
   *  see this file's header. */
  async listDeliveries(params: ListWebhookDeliveriesParams = {}): Promise<WebhookDeliveryList> {
    return this.request.get<WebhookDeliveryList>(DELIVERIES_PATH, {
      limit: params.limit,
      cursor: params.cursor,
      subscription_id: params.subscription_id,
      status: params.status,
    });
  }

  /** `POST /api/v1/webhooks/deliveries/:id/replay` — re-emits the delivery
   *  with its original `Idempotency-Key`, per PF-306's ticket prose. Server
   *  route does not exist yet (PF-306); see this file's header. */
  async replayDelivery(id: string): Promise<WebhookDelivery> {
    return this.request.post<WebhookDelivery>(`${DELIVERIES_PATH}/${encodeURIComponent(id)}/replay`, {});
  }
}
