# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-224 — [TEST-2] 68 e2e tests could pass without executing a single assertion

**What was broken.** A brace-scan of 866 static test blocks found **3 tests with no `expect()` at
all** and **65 whose every `expect()` sat inside a conditional** — 7.9% of the suite reporting
success while observing nothing (`audit/test-quality/runs/e2e-vacuous-tests.txt`). Two of them were
the only automated coverage of a security control:

- `security.spec.ts:217` *XSS via data: URI in links* typed `[Click](data:text/html,…)` into a new
  document, then looped over `editor.locator('a')` asserting only inside
  `if (href?.startsWith('data:'))`. **TipTap ships no markdown-link input rule**, so the typed text
  stayed literal, zero `<a>` elements existed, and the loop body never ran. Its sibling *XSS via
  markdown link injection* (`:197`) had the same hole without the `if`. Neither could tell "the app
  sanitised the URI" from "the app rendered nothing" — and the truth was the latter, for the whole
  life of both tests.
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs* buried
  `expect(response.status()).toBe(403)` inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` skipped the entire authorization
  check silently.

The guards had been added to stop tests failing on missing seed data — the same failure mode
`.claude/CLAUDE.md` already forbids for `test.skip()`. The rule was written for `test.skip()` and
never extended to `if`, so the practice migrated instead of stopping.

**What changed.** Nine vacuous tests rewritten, three new tests added, and — because
`gate.sh` runs neither vitest project over `e2e/` — the two security properties were **also** pinned
in tiers the gate executes.

*Security, non-negotiable (both proven red-first — see Evidence):*

- `web/src/components/editor/linkOptions.ts` **(new)** — the app's link-href policy, named and
  exported: `protocols: []` plus an explicit `isAllowedUri` that denies
  `javascript`/`data`/`vbscript`/`file`/`blob` after `defaultValidate`. Behaviourally a **no-op
  today**: `@tiptap/extension-link` 2.27.2 already rejects all five in its default `isAllowedUri`
  and strips the `href` during `renderHTML`. The point is that the protection was *inherited
  silently* — adding a scheme to `protocols`, or overriding `isAllowedUri`, would have removed it
  with no test failing anywhere. Wired into `web/src/components/Editor.tsx:588` and all three
  `Link.configure` calls in `web/src/components/StandupFeed.tsx`.
- `web/src/components/editor/linkOptions.test.ts` **(new, 27 cases, runs in the gate)** — content
  loaded as TipTap **JSON**, which is the stored-XSS path (`Mark.fromJSON` does not run
  `parseHTML`'s href guard). Asserts a benign `https` href survives *and* that
  `javascript:` / `data:text/html` / `data:image/svg+xml` do not, plus scheme-obfuscation cases
  (`jav\tascript:`, `java\nscript:`, `j a v a s c r i p t:`).
- `api/src/routes/workspaces.test.ts` — three cases added beside the existing member→403 check: the
  403 body must not carry `"logs"`, an unauthenticated request is refused, and a member is refused
  the audit log of a workspace they are not a member of.
- `e2e/security.spec.ts` — the two link tests are replaced by *stored dangerous link hrefs are not
  rendered live*, which opens a seeded document whose `content` already holds link marks with
  dangerous hrefs and asserts unconditionally; plus *markdown link syntax does not create a link at
  all*, which pins the fact the old tests were unknowingly relying on, so that adding a
  markdown-link input rule later fails loudly instead of silently re-opening the vector.
- `e2e/authorization.spec.ts` — every precondition is its own assertion with an actionable message,
  so a setup failure now fails *as a setup failure*; plus a companion test for a foreign workspace's
  audit log.

*The rest, working outward from security:*

| file | test | was |
|---|---|---|
| `e2e/file-attachments.spec.ts:161` | should validate file type | **0 `expect()`** — uploaded a `.exe`, slept 1 s, listed three acceptable outcomes in a comment. Now asserts the blocked-file dialog fired, that **no request reached `/api/files`** (the bytes never leave the browser), and that no attachment node was inserted. |
| `e2e/file-attachments.spec.ts:422` | should block dangerous executable files (.exe) | assertions lived *inside* `page.on('dialog')`, so they never ran if the dialog never fired. Messages are collected and asserted outside the handler. |
| `e2e/check-aria.spec.ts` | check aria-expanded elements | **0 `expect()`** — a diagnostic script with 19 `console.log`s and `return`-on-missing-data. Now asserts the A11Y-1 contract: `aria-expanded` sits on a real `<button>`, is named, and (new second test) tracks the children and survives navigating into one. |
| `e2e/accessibility-remediation.spec.ts:1398` | code blocks have language indication | **0 `expect()`** — ran on `/docs`, which renders no code block, and discarded the computed result. Now opens a seeded document with one code block and asserts count **and** language. |
| `e2e/admin-workspace-members.spec.ts:87` | can change member role | whole body inside `if (await roleSelect.isVisible())`. Now asserts the seeded member row exists, and reloads to prove the PATCH reached the server rather than only moving a local `<select>`. |

**Fixture work, never a conditional skip.** `e2e/fixtures/isolated-env.ts` gains
`seedRenderingFixtures()`: a *Link Sanitization Fixture* document (one benign control href + three
dangerous ones stored as link marks) and a *Code Block Fixture* document (one code block with
`language: 'javascript'`). Both are seeded at `position` 90/91 so they sort last and never become
the document `/docs` auto-opens. Titles and hrefs are exported as constants so a rename cannot
orphan a spec. `e2e/fixtures/test-helpers.ts` gains `openFixtureDocument(page, title)`, which
resolves the id through `GET /api/documents` and asserts the fixture exists with an actionable
message.

**The positive control is the mechanism.** Every rewritten test that inspects rendered elements now
asserts *first* that the thing it will inspect is present. Without that, "the page rendered nothing"
is indistinguishable from "the check passed", which is exactly what 68 tests were doing.

**Evidence.** Red-before-green, both security properties, under `pnpm --filter @ship/{web,api} exec
vitest run <file>` against the branch's own worktree database
(`postgresql://…@localhost:5433/ship_wt_tro_224`):

| deliberate break | result |
|---|---|
| `linkOptions.ts` → `isAllowedUri: () => true` + `protocols: ['javascript','data']` | **4 failed / 23 passed.** `AssertionError: javascript: must not survive into a rendered href`, same for `data:text/html` and `data:image/svg+xml`, plus `"javascript" must never be an allowed link protocol`. The benign-control case stayed **green**, which is what shows the failure is the vulnerability and not a broken test. |
| `workspaces.ts:1021` → `workspaceAdminMiddleware` removed from `GET /:id/audit-logs` | **3 failed / 25 passed**, each `expected 200 to be 403`. Includes the foreign-workspace case, i.e. without the middleware the handler itself does no scoping. |
| both reverted | 27/27 and 28/28 pass. |

**Gate result, and how it got there.** Before this branch merged `main`, `scripts/factory/gate.sh`
reported `tests:not-weakened FAIL — 6 removed test/assertion line(s)`. That check counted removed
`expect(` lines with no comparison to added ones, so it could not distinguish deleting an assertion
from *replacing a vacuous one*. All six removed lines were the vacuous assertions this ticket exists
to delete:

```
e2e/authorization.spec.ts    expect(response.status()).toBe(403)        # was inside two nested ifs
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('.exe')      # was inside page.on('dialog')
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('blocked')   # was inside page.on('dialog')
e2e/security.spec.ts         expect(href).not.toContain('javascript:')       # was inside a loop over 0 elements
e2e/security.spec.ts         expect(href).not.toContain('text/html')         # was inside `if (href?.startsWith('data:'))`
e2e/security.spec.ts         expect(href).not.toContain('<script')           # was inside `if (href?.startsWith('data:'))`
```

Each is replaced by a stronger unconditional assertion in the same test; `regression-test` reports 13
added cases. After merging `main` (`86b5231`), `gate.sh`'s G5 had independently been changed to a net
comparison of removed vs. added test lines — motivated by this exact false-positive class on other
tickets (TRO-223, TRO-179) — and now reports `tests:not-weakened PASS — -6 / +51 test line(s) — net
gain, reviewer should confirm the removals are corrections`. No edit to `gate.sh` was made on this
branch; the fix landed on `main` independently and this entry is corrected to match the gate this PR
actually merges against. Every other gate is green, including `review-patterns` (G7b, also new from
`main`) and both vitest projects.

Three separate gate runs have each failed `tests:api` on a *different* untouched test
(`backlinks.test.ts`, `rate-limit.test.ts`, then `weeks.test.ts`'s "should reject review approval
without rating"); all three pass standalone and the full api suite is 472/472 each time — that is
TRO-277's load-sensitive flake (documented to appear under CPU load, right after `type-check` +
`build`), not this branch.

**Attempted, then reverted — and it found two bugs.** `e2e/ai-analysis-api.spec.ts:209`
*"POST /api/ai/analyze-plan returns 429 after 10 rapid requests"* guards its assertions with
`if (!allSucceeded)`, so the single outcome it exists to catch — the limiter doing nothing — is the
one outcome it excuses. Making the assertion unconditional produced, **observed**,
`Got: 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200` — eleven admissions, no `429`. Two
findings fall out, neither of them a test bug:

1. **The test's premise is false.** `api/src/services/ai-analysis.ts:39` sets `RATE_LIMIT = 120`
   per hour, not 10. Eleven requests cannot trip it, and never could.
2. **The user is told the wrong number.** `api/src/routes/ai.ts:34` returns *"Rate limit exceeded.
   Max 10 analysis requests per hour."* while 120 is enforced. Whoever hits the ceiling is given a
   figure off by 12×.

The file is reverted to its original state. Asserting truthfully would need 121 requests — 120 of
which each attempt a Bedrock call and would likely blow the 60 s test timeout — or making the limit
injectable, which is a production change to enable a test. Neither belongs in a test-integrity
ticket. The 10-vs-120 inconsistency needs its own ticket; the vacuous guard stays on the TEST-2 list
until it does.

**Not done, deliberately.** 60 of the 68 remain. `program-mode-week-ux.spec.ts` alone holds 33
(sprint-filter and quick-menu UX, no security content); `accessibility-remediation.spec.ts` has 6
more, `context-menus.spec.ts` 6, `features-real.spec.ts` 5, `performance.spec.ts` 2, and
`ai-analysis-api.spec.ts` keeps 1 (see above), and
`admin-workspace-members.spec.ts` keeps 2 (`selecting user from search…`, `can add existing user…`)
which are guarded on a **"test space" workspace and a "carol" user that the isolated fixture does
not create** — converting those guards needs a second seeded workspace and more users, which risks
the workspace-switcher and admin-dashboard specs and belongs in its own ticket. See TRO-225's entry
for the retries decision.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database

# The tiers the factory gate actually executes
pnpm --filter @ship/web exec vitest run src/components/editor/linkOptions.test.ts   # 27 pass
pnpm --filter @ship/api exec vitest run src/routes/workspaces.test.ts               # 28 pass

# The e2e specs, targeted. Never the whole suite: 600+ tests, per-worker containers.
pnpm exec playwright test e2e/security.spec.ts       --workers=1 --retries=0        # 18 pass
pnpm exec playwright test e2e/authorization.spec.ts  --workers=2 --retries=0        # 18 pass
pnpm exec playwright test e2e/file-attachments.spec.ts --workers=2 --retries=0      # 13 pass
pnpm exec playwright test e2e/check-aria.spec.ts e2e/admin-workspace-members.spec.ts --workers=2 --retries=0
pnpm exec playwright test e2e/accessibility-remediation.spec.ts --workers=2 --retries=0 \
  -g "code blocks have language indication"                                          # 1 pass
```

To see the security tests fail, reintroduce the vulnerability: set
`isAllowedUri: () => true` in `web/src/components/editor/linkOptions.ts`, or drop
`workspaceAdminMiddleware` from `api/src/routes/workspaces.ts:1021`.

**Rollback.** `git revert` the branch. The only production code touched is the new
`linkOptions.ts` and the four `Link.configure` call sites that spread it; reverting restores
reliance on `@tiptap/extension-link`'s default `isAllowedUri`, which blocks the same five schemes
today.

---

## TRO-225 — [TEST-3] Retries hid a test that failed first-attempt in 100% of runs

**What was broken.** `playwright.config.ts:60` sets `retries: process.env.CI ? 2 : 1`. Across three
identical 869-test runs, counting **first attempts only**, 8 / 5 / 3 tests failed; after retries the
runner reported 1 / 0 / 1. Retries erased 7 / 5 / 2 failures
(`audit/test-quality/runs/e2e-flake-union.txt`). The worst case,
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`, **failed or
timed out on the first attempt in all three runs and was reported as passing all three times.**

**The recorded diagnosis was wrong.** That spec's header blamed Yjs persistence timing — "the retro
document IS created … but its Yjs content isn't persisted … even with a 10s wait … Needs
investigation on a separate branch." Two runs settle it (observed, `--workers=1 --retries=0`, this
worktree):

| invocation | result |
|---|---|
| `playwright test e2e/my-week-stale-data.spec.ts` | plan **passes**, retro **fails** — `getByText('Completed the API refactoring')` never appears |
| `playwright test e2e/my-week-stale-data.spec.ts -g "retro edits"` | retro **passes** (22.5 s) |

The retro test does not fail on its own merits. It fails **because the plan test ran first in the
same worker's database** — the "shared state inside a worker's database" root cause the finding
names, demonstrated rather than inferred.

**Mechanism** (read from the code, consistent with the above). When a weekly plan already exists for
the same person+week, `POST /api/weekly-retros` (`api/src/routes/weekly-plans.ts:641-656`) swaps
`WEEKLY_RETRO_TEMPLATE` for `buildRetroTemplateWithPlanItems(...)`: heading, then a `planReference`
node plus an empty `paragraph` per plan item, then an "Unplanned work" heading and a 3-item bullet
list. The old test clicked the editor's **centre**, so in that taller document the caret landed in a
top-level paragraph rather than inside a list item — and `extractPlanItems`
(`api/src/routes/dashboard.ts:279-309`) collects only `listItem`/`taskItem` text. The typed line
never reached the `/my-week` card. The failure screenshot confirms it: the retro card renders as a
**link** to a real document (so the document exists) whose body still reads "+ Create retro for this
week" (so `items` is empty).

**What changed** in `e2e/my-week-stale-data.spec.ts`:

1. **The cross-test dependency is gone.** `typeIntoFirstListItem()` places the caret in the first
   empty list item explicitly, so the typed text lands in the node type `/my-week` reads whichever
   template the API produced. Both tests use it.
2. **The fixed sleep is gone.** `await page.waitForTimeout(3000)` — a guess at how long persistence
   takes, and the second root-cause smell the finding lists — is replaced by
   `waitForMyWeekToContain()`, which polls `GET /api/dashboard/my-week` until the item is actually
   readable. This also *localises* the failure: a genuine persistence problem now fails at the poll
   with the API's own payload in the message, not 15 s later at a DOM assertion.
3. **Assertions are scoped to their card.** `myWeekSection(page, 'Weekly Retro')` prevents the retro
   assertion from being satisfied by the plan card.
4. The misleading "KNOWN FLAKY / needs investigation" header is replaced by the two-run evidence
   above.

**Decision on `retries`: left at `CI ? 2 : 1`, and here is why.** This branch fixed **1 of the 11**
tests on the flake list. Lowering retries — or setting `failOnFlakyTests: true`, which is the better
end state because it keeps the retry's trace artifact while refusing to score a retry-rescued test
as a pass — would immediately turn a misleadingly-green suite into a permanently-red one with ten
root causes still outstanding, and a permanently-red suite gets ignored exactly as fast as a
falsely-green one. It is a one-line change that costs nothing to defer and belongs with the *last*
flake fix, not the first. What has changed is that the choice is no longer invisible:
`playwright.config.ts` now carries the 8/5/3-vs-1/0/1 measurement, the pointer to
`e2e-flake-union.txt`, and the exact switch to flip. **No claim is made that the other ten flakes
are fixed.** They are:

`inline-comments.spec.ts › canceling a comment removes the highlight` (failed final in 2 of 3 runs —
the strongest remaining candidate), `mentions.spec.ts › should sync mentions between collaborators`,
`weekly-accountability.spec.ts › Allocation grid shows person with assigned issues…`,
`bulk-selection.spec.ts › shift+down then shift+up contracts selection`,
`my-week-stale-data.spec.ts › plan edits…` (flaky once; its fixed sleep is removed here too),
`performance.spec.ts › many images do not crash the editor`,
`programs.spec.ts › program cards show emoji or initial badges`,
`project-weeks.spec.ts › project link in Properties sidebar navigates back to project`,
`status-overview-heatmap.spec.ts › displays split cells for plan/retro status`,
`team-mode.spec.ts › clicking collapsed header expands the group`.

**Second finding, and the more serious one: the editor sometimes never receives a new document's
content.** Once the test asserted that the template had *arrived* — rather than typing into whatever
happened to be on screen — it began failing for an entirely different reason. **Observed**, three
repeat runs at `--workers=1 --retries=0`: run 1 clean, run 2 the *plan* document opened blank, run 3
the *retro* document opened blank. To a user that is a brand-new weekly plan opening as an empty
editor instead of the template.

**Derived** from code reading, not instrumented: `getOrCreateDoc`
(`api/src/collaboration/index.ts:220-226`) publishes the new `Y.Doc` into the shared `docs` map
*before* awaiting the database read and the `jsonToYjs` conversion at `:231-266`, and registers the
broadcasting `doc.on('update')` handler only afterwards. A second connection for the same document
arriving inside that window is handed the empty doc, is sent `writeSyncStep1` from it, and never
receives the conversion update — and `freshFromJsonDocs.delete(docName)` after the first client means
it does not get the cache-clear signal either. The shape of the fix is to store the load *promise* in
the map so concurrent callers await the same load. Needs its own ticket.

This also explains the **other** my-week entry on the flake list (`plan edits are visible on /my-week
…`, flaky in 1 of 3 audit runs), which the plan/retro template coupling does not — and it is very
probably what the original file header was reaching for when it blamed "Yjs persistence".

Until it is fixed, `typeIntoTemplateList` tolerates it with **one bounded reload** (`toPass`, the
construct `e2e/AGENTS.md` sanctions) and a failure message that names the finding and the file:line.
That is a workaround in the *setup* phase of a test whose subject is something else; it is not a
guard, because the assertion still has to pass, and it is not silent.

**Third finding, reported not fixed.** `extractPlanItems` exists in three copies with **divergent**
behaviour: `api/src/routes/dashboard.ts:279-309` collects only `listItem`/`taskItem`, while
`api/src/routes/weekly-plans.ts:63-95` and `api/src/services/ai-analysis.ts:69` also collect
top-level paragraphs longer than 10 characters. Consequence for a real user: an auto-populated retro
puts an empty `paragraph` under each `planReference` block *specifically so you write your update
there* — and `/my-week` then shows an **empty retro card**, because the dashboard reader ignores
paragraphs. That is a product bug, not a test bug; fixing it changes what `/my-week` displays, which
is out of scope for a test-integrity ticket. Needs its own ticket.

**Evidence.** Targeted specs only — the full suite was not run (600+ tests, per-worker containers,
not in the gate). Commands and results are in the PR body / final report; the decisive pair is the
two-run table above.

**How to run it.**

```bash
source .factory-env

# The configuration that reproduced the deterministic failure. 4 consecutive clean runs
# after the fix; before it, the retro test failed every time this way.
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0

# The two-run experiment that identified the cross-test dependency (run against `main`):
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0 -g "retro edits"
```

**Rollback.** `git revert` the branch. `playwright.config.ts` changes are comment-only, so reverting
restores the previous behaviour exactly.

---

## TRO-217 — [A11Y-3] `/my-week` failed colour contrast, the landing page of the app

**What was broken.** `/` redirects to `/my-week`, and it was the only key page Lighthouse failed on
accessibility: **95**, one failing audit, `color-contrast`. axe reported it **Serious** on 18 nodes
(24 in the audit baseline; the count tracks how many future standup rows the current week still
has, so it moves with the weekday).

The finding named two causes. There were **three**, and one of the two named was misattributed:

| Cause | Nodes | Resolved colour | Ratio |
|---|---|---|---|
| `opacity-40` on future standup rows (`MyWeekPage.tsx:339`) | 12 | `#3f3f3f` on `#0d0d0d` | **1.84:1** |
| `text-muted/50` on the 11px plan/retro ordinals | 4 | `#4c4c4c` on `#0d0d0d` | **2.26:1** |
| `text-accent` used as a *foreground* colour | 2 | `#005ea2` on `#0a1d2b` / `#0c1114` | **2.55:1** / 2.82:1 |

The dominant cause — two thirds of the nodes — was `opacity-40`, which the finding never mentioned.
And `bg-accent/20`, which the finding did blame, is not the defect: `accent` (`#005ea2`) is
**2.89:1 as text on the page background before any badge is involved**; the translucent fill only
takes it from 2.89 to 2.55. The fill was fine. Using a fill colour as text was not.

A **fourth** pair, in neither the finding nor either axe run: the "Unsubmitted" badge puts
`text-muted` on a `bg-border` fill at **4.38:1**. It renders only when a plan or retro has content,
is unsubmitted, and is not yet due — a state neither scan happened to hit. It is not a guess: axe
recorded that identical pair on the command palette's `esc` key
(`audit/a11y/axe/command_palette_open.json`).

**What changed.**

- `web/tailwind.config.js` — added `accent-text: #2491ff` (USWDS blue-40v, verified against
  `@uswds/uswds/.../tokens/color/_blue.scss`): **6.08:1** on `background`, 5.37:1 on a
  `bg-accent/20` badge, 5.94:1 on `bg-accent/5`. `accent` itself is **unchanged**, so every
  `bg-accent` fill in the app looks exactly as it did. blue-50v (`#0076d6`) was tried and rejected —
  4.22:1, still failing. Also corrected the `muted` comment, which claimed 5.1:1 where the
  arithmetic gives 5.63:1, and recorded the `bg-border` caveat next to it.
- `web/src/pages/MyWeekPage.tsx` — `opacity-40` removed from future rows in favour of a dimmer
  border; `text-muted/50` → `text-muted` on the two ordinals; `text-accent` → `text-accent-text` on
  the "Current" badge and today's day label; `text-muted` → `text-foreground` on the two
  "Unsubmitted" badges.

**Why the levels differ, since a global token change was the obvious move.**

- `opacity-40` was **page-level** because `MyWeekPage.tsx:339` was its *only* occurrence in
  `web/src`. Nothing else could be affected.
- `text-muted/50` was **page-level** because 10 of its 12 occurrences are on other pages
  (`PlanQualityBanner`, `DashboardVariantC` at `/dashboard`, `WorkspaceSettings`,
  `AdminWorkspaceDetail`, `Programs`, `MergeProgramDialog`, `HypothesisBlockComponent`). They fail
  too — 2.26:1 is a property of the token pair, not of this page — but they are outside A11Y-3 and
  are filed as a follow-up rather than swept in silently.
- `accent-text` was added at **token level** but applied only here. Adding a token cannot regress a
  page that currently passes; mutating `accent` could, because `accent` is a fill under white text
  in 80 places across 45 files. That mutation is a visual-identity decision, not a contrast fix.

**The tradeoff, stated because it is visible.** Future standup rows are no longer ghosted. They now
read as ordinary muted rows, distinguished by a dimmer border, the italic "Upcoming" label and the
absent status dot. This was not avoidable by tuning the opacity value: `text-muted` only clears
4.5:1 above roughly **86%** opacity, at which point nothing looks dimmed at all. Likewise the
ordinals lost their extra-quiet tier — on `#0d0d0d`, AA bottoms out around `#7a7a7a`, a 16-step
band below `muted`, so a perceptibly quieter *compliant* grey does not exist on this background.
Contrast won, as the ticket directed.

**Evidence.** Both ends measured on this branch, same conditions, not inherited from the audit:
`http://localhost:5683`, Chrome for Testing headless, 1440×900, `--preset=desktop`,
`--only-categories=accessibility`, authenticated as `dev@ship.local`, 523 seeded documents,
`ship_wt_tro_217`. Flags identical to `audit/a11y/run-lighthouse.sh` and `audit/a11y/axe-scan.mjs`.

| Measurement on `/my-week` | Before | After |
|---|---|---|
| Lighthouse accessibility | **95** | **100** |
| Lighthouse failing audits | 1 (`color-contrast`, 18 items) | **0** |
| axe `color-contrast` nodes | **18 Serious** | **0** |
| axe all severities | C0 **S1** M0 m0 | C0 S0 M0 m0 |

The audit baseline recorded 24 nodes and the ticket said 25; **18** is what the same page produced
here. The gap is the weekday (four remaining future days instead of six), not a different defect —
the per-node causes and ratios match the baseline artifact exactly.

**Regression test.** `web/src/pages/MyWeekPage.contrast.test.tsx` resolves the effective foreground
and background *colours* out of the rendered DOM and asserts the WCAG ratio, rather than asserting
a class string — so it survives a markup refactor and fails if a palette hex drifts back under
4.5:1. It renders four data states, because three of the page's pairs only exist under specific
data; a single-state check would have declared the page fixed while the 4.38:1 badge sat behind a
common plan state. `web/src/lib/contrast.test.ts` pins the resolver against numbers this project
did not compute — the exact `fgColor`/`bgColor`/`contrastRatio` values axe recorded in
`audit/a11y/axe/`.

Confirmed red first on the unfixed page: 6 failures, every one an `AssertionError` on the ratio
(21 of 39 pairs below 4.5:1 in the first state; named failures at 2.26:1, 1.85:1, 2.82:1, 4.38:1).
No import or locator errors.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 24 new tests; 13 known failures are TEST-1/TRO-223, unchanged
pnpm --filter @ship/web type-check
```

To re-measure against a browser, start the worktree's API and Vite, log in for a fresh
`session_id` (sessions expire in 15 minutes), then run Lighthouse and axe with the flags above.

**Roll back.** `git revert` the commits on `fix/a11y-3-contrast`, or by hand: restore `opacity-40`
on the future-row branch of `rowClass`, put back `text-muted/50` on the two ordinals,
`text-accent` on the "Current" badge and today's day label, `text-muted` on the two "Unsubmitted"
badges, and drop `accent-text` from the palette. The two new spec files fail if any of it comes
back, which is the point.

**Not established.** That a low-vision user can now read the page. Contrast ratios and axe output
are measured; the user-facing benefit is *derived* from them, and no human with low vision has
looked at this build. Also not established: that the repo's three Playwright a11y specs still pass
— they are not run by the factory gate and were not run here. One of them,
`e2e/accessibility-remediation.spec.ts:738` ("no color contrast violations on main pages"), runs
axe right after login, which lands on `/my-week`; it was almost certainly failing before this
change and should now pass, but that is a prediction, not a result.

**Found and not fixed** (filed as follow-ups, all measured):

1. `text-muted` on a `bg-border` fill is **4.38:1** and co-occurs in ~109 places in `web/src`.
   Raising `muted` from `#8a8a8a` to `#929292` (4.86:1 on `#262626`, 6.25:1 on `#0d0d0d`) fixes the
   whole class in one line and cannot lower contrast on any dark surface. Out of scope here because
   it is an app-wide tone change driven by pairs outside this page.
2. `text-accent` is **2.89:1** as small text on the page background wherever it renders — 80
   occurrences in 45 files. Only the two on `/my-week` were observed failing by axe; the rest is
   computed from the token, so treat the count as derived. `accent-text` now exists for them.
3. `bg-surface` is used in three files including `MyWeekPage.tsx`, but `surface` is **not a palette
   token**, so the class generates no CSS and those "cards" are painted with the page background.
   Harmless today; it silently changes the contrast maths for anything inside them if `surface` is
   ever defined.
4. `getContrastTextColor` in `web/src/lib/cn.ts` carries a second copy of the WCAG luminance
   formula now also in `web/src/lib/contrast.ts`. Collapsing them changes a shipped helper's
   behaviour on malformed input, so it was left alone.
5. `pnpm db:migrate` stopped after `010_oauth_state.sql` on a partially-migrated database and still
   reported success, leaving 10 of 42 migrations applied — the swallowed `already exists` catch at
   `api/src/db/migrate.ts:103-110`. This is **DB-1** reproducing; worked around by cloning a
   fully-migrated database rather than by touching the runner.

---

## TRO-215 — [A11Y-1] Navigation sidebars claimed `role="tree"` without a tree keyboard model

**What was broken.** `web/src/pages/App.tsx:637` declared
`<ul role="tree" aria-label="Workspace documents">`, which tells assistive technology "this is a
composite widget, enter interaction mode and navigate with arrow keys." Nothing implemented that
contract: no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`/`aria-posinset`
anywhere in `DocumentTreeItem.tsx` or `App.tsx`. The same pattern appeared in four more places.
Because `role="tree"` also overrides the `<ul>`'s list role, the two bare `<li>` children of that
list — the empty state and the "N more..." overflow link — became roleless orphans, producing axe
**Critical `aria-required-children`** plus **Serious `listitem`**.

**What changed.** Subtraction. `role="tree"`, `role="treeitem"` and `role="group"` are gone from
the document/context/project navigation sidebars, along with `aria-expanded`/`aria-selected` on
the `<li>` elements. The native `<ul>`/`<li>`/`<a>` structure is unchanged and needs no ARIA.

- `web/src/pages/App.tsx` — workspace + private document lists, the local `DocumentTreeItem`, and
  the projects list. `DocumentsTree` is now exported as a unit-test seam.
- `web/src/components/DocumentTreeItem.tsx` — the shared item used by the /docs tree view.
- `web/src/pages/Documents.tsx` — the container for the above; it had to move with the items,
  because a `role="tree"` whose children stop being treeitems is a *new* Critical.
- `web/src/components/ContextTreeNav.tsx`, `web/src/components/sidebars/ProjectContextSidebar.tsx`.

State that used to live on the `<li>` moved to where it is valid ARIA: `aria-expanded` is now on
the expand/collapse `<button>`s, and the active document was already marked with
`aria-current="page"` on its `<a>`.

**One behaviour change, from PR review.** Moving `aria-expanded` onto the buttons exposed that the
person row in `ProjectContextSidebar` was a `<button aria-expanded="false">` even for a person with
**no weeks** — controlling nothing, and with a provably no-op click (`togglePerson` writes
`expandedPeople`, read only by `isExpanded && hasWeeks`). That row is now a plain `<div>`: still
readable, no longer a phantom tab stop. People *with* weeks are unchanged — chevron, week count,
working `aria-expanded`. Reverting restores the focusable no-op button.

**Deliberately kept.** `aria-live="polite"` on the two document lists. It is the WCAG 4.1.3
mechanism for announcing create/delete and is asserted by
`e2e/accessibility-remediation.spec.ts` ("document tree updates are announced"). Whether it is
too verbose on expand/collapse is a screen-reader question, and removing it on a prediction is
the exact error A11Y-1 itself was — see the follow-up note below.

**Out of scope, deliberately.** `web/src/pages/OrgChartPage.tsx` keeps `role="tree"`: it is the
one real tree widget in the codebase (roving `tabIndex` at `:664`, `onKeyDown` at `:462`).

**Evidence.** axe-core 4.11 via `@axe-core/playwright`, Chromium 1223 headless, 1440×900, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, logged in as `dev@ship.local` against a locally
seeded database. Counts are Critical/Serious/Moderate/minor.

| page | before | after |
|---|---|---|
| `/docs` | **C1 S1** M0 m0 — `aria-required-children`, `listitem` | **C0 S0** M0 m0 |
| `/documents/:id` | **C2 S1** M1 m0 | **C1 S0** M1 m0 |
| `/issues` | C0 S0 M0 m1 | C0 S0 M0 m1 |

The Critical remaining on the document view is `aria-allowed-attr` on the editor `<div>` — that is
**A11Y-2**, a separate finding, untouched here.

**Reproduction precondition (worth knowing).** The violation is data-dependent: it only fires when
a sidebar section has **more than `SIDEBAR_ITEM_LIMIT` (10)** root documents, which renders the
bare `<li>` "N more..." overflow link, or **zero**, which renders the bare `<li>` empty state. A
freshly seeded database has 5 and shows **no** violation. The audit environment had more than 10.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 5 new specs, 26 assertions, all green
pnpm type-check
```

**Rollback.** `git revert` the commits on `fix/a11y-1-sidebar-aria`, or by hand: restore the five
`role="tree"`/`role="treeitem"` sites listed above, and restore the person row in
`ProjectContextSidebar.tsx` to a single `<button>` for both the has-weeks and no-weeks cases. The
five new `*.test.tsx` files fail if either comes back, which is the point.

**Still owed — do not mark this fully verified.** Nobody has listened to it. A human found on
2026-07-28 that VoiceOver did not announce the document titles *at all* under the old markup;
this change makes the DOM use native list semantics and axe agrees, but **no screen-reader pass
has been run on the fixed build.** That verification, plus a judgement on the retained
`aria-live`, is outstanding.

---

## TRO-188 (ERR-1) + TRO-189 (ERR-2) — the editor stops lying about "Saved", and a revoked session stops writing

Both findings live in the collaboration path and ship as one change: TRO-189 makes the server hang
up on sockets whose session is gone, and TRO-188 makes the editor say so instead of showing
"Saved" over work that is not saved. Fixing one without the other would have produced a *silently*
disconnected editor — a worse version of ERR-1.

**What changed — TRO-189 / ERR-2 (security: logged-out user kept write access).**

The collaboration socket was authenticated exactly once, during the HTTP upgrade
(`api/src/collaboration/index.ts`, `server.on('upgrade')`), and never re-checked. Deleting or
expiring the session left the socket writing to `documents` indefinitely while REST correctly 401'd
(audit `probe7c`, `probe6.4`).

- Each connection now records the `sessionId` that authorized it (`DocConnection` / `EventConnection`).
- `revalidateLiveSessions()` re-checks every session backing a live socket on an interval
  (`DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000`), in **one batched query** for all distinct
  sessions, applying the same two windows as the REST middleware (`SESSION_TIMEOUT_MS`,
  `ABSOLUTE_SESSION_TIMEOUT_MS`). Invalid → the socket is closed with code **4401**.
- It **fails open** on a database error: a transient outage must not disconnect every open editor.
- `closeSocketsForSession()` is called directly from `POST /api/auth/logout` and from the
  session-fixation rotation on login, so logout takes effect at once rather than up to 30s later.
- Connections are marked `revoked` *before* `ws.close()`, and inbound frames from a revoked
  connection are dropped — `close()` only starts the closing handshake, so without this an edit
  already in flight could still be persisted.

Behaviour change to be aware of: a session that has passed the 15-minute inactivity window now
loses its collaboration socket, where before only REST rejected it. Collaboration traffic
deliberately does **not** refresh `last_activity` — doing so would let an open tab keep a session
alive forever, which is a larger hole than the one being closed.

**What changed — TRO-188 / ERR-1 (data loss under a "Saved" label).**

`Editor.tsx` treated the WebSocket `status: connected` event as proof of persistence. It is not:
audit `probe2d-ws-unavailable.json` records **three** `connected` events and **zero** `sync` events,
with the indicator reading "Saved" for 60 s while `inDb=false`, ending in a document whose content
was `""`. `probe2-ws-drop` and `probe2e` show the same lie under the "Cached" label.

- The header indicator moved out of `Editor.tsx` into `web/src/components/editor/SyncStatusIndicator.tsx`
  with the derivation as a pure function (`deriveSyncIndicator`).
- "Saved" now requires `isSynced` — the y-websocket `sync` event, the only evidence the document
  reached the server. `status: connected` no longer sets it, and `sync(false)`/`disconnected`
  clears it.
- The unsynced state renders as **"Not saved"**, red, with a title that names the consequence
  ("changes … will be lost if you reload"). The reassuring "Cached" label is gone.
- A neutral "Connecting" state covers the first connection attempt only, so a normal page load does
  not flash a warning.
- Close code 4401 (TRO-189) stops the reconnect loop and drives the indicator to "Not saved",
  which is how a revoked session becomes visible to the user.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api  exec vitest run src/collaboration/__tests__/session-revocation.test.ts
pnpm --filter @ship/web  exec vitest run src/components/editor/SyncStatusIndicator.test.tsx
scripts/factory/gate.sh
```

The api test drives the real collaboration server over a real WebSocket and asserts on the
`documents` table, not on a mock. It runs with a 200 ms revalidation interval via
`setupCollaboration(server, { sessionRevalidationIntervalMs })`.

**Rollback.** Revert the commits on `fix/err-1-err-2-collab-socket`. Independently:
for TRO-189 alone, delete the `revalidateLiveSessions`/`closeSocketsForSession` block in
`api/src/collaboration/index.ts` and its two call sites in `api/src/routes/auth.ts` — nothing else
depends on them, and `setupCollaboration`'s second argument is optional. For TRO-188 alone, pass a
permanently-true `isSynced` to `SyncStatusIndicator`, which restores the old "connected means
Saved" behaviour.

---

## TRO-172 — [API-1] Rate limiter no longer caps production at 100 req/min per IP

**What changed.** Two halves, server and client.

*Server* — `api/src/middleware/rate-limit.ts` (new) replaces the single `apiLimiter` that lived in
`api/src/app.ts`. `/api/` is now guarded by two chained limiters over the same 60 s window:

| Limiter | Key | Production limit | Purpose |
|---|---|---|---|
| `perSourceIpLimiter` | source IP | 6,000 / min (100 req/s) | anti-flood floor; makes the identity key unspoofable in aggregate |
| `perIdentityLimiter` | `session_id` cookie → `Bearer` token → source IP | 600 / min (10 req/s) | the budget users actually feel |

The old configuration was **100 / min keyed on IP**. Both numbers in it were wrong:

- *Unit.* The ceiling was sized as if one page view were one request. The audit's browser trace
  measured 63 `/api` requests across 8 flows (login 16, dashboard 12, document view 10, sprint
  board 10), so a user exhausted the window after ~6–10 navigations per minute.
- *Key.* With CloudFront → Elastic Beanstalk and `trust proxy 1`, every user behind one agency NAT
  egress resolved to the same IP, so a whole team shared one 100 req/min budget.

600 is justified against the measurement: the worst single-user burst is 16 XHRs × 20 navigations
per minute = 320 req/min, so 600 leaves ~1.9× headroom and still caps one session at 10 req/s.
6,000 accommodates ~187 simultaneously-active users behind one NAT egress at the measured average
of ~32 req/min per active user, while staying far below the 299–4,049 req/s this API was measured
to serve — a single-source flood is still capped. Test (10,000) and dev (1,000) budgets are
unchanged. Session ids and tokens are SHA-256 fingerprinted before use as bucket keys.

*Client* — `web/src/lib/queryClient.ts` now retries HTTP 429 for **queries and mutations** with a
2 s / 8 s / 20 s / 45 s backoff plus additive jitter. The schedule sums to ≥75 s so at least one
attempt lands after the server's 60 s window rolls over; React Query's default 1/2/4 s backoff
would exhaust itself inside the same window. Every other 4xx is still treated as permanent. If the
retries are exhausted the write is genuinely lost, so `MutationErrorToast` now raises a **sticky**
toast (`web/src/components/ui/Toast.tsx` gained `duration: 0` = no auto-dismiss) naming rate
limiting as the cause instead of a generic three-second message.

**Measured, NODE_ENV=production, concurrency 10, `GET /api/documents?type=wiki`, in-process listener:**

| Scenario | Before | After |
|---|---|---|
| 1,000 requests, no session cookie | 100 served / 900 throttled (90%) | 600 served / 400 throttled (40%) |
| 2,000 requests, 20 distinct sessions behind one IP | 100 served / 1,900 throttled (95%) | **2,000 served / 0 throttled** |

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts
pnpm --filter @ship/web test src/lib/queryClient.test.ts src/components/MutationErrorToast.test.tsx
```

**Rollback.** Revert the commits, or by hand: delete `api/src/middleware/rate-limit.ts` and restore
the single `apiLimiter` (`windowMs: 60_000`, `max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100`) plus
`app.use('/api/', apiLimiter)` in `api/src/app.ts`; restore the two inline `retry` predicates in
`web/src/lib/queryClient.ts` and drop `retryDelay`. The `Toast` `duration: 0` support and the
sticky-toast branch in `MutationErrorToast` are additive and safe to leave.

---

## Factory visibility — status command, published board, cost analysis (no ticket: tooling)

**What changed.** Three additions, all reading from sources of truth rather than a status file:

- `scripts/factory/lib/state.mjs` — reconstructs factory state from git worktrees, `.factory-env`,
  `.factory/gate-result.json`, `gh pr list`, `scorecard.jsonl`, and Claude Code session
  transcripts. No state file is written, because one that drifts reads as authoritative while
  being wrong.
- `scripts/factory/status.mjs` — one-screen terminal view. `--json` feeds the board.
- `scripts/factory/board.mjs` — renders a self-contained HTML control panel (cream ground,
  British racing green, severity carried by stripe + wash + text colour, all contrast-measured
  against WCAG AA rather than estimated). Single-theme by choice: both `data-theme` values are
  pinned to the cream tokens so the viewer's toggle cannot flip it.
- `scripts/factory/serve.mjs` — local server that rebuilds the board from live state on every
  request. This is the surface for *operating* the factory: free to refresh, no agent needed.
  The published Artifact can only be updated by an agent calling a tool, so it is for *sharing*
  a milestone, not for watching a run.
- `scripts/factory/cost-report.mjs` — the graded "AI cost analysis" deliverable
  (`projectbrief.md:63`), derived retroactively from transcripts that already record per-message
  token usage.

**Decision: not LangGraph.** The workers are Claude Code sub-agents with their own tool loops in
git worktrees, so a graph framework would orchestrate opaque subprocesses — the interesting
internals are exactly what it cannot see. The durable state (branch, gate result, PR, Linear
ticket) already exists; a checkpointer would duplicate it and then disagree with it.

**How to run it.**

```bash
node scripts/factory/status.mjs
node scripts/factory/board.mjs > audit/factory/board.html   # then republish to the same URL
node scripts/factory/cost-report.mjs > audit/factory/COST_ANALYSIS.md
```

**Rollback.** Remove `scripts/factory/{status,board,cost-report}.mjs`, `scripts/factory/lib/state.mjs`,
and `audit/factory/{board.html,COST_ANALYSIS.md}`. Nothing else depends on them.

---

## TRO-244 — CI pipeline with source-code inventory

**What changed.** Added `.github/workflows/ci.yml`: typecheck, build, and unit tests for both
packages on every PR and every push to `main`, plus a source-code inventory job that emits a
per-SHA manifest (files and lines per package, dependency tree, licenses) as a retained artifact.

Web unit tests run with `continue-on-error` because 13 are known-failing (TEST-1 / TRO-223). The
real gate is the step after them, which compares failure *identities* against
`audit/factory/quarantine.json` and fails only on **new** breakage.

`pnpm lint` is deliberately **not** wired in: finding TS-6 (TRO-211) established there is no
ESLint config anywhere, so the script exits 0 having checked nothing. Adding it would make CI
advertise a quality gate that does not exist.

**How to run it.** Automatic on PR and push to `main`; `workflow_dispatch` for a manual run.
Locally, the same checks are `scripts/factory/gate.sh`.

**Rollback.** Delete `.github/workflows/ci.yml`. Nothing else depends on it.

---

## Factory harness — ticket remediation infrastructure (no ticket: tooling)

> Exempt from this file's ticket-ID join-key rule. This is sprint tooling, not a fix for an audit
> finding, so it has no entry in `AUDIT_REPORT.md` and no Linear ticket to join to. Every *code*
> change below this line does carry its ID.


**What changed.** Added the machinery that drives audit findings to merged fixes:

- `scripts/factory/worktree.sh` — provisions an isolated worktree, a dedicated database, and
  per-ticket ports. Necessary because `api/src/test/setup.ts` TRUNCATEs 16 tables in the
  `beforeAll` of every api test file; agents sharing a database corrupt each other's runs.
- `scripts/factory/gate.sh` — the per-ticket eval: typecheck, build, unit tests vs the quarantine
  baseline, tests-not-weakened, regression-test-present, `CHANGES.md` entry, scope, CodeRabbit
  capture. Writes `.factory/gate-result.json`.
- `scripts/factory/lib/testdiff.mjs` — compares failure identities, not counts. Verified against a
  forged run where one test broke and one was fixed: totals unchanged at 13, gate correctly failed.
- `audit/factory/quarantine.json` — the 13 known-failing web tests, so agent regressions are
  distinguishable from pre-existing red.
- `.coderabbit.yaml` — review configuration with path instructions tied to Ship's conventions.
- `.claude/skills/ship-factory/` — orchestration, agent contract, eval tiers, escalation gates.

**How to run it.**

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
cd ../Ship-wt-tro_178 && source .factory-env
scripts/factory/gate.sh          # --fast for the inner loop
```

**Rollback.** Remove `scripts/factory/`, `audit/factory/`, `.coderabbit.yaml`, and
`.claude/skills/ship-factory/`. Clean up worktrees with `git worktree remove`, and drop the
per-ticket databases (`ship_wt_*`) from the `ship-audit-pg` container.

---

## TRO-243 — Secrets loading hard-failed on any host that is not AWS

**What changed.** `loadProductionSecrets()` fetched from AWS SSM with no error handling under
`NODE_ENV=production` and overwrote `DATABASE_URL`. Off AWS it threw and killed the process before
the database was ever contacted. It now falls back to environment secrets when they are present
and rethrows when they are not. AWS behaviour is unchanged.

**How to run it.** Set `DATABASE_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` in the environment and
start with `NODE_ENV=production`.

**Rollback.** Revert the merge of `fix/ssm-fallback` (`5b72a79`).

---

## TRO-242 — Build the image from source and serve the SPA from the API

**What changed.** Multi-stage `Dockerfile` so the image builds from a clean checkout — the
previous one copied `shared/dist/` and `api/dist/`, both gitignored and untracked, so it only
worked in the build-locally-then-ship AWS flow. Express now serves `web/dist` after all `/api`
routes. Same-origin is required by `sameSite: 'strict'` session cookies and by the collaboration
WebSocket URL being derived from `window.location.host`.

**How to run it.** `docker build -t ship . && docker run -p 3000:3000 ship`, or deploy to Render,
which builds from the repository.

**Rollback.** Revert the merge of `feat/render-deploy` (`bace770`).

