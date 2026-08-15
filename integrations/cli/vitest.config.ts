import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The live-server test (src/__tests__/login.liveServer.test.ts) spawns a
    // real `tsx api/src/index.ts` process and waits for it to report ready,
    // then drives a real RFC 8628 poll loop against it — bounded but
    // genuinely slower than this package's other, fully-mocked tests. Same
    // headroom sdk/vitest.config.ts gives its own liveServer suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
      reportOnFailure: true,
    },
  },
})
