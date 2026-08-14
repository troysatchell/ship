## Bundle Size — Compare (W6, post-platform-tickets, 2026-08-14)

Compare run against `audit/bundle/baseline.json` / `baseline.md` (2026-07-27), per PLUGFORGE.MD
§6's MVP hard gate: bundle size ≤ ±10% vs the Part 1 baseline in `audit/`.

**Commit measured:** `397e3b75a0f62111bc38e25de0378186fd1fde14` (main, clean tree, up to date
with `origin/main` at measurement time). **Baseline commit:** `076a18371da0a09f88b5329bd59611c4bc9536bb`.

## Methodology

1. `pnpm build:web` from repo root (identical command to baseline: `build:shared` then
   `tsc && VITE_API_URL= vite build` in `web/`).
2. Totals (`totalRawKb`/`totalGzipKb`/`jsRawKb`/`jsGzipKb`/`cssRawKb`/`cssGzipKb`) computed by
   walking `web/dist` for `.js`/`.css` files only (excludes fonts and `.vite/manifest.json`),
   raw size via `fs.statSync`, gzip via Node's `zlib.gzipSync(..., {level: 9})` — same filter and
   gzip level baseline.json used (verified: baseline's `jsRawKb + cssRawKb` sums to its
   `totalRawKb` exactly).
3. Initial-load payload computed by `audit/bundle/measure.mjs web/dist <label>` — walks
   `dist/.vite/manifest.json`'s static-import graph from the entry, which is the same graph Vite
   uses to decide `modulepreload` tags. Cross-checked against `web/dist/index.html`'s actual
   `<script>`/`<link rel=modulepreload>` tags: they agree exactly (entry script + `vendor-react` +
   `vendor-query` + one stylesheet, 4 files).
4. Dependency-level attribution uses the named `manualChunks` groups in `web/vite.config.ts`
   (`vendor-editor`, `vendor-highlight`, `vendor-emoji`, `vendor-react`, `vendor-query`) — this is
   **derived** from the chunking config, not a fresh treemap. Baseline's analyzer
   (`rollup-plugin-visualizer`) is no longer present in `web/node_modules` and was not reinstalled
   for this run (see Caveats).

## Deliverable table

| Metric | Baseline (2026-07-27) | Current (2026-08-14) | Delta |
|---|---|---|---|
| Total production bundle, JS+CSS (raw / gzip) | 2316.96 KB / 699.75 KB | 2163.97 KB / 645.56 KB | **-6.60% / -7.75%** |
| Initial-load bundle (raw / gzip) | 2140.21 KB / 600.75 KB | 379.80 KB / 110.85 KB | **-82.26% / -81.55%** |
| Largest chunk | `index-C2vAyoQ1.js` — 2073.70 KB / 587.93 KB gzip (the entire app, one chunk) | `vendor-editor-C6_BsdQf.js` — 577.50 KB / 185.12 KB gzip (TipTap+ProseMirror+Yjs, lazy) | -72.16% / -68.51% |
| Number of chunks (JS+CSS) | 262 (261 JS / 1 CSS) | 71 (69 JS / 2 CSS) | -72.90% |
| Top 3 largest "dependencies" | highlight.js 64.0 KB gzip · emoji-picker-react 39.1 KB gzip · prosemirror-view 30.9 KB gzip (individual npm packages inside the one entry chunk) | `vendor-editor` 185.12 KB gzip (whole editor/Yjs stack, lazy) · `vendor-emoji` 63.41 KB gzip (lazy) · `vendor-react` 59.33 KB gzip (eager, in entry) | not directly comparable — baseline measured single packages, current measures manualChunks *groups*; see Caveats |
| Unused dependencies | 1 (`@tanstack/query-sync-storage-persister`, BUN-7) | 0 — confirmed removed from `web/package.json` and no import sites | fixed |
| Code splitting in use? | Only 13 document-tab lazy chunks; 0 route-level splitting (25 pages statically imported) | Route-level: 25 `React.lazy()` page imports in `web/src/main.tsx`; editor, highlight.js, and emoji picker also behind dynamic imports; `manualChunks` vendor splitting added | fixed (BUN-1, BUN-2, BUN-3, BUN-4, BUN-6 all landed) |

**Gate verdict: PASS.** Every measured delta is a *reduction*, not an increase — the bundle is
smaller today than the 07-27 baseline on every axis, comfortably inside the ±10% MVP-gate budget.

## Important scoping caveat — read before citing this as "tonight's tickets are safe"

The improvement above is **real but not attributable to tonight's six platform tickets.** The
07-27 baseline commit is 1263 commits and 18 days behind HEAD. In that gap, the BUN-1..BUN-9
bundle-remediation tickets (TRO-197 through TRO-202, merged via PRs #14, #52, #83 and others
between roughly 07-27 and 08-05) landed and were never re-measured until this run — that is the
entire cause of the -82% initial-load reduction. This W6 compare run is the first time anyone
re-baselined bundle size since those fixes shipped.

**Isolated to tonight specifically** (commit `c1caa61`, 2026-08-13 14:13:14, the last commit
before tonight's 58-commit session, diffed against HEAD):

- `git diff --stat c1caa61..HEAD -- web/` touches exactly **3 files**: `web/src/main.tsx` (+13
  lines, registers one new route), `web/src/pages/OAuthDeviceVerify.tsx` (new file, +147 lines,
  PF-106's device-grant verify screen), and `web/vite.config.ts` (+8/-2, extends a dev/preview
  CSP middleware path list — `configureServer`/`configurePreviewServer` do not run inside
  `vite build`, so this has zero production-bundle effect).
- `OAuthDeviceVerifyPage` is registered as `React.lazy(() => import('@/pages/OAuthDeviceVerify')...)`
  — confirmed route-split, matching the BUN-1 pattern. Its emitted chunk,
  `assets/OAuthDeviceVerify-BaIljLCK.js`, is 3.31 KB raw / 1.22 KB gzip and is **not** among the 4
  files in the initial-load closure (verified against both `measure.mjs`'s manifest walk and
  `index.html`'s actual tags).
- `grep -rn "@ship/sdk" web/src` and `grep -n sdk web/package.json` both return **zero matches** —
  the new `sdk/` workspace package is not imported by `web/` at all, so it contributes 0 bytes to
  this bundle regardless of its own size.
- Net tonight-only frontend footprint: **+3.31 KB raw / +1.22 KB gzip to the total bundle
  (0.15% raw / 0.19% gzip of the current total), +0 KB to the initial-load bundle.** OAuth core,
  the public API v1 router, the OpenAPI generator, and the rate-limit exemption middleware are all
  `api/`-only changes with no `web/` footprint.

So: the MVP gate passes both as officially measured (vs the 07-27 baseline, per PLUGFORGE.MD's
own instruction to use the existing baseline file) and under the narrower "did tonight's tickets
specifically move the needle" question — they did not, materially.

## Caveats / not verified this run

- **No fresh treemap.** `rollup-plugin-visualizer` (baseline's analyzer) is not currently in
  `web/node_modules` and was not reinstalled. Per-package attribution inside `vendor-editor` /
  `vendor-emoji` / etc. is **derived** from `web/vite.config.ts`'s `manualChunks()` regex rules
  (observed in source), not measured from a regenerated treemap. If a precise byte-for-byte
  per-npm-package breakdown is needed, rerun with the analyzer reinstalled as devDependency
  scaffolding (permitted by the skill's gate).
- **BUN-8 (duplicate Radix versions)** not re-verified — a grep against `pnpm-lock.yaml` for the
  exact string baseline used found 0 matches, which most likely means the lockfile's key format
  changed (not that the duplication is confirmed gone). Left as "not verified" rather than guessed.
- **Font assets and other static assets** (`.woff`/`.woff2`, icons, manifest.json) are excluded
  from all totals above, matching baseline's own methodology; `web/dist` in full (JS+CSS+fonts+
  everything) is 3.95 MB, essentially unchanged in scale from baseline's reported `distDirTotalMb: 4.5`.
- Full E2E regression suite was **not** re-run as part of this measurement (per this task's scope
  — the caller has a separate e2e-regression agent running concurrently in this repo). The bundle
  build itself completed clean (`✓ built in 2.71s`, only Vite's advisory >500 KB chunk warning for
  `vendor-editor`, which is expected and intentional per BUN-2/BUN-6's design).

## Raw evidence

- `raw/measure-output.txt` — full stdout of `node audit/bundle/measure.mjs web/dist current-main-397e3b7`
- `raw/measure.mjs.snapshot` — copy of the measurement tool as run (already committed at repo HEAD;
  snapshotted here for reproducibility)
- `raw/tonight-web-diffstat.txt` — `git diff c1caa61..HEAD -- web/` (stat + full diff), the source
  for the "isolated to tonight" section above
