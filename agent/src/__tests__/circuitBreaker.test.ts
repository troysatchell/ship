/**
 * TRO-315 (FG-4) — regression tests for `CircuitBreaker`.
 *
 * Carried over from `api/src/utils/__tests__/circuitBreaker.test.ts`
 * (TRO-311) unchanged in substance — see `circuitBreaker.ts`'s header for
 * why this is a deliberate copy of a verified-correct file rather than a
 * fresh implementation. The last case ("allows only ONE trial call...") is
 * FG-4's own proof #3 (half-open concurrency) verbatim.
 *
 * All timing is driven by an injected `now` function advanced manually,
 * never a real sleep (lessons.md #17) — the breaker's cooldown logic is pure
 * arithmetic over timestamps.
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
    expect(breaker.getState()).toBe('closed');

    await expect(breaker.execute(vi.fn().mockResolvedValue('ok'))).resolves.toBe('ok');

    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('c')))).rejects.toThrow();
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('d')))).rejects.toThrow();
    expect(breaker.getState()).toBe('closed');
  });

  it('allows only ONE trial call through when several requests arrive concurrently right as the cooldown elapses (TRO-315 proof #3 / TRO-311 CodeRabbit finding)', async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await expect(breaker.execute(vi.fn().mockRejectedValue(new Error('a')))).rejects.toThrow('a');
    expect(breaker.getState()).toBe('open');
    clock.advance(1001);

    let releaseTrial: (() => void) | undefined;
    const trialGate = new Promise<void>((resolve) => {
      releaseTrial = resolve;
    });
    const trialFn = vi.fn(async () => {
      await trialGate;
      return 'trial result';
    });
    const otherFn = vi.fn().mockResolvedValue('should not run');

    const trialPromise = breaker.execute(trialFn);
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
