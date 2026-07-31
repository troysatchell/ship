# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-31 (later same day), TRO-244 (RULE-4) closed · CI pipeline now runs all 7 assignment-rule-4 checks. PR #76 open on GitHub (`troysatchell/ship`), mergeable, multiple full-green live CI runs. Factory very active in parallel — dozens of other tickets' PRs merging into `main` concurrently during this session.

## Where we are

Worked in dedicated worktree `Ship-wt-tro_244` / branch `fix/ci-missing-checks`. `verify` job had only 4 of 7 required checks (build, lint, type-check, test); added coverage (api+web, `@vitest/coverage-v8`, generous floors 43%/20%), a `pnpm audit` baseline-diff (`audit/factory/dependency-audit-baseline.json` + `scripts/factory/lib/dependency-audit-diff.mjs`, same identity-diff pattern as the test quarantine — 135 pre-existing findings, 0 new), and a new `codeql` job (github/codeql-action init+analyze, pinned SHA). Full detail, the two real bugs the live CI run caught, and the ticket-ID collision finding are in `progress.md`'s 2026-07-31 (PM) entry.

Working tree carries 3 pre-existing, deliberately-untouched items: `.gitignore` has an unrelated local `.gstack/` line (not this project's concern), `docs/submission/{DEMO-SCRIPT,SOCIAL-POST}.md` have uncommitted edits kept **local-only per instruction** (internal, not for the public repo), and an unrelated `high-end-visual-design` skill install sits untracked (`skills-lock.json`, `.claude/skills/high-end-visual-design/`, `.agents/`) — also per instruction, not factory work.

## Remaining — Troy only (submission)

Personalize `DISCOVERY.md` + `SOCIAL-POST.md`, record the video from `DEMO-SCRIPT.md`, submit. Optional garnish: the PDF's Render drift demo (one benign dashboard toggle + plan).

## Backlog remainder — stale, needs a refresh pass

The 28-ticket list below is what stood after wave 1 (previous entry). **Not re-verified this
session, and at least two are already done**: `TRO-245` (RULE-3) and `TRO-238` (TF-5) both showed
up as fully-written, merged `CHANGES.md` entries on `main` while resolving this session's own
merge conflicts (they were not this ticket's work) — the factory kept running other tickets in
parallel throughout. Treat this whole list as "needs re-check against Linear," not "confirmed
remaining":

- **TF:** TRO-283 (TF-8), TRO-237 (TF-4, now unblocked — TF-3 landed), ~~TRO-238 (TF-5)~~ **done**, TRO-239 (TF-6)
- **TEST:** TRO-300 (TEST-16, High — needs the CI-constrained repro, see below), TRO-228..233 (TEST-6/7/8/9/10/11)
- **TS:** TRO-210/212/213/214 (TS-5/7/8/9), TRO-297 (TS-10)
- **DB/API:** TRO-180 (DB-3), TRO-186 (DB-9), TRO-175 (API-4), TRO-280 (API-7)
- **ERR/BUN:** TRO-194 (ERR-7), TRO-201/205 (BUN-5/9)
- **RULE:** ~~TRO-245 (RULE-3, High)~~ **done**, TRO-244 (RULE-4) **done this session**, TRO-249 (RULE-8)
- **CodeRabbit-filed:** TRO-291, TRO-293, TRO-295 (TF-7 follow-up, High — plausible AWS quota blocker)

## Open engineering threads

1. **TRO-300** (TEST-16, High): `session-activity-race` flaked again this session — now also seen
   **under `vitest run --coverage`** specifically (see `progress.md` for the theory). Still needs the
   CI-constrained (2-core) repro to root-cause rather than keep rerunning.
2. Ticket-ID collision confirmed real (`TRO-244` reused across two unrelated pieces of work, 6 weeks
   apart) and an unattended process auto-merges `main` into open ticket branches — both explained in
   `progress.md`'s 2026-07-31 (PM) entry; flag the former in Linear so it doesn't recur.
3. Cat-6 screenshots/recordings for the write-up; VoiceOver passes (TRO-215/281 + prior a11y fixes) still owed to a human.
4. New load-sensitive-flake identities seen this session, not yet folded into `lessons.md`: `api/src/routes/weeks.test.ts`, `api/src/db/__tests__/migrationLock.test.ts`.

## Session lessons already in lessons.md

Stash-at-A/B-test moment (2 agents); programWeeksNav new web flake identity; zsh no-word-split in orchestrator Bash loops; profile-first killed a plausible perf hypothesis (TRO-302); session-checkpoint discipline + orchestrator-on-Sonnet (both now in `ship-factory`/`ship-orchestrator` SKILL.md, not lessons.md).

> — GIR: "I'm gonna sing the doom song now."
