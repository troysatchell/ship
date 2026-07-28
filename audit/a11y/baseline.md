## Accessibility Compliance — Baseline

**Commit:** `076a183` (dirty: audit/memory-bank/.claude only) · **Date:** 2026-07-27 · **App:** web `http://localhost:5173` (authenticated as `dev@ship.local`) · **Data:** 500 documents / 20 users.

> **Compliance context:** Ship is deployed at `ship.awsdev.treasury.gov` — a federal (U.S. Treasury) application, so **Section 508 / WCAG 2.1 AA conformance is effectively mandated**. Under that bar, every **Critical** and **Serious** axe violation below is a conformance failure, not a nice-to-have. The repo is already pursuing this (dedicated `e2e/accessibility.spec.ts`, `accessibility-remediation.spec.ts`, `status-colors-accessibility.spec.ts`).

### Methodology

Three measurement layers, all against the live seeded app on an authenticated session:

1. **Existing infra (recorded, not re-run):** the repo ships 3 axe/keyboard specs. They scan `/login`, the app shell, `/docs`, `/programs`, `/issues`, `/team`, `/documents`, plus keyboard/skip-link/aria-live checks — but every axe assertion filters to **`impact === 'critical'`** (`expect(critical).toEqual([])`). Serious/Moderate/Minor violations pass those specs by construction. They run under the e2e testcontainer+vite-preview harness (a different DB/build), so this baseline did not execute them; the independent scan below runs the truthful superset and is what compare-mode will diff.
2. **Lighthouse 11.7.1** (`npx lighthouse --only-categories=accessibility --preset=desktop`, authenticated via `--extra-headers` Cookie, driven against Playwright's Chromium 147). Score per key page. Reports in `audit/a11y/lighthouse/*.report.html|json`.
3. **axe-core 4.11.0** via `@axe-core/playwright` (tags `wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`) across **every key page AND interactive states** (editor focused, menu/expanded, login), plus keyboard-navigation and accessibility-tree probes. Runner: `audit/a11y/axe-scan.mjs`; raw per-state output in `audit/a11y/axe/`.

**State note:** the seeded dev user has an overdue action item, so an **"Action Items" `role=dialog` auto-opens on every navigation and traps focus**. It is correctly labelled and **Escape closes it** (`escapeClosed: true`), so it is not itself a finding — but page and keyboard scans dismiss it first so they measure the underlying page, not the modal. (An earlier pass that left it open produced a false "focus trap, only 3 tab stops" reading — corrected here.) The "command palette open" state did not reliably isolate the palette overlay and is excluded from findings; its violations are already covered by the document-view/editor states.

### Deliverable table

| Metric | Baseline |
|---|---|
| Lighthouse a11y score per page | **/my-week 95** · /documents/:id 100 · /issues 100 · /weeks 100 · /search 100 |
| Total Critical / Serious (axe) | **2 Critical rules** (`aria-required-children`, `aria-allowed-attr`) · **3 Serious rules** (`color-contrast`, `listitem`, `aria-dialog-name`) |
| Total Moderate / Minor (axe) | **4 Moderate** (`landmark-one-main`, `page-has-heading-one`, `heading-order`, `region`) · **1 Minor** (`empty-table-header`) |
| Keyboard navigation per page | **/issues: Full** (45 tab stops, no trap, focus ring on 45/45) · **/my-week: Full** (20/20 stops, focus ring 42/44). Action-Items modal traps focus correctly & Escape-dismisses. |
| Color contrast failures | **25 nodes on /my-week** — `text-[11px] text-muted/50` timestamps + `bg-accent/20` badges below 4.5:1 (worst and only contrast offender) |
| Missing ARIA labels/roles | `role="tree"` sidebar with non-treeitem `<li>` children (every page); `aria-expanded` on a non-widget editor `<div>`; unnamed Radix dialog (/issues); 1 unlabeled input + 28 unlabeled `<svg>` on document view |

**Per-state axe counts (C/S/M/m):** dashboard `0/1/0/0` · issues `0/0/0/1` · weeks `0/0/2/0` · search `0/0/2/0` · document view `1/1/1/0` · editor focused `2/1/1/0` · issues menu open `0/1/0/1` · login (unauth) `0/0/2/0`.

### The headline: Lighthouse ≠ conformance

Lighthouse rates 4 of 5 key pages a perfect 100 and the 5th a 95, which would read as "essentially compliant." axe on the same pages **plus interactive states** finds **2 Critical + 3 Serious** rule violations — because Lighthouse scans a single static viewport and doesn't mount the focused editor or open menus, and the repo's own specs only fail on `critical` impact. The claim "WCAG AA" is not supported by the generous score; the axe evidence is the truth.

### Findings (ranked)

1. **A11Y-1 · High — Sidebar `role="tree"` contains plain `<li>` nav links, not treeitems.** `<ul role="tree" aria-label="Workspace documents" aria-live="polite">` has `li[tabindex]`/filter-link children (`/docs?filter=workspace`) → axe **Critical** `aria-required-children` + **Serious** `listitem`. On **every authenticated page**. Fix: real treeitem semantics or drop `role="tree"`.
2. **A11Y-2 · High — `aria-expanded` on a non-widget editor `<div>`.** `.tiptap-wrapper > div … aria-expanded="false"` → axe **Critical** `aria-allowed-attr`, on the core editing surface for all document types.
3. **A11Y-3 · High — /my-week fails contrast on 25 elements** (`text-muted/50` 11px, `bg-accent/20` badges) → axe **Serious** + the only Lighthouse-failing page (95). The improvement-target page.
4. **A11Y-4 · Medium — Radix popover opens as an unnamed `role=dialog`** on /issues → axe **Serious** `aria-dialog-name`.
5. **A11Y-5 · Medium — /search and /weeks have no `<main>` landmark and no h1** → axe **Moderate** ×2 (near-empty renders, corroborated by error-handling probe1b).
6. **A11Y-6 · Medium — document pages skip heading levels (h1 → h3)** → axe **Moderate** `heading-order`.
7. **A11Y-7 · Low — login form content not in a landmark / no main** → axe **Moderate** `region`+`landmark-one-main`; **passes the repo's critical-only spec** — exactly what those specs miss.
8. **A11Y-8 · Low — issues table selection column has an empty `<th>`** → axe **Minor** `empty-table-header`.

### Recommended improvement plan

Improvement target: **+10 Lighthouse pts on the lowest page OR all Critical/Serious axe violations fixed on the 3 most important pages.** Recommended attack:

1. **A11Y-3 (contrast)** — raise the `text-muted/50` and `bg-accent/20` tokens to meet 4.5:1. Directly buys the **+10 Lighthouse pts on /my-week** (95 → 100 expected) with before/after Lighthouse reports as proof.
2. **A11Y-1 (tree semantics)** — clears both Critical `aria-required-children` and Serious `listitem` in one fix, on every page; re-run axe on document view + issues to show 0 Critical.
3. **A11Y-2 (editor `aria-expanded`)** — clears the second Critical on the editor surface.

Evidence per fix: before/after Lighthouse (A11Y-3) or before/after axe rule counts (A11Y-1/2), then re-run the repo's 3 a11y specs + the full e2e suite (ARIA changes can break selectors/behavior).
