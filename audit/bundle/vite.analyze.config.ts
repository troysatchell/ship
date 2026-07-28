/**
 * ShipShape bundle-audit analyzer config (measurement scaffolding — NOT app source).
 *
 * Mirrors web/vite.config.ts's build-relevant options exactly (plugins: react + svgr with the
 * same svgrOptions; resolve.alias '@' -> web/src) and adds rollup-plugin-visualizer. Server /
 * preview blocks are omitted because they do not affect `vite build` output.
 *
 * Run from the repo root:
 *   VITE_API_URL= ./web/node_modules/.bin/vite build \
 *     --config audit/bundle/vite.analyze.config.ts \
 *     --root web \
 *     --outDir <scratch>/dist-analyze --emptyOutDir
 *
 * Verify fidelity by diffing the emitted chunk list + byte sizes against web/dist (they match).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
// Deep ESM path: this config lives outside web/, so bare-specifier resolution lands on the
// hoisted copy whose exports map has no CJS entry (vite bundles configs to CJS). The deep
// import sidesteps that. Package: rollup-plugin-visualizer@7.0.1 in web/node_modules.
import { visualizer } from '../../web/node_modules/rollup-plugin-visualizer/dist/plugin/index.js';
import { resolve } from 'path';

const webRoot = resolve(__dirname, '../../web');
const outDir = process.env.AUDIT_STATS_DIR ?? resolve(__dirname);

export default defineConfig({
  root: webRoot,
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        svgoConfig: {
          plugins: [
            {
              name: 'preset-default',
              params: { overrides: { removeViewBox: false } },
            },
            { name: 'convertColors', params: { currentColor: true } },
          ],
        },
      },
    }),
    visualizer({
      filename: resolve(outDir, 'stats.html'),
      template: 'treemap',
      gzipSize: true,
      brotliSize: false,
      sourcemap: false,
    }),
    visualizer({
      filename: resolve(outDir, 'stats.json'),
      template: 'raw-data',
      gzipSize: true,
      brotliSize: false,
      sourcemap: false,
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(webRoot, './src'),
    },
  },
});
