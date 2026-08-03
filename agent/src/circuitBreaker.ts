/**
 * A generic circuit breaker — TRO-315 (FG-4).
 *
 * Deliberately the same state machine as `api/src/utils/circuitBreaker.ts`
 * (TRO-311 / RULE-7), copied rather than reinvented: that file's own history
 * is the reason to copy it exactly. Its first version had a genuine
 * half-open concurrency race — a second concurrent call arriving while a
 * trial call's `await fn()` was still in flight fell through the
 * `state === 'open'` check (state was already 'half-open' by then) and
 * called `fn()` itself, breaking the "exactly one trial call" invariant
 * under real concurrent load. Fixed in `273f058` with an explicit
 * `else if (state === 'half-open') throw new CircuitOpenError()` guard. This
 * file starts from the FIXED version, not the original, and the
 * corresponding regression test (`__tests__/circuitBreaker.test.ts`,
 * "allows only ONE trial call through when several requests arrive
 * concurrently right as the cooldown elapses") is carried over unchanged —
 * TRO-315's own ticket names this exact race as its proof #3.
 *
 * `agent/` does not depend on `api/` (separate workspace package, no shared
 * lib boundary between them), so this is a duplication of a verified-correct
 * ~100-line class rather than a new cross-package dependency.
 *
 * Three states, the standard shape:
 *   - CLOSED: calls go through normally. A run of consecutive failures
 *     reaching `failureThreshold` trips the breaker OPEN.
 *   - OPEN: calls fail immediately with `CircuitOpenError`, without ever
 *     invoking the wrapped function. Once `cooldownMs` has elapsed since
 *     opening, the next call is treated as a HALF_OPEN trial instead of
 *     being short-circuited.
 *   - HALF_OPEN: exactly one trial call is allowed through. Success closes
 *     the breaker and resets the failure count; failure reopens it and
 *     restarts the cooldown from now.
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
  /** Clock source, injectable for deterministic tests. Defaults to `Date.now`. */
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
      // A trial call is already in flight — see the file header for why this
      // branch exists and the exact bug it closes (TRO-311's own review).
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
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
