import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Vitest 4 defaults `coverage.include` to "files actually imported during
      // the run" — without an explicit include, a future shared/src file with
      // real logic that no test happens to import would silently sit outside
      // the coverage denominator entirely, so the reported percentage could
      // stay at 100% while genuinely untested code exists. Naming the glob
      // makes every source file count, tested or not.
      include: ['src/**/*.ts'],
      // TRO-229 correction (see below): api.ts/auth.ts/user.ts/workspace.ts are
      // verified, individually, to contain only `interface` declarations — zero
      // runtime statements, nothing for v8 to instrument. Excluded explicitly
      // rather than left to auto-discovery, so their genuine absence of logic
      // doesn't drag the denominator down for files that DO have something to
      // cover. The two barrel files (index.ts, types/index.ts) are NOT excluded
      // — `export * from './x.js'` is a real, executable statement, and
      // index.test.ts now exercises both.
      exclude: [
        'node_modules',
        'dist',
        'src/**/*.test.ts',
        'src/types/api.ts',
        'src/types/auth.ts',
        'src/types/user.ts',
        'src/types/workspace.ts',
      ],
      // Vitest 4 defaults this to false, so a failing test run produces no
      // coverage-summary.json at all — CI's always-run summary/artifact steps
      // would then silently have nothing to read on a red run.
      reportOnFailure: true,
      // CORRECTION (CodeRabbit, PR #92): this comment originally claimed 100%
      // coverage and set the floor at 95, measured WITHOUT an explicit
      // `coverage.include`. Vitest 4 defaults `include` to "files actually
      // imported during the run", so the four pure-interface files above, plus
      // both barrel index.ts files, were never in the denominator at all —
      // "100%" only ever meant "100% of the 2 files a test happened to
      // import," not 100% of the package.
      //
      // With `include` naming every source file and `src/index.test.ts` added
      // to exercise both barrels (real, executable `export * from` statements,
      // not type declarations — asserting on the values/functions they
      // re-export, not just that the module loaded), re-measured coverage is
      // genuinely 100% (21/21 tests, all included files at 100%). Floor set to
      // 95, not 100, for the same reason as the original comment: a future
      // genuinely-untestable addition (another type-only file — add it to
      // `exclude` above, verified, not assumed, the way the four here were)
      // shouldn't need a config change just to land. Raise or lower
      // deliberately as real logic is added to shared/src; do not lower it to
      // make a failing PR pass.
      thresholds: {
        statements: 95,
      },
    },
  },
})
