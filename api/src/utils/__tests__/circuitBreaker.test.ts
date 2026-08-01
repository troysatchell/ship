/**
 * TRO-311 (RULE-7 follow-up) — regression tests for `CircuitBreaker`.
 *
 * All timing is driven by an injected `now` function advanced manually, never
 * a real sleep (lessons.md #17) — the breaker's cooldown logic is pure
 * arithmetic over timestamps, so there is no reason to touch a real clock or
 * `vi.useFakeTimers()` at all; a plain counter passed as `now` is simpler and
 * exercises exactly the same code path.
 */
import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../circuitBreaker.js';

function makeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows calls through', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(breaker.getState()).toBe('closed');

    const fn = vi.fn().mockResolvedValue('ok');
    await expect(breaker.execute(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe('closed');
  });

  it('stays CLOSED and keeps calling the function while failures remain below the threshold', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(breaker.execute(fn)).rejects.toThrow('boom');
    await expect(breaker.execute(fn)).rejects.toThrow('boom');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(breaker.getState()).toBe('closed');
  });

  it('trips OPEN after exactly `failureThreshold` consecutive failures', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(breaker.execute(fn)).rejects.toThrow('boom');
    await expect(breaker.execute(fn)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('closed');
    await expect(breaker.execute(fn)).rejects.toThrow('boom');

    expect(breaker.getState()).toBe('open');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('OPEN state fails immediately with CircuitOpenError WITHOUT calling the wrapped function', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(breaker.execute(failing)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('open');

    // A DIFFERENT function passed while OPEN and within the cooldown — if the
    // breaker is doing its job, this is never invoked at all.
    const shouldNotBeCalled = vi.fn().mockResolvedValue('should not run');
    clock.advance(5000); // still well inside the 10s cooldown
    await expect(breaker.execute(shouldNotBeCalled)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
  });

  it('allows exactly one HALF_OPEN trial call once the cooldown has elapsed', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: clock.now });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('boom')))).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('open');

    clock.advance(9999);
    await expect(
      breaker.execute(vi.fn().mockResolvedValue('too early'))
    ).rejects.toBeInstanceOf(CircuitOpenError);

    clock.advance(2); // now 10001ms since opening — past the 10s cooldown
    const trial = vi.fn().mockResolvedValue('recovered');
    await expect(breaker.execute(trial)).resolves.toBe('recovered');
    expect(trial).toHaveBeenCalledTimes(1);
  });

  it('a successful HALF_OPEN trial closes the breaker and resets the failure count', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: clock.now });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('a')))).rejects.toThrow();
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('b')))).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    clock.advance(1001);
    await expect(breaker.execute(vi.fn().mockResolvedValue('ok'))).resolves.toBe('ok');
    expect(breaker.getState()).toBe('closed');

    // Failure count was reset by the successful trial — it should take the
    // full threshold again to re-trip, not just one more failure.
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('c')))).rejects.toThrow();
    expect(breaker.getState()).toBe('closed');
  });

  it('a failed HALF_OPEN trial reopens the breaker and restarts the cooldown from now', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('a')))).rejects.toThrow();
    expect(breaker.getState()).toBe('open');

    clock.advance(1001); // cooldown elapsed
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('still down')))).rejects.toThrow(
      'still down'
    );
    expect(breaker.getState()).toBe('open');

    // Cooldown restarted from the moment of the failed trial, not the
    // original open time — advancing only 500ms more (1501ms since the
    // ORIGINAL open) must still be inside the NEW cooldown window.
    clock.advance(500);
    await expect(
      breaker.execute(vi.fn().mockResolvedValue('too early'))
    ).rejects.toBeInstanceOf(CircuitOpenError);

    clock.advance(501); // now 1001ms since the failed trial reopened it
    await expect(breaker.execute(vi.fn().mockResolvedValue('recovered'))).resolves.toBe('recovered');
    expect(breaker.getState()).toBe('closed');
  });

  it('a success before the threshold resets the consecutive-failure count', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });

    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('a')))).rejects.toThrow();
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('b')))).rejects.toThrow();
    expect(breaker.getState()).toBe('closed'); // 2 of 3 — not yet tripped

    await expect(breaker.execute(vi.fn().mockResolvedValue('ok'))).resolves.toBe('ok');

    // Two more failures after the reset should NOT trip it — the counter
    // restarted at the success above, so this is only 2 of 3 again.
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('c')))).rejects.toThrow();
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('d')))).rejects.toThrow();
    expect(breaker.getState()).toBe('closed');
  });

  it('allows only ONE trial call through when several requests arrive concurrently right as the cooldown elapses (CodeRabbit finding on this PR)', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('a')))).rejects.toThrow('a');
    expect(breaker.getState()).toBe('open');
    clock.advance(1001); // cooldown elapsed — the next call(s) are eligible to trial

    // A trial function that does not resolve until released, so its
    // `execute()` call is still in flight (state pinned at 'half-open')
    // when the second, third, and fourth calls are made — this is what
    // actually exercises the race, unlike sequentially-awaited calls.
    let releaseTrial: (() => void) | undefined;
    const trialGate = new Promise<void>((resolve) => {
      releaseTrial = resolve;
    });
    const trialFn = vi.fn(async () => {
      await trialGate;
      return 'trial result';
    });
    const otherFn = vi.fn().mockResolvedValue('should not run');

    const trialPromise = breaker.execute(trialFn); // starts the trial, does not resolve yet
    // These three arrive while the trial above is still pending.
    const rejectedPromises = [breaker.execute(otherFn), breaker.execute(otherFn), breaker.execute(otherFn)];

    for (const p of rejectedPromises) {
      await expect(p).rejects.toBeInstanceOf(CircuitOpenError);
    }
    expect(otherFn, 'no concurrent caller may reach the wrapped function during an in-flight trial').not.toHaveBeenCalled();
    expect(trialFn).toHaveBeenCalledTimes(1);

    releaseTrial?.();
    await expect(trialPromise).resolves.toBe('trial result');
    expect(breaker.getState()).toBe('closed');
  });

  it('rejects an invalid failureThreshold or negative cooldownMs at construction', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, cooldownMs: 1000 })).toThrow();
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: -1 })).toThrow();
  });
});
