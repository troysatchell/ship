/**
 * Playwright Configuration
 *
 * Uses testcontainers for per-worker isolation:
 * - Each worker gets its own PostgreSQL container
 * - Each worker gets its own API server on a dynamic port
 * - Each worker gets its own Vite preview server on a dynamic port
 *
 * MEMORY SAFETY:
 * - Each worker uses ~300-500MB (Postgres + API + Preview + Browser)
 * - Default is 4 workers locally = ~2GB (safe for most machines)
 * - Set PLAYWRIGHT_WORKERS env var to override
 * - If system has <4GB free RAM, reduce workers or close other apps
 *
 * HISTORY: Using 8 workers with vite dev (instead of preview) caused
 * a 90GB memory explosion and system crash. We now use vite preview
 * (lightweight static server) instead of vite dev (heavy HMR server).
 */

import { defineConfig, devices } from '@playwright/test';
import os from 'os';
import { computeE2eWorkerCount } from './web/src/lib/computeE2eWorkerCount';

// Calculate safe worker count based on available memory.
//
// TRO-232 / audit finding TEST-10: the actual calculation lives in
// `web/src/lib/computeE2eWorkerCount.ts` as a pure, testable function — this file
// just gathers the real `os`/`process.env` inputs and hands them over. It used to be
// inlined here as `os.freemem()`-based math, which is sound on Linux/CI but wrong on
// macOS: macOS deliberately keeps reported free memory near zero (spare RAM goes to
// filesystem cache and memory compression instead), so `os.freemem()` is not a
// meaningful "available memory" signal there. On a 24GB/14-core Mac this collapsed
// every local run to a single worker (~4x slower) with no warning. See
// `computeE2eWorkerCount.ts`'s header comment and its test file for the fix and the
// regression coverage; this bug never affected CI (the `isCI` branch below is
// unchanged from before, and still returns 4 immediately when no valid
// `PLAYWRIGHT_WORKERS` override is set — override handling runs first and wins).
function getWorkerCount(): number {
  return computeE2eWorkerCount({
    platform: os.platform(),
    totalMemGB: os.totalmem() / (1024 * 1024 * 1024),
    freeMemGB: os.freemem() / (1024 * 1024 * 1024),
    cpuCores: os.cpus().length,
    isCI: !!process.env.CI,
    explicitOverride: process.env.PLAYWRIGHT_WORKERS,
  });
}

// Calculate workers (logging happens in global-setup to avoid per-worker noise)
const calculatedWorkers = getWorkerCount();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 1 retry locally for flaky WebSocket/timing tests.
  //
  // TRO-225 / audit finding TEST-3: these retries are currently *masking* real
  // failures, not absorbing noise. Across three identical 869-test runs, counting
  // first attempts only, 8 / 5 / 3 tests failed; after retries the runner reported
  // 1 / 0 / 1. `my-week-stale-data.spec.ts › retro edits ...` failed or timed out
  // on the first attempt in all three runs and was reported as passing all three
  // times. Flake list: `audit/test-quality/runs/e2e-flake-union.txt`.
  //
  // Deliberately NOT changed on the TRO-225 branch. That branch fixed one of the
  // eleven (the my-week retro test — a cross-test database dependency, see that
  // spec's header); flipping the switch with ten root causes outstanding would turn
  // a misleadingly-green suite into a permanently-red one, which gets ignored just
  // as fast. The honest end state is `failOnFlakyTests: true` (Playwright >= 1.49,
  // or `--fail-on-flaky-tests`), which keeps the retry's trace artifact while
  // refusing to report a retry-rescued test as a pass. Turn it on with the last
  // flake fix, not the first.
  retries: process.env.CI ? 2 : 1,
  workers: calculatedWorkers,
  // Reporters:
  // - 'line' shows real-time progress: [1/641] ✓ auth.spec.ts:15 (2.3s)
  // - 'html' generates detailed report at end
  // - './e2e/progress-reporter.ts' writes JSONL for live monitoring
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['./e2e/progress-reporter.ts']]
    : [['line'], ['html', { open: 'never' }], ['./e2e/progress-reporter.ts']],
  use: {
    // baseURL is provided by the isolated-env fixture
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Longer timeout for container startup
  timeout: 60000,
  // Global setup builds API and Web once before all workers
  globalSetup: './e2e/global-setup.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // NO webServer - the fixture handles server startup per worker
});
