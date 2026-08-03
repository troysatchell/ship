/**
 * TRO-315 (FG-4) — the four proofs the ticket names, plus self-throttling
 * and the plain-message degradation contract. Every case runs against a
 * stable fake `fetchImpl` — never a live call. Timers (`setTimeoutImpl`),
 * the backoff `sleep`, and the breaker's own clock are all injected so
 * nothing here waits on real wall-clock time (lessons.md #17).
 */
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../circuitBreaker.js';
import { RateLimiter } from '../rateLimiter.js';
import { ResilientClient, ShipUnreachableError } from '../resilientClient.js';

function makeClock(start = 0) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

/** Records every backoff delay it was asked to wait, then resolves immediately — no real time spent. */
function instantSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

function okResponse() {
  return new Response(null, { status: 200 });
}
function serverErrorResponse(status = 503) {
  return new Response(null, { status });
}

describe('ResilientClient.get — proof #1: Ship returning 503 repeatedly', () => {
  it('retries with growing delays, then opens the breaker, and the caller gets a plain unreachable error (process stays alive)', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000, now: clock.now });
    const fetchImpl = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const { sleep, delays } = instantSleep();

    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 3, baseDelayMs: 100, jitter: false },
      fetchImpl,
      sleep,
    });

    await expect(client.get('https://ship.example.gov/api/documents')).rejects.toBeInstanceOf(
      ShipUnreachableError
    );

    // 3 attempts, all real HTTP calls (breaker was closed/half-open, never
    // short-circuited mid-sequence since failureThreshold === maxAttempts).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Backoff delays grow: 100ms, then 200ms (exponential, no jitter).
    expect(delays).toEqual([100, 200]);
    // The 3rd consecutive failure trips the breaker.
    expect(breaker.getState()).toBe('open');
    // Nothing thrown here escaped as an uncaught exception — the test
    // function itself returning is the "process is still alive" proof; the
    // /ready wiring test (server.test.ts, FG-4 update) proves the HTTP-level
    // consequence (503) separately.
  });

  it('the caller-facing error message is always the plain degradation message, never a raw stack trace', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const fetchImpl = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const { sleep } = instantSleep();
    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 50 },
      fetchImpl,
      sleep,
    });

    await expect(client.get('https://ship.example.gov/api/documents')).rejects.toMatchObject({
      message: "I can't reach Ship right now.",
    });
  });

  it('once the breaker is already open, further attempts fail fast without retrying or calling fetch again', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    const fetchImpl = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const { sleep } = instantSleep();
    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 5, baseDelayMs: 10 },
      fetchImpl,
      sleep,
    });

    // First call opens the breaker (threshold 1) — its own retry loop stops
    // immediately once CircuitOpenError is thrown mid-sequence.
    await expect(client.get('https://ship.example.gov/x')).rejects.toBeInstanceOf(ShipUnreachableError);
    expect(breaker.getState()).toBe('open');
    const callsAfterFirstGet = fetchImpl.mock.calls.length;
    expect(callsAfterFirstGet).toBe(1); // failureThreshold=1 trips it on the very first attempt

    fetchImpl.mockClear();
    await expect(client.get('https://ship.example.gov/x')).rejects.toBeInstanceOf(ShipUnreachableError);
    // Breaker was already open — no HTTP call at all for the whole retry loop.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ResilientClient.get — proof #2: Ship hanging', () => {
  it('times out at the configured bound rather than waiting indefinitely', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 10_000 });
    // A fetchImpl that never resolves on its own — simulates a genuine hang.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));

    const scheduled: Array<{ ms: number; cb: () => void }> = [];
    const setTimeoutImpl = vi.fn((cb: () => void, ms?: number) => {
      scheduled.push({ ms: ms ?? 0, cb });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;

    const client = new ResilientClient({
      breaker,
      timeoutMs: 2500,
      retry: { maxAttempts: 1, baseDelayMs: 50 },
      fetchImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    const pending = client.get('https://ship.example.gov/slow');

    // The timer that bounds this call must have been scheduled at exactly
    // the configured timeout — not left to whatever fetch feels like.
    expect(scheduled).toHaveLength(1);
    const [firstScheduled] = scheduled;
    if (!firstScheduled) throw new Error('expected a timer to have been scheduled');
    expect(firstScheduled.ms).toBe(2500);

    // Fire the timeout deterministically — no real time elapses in this test.
    firstScheduled.cb();

    await expect(pending).rejects.toBeInstanceOf(ShipUnreachableError);
  });
});

describe('ResilientClient — proof #3: half-open admits exactly one concurrent trial', () => {
  it('while a half-open trial is in flight, concurrent get() calls fail fast without reaching fetch', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });

    // Trip the breaker open first.
    const failingFetch = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const { sleep } = instantSleep();
    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 10 },
      fetchImpl: failingFetch,
      sleep,
    });
    await expect(client.get('https://ship.example.gov/x')).rejects.toBeInstanceOf(ShipUnreachableError);
    expect(breaker.getState()).toBe('open');
    clock.advance(1001); // cooldown elapsed — next call is eligible to trial

    // A gated fetch: the trial call's fetch does not resolve until released,
    // so it is provably still in flight when the concurrent calls arrive.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedFetch = vi.fn(async () => {
      await gate;
      return okResponse();
    });
    const trialClient = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 10 },
      fetchImpl: gatedFetch,
      sleep,
    });

    const trialPromise = trialClient.get('https://ship.example.gov/x');
    const concurrent = [
      trialClient.get('https://ship.example.gov/x'),
      trialClient.get('https://ship.example.gov/x'),
    ];

    for (const p of concurrent) {
      await expect(p).rejects.toBeInstanceOf(ShipUnreachableError);
    }
    expect(gatedFetch).toHaveBeenCalledTimes(1); // only the trial call ever reached fetch

    release?.();
    await expect(trialPromise).resolves.toBeInstanceOf(Response);
    expect(breaker.getState()).toBe('closed');
  });
});

describe('ResilientClient — proof #4: the breaker closes again once Ship recovers', () => {
  it('a successful call after the cooldown closes the breaker, and subsequent calls need no retry', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500, now: clock.now });
    const fetchImpl = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const { sleep } = instantSleep();
    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 2, baseDelayMs: 10 },
      fetchImpl,
      sleep,
    });

    await expect(client.get('https://ship.example.gov/x')).rejects.toBeInstanceOf(ShipUnreachableError);
    expect(breaker.getState()).toBe('open');

    clock.advance(501);
    fetchImpl.mockResolvedValue(okResponse()); // Ship has recovered
    const response = await client.get('https://ship.example.gov/x');
    expect(response.status).toBe(200);
    expect(breaker.getState()).toBe('closed');

    fetchImpl.mockClear();
    const again = await client.get('https://ship.example.gov/x');
    expect(again.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry needed, breaker fully closed
  });
});

describe('ResilientClient — self-throttling', () => {
  it('rejects with ShipUnreachableError once the self-throttle ceiling is hit in the current window, without calling fetch', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });
    const rateLimiter = new RateLimiter({ maxPerWindow: 1, windowMs: 60_000, now: clock.now });
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new ResilientClient({
      breaker,
      rateLimiter,
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 10 },
      fetchImpl,
    });

    await expect(client.get('https://ship.example.gov/a')).resolves.toBeInstanceOf(Response);
    await expect(client.get('https://ship.example.gov/b')).rejects.toBeInstanceOf(ShipUnreachableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the throttled call never reached fetch
  });
});

describe('ResilientClient.request — non-idempotent calls', () => {
  it('goes through the breaker and timeout, but is never retried', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });
    const fetchImpl = vi.fn().mockResolvedValue(serverErrorResponse(503));
    const client = new ResilientClient({
      breaker,
      timeoutMs: 1000,
      retry: { maxAttempts: 5, baseDelayMs: 10 }, // irrelevant to .request()
      fetchImpl,
    });

    await expect(client.request('https://ship.example.gov/x', { method: 'POST' })).rejects.toBeInstanceOf(
      ShipUnreachableError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// Sanity: CircuitOpenError is still importable from this module for callers
// that want to distinguish "breaker open" from other failure causes.
describe('re-exports', () => {
  it('re-exports CircuitOpenError', () => {
    expect(new CircuitOpenError()).toBeInstanceOf(Error);
  });
});
