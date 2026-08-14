/**
 * PF-405 (Linear TRO-422) — regression test for the size gate's pure
 * pass/fail decision logic (`scripts/measure-size.mjs#checkSize`).
 *
 * Deliberately does NOT re-run a real esbuild bundle here (that would
 * duplicate `scripts/measure-size.mjs`'s own CLI, which is exercised
 * directly — `node scripts/measure-size.mjs` — as its own CI/PR-evidence
 * step; see CHANGES.md's TRO-422 entry and the PR body for the real,
 * captured pass/fail output against the actual built bundle). This file
 * proves the THRESHOLD COMPARISON itself is correct and stays correct —
 * exactly the AC this ticket names ("prove ... the gate fails on
 * simulated ... bloat") — using `checkSize`'s own `thresholdKb` parameter
 * as the "simulated bloat" lever (a real gzip byte count held fixed, the
 * threshold moved below it), rather than needing to actually inflate a
 * built artifact for a permanent regression test.
 *
 * `scripts/` is outside `sdk/src` (this package's `rootDir`), so
 * `sdk/tsconfig.json` would reject a static import of it from anywhere
 * under `tsc`'s program (TS6059) — same reason `client.liveServer.test.ts`
 * imports `api/src/app.js` only from inside `src/__tests__/**`, which that
 * file's own tsconfig entry excludes from `tsc`/`tsc --noEmit` for exactly
 * this reason. This file lives in the same excluded directory.
 */
import { describe, it, expect } from 'vitest';
import { checkSize, DEFAULT_THRESHOLD_KB } from '../../scripts/measure-size.mjs';

describe('PF-405: size gate decision logic (checkSize)', () => {
  it('passes when the measured gzip size is under the real 250 KB threshold', () => {
    const result = checkSize(5085); // the real, measured @ship/sdk min+gz size as of this ticket
    expect(result.pass).toBe(true);
    expect(result.gzipKb).toBeCloseTo(5.085, 2);
    expect(result.thresholdKb).toBe(DEFAULT_THRESHOLD_KB);
  });

  it('passes at exactly the DEFAULT_THRESHOLD_KB boundary minus one byte (strictly under, not at-or-under)', () => {
    const thresholdBytes = DEFAULT_THRESHOLD_KB * 1000;
    expect(checkSize(thresholdBytes - 1).pass).toBe(true);
  });

  it('fails at exactly the threshold boundary (< , not <=)', () => {
    const thresholdBytes = DEFAULT_THRESHOLD_KB * 1000;
    expect(checkSize(thresholdBytes).pass).toBe(false);
  });

  it('AC proof: simulated bloat — a real measured size against an artificially lowered threshold FAILS the gate', () => {
    // 5085 bytes is this ticket's real, measured @ship/sdk min+gz size (see
    // scripts/measure-size.mjs's own captured output in the PR body/
    // CHANGES.md) — nowhere near 250 KB. Simulating "bloat" via
    // scripts/measure-size.mjs's own supported `--threshold-kb` override
    // (documented in that file's header as TEST-ONLY, never the real gate)
    // rather than actually padding a built artifact: the THRESHOLD
    // COMPARISON is what this ticket's AC needs proven, and this exercises
    // that exact code path with a real gzip byte count.
    const result = checkSize(5085, 1);
    expect(result.pass).toBe(false);
    expect(result.gzipBytes).toBe(5085);
    expect(result.thresholdKb).toBe(1);
  });

  it('fails when the measured gzip size genuinely exceeds the real 250 KB threshold', () => {
    const oneMegabyte = 1_000_000;
    const result = checkSize(oneMegabyte);
    expect(result.pass).toBe(false);
    expect(result.gzipKb).toBe(1000);
  });
});
