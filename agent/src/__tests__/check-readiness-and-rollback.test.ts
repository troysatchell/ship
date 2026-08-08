import { describe, expect, it, vi } from 'vitest';
import {
  findPreviousLiveDeploy,
  parseArgs,
  runReadinessCheck,
} from '../scripts/check-readiness-and-rollback.js';
import type { ReadinessFetcher } from '../deployReadiness.js';

describe('parseArgs', () => {
  it('parses a minimal dry-run invocation with defaults', () => {
    const args = parseArgs(['--url', 'https://example.com/ready']);
    expect(args).toEqual({
      url: 'https://example.com/ready',
      attempts: 3,
      intervalMs: 30_000,
      serviceId: undefined,
      execute: false,
    });
  });

  it('parses an --execute invocation with --service-id', () => {
    const args = parseArgs([
      '--url', 'https://example.com/ready',
      '--attempts', '5',
      '--interval-ms', '1000',
      '--service-id', 'srv-abc123',
      '--execute',
    ]);
    expect(args.attempts).toBe(5);
    expect(args.intervalMs).toBe(1000);
    expect(args.serviceId).toBe('srv-abc123');
    expect(args.execute).toBe(true);
  });

  it('rejects a missing --url', () => {
    expect(() => parseArgs(['--attempts', '3'])).toThrow(/--url is required/);
  });

  // Guards the exact reasoning deployReadiness.ts's module docstring states:
  // a single sample can never distinguish sustained failure from a
  // transient blip, so the CLI must never even ACCEPT a config that could
  // only ever take one sample.
  it('rejects --attempts below 2', () => {
    expect(() => parseArgs(['--url', 'https://x/ready', '--attempts', '1'])).toThrow(/--attempts must be >= 2/);
  });

  it('rejects --execute without --service-id', () => {
    expect(() => parseArgs(['--url', 'https://x/ready', '--execute'])).toThrow(/--execute requires --service-id/);
  });
});

describe('findPreviousLiveDeploy', () => {
  it('returns the most recent live deploy that is not the excluded (current) one', () => {
    const deploys = [
      { id: 'dep-3', status: 'live', createdAt: '2026-08-05T03:00:00Z', commit: { id: 'sha3' } },
      { id: 'dep-2', status: 'live', createdAt: '2026-08-04T03:00:00Z', commit: { id: 'sha2' } },
      { id: 'dep-1', status: 'live', createdAt: '2026-08-03T03:00:00Z', commit: { id: 'sha1' } },
    ];
    const result = findPreviousLiveDeploy(deploys, 'dep-3');
    expect(result?.id).toBe('dep-2');
  });

  it('ignores non-live deploys (failed/canceled/build_in_progress)', () => {
    const deploys = [
      { id: 'dep-3', status: 'live', createdAt: '2026-08-05T03:00:00Z', commit: { id: 'sha3' } },
      { id: 'dep-2b', status: 'update_failed', createdAt: '2026-08-04T12:00:00Z', commit: { id: 'sha2b' } },
      { id: 'dep-2', status: 'live', createdAt: '2026-08-04T03:00:00Z', commit: { id: 'sha2' } },
    ];
    const result = findPreviousLiveDeploy(deploys, 'dep-3');
    expect(result?.id).toBe('dep-2');
  });

  it('returns undefined when there is no other live deploy (nothing to roll back to)', () => {
    const deploys = [{ id: 'dep-1', status: 'live', createdAt: '2026-08-05T03:00:00Z', commit: { id: 'sha1' } }];
    expect(findPreviousLiveDeploy(deploys, 'dep-1')).toBeUndefined();
  });

  it('returns undefined on an empty deploy list', () => {
    expect(findPreviousLiveDeploy([], undefined)).toBeUndefined();
  });
});

// TRO-367 (W5-R36) — proof that the trigger is actually WIRED, not just that
// its pieces individually work. `parseArgs` above and
// `evaluateReadinessSamples`/`pollReadiness` (deployReadiness.test.ts) were
// each already unit-tested in isolation before this ticket; nothing proved
// the decision ("sustained failure") actually reaches the action ("call
// Render"). Every case here is a dry-run / simulated-failure demonstration —
// `fetcher` never makes a real request to a live `/ready` endpoint, and
// `fetchImpl` never makes a real call to Render's API — exactly what this
// ticket's HARD CONSTRAINT calls for in place of a live exercise.
describe('runReadinessCheck (the wired trigger: poll -> evaluate -> decide -> act)', () => {
  function readyFetcher(): ReadinessFetcher {
    return { get: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) };
  }
  function notReadyFetcher(): ReadinessFetcher {
    return { get: vi.fn().mockResolvedValue(new Response(null, { status: 503 })) };
  }

  it('takes no Render action when every sample is ready', async () => {
    const args = parseArgs(['--url', 'https://example.com/ready', '--attempts', '2', '--interval-ms', '0']);
    const fetchImpl = vi.fn();

    const result = await runReadinessCheck(args, {
      fetcher: readyFetcher(),
      fetchImpl,
      apiKey: undefined,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.outcome).toBe('healthy');
    expect(result.evaluation.rollbackWarranted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does NOT call Render on a transient failure that recovers mid-window, even with --execute and a real key', async () => {
    const args = parseArgs([
      '--url', 'https://example.com/ready',
      '--attempts', '3', '--interval-ms', '0',
      '--service-id', 'srv-agent-123', '--execute',
    ]);
    const fetcher: ReadinessFetcher = {
      get: vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    };
    const fetchImpl = vi.fn();

    const result = await runReadinessCheck(args, {
      fetcher,
      fetchImpl,
      apiKey: 'fake-render-key',
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.outcome).toBe('transient');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports "rollback warranted" without calling Render when --execute was not passed (dry run)', async () => {
    const args = parseArgs(['--url', 'https://example.com/ready', '--attempts', '3', '--interval-ms', '0']);
    const fetchImpl = vi.fn();

    const result = await runReadinessCheck(args, {
      fetcher: notReadyFetcher(),
      fetchImpl,
      apiKey: 'fake-render-key',
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.outcome).toBe('dry_run_warn');
    expect(result.evaluation.rollbackWarranted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports "missing_api_key" and does not call Render when --execute was passed but no RENDER_API_KEY is available', async () => {
    const args = parseArgs([
      '--url', 'https://example.com/ready',
      '--attempts', '2', '--interval-ms', '0',
      '--service-id', 'srv-agent-123', '--execute',
    ]);
    const fetchImpl = vi.fn();

    const result = await runReadinessCheck(args, {
      fetcher: notReadyFetcher(),
      fetchImpl,
      apiKey: undefined,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.outcome).toBe('missing_api_key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('on a sustained failure with --execute and a key, actually calls Render to redeploy the previous live deploy', async () => {
    const args = parseArgs([
      '--url', 'https://example.com/ready',
      '--attempts', '3', '--interval-ms', '0',
      '--service-id', 'srv-agent-123', '--execute',
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { deploy: { id: 'dep-broken', status: 'live', createdAt: '2026-08-08T00:00:00Z', commit: { id: 'broken-sha' } } },
            { deploy: { id: 'dep-good', status: 'live', createdAt: '2026-08-07T00:00:00Z', commit: { id: 'good-sha' } } },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'dep-new' }), { status: 201 }));

    const result = await runReadinessCheck(args, {
      fetcher: notReadyFetcher(),
      fetchImpl,
      apiKey: 'fake-render-key',
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.outcome).toBe('rolled_back');
    expect(result.rolledBackTo?.id).toBe('dep-good');
    expect(result.rolledBackTo?.commit?.id).toBe('good-sha');

    // Confirms the trigger actually reaches Render's documented rollback
    // mechanism (POST .../deploys with the previous commit id) — not just
    // that the decision logic ran. Both calls are against `fetchImpl`, a
    // fake; neither ever leaves this process.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const rollbackCall = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(rollbackCall[0]).toBe('https://api.render.com/v1/services/srv-agent-123/deploys');
    expect(rollbackCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(rollbackCall[1].body))).toEqual({ commitId: 'good-sha' });
  });

  it('calls onEvaluated exactly once with the samples and evaluation, before any Render call', async () => {
    const args = parseArgs(['--url', 'https://example.com/ready', '--attempts', '2', '--interval-ms', '0']);
    const seen: unknown[] = [];

    const result = await runReadinessCheck(args, {
      fetcher: readyFetcher(),
      fetchImpl: vi.fn(),
      apiKey: undefined,
      sleep: vi.fn().mockResolvedValue(undefined),
      onEvaluated: (samples, evaluation) => {
        seen.push({ sampleCount: samples.length, evaluation });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ sampleCount: 2, evaluation: result.evaluation });
  });
});
