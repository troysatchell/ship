import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially to prevent database conflicts
    // Tests within each file can still run in parallel
    fileParallelism: false,
    // TRO-277 / TEST-12 — deadlines sized for a loaded machine, not an idle one.
    //
    // These raise no assertion and skip nothing; they only stop a slow-but-correct
    // test being reported as a failure. Measured: in 20 api runs under concurrent
    // build load (load average ~29 on 14 cores), three runs failed solely with
    // `Test timed out in 5000ms` on tests that take 10-70ms unloaded — a deadline
    // roughly 80x their normal duration, so exceeding it said nothing about
    // correctness and cost the branch a gate attempt.
    testTimeout: 15_000,
    // The hook deadline matters more than it looks. When a beforeAll fails,
    // vitest reports that describe's tests as SKIPPED rather than failed, so a
    // hook that misses its deadline silently removes assertions from the run
    // instead of flagging anything. That was the source of this suite's
    // unaccounted-for skip counts.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', 'src/test/**'],
    },
  },
})
