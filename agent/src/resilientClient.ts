/**
 * A single outbound client layer used by every call the agent makes — Ship
 * API and the model provider both (TRO-315 / FG-4).
 *
 * Scope, per the ticket:
 *   - Explicit connect/read timeout — no unbounded awaits anywhere.
 *   - Retry with exponential backoff and jitter, on idempotent GET reads only.
 *   - Circuit breaker with a half-open probe (`circuitBreaker.ts`, the
 *     TRO-311-fixed pattern).
 *   - Self-throttling below Ship's per-IP ceiling (`rateLimiter.ts`), because
 *     both of Ship's own limiters fail open.
 *   - Degradation contract: Ship unreachable -> the caller gets
 *     `ShipUnreachableError` with a plain, user-safe message, never a raw
 *     stack trace or an unbounded hang.
 *
 * Design note on WHERE the breaker sits: it wraps each individual HTTP
 * attempt, not the whole retry sequence. That is what makes proof #1 in the
 * ticket ("Ship returning 503 -> retries with growing delays, then opens the
 * breaker") a single coherent sequence rather than two disconnected
 * behaviors — the Nth attempt inside one `get()` call's retry loop is the
 * same call that trips the breaker, and once it does, `CircuitOpenError`
 * propagates straight out of the retry loop (no more backoff waiting on a
 * breaker that has already given up).
 */

import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
import type { RateLimiter } from './rateLimiter.js';
import { SelfThrottleExceededError } from './rateLimiter.js';

export { CircuitOpenError, SelfThrottleExceededError };

/** Thrown when a response's HTTP status makes it a failure for retry/breaker purposes (5xx). */
export class ShipHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Ship responded ${status}`);
    this.name = 'ShipHttpError';
  }
}

/** A bounded wait exceeded — connect/read never resolved in time. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * The plain, user-safe message the degradation contract requires: an
 * in-flight on-demand request should surface this, never a stack trace.
 */
export class ShipUnreachableError extends Error {
  constructor(public readonly cause: unknown) {
    super("I can't reach Ship right now.");
    this.name = 'ShipUnreachableError';
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. 1 means "no retry". */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Full jitter (random 0..delay) when true; fixed exponential delay when false. Default true. */
  jitter?: boolean;
}

export interface ResilientClientOptions {
  breaker: CircuitBreaker;
  rateLimiter?: RateLimiter;
  timeoutMs: number;
  retry: RetryOptions;
  fetchImpl?: typeof fetch;
  /** Injectable timer, for deterministic tests — never a real wait (lessons.md #17). */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** Injectable backoff sleep, for deterministic tests. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source (0..1). Defaults to Math.random. */
  random?: () => number;
}

export class ResilientClient {
  private readonly breaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;
  private readonly fetchImpl: typeof fetch;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ResilientClientOptions) {
    this.breaker = options.breaker;
    this.rateLimiter = options.rateLimiter;
    this.timeoutMs = options.timeoutMs;
    this.retry = {
      maxAttempts: options.retry.maxAttempts,
      baseDelayMs: options.retry.baseDelayMs,
      maxDelayMs: options.retry.maxDelayMs ?? options.retry.baseDelayMs * 16,
      jitter: options.retry.jitter ?? true,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => this.setTimeoutImpl(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  getBreakerState() {
    return this.breaker.getState();
  }

  /**
   * Idempotent read, eligible for retry with backoff. Every failure mode
   * (5xx, timeout, network error, breaker open) is normalized: retries are
   * attempted up to `retry.maxAttempts`, and if every attempt is exhausted —
   * or the breaker is open — the caller gets `ShipUnreachableError`, never a
   * raw error type or an unbounded hang.
   */
  async get(url: string, init: RequestInit = {}): Promise<Response> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      if (this.rateLimiter && !this.rateLimiter.tryAcquire()) {
        throw new ShipUnreachableError(new SelfThrottleExceededError());
      }

      try {
        return await this.breaker.execute(() => this.checkedFetch(url, { ...init, method: 'GET' }));
      } catch (err) {
        lastErr = err;
        if (err instanceof CircuitOpenError) {
          // The breaker just told us to stop. Further backoff-and-retry
          // against a breaker that is already open only adds latency for no
          // chance of success — fail fast instead.
          break;
        }
        if (attempt >= this.retry.maxAttempts) {
          break;
        }
        await this.backoffDelay(attempt);
      }
    }

    throw new ShipUnreachableError(lastErr);
  }

  /** Non-idempotent request: timeout + breaker, no retry. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.breaker.execute(() => this.checkedFetch(url, init));
    } catch (err) {
      throw new ShipUnreachableError(err);
    }
  }

  private async checkedFetch(url: string, init: RequestInit): Promise<Response> {
    const response = await this.timedFetch(url, init);
    if (!response.ok && response.status >= 500) {
      throw new ShipHttpError(response.status);
    }
    return response;
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    // Forward an externally-supplied signal too — the caller can still
    // cancel independently of our own bound.
    if (init.signal) {
      init.signal.addEventListener('abort', () => controller.abort());
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.setTimeoutImpl(() => {
        controller.abort();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) this.clearTimeoutImpl(timer);
    }
  }

  private async backoffDelay(attempt: number): Promise<void> {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const delay = this.retry.jitter ? this.random() * exp : exp;
    await this.sleep(delay);
  }
}
