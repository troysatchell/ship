/**
 * `TokenBucket` — the token-bucket rate-limiting primitive behind PF-500's
 * per-app / per-token buckets (PLUGFORGE.MD §2.7, Linear TRO-427).
 *
 * A classic continuous-refill token bucket, keyed by an arbitrary string (an
 * app's `client_id`, or a hash of the raw bearer credential). Each bucket
 * starts full (`capacity` tokens) and refills LINEARLY over `windowMs` — not
 * a fixed window that resets all-at-once at a clock boundary, so a caller
 * that spends its whole budget gets tokens back gradually rather than in one
 * lump at the top of the next minute.
 *
 * `clock` is injected — same discipline PF-304 (tonight's webhook-deliverer
 * ticket) applied to its retry scheduling — so exhaustion/refill is
 * unit-testable by advancing a fake clock rather than waiting on real
 * `setTimeout`s. See `__tests__/tokenBucket.test.ts`.
 */

export interface Clock {
  now(): number;
}

/** The real clock — used everywhere except tests. */
export const systemClock: Clock = { now: () => Date.now() };

export interface BucketState {
  /** Whether this check found enough tokens for the requested cost. */
  allowed: boolean;
  /** The bucket's configured capacity — echoed back for header convenience. */
  limit: number;
  /** Tokens left after this check, floored (a fractional token isn't usable,
   *  so it's never advertised as "remaining"). */
  remaining: number;
  /** Milliseconds from now until the bucket is back to full capacity. 0 if
   *  already full. */
  resetAfterMs: number;
  /** Milliseconds from now until at least the requested cost is available
   *  again. 0 if it is already available (`allowed: true`). */
  retryAfterMs: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly clock: Clock = systemClock
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`TokenBucket: capacity must be a positive number, got ${capacity}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`TokenBucket: windowMs must be a positive number, got ${windowMs}`);
    }
  }

  /** Applies linear refill up to `now`, creating the bucket at full capacity
   *  the first time a key is seen. Never itself spends a token. */
  private refillAt(key: string, now: number): { tokens: number; lastRefillMs: number } {
    let state = this.buckets.get(key);
    if (!state) {
      state = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, state);
      return state;
    }
    const elapsedMs = now - state.lastRefillMs;
    if (elapsedMs > 0) {
      const refillRatePerMs = this.capacity / this.windowMs;
      state.tokens = Math.min(this.capacity, state.tokens + elapsedMs * refillRatePerMs);
      state.lastRefillMs = now;
    }
    return state;
  }

  private snapshot(state: { tokens: number }, allowed: boolean, cost: number): BucketState {
    const msPerToken = this.windowMs / this.capacity;
    const deficitToFull = this.capacity - state.tokens;
    const resetAfterMs = Math.max(0, Math.ceil(deficitToFull * msPerToken));

    const deficitForCost = cost - state.tokens;
    const retryAfterMs = deficitForCost > 0 ? Math.ceil(deficitForCost * msPerToken) : 0;

    return {
      allowed,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(state.tokens)),
      resetAfterMs,
      retryAfterMs,
    };
  }

  /**
   * Reports whether `cost` tokens (default 1) are available right now,
   * WITHOUT spending them. Used to check multiple buckets (e.g. per-app AND
   * per-token) before committing to either — see `middleware.ts`'s
   * `rateLimitBuckets`, which must not partially debit one bucket for a
   * request the other bucket is about to deny.
   */
  peek(key: string, cost = 1): BucketState {
    const state = this.refillAt(key, this.clock.now());
    return this.snapshot(state, state.tokens >= cost, cost);
  }

  /**
   * Spends `cost` tokens (default 1) if available; if not, spends nothing
   * (never goes negative) and reports `allowed: false`. Callers that need
   * "check several buckets, then commit only if all allow" should `peek`
   * first — see `middleware.ts`.
   */
  consume(key: string, cost = 1): BucketState {
    const state = this.refillAt(key, this.clock.now());
    const allowed = state.tokens >= cost;
    if (allowed) {
      state.tokens -= cost;
    }
    return this.snapshot(state, allowed, cost);
  }
}
