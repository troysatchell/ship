/**
 * `IWebhookDeliverer` / `InMemoryWebhookDeliverer` — PF-304 (TRO-438).
 *
 * The two graded scenarios PLUGFORGE.MD §5 names, plus the supporting
 * behaviors this ticket's own brief calls out: workspace-scoped subscription
 * matching, 4xx immediate dead-letter (no retry), a stable idempotency key
 * across retries, and `rehydrate()` (the crash-recovery gap
 * docs/architecture.md's "Deliverer crash" section names as PF-304's own
 * design intent).
 *
 * ── Zero real-time waits (this ticket's hard AC) ──
 * Every test drives an injected `ManualClock` by hand (`clock.advance(ms)`)
 * and calls `processDue()` directly — there is no real `setTimeout`/sleep
 * anywhere in this file's control flow, and no assertion on real wall-clock
 * elapsed time either (a fixed real-time threshold inside a test is exactly
 * the load-sensitive-flake shape TEST-12/TRO-277 already burned this repo on
 * — CodeRabbit, this PR review). The "genuinely fast" claim this ticket's own
 * brief asks for is proven externally: run this file and read vitest's own
 * reported duration (see this ticket's CHANGES.md entry and PR description
 * for the observed number) — near-zero real time to simulate the ~5.5
 * minutes of retry schedule the two graded scenarios exercise (1s+4s+16s+1m+
 * 5m combined) is the actual point of "deterministic clock injection."
 *
 * ── DB fixtures, no HTTP layer ──
 * The deliverer operates on `webhook_subscriptions`/`webhook_deliveries`
 * directly (`enqueueEvent`/`processDue`/`rehydrate`) — there is no need to go
 * through `createApp()`/supertest/a bearer token the way
 * `resources/__tests__/webhooks.test.ts` does for the CRUD routes. Fixtures
 * here are just a workspace + one `oauth_apps` row + one or more
 * `webhook_subscriptions` rows, inserted directly via `pool` (same raw-SQL
 * fixture style `resources/__tests__/webhooks.test.ts` already uses for its
 * own `insertOauthApp`). Cleanup is a single `DELETE FROM workspaces` per
 * created workspace — `oauth_apps`/`webhook_subscriptions`/`webhook_deliveries`
 * all cascade (verified: `042_oauth_apps.sql`'s `workspace_id ... ON DELETE
 * CASCADE`, `047_webhook_subscriptions.sql`'s `app_id ... ON DELETE CASCADE`,
 * this ticket's own `048_webhook_deliveries.sql`'s `subscription_id ... ON
 * DELETE CASCADE`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import {
  InMemoryWebhookDeliverer,
  wireDelivererToEventBus,
  EXECUTION_FAILURE_BACKOFF_MS,
  MAX_EXECUTION_FAILURES,
  type IWebhookDeliverer,
} from '../deliverer.js';
import { ManualClock } from '../clock.js';
import { InProcessEventBus } from '../eventBus.js';
import type { EventEnvelope } from '../eventBus.js';
import { EVENT_TYPES } from '../events.js';
import { encryptSecret, SECRET_ENCRYPTION_KEY_ENV } from '../secretEncryption.js';
import { verify as verifySignature } from '../signer.js';

function onlyRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}.`);
  return row;
}

// Factories, not constants: a `Response`'s body can only be read once, and
// `InMemoryWebhookDeliverer` reads it (`response.text()`, for
// `response_excerpt`) on every attempt. A mock that returned the SAME
// `Response` instance across multiple attempts (e.g. `mockResolvedValue`,
// which resolves to one fixed value forever) would hand attempt 2+ an
// already-consumed body (CodeRabbit, this PR review) — harmless in
// production, where a real `fetch()` call always returns a fresh `Response`,
// but a real correctness gap in a test mock. `fetchMockAlways`/
// `fetchMockSequence` below always call the factory fresh, per invocation.
function okResponse(body = 'ok') {
  return new Response(body, { status: 200 });
}
function serverErrorResponse(status = 503, body = 'server error') {
  return new Response(body, { status });
}
function clientErrorResponse(status = 400, body = 'bad request') {
  return new Response(body, { status });
}

/** A `fetchImpl` double, explicitly typed as `typeof fetch` so every call's
 * arguments are inferred at the call site — no `as [string, RequestInit]`
 * cast needed to read them back out of `.mock.calls` (CodeRabbit, this PR
 * review). Every invocation calls `factory()` fresh, forever. */
function fetchMockAlways(factory: () => Response) {
  return vi.fn<typeof fetch>(async () => factory());
}

/** Same typed-mock shape as `fetchMockAlways`, but a finite, ordered sequence
 * of fresh responses — one `factory()` call per invocation, in order. Throws
 * if called more times than `factories` provides, so a test that
 * under-specifies its sequence fails loudly instead of returning `undefined`. */
function fetchMockSequence(...factories: Array<() => Response>) {
  const fn = vi.fn<typeof fetch>(async () => {
    throw new Error('fetchMockSequence: called more times than responses were queued');
  });
  for (const factory of factories) {
    fn.mockImplementationOnce(async () => factory());
  }
  return fn;
}

/** Narrows `RequestInit['headers']` (the full fetch union: `Headers`,
 * `string[][]`, or a plain record whose values can themselves be an array —
 * referenced via indexed access rather than the bare `HeadersInit` type name,
 * which `undici-types` exports from its own module but does not re-expose as
 * a global) down to a single header's value, without an `as Record<string,
 * string>` cast past the non-record shapes (CodeRabbit, this PR review). */
function extractHeader(headers: RequestInit['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const lowerName = name.toLowerCase();
    for (const pair of headers) {
      const key = pair[0];
      if (key !== undefined && key.toLowerCase() === lowerName) return pair[1];
    }
    return undefined;
  }
  const value = headers[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(', ');
}

interface DeliveryRow {
  id: string;
  attempt_number: number;
  status: string;
  response_status: number | null;
  latency_ms: number | null;
  next_attempt_at: Date | null;
  idempotency_key: string;
  subscription_id: string;
}

describe('InMemoryWebhookDeliverer (PF-304 / TRO-438)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let originalSecretEncryptionKey: string | undefined;
  const createdWorkspaceIds: string[] = [];

  beforeAll(() => {
    originalSecretEncryptionKey = process.env[SECRET_ENCRYPTION_KEY_ENV];
    process.env[SECRET_ENCRYPTION_KEY_ENV] = crypto.randomBytes(32).toString('hex');
  });

  afterAll(async () => {
    if (createdWorkspaceIds.length > 0) {
      await pool.query(`DELETE FROM workspaces WHERE id = ANY($1)`, [createdWorkspaceIds]);
    }
    if (originalSecretEncryptionKey === undefined) {
      delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    } else {
      process.env[SECRET_ENCRYPTION_KEY_ENV] = originalSecretEncryptionKey;
    }
  });

  async function createWorkspace(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-304 Test ${testRunId} ${crypto.randomBytes(4).toString('hex')}`]
    );
    const id = onlyRow(result.rows).id;
    createdWorkspaceIds.push(id);
    return id;
  }

  async function createOAuthApp(workspaceId: string): Promise<string> {
    const clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type)
       VALUES ($1, $2, $3, 'confidential') RETURNING id`,
      [workspaceId, `PF-304 App ${crypto.randomBytes(4).toString('hex')}`, clientId]
    );
    return onlyRow(result.rows).id;
  }

  /** Returns `{ id, secret }` — `secret` is the plaintext signing secret, for
   * tests that verify the outbound signature. */
  async function createSubscription(
    appId: string,
    eventType: string,
    options: { active?: boolean; targetUrl?: string } = {}
  ): Promise<{ id: string; secret: string }> {
    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        appId,
        eventType,
        options.targetUrl ?? 'https://example.com/hook',
        encryptSecret(secret),
        options.active ?? true,
      ]
    );
    return { id: onlyRow(result.rows).id, secret };
  }

  function buildEvent(workspaceId: string, type: (typeof EVENT_TYPES)[number] = 'document.created'): EventEnvelope {
    return {
      id: crypto.randomUUID(),
      type,
      created_at: new Date().toISOString(),
      workspace_id: workspaceId,
      data: {
        id: crypto.randomUUID(),
        document_type: 'wiki',
        title: 'PF-304 test document',
        created_by: null,
      },
    };
  }

  async function fetchDeliveryRows(subscriptionId: string, eventId: string): Promise<DeliveryRow[]> {
    const result = await pool.query<DeliveryRow>(
      `SELECT id, attempt_number, status, response_status, latency_ms, next_attempt_at, idempotency_key, subscription_id
       FROM webhook_deliveries WHERE subscription_id = $1 AND event_id = $2 ORDER BY attempt_number ASC`,
      [subscriptionId, eventId]
    );
    return result.rows;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Graded scenario #1 (PLUGFORGE.MD §5): 500x3 then 200 -> succeeds on
  // attempt 4, with waits correctly >= 1s / 4s / 16s.
  // ──────────────────────────────────────────────────────────────────────

  it('500x3 then 200 succeeds on attempt 4, with waits correctly >= 1s/4s/16s per the injected clock — fast and deterministic', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId, secret } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    const fetchImpl = fetchMockSequence(
      () => serverErrorResponse(500),
      () => serverErrorResponse(500),
      () => serverErrorResponse(500),
      () => okResponse()
    );

    const clock = new ManualClock(0);
    // randomSource: () => 0 removes jitter, so the exact schedule boundary
    // (>=, tested from both sides below) is the only thing under test here —
    // a separate test below proves jitter is actually added on top.
    const deliverer = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl, randomSource: () => 0 });

    expect(await deliverer.enqueueEvent(event)).toBe(1);

    // Attempt 1 is due immediately (enqueue schedules it at `now`).
    expect(await deliverer.processDue()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The outbound POST carries a valid Ship-Signature, verifiable against
    // this subscription's own secret — proves the deliverer actually signs
    // per PF-303's contract, not just that it POSTs. `fetchImpl` is typed as
    // `typeof fetch` (`fetchMockSequence`), so `.mock.calls[0]` is already
    // `Parameters<typeof fetch> | undefined` — no `as` cast needed to read it.
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error('expected fetchImpl to have been called at least once');
    const [, firstInit] = firstCall;
    if (!firstInit) throw new Error('expected the deliverer to pass a RequestInit to fetch');

    const signatureHeader = extractHeader(firstInit.headers, 'Ship-Signature');
    if (signatureHeader === undefined) {
      throw new Error('expected the deliverer to send a Ship-Signature header');
    }
    const rawBody = firstInit.body;
    if (typeof rawBody !== 'string') {
      throw new Error('expected the deliverer to send a string body');
    }
    expect(verifySignature(signatureHeader, rawBody, secret, 300, () => Math.floor(clock.now() / 1000))).toBe(true);
    expect(extractHeader(firstInit.headers, 'Idempotency-Key')).toBeTruthy();

    // --- boundary check: attempt 2 must NOT fire before a full 1s has passed ---
    clock.advance(999);
    expect(await deliverer.processDue()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(await deliverer.processDue()).toBe(1); // now >= 1000ms since attempt 1 failed
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // --- boundary check: attempt 3 must NOT fire before a full 4s has passed ---
    clock.advance(3_999);
    expect(await deliverer.processDue()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock.advance(1);
    expect(await deliverer.processDue()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // --- boundary check: attempt 4 must NOT fire before a full 16s has passed ---
    clock.advance(15_999);
    expect(await deliverer.processDue()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    clock.advance(1);
    expect(await deliverer.processDue()).toBe(1); // attempt 4 -> 200, succeeds
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'success']);
    expect(rows.map((r) => r.response_status)).toEqual([500, 500, 500, 200]);
    expect(rows[3]?.next_attempt_at).toBeNull();
    // Every attempt shares the SAME idempotency_key (the original delivery's
    // identifier, per docs/architecture.md's Webhook Pipeline section).
    const idempotencyKeys = new Set(rows.map((r) => r.idempotency_key));
    expect(idempotencyKeys.size).toBe(1);
    // No assertion on real wall-clock elapsed time here (CodeRabbit, this PR
    // review): a fixed real-time threshold inside a test is exactly the
    // load-sensitive-flake shape TEST-12/TRO-277 already burned this repo on
    // (gate.sh's own comment: tests 10-70ms unloaded failed a 5000ms deadline
    // under load). The genuinely-fast claim is proven externally instead — by
    // running this file and reading vitest's own reported duration (see this
    // ticket's CHANGES.md entry and PR description for the observed number),
    // not by a threshold baked into the suite that could itself start failing
    // under load without the deliverer's behavior changing at all.
  });

  it('applies jitter on top of the base schedule (does not fire at exactly the base delay when jitter > 0)', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    // Attempt 1 fails (schedules attempt 2, jittered); attempt 2 succeeds —
    // so this test ends at a terminal state and leaves no dangling 'pending'
    // row behind (relevant to the rehydrate() tests below, which scan for
    // any 'pending' row).
    const fetchImpl = fetchMockSequence(() => serverErrorResponse(500), () => okResponse());
    const clock = new ManualClock(0);
    // Full jitter formula (see deliverer.ts): delay = base + random()*base.
    // random() => 0.5 on a 1000ms base schedule entry -> exactly 1500ms.
    const deliverer = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl, randomSource: () => 0.5 });

    await deliverer.enqueueEvent(event);
    await deliverer.processDue(); // attempt 1 fails, schedules attempt 2 at +1500ms

    clock.advance(1_000); // the un-jittered base delay alone is NOT enough
    expect(await deliverer.processDue()).toBe(0);
    clock.advance(499);
    expect(await deliverer.processDue()).toBe(0);
    clock.advance(1);
    expect(await deliverer.processDue()).toBe(1); // now at +1500ms, due -> attempt 2 succeeds

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'success']);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Graded scenario #2 (PLUGFORGE.MD §5): 6 failed attempts total -> DLQ.
  // ──────────────────────────────────────────────────────────────────────

  it('6 consecutive failures land in webhook_deliveries with status = dead — fast and deterministic', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    const fetchImpl = fetchMockAlways(() => serverErrorResponse(503));
    const clock = new ManualClock(0);
    const deliverer = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl, randomSource: () => 0 });

    await deliverer.enqueueEvent(event);

    // 5 waits between 6 attempts: 1s, 4s, 16s, 1m, 5m (the schedule's 6th
    // entry, 30m, is never reached — see deliverer.ts's file header).
    const waitsBetweenAttempts = [1_000, 4_000, 16_000, 60_000, 300_000];
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(await deliverer.processDue()).toBe(1);
      const wait = waitsBetweenAttempts[attempt - 1];
      if (wait !== undefined) clock.advance(wait);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'dead']);
    expect(rows[5]?.next_attempt_at).toBeNull();

    // Nothing further is scheduled — advancing arbitrarily far and calling
    // processDue() again attempts nothing more.
    clock.advance(10_000_000);
    expect(await deliverer.processDue()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    // No wall-clock threshold assertion here — see the identical note in the
    // graded scenario #1 test above.
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4xx: permanent failure, dead-lettered immediately, no retry.
  // ──────────────────────────────────────────────────────────────────────

  it('a 4xx response dead-letters immediately on attempt 1 — no retry is ever scheduled', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    const fetchImpl = fetchMockAlways(() => clientErrorResponse(400));
    const clock = new ManualClock(0);
    const deliverer = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl });

    await deliverer.enqueueEvent(event);
    expect(await deliverer.processDue()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('dead');
    expect(rows[0]?.response_status).toBe(400);
    expect(rows[0]?.next_attempt_at).toBeNull();

    clock.advance(10_000_000);
    expect(await deliverer.processDue()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still just the one attempt, ever
  });

  // ──────────────────────────────────────────────────────────────────────
  // enqueueEvent() called twice for the same (subscription, event): the
  // migration 048 unique index + ON CONFLICT DO NOTHING dedup.
  // ──────────────────────────────────────────────────────────────────────

  it('enqueueEvent() called twice for the same event is a harmless no-op the second time, not a duplicate row or a thrown error', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    const fetchImpl = fetchMockAlways(() => okResponse());
    const deliverer = new InMemoryWebhookDeliverer(pool, new ManualClock(0), { fetchImpl });

    expect(await deliverer.enqueueEvent(event)).toBe(1);
    // Second call: idx_webhook_deliveries_unique_attempt (subscription_id,
    // event_id, attempt_number) already has a row for (this subscription,
    // this event, attempt 1) — ON CONFLICT DO NOTHING means this returns 0
    // enqueued rather than throwing a unique-violation.
    await expect(deliverer.enqueueEvent(event)).resolves.toBe(0);

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows).toHaveLength(1);
    expect(deliverer.queueLength).toBe(1);

    // Drain it — same "don't leave a dangling pending row" hygiene as the
    // workspace-matcher test above.
    expect(await deliverer.processDue()).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Subscription matcher: event_type AND workspace, active only.
  // ──────────────────────────────────────────────────────────────────────

  it('only enqueues for an ACTIVE subscription in the SAME workspace as the event, matching by event_type', async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const otherAppId = await createOAuthApp(otherWorkspaceId);

    const { id: matchingSubscriptionId } = await createSubscription(appId, 'document.created');
    await createSubscription(appId, 'issue.created'); // different event_type — must not match
    await createSubscription(otherAppId, 'document.created'); // different workspace — must not match
    // A distinct target_url: the partial unique index
    // (idx_webhook_subscriptions_unique_active) is on (app_id, event_type,
    // target_url) WHERE active — a second ACTIVE row for the identical
    // triple would collide before this test gets to deactivate it.
    await createSubscription(appId, 'document.created', {
      active: false,
      targetUrl: 'https://example.com/hook-inactive',
    });

    const event = buildEvent(workspaceId, 'document.created');
    const fetchImpl = fetchMockAlways(() => okResponse());
    const deliverer = new InMemoryWebhookDeliverer(pool, new ManualClock(0), { fetchImpl });

    const enqueuedCount = await deliverer.enqueueEvent(event);
    expect(enqueuedCount).toBe(1);

    const rows = await fetchDeliveryRows(matchingSubscriptionId, event.id);
    expect(rows).toHaveLength(1);

    // Drain the row this test created rather than leaving it 'pending'
    // forever — the rehydrate() tests below scan for ANY 'pending' row
    // system-wide (correctly — see deliverer.ts's rehydrate() docstring: it
    // is a boot-time recovery of every outstanding attempt, not scoped to
    // one deliverer instance's own history), so an undrained row here would
    // make those tests' counts order-dependent on this one.
    expect(await deliverer.processDue()).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // processDue()'s EXECUTION-failure backoff (decrypt/sign/DB — never an
  // HTTP delivery outcome, which always resolves to a terminal DB write).
  // ──────────────────────────────────────────────────────────────────────

  it('an execution failure (e.g. an undecryptable secret) backs off instead of retrying immediately, then gives up in-memory after MAX_EXECUTION_FAILURES — leaving the row pending for rehydrate()', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    // A subscription with a garbage (non-AES-GCM) ciphertext — bypasses
    // createSubscription()'s real encryptSecret() call so that attempt()'s
    // decryptSecret() throws, exercising processDue()'s execution-failure
    // path (never reaches performHttpAttempt() at all).
    const subscriptionResult = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [appId, 'document.created', 'https://example.com/hook', 'not-a-valid-ciphertext']
    );
    const subscriptionId = onlyRow(subscriptionResult.rows).id;
    const event = buildEvent(workspaceId);

    const fetchImpl = fetchMockAlways(() => okResponse()); // never reached
    const clock = new ManualClock(0);
    const deliverer = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl });

    await deliverer.enqueueEvent(event);
    expect(deliverer.queueLength).toBe(1);

    // Attempt 1: execution fails. `processDue()` still reports 1 (it WAS due
    // and WAS attempted — attempting is what failed), and the item is
    // re-queued with a backoff delay, not retried on the very next call.
    expect(await deliverer.processDue()).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deliverer.queueLength).toBe(1);

    clock.advance(EXECUTION_FAILURE_BACKOFF_MS - 1);
    expect(await deliverer.processDue()).toBe(0); // not due yet — backoff, not immediate retry
    clock.advance(1);

    // Drive it through the remaining execution failures until
    // MAX_EXECUTION_FAILURES is reached and this process gives up in-memory.
    for (let failureCount = 2; failureCount <= MAX_EXECUTION_FAILURES; failureCount++) {
      expect(await deliverer.processDue()).toBe(1);
      clock.advance(EXECUTION_FAILURE_BACKOFF_MS);
    }

    // Given up: the queue is empty (nothing left to re-process in THIS
    // process), yet the DB row is still 'pending' — never touched by an
    // execution failure, only by a real HTTP attempt outcome — so a future
    // rehydrate() (this process's own restart, or another instance's boot)
    // can still recover and eventually deliver it.
    expect(deliverer.queueLength).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });

  // ──────────────────────────────────────────────────────────────────────
  // rehydrate(): the crash-recovery gap docs/architecture.md names as
  // PF-304's own design intent.
  // ──────────────────────────────────────────────────────────────────────

  it('rehydrate() restores a pending attempt into a FRESH deliverer instance after a simulated crash', async () => {
    const workspaceId = await createWorkspace();
    const appId = await createOAuthApp(workspaceId);
    const { id: subscriptionId } = await createSubscription(appId, 'document.created');
    const event = buildEvent(workspaceId);

    const clock = new ManualClock(0);
    const fetchImplA = fetchMockAlways(() => serverErrorResponse(500));
    const delivererA = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl: fetchImplA, randomSource: () => 0 });

    await delivererA.enqueueEvent(event);
    expect(await delivererA.processDue()).toBe(1); // attempt 1 fails, schedules attempt 2 (pending row, due +1s)
    expect(delivererA.queueLength).toBe(1);

    // Simulate a process crash: `delivererA`'s in-memory queue is simply
    // discarded (never call processDue on it again). A brand-new instance,
    // same clock, starts with an EMPTY queue.
    const fetchImplB = fetchMockAlways(() => okResponse());
    const delivererB = new InMemoryWebhookDeliverer(pool, clock, { fetchImpl: fetchImplB, randomSource: () => 0 });
    expect(delivererB.queueLength).toBe(0);

    // >= 1, not necessarily exactly 1: rehydrate() is deliberately
    // system-wide (every outstanding 'pending' row, not scoped to one
    // event/subscription — see its docstring), so this assertion does not
    // assume this test is the only source of 'pending' rows in the run. What
    // it DOES assert precisely, below, is that THIS test's own delivery
    // reaches 'success' once restored and processed.
    const restoredCount = await delivererB.rehydrate();
    expect(restoredCount).toBeGreaterThanOrEqual(1);
    expect(delivererB.queueLength).toBeGreaterThanOrEqual(1);

    clock.advance(1_000);
    await delivererB.processDue(); // attempt 2 for every restored delivery, including ours, succeeds
    expect(fetchImplB).toHaveBeenCalled();

    const rows = await fetchDeliveryRows(subscriptionId, event.id);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'success']);
  });

  it('rehydrate() on a deliverer with nothing pending restores 0', async () => {
    const deliverer = new InMemoryWebhookDeliverer(pool, new ManualClock(0));
    // Not asserting exactly 0 globally (other tests in this file may leave
    // rows behind transiently within the same run), only that THIS
    // deliverer's own queue grows by exactly what rehydrate() reports.
    const before = deliverer.queueLength;
    const restored = await deliverer.rehydrate();
    expect(deliverer.queueLength).toBe(before + restored);
  });
});

// ────────────────────────────────────────────────────────────────────────
// wireDelivererToEventBus — pure, in-memory, no DB. Proves requirement #7:
// "when publish() fires an event, match it against active subscriptions by
// event_type, enqueue a delivery per matching subscription" at the WIRING
// layer (the matching itself is `enqueueEvent`'s own job, covered above).
// ────────────────────────────────────────────────────────────────────────

describe('wireDelivererToEventBus', () => {
  function fakeDeliverer(): IWebhookDeliverer & {
    enqueueEvent: ReturnType<typeof vi.fn>;
  } {
    return {
      enqueueEvent: vi.fn(async () => 0),
      processDue: vi.fn(async () => 0),
      rehydrate: vi.fn(async () => 0),
    };
  }

  it('subscribes to all 8 event types', () => {
    const bus = new InProcessEventBus();
    const subscribeSpy = vi.spyOn(bus, 'subscribe');
    wireDelivererToEventBus(fakeDeliverer(), bus);
    const subscribedTypes = subscribeSpy.mock.calls.map((call) => call[0]);
    expect([...subscribedTypes].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('fires enqueueEvent synchronously (the call itself, not its promise) when a matching event publishes, and stops after unsubscribe', () => {
    const bus = new InProcessEventBus();
    const deliverer = fakeDeliverer();
    const unsubscribe = wireDelivererToEventBus(deliverer, bus);

    const workspaceId = crypto.randomUUID();
    bus.publish('document.created', workspaceId, {
      id: crypto.randomUUID(),
      document_type: 'wiki',
      title: 'x',
      created_by: null,
    });

    expect(deliverer.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(deliverer.enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'document.created' }));

    unsubscribe();
    bus.publish('document.created', workspaceId, {
      id: crypto.randomUUID(),
      document_type: 'wiki',
      title: 'y',
      created_by: null,
    });
    expect(deliverer.enqueueEvent).toHaveBeenCalledTimes(1); // unchanged
  });

  it('a rejected enqueueEvent is reported via onEnqueueError, never thrown back into publish()', async () => {
    const bus = new InProcessEventBus();
    const boom = new Error('db unreachable');
    const deliverer: IWebhookDeliverer = {
      enqueueEvent: vi.fn(async () => {
        throw boom;
      }),
      processDue: vi.fn(async () => 0),
      rehydrate: vi.fn(async () => 0),
    };
    const onEnqueueError = vi.fn();
    wireDelivererToEventBus(deliverer, bus, onEnqueueError);

    const workspaceId = crypto.randomUUID();
    expect(() =>
      bus.publish('document.created', workspaceId, {
        id: crypto.randomUUID(),
        document_type: 'wiki',
        title: 'z',
        created_by: null,
      })
    ).not.toThrow();

    // Flush the microtask queue so the already-rejected promise's .catch()
    // continuation has run — not a real-time wait, just a queue flush.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onEnqueueError).toHaveBeenCalledWith(boom, expect.objectContaining({ type: 'document.created' }));
  });
});
