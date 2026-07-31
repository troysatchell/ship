# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-31, post-submission factory wave · **74 tickets Done, 84 PRs merged, factory board empty again.** Submission itself is unaffected — this was a user-directed one-wave resumption of the factory after Phase 2, stopped deliberately after wave 1.

## Where we are

`main` at `cfc5aef`, both remotes synced (GitLab `origin` fetch, GitHub `origin` second push — **remember to `git pull https://github.com/... main` before pushing after any GitHub-side merge, GitLab never auto-follows**), zero open PRs, zero worktrees. This session's wave: TRO-234/236/292/294/298/281/301/196 → PRs #61–#68, all merged `--merge` (history preserved). Full narrative and two operational findings (CHANGES.md merge-conflict cascade cost; `session-activity-race` now confirmed flaking in CI itself, not just local) in `progress.md`'s 2026-07-31 entry.

Working tree carries 3 pre-existing, deliberately-untouched items: `.gitignore` has an unrelated local `.gstack/` line (not this project's concern), `docs/submission/{DEMO-SCRIPT,SOCIAL-POST}.md` have uncommitted edits kept **local-only per instruction** (internal, not for the public repo), and an unrelated `high-end-visual-design` skill install sits untracked (`skills-lock.json`, `.claude/skills/high-end-visual-design/`, `.agents/`) — also per instruction, not factory work.

## Remaining — Troy only (submission)

Personalize `DISCOVERY.md` + `SOCIAL-POST.md`, record the video from `DEMO-SCRIPT.md`, submit. Optional garnish: the PDF's Render drift demo (one benign dashboard toggle + plan).

## Backlog remainder — 28 tickets, untouched by design

Stopped here on explicit instruction after wave 1; none of these were started.

- **TF:** TRO-283 (TF-8), TRO-237 (TF-4, now unblocked — TF-3 landed), TRO-238 (TF-5), TRO-239 (TF-6)
- **TEST:** TRO-300 (TEST-16, High — needs the CI-constrained repro, see below), TRO-228..233 (TEST-6/7/8/9/10/11)
- **TS:** TRO-210/212/213/214 (TS-5/7/8/9), TRO-297 (TS-10)
- **DB/API:** TRO-180 (DB-3), TRO-186 (DB-9), TRO-175 (API-4), TRO-280 (API-7)
- **ERR/BUN:** TRO-194 (ERR-7), TRO-201/205 (BUN-5/9)
- **RULE:** TRO-245 (RULE-3, High), TRO-249 (RULE-8)
- **CodeRabbit-filed:** TRO-291, TRO-293, TRO-295 (TF-7 follow-up, High — plausible AWS quota blocker)

## Open engineering threads

1. **TRO-300** (TEST-16, High): `session-activity-race` now confirmed flaking **in CI itself**, 3× this session across unrelated diffs (PRs #62/#63/#66), always cleared by `gh run rerun --failed`. Needs the CI-constrained (2-core) repro to actually root-cause rather than keep rerunning.
2. Cat-6 screenshots/recordings for the write-up; VoiceOver passes (TRO-215/281 + prior a11y fixes) still owed to a human.
3. New load-sensitive-flake identities seen this session, not yet folded into `lessons.md`: `api/src/routes/weeks.test.ts`, `api/src/db/__tests__/migrationLock.test.ts`.

## Session lessons already in lessons.md

Stash-at-A/B-test moment (2 agents); programWeeksNav new web flake identity; zsh no-word-split in orchestrator Bash loops; profile-first killed a plausible perf hypothesis (TRO-302); session-checkpoint discipline + orchestrator-on-Sonnet (both now in `ship-factory`/`ship-orchestrator` SKILL.md, not lessons.md).

> — GIR: "I'm gonna sing the doom song now."
