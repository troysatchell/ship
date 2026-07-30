# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-30, day 4 night · **Phase 2 nearly banked: 25 tickets Done today, 13 PRs merged, db-query compare measurement now done, api-perf compare done.** Phase 2 due **Fri Jul 31**.

## Where we are

`main` at `15e6cb0`+a11y-artifacts merge, all remotes synced. Today's merges: #40 #42 #43 #45 #46 #48 #49 #50 #51 #52 #53 #54 #55 #56 #58 #59. Audit-68 Done ≈ **40** (27 + TS-1/2/3/4, DB-6/7/8/10, A11Y-4/5/6/7/8, TS-6, ERR-6, TEST-5, BUN-7/8 — recount against Linear before quoting precisely).

## Category-target status (the graded 40%)

- **Cat 2 bundle** ✅ banked (−80.5% /login, earlier run).
- **Cat 5 tests** ✅ banked (far past 3-tests/3-flakes).
- **Cat 6 errors** ✅ banked (ERR-1 data-loss headline + 10 more; screenshot/recording pass still owed for the write-up).
- **Cat 7 a11y** ✅ **banked today** — compare-phase2-jul30: all 8 baseline findings resolved; C/S = 0 on my-week, document view, issues (all states). Known new Serious on /weeks+/search = TRO-298 (not key pages). Lighthouse my-week 95→100.
- **Cat 4 db** ✅ **formal compare done today** (`audit/db-query/compare-phase2-jul30/`, branch `measure/db-query-compare-jul30` @ `a9c482f`, off `main` 34a0aeb, pushed, no PR). Target cleared two ways: List issues 17→13 steady (−23.5%, one of the 5 required flows), and the slowest-query route (baseline's #1 slowest statement, the session UPDATE, 4.764ms max → 0.614ms, −87.1%, matching DB-2's throttle). **Correction to the "dashboard 30→6" figure in this file's prior entry: not reproduced.** "Load main page" (hits `/my-week`, confirmed unchanged since baseline) and "dashboard" (`/dashboard`, DB-4's actual target) are two different flows in this harness — DB-4's real evidence is the non-required "Load week dashboard" flow, 42→13 steady (−69.0%, N+1 YES→NO), not "main page." DB-6/7/8 all confirmed via EXPLAIN ANALYZE (weeks-aggregate buffers −36.5%, ticket-lookup Seq→Index Scan, association-batch estimate error 28x-under→1.1x-under). DB-5 confirmed via row width (−67.3%) not ms. Full detail + what-got-worse section in the artifact `.md`.
- **Cat 3 api-perf** ✅ **compare done, merged to main** (34a0aeb, "Merge api-perf compare artifacts (phase2-jul30)"): `/api/issues` clears −20% P95 robustly at every concurrency (−30.7% at c=25, the headline); a second endpoint (`documents/:id`) clears it only at c=50, so whether "≥2 endpoints" is met depends on the reading — both stated plainly in the artifact, neither spun. Rate-limiter hashing regression flagged separately.
- **Cat 1 type-safety** ✅ by per-ticket deltas: ~130 (TS-1) + ~45 (TS-2) + 19 (TS-3) + 233 (TS-4 corrected count 286→53) ≈ **427 ≥ 384 target**. **Critical nuance (TS-4 discovery): the tracked count.sh metric has a BSD-grep bracket bug that never counted property!-assertions, and live totals grew with the codebase (1747 vs 1535) — present Cat-1 evidence as controlled per-ticket diffs, never a naive live re-count.**
- **Cat 8 terraform** ✅ artifact exists (PR #57, held): pinned Render provider 1.9.1 + live plan + adoption memo; local-provider + drift demo pre-existing.

## Held for the maintainer (batch-answer)

PR #41 (TF-2, deletes environments/prod; dev/shadow kept — premise corrected), PR #47 (TF-7 pair: SG prefix-list + trust proxy 2; TRO-295 quota check first; discovery: req.ip was CloudFront's edge IP for ALL traffic), PR #57 (TF-10: import vs apply), Render image-switch runbook (RULE-5), prod SSM DATABASE_URL read, VoiceOver (TRO-215/281 + today's a11y fixes), PR #30 ordering decision.

## In flight / next

1. **Merge `measure/db-query-compare-jul30` (a9c482f) into `main`** — pushed, no PR opened by design (measurement-only branch, same pattern as the already-merged api-perf compare branch). All 8 category targets are now evidenced; this is the last one to land.
2. **Deferred CodeRabbit triage sweep**: reviews never landed for #48–#59 (service rate-limited all evening); when they appear on merged PRs, triage as follow-ups. GitHub also dropped pull_request events 19:33–19:43 — workflow_dispatch was the workaround.
3. TRO-300 (TEST-16, High): session-activity-race flaked CI 4× today post-TEST-15-fix — needs the CI-constrained repro.
4. Sunday deliverables: improvement docs per category, discovery write-up, demo video, AI cost analysis, social post, Cat-6 screenshots.

## Session lessons already in lessons.md

Stash-at-A/B-test moment (2 agents); programWeeksNav new web flake identity; zsh no-word-split in orchestrator Bash loops.

> — GIR: "I'm gonna sing the doom song now."
