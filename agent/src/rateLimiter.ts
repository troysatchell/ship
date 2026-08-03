/**
 * Self-throttle for outbound Ship calls — TRO-315 (FG-4).
 *
 * FLEETGRAPH.MD "Reliability": both of Ship's rate limiters fail OPEN — on a
 * cache outage the server-side ceiling disappears entirely — so the agent
 * cannot treat Ship's limiter as a safety net and must cap its own outbound
 * rate below Ship's shared per-source-IP ceiling (~6,000 req/min, shared
 * across every user the agent serves). This is a plain sliding-window
 * counter, deliberately not a token bucket: the requirement is "no more than
 * N calls in any trailing `windowMs`", which a sliding window expresses
 * directly, and it needs no background refill timer to reason about or test.
 */

export class SelfThrottleExceededError extends Error {
  constructor(message = 'self-throttle limit exceeded') {
    super(message);
    this.name = 'SelfThrottleExceededError';
  }
}

export interface RateLimiterOptions {
  /** Maximum calls allowed within any trailing `windowMs`. */
  maxPerWindow: number;
  windowMs: number;
  /** Clock source, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (options.maxPerWindow < 1) {
      throw new Error('maxPerWindow must be at least 1');
    }
    if (options.windowMs <= 0) {
      throw new Error('windowMs must be positive');
    }
    this.maxPerWindow = options.maxPerWindow;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Attempt to record one call. Returns `true` and counts it if under the
   * ceiling for the current window; returns `false` (does NOT count it)
   * otherwise. Never throws — callers decide what "over the limit" means.
   */
  tryAcquire(): boolean {
    const now = this.now();
    const windowStart = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length >= this.maxPerWindow) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  /** Calls currently counted within the trailing window. For tests/metrics. */
  currentCount(): number {
    const windowStart = this.now() - this.windowMs;
    return this.timestamps.filter((t) => t > windowStart).length;
  }
}
