#!/usr/bin/env node
/**
 * Bundle measurement for BUN-1..BUN-6 (TRO-197..TRO-202).
 *
 * Two numbers, because one of them can be gamed and the other cannot:
 *
 *  1. `initial` — assets referenced directly by dist/index.html (module
 *     scripts, modulepreload, stylesheets). This is the audit's
 *     `initialGzipKb`. Code splitting moves bytes out of it by construction,
 *     so on its own it flatters any lazy-loading change.
 *
 *  2. `route` — for a named route, the transitive closure over *static*
 *     imports of the entry chunk plus that route's chunk. This is what the
 *     browser actually downloads to render that route, and it does not drop
 *     just because a module moved into a different file. Judge the fix on
 *     this.
 *
 * The closure is computed by reading the emitted chunks and following literal
 * `from"./x.js"` / `import"./x.js"` specifiers. Dynamic `import("./x.js")` is
 * deliberately NOT followed — that is the split boundary.
 *
 * kB = 1000 bytes. gzip level 9 (matches audit/AUDIT_REPORT.md methodology).
 *
 * Usage: node audit/bundle/measure.mjs <dist-dir> [label]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { gzipSync } from 'zlib';

const distDir = process.argv[2] || 'web/dist';
const label = process.argv[3] || distDir;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = walk(distDir);
const gzCache = new Map();
const gz = (path) => {
  if (!gzCache.has(path)) gzCache.set(path, gzipSync(readFileSync(path), { level: 9 }).length);
  return gzCache.get(path);
};
const rawOf = (path) => statSync(path).size;
const kb = (n) => +(n / 1000).toFixed(2);

const html = readFileSync(join(distDir, 'index.html'), 'utf8');

// --- 1. assets referenced directly from index.html ---------------------------
const htmlRefs = new Set();
for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) htmlRefs.add(m[1]);
for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) htmlRefs.add(m[1]);
for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) {
  if (!m[1].startsWith('http')) htmlRefs.add(m[1]);
}

const toPath = (ref) => join(distDir, ref.replace(/^\//, ''));
const initialFiles = [...htmlRefs].map(toPath).filter(existsSync);

// --- 2. static-import closure ------------------------------------------------
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*"(\.\/[^"]+\.js)"/g;

function staticDeps(file) {
  const src = readFileSync(file, 'utf8');
  const deps = new Set();
  for (const m of src.matchAll(STATIC_IMPORT)) deps.add(join(dirname(file), m[1]));
  return [...deps].filter(existsSync);
}

function closure(entryFiles) {
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith('.js')) queue.push(...staticDeps(f));
  }
  return [...seen];
}

const entryJs = initialFiles.filter((f) => f.endsWith('.js'));
const entryCss = initialFiles.filter((f) => f.endsWith('.css'));

/** Find the emitted chunk for a source module by filename stem. */
function chunkFor(stem) {
  const hit = files.find((f) => new RegExp(`/${stem}-[A-Za-z0-9_-]+\\.js$`).test(f));
  return hit ? [hit] : [];
}

/**
 * A route's real payload: the entry closure, the stylesheet(s), and the
 * closure of every chunk the route needs. Named chunks are resolved by stem;
 * a stem that no longer exists (because the module was inlined into another
 * chunk) contributes nothing and is reported so the number is not silently
 * wrong.
 */
function routePayload(name, stems) {
  const resolved = [];
  const missing = [];
  for (const s of stems) {
    const c = chunkFor(s);
    if (c.length) resolved.push(...c);
    else missing.push(s);
  }
  const set = closure([...entryJs, ...resolved]);
  const all = [...new Set([...set, ...entryCss])];
  return {
    route: name,
    stems,
    missingStems: missing,
    files: all.length,
    rawKb: kb(all.reduce((n, f) => n + rawOf(f), 0)),
    gzipKb: kb(all.reduce((n, f) => n + gz(f), 0)),
  };
}

// Representative routes. `/login` is entry-only (LoginPage stays static).
const routes = [
  routePayload('/login  (unauthenticated first paint)', []),
  routePayload('/docs   (4-panel layout + document list)', ['App', 'Documents']),
  routePayload('/documents/:id  (layout + editor)', ['App', 'UnifiedDocumentPage']),
];

// --- 3. totals ---------------------------------------------------------------
const jsFiles = files.filter((f) => f.endsWith('.js'));
const cssFiles = files.filter((f) => f.endsWith('.css'));

const out = {
  label,
  initialRawKb: kb(initialFiles.reduce((n, f) => n + rawOf(f), 0)),
  initialGzipKb: kb(initialFiles.reduce((n, f) => n + gz(f), 0)),
  initialAssets: initialFiles.length,
  routes,
  jsChunkCount: jsFiles.length,
  cssFileCount: cssFiles.length,
  fileCount: files.length,
  totalRawKb: kb(files.reduce((n, f) => n + rawOf(f), 0)),
  totalGzipKb: kb(files.reduce((n, f) => n + gz(f), 0)),
  chunks: jsFiles
    .map((f) => ({ file: relative(distDir, f), raw: rawOf(f), gzip: gz(f) }))
    .sort((a, b) => b.gzip - a.gzip),
};

console.log(`\n=== ${label} ===`);
console.log(`index.html initial payload: ${out.initialRawKb} kB raw / ${out.initialGzipKb} kB gzip  [${out.initialAssets} assets]`);
for (const f of initialFiles) console.log(`   ${basename(f).padEnd(40)} ${String(kb(rawOf(f))).padStart(10)} kB raw ${String(kb(gz(f))).padStart(9)} kB gzip`);
console.log(`\nreal per-route payload (static-import closure, gzip):`);
for (const r of routes) {
  const miss = r.missingStems.length ? `  [stems not emitted as own chunk: ${r.missingStems.join(', ')}]` : '';
  console.log(`   ${r.route.padEnd(44)} ${String(r.gzipKb).padStart(8)} kB gzip  (${r.rawKb} kB raw, ${r.files} files)${miss}`);
}
console.log(`\njs chunks emitted: ${out.jsChunkCount}   css: ${out.cssFileCount}   all files: ${out.fileCount}`);
console.log(`total dist: ${out.totalRawKb} kB raw / ${out.totalGzipKb} kB gzip`);
console.log(`\ntop 12 js chunks by gzip:`);
for (const c of out.chunks.slice(0, 12)) {
  console.log(`   ${c.file.padEnd(48)} ${String(kb(c.raw)).padStart(10)} kB raw ${String(kb(c.gzip)).padStart(9)} kB gzip`);
}
console.log('\nJSON ' + JSON.stringify({ ...out, chunks: out.chunks.slice(0, 25) }));
