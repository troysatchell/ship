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

/**
 * Thrown when a response's HTTP status makes it a failure for retry/breaker
 * purposes (5xx, or 429 rate-limited). `retryAfterMs`, when the response
 * carried a `Retry-After` header, is the server-directed wait — honored in
 * place of computed exponential backoff when present (see `get()`).
 */
export class ShipHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number
  ) {
    super(`Ship responded ${status}`);
    this.name = 'ShipHttpError';
  }
}

/** Parses a `Retry-After` header value (delta-seconds or an HTTP-date) into milliseconds. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
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
  constructor(cause: unknown) {
    // Native `Error.cause` (via the options bag), not a parameter-property —
    // a parameter-property would additionally make `cause` an enumerable own
    // property of every instance, which the native mechanism does not.
    super("I can't reach Ship right now.", { cause });
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

/**
 * Handle returned by `setTimeoutImpl`, as accepted by `clearTimeoutImpl`. This
 * client only ever stores the handle and passes it back to `clearTimeoutImpl`
 * — it never inspects it — so the type only needs to cover what a real timer
 * returns (`NodeJS.Timeout`) and what a deterministic test fake naturally
 * returns instead (a plain counter/index), not the full ambient
 * `typeof setTimeout` overload set.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;
/** The narrow shape this client actually calls: a zero-arg callback and a delay in ms. */
export type SetTimeoutImpl = (callback: () => void, ms: number) => TimerHandle;
export type ClearTimeoutImpl = (handle: TimerHandle) => void;

export interface ResilientClientOptions {
  breaker: CircuitBreaker;
  rateLimiter?: RateLimiter;
  timeoutMs: number;
  retry: RetryOptions;
  fetchImpl?: typeof fetch;
  /** Injectable timer, for deterministic tests — never a real wait (lessons.md #17). */
  setTimeoutImpl?: SetTimeoutImpl;
  clearTimeoutImpl?: ClearTimeoutImpl;
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
  private readonly setTimeoutImpl: SetTimeoutImpl;
  private readonly clearTimeoutImpl: ClearTimeoutImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ResilientClientOptions) {
    if (options.retry.maxAttempts < 1) {
      throw new Error('retry.maxAttempts must be at least 1');
    }
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
        if (err instanceof ShipHttpError && err.retryAfterMs !== undefined) {
          // Server-directed wait (429/5xx with Retry-After) takes precedence
          // over our own computed exponential backoff.
          await this.sleep(err.retryAfterMs);
        } else {
          await this.backoffDelay(attempt);
        }
      }
    }

    throw new ShipUnreachableError(lastErr);
  }

  /** Non-idempotent request: timeout + breaker, no retry. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.rateLimiter && !this.rateLimiter.tryAcquire()) {
      throw new ShipUnreachableError(new SelfThrottleExceededError());
    }

    try {
      return await this.breaker.execute(() => this.checkedFetch(url, init));
    } catch (err) {
      throw new ShipUnreachableError(err);
    }
  }

  private async checkedFetch(url: string, init: RequestInit): Promise<Response> {
    const response = await this.timedFetch(url, init);
    // >=500 is a server failure; 429 is Ship telling us to back off — both
    // are failures for retry/breaker purposes. `response.status >= 500`
    // already implies `!response.ok`, so no separate `.ok` check is needed.
    if (response.status >= 500 || response.status === 429) {
      throw new ShipHttpError(response.status, parseRetryAfterMs(response.headers.get('Retry-After')));
    }
    return response;
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    // Forward an externally-supplied signal too — the caller can still
    // cancel independently of our own bound. If it's already aborted before
    // we even start, don't bother starting the fetch at all.
    if (init.signal) {
      if (init.signal.aborted) {
        controller.abort();
      } else {
        init.signal.addEventListener('abort', onAbort);
      }
    }

    let timer: TimerHandle | undefined;
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
      // Always remove the listener we may have added above — otherwise it
      // leaks onto the caller's signal for the lifetime of that signal,
      // which can outlive this single call by a lot (e.g. a request-scoped
      // AbortSignal reused across several outbound calls).
      if (init.signal) init.signal.removeEventListener('abort', onAbort);
    }
  }

  private async backoffDelay(attempt: number): Promise<void> {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const delay = this.retry.jitter ? this.random() * exp : exp;
    await this.sleep(delay);
  }
}
