/**
 * `IWebhookDeliverer` + `InMemoryWebhookDeliverer` — PF-304 (TRO-438,
 * PLUGFORGE.MD §2.6). The last stage of the webhook pipeline
 * docs/architecture.md's "Webhook Pipeline" section names end to end:
 *
 *   domain write (documentService) -> IEventBus.publish -> subscription matcher
 *     -> HMAC signer -> IWebhookDeliverer (retry scheduler) -> delivery log -> DLQ -> replay
 *
 * This file is the subscription matcher, the retry scheduler, and the delivery
 * log/DLQ persistence. `signer.ts` (PF-303) does the HMAC signing; replay
 * (`POST /:id/replay`) is PF-306, not this ticket.
 *
 * ── Precedent for "single-instance, in-memory queue" ──
 * docs/architecture.md's own "Deliverer crash" section: "The webhook deliverer
 * is an in-memory queue on a single Render instance (§2.6 — same justified
 * precedent as FleetGraph's `ItemStore`)". `agent/src/itemStore.ts` accepts the
 * identical risk (process memory as the source of truth for in-flight state,
 * one Render dyno, no horizontal scale-out) for the identical reason: this is
 * a Week 6 MVP shipping on one instance, and a queue-backed implementation
 * (SQS/BullMQ/etc.) is a real future migration, not a YAGNI violation to skip
 * now. `IWebhookDeliverer` is the seam that migration would land behind.
 *
 * ── What survives a crash, and what this file adds beyond that doc's caveat ──
 * "What survives: every attempt already made is persisted to
 * webhook_deliveries before the deliverer moves on... Intended recovery: a
 * boot-time scan for `pending`/`failed` rows whose `next_attempt_at` has
 * passed, re-enqueued into the fresh in-memory queue — this is design intent
 * for PF-304, not yet implemented; state plainly whether it shipped once
 * PF-304 lands." It ships here: `rehydrate()` below. (One refinement from that
 * doc's phrasing: only `'pending'` rows need rehydrating, not `'failed'` ones
 * — in this file's row-per-attempt lifecycle, a `'failed'` row is a completed,
 * terminal record of ONE past attempt; the still-outstanding next attempt it
 * scheduled is itself always a separate `'pending'` sibling row. See the
 * migration 048 header for the full row-lifecycle state machine.)
 *
 * ── Retry schedule (exact, PLUGFORGE.MD §2.6) ──
 * 1s, 4s, 16s, 1m, 5m, 30m + jitter. 5xx or a request timeout -> retry per
 * schedule. 4xx -> permanent failure, dead-lettered immediately, no retries.
 * 6 failed attempts total -> DLQ (`status = 'dead'`).
 *
 * `RETRY_SCHEDULE_MS`'s 6th entry (30m) is defined for fidelity to that exact
 * spec but is unreachable at `MAX_ATTEMPTS = 6`: 6 total attempts means only 5
 * waits are ever computed (attempts 1-5 failing schedule attempts 2-6 at
 * 1s/4s/16s/1m/5m; attempt 6 failing goes straight to DLQ — there is no 7th
 * attempt to wait 30m for). Named here rather than silently dropped, per this
 * repo's claim-provenance convention (`.claude/CLAUDE.md`): the schedule
 * constant matches the PRD's six numbers exactly, even though this ticket's
 * own AC ("6 failed attempts total -> DLQ") means the last one is dead code
 * under the current `MAX_ATTEMPTS`. If a future ticket raises `MAX_ATTEMPTS`,
 * the 30m entry is already correct and waiting.
 *
 * ── Deterministic clock (this ticket's hard, non-negotiable AC) ──
 * Every timing decision — whether an attempt is due, how long it took
 * (`latency_ms`) — reads the injected `Clock` (`clock.ts`), never `Date.now()`
 * directly. `processDue()` does not schedule anything; it inspects "is
 * anything due *right now*, per the clock" and returns. A test drives it by
 * calling `enqueueEvent()`, then alternating `clock.advance(ms)` /
 * `processDue()` — zero real timers anywhere in that loop. The ONE real timer
 * in this file is the per-HTTP-attempt connect/read timeout inside
 * `performHttpAttempt()` (mirrors `agent/src/resilientClient.ts`'s
 * `timedFetch()` exactly: a real `setTimeout` racing the fetch, cleared in a
 * `finally` the instant either settles) — never exercised by this file's own
 * tests, which inject a `fetchImpl` that resolves/rejects synchronously, so
 * the timeout timer is armed and immediately cleared without ever firing.
 * `start()`/`stop()` (the production polling loop that repeatedly calls
 * `processDue()` on a real interval) are wired only from `api/src/index.ts`,
 * the real process entrypoint — never from `app.ts`/`createApp()`, which
 * every test file imports, so no background timer runs during `pnpm test`.
 *
 * ── Workspace scoping (derived, not spelled out verbatim in the ticket) ──
 * The subscription matcher below filters by `event_type` AND the subscribing
 * app's `workspace_id` matching the event's own `workspace_id` (a join through
 * `oauth_apps`, since `webhook_subscriptions` carries no `workspace_id` of its
 * own — see migration 047). The ticket text says only "match ... by
 * event_type"; migration 047's own "supporting index for the future
 * subscription matcher" comment says the same. Without the workspace filter,
 * a subscription created in workspace A would receive every OTHER workspace's
 * events of the same type too — a cross-tenant leak that contradicts every
 * other workspace-scoped query in this codebase (`resolveWorkspaceOrThrow`,
 * `documents.workspace_id`, etc.). Treated as a necessary correctness fix,
 * not scope creep.
 *
 * ── Test-double note ──
 * docs/architecture.md's own test-wiring pseudocode shows
 * `new InMemoryWebhookDeliverer(new FakePool(), new FakeClock())` — a fake
 * `Pool` double. This file's own tests (`__tests__/deliverer.test.ts`) instead
 * use the REAL test Postgres pool (`db/client.ts`'s `pool`), matching this
 * directory's established integration-test convention
 * (`resources/__tests__/webhooks.test.ts`, `oauth/__tests__/device.test.ts`:
 * real DB, only time and the outbound HTTP transport faked) — asserting a
 * `webhook_deliveries` row's `status` after a real `SELECT` is a stronger
 * proof than asserting a call against an in-memory double. Only `Clock` and
 * `fetchImpl` are faked.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { sign, type Clock as SignerClock } from './signer.js';
import { decryptSecret } from './secretEncryption.js';
import { EVENT_TYPES, type EventType } from './events.js';
import type { EventEnvelope, IEventBus, Unsubscribe } from './eventBus.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed' | 'dead';

/** Exact schedule, PLUGFORGE.MD §2.6 — see file header for why index 5 (30m)
 * is unreachable at `MAX_ATTEMPTS = 6`. */
export const RETRY_SCHEDULE_MS = [1_000, 4_000, 16_000, 60_000, 300_000, 1_800_000] as const;

/** "6 failed attempts total -> DLQ" — this ticket's own AC, verbatim. */
export const MAX_ATTEMPTS = 6;

/** `response_excerpt` is an excerpt, not the full body — caps what a
 * misbehaving/huge subscriber response costs to store per attempt row. */
const RESPONSE_EXCERPT_MAX_CHARS = 2000;

/** Default per-attempt connect+read timeout for the outbound POST. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

/** Default production polling interval for `start()` — how often `processDue()`
 * is called to check for due attempts. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface IWebhookDeliverer {
  /**
   * Matches `event` against active `webhook_subscriptions` (by `event_type`
   * and the subscribing app's workspace), and enqueues one attempt-1 delivery
   * per match — persisted as a `'pending'` `webhook_deliveries` row, due
   * immediately. Returns the number of deliveries enqueued (0 if nothing
   * subscribes).
   */
  enqueueEvent(event: EventEnvelope): Promise<number>;
  /**
   * Attempts every queued delivery whose due time has arrived, per the
   * injected `Clock`. Returns the number of attempts made. Safe to call
   * repeatedly / on an interval; a no-op when nothing is due.
   */
  processDue(): Promise<number>;
  /**
   * Boot-time recovery: loads every `'pending'` `webhook_deliveries` row (an
   * attempt that was scheduled but never executed — including because the
   * process crashed between scheduling it and running it) back into the
   * in-memory queue. Returns the number restored. Call once, before serving
   * traffic; safe to call on an empty queue (a fresh deploy with nothing
   * pending restores 0).
   */
  rehydrate(): Promise<number>;
}

/** One scheduled-but-not-yet-executed attempt, held only in process memory
 * until `processDue()` executes it (at which point it becomes a persisted,
 * terminal `webhook_deliveries` row — see migration 048's header for the
 * row lifecycle). */
interface QueuedAttempt {
  deliveryRowId: string;
  subscriptionId: string;
  eventId: string;
  eventType: EventType;
  targetUrl: string;
  signingSecretCiphertext: string;
  /** The exact JSON string this attempt signs and sends — identical across
   * every attempt of the same delivery (the event payload never changes
   * between retries). */
  rawBody: string;
  /** Stable across every attempt of this delivery — see file header. */
  idempotencyKey: string;
  attemptNumber: number;
  dueAtMs: number;
}

type AttemptOutcome =
  | { kind: 'success'; status: number; bodyExcerpt: string }
  | { kind: 'retryable'; status: number | null; bodyExcerpt: string }
  | { kind: 'permanent'; status: number | null; bodyExcerpt: string };

/** Handle returned by `setTimeout`, as accepted by `clearTimeout` — same
 * narrow shape `resilientClient.ts`'s `TimerHandle` documents (only ever
 * stored and passed back, never inspected). */
type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimeoutImpl = (callback: () => void, ms: number) => TimerHandle;
type ClearTimeoutImpl = (handle: TimerHandle) => void;

export interface InMemoryWebhookDelivererOptions {
  /** Injectable outbound transport, for deterministic tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable jitter source (0..1). Defaults to `Math.random`. */
  randomSource?: () => number;
  /** Per-attempt connect+read timeout, in ms. Default 10s. */
  timeoutMs?: number;
  /** Injectable timer, for deterministic tests — mirrors `resilientClient.ts`. */
  setTimeoutImpl?: SetTimeoutImpl;
  clearTimeoutImpl?: ClearTimeoutImpl;
}

/**
 * The single must-ship implementation of `IWebhookDeliverer` — see file
 * header for the full design rationale.
 */
export class InMemoryWebhookDeliverer implements IWebhookDeliverer {
  private readonly pool: Pool;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly setTimeoutImpl: SetTimeoutImpl;
  private readonly clearTimeoutImpl: ClearTimeoutImpl;

  private queue: QueuedAttempt[] = [];
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool, clock: Clock = systemClock, options: InMemoryWebhookDelivererOptions = {}) {
    this.pool = pool;
    this.clock = clock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.random = options.randomSource ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  /** Read-only view of the in-memory queue length — test/observability
   * convenience, never used for a scheduling decision (that's always
   * `dueAtMs <= clock.now()`, computed fresh in `processDue()`). */
  get queueLength(): number {
    return this.queue.length;
  }

  async enqueueEvent(event: EventEnvelope): Promise<number> {
    const matches = await this.pool.query<{
      id: string;
      target_url: string;
      signing_secret_ciphertext: string;
    }>(
      `SELECT ws.id, ws.target_url, ws.signing_secret_ciphertext
       FROM webhook_subscriptions ws
       JOIN oauth_apps a ON a.id = ws.app_id
       WHERE ws.event_type = $1 AND ws.active = true AND a.workspace_id = $2`,
      [event.type, event.workspace_id]
    );

    const rawBody = JSON.stringify(event);
    const dueAtMs = this.clock.now();
    let enqueued = 0;

    for (const subscription of matches.rows) {
      const idempotencyKey = randomUUID();
      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status, next_attempt_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, 1, 'pending', $6)
         RETURNING id`,
        [subscription.id, event.id, event.type, rawBody, idempotencyKey, new Date(dueAtMs).toISOString()]
      );
      const row = inserted.rows[0];
      if (!row) {
        // INSERT ... RETURNING always returns a row on success; this branch
        // is unreachable in practice and exists only so `row.id` below is
        // never read off a possibly-undefined value.
        continue;
      }

      this.queue.push({
        deliveryRowId: row.id,
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        targetUrl: subscription.target_url,
        signingSecretCiphertext: subscription.signing_secret_ciphertext,
        rawBody,
        idempotencyKey,
        attemptNumber: 1,
        dueAtMs,
      });
      enqueued++;
    }

    return enqueued;
  }

  async processDue(): Promise<number> {
    const now = this.clock.now();
    const due: QueuedAttempt[] = [];
    const notYetDue: QueuedAttempt[] = [];
    for (const item of this.queue) {
      if (item.dueAtMs <= now) {
        due.push(item);
      } else {
        notYetDue.push(item);
      }
    }
    this.queue = notYetDue;

    for (const item of due) {
      await this.attempt(item);
    }
    return due.length;
  }

  async rehydrate(): Promise<number> {
    const result = await this.pool.query<{
      id: string;
      subscription_id: string;
      event_id: string;
      event_type: string;
      payload: unknown;
      idempotency_key: string;
      attempt_number: number;
      next_attempt_at: Date | null;
      target_url: string;
      signing_secret_ciphertext: string;
    }>(
      `SELECT wd.id, wd.subscription_id, wd.event_id, wd.event_type, wd.payload, wd.idempotency_key,
              wd.attempt_number, wd.next_attempt_at, ws.target_url, ws.signing_secret_ciphertext
       FROM webhook_deliveries wd
       JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
       WHERE wd.status = 'pending'`
    );

    let restored = 0;
    for (const row of result.rows) {
      this.queue.push({
        deliveryRowId: row.id,
        subscriptionId: row.subscription_id,
        eventId: row.event_id,
        eventType: row.event_type as EventType,
        targetUrl: row.target_url,
        signingSecretCiphertext: row.signing_secret_ciphertext,
        // Re-serialized from the persisted jsonb, not byte-identical to the
        // original `JSON.stringify(event)` (Postgres jsonb does not preserve
        // key order/whitespace) — harmless, because this attempt signs
        // whatever it is about to send, fresh, at send time (see `attempt()`
        // below); it never needs to match a PAST attempt's exact bytes.
        rawBody: JSON.stringify(row.payload),
        idempotencyKey: row.idempotency_key,
        attemptNumber: row.attempt_number,
        dueAtMs: row.next_attempt_at ? row.next_attempt_at.getTime() : this.clock.now(),
      });
      restored++;
    }
    return restored;
  }

  /** Starts the production polling loop: calls `processDue()` on a real
   * interval. Never call this from a test or from `app.ts`/`createApp()` —
   * see file header. Idempotent (a second call while already running is a
   * no-op). */
  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.pollHandle !== null) return;
    this.pollHandle = setInterval(() => {
      void this.processDue().catch((error: unknown) => {
        console.error('webhook deliverer: processDue() failed', error);
      });
    }, intervalMs);
    this.pollHandle.unref?.();
  }

  /** Stops the polling loop started by `start()`. No-op if not running. */
  stop(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private async attempt(item: QueuedAttempt): Promise<void> {
    const secret = decryptSecret(item.signingSecretCiphertext);
    // signer.ts's Clock returns unix SECONDS, not ms — see clock.ts's header
    // for why the two `Clock` shapes are kept distinct.
    const signerClock: SignerClock = () => Math.floor(this.clock.now() / 1000);
    const signatureHeader = sign(item.rawBody, secret, signerClock);

    const startedAtMs = this.clock.now();
    const outcome = await this.performHttpAttempt(item, signatureHeader);
    const latencyMs = Math.max(0, this.clock.now() - startedAtMs);

    if (outcome.kind === 'success') {
      await this.pool.query(
        `UPDATE webhook_deliveries
         SET status = 'success', response_status = $2, response_excerpt = $3, latency_ms = $4, next_attempt_at = NULL
         WHERE id = $1`,
        [item.deliveryRowId, outcome.status, outcome.bodyExcerpt, latencyMs]
      );
      return;
    }

    if (outcome.kind === 'permanent') {
      // 4xx (or any other non-2xx/non-5xx response) — dead-letter
      // immediately per spec, regardless of attempt_number. No retry row.
      await this.pool.query(
        `UPDATE webhook_deliveries
         SET status = 'dead', response_status = $2, response_excerpt = $3, latency_ms = $4, next_attempt_at = NULL
         WHERE id = $1`,
        [item.deliveryRowId, outcome.status, outcome.bodyExcerpt, latencyMs]
      );
      return;
    }

    // outcome.kind === 'retryable' (5xx or timeout).
    if (item.attemptNumber >= MAX_ATTEMPTS) {
      // This was the 6th failed attempt total -> DLQ. No retry row.
      await this.pool.query(
        `UPDATE webhook_deliveries
         SET status = 'dead', response_status = $2, response_excerpt = $3, latency_ms = $4, next_attempt_at = NULL
         WHERE id = $1`,
        [item.deliveryRowId, outcome.status, outcome.bodyExcerpt, latencyMs]
      );
      return;
    }

    // Schedule the next attempt: index 0 = wait after attempt 1 fails (1s),
    // index 1 = wait after attempt 2 fails (4s), etc. The final `?? 1_800_000`
    // is unreachable in practice (RETRY_SCHEDULE_MS always has 6 entries and
    // scheduleIndex is always in range at MAX_ATTEMPTS=6) — it exists only to
    // satisfy `noUncheckedIndexedAccess`'s `number | undefined` result for a
    // variable (non-literal) tuple index, without an `as`/non-null-assertion.
    const scheduleIndex = item.attemptNumber - 1;
    const lastScheduleEntry = RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] ?? 1_800_000;
    const baseDelayMs = RETRY_SCHEDULE_MS[scheduleIndex] ?? lastScheduleEntry;
    // Full jitter (matches agent/src/resilientClient.ts's own `jitter`
    // shape): the scheduled wait is never LESS than the base schedule value,
    // only ever base + up to one more base's worth — so the graded
    // scenario's ">= 1s/4s/16s" assertion is a spec invariant of this
    // formula, not an incidental property of a particular random draw.
    const delayMs = baseDelayMs + this.random() * baseDelayMs;
    const nextAttemptAtMs = this.clock.now() + delayMs;
    const nextAttemptNumber = item.attemptNumber + 1;

    await this.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'failed', response_status = $2, response_excerpt = $3, latency_ms = $4, next_attempt_at = $5
       WHERE id = $1`,
      [item.deliveryRowId, outcome.status, outcome.bodyExcerpt, latencyMs, new Date(nextAttemptAtMs).toISOString()]
    );

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', $7)
       RETURNING id`,
      [
        item.subscriptionId,
        item.eventId,
        item.eventType,
        item.rawBody,
        item.idempotencyKey,
        nextAttemptNumber,
        new Date(nextAttemptAtMs).toISOString(),
      ]
    );
    const nextRow = inserted.rows[0];
    if (!nextRow) return; // unreachable — see the identical guard in enqueueEvent()

    this.queue.push({
      ...item,
      deliveryRowId: nextRow.id,
      attemptNumber: nextAttemptNumber,
      dueAtMs: nextAttemptAtMs,
    });
  }

  private async performHttpAttempt(item: QueuedAttempt, signatureHeader: string): Promise<AttemptOutcome> {
    const controller = new AbortController();
    let timer: TimerHandle | undefined;
    const timeoutMs = this.timeoutMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = this.setTimeoutImpl(() => {
        controller.abort();
        reject(new Error(`webhook delivery timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchImpl(item.targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ship-Signature': signatureHeader,
            'Idempotency-Key': item.idempotencyKey,
          },
          body: item.rawBody,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      const bodyExcerpt = await this.safeExcerpt(response);
      if (response.status >= 200 && response.status < 300) {
        return { kind: 'success', status: response.status, bodyExcerpt };
      }
      if (response.status >= 500) {
        return { kind: 'retryable', status: response.status, bodyExcerpt };
      }
      // 4xx, and defensively anything else non-2xx/non-5xx (1xx/3xx are not
      // meaningful terminal responses to a webhook POST) — permanent per spec.
      return { kind: 'permanent', status: response.status, bodyExcerpt };
    } catch (error) {
      // Network error, abort, or the timeout above — all retryable, same
      // bucket as 5xx ("5xx or timeout -> retry", this ticket's own spec).
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'retryable', status: null, bodyExcerpt: message.slice(0, RESPONSE_EXCERPT_MAX_CHARS) };
    } finally {
      if (timer !== undefined) this.clearTimeoutImpl(timer);
    }
  }

  private async safeExcerpt(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, RESPONSE_EXCERPT_MAX_CHARS);
    } catch {
      return '';
    }
  }
}

/**
 * Wires `deliverer` as an `IEventBus` subscriber for all 8 event types —
 * PF-304's own AC #7. `IEventBus` handlers are deliberately synchronous
 * (`eventBus.ts`'s own header: "A handler that needs to do async work ...
 * enqueues it"), so this handler fires `enqueueEvent()` without awaiting it —
 * `publish()`'s synchronous dispatch loop returns to `documentService`
 * immediately, never blocked on a DB round-trip or on subscription matching.
 * A rejected `enqueueEvent()` is caught and handed to `onEnqueueError`
 * (default: `console.error`) rather than becoming an unhandled promise
 * rejection or propagating back into `publish()`'s dispatch loop, where it
 * would interrupt every OTHER subscriber and, per `eventBus.ts`'s own
 * "throws loudly" design, the original write itself.
 */
export function wireDelivererToEventBus(
  deliverer: IWebhookDeliverer,
  bus: IEventBus,
  onEnqueueError: (error: unknown, event: EventEnvelope) => void = (error, event) => {
    console.error(`webhook deliverer: failed to enqueue deliveries for event ${event.id} (${event.type})`, error);
  }
): Unsubscribe {
  const unsubscribers: Unsubscribe[] = EVENT_TYPES.map((type) =>
    bus.subscribe(type, (event) => {
      void deliverer.enqueueEvent(event).catch((error: unknown) => onEnqueueError(error, event));
    })
  );

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
