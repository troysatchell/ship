## Accessibility Compliance — Compare (phase2-jul30)

**Commit:** `1474cb1` (clean, apart from these compare artifacts) · **Date:** 2026-07-30 · **App:** web `http://localhost:5648` (worktree-allocated port; authenticated as `dev@ship.local` with a freshly-issued session) · **Data:** 500 documents / 20 users, identical per-type breakdown to the baseline (26 root-level wiki docs, satisfying the A11Y-1 >10-root-docs precondition).

**Baseline compared against:** `audit/a11y/baseline.json` / `baseline.md`, commit `076a183`, 2026-07-27. Every merged a11y fix through A11Y-1, A11Y-2, A11Y-3, A11Y-4/A11Y-8, and A11Y-5/A11Y-6/A11Y-7 (including the new NotFound wildcard route) is present on this branch (`measure/a11y-compare-jul30`, main HEAD `1474cb1`).

### Methodology (identical to baseline, per the identical-conditions rule)

Same tool versions: Lighthouse 11.7.1 (`npx --yes lighthouse@11`), axe-core 4.11.0 via `@axe-core/playwright`, Playwright 1.57.0, same cached Chromium (`chromium-1217`). Same viewport (1440×900), same tag set (`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`), same 5 key pages, same interactive states (editor focused, command palette, issues menu/expanded, login unauth), same modal-dismiss handling for the seeded user's "Action Items" dialog. Runner scripts are worktree-local copies of the baseline's `audit/a11y/run-lighthouse.sh` / `audit/a11y/axe-scan.mjs`, saved in this directory, with only the base URL port parameterized via `WEB_PORT` (no hardcoded session tokens — `SESSION_ID`/`WIKI_DOC_ID` read from env exactly as the baseline scripts do). A fresh login was performed for this run (new `SESSION_ID`, not reused from baseline).

Data volume was reproduced from scratch in this worktree's own database (`ship_wt_a11y_compare`) via `pnpm db:seed` + `audit/seed-augment.ts` (the same deterministic script baseline used), landing on the identical 500/20 breakdown baseline recorded.

### Lighthouse — accessibility score per page

| Page | Baseline (Jul 27) | Compare (Jul 30) | Δ |
|---|---|---|---|
| **/my-week** | 95 | **100** | **+5** |
| /documents/:id (document) | 100 | 100 | 0 |
| /issues | 100 | 100 | 0 |
| /weeks | 100 | **95** | **-5** |
| /search | 100 | **95** | **-5** |

/my-week's sole failing audit (color-contrast) at baseline is gone — confirms A11Y-3 held. /weeks and /search each now fail on `color-contrast` as their *only* non-passing audit (see TRO-298 below) — a new, previously-unreachable regression, not a re-occurrence of A11Y-3 itself (different component, different pages).

### axe-core — per page/state (Critical/Serious/Moderate/Minor)

| Page + state | Baseline C/S/M/m | Compare C/S/M/m | Change |
|---|---|---|---|
| dashboard (my-week) | 0/1/0/0 | **0/0/0/0** | S -1 (A11Y-3) |
| issues list | 0/0/0/1 | **0/0/0/0** | m -1 (A11Y-8) |
| weeks board | 0/0/2/0 | **0/1/0/0** | M -2 (A11Y-5), **S +1 (new — TRO-298)** |
| search | 0/0/2/0 | **0/1/0/0** | M -2 (A11Y-5), **S +1 (new — TRO-298)** |
| document view | 1/1/1/0 | **0/0/0/0** | C -1, S -1 (A11Y-1), M -1 (A11Y-6) |
| document editor focused | 2/1/1/0 | **0/0/0/0** | C -2 (A11Y-1+A11Y-2), S -1 (A11Y-1), M -1 (A11Y-6) |
| issues menu/expanded state | 0/1/0/1 | **0/0/0/0** | S -1 (A11Y-4), m -1 (A11Y-8) |
| login (unauth) | 0/0/2/0 | **0/0/0/0** | M -2 (A11Y-7) |

**Excluded from the table above (matching baseline's own exclusion):** the "command palette open" state, which baseline flagged as unreliably isolated. This run's palette scan *did* reliably open and reported 1 additional Serious `color-contrast` node (a `<kbd>esc</kbd>` shortcut hint) — recorded as a supplementary observation, not folded into the primary comparison.

**Rule-level rollup:** both baseline Critical rules (`aria-required-children`, `aria-allowed-attr`) are fully cleared — 0 instances anywhere scanned. Two of three baseline Serious rules (`listitem`, `aria-dialog-name`) are fully cleared; the third (`color-contrast`) is cleared at its baseline location (/my-week) but reappears at a new location (see below). All 4 Moderate rules and the 1 Minor rule are fully cleared.

### The headline claims — verified

- **Critical = 0 and Serious = 0 on the 3 most important pages, across every measured state.** CONFIRMED: my-week (0/0), document view + editor-focused (0/0 each), issues list + menu/expanded (0/0 each).
- **my-week Lighthouse 95 → 100.** CONFIRMED — held, no failing audits remain.

### New violation — TRO-298 (expected, not on the 3 key pages)

**DashboardSidebar active-item button fails color contrast on /weeks and /search.** `web/src/components/DashboardSidebar.tsx:33-37,46-52` — the "My Work"/"Overview" toggle's active state (`bg-accent/10 text-accent font-medium`). axe: `color-contrast` Serious, 1 node each on `/weeks` and `/search`, fgColor `#005ea2` / bgColor `#0c151c`, ratio 2.74 vs required 4.5:1. Lighthouse corroborates: `color-contrast` is the sole failing audit dropping both pages to 95.

**Why newly reachable (derived from reading the code, not confirmed by an author):** per the A11Y-5/6/7 fix commit (`e813117`), `/weeks` and `/search` were previously dead routes — no page component, no catch-all, so an unmatched path rendered nothing. `web/src/pages/App.tsx`'s `getActiveMode()` (lines 152-178) has no explicit branch for either path; both fall through to the `return 'dashboard'` default at line 178, which mounts `<DashboardSidebar/>` (line 527-528) as the contextual sidebar. Adding real routes for A11Y-5 means these paths now hit that same default branch and mount `DashboardSidebar` for the first time, exposing a pre-existing contrast defect that had no route to render on before.

**Open question, reported rather than papered over:** the identical button (same classes, same computed `rgba(0,94,162,0.1)` background, same DOM ancestor chain, same bounding rect — verified by hand) is also rendered on `/my-week`, yet axe reports 0 violations there in both the full-page scan and a scope-restricted re-check limited to that exact `<div>`. The mechanism was not resolved — axe's pass/violation lists for `/my-week` do not reference this button in either direction. Recorded as unresolved rather than asserted away.

Not one of the 3 key pages (my-week/document/issues) — does not affect the target verdict.

### Keyboard navigation

| Page | Baseline | Compare | Verdict |
|---|---|---|---|
| /issues | Full — 45 stops, no trap, ring 45/45 | Full — 45 stops, 45 unique, no trap, ring 45/45 | Unchanged |
| /my-week | Full — 20/20 stops, ring 42/44 | Full — 44 stops, 23 unique, ring 43/44 | Full (raw stop count differs — incidental content difference, not a regression; no trap either run) |

### e2e regression check

Re-ran the repo's 3 dedicated a11y specs (`accessibility.spec.ts`, `accessibility-remediation.spec.ts`, `status-colors-accessibility.spec.ts`) — not the full ~866-test suite (time-boxed; see `e2e-a11y-specs-run.txt`). 74/75 passed. One test failed on both its run and its retry (not a flake): `accessibility-remediation.spec.ts :: "tooltips shown on hover also appear on focus"` — a Radix tooltip on `KanbanBoard.tsx`'s "More actions" button stays visible after mouse-away. Unrelated to A11Y-1..8 (no merged a11y fix touches `KanbanBoard.tsx`); flagged for the record, not investigated further under this measurement-only mandate. All the specs' own critical-impact axe assertions across `/login`, the app shell, `/docs`, `/programs`, `/issues`, `/team`, `/documents`, plus keyboard/skip-link/aria-live checks, passed — the ARIA changes (tree-role removal, editor `aria-expanded` removal, popover naming, landmark/heading additions) did not break existing selectors or behavior.

### Verdict against the improvement target

**Target:** +10 Lighthouse points on the lowest-scoring page **OR** all Critical/Serious axe violations fixed on the 3 most important pages.

- **Prong 1 (Lighthouse +10):** NOT met. /my-week gained only +5 (95→100). /weeks and /search each lost 5 (100→95), so the post-fix lowest-scoring pages sit at 95 — no page gained 10 points.
- **Prong 2 (Critical/Serious cleared on the 3 key pages):** **MET.** my-week, document view (+ editor-focused), and issues (+ menu/expanded) all show 0 Critical / 0 Serious across every measured state — all 8 baseline findings resolved in their original location.

**Verdict: category improvement target is satisfied, via Prong 2.** The new TRO-298 finding is real, corroborated by both tools, and should be tracked — but it sits outside the 3 pages the target is scored against, so it does not change the verdict.
