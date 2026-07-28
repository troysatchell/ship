# Bundle Size — Baseline

**Category** `bundle` · **Finding prefix** `BUN` · **Mode** baseline · **Date** 2026-07-27
**Commit** `076a18371da0a09f88b5329bd59611c4bc9536bb` (dirty: yes — only `.claude/`, `.gitignore`, `audit/`, `memory-bank/`; no application source under `api/`, `web/`, `shared/` is modified, so the measurements reflect the commit)

| | |
|---|---|
| Hardware | Apple Mac16,7 — 14 cores, 24 GB RAM (arm64) |
| OS | Darwin 25.5.0 arm64 / macOS 26.5.1 |
| Node | v23.2.0 |
| Package manager | pnpm 10.27.0 |
| Vite | 6.4.1 (declared `^6.0.5`) |
| Data volume | 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users |
| Concurrency | n/a — static analysis of build output, no runtime load |

Data volume is stamped for cross-category comparability; it does not influence a static bundle measurement.

---

## Methodology

Everything below is reproducible from the repo root. **All sizes use kB = 1000 bytes** (matching Vite's own reporting) and **gzip = `zlib.gzipSync(buf, { level: 9 })`**. Vite's build log reports gzip at zlib's default level, which is why its entry-chunk figure (589.50 kB) is ~1.5 kB larger than the level-9 figure used here (587.93 kB). Compare mode must use level 9 to stay comparable.

### 1. Build under measurement

`pnpm build` (→ `web/package.json` `build`: `tsc && VITE_API_URL= vite build`) had already been run against this commit before the audit began; `web/dist` was left untouched and **every number in this report is measured from `web/dist`**. Dev servers (API :3001, web :5173) were running throughout and were neither used nor restarted.

### 2. Total size, chunk map, initial-load set

Node script over `web/dist/assets`, reading each `*.js`/`*.css` file and gzipping it in-process:

```js
for (const f of readdirSync('web/dist/assets')) {
  if (!/\.(js|css)$/.test(f)) continue;
  const buf = readFileSync(join(dir, f));
  rows.push({ file: f, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });
}
```

The **initial-load set** was read directly out of the built `web/dist/index.html`: it contains exactly one `<script type="module" crossorigin src="/assets/index-C2vAyoQ1.js">` and one `<link rel="stylesheet" href="/assets/index-DJeYp5na.css">`, and **no `modulepreload` tags at all**. Initial load is therefore exactly those two files.

Chunks were classified by filename stem: `index` → entry; `Project*|Program*|Week*|Standup*` → lazy document-tab chunks; everything else lowercase-alphanumeric → USWDS icon chunks (`statusColors` is the one app module that falls outside both buckets).

### 3. Treemap / dependency attribution

`rollup-plugin-visualizer@7.0.1` was installed as a devDependency of `@ship/web`. **The registry is blocked in this environment, but `pnpm add -D rollup-plugin-visualizer --filter @ship/web` succeeded from the local pnpm store** (`resolved 1011, downloaded 0`), so no fallback was needed. After analysis the manifests were reverted (`git checkout -- web/package.json pnpm-lock.yaml`) so the audited tree matches the commit exactly; the package stays resolvable in `web/node_modules` for compare mode.

`web/vite.config.ts` was **not** modified. Instead `audit/bundle/vite.analyze.config.ts` (committed alongside this report) mirrors its build-relevant options — `@vitejs/plugin-react`, `vite-plugin-svgr` with byte-identical `svgrOptions`, and the `@` → `web/src` alias — and adds two visualizer instances (treemap HTML + `raw-data` JSON). It imports the plugin by deep ESM path because the config lives outside `web/` and Vite bundles configs to CJS.

```bash
# run from web/ so Tailwind's content globs resolve against the same CWD as the real build
cd web && AUDIT_STATS_DIR=../audit/bundle VITE_API_URL= \
  ./node_modules/.bin/vite build \
    --config ../audit/bundle/vite.analyze.config.ts \
    --outDir <scratch>/dist-analyze --emptyOutDir
```

**Fidelity check (this is what makes the attribution trustworthy):** the analyzer build emitted the same 262 chunk names as `web/dist` and **0 size differences across all 262 files**. Output saved as `audit/bundle/stats.html` (treemap) and `audit/bundle/stats.json` (raw data).

> The first analyzer run was executed from the repo root and produced a 20,038-byte CSS file instead of 66,512 — Tailwind's `content` globs resolve against `process.cwd()`, not the config file. JS was unaffected. Re-running with `cwd=web` gave byte-for-byte parity. **Compare mode must run from `web/`.**

**Attribution maths.** `rollup-plugin-visualizer` reports `renderedLength` *before* Vite's esbuild minify pass (4,797.8 kB across all chunks vs 2,250.5 kB actually emitted), so raw visualizer numbers overstate shipped bytes by ~2.1×. Every per-dependency figure in this report is therefore **scaled per chunk**:

```
estShippedRaw(module)  = renderedLength(module) × (actualChunkRawBytes  / Σ renderedLength in chunk)
estShippedGzip(module) = gzipLength(module)     × (actualChunkGzipBytes / Σ gzipLength     in chunk)
```

These are proportional estimates, not exact per-module byte counts (minification and compression are not linear per module), but they are deterministic and reproduce exactly from `stats.json` + `web/dist`. Package names come from the pnpm path pattern `node_modules/(\.pnpm/[^/]+/node_modules/)?((@[^/]+/)?[^/]+)/`; app modules bucket by their `src/<dir>` segment.

### 4. Unused dependencies

For each entry in `web/package.json` `dependencies`, count import sites:

```bash
grep -rE "from '(<pkg>)(/|')|import '(<pkg>)(/|')|require\('(<pkg>)'" web/src \
  --include="*.ts" --include="*.tsx" --include="*.css" | wc -l
```

Two packages scored 0 and were then verified individually rather than flagged blind:
- `@uswds/uswds` — **not unused**: consumed via the `import.meta.glob` path string at `web/src/components/icons/uswds/Icon.tsx:24`, which the grep pattern cannot see.
- `@tanstack/query-sync-storage-persister` — **genuinely unused**: 0 import sites *and* 0 modules present in any emitted chunk per `stats.json`.

### 5. Splitting assessment

```bash
grep -rn "lazy(" web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
grep -rnE "\bimport\(" web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
grep -rnE "<Icon[[:space:]]+name=\{" web/src --include="*.tsx"   # → 0 matches
```

Icon liveness: every emitted icon chunk stem was matched against quoted lowercase literals across `web/src`, excluding the generated `types.ts` `IconName` union, `Icon.tsx` itself, `__mocks__/` and `*.test.tsx`. Because `<Icon name={…}>` has zero occurrences, all icon names are inline literals and this scan is exhaustive rather than heuristic.

### 6. Duplicate versions

Module ids in `stats.json` were parsed for `.pnpm/<name>@<version>` segments and grouped by package name (124 packages present in the bundle).

---

## Deliverable table

| Metric | Baseline |
|---|---|
| **Total production bundle (raw / gzip)** | **2,316.96 kB / 699.75 kB** (261 JS + 1 CSS) |
| **Initial-load bundle (raw / gzip)** | **2,140.21 kB / 600.75 kB** — 92.4% of total raw, 85.9% of total gzip |
| **Largest chunk** | `assets/index-C2vAyoQ1.js` — 2,073.70 kB raw / 587.93 kB gzip |
| **Number of chunks** | 262 (1 entry JS, 1 entry CSS, 245 icon chunks, 14 document-tab chunks, 1 `statusColors`) |
| **Top 3 largest dependencies** (in the entry chunk, est. shipped) | 1. `highlight.js` 176.3 kB raw / 64.0 kB gzip (10.9% of entry gzip) · 2. `emoji-picker-react` 186.4 kB raw / 39.1 kB gzip (6.6%) · 3. `prosemirror-view` 110.2 kB raw / 30.9 kB gzip (5.3%) |
| **Unused dependencies** | `@tanstack/query-sync-storage-persister` (0 imports, 0 bundled modules). `@tanstack/react-query-devtools` is a runtime dep that ships a ~0-byte production stub — misclassified, not wasteful. |
| **Code splitting in use?** | Yes, but never at a route boundary: 13 `React.lazy` document tabs (`web/src/lib/document-tabs.tsx:52-66`), 2 dynamic imports (`web/src/components/editor/SlashCommands.tsx:377,445`), 245 lazy icon chunks (`Icon.tsx:23-26`). **0 lazy routes** — all 25 pages statically imported at `web/src/main.tsx:19-43`. |

### Where the 587.93 kB entry chunk actually goes

| Family | est. raw | est. gzip | % of entry gzip |
|---|---:|---:|---:|
| TipTap + ProseMirror + Yjs + lib0 + y-* + linkifyjs | 726.5 kB | 208.7 kB | 35.5% |
| Application source (`web/src`) | 556.8 kB | 142.5 kB | 24.2% |
| highlight.js + lowlight | 181.8 kB | 65.8 kB | 11.2% |
| Radix + cmdk + Popper + Tippy + Floating UI | 139.8 kB | 47.8 kB | 8.1% |
| emoji-picker-react | 186.4 kB | 39.1 kB | 6.6% |
| react + react-dom + react-router | 105.2 kB | 36.7 kB | 6.2% |
| @dnd-kit | 58.8 kB | 15.1 kB | 2.6% |
| @tanstack query | 40.4 kB | 13.0 kB | 2.2% |
| diff-match-patch | 37.6 kB | 9.8 kB | 1.7% |
| everything else | 40.5 kB | 9.6 kB | 1.6% |

### Lazy chunks (260 chunks, 176.75 kB raw / 99.0 kB gzip — 14.1% of total gzip)

| Group | Count | Raw | Note |
|---|---:|---:|---|
| USWDS icon chunks | 245 | 104.6 kB | **209 of them are never referenced by app source** (91.3 kB raw of dead deploy output) |
| Document-tab chunks | 14 | 71.8 kB | The only deliberate splitting in the app |
| `statusColors` | 1 | ~0.4 kB | Shared by lazy tabs |

---

## Findings

### BUN-1 · High · Whole application ships in one 2.07 MB entry chunk — zero route-level code splitting
**Location:** `web/src/main.tsx:19-43` (25 static page imports), routes at `web/src/main.tsx:214-247`

`web/dist/index.html` references exactly one module script (2,073.70 kB raw / 587.93 kB gzip) and one stylesheet (66.51 kB / 12.83 kB), with **no `modulepreload` tags**. That pair is 92.4% of emitted raw bytes and 85.9% of gzip bytes. All 25 page components — including `AdminDashboardPage`, `AdminWorkspaceDetailPage`, `OrgChartPage`, `ReviewsPage`, `WorkspaceSettingsPage`, `PublicFeedbackPage`, `SetupPage`, `InviteAcceptPage` — are statically imported. Treemap attribution places 198.9 kB raw / 44.2 kB gzip of `/src/pages/*` inside the entry chunk, on top of the components those pages exclusively pull in. Lazy loading exists only for document tabs, two slash-command helpers, and icons — never at a route boundary. Vite prints its `>500 kB` warning on every build.

**Hypothesis:** `web/vite.config.ts` has no `build` block whatsoever (no `rollupOptions`, no `manualChunks`, no `chunkSizeWarningLimit`), and `main.tsx` was written with eager imports. Splitting arrived later and only for document tabs, so the pattern never propagated up to routes. Nothing in CI fails on bundle size, so the warning has been absorbed as build noise.

**Estimated impact:** This is the structural cause of BUN-2/3/4. An unauthenticated visitor on `/login` downloads the admin dashboard, org chart, reviews queue and the whole editor stack before the login form paints. Route-level `React.lazy` moves ~44 kB gzip of page modules plus their exclusive subtrees out of the entry chunk and is the prerequisite for the 20% initial-load target.

### BUN-2 · High · TipTap + ProseMirror + Yjs editor stack is 35.5% of the entry chunk and loads on every page
**Location:** `web/src/components/Editor.tsx`, imported eagerly by `web/src/components/UnifiedEditor.tsx:3` and `web/src/pages/PersonEditor.tsx:3`

`@tiptap/*` + `prosemirror-*` + `yjs` + `lib0` + `y-prosemirror`/`y-websocket`/`y-protocols` + `linkifyjs` total **726.5 kB raw / 208.7 kB gzip est = 35.5% of the entry chunk**. Largest members: `prosemirror-view` 110.2 kB raw / 30.9 kB gzip, `yjs` 123.6 / 30.0, `@tiptap/core` 84.5 / 19.9, `lib0` 49.7 / 18.4, `prosemirror-model` 56.5 / 15.5. No dynamic-import boundary exists anywhere in Editor.tsx's import chain.

**Hypothesis:** The Editor is the centrepiece of the "everything is a document" model, so it was imported directly rather than behind Suspense. With only one chunk (BUN-1) there was no seam at which to defer it.

**Estimated impact:** `React.lazy` + `Suspense` around `Editor`/`UnifiedEditor` removes up to **208.7 kB gzip — 34.7% of the 600.75 kB initial payload**, on its own more than the 20% target. Users who never open an editor (login, dashboards, issue lists, admin) stop paying for it entirely.

### BUN-3 · High · `createLowlight(common)` pulls 37 highlight.js grammars into the entry chunk
**Location:** `web/src/components/Editor.tsx:12` and `Editor.tsx:46`, consumed at `Editor.tsx:549`

`highlight.js` contributes 39 modules — 387.0 kB pre-minification → **176.3 kB raw / 64.0 kB gzip est, 10.9% of the entry chunk and the largest npm package in it**. `createLowlight(common)` was resolved against the installed lowlight and registers 37 grammars: arduino, bash, c, cpp, csharp, css, diff, go, graphql, ini, java, javascript, json, kotlin, less, lua, makefile, markdown, objectivec, perl, php, php-template, plaintext, python, python-repl, r, ruby, rust, scss, shell, sql, swift, typescript, vbnet, wasm, xml, yaml. `@tiptap/extension-code-block-lowlight` adds 37.3 kB raw / 12.6 kB gzip; family total 181.8 kB raw / 65.8 kB gzip (11.2%).

**Hypothesis:** `common` is lowlight's convenience export and the path of least resistance; nobody measured what 37 grammars cost. Arduino, VBNet, Objective-C, R, Lua, Perl and WASM are unlikely in a project-management wiki but are indistinguishable from the ones that matter once `common` is imported.

**Estimated impact:** Registering an explicit 6-8 languages is a one-line change worth an estimated **45-55 kB gzip**. Dynamically importing the lowlight instance when a code block first renders removes the full **65.8 kB gzip (11.0% of initial payload)** for one async boundary.

### BUN-4 · Medium · emoji-picker-react ships in the entry chunk for a single sidebar popover
**Location:** `web/src/components/EmojiPicker.tsx:2`; sole consumer `web/src/components/sidebars/ProjectSidebar.tsx:2,295`

A single 409.2 kB pre-minification module → **186.4 kB raw / 39.1 kB gzip est, 6.6% of the entry chunk** and its 2nd-largest npm dependency. Exactly one consumer outside the wrapper: the project-icon `PropertyRow`. The import is fully static, so it downloads on every page load including `/login`.

**Hypothesis:** `EmojiPicker.tsx` is a plain re-export wrapper, and with no splitting infrastructure (BUN-1) there was no obvious place to defer it. The cost is invisible without a treemap.

**Estimated impact:** `React.lazy` on the popover body removes **39.1 kB gzip (6.5% of initial payload)** at near-zero risk — the picker is behind a click in a properties sidebar, so a Suspense fallback is imperceptible. Best effort-to-yield ratio of any finding here. (Rated Medium rather than High only because it sits below the 100 kB-gzip bar in the category severity guidance; by share of payload it is worth fixing first.)

### BUN-5 · Medium · Icon glob emits 245 chunks, 209 never referenced, plus a 245-entry loader map in the entry chunk
**Location:** `web/src/components/icons/uswds/Icon.tsx:23-26`

245 per-icon chunks are emitted (104.6 kB raw / 74.3 kB gzip aggregate — tiny files gzip badly). Cross-referencing every icon chunk stem against string literals in `web/src` (excluding the generated `types.ts` union, `Icon.tsx`, mocks and tests): **36 referenced, 209 not** (91.3 kB raw / 64.2 kB gzip deployed but never requested). `<Icon name={…}>` has **zero** occurrences, so every icon name is an inline literal and the scan is exhaustive. Separately the generated glob map inside `Icon.tsx` is 42.7 kB pre-minification (3.6 kB gzip) and sits in the **entry** chunk.

**Hypothesis:** The whole-directory `import.meta.glob` was chosen so any icon name would "just work". Because every icon is also enumerated in the generated `types.ts` union, tree-shaking cannot narrow the glob and the build gets no signal about which 36 icons are real.

**Estimated impact:** Narrowing the glob to icons actually used — ideally generated by the same script that writes `types.ts` (`pnpm generate:icon-types`) — removes ~3 kB gzip from the entry chunk and 209 dead files from every S3/CloudFront deploy. Secondary benefit: each used icon is currently a separate lazy HTTP request on first paint, a per-icon network waterfall that a small eager map eliminates.

### BUN-6 · Medium · No build/chunking configuration — no vendor chunk, so every app change invalidates all 588 kB gzip
**Location:** `web/vite.config.ts:46-94` (returned config has no `build` key)

The config declares only `plugins`, `resolve.alias`, `server` and `preview`. Result: one chunk holds all application code **and** all third-party code — React, react-dom, react-router, TanStack Query, TipTap/ProseMirror/Yjs, highlight.js, emoji-picker-react, Radix, dnd-kit, Tippy, Popper. Stable vendor code (105.2 kB raw / 36.7 kB gzip for react+react-dom+router alone; 726.5 kB raw for the editor stack) shares a content hash with volatile app source (556.8 kB raw / 142.5 kB gzip).

**Hypothesis:** The default Vite config was never revisited as the app grew past a handful of pages; the chunk-size warning is advisory and does not fail CI.

**Estimated impact:** A `manualChunks` vendor split does not reduce total bytes but converts ~250-300 kB gzip of stable dependency code into a long-lived cache entry: returning users after a routine deploy would download tens of kB instead of 588 kB. **Compare mode should track "bytes changed per deploy" separately**, because this fix improves that without moving `initialGzipKb`.

### BUN-7 · Low · Unused dependency `@tanstack/query-sync-storage-persister`
**Location:** `web/package.json:25`

Zero import sites and zero modules in any emitted chunk. `web/src/lib/queryClient.ts:1-3` implements persistence itself with `idb-keyval` plus the `PersistedClient`/`Persister` **types** from `@tanstack/react-query-persist-client`. Related: `@tanstack/react-query-devtools` (`web/package.json:27`) is a runtime `dependency` statically imported at `main.tsx:6` and rendered at `main.tsx:265` — verified harmless, its production build tree-shakes to a ~0-byte no-op stub.

**Hypothesis:** Leftover from an earlier localStorage-based persistence approach replaced by the IndexedDB persister with corruption detection.

**Estimated impact:** 0 shipped bytes — hygiene and supply-chain surface, not payload. Move react-query-devtools to `devDependencies` for the same reason.

### BUN-8 · Low · Duplicate Radix versions, both copies in the entry chunk
**Location:** `pnpm-lock.yaml` (transitive peers of `@radix-ui/react-dialog`/`react-popover`/`react-tooltip`); both copies land in `assets/index-C2vAyoQ1.js`

`@radix-ui/react-slot` resolves to both 1.2.3 and 1.2.4, `@radix-ui/react-primitive` to both 2.1.3 and 2.1.4 — all four copies bundled. Measured cost: slot 1.9 + 1.8 kB raw, primitive 0.4 + 0.3 kB raw; redundant copies ≈ **2.1 kB raw**. No other package among the 124 in the bundle has more than one version.

**Hypothesis:** The three Radix packages are pinned at different caret ranges and resolved their shared internals at different times, so pnpm kept two trees.

**Estimated impact:** ~2.1 kB raw / <1 kB gzip. Negligible but recorded so compare mode can confirm it does not grow; fix opportunistically with a pnpm resolution or by refreshing the Radix packages together.

### BUN-9 · Low · Initial render blocks on a third-party Google Fonts stylesheet
**Location:** `web/index.html:65-67`

Two preconnects to `fonts.googleapis.com`/`fonts.gstatic.com` plus a render-blocking `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter…">`, ahead of the entry script in `<head>`. Not counted in any bundle metric above (it is not an emitted asset) but it is on the same initial-load critical path.

**Hypothesis:** Vite/Tailwind starter boilerplate that survived into a production app which is otherwise fully self-hosted (own icons, own CSS, own PWA manifest).

**Estimated impact:** Self-hosting an Inter woff2 subset removes a cross-origin round trip from first paint and drops a third-party runtime dependency from an app deployed at `ship.awsdev.treasury.gov`. No effect on the size target; flagged because it shares the critical path.

---

## Recommended improvement plan

**Target chosen: the initial-load variant — cut the initial-load bundle by 20%** (600.75 kB gzip → ≤ 480.60 kB gzip). It is the right variant because 85.9% of all shipped gzip is in a single entry chunk, and because total-bundle reduction understates the win: moving bytes into lazy chunks improves the user-visible metric without deleting a single feature.

The 15% total-bundle variant is *not* the target and should not be used to judge the fix: correctly lazy-loading the editor would leave `totalGzipKb` almost unchanged while halving what a visitor downloads.

Ordered by yield-per-unit-of-risk. Estimates are additive only where the code paths are disjoint; steps 2 and 3 overlap (lowlight is reached through the editor), so take the union, not the sum.

| # | Change | Finding | Est. initial-load gzip removed | Risk |
|---|---|---|---:|---|
| 1 | `React.lazy` the emoji picker body in `EmojiPicker.tsx` | BUN-4 | 39.1 kB (6.5%) | Very low — behind a click |
| 2 | Replace `createLowlight(common)` with an explicit language list, or dynamic-import lowlight on first code block | BUN-3 | 45-65.8 kB (7.5-11.0%) | Low — degrades to unhighlighted code at worst |
| 3 | `React.lazy` + `Suspense` around `Editor`/`UnifiedEditor` | BUN-2 | up to 208.7 kB (34.7%) | Medium — must not break Yjs/WebSocket mount timing or the "Untitled" placeholder contract |
| 4 | Route-level `React.lazy` for all non-critical routes in `main.tsx` (admin, org chart, reviews, settings, setup, invite, public feedback first) | BUN-1 | ~44 kB of page modules + exclusive subtrees | Medium — needs a Suspense fallback that does not flash the 4-panel layout |
| 5 | `build.rollupOptions.output.manualChunks` vendor split | BUN-6 | 0 kB initial, but ~250-300 kB gzip becomes cacheable across deploys | Low |
| 6 | Narrow the icon glob; drop `@tanstack/query-sync-storage-persister`; move devtools to `devDependencies`; dedupe Radix | BUN-5, 7, 8 | ~3 kB entry + 209 dead files off the CDN | Very low |

**Steps 1-3 alone are projected to take the initial load from 600.75 kB gzip to roughly 290-310 kB — a 48-52% reduction, comfortably past the 20% target.** Step 1 is a single afternoon's work and already covers a third of it.

### Compare-mode protocol (must match exactly)

1. Build with `pnpm build` from the repo root; measure `web/dist` only.
2. Reinstall the analyzer if needed (`pnpm add -D rollup-plugin-visualizer --filter @ship/web`, resolves from the local pnpm store) and re-run **from `web/`** with `audit/bundle/vite.analyze.config.ts` — running from the repo root silently under-generates the Tailwind CSS.
3. Verify chunk-name and byte parity between the analyzer build and `web/dist` before trusting any attribution.
4. Gzip at level 9. kB = 1000 bytes.
5. Re-run the identical grep patterns in §4 and §5 above for unused-dependency and splitting counts.
6. **Prove functionality is preserved:** `pnpm test` (api vitest) **and** `pnpm --filter @ship/web test` (the root `test` script does not cover web) **and** the Playwright suite via `/e2e-test-runner` — never `pnpm test:e2e` directly. Lazy-loading that breaks a route, or removing a language grammar that a seeded document depends on, is a regression and not a win.
