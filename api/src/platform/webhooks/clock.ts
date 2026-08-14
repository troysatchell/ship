/**
 * Deterministic clock injection for the webhook deliverer (PF-304 / TRO-438).
 *
 * This ticket's hard, non-negotiable AC: zero real `setTimeout`/sleep waits in
 * tests, with a clock the test can advance programmatically to simulate the
 * 1s/4s/16s/... passage of time instantly. Checked this codebase for an
 * existing injectable-clock abstraction before adding a new one, per this
 * ticket's own instruction — found two narrower precedents, neither directly
 * reusable:
 *   - `agent/src/circuitBreaker.ts`'s `CircuitBreakerOptions.now?: () => number`
 *     — a bare function, not an object, and scoped to one class's constructor
 *     option rather than a shared type other modules import.
 *   - `platform/webhooks/signer.ts`'s `Clock = () => number` — also a bare
 *     function, and deliberately returns **Unix seconds** (matching the
 *     `Ship-Signature` header's `t=<unix-seconds>` field), not milliseconds.
 *     Reusing that type here would silently misinterpret every delay/interval
 *     in this file (`RETRY_SCHEDULE_MS` is milliseconds) as seconds.
 * This module's `Clock` is deliberately an object with a `now(): number`
 * method (milliseconds, matching `Date.now()`) rather than a bare function —
 * `ManualClock` needs an `advance()` method alongside `now()`, and a bare
 * function type has nowhere to hang a second method. The deliverer converts
 * to `signer.ts`'s unix-seconds `Clock` at the one call site that needs it
 * (`Math.floor(this.clock.now() / 1000)`), so the two `Clock` shapes never get
 * confused for each other at a type level.
 */

/** Milliseconds since the Unix epoch — same unit and epoch as `Date.now()`. */
export interface Clock {
  now(): number;
}

/** Real wall-clock time. The only `Clock` production code should ever use. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * A clock the caller advances by hand. Never ticks on its own — `now()`
 * returns whatever `advance()` last left it at (or the constructor's
 * `startMs`, before any `advance()` call). This is what lets a test simulate
 * "4 seconds passed" in zero real elapsed time: call `advance(4_000)`, then
 * re-check what the deliverer considers due.
 */
export class ManualClock implements Clock {
  private currentMs: number;

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** Moves the clock forward by `ms`. Throws on a negative value — time does
   * not run backwards, and a negative `advance()` call at a test's own call
   * site is almost always a sign-flip bug worth failing loudly on rather than
   * silently rewinding the clock. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`ManualClock.advance: ms must be a finite number >= 0 (got ${ms})`);
    }
    this.currentMs += ms;
  }
}
