import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        svgoConfig: {
          plugins: [
            {
              name: 'preset-default',
              params: {
                overrides: {
                  removeViewBox: false,
                },
              },
            },
            {
              name: 'convertColors',
              params: {
                currentColor: true,
              },
            },
          ],
        },
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // TRO-244: same provider/shape as api/vitest.config.ts so `test:coverage`
    // reports consistently across packages in CI.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: ['node_modules', 'dist', 'src/test/**'],
      // Measured statement coverage on 2026-07-31 was 22.27%. Floor set ~2
      // points below that for the same reason as api/vitest.config.ts: catch
      // a silent regression without pretending this is a target coverage
      // level. Raise deliberately as real coverage grows.
      thresholds: {
        statements: 20,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
