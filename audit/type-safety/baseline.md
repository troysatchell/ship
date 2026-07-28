## Type Safety — Baseline

**Repo:** `/Users/troy/repos/GAUNTLET/Ship` · **Commit:** `076a183` (tree dirty: `.claude/`, `.gitignore`, `audit/`, `memory-bank/` only — no application source modified) · **Date:** 2026-07-27T16:53:39Z
**Environment:** Apple Mac16,7 — 14 cores, 24 GB RAM (arm64) · Darwin 25.5.0 arm64 / macOS 26.5.1 · Node v23.2.0 · pnpm 10.27.0 · TypeScript 5.9.3
**Data volume:** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users

---

### Methodology

Static analysis only. No application source, config, or dependency was modified.

**1. Violation counts** — the bundled script, run once against all three packages from the repo root:

```bash
~/.claude/skills/type-safety-audit/scripts/count.sh \
  /Users/troy/repos/GAUNTLET/Ship/web \
  /Users/troy/repos/GAUNTLET/Ship/api \
  /Users/troy/repos/GAUNTLET/Ship/shared
```

Base grep invocation used by the script (recorded verbatim — compare mode must use the identical patterns):

```
grep -rEn --include=*.ts --include=*.tsx \
     --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage
```

| Metric key | Pattern |
|---|---|
| `explicit_any` | `:\s*any\b\|<any>\|\bany\[\]\|Array<any>` |
| `as_assertions` | `\bas\s+[A-Za-z_{]` |
| `as_any` | `\bas\s+any\b` |
| `non_null_assertions` | `[a-zA-Z0-9_\)\]]!(\.\|\[\|\)\|,\|;\|\s*$)` |
| `ts_ignore` | `@ts-(ignore\|expect-error)` |
| top-files ranking | `:\s*any\b\|<any>\|\bany\[\]\|\bas\s+any\b\|@ts-(ignore\|expect-error)` |

> **Grep-binary note (matters for reproducibility).** The script has a `bash` shebang, so it resolves `grep` to `/usr/bin/grep` (BSD grep, macOS 26) rather than this shell's interactive `ugrep` shim. All tracked numbers below are the BSD-grep numbers. Reproduce with `bash ~/.claude/skills/type-safety-audit/scripts/count.sh …`, never by pasting the greps into an interactive zsh — ugrep parses the bracket expressions differently and returns materially different counts.

**2. Strict mode** — every tsconfig in the tree was read (`tsconfig.json`, `web/`, `api/`, `shared/`; `research/configs/*` is a non-built reference copy). `pnpm type-check` (= `tsc --noEmit` per package) was run to establish the current error count. Because `strict` is already on everywhere, the equivalent "true debt" probe is the *inherited* strict flags web opts out of; measured with CLI overrides so no file was edited:

```bash
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch
```

**3. Supporting counts** (each from a command, per the determinism rule), all with the same base grep:

| Number | Command |
|---|---|
| 707 untyped pg queries / 0 typed | `'(pool\|client\|db)\.query'` vs `'(pool\|client\|db)\.query<'` over `api/src`, minus test files |
| 767 `.rows` accesses | `'\.rows\b'` over `api/src`, minus test files |
| 7 untyped row mappers | `'\((row\|r): any'` over `api/src`, minus test files |
| 236 `req.userId!` / `req.workspaceId!` | `'req\.(userId\|workspaceId)!'` over `api/src` |
| 13/198 and 13/109 shared-type importers | `grep -rl "from '@ship/shared'"` over `web/src`, `api/src` |
| ~40 duplicate model declarations | `'^(export )?(interface\|type) (Project\|Issue\|WikiDocument\|UnifiedDocument\|Sprint\|Week\|Program\|Person\|ApiResponse)\b'` |
| ESLint absent | `find` for `.eslintrc*` / `eslint.config.*` outside node_modules → 0 hits |

**Correction factors** (spot-checks; the raw script number remains the tracked metric):

- `non_null_assertions` **under-counts by ~6.8x**. In `[a-zA-Z0-9_\)\]]!…`, BSD grep treats the backslashes inside the bracket expression as literal `\`, so the class closes early and the pattern effectively requires a `]` immediately before `!`. Tracked total 47; the corrected pattern `[a-zA-Z0-9_)]]?!(\.|\[|\)|,|;|\s*$)` yields **321** (web 33, api 288), of which only 2 are comment false positives and 4 are in test files. Both numbers are recorded in `baseline.json` (`nonNullTotal`, `nonNullCorrected`); the tracked pattern is kept unchanged so compare mode stays comparable.
- `as_assertions` **over-counts by roughly 15–20%**. Of the 1385 raw hits, ≥154 are not assertions at all: 61 are on `import`/`export … as …` lines (web 35, api 26) and 93 are inside comments or prose (web 34, api 58, shared 1 — e.g. `// Format time as M:SS`, `Same as last week`). A further 73 are `as const` (web 59, api 12, shared 2), which is a safety *improvement*, not a violation. Genuinely risky assertions are the 158 `as any` plus the residue.

---

### Deliverable table

| Metric | Baseline |
|---|---|
| Total `any` types | **102** |
| Total type assertions (`as`) | **1385** (of which 158 are `as any`; ~154 raw hits are imports/comments and 73 are `as const` — see corrections) |
| Total non-null assertions (`!`) | **47** tracked · **321** corrected |
| Total `@ts-ignore` / `@ts-expect-error` | **1** (a single justified `@ts-expect-error` at `web/src/components/icons/uswds/Icon.test.tsx:63`) |
| Strict mode enabled? | **web: yes · api: yes · shared: yes** — but web does **not** extend the root tsconfig, so it silently loses `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` |
| Strict-mode error count (if disabled) | **0** at current configs (`pnpm type-check` is green). With web's three missing inherited flags restored: **102 errors** — 94 `noUncheckedIndexedAccess`, 8 `noImplicitReturns` (TS7030), 0 `noFallthroughCasesInSwitch` |
| Top 5 violation-dense files (raw script ranking) | `api/src/__tests__/transformIssueLinks.test.ts` 37 · `api/src/services/accountability.test.ts` 32 · `api/src/__tests__/auth.test.ts` 24 · `api/src/__tests__/activity.test.ts` 21 · `api/src/routes/issues-history.test.ts` 20 |
| **Total tracked violations** | **1535** (102 `any` + 1385 `as` + 47 `!` + 1 ts-ignore; `as any` not double-counted) |

#### Per package

| Package | `any` | `as` | `as any` | `!` (tracked / corrected) | ts-ignore | strict | extra root flags | tsc errors |
|---|---|---|---|---|---|---|---|---|
| `web` (frontend, 198 src files) | 24 | 433 | 7 | 5 / 33 | 1 | ✅ | ❌ **not inherited** | 0 → **102** with flags |
| `api` (backend, 109 src files) | 78 | 947 | 151 | 42 / 288 | 0 | ✅ | ✅ | 0 |
| `shared` (8 src files, 46 exported types) | 0 | 5 | 0 | 0 / 0 | 0 | ✅ | ✅ | 0 |
| **Total** | **102** | **1385** | **158** | **47 / 321** | **1** | | | **0 / 102** |

#### Where the violations actually live

The raw density ranking is dominated by tests and is misleading about risk. Splitting it:

| | Sites | Share |
|---|---|---|
| Test files (`*.test.*`, `__tests__/`) | 176 | 68% |
| Production code | 84 | 32% |

**Production-only density ranking** — this is the list worth reading:

| Rank | File | Sites | Lines | What flows through it |
|---|---|---|---|---|
| 1 | `api/src/routes/projects.ts` | 13 | 1735 | SQL rows → project/sprint JSON contract; issue rollup counts |
| 2 | `api/src/utils/yjsConverter.ts` | 12 | 245 | CRDT state ↔ persisted document `content` |
| 3 | `api/src/routes/weeks.ts` | 10 | 3156 | SQL rows → sprint/week/standup JSON contract |
| 4 | `web/src/components/editor/FileAttachment.tsx` | 7 | 357 | TipTap node/editor commands, upload |
| 4= | `api/src/types/y-protocols.d.ts` | 7 | 39 | Yjs awareness/sync protocol shims |
| 6 | `web/src/components/editor/SlashCommands.tsx` | 6 | 714 | TipTap editor + suggestion plugin props |
| 6= | `web/src/components/editor/AIScoringDisplay.tsx` | 6 | 287 | ProseMirror doc traversal |

Two clusters explain almost all production `any`: **(a) the raw-`pg` boundary** — seven `extract*FromRow(row: any)` mappers plus `(i: any)` filter callbacks, i.e. TS-2, and **(b) the TipTap/Yjs boundary** — `yjsConverter.ts`, `y-protocols.d.ts`, and the three editor components, i.e. TS-3. Cluster (b) is a *defensible* external-library boundary that was never modelled; cluster (a) is internal data the codebase fully controls and has no excuse.

---

### Findings

#### TS-1 · High — `web/tsconfig.json` does not extend the root tsconfig; 102 latent type errors are invisible in the frontend

`web/tsconfig.json` has no `extends` key. `api/tsconfig.json:2` and `shared/tsconfig.json:2` both extend `../tsconfig.json`, which sets `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`. web re-declares `strict: true` standalone and therefore runs without the other three. `pnpm type-check` is green today; restoring the three flags via CLI override produces **102 errors** — 41 TS2532 "Object is possibly 'undefined'", 29 TS18048, 12 TS2322, 11 TS2345, 1 TS18047, 8 TS7030. Densest: `CommandPalette.tsx` (13), `lib/cn.ts` (12), `hooks/useSelection.ts` (12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12).

The strongest evidence that this is drift rather than intent: the repo's own reference config at `research/configs/web/tsconfig.json` **does** `extends: "../tsconfig.json"`. The shipped config diverged from the pattern the other two packages still follow.

*Impact:* these 94 index/lookup errors are precisely the "cannot read property of undefined" crash class, in the package that renders the UI. Fixing them also mechanically retires most of web's 33 corrected non-null assertions, because `noUncheckedIndexedAccess` forces real narrowing where `!` is currently papering over the same lookups.

#### TS-2 · High — the entire database-to-HTTP response path is implicitly `any`

`@types/pg` declares `query<R extends QueryResultRow = any, I = any[]>(…)`. In `api/src` production code there are **707** `pool/client/db.query(` call sites and **zero** supply the generic — so all **767** `.rows` accesses are `any`. The only translation layer between those rows and the JSON contract the frontend consumes is seven hand-written mappers, every one declared `(row: any)`:

`projects.ts:18` `extractProjectFromRow` · `projects.ts:1102` and `weeks.ts:186` `extractSprintFromRow` · `issues.ts:82` `extractIssueFromRow` · `programs.ts:12` `extractProgramFromRow` · `feedback.ts:27` `extractFeedbackFromRow` · `weeks.ts:1793` `formatStandupResponse`

Consumers stay untyped downstream — `projects.ts:959-961` and `:983-985` compute rollups with `issuesResult.rows.filter((i: any) => i.state === 'done')`.

*Why this is the headline:* most of this debt is **not** in the 102 `any` count. Only the mapper signatures and a handful of callbacks are annotated; the other ~760 property accesses are unannotated implicit `any` that `strict` cannot catch, because pg's generic defaults to `any` rather than `unknown`. A column rename or a `properties->>'…'` key typo yields `undefined` in a live API response with no compile-time signal anywhere in the chain.

#### TS-3 · High — the Yjs ↔ TipTap converter, on the document persistence path, is fully untyped

`api/src/utils/yjsConverter.ts` carries 12 `any` in 245 lines — the highest any-per-line density of any production file. Every exported signature is untyped: `yjsToJson(fragment): any`, `jsonToYjs(doc, fragment, content: any)`, `loadContentFromYjsState(yjsState): any | null`, plus the internal `extractTextWithMarks(el, inheritedMarks: any[]): any[]` and `yjsElementToJson(el): any[]`. `api/src/types/y-protocols.d.ts` adds 7 more on the awareness/sync surface underneath.

The callers are the core data path, not a side road:
- `api/src/collaboration/index.ts:118` — inside `persistDocument()`, `yjsToJson(fragment)` produces the value written to `documents.content` and fed to the hypothesis / success-criteria / vision / goals extractors.
- `api/src/routes/documents.ts:405` — `loadContentFromYjsState(doc.yjs_state)` produces the content served over REST.

*Impact:* this is the only code translating collaborative CRDT state into the durable `content` column. Given Ship's "everything is a document" model, a shape regression here silently corrupts or drops user-authored content — the product's core artifact — and nothing would fail to compile. Twelve `any`s stand between the CRDT and the database.

#### TS-4 · Medium — 236 non-null assertions on request auth context, from one optional declaration

`api/src/middleware/auth.ts:11-12` augments Express's `Request` with `userId?: string` and `workspaceId?: string`. Because they are optional, every authenticated handler re-asserts: **236** occurrences of `req.userId!` / `req.workspaceId!` across `api/src` — 82% of api's 288 corrected non-null assertions. Representative sites: `routes/projects.ts:318-319`, `routes/comments.ts:22,60-61,143-144,230-231`, `routes/workspaces.ts:214,389,490,591,673,861`.

*Impact:* one type declaration produces 15% of all tracked violations, and an `AuthenticatedRequest` type (or a typed handler wrapper applied after `requireAuth`) retires all 236 in a single edit. The correctness argument is stronger than the count: today a route registered *without* `requireAuth` type-checks identically to one with it, so a middleware-ordering mistake sends `undefined` into SQL as a user or workspace id rather than failing to compile. That is authorization scoping, not hygiene.

#### TS-5 · Medium — the `shared/` contract is bypassed; ~40 duplicate model declarations

`shared/src` exports 46 types and is itself pristine (0 `any`, 5 `as`). It is barely used: **13 of 198** web files and **13 of 109** api files import from `@ship/shared`. Meanwhile web/src declares the domain model ~40 times locally — `Project` ×5, `Sprint` ×6, `Program` ×6, `Person` ×5, `Issue` ×4, `WikiDocument` ×4, `Week` ×3 — across hooks, sidebars, comboboxes and pages. `web/src/lib/api.ts:5` even redeclares `interface ApiResponse<T>` although `shared/src/types/api.ts:2` exports `ApiResponse<T = unknown>` with a proper `ApiError`.

*Root cause and consequence:* the API responses these shapes describe are themselves untyped (TS-2), so there was never an authoritative type to import. Each component is validated against its own private guess at the contract, making cross-boundary drift structurally undetectable. Consolidating on `shared/` is what makes TS-2's typed row interfaces actually reach the frontend — done together, a backend field rename becomes a frontend compile error.

#### TS-6 · Medium — no ESLint anywhere; `pnpm lint` is a silent no-op

No `.eslintrc*` or `eslint.config.*` exists outside `node_modules`. None of `web`, `api`, `shared` defines a `lint` script, so root `package.json:25`'s `"lint": "pnpm --recursive run lint"` matches nothing and exits 0 — reporting success in CI while checking nothing. There is no `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `no-unsafe-assignment`, or `ban-ts-comment` rule in force.

*Impact:* `tsc --noEmit` is the only static gate, and it cannot flag `any` — `any` is legal TypeScript. The entire violation class measured here is invisible to the only check that runs. This finding reduces nothing on its own; it is the ratchet that keeps any reduction from regressing.

#### TS-7 · Medium — `as any` silencing mismatches on a destructive bulk mutation and a SQL parameter

- `web/src/pages/Projects.tsx:220` — `await updateProject(id, { archived_at: new Date().toISOString() } as any)` inside `handleBulkArchive`; `:233` the same in the Undo handler. `updateProject` is `(id: string, updates: Partial<Project>) => Promise<Project | null>` (`contexts/ProjectsContext.tsx:21`) and `archived_at: string | null` **is** a member of `Project` (`hooks/useProjectsQuery.ts`) — so both assertions are unnecessary today and purely defeat the check on a path that mutates many records at once.
- `api/src/routes/issues.ts:155` — `params.push(states as any)` pushes a `string[]` into a scalar-typed SQL parameter array for an `= ANY($n)` clause; the assertion hides a genuine element-type gap.

These three, plus `FileAttachment.tsx:139` (`} as any` on a TipTap `addCommands` return), are the entire production `as any` population: **154 of 158** `as any` occurrences are in test files (api 150 of 151, web 4 of 7).

*Impact:* small count, disproportionate placement. Because the Projects.tsx assertions are redundant *now*, they will silently absorb a real mismatch the first time the Project model changes — the exact failure mode that makes `as any` dangerous. Deleting them is zero-risk.

#### TS-8 · Low — 68% of flagged sites are in tests, where `as any` mocks decouple tests from the shapes they verify

176 of 260 sites matching the density pattern are in `*.test.*` / `__tests__` files, and they occupy the entire raw top-6: `transformIssueLinks.test.ts` (37), `accountability.test.ts` (32), `auth.test.ts` (24), `activity.test.ts` (21), `issues-history.test.ts` (20), `projects.test.ts` (17). Typical shapes: `vi.mocked(pool.query).mock.calls[0]![1] as any[]` and `expect((editor.commands as any).setFileAttachment)`.

*Impact:* low blast radius, but it means a route can change its response shape and its own unit test still compiles and passes — these tests protect less than their count implies. Mechanically this is the largest single reduction available (~10% of all tracked violations), and it is the one most at risk of being "fixed" superficially.

#### TS-9 · Low — web build and script files are never type-checked

`web/tsconfig.json` includes `src` only, and `web/tsconfig.node.json` — the Vite companion config that would cover build tooling — does not exist. So neither `pnpm type-check` nor the `tsc && vite build` step covers `web/vite.config.ts` or `web/scripts/generate-icon-types.ts`. The latter generates the icon-name union type the rest of web depends on, making it the least-checked file in the package.

---

### Recommended improvement plan

**Improvement target: eliminate 25% of the 1535 tracked violations ≈ 384 sites**, with real types — `any` → `unknown` without narrowing does not count.

| # | Action | Finding | Violations retired | Effort | Real-safety value |
|---|---|---|---|---|---|
| 1 | Add `"extends": "../tsconfig.json"` to `web/tsconfig.json` (keeping web's `jsx`/`moduleResolution`/`paths` overrides) and fix the 102 errors it surfaces | TS-1 | ~130 (28 web `!`+`any` sites, plus 102 previously-uncounted latent errors) | M | **Highest** — converts the main frontend crash class into compile errors |
| 2 | Introduce an `AuthenticatedRequest` type (or typed handler wrapper) so `userId`/`workspaceId` are required after `requireAuth` | TS-4 | **236** | S | High — closes an authz-scoping hole; best ratio in the plan |
| 3 | Declare row interfaces per query and type the 7 `extract*FromRow` mappers; use `pool.query<RowType>(…)` on the hot routes | TS-2 | ~45 explicit + 767 accesses brought under the compiler | L | **Highest** — the API contract stops being a guess |
| 4 | Model the TipTap JSON node type and apply it across `yjsConverter.ts` (+ `y-protocols.d.ts`) | TS-3 | ~19 | S–M | High — protects durable document content |
| 5 | Replace test `as any` with typed mock factories (`Partial<X>`-based builders for the pg pool and TipTap editor) | TS-8 | ~155 | M | Low direct, but restores regression protection |
| 6 | Delete the two redundant `as any` in `Projects.tsx`; type `params` in `issues.ts` as `(string \| string[] \| number)[]` | TS-7 | 3 | XS | Medium — removes a live trap on a bulk-destructive path |
| 7 | Consolidate the ~40 duplicate model declarations onto `@ship/shared` (start with `ApiResponse`, `Project`, `Issue`, `Sprint`) | TS-5 | ~10 direct | L | High — only way steps 3 and 4 reach the UI |
| 8 | Add ESLint + typescript-eslint with `no-explicit-any`, `no-non-null-assertion`, `no-unsafe-assignment`, `ban-ts-comment` as **errors**, plus a `lint` script in each package so root `pnpm lint` stops being a no-op | TS-6 | 0 | S | **The ratchet** — without it everything above regresses |
| 9 | Add `web/tsconfig.node.json` covering `vite.config.ts` and `web/scripts/` | TS-9 | 0 | XS | Low |

**Sequencing.** Steps 1 + 2 + 4 + 6 alone clear roughly **388 violations (~25%)** for modest effort and are all genuine typing work, so they hit the target without step 5's bulk mechanical churn. Do step 8 *first* so the reduction is defended, then 1 → 2 → 4 → 6, then 3 → 7 as the structural fix (largest payoff, largest effort), leaving 5 as optional headroom.

**Compare-mode requirements.** Re-run the identical `count.sh` invocation and the identical `tsc` override command at the fix commit, then run `pnpm type-check` and `pnpm test` (note: root `pnpm test` runs **@ship/api only** — web unit tests need `pnpm --filter @ship/web test`) to prove behavior is preserved. Sample at least 5 fixed sites showing before/after types.
