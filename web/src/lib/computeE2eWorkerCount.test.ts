/**
 * Regression test for TRO-232 / audit finding TEST-10.
 *
 * The old inline calculation in `playwright.config.ts` derived worker count from
 * `os.freemem()`, which macOS keeps near zero regardless of actually-available
 * memory (it uses spare RAM for cache/compression instead of reporting it "free").
 * The audit measured this exact scenario on a real machine: 24GB total RAM, 14 CPU
 * cores, `os.freemem()` reporting only 0.3GB. That collapsed the run to a single
 * worker — a ~4x slowdown with no error or warning.
 *
 * `OLD_BUGGY_CALCULATION` below is a literal copy of the pre-fix logic (not a
 * re-derivation) so this test independently proves the bug existed, rather than
 * merely asserting today's fixed function returns something reasonable.
 */
import { describe, it, expect } from 'vitest';
import { computeE2eWorkerCount, type ComputeE2eWorkerCountOptions } from './computeE2eWorkerCount';

// Verbatim copy of the pre-TRO-232 `getWorkerCount()` memory math from
// `playwright.config.ts` (freemem-based, no Darwin special-case). Kept ONLY so this
// test can demonstrate the bug directly; not used by the fixed implementation.
function oldBuggyCalculation(freeMemGB: number, cpuCores: number): number {
  const memPerWorker = 0.5;
  const reserveGB = 2;
  const memoryBasedLimit = Math.floor((freeMemGB - reserveGB) / memPerWorker);
  return Math.max(1, Math.min(memoryBasedLimit, cpuCores));
}

// The audit's exact measured Darwin scenario: 24GB/14-core Mac, os.freemem() ≈ 0.3GB.
const AUDIT_MEASURED_DARWIN: ComputeE2eWorkerCountOptions = {
  platform: 'darwin',
  totalMemGB: 24,
  freeMemGB: 0.3,
  cpuCores: 14,
  isCI: false,
};

describe('the bug this ticket fixes (documented, not exercised by the fix)', () => {
  it('the old freemem-based calculation collapses to 1 worker on the audit-measured Mac', () => {
    // floor((0.3 - 2) / 0.5) = floor(-3.4) = -4; Math.max(1, Math.min(-4, 14)) = 1
    expect(oldBuggyCalculation(AUDIT_MEASURED_DARWIN.freeMemGB, AUDIT_MEASURED_DARWIN.cpuCores)).toBe(1);
  });
});

describe('computeE2eWorkerCount', () => {
  it('fixes the Darwin collapse: audit-measured machine gets more than 1 worker', () => {
    const result = computeE2eWorkerCount(AUDIT_MEASURED_DARWIN);
    expect(result).toBeGreaterThanOrEqual(2);
    expect(result).toBeLessThanOrEqual(AUDIT_MEASURED_DARWIN.cpuCores);
  });

  it('never exceeds cpuCores on Darwin even with abundant memory', () => {
    const result = computeE2eWorkerCount({
      platform: 'darwin',
      totalMemGB: 128,
      freeMemGB: 0.5,
      cpuCores: 8,
      isCI: false,
    });
    expect(result).toBeLessThanOrEqual(8);
  });

  it('never returns 0 or negative on Darwin even on a low-memory machine', () => {
    const result = computeE2eWorkerCount({
      platform: 'darwin',
      totalMemGB: 4,
      freeMemGB: 0.1,
      cpuCores: 8,
      isCI: false,
    });
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it('leaves non-Darwin (Linux) freemem-based behavior unchanged', () => {
    const linux: ComputeE2eWorkerCountOptions = {
      platform: 'linux',
      totalMemGB: 24,
      freeMemGB: 8,
      cpuCores: 14,
      isCI: false,
    };
    // floor((8 - 2) / 0.5) = 12, min(12, 14) = 12
    expect(computeE2eWorkerCount(linux)).toBe(12);
  });

  it('reproduces the old Linux collapse when freemem is genuinely low (unchanged, sound heuristic)', () => {
    const result = computeE2eWorkerCount({
      platform: 'linux',
      totalMemGB: 24,
      freeMemGB: 0.3,
      cpuCores: 14,
      isCI: false,
    });
    // On Linux, low freemem really does mean low available memory, so collapsing
    // toward 1 is the correct, intended behavior — this path is deliberately untouched.
    expect(result).toBe(1);
  });

  it('CI always returns 4 regardless of platform or memory (unaffected by this fix)', () => {
    const result = computeE2eWorkerCount({
      platform: 'darwin',
      totalMemGB: 24,
      freeMemGB: 0.3,
      cpuCores: 14,
      isCI: true,
    });
    expect(result).toBe(4);
  });

  it('an explicit PLAYWRIGHT_WORKERS override wins over every other input', () => {
    const result = computeE2eWorkerCount({
      platform: 'darwin',
      totalMemGB: 24,
      freeMemGB: 0.3,
      cpuCores: 14,
      isCI: true,
      explicitOverride: '7',
    });
    expect(result).toBe(7);
  });

  it('ignores a garbage override and falls through to normal calculation', () => {
    const result = computeE2eWorkerCount({
      ...AUDIT_MEASURED_DARWIN,
      explicitOverride: 'not-a-number',
    });
    expect(result).toBeGreaterThanOrEqual(2);
    expect(result).toBeLessThanOrEqual(AUDIT_MEASURED_DARWIN.cpuCores);
  });
});
