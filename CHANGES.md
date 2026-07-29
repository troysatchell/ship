# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-277 — [TEST-12] Load-sensitive api flake: leaking mock queues and an unguarded shared test database

**What was broken.** The api suite failed an otherwise-good branch four times in one day, on a
different test each time, and passed on standalone re-run. `audit/factory/quarantine.json` records
api as `knownFailing: 0`, so each occurrence burned a gate attempt against the 3-retry cap. One
occurrence was on a branch touching only `web/` and `vite.config.ts`, which cannot break an api
DELETE test — so the cause was never in the ticket's diff. Two independent defects were found.

**Defect 1 — `vi.clearAllMocks()` does not drain queued once-values.** Confirmed on vitest 4.0.17:
`clearAllMocks` wipes call records but leaves unconsumed `mockResolvedValueOnce` responses queued.
A test that queues more responses than its handler consumes therefore leaves one behind, and the
next test receives that stale response first — shifting every subsequent mock in that test by one
and surfacing as a failure in an unrelated place. Five api test files combined the two.

**Defect 2 — nothing stopped two api suites from sharing one database.**
`api/src/test/setup.ts` `TRUNCATE`s 16 tables in the `beforeAll` of *every* api test file, and each
file then builds fixtures it depends on for the rest of the file. `fileParallelism: false` makes
that safe within one process and does nothing across processes. Two suites on one `DATABASE_URL`
delete each other's fixtures mid-file. Reproduced deliberately by running two suites against one
database: **18 and 20 failures**, dominated by `expected 401 to be 200` (the session row was
truncated away) and `violates foreign key constraint "documents_workspace_id_fkey"` in nested
`beforeAll` hooks — the exact shapes of all four recorded flakes.

**This also explains the phantom skips.** Two full runs had previously reported
`450 passed | 6 skipped (456)` with no `.skip`/`.todo`/`.fixme` marker anywhere in
`api/src/**/*.test.ts`. When a `beforeAll` hook fails, vitest reports that describe's tests as
**skipped, not failed** — an intermittently-absent assertion that reads as a pass. The two-suite
run reproduced it at scale: **11 and 33 skipped**, same zero markers.

**What changed.**

- `api/src/test/setup.ts` — takes a session-level Postgres advisory lock, held for the duration of
  each test file, before truncating. Concurrent suites now serialize at file granularity instead of
  corrupting each other; on timeout it fails with a message naming the cause rather than producing a
  mystery 401. Advisory lock spaces are per-database, so worktrees with their own database never
  contend, and the lock is released on disconnect so a crashed run cannot wedge the next one. The
  hook timeout is raised above the lock deadline deliberately: a hook that vitest abandons keeps
  running and would truncate outside vitest's control — that hole caused a residual failure in
  testing before it was closed.
- `api/src/routes/issues-history.test.ts`, `api/src/routes/iterations.test.ts`,
  `api/src/__tests__/activity.test.ts`, `api/src/__tests__/auth.test.ts`,
  `api/src/__tests__/transformIssueLinks.test.ts` — `resetAllMocks` in place of the clear-only
  variant. Mock factories in the first two were rewritten from `vi.fn().mockResolvedValue(x)` to
  `vi.fn(impl)`, because `resetAllMocks` restores an implementation passed to `vi.fn()` but wipes one
  chained on afterwards; a naive conversion would have turned those mocks into undefined-returning
  stubs. `issues-history.test.ts` also drops three now-redundant re-establishment lines, one of
  which was an `as any` cast.
- `api/src/__tests__/mock-isolation.test.ts` — new. Pins the four vitest semantics the fix rests on,
  and scans every api test file to fail the suite if the clear-plus-once-queue combination returns.

**Defect 3 — deadlines sized for an idle machine.** With the two mechanisms above fixed, 20 api runs
under concurrent build load still failed 6 times, and half of those failed on nothing but
`Test timed out in 5000ms` — on tests that take 10-70ms unloaded. A deadline 80x a test's normal
duration says nothing about correctness on an oversubscribed machine, and it cost a gate attempt each
time. Separately, `rate-limit.test.ts`'s 320-request burst was the single most frequent failure in
the suite, because `request(app)` binds a throwaway server per call and the burst created 320 of
them; it failed as `socket hang up` and as a 5s timeout.

- `api/vitest.config.ts` — `testTimeout` 5s → 15s, `hookTimeout` 10s → 30s. No assertion is raised or
  removed and nothing is skipped. The hook deadline is the more consequential one, because a hook
  that merely misses its deadline reports its describe's tests as *skipped* — silently dropping
  assertions instead of flagging anything.
- `api/src/middleware/__tests__/rate-limit.test.ts` — the burst binds one server for all 320
  requests, measuring the limiter instead of the ephemeral-port supply. The assertion is byte-for-byte
  unchanged: still 320 requests on one session key, still zero tolerated 429s.

**Evidence.** Red-before-green for the guard test: with two pre-fix files restored it fails with an
`AssertionError` naming `__tests__/activity.test.ts` and `routes/issues-history.test.ts`. Everything
else here is proven by repetition, since converting a mock-reset call has no meaningful unit test.

| Condition | Before | After |
|---|---|---|
| Two api suites, one database | 18 and 20 failures; 11 and 33 phantom skips | 0 failures; 0 skips |
| 20 api runs under concurrent build load (load avg ~29 on 14 cores) | 6 runs failed | **1 run failed** |
| Phantom skips across those 20 runs | — | **0, in all 20** |
| `rate-limit.test.ts` alone, 25 runs under the same load | failed 3 times in 20 full runs | 25/25 |

The one remaining failure is a different defect and is **not fixed**:
`sprint-reviews.test.ts > POST /api/weeks/:id/review > returns 403 without auth (CSRF check first)`
exceeded even the 15s deadline once in 20 runs, which is a hung request rather than a slow one. It
needs its own ticket.

**How to run it.**

```bash
source .factory-env    # api tests TRUNCATE 16 tables; never run them without this

# The guard, and the four vitest semantics the fix rests on.
pnpm --filter @ship/api test --run src/__tests__/mock-isolation.test.ts

# Defect 2, directly: two suites against one database. Both must now pass.
# Before the lock they reported 18 and 20 failures, and 11 and 33 phantom skips.
pnpm --filter @ship/api test --run & (sleep 4; pnpm --filter @ship/api test --run); wait

# The repetition the flake actually needed: build load in parallel with the suite.
for i in 1 2 3 4; do (while :; do pnpm --filter @ship/api type-check; done >/dev/null 2>&1) & done
for n in $(seq 1 20); do pnpm --filter @ship/api test --run >/dev/null 2>&1 || echo "run $n FAILED"; done
kill %1 %2 %3 %4
```

**Rollback.** `git revert` the commits. The lock is confined to the test setup file and the
converted files are self-contained; nothing in `api/src` production code changed.

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
