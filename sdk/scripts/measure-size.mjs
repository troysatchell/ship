#!/usr/bin/env node
/**
 * measure-size.mjs — PF-405 (Linear TRO-422) size gate: the built
 * `@ship/sdk` bundle, minified + gzipped, must be under 250 KB.
 *
 * WHY A REAL BUNDLE, NOT A SUM OF sdk/dist/**: `sdk/package.json`'s own
 * `build` script (`tsc`) emits one unminified `.js` file per source module —
 * useful for a tree-shaking consumer, but summing those files' raw sizes
 * would not answer "what does min+gz actually measure," and skipping
 * minification would silently understate the real number a bundler-using
 * consumer sees. So this script does what a consumer's own bundler would:
 * bundles the package's public entry point (`src/index.ts`) into ONE file,
 * minifies it, and gzips that. `esbuild` (already resolvable in this repo's
 * lockfile as a transitive dependency of vite/tsx — verified via `pnpm why
 * esbuild` before adding it here — so this adds no new supply-chain
 * surface, just a direct devDependency declaration) does the bundling;
 * `bundle: true` with zero runtime `dependencies` (sdk/package.json) means
 * there is nothing external to externalize — the whole package is the
 * bundle.
 *
 * kB = 1000 bytes, gzip level 9 — same convention `audit/bundle/measure.mjs`
 * documents and uses for the web bundle, kept consistent here rather than
 * inventing a second one.
 *
 * Usage:
 *   node scripts/measure-size.mjs                     # real gate: fails if > 250 KB gzip
 *   node scripts/measure-size.mjs --threshold-kb 1     # TEST-ONLY override, for proving the
 *                                                       # gate actually fails on bloat (PF-405's
 *                                                       # own AC) — never use this to raise the
 *                                                       # real 250 KB bar; see CHANGES.md/PR body.
 *
 * Exit 0 = under threshold. Exit 1 = at or over threshold. Exit 2 = could
 * not build/measure at all (distinct from "measured and failed").
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = join(__dirname, '..');
const ENTRY = join(SDK_ROOT, 'src', 'index.ts');

export const DEFAULT_THRESHOLD_KB = 250;
const KB = 1000; // decimal kB, matching audit/bundle/measure.mjs's documented convention

/**
 * Pure pass/fail decision — PF-405's AC ("prove both gates catch real
 * drift/bloat, then revert") is exercised against THIS function in
 * `src/__tests__/sizeGate.test.ts` via a test-only threshold, without
 * needing to actually inflate a real bundle for the permanent regression
 * test. The real `main()` below calls this with the real, measured gzip
 * size and the real 250 KB threshold.
 */
export function checkSize(gzipBytes, thresholdKb = DEFAULT_THRESHOLD_KB) {
  const gzipKb = gzipBytes / KB;
  const thresholdBytes = thresholdKb * KB;
  return {
    pass: gzipBytes < thresholdBytes,
    gzipBytes,
    gzipKb: +gzipKb.toFixed(2),
    thresholdKb,
  };
}

/**
 * Bundles `src/index.ts` (esbuild, minified, ESM, zero externals — this
 * package has zero runtime `dependencies` to externalize) and gzips the
 * result. Returns byte counts for both the minified-only and minified+gzip
 * artifacts, so a report can show the gzip win, not just the final number.
 */
export async function buildAndMeasure() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'esm',
    // 'node', not 'neutral': `tokenStore.ts`'s `FileTokenStore` (`fs`/`path`)
    // and `verifyWebhook.ts` (`node:crypto`) are real, deliberate Node
    // built-in imports (PF-403/PF-404) — this package's own README-level
    // shape spans both a Node CLI/server context and a browser PKCE-flow
    // context (client.ts's header), but the browser-only entry points
    // (deviceLogin/authorizationCodeFlow/ShipClient's fetch-based core)
    // never reach those two files, so a real per-target bundler (this
    // package has no bundler of its own — that decision belongs to the
    // consumer) would resolve them from the platform, not bundle them.
    // `platform: 'node'` marks Node built-ins external automatically,
    // matching what a Node consumer's own bundler does; engines.node in
    // package.json is >=18, hence target node18.
    platform: 'node',
    target: 'node18',
    write: false,
    absWorkingDir: SDK_ROOT,
    logLevel: 'silent',
  });

  const [outputFile] = result.outputFiles;
  if (!outputFile) {
    throw new Error('esbuild produced no output file for src/index.ts — cannot measure size.');
  }

  const minifiedBytes = outputFile.contents.byteLength;
  const gzipBytes = gzipSync(outputFile.contents, { level: 9 }).length;

  return { minifiedBytes, gzipBytes };
}

// --- CLI entry point --------------------------------------------------
// Guarded so a companion test can import checkSize/buildAndMeasure without
// triggering a build/process.exit as a side effect of import (same
// convention as scripts/check-integration-deps.mjs).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const thresholdFlagIndex = argv.indexOf('--threshold-kb');
  const thresholdKb =
    thresholdFlagIndex !== -1 && argv[thresholdFlagIndex + 1]
      ? Number(argv[thresholdFlagIndex + 1])
      : DEFAULT_THRESHOLD_KB;

  if (!Number.isFinite(thresholdKb) || thresholdKb <= 0) {
    console.error(`measure-size: invalid --threshold-kb value: ${argv[thresholdFlagIndex + 1]}`);
    process.exit(2);
  }

  let measured;
  try {
    measured = await buildAndMeasure();
  } catch (err) {
    console.error(`measure-size: build failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const { minifiedBytes, gzipBytes } = measured;
  const { pass, gzipKb } = checkSize(gzipBytes, thresholdKb);
  const minKb = +(minifiedBytes / KB).toFixed(2);

  console.log(`\n@ship/sdk size gate (PF-405, TRO-422)`);
  console.log(`  entry:      src/index.ts (bundled, minified, ESM, zero externals)`);
  console.log(`  minified:   ${minKb} kB`);
  console.log(`  min+gzip:   ${gzipKb} kB  (gzip level 9)`);
  console.log(`  threshold:  ${thresholdKb} kB min+gz${thresholdKb !== DEFAULT_THRESHOLD_KB ? '  [TEST-ONLY OVERRIDE — not the real 250 KB gate]' : ''}`);
  console.log(
    'JSON ' +
      JSON.stringify({ minifiedBytes, gzipBytes, minKb, gzipKb, thresholdKb, pass })
  );

  if (pass) {
    console.log(`\nPASS — ${gzipKb} kB < ${thresholdKb} kB.\n`);
    process.exit(0);
  } else {
    console.error(`\nFAIL — ${gzipKb} kB >= ${thresholdKb} kB threshold.\n`);
    process.exit(1);
  }
}
