#!/usr/bin/env node
// Bundles src/index.ts into one self-contained dist/server.js — express,
// @slack/web-api, zod, and @ship/sdk's verifyWebhook all inlined. This is
// what keeps this package's package.json `dependencies` down to just
// `@ship/sdk` (scripts/check-integration-deps.mjs, PF-003/TRO-399): every
// other package this source imports is a *build-time* dependency (bundled
// in), not a runtime one resolved from node_modules — `node dist/server.js`
// needs nothing installed at deploy time.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Node builtins (fs, path, node:crypto, ...) stay external automatically
  // under platform:'node' — nothing else needs to.
});

console.log('Built dist/server.js');
