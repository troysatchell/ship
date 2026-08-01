/**
 * A generic circuit breaker — TRO-311 (RULE-7 follow-up).
 *
 * TRO-248 (RULE-7) already assessed the codebase for circuit-breaker gaps and
 * found the strongest candidate — the collaboration WebSocket — already
 * protected by `y-websocket`'s exponential-backoff reconnect plus
 * `Editor.tsx`'s permanent-failure `shouldConnect = false` gating (ERR-1/
 * ERR-2). Building a second breaker there would duplicate that protection.
 * This file targets a different outbound dependency instead: the Redis-backed
 * rate-limit store (`redis-rate-limit-store.ts`), which had retry/timeout
 * protection (TRO-280) but no breaker.
 *
 * WHY A BREAKER ON TOP OF THE EXISTING RETRY/TIMEOUT PROTECTION: those bound
 * the cost of any ONE failed request. They do nothing to stop every
 * subsequent request from paying that same bounded cost again during a
 * sustained outage — 1,000 requests against a Redis that has been down for
 * five minutes still make 1,000 doomed connection attempts. A circuit breaker
 * adds memory: after enough consecutive failures, stop trying entirely for a
 * cooldown window (near-zero cost per request), then send one trial request
 * to check for recovery before resuming normal traffic.
 *
 * Three states, the standard shape:
 *   - CLOSED: calls go through normally. A run of consecutive failures
 *     reaching `failureThreshold` trips the breaker OPEN.
 *   - OPEN: calls fail immediately with `CircuitOpenError`, without ever
 *     invoking the wrapped function — the entire point of this class. Once
 *     `cooldownMs` has elapsed since opening, the next call is treated as a
 *     HALF_OPEN trial instead of being short-circuited.
 *   - HALF_OPEN: exactly one trial call is allowed through. Success closes
 *     the breaker and resets the failure count; failure reopens it and
 *     restarts the cooldown from now.
 *
 * This class has no knowledge of Redis, HTTP, or any other transport — it
 * wraps an arbitrary `() => Promise<T>`, so it is reusable for any outbound
 * call with the same "bounded-cost-per-call already handled, but repeated
 * failures should stop trying" shape.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Thrown by `execute()` when the breaker is OPEN and the cooldown has not yet elapsed. The wrapped function is never called in this case. */
export class CircuitOpenError extends Error {
  constructor(message = 'circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures (from CLOSED) required to trip the breaker OPEN. */
  failureThreshold: number;
  /** Milliseconds to wait after opening before allowing a HALF_OPEN trial call. */
  cooldownMs: number;
  /**
   * Clock source, injectable for deterministic tests with `vi.useFakeTimers()`
   * — never a real sleep (lessons.md #17). Defaults to `Date.now`.
   */
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    if (options.failureThreshold < 1) {
      throw new Error('failureThreshold must be at least 1');
    }
    if (options.cooldownMs < 0) {
      throw new Error('cooldownMs must not be negative');
    }
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Run `fn` through the breaker. Throws `CircuitOpenError` (without calling
   * `fn`) if the breaker is OPEN and the cooldown has not elapsed. Otherwise
   * calls `fn`, records the outcome, and rethrows/returns as `fn` did.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) {
        throw new CircuitOpenError();
      }
      this.state = 'half-open';
    } else if (this.state === 'half-open') {
      // A trial call is already in flight (its own `await fn()` below hasn't
      // settled yet, so the state is still 'half-open'). Without this branch,
      // any concurrent call arriving during that window falls through this
      // whole `if`/`else if` untouched and calls `fn()` directly — exactly
      // one trial call at a time is the documented invariant this exists to
      // hold. The check-then-mutate above is safe from the same race because
      // it is synchronous (no `await` between reading `this.state` and
      // writing it), so two calls invoked back-to-back (e.g. via
      // `Promise.all`) cannot both observe 'open' before either mutates —
      // JS evaluates and starts each call in order, and a function body runs
      // synchronously up to its first `await`.
      throw new CircuitOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    // A HALF_OPEN trial failing reopens immediately — it does not get the
    // full `failureThreshold` count again, since a single failed trial is
    // already the answer to "has the dependency recovered?".
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
