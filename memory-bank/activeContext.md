# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-30, day 4 end-of-night · **PHASE 2 COMPLETE — all 8 category targets MET with evidence in `docs/IMPROVEMENTS.md`. 66 tickets Done, 76 PRs merged, factory board empty.** Early submission tonight.

## Where we are

`main` at `4bd8a97`, all remotes synced, zero open PRs, zero worktrees. Final recounts (direct, not from logs): **65→66 tickets Done in Linear** (46 of the audit-68 + rules/deploy/post-baseline incl. TRO-302), **76 unique PRs merged** into main. Live Render demo runs the current build (deployed `09a6895`+, auto-deploy gap was manual-triggered). Submission docs complete: `docs/IMPROVEMENTS.md` (8/8 categories **met**), `docs/submission/{DISCOVERY,AI-COST-ANALYSIS,SOCIAL-POST,DEMO-SCRIPT}.md`. Cost analysis is final: **measured** 21,413 requests / 91 transcripts ≈ **$2,385–2,714 API-equivalent** (~$37/ticket), out-of-pocket = Max subscription; 64% of spend was cache reads (the factory pattern's signature).

## Category endgames worth remembering

- **Cat 3:** met — issues −30.7%/−39.4% P95; documents/:id −34.8% at c=50. The c=25 "regressions" were **investigated and dissolved (TRO-302/PR #60)**: hash acquitted (650 ns, 3 evidence lines), fresh re-bench of unchanged code showed ±27–35% noise — wider than every regression. Improvements survive because payload bytes/query counts/cross-concurrency consistency can't be noise.
- **Cat 4:** met two ways (issues flow −23.5% queries; slowest statement −87.1%). The "dashboard 30→6" figure is PR #29's own portion-measurement, NOT the harness flow — harness shows week-dashboard 42→13 (−69%), N+1 eliminated. Don't conflate the two in the video.
- **Cat 1:** proven ONLY as controlled per-ticket diffs (≈411–427 ≥ 384); count.sh has a BSD-grep bracket bug and live totals grew with the codebase — never quote a naive re-count.
- **Cat 8:** live Render deployment adopted via `terraform import`, post-import plan = "No changes" (`terraform/render/plan/`). AWS blueprints are hygiene-only per maintainer; no applies planned.

## Remaining — Troy only

Personalize `DISCOVERY.md` + `SOCIAL-POST.md`, record the video from `DEMO-SCRIPT.md`, submit. Optional garnish: the PDF's Render drift demo (one benign dashboard toggle + plan).

## Open engineering threads (post-submission)

1. **Deferred CodeRabbit triage sweep** over merged #48–#60 when its reviews ever land (service was rate-limited all evening; merges made on the documented degraded-service judgment). GitHub also dropped pull_request webhook events 19:33–19:43Z — `workflow_dispatch` was the workaround.
2. **TRO-300** (TEST-16, High): session-activity-race flaked CI 4× post-TEST-15-fix — needs the CI-constrained (2-core) repro.
3. Backlog remainder: TS-5/7/8/9, TEST-6/7/8/9/10/11, A11Y remainder incl. TRO-298 contrast, DB-3/DB-9, API-4/7, ERR-7/9/17, BUN-5/9, TF-3/4/5/6/8, TRO-291..297 post-baseline set.
4. Cat-6 screenshots/recordings for the write-up; VoiceOver passes (TRO-215/281 + this session's a11y fixes) still owed to a human.

## Session lessons already in lessons.md

Stash-at-A/B-test moment (2 agents); programWeeksNav new web flake identity; zsh no-word-split in orchestrator Bash loops; profile-first killed a plausible perf hypothesis (TRO-302) — the noise-control run (re-bench unchanged code) is the cheapest most-decisive benchmark tool we used.

> — GIR: "I'm gonna sing the doom song now."
