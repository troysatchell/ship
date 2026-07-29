import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// Read API port from environment or .ports file (created by scripts/dev.sh)
function getApiPort(): number {
  // Check for explicit API_PORT env var first (used by testcontainers)
  if (process.env.API_PORT) {
    return parseInt(process.env.API_PORT, 10);
  }

  const portsFile = resolve(__dirname, '../.ports');
  if (existsSync(portsFile)) {
    const content = readFileSync(portsFile, 'utf-8');
    const match = content.match(/^API=(\d+)/m);
    if (match) return parseInt(match[1], 10);
  }
  // Fallback to default
  return 3000;
}

/**
 * Vendor chunking (BUN-6 / TRO-202).
 *
 * This does NOT reduce total bytes. It changes *which* bytes a returning user
 * has to re-download after a routine deploy. Before this, one chunk held all
 * application code and all third-party code, so editing a single page gave the
 * whole ~588 kB gzip a new content hash and invalidated it for every user.
 *
 * Three rules govern the groups below:
 *
 *  1. Group by release cadence, not by size. React and TanStack Query change
 *     on their own upgrade schedule, which is roughly never compared to
 *     `web/src`. That is what makes them worth a stable chunk.
 *
 *  2. **Never merge a lazily-reachable package into an eagerly-reachable
 *     chunk.** A manual chunk is loaded as soon as *anything* in it is
 *     statically reachable from the entry. Sweeping the editor stack or
 *     emoji-picker-react into a catch-all `vendor` alongside, say, `clsx`
 *     would silently undo BUN-2 and BUN-4 — the split would still exist on
 *     disk while the bytes came back to the initial payload. Hence the
 *     dedicated `vendor-editor`, `vendor-highlight` and `vendor-emoji` groups,
 *     and hence `audit/bundle/measure.mjs` reports per-route closures rather
 *     than trusting the chunk list.
 *
 *  3. Only group a package that *every* route needs. Radix, cmdk and dnd-kit
 *     were tried as a `vendor-ui` group and measured: it cost 15.0 kB gzip on
 *     /docs and /documents/:id, because a route that needs one primitive then
 *     downloads all of them. Rollup's default placement splits those better
 *     than a hand-written rule does, so they are deliberately left alone.
 */
function manualChunks(id: string): string | undefined {
  // Rollup's CommonJS interop helpers (`getDefaultExportFromCjs`) are a virtual
  // module every chunk needs. Left unassigned, Rollup folds them into whichever
  // manual chunk happens to claim them first — in this app that was
  // `vendor-highlight`, which then became a static dependency of the entry and
  // silently dragged 22.6 kB gzip of syntax grammars back into first paint.
  // Pinning them to the always-eager react chunk costs ~200 bytes and removes
  // the failure mode.
  if (id.includes('commonjsHelpers')) return 'vendor-react';

  if (!id.includes('node_modules')) return undefined;

  // Reached only through the dynamic import of components/Editor (BUN-2).
  if (/node_modules\/(@tiptap|prosemirror-[^/]+|yjs|y-protocols|y-prosemirror|y-websocket|y-indexeddb|lib0|linkifyjs|tippy\.js|@popperjs)\//.test(id)) {
    return 'vendor-editor';
  }
  // Reached only through vendor-editor's code-block extension (BUN-3).
  if (/node_modules\/(highlight\.js|lowlight)\//.test(id)) return 'vendor-highlight';
  // Reached only through the emoji popover's dynamic import (BUN-4).
  if (/node_modules\/emoji-picker-react\//.test(id)) return 'vendor-emoji';

  // Eagerly reachable, and stable across app deploys.
  if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) {
    return 'vendor-react';
  }
  if (/node_modules\/@tanstack\//.test(id)) return 'vendor-query';

  // Everything else keeps Rollup's default placement. A catch-all `vendor`
  // here would violate rule 2 above for any package that is only ever
  // dynamically imported.
  return undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiPort = getApiPort();

  // Proxy configuration shared between dev and preview servers
  const proxyConfig = {
    '/api': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
    },
    '/collaboration': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
      ws: true,
    },
    '/events': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    plugins: [
      react(),
      svgr({
        // Allow importing SVGs as React components with ?react suffix
        // e.g., import CheckIcon from '@uswds/uswds/dist/img/usa-icons/check.svg?react'
        svgrOptions: {
          // Use currentColor for fill to match existing icon patterns
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
              // Replace hardcoded colors with currentColor
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
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        output: { manualChunks },
      },
    },
    server: {
      port: parseInt(env.VITE_PORT || '5173'),
      strictPort: true,
      proxy: proxyConfig,
    },
    // Preview server config - used by `vite preview` for E2E tests
    // This is MUCH lighter weight than the dev server (no HMR, no watchers)
    preview: {
      port: parseInt(env.VITE_PORT || '4173'),
      strictPort: true,
      proxy: proxyConfig,
    },
  };
});
