import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: ['node_modules', 'dist'],
      // TRO-229 (TEST-7 scope correction): shared/src is 8 files, 6 of which are
      // pure `interface`/`type` declarations or re-export barrels (types/api.ts,
      // types/auth.ts, types/user.ts, types/workspace.ts, types/index.ts,
      // index.ts) — those compile to zero runtime statements, so there is
      // nothing in them for v8 to instrument. The two files with real logic are
      // constants.ts (computed session-timeout constants) and
      // types/document.ts (computeICEScore + the DEFAULT_PROJECT_PROPERTIES
      // constant), both fully covered by the tests added in this ticket.
      // Measured statement coverage on 2026-07-31 was 100% (every executable
      // statement in the package is exercised) — floor set to 95%, not 100%,
      // so a future genuinely-untestable addition (another type-only file)
      // doesn't need a config change just to land. Raise or lower deliberately
      // as real logic is added to shared/src; do not lower it to make a
      // failing PR pass.
      thresholds: {
        statements: 95,
      },
    },
  },
})
