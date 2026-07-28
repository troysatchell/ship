## Test Coverage & Quality — Baseline

**Category:** `test-quality` · **Finding prefix:** `TEST` · **Mode:** baseline
**Repo:** `/Users/troy/repos/GAUNTLET/Ship` · **Commit:** `076a18371da0a09f88b5329bd59611c4bc9536bb` (dirty: audit/, memory-bank/, .claude/, .gitignore only — no application source modified)
**Date:** 2026-07-27

---

### Methodology

Environment stamped from `audit/shipshape.config.yaml` `environment:` block. Every number below comes from a recorded command; raw outputs are in `audit/test-quality/runs/`.

**Unit / integration suites**

```bash
# api (28 files) — NOTE: run against an ISOLATED database, see scaffolding
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_unit_audit \
  ./node_modules/.bin/vitest run --root api --reporter=json --outputFile.json=<f>
# repeated 3x clean + 3x under NODE_V8_COVERAGE + 1 initial = 7 runs total

# web (16 files) — NOT run by root `pnpm test`
pnpm --filter @ship/web exec vitest run --reporter=json --outputFile.json=<f>   # x2
```

**E2E suite** — 3 identical runs, workers pinned for determinism (the config's auto-sizing is
non-deterministic; see TEST-9):

```bash
PLAYWRIGHT_WORKERS=4 PLAYWRIGHT_JSON_OUTPUT_NAME=<f> \
  ./node_modules/.bin/playwright test --reporter=json,./e2e/progress-reporter.ts
```

First-attempt outcomes are read from `results[0].status` of the Playwright JSON report
(`scratchpad/pwparse.mjs`), because `retries: 1` locally / `2` in CI rewrites the headline
pass count. Test-level failure text extracted from the same JSON (`errdump.mjs`), not from
`test-results/errors/`, because that directory is never cleared between runs.

**Code coverage** — `pnpm --filter @ship/api test:coverage` fails (`MISSING DEPENDENCY
'@vitest/coverage-v8'`, log: `runs/api-coverage-attempt.log`). The npm registry is blocked in
this environment, so the provider could not be installed (baseline mode would not install it
anyway). Substitute measurement: raw V8 coverage via `NODE_V8_COVERAGE=<dir> vitest run`,
reduced by `scratchpad/v8cov.mjs` (function coverage = share of V8 function records with
`ranges[0].count > 0`, excluding the module top-level record). Offsets refer to
vitest-transformed sources, so byte coverage is an inflated upper bound; **function coverage is
the number to cite**. Web could not be measured at all — the jsdom environment emits no V8
coverage records for `web/src/*` under either the threads or forks pool.

**Static counts** (identical greps must be reused in compare mode):

```bash
grep -rn "waitForTimeout" e2e --include='*.spec.ts' | wc -l          # 619
grep -rn "if (await " e2e --include='*.spec.ts' | wc -l              # 98
node scratchpad/vacuous.mjs e2e     # brace-scanner: tests whose every expect() is conditional
./node_modules/.bin/playwright test --list --reporter=json           # 869 specs / 71 files
```

**Sampling rule for the assertion spot-check** (reproducible): all 869 spec titles dumped in
`playwright test --list` order, then `awk 'NR%87==1'` → 10 tests.

---

### Deliverable table

| Metric | Baseline |
|---|---|
| Total tests (unit / e2e) | **602 unit** (451 api + 151 web) / **869 e2e** (71 spec files) |
| Pass / Fail / Flaky — unit | 589 pass / **13 fail** (all web) / 1 flaky (`weeks.test.ts`, 1 fail in 7 runs) |
| Pass / Fail / Flaky — e2e | 3-run union: **858 clean in all 3 runs** / 0 always-fail / **11 flaky**; 1 of those failed both attempts in 2 of 3 runs |
| Suite runtime (unit / e2e) | api 12.0 s, web 1.7 s / e2e **541 s / 568 s / 543 s** wall (4 workers, ~9 min per run) |
| Retries configured? | **Yes — `retries: 2` in CI, `1` locally** (`playwright.config.ts:60`). Retries erased 7 / 5 / 2 first-attempt failures across the three runs. |
| Critical flows with zero coverage | Concurrent multi-client editing / Yjs merge; `/dashboard`; `/team/org-chart`; global search UI (API-only); single-document delete |
| Code coverage % per package | api **51.4 % function** (398/774; 7 of 79 modules never loaded) — *approximated, tooling broken*; web **unmeasurable** (no coverage config, no provider); shared **0 %** (no tests, no test script) |
| Tests that can pass with zero assertions | **68 of 866** static e2e blocks (7.9 %) — 3 with no `expect()` at all, 65 whose every `expect()` is inside a conditional |
| CI enforcement | **None.** No `.github/workflows/`, no GitLab/Jenkins/CodeBuild config anywhere in the repo. |

---

### Flow-coverage matrix

"Covered" = a regression in that flow would fail a test. "Smoke" = the page/route loads and
something is visible, but behaviour is not asserted.

| Flow | Entry point | Status | Evidence |
|---|---|---|---|
| Load main page | `/` → redirects to `/my-week` (`web/src/main.tsx:214`) | **Smoke** | `/` is visited by 4 tests (auth redirect, accountability banner ×2, spike-isolated). `/my-week` appears in exactly one spec file (`e2e/my-week-stale-data.spec.ts`). Nothing asserts the landing page's own content. |
| View a document | `/documents/:id/*` | **Covered** | `documents.spec.ts`, `document-workflows.spec.ts`, `data-integrity.spec.ts` (persistence of formatting, nested structure, images, mentions) |
| List issues | `/issues` | **Covered** | `issues.spec.ts` (14), `bulk-selection.spec.ts` (85), `issues-bulk-operations.spec.ts`; 152 direct navigations |
| Load sprint / week board | `/team/allocation`, program week UX | **Covered but hollow** | `program-mode-week-ux.spec.ts` has 66 tests — **33 of them assert only inside conditionals** (TEST-2) |
| Search content | Command palette (⌘K) — there is no `/search` route | **Partial (API only)** | `search-api.spec.ts` has 4 API tests. UI search is touched only for a11y dialog role, focus trap, tooltip, and one private-doc visibility case. No test asserts a query returns the right documents or that selecting a result navigates. |
| Auth: login / logout / session | `/login`, session timeout | **Covered** | `auth.spec.ts` (7), `session-timeout.spec.ts` (58), `authorization.spec.ts` (17) |
| Permissions & visibility | private docs, workspace roles | **Covered, with holes** | `private-documents.spec.ts` (20), `security.spec.ts` (18), `authorization.spec.ts` (17) — but `security.spec.ts:217` (XSS) and `authorization.spec.ts:299` (audit-log access) can both pass with zero assertions |
| Create / edit documents & issues | list pages + editor | **Covered** | create + rename asserted in `documents.spec.ts`, `issues.spec.ts` |
| Delete / archive | bulk bar, doc tree | **Partial** | Bulk archive/delete/undo for issues is well covered (`bulk-selection.spec.ts`). Single-document delete from the doc tree has only a *tooltip* test (`tooltips.spec.ts:57`), which is itself vacuous. |
| **Real-time collaboration / Yjs merge** | `/collaboration/{docType}:{docId}` | **Uncovered** | 11 tests mention collaboration/WebSocket, but only `mentions.spec.ts:374` opens a second client — via `browser.newPage()` (same context, sequential), with every assertion inside `if (await option.isVisible())`, and it flaked in run 2. Only `security.spec.ts` and `private-documents.spec.ts` use `browser.newContext()`, neither for editing. **No test performs concurrent edits from two clients and asserts the merged result.** |
| Offline queue / IndexedDB | image upload, edits | **Partial** | `images.spec.ts` (queue when offline, clear IDB after upload), `race-conditions.spec.ts` (offline edits sync, slow network) |
| Dashboard page | `/dashboard` (`DashboardPage`) | **Zero** | 0 occurrences of `/dashboard` or `DashboardPage` in any of the 71 spec files. (A web unit test `web/src/pages/Dashboard.test.tsx` exists — and is one of the 13 the root `pnpm test` never runs.) |
| Org chart | `/team/org-chart` (`OrgChartPage`) | **Zero** | 0 occurrences of `org-chart` / `orgchart` in `e2e/`; no unit test either |
| Projects list | `/projects` (`ProjectsPage`) | **Smoke** | exactly one navigation, `document-workflows.spec.ts:162` |

---

### E2E flakiness — 3 identical runs, first-attempt outcomes

All three runs: 869 tests, 4 workers, same commit, same machine, dev servers left running throughout.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Wall clock | 541 s | 568 s | 543 s |
| Playwright-reported duration | 539.9 s | 567.4 s | 542.8 s |
| **As the runner reports it** (post-retry) | 861 pass / 1 fail / 7 flaky | 864 pass / 0 fail / 5 flaky | 866 pass / 1 fail / 2 flaky |
| **First-attempt failures** | **8** | **5** | **3** |
| Failures erased by the retry | 7 | 5 | 2 |

**11 distinct tests** produced a non-clean outcome in at least one run; **858 of 869 were clean in
all three**. `P` = passed first attempt, `F` = failed, `T` = timed out (`runs/e2e-flake-union.txt`):

| R1 R2 R3 | Final verdict per run | Test | Smell |
|---|---|---|---|
| `T T F` | flaky / flaky / flaky | `my-week-stale-data.spec.ts` › retro edits are visible on /my-week after navigating back | **Failed the first attempt in 100 % of runs and was hidden every time.** Times out waiting for a "create retro for this week" button — order/shared-state dependence on whether another test in the worker already created that week's retro. |
| `F P F` | **FAIL** / pass / **FAIL** | `inline-comments.spec.ts:118` › canceling a comment removes the highlight | Failed *both* attempts in 2 of 3 runs. Real app bug candidate → **TEST-5** |
| `P F F` | pass / flaky / flaky | `mentions.spec.ts:374` › should sync mentions between collaborators | The only cross-client test in the suite; timing (`waitForTimeout(2000/3000)`) plus a mention popup that may not open |
| `F F P` | flaky / flaky / pass | `weekly-accountability.spec.ts:469` › Allocation grid shows person with assigned issues and plan/retro status | Real race candidate — grid returns `planId: null` right after the plan is created → **TEST-6** |
| `P F P` | pass / flaky / pass | `bulk-selection.spec.ts` › shift+down then shift+up contracts selection | Keyboard timing |
| `P T P` | pass / flaky / pass | `my-week-stale-data.spec.ts` › plan edits are visible on /my-week after navigating back | Same shape as the retro variant |
| `F P P` | flaky / pass / pass | `performance.spec.ts:410` › many images do not crash the editor | `waitForEvent('filechooser')` timed out at 45 s — slash-command timing |
| `F P P` | flaky / pass / pass | `programs.spec.ts:212` › program cards show emoji or initial badges | Element not found in a 2 000 ms window — timeout too tight for a cold render |
| `F P P` | flaky / pass / pass | `project-weeks.spec.ts` › project link in Properties sidebar navigates back to project | Element not found in 5 000 ms after API-side setup — read-after-write timing |
| `F P P` | flaky / pass / pass | `status-overview-heatmap.spec.ts` › displays split cells for plan/retro status | Needs a weekly plan to exist — shared-state dependence |
| `F P P` | flaky / pass / pass | `team-mode.spec.ts` › clicking collapsed header expands the group | Needs an "Unassigned N" group to exist — shared-state dependence |

Dominant smells, in order: **shared state between tests inside a worker's database** (5),
**fixed short timeouts / `waitForTimeout`** (4), **real app races** (2, cross-filed).

---

### Assertion-quality spot-check (10 tests, `awk 'NR%87==1'` sample)

| # | Test | Verdict |
|---|---|---|
| 1 | `accessibility-remediation.spec.ts` › status indicators have icons not just colors | **Meaningful** — asserts count > 0 and one `svg` per indicator |
| 2 | `admin-workspace-members.spec.ts:87` › can change member role | **Vacuous** — the only `expect` is inside `if (await roleSelect.isVisible())` |
| 3 | `bulk-selection.spec.ts:784` › k key moves focus to previous item | **Meaningful** — asserts the focus ring moves *and* leaves the old row |
| 4 | `data-integrity.spec.ts:324` › mentions survive document reload | **Conditional** — whole body guarded by `if (await firstOption.isVisible())` |
| 5 | `features-real.spec.ts:185` › uploaded image persists after page reload | **Conditional** — `waitForEvent('filechooser').catch(() => [null])` then `if (fileChooser)`; a broken file picker makes this a green no-op |
| 6 | `issue-estimates.spec.ts:67` › shows hours label/hint next to estimate field | **Smoke** — `getByText('hours')` visibility only |
| 7 | `private-documents.spec.ts:523` › mention of private doc shows placeholder for non-creator | **Meaningful** (asserts `status === 404`) but the title describes UI the test never looks at |
| 8 | `project-weeks.spec.ts:104` › shows allocated team members in the grid | **Meaningful** — seeds allocations via API, asserts the person renders |
| 9 | `session-timeout.spec.ts:465` › shows "session expired" message after timeout | **Smoke** — navigates straight to `/login?expired=true`; the timeout itself is never exercised |
| 10 | `team-mode.spec.ts:149` › can click cell to open program selector | **Conditional** — branches on `hasEmptyCell`, data-dependent |

**Ratio: 4 / 10 assert a meaningful outcome; 2 / 10 are visibility-only smoke; 4 / 10 can execute
zero assertions depending on page state.**

By contrast the **api unit suite is clean**: 1 100 `expect()` calls, **0** conditional guards,
and 356 body/state assertions vs 263 status-only.

---

### Findings

#### TEST-1 — High — 13 web unit tests are failing, and nothing in the repository ever runs them

**Location:** `package.json:27`; `web/src/lib/document-tabs.test.ts`,
`web/src/components/editor/DetailsExtension.test.ts`, `web/src/hooks/useSessionTimeout.test.ts`

**Evidence:** `pnpm --filter @ship/web exec vitest run` → **13 failed / 138 passed / 151 total**,
3 of 16 files, reproduced identically on two runs (`runs/web-unit-failures.log`,
`runs/web-unit-run1.json`). Meanwhile the root script is
`"test": "pnpm --filter @ship/api test"` — it runs only `@ship/api` and reports **451/451 green**.
There is no CI: `.github/` contains only `instructions/`, there is no `workflows/` directory, and
no `.gitlab-ci.yml` / `Jenkinsfile` / `buildspec.yml` anywhere in the tree. `.husky/pre-commit`
runs `check-empty-tests.sh`, `check-api-coverage.sh` and `comply opensource` — **it never executes
a test suite.**

**Hypothesis:** the sprint→week rename landed in `web/src` (source now emits tab id `weeks` with
label `Weeks (n)`, `document-tabs.tsx:115-116`) while `document-tabs.test.ts:25,34,97,114,160`
still asserts `'sprints'`; `DetailsExtension.ts:48` changed `content` to
`'detailsSummary detailsContent'` while `DetailsExtension.test.ts:16` still asserts `'block+'` and
constructs an `Editor` without the sibling nodes, so ProseMirror throws. Both drifts are exactly
what a CI run would have caught on the commit that introduced them. Nothing did.

**Estimated impact:** the repository currently has **no automated regression gate at all**. Making
the root `test` script recursive and adding a CI workflow converts 13 silent failures into visible
ones on day one, and is the precondition for every other improvement in this category.

---

#### TEST-2 — High — 68 e2e tests (7.9 %) can pass without executing a single assertion, including a security and an authorization test

**Location:** `e2e/program-mode-week-ux.spec.ts` (33 of its 66 tests), `e2e/security.spec.ts:217`,
`e2e/authorization.spec.ts:299`, `e2e/context-menus.spec.ts` (6),
`e2e/accessibility-remediation.spec.ts` (6), `e2e/features-real.spec.ts` (5); full list in
`runs/e2e-vacuous-tests.txt`

**Evidence:** brace-scanner over 866 static test blocks (`runs/vacuous.mjs`): **3 tests contain no
`expect()` at all**, **65 more have every `expect()` nested inside a conditional**. Supporting
counts: 98 `if (await …)` guards and 35 `count`/`length` comparisons across `e2e/`.

Two worked examples:

- `security.spec.ts:217` *XSS via data: URI in links* — types a markdown link with a
  `data:text/html` payload, then loops over rendered `<a>` elements and asserts only
  `if (href?.startsWith('data:'))`. It never asserts a link was created, so **zero `<a>` elements
  produces a green test**. It cannot distinguish "the app sanitised the URI" from "the app
  rendered nothing".
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs (admin only)* —
  the `expect(response.status()).toBe(403)` sits inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` silently skips the entire
  authorization check.

**Hypothesis:** the guards were added to stop tests failing on missing seed data — the same failure
mode `.claude/CLAUDE.md` already forbids for `test.skip()` ("use assertions with clear messages
instead"). The rule was written for `test.skip()` and never extended to `if`-guards, so the
practice migrated rather than stopped. `bulk-selection.spec.ts:793` shows the correct pattern in
the same repo: `expect(rowCount, 'Seed data should provide at least 2 issues…').toBeGreaterThanOrEqual(2)`.

**Estimated impact:** 7.9 % of the e2e suite provides no signal. Two of those tests are the only
automated checks for a stored-XSS vector and for member-level audit-log access.

---

#### TEST-3 — High — retries hide a test that fails on first attempt in 100 % of runs; 11 tests flaked across 3 identical runs

**Location:** `playwright.config.ts:60` (`retries: process.env.CI ? 2 : 1`); flake list in
`runs/e2e-flake-union.txt`

**Evidence:** three identical 869-test runs (see the flakiness table above). Counting only the
first attempt of each test, **8 / 5 / 3** tests failed. After retries the runner reported
**1 / 0 / 1** failures — retries erased **7 / 5 / 2** failures respectively.
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`
**failed or timed out on the first attempt in all three runs** and was reported as passing all
three times. Root-cause smells are dominated by shared state inside a worker's database (5 tests
depend on data another test may or may not have created) and fixed short timeouts (4).

**Hypothesis:** `retries: 1` locally was introduced "for flaky WebSocket/timing tests" (the config
comment says so). It works — the suite looks green — which removes the pressure to fix the
underlying order-dependence, so the flake set grows. The suite has 619 `waitForTimeout` calls
across 49 of 71 spec files; that is the accumulated cost of treating flakes as timing problems.

**Estimated impact:** a real regression in any of these 11 paths would be retried into green. The
improvement target (3 flakes fixed with root cause) is directly available here.

---

#### TEST-4 — High — concurrent multi-client editing / Yjs merge has no test

**Location:** `e2e/mentions.spec.ts:374` is the only cross-client test; `api/src/collaboration/index.ts`

**Evidence:** 11 tests mention collaboration / WebSocket / real-time (all listed in
`runs/e2e-flake-union.txt` methodology), but they cover connection establishment, a status
indicator, and reconnection. `browser.newContext()` appears in only 2 of 71 spec files
(`security.spec.ts`, `private-documents.spec.ts`), neither for editing.
`mentions.spec.ts:374` is the sole two-client test: it uses `browser.newPage()` (same browser,
sequential not concurrent), every assertion sits inside `if (await option.isVisible())`, it relies
on `waitForTimeout(2000)` + `waitForTimeout(3000)` for sync, and it first-attempt-failed in 2 of 3
runs. **No test performs concurrent edits from two clients and asserts the merged result.**
Independently, `api/src/collaboration/index.ts` sits at **25.0 % function coverage** (7 of 28
functions) in the api unit suite.

**Hypothesis:** cross-client tests are expensive and slow, so coverage stopped at "the socket
connects". The CRDT merge behaviour — the whole justification for the Yjs architecture in
`docs/unified-document-model.md` — is verified by nothing.

**Estimated impact:** a Yjs or persistence regression that silently drops one client's edits would
ship green. This is the highest-value place to spend the "3 meaningful new tests" target.

---

#### TEST-5 — Medium (escalate: real app bug candidate) — canceling an inline comment leaves an orphaned `comment-highlight` mark in the document

**Location:** `e2e/inline-comments.spec.ts:118-132`; `web/src/components/editor/CommentDisplay.tsx:181,185-188,315-318`;
`web/src/components/Editor.tsx:668-671`; `web/src/components/editor/CommentMark.ts:69`

**Evidence:** the only test that failed **both** attempts, and it did so in runs 1 and 3 (passed in
run 2). The failure output shows the locator resolving 14 consecutive times over a 10 s window to
`<span class="comment-highlight" data-comment-id="1140cc9f-f225-46a8-b3b3-2327ad18741f">comment that gets canceled</span>`
after `Escape` was pressed (`runs/e2e-run1-failures.txt`, `runs/e2e-run3-failures.txt`).

**Hypothesis:** the Escape handler is bound to a `.comment-pending-field` `<input>` rendered inside
a `Decoration.widget` and auto-focused in a `requestAnimationFrame`
(`CommentDisplay.tsx:185-188`); when focus has not landed yet, the keypress never reaches
`onCancelComment` → `editor.commands.unsetComment(commentId)`. `comment-highlight` is a **TipTap
Mark, i.e. document content** (`CommentMark.ts:69`), not a decoration — so the leftover span is
persisted to `documents.content` and synced through Yjs, pointing at a comment that was never
created.

**Estimated impact:** document-content pollution on a plausible user action (start a comment,
change your mind). Cross-file to `error-handling` for confirmation of the focus race.

---

#### TEST-6 — Medium (escalate: real race candidate) — allocation grid returns `planId: null` immediately after the plan is created

**Location:** `e2e/weekly-accountability.spec.ts:469`;
`GET /api/weekly-plans/project-allocation-grid/:projectId`

**Evidence:** first-attempt failure in runs 1 and 2. `expect(week1Data.planId).toBe(plan.id)`
received `null` on a `GET` issued immediately after a successful weekly-plan `POST` in the same
test, against the worker's own isolated Postgres container.

**Hypothesis:** the grid endpoint joins plans to allocations on a key the just-created plan does
not yet satisfy (week assignment written in a separate statement), so a read that immediately
follows the write sees the allocation but not the plan.

**Estimated impact:** a user creating a weekly plan may see their own plan missing from the
allocation grid on the next render. Cross-file to `db-query` / `api-perf`.

---

#### TEST-7 — Medium — coverage measurement is broken in api and entirely absent in web

**Location:** `api/vitest.config.ts:12-16`, `api/package.json:16`, `web/vitest.config.ts`,
`pnpm-lock.yaml`

**Evidence:** `pnpm --filter @ship/api test:coverage` exits 1 with
`MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`
(`runs/api-coverage-attempt.log`). The package appears **0 times in `pnpm-lock.yaml`** and is not
in any `node_modules/@vitest` directory — `api/vitest.config.ts` declares `provider: 'v8'` for a
provider that was never installed. `web/vitest.config.ts` has no `coverage` block at all and
`web/package.json` has no `test:coverage` script. `shared/` has **no test script and zero test
files** (0 of 8 source files).

Substitute measurement (raw `NODE_V8_COVERAGE`, `runs/api-v8-coverage.txt`) — **api function
coverage 51.4 % (398 / 774)**, 7 of 79 modules never loaded. Weakest modules:

| Module | Function coverage |
|---|---|
| `api/src/services/ai-analysis.ts` | 7.1 % (1/14) |
| `api/src/services/secrets-manager.ts` | 8.3 % (1/12) |
| `api/src/services/oauth-state.ts` | 11.1 % (1/9) |
| `api/src/routes/programs.ts` | 15.4 % (2/13) |
| `api/src/routes/caia-auth.ts` | 16.7 % (2/12) |
| `api/src/routes/admin-credentials.ts` | 18.2 % (2/11) |
| `api/src/routes/weekly-plans.ts` | 21.4 % (3/14) |
| `api/src/collaboration/index.ts` | 25.0 % (7/28) |
| `api/src/utils/document-crud.ts` | 29.3 % (12/41) |

**Estimated impact:** nobody can see coverage move, so no coverage-based decision is possible. The
registry is blocked in this environment, so this was reported rather than fixed (baseline mode
would not install dependencies regardless).

---

#### TEST-8 — Medium — two shipped routes have zero coverage of any kind

**Location:** `web/src/main.tsx:215` (`/dashboard` → `DashboardPage`), `:240` (`/team/org-chart` →
`OrgChartPage`), `:222` (`/projects`), `:216` (`/my-week`, the target of the `/` redirect at `:214`)

**Evidence:** grep across all 71 spec files — `/dashboard` and `DashboardPage`: **0 occurrences**;
`org-chart` / `orgchart`: **0 occurrences** (and no unit test either). `/projects` is navigated to
**once**, in `document-workflows.spec.ts:162`. `/my-week` — the destination of the `/` redirect,
i.e. the app's landing page — appears in exactly **one** spec file
(`e2e/my-week-stale-data.spec.ts`), whose two tests are both on the flake list.

**Hypothesis:** e2e coverage grew feature-by-feature around `/docs` (162 navigations) and `/issues`
(152); routes added later or reached only via redirect were never picked up.

**Estimated impact:** the landing page and the org chart can break without any test noticing.
`/dashboard` does have `web/src/pages/Dashboard.test.tsx` — one of the 13 tests the root `pnpm test`
never runs (TEST-1).

---

#### TEST-9 — Medium — `pnpm test` TRUNCATEs whatever database `DATABASE_URL` points at

**Location:** `api/src/test/setup.ts:14-20`, `api/src/db/client.ts:10`

**Evidence:** `setup.ts` runs, in the `beforeAll` of **every one of the 28 api test files**,
`TRUNCATE TABLE workspace_invites, sessions, files, document_links, document_history, comments,
document_associations, document_snapshots, sprint_iterations, issue_iterations, documents,
audit_logs, workspace_memberships, users, workspaces CASCADE`. `client.ts:10` builds the pool from
`api/.env.local` — the same file `scripts/dev.sh` writes pointing at the developer's dev database.
There is no `.env.test` and no test-specific override. Confirmed operationally: this audit had to
create a separate `ship_unit_audit` database (schema-only `pg_dump` of `ship_dev`) before running
the api suite, because running it as documented would have destroyed the 500-document seeded
dataset the other audit categories depend on.

**Hypothesis:** the api suite predates the e2e testcontainers isolation and was never migrated to
it; `fileParallelism: false` in `api/vitest.config.ts` is the workaround for the resulting
cross-file interference.

**Estimated impact:** the sequence documented in `.claude/CLAUDE.md` (`pnpm dev`, then `pnpm test`)
silently wipes the developer's dev database. It also makes the api suite order-dependent, which is
the likeliest explanation for the one api-unit flake observed
(`weeks.test.ts › should accept all valid ratings (1-5)` returned 404 in 1 of 7 runs).

---

#### TEST-10 — Low — e2e worker auto-sizing collapses to 1 worker on macOS

**Location:** `playwright.config.ts:26-56`

**Evidence:** the worker count is derived from `os.freemem()`. Measured on this machine:
`os.totalmem()` 24.0 GB, `os.freemem()` **0.3 GB** (macOS reports almost all RAM as
used/cached/compressed), 14 CPUs → `memoryBasedLimit = floor((0.3 − 2) / 0.5) = −4` →
`Math.max(1, min(−4, 14))` = **1 worker**. Every measurement in this report pins
`PLAYWRIGHT_WORKERS=4`, which is both the CI value and what makes the three runs comparable.

**Estimated impact:** a developer running `pnpm test:e2e` on a Mac gets a single-worker run —
roughly 4× the measured 9 minutes — which is a strong disincentive to run the suite locally at all.

---

#### TEST-11 — Low — stale test-count comment and heavy sleep usage

**Location:** `playwright.config.ts:63`; 49 of 71 spec files

**Evidence:** the config comment advertises `[1/641]`; `playwright test --list` reports **869**
specs across 71 files. `grep -rn "waitForTimeout" e2e --include='*.spec.ts' | wc -l` → **619**
occurrences in 49 files, led by `tables.spec.ts` (52), `file-attachments.spec.ts` (37),
`features-real.spec.ts` (36), `backlinks.spec.ts` (34), `drag-handle.spec.ts` (33),
`data-integrity.spec.ts` (33).

**Estimated impact:** hygiene, but the `waitForTimeout` density is the mechanism behind TEST-3 —
every fixed sleep is a flake waiting for a slower machine.

---

### Recommended improvement plan

Improvement target for this category: **3 meaningful tests for previously-untested critical
paths, OR 3 flaky tests fixed with root-cause analysis.** Both are available; in priority order:

1. **Make the existing suite visible before adding to it (TEST-1).** Change root `test` to
   `pnpm --recursive run test` and add a CI workflow that runs unit + e2e. This alone surfaces
   13 already-broken tests. Expect the change to go red immediately — that is the point.
2. **Fix the 13 web unit failures (TEST-1).** `document-tabs.test.ts` (9) is stale against the
   sprint→week rename; `DetailsExtension.test.ts` (3) asserts a content expression the
   extension no longer uses and builds an editor without the `detailsSummary` node;
   `useSessionTimeout.test.ts` (1) mocks `fetch` without the CSRF pre-flight that
   `fetchWithCsrf` performs, so `apiPost` throws into the force-logout `catch`.
3. **Fix 3 flakes with root causes (TEST-3).** The three that recur are all the same shape:
   `my-week-stale-data` (waits for a "create retro" button that another test's data may have
   already consumed), `weekly-accountability` (reads the allocation grid immediately after
   creating a plan — see TEST-6, likely a real read-after-write race), and `inline-comments`
   (see TEST-5). Fix the app-side causes rather than lengthening timeouts; 619 `waitForTimeout`
   calls is already the accumulated cost of the opposite approach.
4. **Add 3 meaningful tests for the uncovered critical paths (TEST-4, TEST-8):** (a) two
   `browser.newContext()` clients editing the same document concurrently, asserting both
   converge on merged content after reconnect; (b) `/dashboard` rendering seeded data;
   (c) command-palette search returning an expected document and navigating to it. Each must be
   proven meaningful by breaking the guarded behaviour and watching the test fail.
5. **De-vacuum the top offenders (TEST-2).** `program-mode-week-ux.spec.ts` alone holds 33 of
   the 65 conditional-only tests. Replace `if (await x.isVisible())` with a seeded precondition
   plus an unconditional assertion, exactly as `.claude/CLAUDE.md` already mandates for
   `test.skip()`. Start with `security.spec.ts:217` and `authorization.spec.ts:299`.
6. **Restore coverage measurement (TEST-7)** — install `@vitest/coverage-v8`, add a `coverage`
   block and a `test:coverage` script to `web/vitest.config.ts` / `web/package.json`. Until
   then the 51.4 % api function coverage here is the only number anyone has.
