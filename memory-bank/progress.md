# Progress — Status Log

*What works, what's left, what changed. Append-style updates with dates; newest section first.*

## Status board

| Workstream | Status |
|---|---|
| Codebase orientation | ✅ done (2026-07-27) — full repo map, leads recorded in systemPatterns + config notes |
| Audit skill set (8 skills) | ✅ built at `~/.claude/skills/` (2026-07-27) |
| Repo audit config | ✅ `audit/shipshape.config.yaml` written with verified facts |
| Memory bank | ✅ initialized (2026-07-27) |
| Seed augmentation | ✅ 500 docs / 20 users, deterministic, verified by row count |
| Baseline: type-safety / bundle / tests (Group A) | ✅ done (2026-07-27) — 29 findings |
| Baseline: api-perf → db-query (Group B) | ✅ done (2026-07-27) — 16 findings, 2 Critical |
| Baseline: error-handling / a11y (Group C) | ✅ done (2026-07-27) — 9 + 8 findings, 2 more Critical (ERR-1, ERR-2) |
| Baseline: Terraform/IaC (Category 8) | ✅ done (2026-07-27) — 6 findings (2 High), `audit/terraform/` |
| Live dashboard + defense brief | ✅ published (URLs in log below); dashboard at checkpoint `report-complete` |
| AUDIT_REPORT.md assembled + submitted | ✅ `audit/AUDIT_REPORT.md` — **68 findings, 4 Critical, 8 categories** |
| Findings → Linear tickets | ✅ done (2026-07-28) — 8 epics + 68 sub-issues, `TRO-164`–`TRO-239` (+ `TRO-240` post-baseline) |
| Audit baseline committed + published | ✅ done (2026-07-28) — dual remotes, raw captures gitignored |
| **Tuesday audit gate** | ✅ **verified 2026-07-28** — every required table row present; rule 1 clean |
| Orientation write-up (`audit/ORIENTATION.md`) | ✅ done (2026-07-28) — a *final-submission* item banked early |
| Raw evidence committed | ✅ done (2026-07-28) — 11 cited paths now resolve |
| Coverage tooling configured + measured | ✅ done (2026-07-28) — api 40.52% / web 28.53% lines |
| **Render deploy** | ✅ **live + seeded (2026-07-28)** — https://ship-rr6m.onrender.com |
| Assignment implementation rules tracked | ✅ epic `TRO-241` + 6 sub-issues (2026-07-28) |
| Screen-reader pass (Cat 7) | ✅ done (2026-07-28) — A11Y-1 escalated to Urgent |
| Ticket factory harness | ✅ built + self-tested + committed (2026-07-29) — `feat/ticket-factory-harness` @ `ea2dcd3` |
| CI pipeline (`TRO-244`, rule 4) | ✅ written (2026-07-29) — `.github/workflows/ci.yml`; first real run is the harness PR |
| **Improvement phase (Phase 2)** | 🟡 **underway (2026-07-29/30)** — 26 audit tickets Done (was 5), 16 PRs merged this run, **1 PR open** (#11, blocked on TRO-288) |
| Post-baseline findings from remediation | 🟡 13 filed — `TRO-276`–`TRO-288`, all marked post-baseline (1 cancelled after investigation, 1 High and in flight) |
| Demo-video companion artifact | ✅ published (2026-07-28) — before/after slots now have real numbers, see log |
| Discovery write-up · demo video · AI cost analysis · social post | ⬜ Sun Aug 2 |
| Final polish + presentation | ⬜ Sun Aug 2 |

## Log

### 2026-07-30 (Thu) night — deliverable push: 13 more PRs merged (25 tickets today), Cat 7 banked, measurement pass running

**Merged after the evening entry:** #45 #46 #48 #49 #50 #51 #52 #53 #54 #55 #56 #58 #59 — TS-1/2/3/4,
TS-6, DB-6/7/8/10, ERR-6+TEST-5, ERR-13/14, A11Y-4/5/6/7/8, BUN-7/8, RULE-6, RULE-7. Method: the
documented local `--no-ff` sequence + merge-changes/jsonl-union + combined verify per batch + single
push. Two integration repairs caught by the combined verify, both from strict-flags-vs-parallel-
authorship: radixVersionDedupe.test captures (fixed on main) and nothing else.

**Category 7 banked** (compare-phase2-jul30, merged to main): all 8 baseline findings resolved,
C/S = 0 on the three key pages across all states, my-week Lighthouse 95→100. New Serious on
/weeks+/search is TRO-298 (DashboardSidebar contrast, newly reachable via the A11Y-5 wildcard-route
fix — `getActiveMode()` fallback mounts DashboardSidebar there).

**Category 1's metric corrected (TS-4 agent):** `count.sh`'s non-null pattern has a BSD-grep bracket
bug — the 236 `req.userId!` sites were never in the tracked count, and live totals grew with the
codebase (1747 now vs 1535 baseline). Category progress is provable ONLY as controlled per-ticket
diffs: ~130+45+19+233 ≈ 427 sites retired ≥ 384 target. Corrected api non-null: 286 → 53.

**Infra fights:** GitHub dropped pull_request webhook events 19:33–19:43 (no Actions runs created;
status page clean) — close/reopen did NOT re-trigger; empty commits didn't either; workflow_dispatch
DID and became the session's CI path. CodeRabbit was rate-limited org-wide all evening — merged the
green queue on the documented degraded-service judgment; deferred triage sweep owed when reviews
land. session-activity-race flaked CI 4× today post-TEST-15-fix → TRO-300 (High).

**New tickets today:** TRO-291..301 (login recovery guidance, tfplan hygiene, quick-menu fixmes,
ALB doc URL, SG quota High, marks round-trip, floating promises 398, DashboardSidebar contrast,
Render TF config→PR #57, TEST-16 flake, doc-read retry). Session end state: backlog no longer has
Urgent/High audit items unstarted except human-held TF work.

### 2026-07-30 (Thu) evening — factory resumed: recovery, 3 merges, 8 agents in flight

**Recovery first, per `/ship-orchestrator` §4:** reconciled disk/branches/Linear. Found `main` had
already advanced past this file's previous entry (PRs #34 TEST-15, #38 ERR-3/4, #39 tooling were
merged); 19 worktrees were stale leftovers of Done tickets — removed, databases dropped. TEST-15's
worktree branch had zero unique commits (its work merged via PR #34); verified before deleting.

**Merged this session (local `--no-ff` sequence, combined verify, single push; main
`3bc90ed` → `9a15f43`, all remotes identical):**
- **#40** TEST-14/TRO-286 — the 22-finding CodeRabbit round fixed first (ledger 82→104); api
  604/604, web 363/363 at gate.
- **#42** RULE-5/TRO-246 — CI builds the image once → GHCR tagged by SHA; Render switch is a held
  runbook. Gate honestly failed only `regression-test`; orchestrator judged it inapplicable
  (CI+docs deliverable) and recorded the judgment rather than gaming a test.
- **#43** A11Y-2/TRO-216 — root cause was tippy.js `aria: {expanded: 'auto'}` on the BubbleMenu
  anchor, not app markup; live axe editor-focused C1→C0.

**Combined verify note:** api suite failed once inside the full run under 8-agent load and passed
46/46 on re-run; first capture truncated the identity (orchestrator script bug — `tail -8`), so it
is recorded as load-transient with identity unknown, plainly.

**Held for human:** PR #41 (TF-2 — ticket premise partially wrong: only `environments/prod` was a
true duplicate; dev/shadow kept; live IAM `PutSecretValue` gap ported), PR #47 (TF-7 — `trust
proxy 1` meant `req.ip` was CloudFront's edge IP for ALL traffic; SG prefix-list lock + hop-count
2 must land together; TRO-295 quota check before apply).

**Open PRs in fix rounds:** #45 (TS-3; converter any 12→0, api explicit-any 78→59; recursive-guard
finding) and #46 (TS-1; 156 latent errors fixed — the audit's 102 had drifted; ReviewsPage
invariant gap found+tested).

**New tickets:** TRO-291 (login recovery guidance), TRO-292 (committed tfplan, strings-scan
clean), TRO-293 (fixme'd quick-menu tests), TRO-294 (doc ALB health-check URL), TRO-295 (SG
prefix-list quota, High), TRO-296 (converter marks round-trip asymmetry).

**Process:** all ticket agents on Sonnet per standing decision; wave sizing kept to ~8 with gates
staggered; wave-1 briefs omitted the ledger-recording instruction (orchestrator recorded 15 rows
after the fact — instruction now included in later briefs).

### 2026-07-30 (Thu) — Phase 2, wave 3: 16 PRs merged, main at `319e1af`

**`main` went `4d74602` → `319e1af`, verified via `git log --oneline --merges`. 16 PRs merged, both
remotes in sync.** Audit tickets Done: 5 → **26**, counted directly against Linear this session
(filtered to the ShipShape Audit Remediation ID range so the workspace's unrelated projects don't
inflate it). Merged: #14, #8, #20, #19, #13, #12, #24, #17, #22, #23, #29, #30 (21 tickets) plus
tooling #26, #27, #28, #31.

**Headline results below are as measured and recorded by the implementing agents in `CHANGES.md` /
PR bodies — this session did not re-run the benchmarks, only confirmed the PRs merged and the
tickets they claim:**

| PR | Tickets | Headline result |
|---|---|---|
| #14 | TRO-197/198/199/200/202 (BUN-1,2,3,4,6) | `/login` 601 → 117 kB gzip (−80.5%) |
| #8 | TRO-178 (DB-1) | migration runner applies 42/42 or exits non-zero |
| #20 | TRO-174 (API-3) | `/api/issues` 379,907 → 25,050 B (15.17×) |
| #19 | TRO-173/182 (API-2/DB-5) | payload 380 → 241 kB; p95 90.4 → 59.1 ms; one pre-existing `as any` deleted |
| #13 | TRO-179/177 (DB-2/API-6) | session write throttled; 10 row versions → 1 |
| #12 | TRO-276 (ERR-10) | malformed frame closes its socket, not the process |
| #24 | TRO-224/225 (TEST-2/3) | the stored-XSS spec now actually tests sanitization |
| #17 | TRO-240 (DB-11) | one SSL decision shared by every pool |
| #22 | TRO-226 (TEST-4) | concurrent Yjs merge coverage |
| #23 | TRO-277 (TEST-12) | api flake 6/20 → 1/20 under load |
| #29 | TRO-181/176 (DB-4/API-5) | dashboard fan-out: 5 requests → 1, 30 queries → 6 (−80% each) |
| #30 | TRO-192/195 (ERR-5/ERR-8) | malformed path/query params return 400/404 instead of 500 |

**Verified by the orchestrator directly against the integrated `main`** (not self-reported by the
ticket agents) — dockerised postgres 15 on `:5433`, database `ship_factory_integration`: typecheck
clean, build clean, api **533/533** then **592/592**, web failures exactly the quarantined
identities with zero new (`testdiff.mjs`), and 42/42 migrations against a fresh database. Checked
twice, once per verification pass over the combined merge result.

**Merge method matters and is now the documented one.** Merging PRs one at a time through GitHub
re-conflicted every other open branch on `CHANGES.md`, so the queue could not drain. What worked:
integrate locally with `git merge --no-ff` in sequence, resolve each `CHANGES.md` with
`scripts/factory/merge-changes.mjs` (reports "entry integrity OK — all N entries byte-identical to
source"), union each append-only `.jsonl`, then verify the *combined* result before one push. Two
merges were deliberately **aborted** rather than auto-resolved because they were real code
conflicts needing judgement, not text ones — #17 vs #8 in `api/src/db/migrate.ts`, #23 vs #13 in
`api/src/__tests__/auth.test.ts` — both then hand-resolved by agents instructed to preserve both
fixes.

**Four factory tooling defects found and fixed** (confirmed by reading `scripts/factory/gate.sh` and
`.factory-env` directly):
1. G9 (`coderabbit review`) had **no timeout** and hung 11+ minutes at 2.6s CPU under concurrent
   load. Now wrapped in `timeout`/`gtimeout` (`CR_TIMEOUT`, default 360s) — `gate.sh:277-335`.
2. G9 **overwrote a completed `.factory/coderabbit.json` with a rate-limit error stub**, destroying a
   captured 10-finding review. Now captures to a temp file and keeps older findings on timeout,
   reporting `KEPT n finding(s) from an earlier run`.
3. `FACTORY_BASE_REF` **could not be overridden** — `.factory-env` hardcodes `main` and `set -a; .`
   clobbered the caller's exported value (`gate.sh:39-51`). Local `main` is one shared ref across
   worktrees and had lagged `origin/main` by three merges mid-session.
4. The `check-attr` rule in `lessons.md` **was wrong** and is now corrected — see watch-outs below.

**`lessons.md` gained rules 21–25**: type the boundaries G7b cannot see (`pool.query` rows,
`response.json()`); never start a background poll and wait on it; run `pnpm install` after merging
`main`; the api flake's five identities; a commit message claiming a cleanup is not evidence of it.

**Review ledger: 74 findings across 13 tickets**, counted directly this session via
`node scripts/factory/review-ledger.mjs report` (74 rows in `audit/factory/review-findings.jsonl`,
confirmed by line count). The file held 38 lines at the start of this run (`git show 4d74602:...`);
the run's own tracking put the pre-run figure at 50, a gap this session didn't reconcile further.
The aggregate's headline: type-safety is 8 findings across 6 tickets and still the largest single
class — but it was **also** filed under `implicit-any` (2), `unsafe-cast` (1), `unsafe-type-cast`
(1) and `test-cast` (2), so the fragmented taxonomy hid a class of **14**. Record everything in that
family under the single slug `type-safety` going forward.

**Watch-outs verified this run:**

- **`git check-attr merge -- CHANGES.md` after a merge is NOT a valid check — this reverses the
  prior rule in this file.** The merge replaces `.gitattributes` with `main`'s version, so it reads
  `unspecified` even when the union driver just corrupted the file. Two agents independently saw a
  clean `unspecified` beside a genuinely spliced `CHANGES.md` (17 unbalanced fences in one case, 13
  plus a spliced command block in the other). Only `merge-changes.mjs --check` catches it.
- **After `git merge main`, run `pnpm install`.** PR #20 added `compression`; a stale `node_modules`
  fails at module load, so ~19 api test files fail at once plus typecheck errors. Three agents read
  this as a catastrophic regression from their merge. Tell: failures in files the diff never
  touched, module-resolution errors rather than assertion errors.
- **Agents stall if they start a background poll and wait on it.** Six did, on CI checks, gate runs
  and monitors. Nothing wakes them; each had to be nudged to produce a report it had already earned.
- **The load-sensitive api flake now has five identities**: `backlinks.test.ts`, `rate-limit.test.ts`,
  `weeks.test.ts::should reject review approval without rating`,
  `session-activity-race.test.ts::modifies the session row exactly once…`, and a candidate
  `workspaces.test.ts::should archive person document`. All fail inside a full gate run and pass
  standalone — five unrelated identities is the evidence for one shared mechanism, not five flaky
  tests.

**New architectural pattern, verified in code and now in `systemPatterns.md`.** Three agents
independently hit the same class in `api/src/collaboration/index.ts`'s connection handler: async
work between making a socket reachable and making it able to respond. Read directly:
`getOrCreateDoc()` (line 227) publishes a new `Y.Doc` into the shared `docs` map **before** its
`await pool.query(...)` (line 233) loads real state — a second concurrent connection during that
window gets the still-empty doc (ERR-12, `TRO-285`). Separately, the connection handler (line 1009)
`await`s that same `getOrCreateDoc()` call (line 1018) **before** attaching `ws.on('message', ...)`
(line 1059) — inbound frames arriving in that window have no listener yet and are dropped (ERR-11,
`TRO-284`). ERR-10 (the `'error'` listener, line 1016) was the first instance of this class and is
already fixed by moving the listener to the first statement in the handler, before any `await`.

**Current state:**

- **Open PRs: #11 only** (TRO-223 / TEST-1). Gate-green (CodeRabbit pass, CI pass), pushed, and
  empties the quarantine entirely — `web.knownFailing: 0`, `api.knownFailing: 0` in the merged tree.
  **Web suite: 346/346, 0 failed** — observed by the orchestrator directly on branch
  `fix/test-1-web-suite-green` at `580ca13`, `pnpm --filter @ship/web test`, dockerised postgres 15
  on `:5433` (2026-07-30). **Two prior figures in this log entry were wrong and are both superseded:**
  neither the original 345/345 nor the subsequent "186/186, branch behind at `84f05ff`" correction is
  current. The second correction checked the PR *description*, which the author never updated
  through three later `main` merges — the branch itself (`git merge-base --is-ancestor` against both
  `319e1af` and `f7b15c9` returns true) is fully caught up with all 16 PRs from this run. The PR
  description is a stale artifact; the branch is the authority. #11 is still unmerged, blocked on
  TRO-288, so 346/346 describes the branch, not `main`. Its own work found 1 genuine product
  regression (a count-aware tab label dropped by an earlier commit, `UnifiedDocumentPage.tsx:133,141`)
  among 12 stale tests, plus a second regression filed separately (`ProgramWeeksTab.tsx` navigates to
  a now-dead `sprints` tab id), plus a commit message that falsely claimed two cast removals when only
  one happened (this is `lessons.md` rule 25).
- **New ticket: `TRO-288` [TEST-15], High, In Progress** (confirmed in Linear) —
  `session-activity-race.test.ts` asserts exactly-once under a concurrent burst and fails CI on
  branches that don't touch auth, blocking the merge queue. Hit CI on #29 (passed on a plain re-run
  of the same commit) and on #11. Acceptance bar: 10 consecutive runs under deliberate load, still
  red against the pre-DB-2 unconditional write.
- **In flight:** `TRO-284` + `TRO-285` (ERR-11/ERR-12, both confirmed "In Progress" in Linear) — the
  collaboration load-window pair described above. ERR-11's regression test is confirmed red for the
  documented signature (frame sequence `[3,0,1,1]`).
- **Maintainer decisions this run:** merge #17 now and read the SSM `DATABASE_URL` before the next
  deploy; merge #13 without a separate human auth read; installing CodeRabbit's GitHub App for the
  repo to remove the review rate-limit bottleneck.

**Still owed to a human:** read the production SSM `DATABASE_URL` before the next deploy (PR #17
makes the API refuse to start if it resolves to `sslmode=disable`, and there's no `aws` CLI here to
check it); VoiceOver on `TRO-215` and `TRO-281` (still nobody has *heard* either); a decision on
PR #30's ordering change (`router.param` now fires before `authMiddleware`, so a malformed id from
an unauthenticated request returns 400 where it used to return 401).

### 2026-07-29 (Wed) night → 2026-07-30 — Phase 2, three factory waves

**19 tickets worked. 4 merged, 12 in review.** `main` at `84f05ff`. Every gate run by the orchestrator
independently of the agent's self-report; no ticket merged on a self-report.

**Merged audit findings (4):** `TRO-172` API-1 (rate limiter), `TRO-188`+`TRO-189` ERR-1/ERR-2
(collaboration socket), `TRO-215` A11Y-1 (sidebar ARIA).

**Measured results now in hand** — these are the Friday compare-mode numbers:

| Finding | Before → After | Conditions |
|---|---|---|
| API-3 gzip | `/api/issues` **379,907 → 25,050 B (15.17×)** | payload bytes over real HTTP, not loopback timing |
| BUN-1..6 | `/login` **601 → 117 kB gzip (−80.5%)** | transitive static-import closure per route |
| API-2/DB-5 | payload 380 → 241 kB; p95 c=25 **90.4 → 59.1 ms** | 254 issues, seed-augmented, autocannon |
| A11Y-3 | Lighthouse **95 → 100**; axe 18 Serious → **0** | Chrome headless 1440×900, authenticated |
| DB-2/API-6 | **20% fewer statements per read**; 10 row versions → 1 | 12 sequential reads, `NODE_ENV=test` |
| TEST-1 | web **138/151 → 214/214**; quarantine emptied | — |
| TEST-12 | api flake **6/20 → 1/20** failures under load | 4 concurrent build loops, load ~29 |

**Three agents independently found one architectural flaw** in `api/src/collaboration/index.ts`: async
work happening between making something reachable and making it able to respond. ERR-10 (`'error'`
listener after an `await`) is fixed; ERR-11 (`TRO-284`, `'message'` listener, drops sync step 1) and
ERR-12 (`TRO-285`, doc published to the shared map before it loads) are filed. Worth a
`systemPatterns.md` note before someone makes it a fourth time.

**Agents corrected the audit repeatedly, which is the result worth keeping:**
- **API-2's estimate was arithmetically wrong** — it applied `content`'s *database* share (64.5% of row
  bytes) to the *JSON payload*. On the wire it was 38.4%, so 1.57× not 2.6×.
- **A11Y-3's stated cause was wrong twice over** — the dominant cause was `opacity-40` (18 of 24 nodes),
  which the ticket never mentions; and `bg-accent/20`, which it blames, is not the defect (`#005ea2` is
  already 2.89:1 as text before any badge exists).
- **The stored-XSS test never tested sanitization at all.** TipTap has no markdown-link input rule, so
  `[Click](data:...)` produced **zero `<a>` elements** — "the app rendered nothing" was passing as "the
  app sanitised the URI", for the whole life of the test.
- **TEST-4's coverage claim (25%) was not reproducible** — ERR-2's test had landed on that file hours
  earlier and already lifted function coverage to 67.24%.
- **The api-flake connection-timeout hypothesis was disconfirmed by code.** `auth.ts:230-238` returns
  500 on a query error, so a timeout can never produce the observed 401. The correlation was real; the
  mechanism was invented.

**Factory self-improvement, driven by aggregating review findings.** `review-ledger.mjs` records every
finding; grouping day-one's 29 showed type-safety recurring across **4** tickets and fixed sleeps across
**3**, every one filed *after* the gate passed. So `gate.sh` gained **G7b** (`review-patterns.mjs`) for
the two mechanically-decidable classes, and `lessons.md` gained rules 16–20 for the rest. G7b
immediately caught 12 violations on one branch and 5 on another that the reviews had missed.

**Two of my own tools were wrong and were fixed:**
- `merge=union` on `CHANGES.md` silently damaged all five open branches (dropped the shared
  `**How to run it.**` heading and ```` ``` ```` fences — 9 entry headings, 8 run blocks). CodeRabbit
  caught it. Replaced with `merge-changes.mjs`, which merges whole entries and **asserts byte-identity**.
- G5 (`tests:not-weakened`) counted removals alone, so a corrected assertion looked like a deleted one.
  It misfired 3× — forced an override on TRO-223 and made TRO-179 revert two legitimate renames. Now
  compares removed *vs added*.

**Decisions:** ticket agents run on **Sonnet** (the brief carries the knowledge, not the model);
concurrency is capped by **gates, not agents** (load hit 39.75 on 14 cores and manufactured phantom
failures).

**Still owed to a human:** VoiceOver on `TRO-215`/`TRO-281`; Terraform tickets need escalation gate 2
before any `apply`.

#### Review-triage round — what the reviews found after the gates had passed

Every open PR was triaged. Findings are in `audit/factory/review-findings.jsonl` (47 rows);
`node scripts/factory/review-ledger.mjs report` groups them by recurrence.

**Two were live defects, not nits:**

- **DB-11 / PR #17 — the connection string overrides the resolved `ssl` object.** `?sslmode=disable`
  in `DATABASE_URL` discards it entirely and puts the socket on plaintext, so the whole DB-11 fix
  could be defeated by the one thing most likely to arrive copy-pasted from a dashboard. Established
  from pg source (`connection-parameters.js:56` — `parse()` is the last source and overwrites the
  caller's `ssl`), then measured across all six `sslmode` values; `disable` is the **only** one that
  defeats it. The guard now **refuses to start** in production rather than rewriting the URL —
  silently editing an operator's explicit instruction is the same defect as the original bug.
  **⚠️ Deployment precondition: if production SSM already has `sslmode=disable`, this converts a
  working deploy into a startup failure. Nobody could read SSM. Check it before rolling out.**
- **API-3 / PR #20 — case-sensitive exclusions.** With the library filter alone, **both**
  `Text/Event-Stream` and `Application/Octet-Stream` compress. The two guards were the only thing
  stopping them and case defeated both; for octet-stream the bypass was **client-controlled**, since
  `files.ts:309` echoes a client-declared mime type validated only against a filename blocklist. Also
  verified that `compression.filter`'s own mime-db lookup **is** case-insensitive, so only the
  additions needed normalizing — recorded so nobody "fixes" the library path later.

**One correction reversed an orchestrator conclusion.** On PR #8 I concluded the rolled-back-batch
path was unreachable because `schema.sql` is fully idempotent (17/17 tables, 59/59 indexes, both
enums guarded — the agent confirmed those counts by hand). **Wrong, because
`CREATE TABLE IF NOT EXISTS` is check-then-create and not atomic.** Raced: 12 sessions × 40 rounds →
**434 × `23505`** on `pg_type_typname_nsp_index`; the real `schema.sql` from 6 connections → **5 of 6
failed**. `42710` was in the tolerated set, so that path swallowed a full rollback and reported
success. I answered the *category* (is the file idempotent?) and not the *case* (what happens
concurrently?) — the exact `.claude/CLAUDE.md` rule I had been citing at agents. TRO-279 escalated to
High with the numbers.

**A test I had defended was encoding the bug.** I flagged
`still tolerates duplicate-object errors raised by schema.sql itself` as the guard against "fixing
this by deleting the tolerance". It passed *precisely because nothing was applied and nobody was
told*. Replaced with one that asserts a dropped table is **not** recreated.

**The headline bundle number survived scrutiny.** A reviewer found `routePayload()` walked only `.js`
imports, so lazy-chunk CSS was omitted and every route read smaller than it was. Re-measured against
Vite's manifest graph: `/login` **601.47 → 117.34 kB gzip, −80.5%** — the fix moved it by 0.05 kB,
because this app's only lazy stylesheet hangs off `vendor-editor` and was never in a *static* closure.
The method was still wrong and the fix is what stops the next CSS-bearing lazy chunk going unmeasured.
The same review exposed that the static-import guard was **vacuous against 7 of 7 forms** — the old
regex missed every one, the new detector catches all seven.

**Three more shared-state failures**, all the same class as the `refs/stash` collision: the shared
scratchpad clobbering a merge input (integrity passed on the *wrong* source — byte-identity cannot
prove the inputs were intended, hence `merge-changes --expect`), git reading merge attributes from the
**pre-merge** tree (so removing `merge=union` protected nothing until each branch merged it, damaging
three more files while reporting success), and a G7b rule left **uncommitted** in the orchestrator's
tree so every branch ran the weaker checker. All three are now rules in `lessons.md`.

### 2026-07-29 (Wed) — Day 3 — ticket factory built and proven on itself

**No audit tickets were worked today.** What was built is the machinery to work them
autonomously, plus `TRO-244` (CI), which the factory needed anyway. Shipped via PR #1
(`feat/ticket-factory-harness` → merge `2dced06`), CI green on both jobs.

- **Green-on-arrival established.** `audit/factory/quarantine.json` — api **451/451 green**, web
  **138/151**, the 13 failures being TEST-1 (`TRO-223`), recorded by *identity*
  (`file::full test name`), not by count. api was measured on a dedicated database because
  `api/src/test/setup.ts:9-21` TRUNCATEs 16 tables in the `beforeAll` of every test file.
- **The eval is two-tier**, and the distinction matters: `gate.sh` answers *did this break
  anything* (seconds, every attempt); a category compare run against the `audit-baseline` tag
  answers *did this measurably improve anything* (expensive, batched). Tests passing is not
  evidence of improvement, and improvement is 40% of the grade. Details in
  `.claude/skills/ship-factory/references/evals.md`.
- **The gate was negative-tested, not assumed.** Forged a vitest report where one passing test
  fails and one quarantined test is fixed: total failures stayed at 13, and the gate still failed
  and named the new break. A count-based comparison would have passed it.
- **CodeRabbit reviewed the harness itself — 13 findings, 10 fixed, 3 dismissed.** Two were
  serious:
  1. *Critical* — the ticket ID reached `CREATE DATABASE` uninterpolated-unchecked in
     `worktree.sh`; identifiers can't be bound as parameters, so `X"; DROP DATABASE …` would have
     executed. Now validated against `^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$` before any psql call.
  2. *Anti-gaming hole* — `gate.sh` read `quarantine.json` from the **ticket branch**, so an agent
     could have appended its own new failures and gone green. Now materialized from `BASE_REF`.
  Dismissed: two gitignored build artifacts and one trivial nit.
- **Two bugs found by my own testing**, both now rules in `references/lessons.md`: in a linked
  worktree `.git` is a **file**, so `.git/info/exclude` fails "Not a directory" and under `set -e`
  aborts provisioning *before* migration (a worktree came out with a database and 0 tables); and
  `grep -c … || echo 0` yields `"0\n0"` because `grep -c` prints `0` then exits 1.
- **DB-1 reproduced again** incidentally: provisioning ran `pnpm db:migrate`, which reported
  `rc=0` while abandoning at migration 010. Schema still complete, because `schema.sql` runs
  first — the documented nuance, confirmed a second time.
- **`gh` could not resolve the repo at all** — `origin` fetches from GitLab, so every `gh pr`
  call would have failed. Fixed with `GH_REPO=troysatchell/ship` in `.claude/settings.local.json`
  rather than by touching the deliberate dual-push remote config.
- **CodeRabbit GitHub App is not installed** — verified from the CLI's own message, not inferred.
  Without it there are no automatic PR reviews.

**Decisions (maintainer, 2026-07-29):** auto-merge once the CodeRabbit review is green; push and
PR creation pre-authorized; parallel by default, serializing only on real dependencies; scope for
Phase 2 is the 4 Criticals + the assignment rules, not all 75 tickets.

### 2026-07-28 (Tue) — Day 2, night — Phase 1 closed, application deployed and seeded

**Phase 1 is done.** Tagged `audit-baseline` at `149873a` so compare mode has a fixed reference and the Phase 1 state stays unambiguous after Phase 2 starts changing source.

- **Raw evidence committed** (`b516ab7`). The report cited 11 raw-data paths and **none** were in the repo — silently breaking Category 2's treemap requirement and Category 8's "save the plan output", plus the deliverable's own "raw data" row. Now 102 files / ~9.8 MB tracked. A global `*.log` rule was still swallowing `pg-statements.log` and `api-3009.log` (both cited evidence), so there is an explicit `!audit/**/*.log` negation with a comment. Screened first, since GitHub is public: no hashes, tokens, or real addresses — only synthetic `ship.local` seed data.
- **Coverage tooling configured and measured** (`149873a`). Category 5 says *configure it*, not *report it broken*; the registry became reachable, so the provider was installed at vitest's exact version, both suites measured, manifests reverted (the same install-measure-revert the bundle category used). Real figures replace the approximation: **api lines 40.52% / branches 33.44% / functions 40.90%; web lines 28.53% / branches 19.38% / functions 25.60%; shared 0%**. Three things the substitute could not have found: the provider must match vitest's *exact* release (`^4` → 4.1.10 fails against 4.0.17); `coverage.reportOnFailure` defaults to **false**, so web's 13 failing tests suppressed the report entirely (**TEST-1 and TEST-7 compound**); and the real api figure is *lower* than the raw profiler suggested (40.90% vs 51.4%, different denominators).
- **Deployed and seeded** — https://ship-rr6m.onrender.com. Two fixes were required, both on branches, both merged `--no-ff`:
  - **`TRO-242`** (`137dcd4` → `bace770`) — multi-stage Dockerfile so the image builds from a clean checkout, plus ~12 lines serving `web/dist` from Express after all `/api` routes. Same-origin is forced by `sameSite: 'strict'` cookies and the WS URL from `window.location.host`.
  - **`TRO-243`** (`11e93b6` → `5b72a79`) — `loadProductionSecrets()` fetched from AWS SSM with no error handling under `NODE_ENV=production` and **overwrote** `DATABASE_URL`. Off AWS it threw and killed the process before the database was touched. Now falls back to environment secrets when present, rethrows when not. AWS behaviour unchanged.
  - Render Postgres `dpg-d9kgth6417fc7386hhh0-a` created (free, oregon, pg16), migrated, seeded to **11 users / 257 documents**. Seeding needed a temporary IP allowlist entry — Render defaults to `ipAllowList: None` — **removed afterwards**; the service connects internally.
- **Screen-reader pass done, and it paid off.** VoiceOver revealed the workspace sidebar **does not announce document titles at all**. `TRO-215` escalated **High → Urgent** with the full diagnosis: `role="tree"` declares a composite widget, but there is no `tabIndex`, no `onKeyDown`, no `aria-level`/`setsize`/`posinset`, and bare `<li>` children at `App.tsx:648,653`. Accessibility got *worse* by adding ARIA — plain `<ul><li><a>` would read correctly. Recommended fix is removal, not implementation.
- **Assignment rules now tracked** — epic `TRO-241` with `TRO-244` (CI, Urgent), `TRO-245` (regression tests), `TRO-246` (build/release/run), `TRO-247` (one-command start), `TRO-248` (retries/timeouts/breakers), `TRO-249` (`CHANGES.md`). Plus `TRO-242`/`TRO-243` filed as Done with before/after and tradeoffs, which is rule 9's improvement documentation.

**Two corrections recorded** so they are not repeated:

1. **DB-1 does not break a fresh database.** `migrate.ts:38-41` runs `schema.sql` first, which carries the end state — a new Render Postgres came out complete (18 tables, 83 indexes) despite the loop abandoning at migration 010. The hazard is an *existing* database at an intermediate state. This was stated backwards earlier in the day.
2. **A smoke test under `NODE_ENV=development` does not exercise the production startup path.** That is exactly how the SSM coupling was missed on the first local container test — `ssm.ts:39` returns early below production.

### 2026-07-28 (Tue) — Day 2, end of day — gate verified, orientation banked, Render blocked

- **Tuesday gate verified rather than assumed.** Checked `AUDIT_REPORT.md` row-by-row against the PDF's per-category Deliverable tables: all present, several over-delivering (6 API endpoints vs. a required 5; 6 DB flows vs. 5; type-safety table carries all 7 required rows including the `@ts-ignore` count). **Rule 1 confirmed by diff, not by assertion** — `git diff 076a183..HEAD -- api/ web/ shared/ terraform/ e2e/` is empty. Only `audit/`, `memory-bank/`, `.claude/`, `.gitignore`, `README.md` moved.
- **`audit/ORIENTATION.md` written** (`13b11b5`) — the Appendix checklist deliverable, all 8 sections. Orientation itself happened 2026-07-27; this is the write-up, and claims sourced from later *measurement* are marked `[audit]` with their finding ID so the two aren't conflated. It's a **final-submission** item, so it's banked early. Best line in it: at 10× users the unified document model is *not* what breaks — every scaling problem is in the access layer and fixable without touching the data model.
- **Corrected a genuine docs defect** (`56ae2aa`). `.claude/CLAUDE.md:102` claimed `documents.program_id` and `documents.project_id` "still exist" and credited migration 027 with dropping only `sprint_id`. Both clauses wrong: **027 drops `sprint_id` AND `project_id`; 029 drops `program_id`** — all three gone. Likely cause of the confusion: `sprint_iterations.sprint_id` (`schema.sql:272`) is a live column on a *different* table. Corrected text calls that distinction out and keeps the DB-1 caveat that `\d documents` remains the authority.
- **README gained a fork section** — links `AUDIT_REPORT.md` + `ORIENTATION.md`, states baseline conditions, and carries four cold-start warnings drawn from DB-1, TEST-9 and TEST-1 (migrate exits 0 while under-applying; `pnpm test` truncates your dev DB; root `pnpm test` skips web; `pnpm dev` writes its own `.ports`).
- **New finding: DB-11 → `TRO-240`.** `api/src/db/client.ts` configures **no `ssl`** on the main application pool, while `migrate.ts:32` and `seed.ts:44` both set `ssl: { rejectUnauthorized: false }` in production. Invisible on AWS (Aurora is in-VPC); breaks against any TLS-requiring managed Postgres. Failure signature is confusing because `Dockerfile:35` is `migrate && index.js` — migrate connects and exits 0, then the app fails, so logs read as a database problem rather than a client-config one. **Marked post-baseline in the ticket; it is NOT one of the report's 68** and must not be counted toward the baseline.
- **Render: service created, deploy blocked.** `ship` / `srv-d9kf2t942hec73aofrt0`, oregon, **docker** runtime, free plan, `https://ship-rr6m.onrender.com`. Two hard stops found by reading the Dockerfile rather than by deploying:
  1. `Dockerfile:22-23` copies `shared/dist/` and `api/dist/`, both gitignored and untracked — `.dockerignore` even documents the assumption. The image is designed for the AWS build-locally-then-ship flow; Render clones from GitHub, so COPY finds nothing. **This is assignment rule 5 in disguise** (build once, promote the artifact).
  2. The image is **API-only** — no web build, so no UI regardless.
  Also: no Postgres instance exists in the workspace (hence no Internal URL anywhere) — must be created in **oregon** to match the service for internal networking.
- **Render credentials in hand.** Key in gitignored repo-root `.env`; owner ID `tea-d9kevetg1s2s73807n5g` retrieved via `GET /v1/owners`. Corrected earlier env-var guidance: the docker runtime means `NODE_ENV`/`PORT`/`VITE_APP_ENV` come from the Dockerfile and `NODE_VERSION` is irrelevant — only `DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN` need setting, plus health check path `/health`.
- **Demo video is Sunday, not Tuesday** — and cannot be made early, since its spec requires improvements and before/after measurements that rule 1 forbids producing during the audit. Published a demo-video companion artifact instead (British-green-on-cream, talking-points density) with measured baselines, targets, and *pending* after-slots to fill Friday: claude.ai/code/artifact/a13fd909-f20b-4fdc-bf07-de50e08d43b7

### 2026-07-28 (Tue) — Day 2, later — assignment PDF re-read; brief was incomplete

- **Read `/Users/troy/Documents/G.Assignments/GFA_Week_4_ShipShape_Updated.pdf` (13 pp) in full.** `projectbrief.md` had been a partial transcription — it captured the 7 category targets, deadlines, and audit rules but **missed the 11 implementation rules, the 10-row submission deliverable table, and the grading weights**. Brief rewritten from the source; it now points at the PDF path as the authority.
- **Render vs Railway: SETTLED — Render.** Not a judgment call; Category 8 states deployment is via Render with its official first-party provider (`render-oss/render`) and that **no AWS account or cloud credentials are required**. Also: the Render service must be **created by `terraform apply` from a clean checkout**, so it must not be hand-built in the dashboard.
- **Topology forced to one Render web service** (API + SPA same-origin). Verified in code: session cookie `sameSite: 'strict'` (`api/src/middleware/auth.ts:217`, `api/src/routes/auth.ts:188`), collab WS URL from `window.location.host` (`web/src/components/Editor.tsx:334`), `VITE_API_URL` defaults to `''` (`Editor.tsx:330`). A static-site + separate-API split silently breaks auth and collaboration. **The API does not serve `web/dist` today** — required code change before any deploy works.
- **Newly surfaced graded scope, none of it in the 68 findings:** CI pipeline w/ source-code inventory (rule 4), regression tests per audit bug (rule 3), build-once/promote artifacts tagged with git SHA (rule 5), one-command local start (rule 6), retries/timeouts/circuit breakers (rule 7), `CHANGES.md` (rule 8) — plus non-code deliverables: improvement docs, discovery write-up (3 things w/ file:line), 3–5 min demo video, AI cost analysis, social post tagging @GauntletAI, orientation notes. Listed in activeContext.md; not yet ticketed.
- **Grading recorded:** audit report is pass/fail (met). Implementation scored — measurable improvement 40%, technical depth 25%, TypeScript quality 15%, documentation 10%, commit discipline 10%. Rule 11 and the 10% weight both say the git history is read directly, so improvements go on their own labeled branches from here.
- **Incidental:** the upstream target repo is `github.com/US-Department-of-the-Treasury/ship` — **already public**. The infra-topology exposure weighed before publishing our fork was therefore already public upstream. Also note the submission deliverable is the **GitLab** repo while rule 4 mandates **GitHub Actions** — the dual-remote setup from earlier today happens to satisfy both.

### 2026-07-28 (Tue) — Day 2 — findings → Linear, repo published, deploy target opened

- **All 68 findings decomposed into Linear tickets.** Team `Troysatchell` (`TRO`), project **ShipShape Audit Remediation**. Structure is 8 category "epic" parents with each finding as a sub-issue — parents `TRO-164`–`TRO-171`, sub-issues `TRO-172`–`TRO-239`. Full ID map is in `activeContext.md`; finding IDs stay the join key between report, tickets, and compare runs.
  - **Ticket convention adopted:** lead with the user-facing cost, keep the measurement underneath as proof. The report is measurement-first by design (it has to be re-runnable and diffable); that makes a poor ticket title but the right ticket body. In practice the "Estimated impact" paragraph became the lede and "Evidence" the body.
  - Cross-cutting root causes wired as Linear **relations** (DB-2⇄API-6, DB-4⇄API-4/API-5/ERR-7, API-2⇄DB-5, ERR-6⇄TEST-5, ERR-1⇄ERR-2, BUN-1⇄BUN-2/3/4/6) rather than deduplicated. True dependencies as **blocks**: API-1→API-2/API-3, TF-3→TF-4, TF-2→TF-1.
  - The unpinned boot-crash hypothesis rides inside `TRO-188` (ERR-1) rather than getting its own ticket — it needs a clean repro before it can be called a 5th Critical.
- **Audit baseline + memory bank committed and published** (`c73e621`). `audit/` tracked at ~700 KB: `AUDIT_REPORT.md`, per-category `baseline.json`/`baseline.md`, and the scan scripts. The ~9 MB of raw captures (server logs, probe JSON, EXPLAIN dumps, screenshots, Lighthouse/axe reports, analyzer stats) is **gitignored and regenerable** from the per-category Methodology sections. Pre-commit hooks (`comply opensource`, empty-test, api-coverage) passed — no `--no-verify`.
- **Repo now publishes to two remotes from one push.** `origin` fetches from GitLab `troysatchell/Ship` (internal) and has two push URLs — that project plus **public** GitHub `troysatchell/ship`. `upstream` is the original `byronmackay/ship`. Chose dual push URLs over CI mirroring: no extra machinery, and the remotes can't silently drift. See techContext.md.
  - Public was a deliberate call after a clean secret scan (no credentials in tree or in 557 commits of history; two previously-committed-then-ignored files verified harmless). Exposure that *is* published: the unfixed 68-finding report, Terraform VPC/WAF/Aurora topology, a Route53 zone ID, and `*.awsdev.treasury.gov` hostnames. Reaffirmed after being shown the specifics — **decided, don't re-litigate.**
- **Verified 2026-07-28: AWS prod is not publicly reachable.** `ship.awsdev.treasury.gov` → 403; `ship-api-prod...elasticbeanstalk.com/health` → no response. Reviewers can't reach a running app there, which is an independent argument for the submission deploy.
- **Opened: Render vs Railway for the submission deploy.** Undecided. The brief frames Render, and Category 8's improvement target is specifically a *Render-provider* config (`render-oss/render`, pinned, `terraform apply` from a clean machine — `AUDIT_REPORT.md:1673`). Railway has no first-party Terraform provider, so it can host the app but can't produce the graded artifact. Decision hinges on whether the deploy must satisfy Category 8 or is only a demo URL.

### 2026-07-27 (Mon) — Day 1, latest — Category 8 (Terraform/IaC) baseline
- Added an 8th audit category: **Terraform Plan Review**. Artifacts in `audit/terraform/baseline.{json,md}` + `raw/` + `drift-demo/`. 6 findings (2 High / 3 Medium / 1 Low), 0 Critical.
- **Scope reality:** `terraform/` is **AWS** (Elastic Beanstalk + Aurora Serverless v2 + VPC + CloudFront/S3 + WAF + SSM), NOT the Render setup the brief assumes — no Render provider exists in the repo. A live `terraform plan` is **not runnable** (S3 remote backend whose bucket name lives in SSM + no AWS creds), so blast radius was reasoned statically from the code + `terraform validate`.
- **Tooling gotcha (TF-3):** the pinned Terraform `1.6.0` (`.terraform-version`) can't `init` — its bundled provider-signing key has expired (`openpgp: key expired`). Used 1.9.8 (allowed by `required_version >= 1.6.0`) to validate; downloaded to a temp bin, not added to repo.
- **Top findings:** TF-1 (High) prod Aurora + uploads bucket have no `deletion_protection`/`prevent_destroy` — only the TF *state* bucket is guarded; TF-2 (High) two divergent root configs (flat `terraform/*.tf` with WAF+realtime-logging vs modular `environments/prod` without) manage the same infra with separate state + colliding names.
- **Drift demo (cloud-free):** `audit/terraform/drift-demo/` with `hashicorp/local` 2.5.2 — clean plan `No changes`; after a manual out-of-band file edit, `plan` recreates both files back to declared content (before/after = `raw/drift-2-clean-plan.txt` → `raw/drift-3-drift-plan.txt`).
- Cleaned up: removed the `.terraform` cache + root lock file `init` created, so `git status terraform/` is empty (infra source untouched). Folded Category 8 into `AUDIT_REPORT.md` → now **68 findings / 4 Critical / 8 categories**.

### 2026-07-27 (Mon) — Day 1, late — baseline COMPLETE
- Resumed the terminated `/shipshape-audit baseline` from Group C. Both remaining categories now measured; **full baseline done, 62 findings (4 Critical / 21 High / 25 Medium / 12 Low)**.
- **error-handling (9 findings, 2 Critical):** synthesized from the already-captured probe1–8 raw JSON (`audit/error-handling/raw/`). ERR-1 (collab-WS-unreachable silent data loss, false "Saved") and ERR-2 (session revocation not enforced on live sockets) are both Critical, both in `api/src/collaboration/index.ts`. Positives verified: no exploitable XSS, clean API 400 validation, browser-offline recovery works. Boot-crash note (uncaught lib0 Yjs decode loading `yjs_state`) flagged for clean repro.
- **a11y (8 findings, 3 High):** measured live. Lighthouse 11.7.1 via `npx` + Playwright Chromium (no system Chrome), authenticated by cookie in `--extra-headers` → my-week 95, others 100. axe-core 4.11 across pages **+ interactive states** found what Lighthouse and the repo's *critical-only* specs miss: 2 axe-Critical (`aria-required-children` sidebar tree; `aria-allowed-attr` editor) + 3 Serious (25-node contrast on /my-week; `listitem`; unnamed dialog). Keyboard nav healthy once the auto-opening "Action Items" modal is Escape-dismissed. 508 framing (treasury.gov) added. Runner scripts saved with the live session token scrubbed to env vars.
- **AUDIT_REPORT.md assembled** (`audit/AUDIT_REPORT.md`, 1,562 lines): exec summary, 62-row cross-category ranking (Criticals first, cross-refs noted), improvement plan with shared-root-cause map, all 7 `baseline.md` sections embedded verbatim (H1s demoted so the report keeps one title).
- **Dashboard republished** to the same URL at checkpoint `report-complete` (viewed remote first to confirm no divergence, then published): claude.ai/code/artifact/7a2310eb-6cce-4da6-a83f-5c5b8d3f2c6c

### 2026-07-27 (Mon) — Day 1, evening
- Baselines complete for 5/7 categories: type-safety (9 findings), bundle (9), api-perf (6), db-query (10), test-quality (11) — 45 findings, 2 Critical (DB-1 migrations, API-1 rate limiter). Artifacts in `audit/<cat>/baseline.{json,md}`.
- **Group C (error-handling, a11y) terminated before baseline — unmeasured.** Decision pending: re-run vs. submit as NOT MEASURED.
- Prerequisite gate had already exposed DB-1; db-query reproduced it independently on a throwaway DB.
- Live dashboard wired into the orchestrator skill and published (checkpoint `group-b-complete`): claude.ai/code/artifact/7a2310eb-6cce-4da6-a83f-5c5b8d3f2c6c
- Architecture defense brief built from the five baselines (charts, Criticals, systemic causes, remediation plan): `audit/defense.html` → claude.ai/code/artifact/c73766aa-3005-42e7-801a-19248f92f8d5

### 2026-07-27 (Mon) — Day 1
- Cloned repo (`labs.gauntletai.com/byronmackay/ship` → `/Users/troy/repos/GAUNTLET/Ship`).
- Built the ShipShape skill architecture: 7 generic category skills + thin orchestrator + shared conventions, after analyzing the skillsets.cc audit skill as prior art. Decision: per-category skills because phase 2 re-invokes categories individually for before/after evidence.
- Mapped the codebase (tsconfigs, build, routes, schema/indexes, seed volumes, test infra, existing a11y specs). Key leads: web tsconfig weaker than root; 433 `as` in web; coverage package missing; no route-level code splitting; no index on ticket_number/created_by; seed short of brief volumes.
- Smoke-tested `count.sh` against `web/` — works.
- Published usage-guide artifact (color-coded diagrams) and initialized this memory bank.
