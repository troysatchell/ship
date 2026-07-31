/**
 * Pure worker-count calculation for `playwright.config.ts`'s `getWorkerCount()`.
 *
 * Added for TRO-232 / audit finding TEST-10: the previous inline calculation derived
 * worker count from `os.freemem()`. That is sound on Linux (and CI, which never
 * reaches this path — see below) but wrong on Darwin: macOS deliberately keeps
 * reported free memory near zero, using spare RAM for filesystem cache and memory
 * compression rather than leaving it "free". On a 24GB/14-core Mac the audit measured
 * `freeMemGB ≈ 0.3`, which drove `memoryBasedLimit` negative and collapsed the run to
 * a single worker (`Math.max(1, Math.min(-4, 14))`) — a ~4x slowdown with no error or
 * warning, discovered only by a human running the suite locally.
 *
 * Fix: on `darwin`, budget a fraction of *total* memory (`os.totalmem()`) instead of
 * free memory. Total memory is a stable number macOS does not obscure the way it
 * obscures "free". Every other platform (and CI, via the `isCI` short-circuit) keeps
 * the original freemem-based math untouched — the audit's own text says that
 * heuristic "is sound on Linux and wrong on Darwin", so only the wrong half changes.
 *
 * Inputs are passed in explicitly (rather than this function reading `os`/
 * `process.env` itself) so the calculation is a pure function: testable with plain
 * numbers, no `os`/`process.env` mocking required. `playwright.config.ts` is the only
 * caller and is responsible for gathering the real values.
 */

export interface ComputeE2eWorkerCountOptions {
  /** `os.platform()` — only `'darwin'` changes behavior; every other value uses the
   *  original freemem-based calculation. */
  platform: string;
  /** `os.totalmem()` in GB. Only consulted on `darwin`. */
  totalMemGB: number;
  /** `os.freemem()` in GB. Used on every platform except `darwin`. */
  freeMemGB: number;
  /** `os.cpus().length`. Workers never exceed this. */
  cpuCores: number;
  /** `!!process.env.CI`. Returns a fixed 4 when no valid `explicitOverride` is set
   *  (unaffected by this fix) — `explicitOverride` is checked first and wins. */
  isCI: boolean;
  /** Raw `process.env.PLAYWRIGHT_WORKERS`, if set. Wins over every other input. */
  explicitOverride?: string;
}

// Each worker needs roughly 150MB Postgres + 100MB API + 50MB preview + 200MB
// browser ≈ 500MB. Keep 2GB free for the OS and other running apps.
const MEM_PER_WORKER_GB = 0.5;
const RESERVE_GB = 2;

// macOS-only: fraction of TOTAL memory budgeted toward workers. Chosen so the
// audit's measured machine (24GB/14 cores) lands at the CPU-core ceiling rather
// than a memory-derived number, while still degrading on genuinely small Macs
// instead of hardcoding a fixed worker count that would over-provision them.
const DARWIN_USABLE_MEM_FRACTION = 0.5;

/**
 * Compute a safe Playwright worker count from machine/environment facts.
 * For the automatic (non-override, non-CI) calculation: never returns 0 or a
 * negative number, never exceeds `cpuCores`. A valid `explicitOverride` bypasses
 * both this floor and the CI short-circuit and is returned as-is.
 */
export function computeE2eWorkerCount(options: ComputeE2eWorkerCountOptions): number {
  const { platform, totalMemGB, freeMemGB, cpuCores, isCI, explicitOverride } = options;

  if (explicitOverride) {
    const parsed = parseInt(explicitOverride, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (isCI) {
    return 4;
  }

  const memoryBasedLimit =
    platform === 'darwin'
      ? Math.floor((totalMemGB * DARWIN_USABLE_MEM_FRACTION - RESERVE_GB) / MEM_PER_WORKER_GB)
      : Math.floor((freeMemGB - RESERVE_GB) / MEM_PER_WORKER_GB);

  const safeCpuCores = Math.max(1, Math.floor(cpuCores));

  return Math.max(1, Math.min(memoryBasedLimit, safeCpuCores));
}
