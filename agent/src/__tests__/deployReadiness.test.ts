import { describe, expect, it, vi } from 'vitest';
import {
  evaluateReadinessSamples,
  pollReadiness,
  type ReadinessFetcher,
  type ReadinessSample,
} from '../deployReadiness.js';

function sample(ready: boolean, reason = ready ? 'ok' : 'http_503', at = '2026-08-05T00:00:00.000Z'): ReadinessSample {
  return { at, ready, reason };
}

describe('evaluateReadinessSamples', () => {
  it('does not warrant rollback on zero samples (no data is not evidence of failure)', () => {
    const result = evaluateReadinessSamples([]);
    expect(result.rollbackWarranted).toBe(false);
    expect(result.reason).toBe('no_samples');
  });

  it('does not warrant rollback when every sample is ready', () => {
    const result = evaluateReadinessSamples([sample(true), sample(true), sample(true)]);
    expect(result.rollbackWarranted).toBe(false);
    expect(result.reason).toBe('healthy: every sample reported ready');
  });

  // This is the case FLEETGRAPH.MD explicitly warns about: "/ready can also
  // legitimately be false on a healthy, freshly-promoted instance if Ship
  // itself is briefly down, and that specific case must not be read as 'the
  // deploy failed.'" A single failed sample among several that recover must
  // NOT trigger a rollback.
  it('does NOT warrant rollback on a single transient failure that recovers (the FLEETGRAPH.MD caveat)', () => {
    const result = evaluateReadinessSamples([sample(true), sample(false), sample(true)]);
    expect(result.rollbackWarranted).toBe(false);
    expect(result.reason).toContain('transient');
    expect(result.failureCount).toBe(1);
    expect(result.sampleCount).toBe(3);
  });

  it('does NOT warrant rollback when only the first sample fails then it recovers', () => {
    const result = evaluateReadinessSamples([sample(false), sample(true), sample(true)]);
    expect(result.rollbackWarranted).toBe(false);
  });

  // This is the exact gap FLEETGRAPH.MD names: a deploy that boots (passes
  // /health) but is missing config or cannot reach Ship stays not-ready on
  // EVERY sample across the whole window — a real, sustained failure.
  it('WARRANTS rollback when every sample in the window is not-ready (sustained failure)', () => {
    const result = evaluateReadinessSamples([
      sample(false, 'ship_unreachable: timeout'),
      sample(false, 'ship_unreachable: timeout'),
      sample(false, 'ship_unreachable: timeout'),
    ]);
    expect(result.rollbackWarranted).toBe(true);
    expect(result.reason).toContain('sustained_not_ready');
    expect(result.failureCount).toBe(3);
    expect(result.sampleCount).toBe(3);
  });

  it('warrants rollback on a single-sample window that fails (degenerate case of "every sample failed")', () => {
    const result = evaluateReadinessSamples([sample(false, 'config_incomplete')]);
    expect(result.rollbackWarranted).toBe(true);
  });
});

describe('pollReadiness', () => {
  it('takes exactly `attempts` samples, sleeping `intervalMs` between them but not after the last', async () => {
    const fetcher: ReadinessFetcher = {
      get: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    };
    const sleep = vi.fn().mockResolvedValue(undefined);

    const samples = await pollReadiness({
      url: 'http://localhost:9999/ready',
      attempts: 3,
      intervalMs: 1234,
      fetcher,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      sleep,
    });

    expect(samples).toHaveLength(3);
    expect(samples.every((s) => s.ready)).toBe(true);
    expect(fetcher.get).toHaveBeenCalledTimes(3);
    expect(fetcher.get).toHaveBeenCalledWith('http://localhost:9999/ready');
    // Sleeps between samples only — 2 sleeps for 3 attempts, never a
    // trailing sleep after the final sample (nothing left to wait for).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('records a non-2xx response as not-ready with an http_<status> reason, never throwing', async () => {
    const fetcher: ReadinessFetcher = {
      get: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    };
    const samples = await pollReadiness({
      url: 'http://localhost:9999/ready',
      attempts: 1,
      intervalMs: 1000,
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(samples).toEqual([expect.objectContaining({ ready: false, reason: 'http_503' })]);
  });

  it('records a fetch rejection (network failure) as not-ready, never throwing', async () => {
    const fetcher: ReadinessFetcher = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const samples = await pollReadiness({
      url: 'http://localhost:9999/ready',
      attempts: 1,
      intervalMs: 1000,
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.ready).toBe(false);
    expect(samples[0]?.reason).toContain('fetch_failed');
    expect(samples[0]?.reason).toContain('ECONNREFUSED');
  });

  it('rejects an attempts count below 1 rather than silently returning no data', async () => {
    const fetcher: ReadinessFetcher = { get: vi.fn() };
    await expect(
      pollReadiness({ url: 'http://x/ready', attempts: 0, intervalMs: 1000, fetcher })
    ).rejects.toThrow(/attempts must be >= 1/);
  });
});
