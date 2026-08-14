import { describe, it, expect } from 'vitest';
import { TokenBucket, type Clock } from '../tokenBucket.js';

/**
 * PF-500 (Linear TRO-427) AC: "bucket exhaustion/refill unit-tested with
 * injected clock." No real `setTimeout` anywhere in this file — every
 * "time passing" assertion below advances a `FakeClock` synchronously,
 * same discipline PF-304 applied to its retry scheduling tonight.
 */

class FakeClock implements Clock {
  private currentMs: number;
  constructor(startMs = 0) {
    this.currentMs = startMs;
  }
  now(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

describe('TokenBucket', () => {
  it('starts every new key at full capacity', () => {
    const bucket = new TokenBucket(10, 60_000, new FakeClock());
    const state = bucket.peek('key-a');
    expect(state.allowed).toBe(true);
    expect(state.limit).toBe(10);
    expect(state.remaining).toBe(10);
    expect(state.resetAfterMs).toBe(0);
    expect(state.retryAfterMs).toBe(0);
  });

  it('consume() debits exactly one token by default and reports the new remaining count', () => {
    const bucket = new TokenBucket(5, 60_000, new FakeClock());
    const first = bucket.consume('key-a');
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(4);
    const second = bucket.consume('key-a');
    expect(second.remaining).toBe(3);
  });

  it('exhaustion: denies once the bucket has no tokens left, and does not go negative', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 60_000, clock);
    expect(bucket.consume('key-a').allowed).toBe(true); // 3 -> 2
    expect(bucket.consume('key-a').allowed).toBe(true); // 2 -> 1
    expect(bucket.consume('key-a').allowed).toBe(true); // 1 -> 0

    const denied = bucket.consume('key-a');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // Consuming again while empty must not underflow past 0.
    const stillDenied = bucket.consume('key-a');
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.remaining).toBe(0);
  });

  it('peek() never spends a token, even when called repeatedly', () => {
    const bucket = new TokenBucket(2, 60_000, new FakeClock());
    bucket.peek('key-a');
    bucket.peek('key-a');
    bucket.peek('key-a');
    const state = bucket.peek('key-a');
    expect(state.remaining).toBe(2);
    expect(state.allowed).toBe(true);
  });

  it('refill: exhausted bucket gains exactly one token after windowMs/capacity has elapsed', () => {
    const clock = new FakeClock(0);
    // capacity 10 over a 60_000ms window -> 1 token every 6_000ms.
    const bucket = new TokenBucket(10, 60_000, clock);
    for (let i = 0; i < 10; i++) {
      expect(bucket.consume('key-a').allowed).toBe(true);
    }
    expect(bucket.peek('key-a').remaining).toBe(0);

    clock.advance(6_000);
    expect(bucket.peek('key-a').remaining).toBe(1);

    clock.advance(6_000);
    expect(bucket.peek('key-a').remaining).toBe(2);
  });

  it('refill: never exceeds capacity even after a very long idle period', () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket(5, 60_000, clock);
    bucket.consume('key-a'); // 5 -> 4
    clock.advance(10 * 60_000); // 10 windows' worth of idle time
    const state = bucket.peek('key-a');
    expect(state.remaining).toBe(5);
    expect(state.resetAfterMs).toBe(0);
  });

  it('refill: a fully exhausted bucket is exactly full again after one full windowMs', () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket(4, 60_000, clock);
    for (let i = 0; i < 4; i++) bucket.consume('key-a');
    expect(bucket.peek('key-a').remaining).toBe(0);

    clock.advance(60_000);
    const state = bucket.peek('key-a');
    expect(state.remaining).toBe(4);
    expect(state.resetAfterMs).toBe(0);
  });

  it('retryAfterMs counts down linearly while exhausted, and is 0 once allowed again', () => {
    const clock = new FakeClock(0);
    // capacity 6 over 60_000ms -> 1 token every 10_000ms.
    const bucket = new TokenBucket(6, 60_000, clock);
    for (let i = 0; i < 6; i++) bucket.consume('key-a');

    const justExhausted = bucket.peek('key-a');
    expect(justExhausted.allowed).toBe(false);
    expect(justExhausted.retryAfterMs).toBe(10_000);

    clock.advance(4_000);
    expect(bucket.peek('key-a').retryAfterMs).toBe(6_000);

    clock.advance(6_000);
    const nowAllowed = bucket.peek('key-a');
    expect(nowAllowed.allowed).toBe(true);
    expect(nowAllowed.retryAfterMs).toBe(0);
  });

  it('resetAfterMs reflects time to FULL capacity, not just to the next single token', () => {
    const clock = new FakeClock(0);
    // capacity 4 over 40_000ms -> 1 token every 10_000ms.
    const bucket = new TokenBucket(4, 40_000, clock);
    bucket.consume('key-a'); // spend 2 of 4
    bucket.consume('key-a');
    const state = bucket.peek('key-a');
    expect(state.remaining).toBe(2);
    // 2 tokens short of full, at 10_000ms/token -> 20_000ms to full.
    expect(state.resetAfterMs).toBe(20_000);
  });

  it('different keys have fully independent buckets', () => {
    const bucket = new TokenBucket(2, 60_000, new FakeClock());
    bucket.consume('key-a');
    bucket.consume('key-a');
    expect(bucket.peek('key-a').allowed).toBe(false);
    expect(bucket.peek('key-b').allowed).toBe(true);
    expect(bucket.peek('key-b').remaining).toBe(2);
  });

  it('rejects a non-positive capacity or windowMs at construction time', () => {
    expect(() => new TokenBucket(0, 60_000)).toThrow();
    expect(() => new TokenBucket(-5, 60_000)).toThrow();
    expect(() => new TokenBucket(10, 0)).toThrow();
    expect(() => new TokenBucket(10, -1)).toThrow();
  });
});
