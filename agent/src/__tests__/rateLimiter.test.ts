import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rateLimiter.js';

function makeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows calls up to maxPerWindow and then rejects further ones in the same window', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ maxPerWindow: 3, windowMs: 1000, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.currentCount()).toBe(3);
  });

  it('a rejected call is not counted — it does not consume budget', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ maxPerWindow: 1, windowMs: 1000, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.currentCount()).toBe(1);
  });

  it('capacity frees up as the window slides past old calls', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    clock.advance(500);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false); // still 2 within the last 1000ms

    clock.advance(501); // the first call (t=0) is now outside the window (t=1001)
    expect(limiter.currentCount()).toBe(1); // only the t=500 call remains
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('rejects an invalid maxPerWindow or non-positive windowMs at construction', () => {
    expect(() => new RateLimiter({ maxPerWindow: 0, windowMs: 1000 })).toThrow();
    expect(() => new RateLimiter({ maxPerWindow: 1, windowMs: 0 })).toThrow();
  });
});
