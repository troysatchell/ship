import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * TRO-277 / TEST-12 — mock isolation between test cases.
 *
 * `vi.clearAllMocks()` clears call records but does NOT drain queued
 * `mockResolvedValueOnce` responses. A test that queues more responses than its
 * handler actually consumes therefore leaves one behind, and the next test to
 * run gets that stale response first — every subsequent mock in that test shifts
 * by one. The visible symptom is a failure in a test that has nothing to do with
 * the bug, which is why this presented as a load-sensitive "flake" that landed on
 * a different test each time.
 *
 * The first block pins the vitest semantics the rule rests on. The second block
 * enforces the rule across the api suite, so a future test file cannot quietly
 * reintroduce the combination.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..');

/**
 * This file necessarily contains both forbidden tokens — it names them in order
 * to search for them — so it is the one file excluded from its own scan.
 */
const SELF = 'mock-isolation.test.ts';

/** Any of the "consume once then discard" queue helpers. */
const ONCE_QUEUE = /mock(?:Resolved|Rejected|Return)ValueOnce|mockImplementationOnce/;
const CLEAR_ALL = /vi\s*\.\s*clearAllMocks\s*\(/;

function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...testFilesUnder(full));
    } else if (entry.endsWith('.test.ts') && entry !== SELF) {
      found.push(full);
    }
  }
  return found;
}

describe('vi.clearAllMocks does not drain queued once-values (the TEST-12 mechanism)', () => {
  it('leaves an unconsumed mockResolvedValueOnce queued after clearAllMocks', async () => {
    const query = vi.fn();
    query.mockResolvedValueOnce('leaked-from-previous-test');

    // Simulate the beforeEach of a test file that uses clearAllMocks.
    vi.clearAllMocks();

    // The queued response survived the "cleanup" and is served to the next
    // caller, which is the leak this ticket removes.
    await expect(query()).resolves.toBe('leaked-from-previous-test');
  });

  it('drains the queue when resetAllMocks is used instead', async () => {
    const query = vi.fn();
    query.mockResolvedValueOnce('leaked-from-previous-test');

    vi.resetAllMocks();

    // No implementation and no queue left: a stale response cannot reach the
    // next test.
    expect(await query()).toBeUndefined();
  });

  it('preserves an implementation passed to vi.fn(impl) across resetAllMocks', async () => {
    // This is what makes resetAllMocks a safe blanket replacement: mock factory
    // defaults survive it, as long as they are given to vi.fn() directly rather
    // than chained on afterwards as .mockResolvedValue(...).
    const connect = vi.fn(async () => 'the-mock-client');
    const filterSql = vi.fn(() => '1=1');

    vi.resetAllMocks();

    await expect(connect()).resolves.toBe('the-mock-client');
    expect(filterSql()).toBe('1=1');
  });

  it('wipes an implementation that was chained on with mockResolvedValue', async () => {
    // The counterpart trap: a factory written as vi.fn().mockResolvedValue(x)
    // becomes an undefined-returning stub after resetAllMocks. Files converted
    // for this ticket had their factories rewritten to the vi.fn(impl) form.
    const chained = vi.fn().mockResolvedValue('gone-after-reset');

    vi.resetAllMocks();

    expect(await chained()).toBeUndefined();
  });
});

describe('api suite mock-isolation invariant', () => {
  it('finds api test files to scan', () => {
    // Guard against the scan silently passing because it matched nothing.
    expect(testFilesUnder(API_SRC).length).toBeGreaterThan(20);
  });

  it('has no test file that combines clearAllMocks with a once-queue', () => {
    const violations: string[] = [];

    for (const file of testFilesUnder(API_SRC)) {
      const source = readFileSync(file, 'utf8');
      if (CLEAR_ALL.test(source) && ONCE_QUEUE.test(source)) {
        violations.push(relative(API_SRC, file));
      }
    }

    expect(
      violations,
      'These api test files use vi.clearAllMocks() alongside a *Once mock queue. ' +
        'clearAllMocks does not drain that queue, so an over-queued response leaks ' +
        'into the next test and shifts its mocks by one (TRO-277 / TEST-12). Use ' +
        'vi.resetAllMocks() instead, and give mock factories their implementation ' +
        'via vi.fn(impl) so the reset restores it.'
    ).toEqual([]);
  });
});
