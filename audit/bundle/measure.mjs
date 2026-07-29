#!/usr/bin/env node
/**
 * Bundle measurement for BUN-1..BUN-6 (TRO-197..TRO-202).
 *
 * WHY THIS EXISTS AT ALL
 *
 * The audit's headline metric, `initialGzipKb`, is the set of assets
 * `dist/index.html` references. Code splitting improves that number *by
 * construction* — moving a module into a lazy chunk always reduces it, whether
 * or not any user is better off. Scoring a splitting change on it flatters the
 * change. So this tool reports a second, harder number: for a given route, the
 * transitive closure over **static** imports of the entry plus that route's
 * chunk. That is what the browser must have in hand to render the route, and it
 * does not shrink just because a module moved to a different file.
 *
 * HOW IT READS THE GRAPH, AND WHY THAT WAS WRONG ONCE
 *
 * The first version walked `import "./x.js"` specifiers out of the emitted
 * chunks. That walk is blind to stylesheets, so CSS belonging to a lazy chunk
 * was invisible and **every route measured smaller than it really is**
 * (CodeRabbit finding 1 on PR #14). In this app that hid
 * `assets/vendor-editor-*.css` — the editor's Tippy styles, split out of the
 * single stylesheet by the very change being measured.
 *
 * It now reads `dist/.vite/manifest.json` (`build.manifest: true` in
 * web/vite.config.ts) and follows `imports` while collecting `css` at every
 * node. That is the same graph Vite itself uses to decide which modulepreload
 * and stylesheet links a chunk needs, so the measurement cannot disagree with
 * what the browser fetches. `dynamicImports` are deliberately NOT followed —
 * they are the split boundary.
 *
 * kB = 1000 bytes. gzip level 9 (matches audit/AUDIT_REPORT.md methodology).
 *
 * Usage, from the repository root:
 *   node audit/bundle/measure.mjs <dist> [label]
 *   node audit/bundle/measure.mjs <dist> [label] --baseline <previous-dist>
 *
 * With --baseline, also reports deploy churn: the bytes a returning user with a
 * warm cache must re-download on each route, i.e. the closure members whose
 * content hash changed. That is the metric BUN-6 exists to move.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { gzipSync } from 'zlib';

const args = process.argv.slice(2);
const baselineFlag = args.indexOf('--baseline');
const baselineDist = baselineFlag === -1 ? null : args[baselineFlag + 1];
const positional = baselineFlag === -1 ? args : args.slice(0, baselineFlag);
const distDir = positional[0] || 'web/dist';
const label = positional[1] || distDir;

const gzCache = new Map();
const gz = (p) => {
  if (!gzCache.has(p)) gzCache.set(p, gzipSync(readFileSync(p), { level: 9 }).length);
  return gzCache.get(p);
};
const raw = (p) => statSync(p).size;
const kb = (n) => +(n / 1000).toFixed(2);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, acc);
    else acc.push(f);
  }
  return acc;
}

const MANIFEST = '.vite/manifest.json';

function loadManifest(dist) {
  const p = join(dist, MANIFEST);
  if (!existsSync(p)) {
    console.error(
      `\n${p} not found.\n` +
        `This tool measures from Vite's manifest so CSS attached to lazy chunks is counted.\n` +
        `web/vite.config.ts sets build.manifest: true. For a tree that predates that setting:\n` +
        `  cd web && VITE_API_URL= pnpm exec vite build --manifest\n`
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

const manifest = loadManifest(distDir);
const ENTRY_KEY = Object.keys(manifest).find((k) => manifest[k].isEntry) ?? 'index.html';

/**
 * Resolve a route target to a manifest key.
 *
 * A page is normally keyed by its source path, but a chunk that ends up shared
 * loses its `src` and is keyed by its emitted filename instead
 * (`_UnifiedDocumentPage-<hash>.js`), so both shapes have to be handled or the
 * route silently measures short.
 *
 * Returns null when the module is not a chunk of its own — which is exactly the
 * pre-split case: before BUN-1 every page lived inside the single entry chunk,
 * so the route's payload simply *is* the entry closure. That must degrade to a
 * correct number with a visible note, not throw (which would block measuring
 * the baseline) and not silently drop bytes.
 */
function resolveKey(target) {
  if (manifest[target]) return target;
  const stem = basename(target).replace(/\.[jt]sx?$/, '');
  const byKey = new RegExp(`(^|/)_?${stem}-[A-Za-z0-9_-]+\\.js$`);
  const byFile = new RegExp(`(^|/)${stem}-[A-Za-z0-9_-]+\\.js$`);
  return (
    Object.keys(manifest).find((k) => byKey.test(k) || byFile.test(manifest[k].file ?? '')) ?? null
  );
}

/** Files (js + css) reachable from `keys` through static imports only. */
function closure(keys) {
  const seen = new Set();
  const files = new Set();
  const queue = [...keys];
  while (queue.length) {
    const k = queue.pop();
    if (seen.has(k) || !manifest[k]) continue;
    seen.add(k);
    const node = manifest[k];
    if (node.file) files.add(node.file);
    for (const c of node.css ?? []) files.add(c);
    for (const imp of node.imports ?? []) queue.push(imp);
    // node.dynamicImports is intentionally not followed: that is the boundary.
  }
  return [...files].map((f) => join(distDir, f)).filter(existsSync);
}

function size(files) {
  return {
    files: files.length,
    rawKb: kb(files.reduce((n, f) => n + raw(f), 0)),
    gzipKb: kb(files.reduce((n, f) => n + gz(f), 0)),
    cssGzipKb: kb(files.filter((f) => f.endsWith('.css')).reduce((n, f) => n + gz(f), 0)),
  };
}

// `/login` is entry-only: LoginPage is deliberately static (see main.tsx).
const ROUTES = [
  { route: '/login  (unauthenticated first paint)', targets: [] },
  {
    route: '/docs   (4-panel layout + document list)',
    targets: ['src/pages/App.tsx', 'src/pages/Documents.tsx'],
  },
  {
    route: '/documents/:id  (layout + editor shell)',
    targets: ['src/pages/App.tsx', 'src/pages/UnifiedDocumentPage.tsx'],
  },
];

const initialFiles = closure([ENTRY_KEY]);
const routes = ROUTES.map(({ route, targets }) => {
  const resolved = targets.map((t) => [t, resolveKey(t)]);
  const inEntryChunk = resolved.filter(([, k]) => k === null).map(([t]) => t);
  const keys = resolved.map(([, k]) => k).filter(Boolean);
  const files = closure([ENTRY_KEY, ...keys]);
  return { route, ...size(files), inEntryChunk, _files: files };
});

const all = walk(distDir).filter((f) => !f.includes('/.vite/'));
const jsCount = all.filter((f) => f.endsWith('.js')).length;
const cssCount = all.filter((f) => f.endsWith('.css')).length;

console.log(`\n=== ${label} ===`);
const init = size(initialFiles);
console.log(
  `initial payload (entry closure): ${init.rawKb} kB raw / ${init.gzipKb} kB gzip  ` +
    `[${init.files} assets, CSS ${init.cssGzipKb} kB gzip]`
);
for (const f of initialFiles) {
  console.log(
    `   ${basename(f).padEnd(40)} ${String(kb(raw(f))).padStart(10)} kB raw ${String(kb(gz(f))).padStart(9)} kB gzip`
  );
}

console.log(`\nreal per-route payload (static-import closure incl. CSS, gzip):`);
for (const r of routes) {
  const note = r.inEntryChunk.length
    ? `  [not split out — inside the entry chunk: ${r.inEntryChunk.map((t) => basename(t)).join(', ')}]`
    : '';
  console.log(
    `   ${r.route.padEnd(44)} ${String(r.gzipKb).padStart(8)} kB gzip  ` +
      `(${r.rawKb} kB raw, ${r.files} files, CSS ${r.cssGzipKb} kB)${note}`
  );
}

console.log(`\njs chunks emitted: ${jsCount}   css: ${cssCount}   all files: ${all.length}`);
console.log(
  `total dist (excl. ${MANIFEST}): ${kb(all.reduce((n, f) => n + raw(f), 0))} kB raw / ` +
    `${kb(all.reduce((n, f) => n + gz(f), 0))} kB gzip`
);

let churn = null;
if (baselineDist) {
  const cached = new Set(walk(baselineDist).map((f) => basename(f)));
  churn = routes.map((r) => {
    const stale = r._files.filter((f) => !cached.has(basename(f)));
    const changed = stale.reduce((n, f) => n + gz(f), 0);
    const total = r._files.reduce((n, f) => n + gz(f), 0);
    return {
      route: r.route,
      reDownloadGzipKb: kb(changed),
      routeGzipKb: kb(total),
      staleFiles: stale.length,
      totalFiles: r._files.length,
      pctOfRoute: +((changed / total) * 100).toFixed(1),
    };
  });
  console.log(`\ndeploy churn vs ${baselineDist} — bytes a warm-cache visitor re-downloads:`);
  for (const c of churn) {
    console.log(
      `   ${c.route.padEnd(44)} ${String(c.reDownloadGzipKb).padStart(8)} kB of ` +
        `${String(c.routeGzipKb).padStart(8)} kB (${c.staleFiles}/${c.totalFiles} files, ${c.pctOfRoute}%)`
    );
  }
}

const assets = all
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => ({ file: relative(distDir, f), raw: raw(f), gzip: gz(f) }))
  .sort((a, b) => b.gzip - a.gzip);
console.log(`\ntop 12 assets by gzip:`);
for (const c of assets.slice(0, 12)) {
  console.log(
    `   ${c.file.padEnd(48)} ${String(kb(c.raw)).padStart(10)} kB raw ${String(kb(c.gzip)).padStart(9)} kB gzip`
  );
}

console.log(
  '\nJSON ' +
    JSON.stringify({
      label,
      initial: init,
      routes: routes.map(({ _files, ...r }) => r),
      churn,
      jsChunkCount: jsCount,
      cssFileCount: cssCount,
      fileCount: all.length,
      totalRawKb: kb(all.reduce((n, f) => n + raw(f), 0)),
      totalGzipKb: kb(all.reduce((n, f) => n + gz(f), 0)),
      assets: assets.slice(0, 20),
    })
);
