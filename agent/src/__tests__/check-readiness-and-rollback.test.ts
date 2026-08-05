import { describe, expect, it } from 'vitest';
import { findPreviousLiveDeploy, parseArgs } from '../scripts/check-readiness-and-rollback.js';

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
