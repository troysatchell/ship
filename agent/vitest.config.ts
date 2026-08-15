import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    // PF-702 (TRO-428): two files now do real writes against the shared
    // worktree Postgres database with no per-file isolation —
    // `gateWriteBoundary.dbRoundTrip.test.ts` (pre-existing, "THE ONE
    // deliberate cross-package import" in this package until this ticket)
    // and the new `shipClientParity.liveServer.test.ts`. The former asserts
    // a GLOBAL, workspace-unscoped `SELECT COUNT(*) FROM documents`
    // before/after a proactive run to prove "writes nothing" — vitest's
    // default file parallelism let the latter's `beforeAll` seed rows
    // concurrently inside that exact window, so the count moved for a
    // reason that had nothing to do with a real regression (observed: 8 vs
    // 2, a flake, not a bug — same root cause `api/vitest.config.ts`'s own
    // `fileParallelism: false` was already set for, mirrored here). Any
    // future file that touches this same shared DB state needs to keep this
    // true, or scope its own assertions to a workspace_id the way most
    // other DB-touching tests already do.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', 'src/**/*.test.ts', 'src/scripts/**'],
      reportOnFailure: true,
    },
  },
})
