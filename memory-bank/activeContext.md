# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-31 (evening), post-grading-failure remediation session. `main` at `fb3e179`, both remotes synced (GitLab `origin`, GitHub mirror), zero open PRs, zero worktrees, working tree clean except the 3 pre-existing local-only items noted below.

## Where we are

User reported this week's grading checkpoint **failed**, quoting the grader's feedback verbatim. Investigation (cross-checked against the actual PDF rubric at `/Users/troy/Documents/G.Assignments/GFA_Week_4_ShipShape_Updated.pdf`, not the memory-bank summary) confirmed all three grader complaints were real, not misunderstandings:

1. **CI missing 3 of 7 required checks** (coverage, `pnpm audit`, security scan) — `TRO-244` had been marked Done on 2026-07-29 for a *different* CI bootstrap ticket that reused the same ID; the actual rule-4 gap was never closed. Reopened, fixed for real: coverage (api 43% / web 20% enforced floors), `pnpm audit` baseline-diff (135 pre-existing findings baselined, fails only on new advisories — same identity-diff pattern as the test quarantine), CodeQL security scan (pinned SHA). Verified with live green GitHub Actions runs, not just local gate.sh. PR #76, merged.
2. **API-3 category target unmet** — only `/api/issues` robustly cleared the ≥20% P95 bar; the audit's own compare doc explicitly declined to claim 2/2 endpoints. Filed `TRO-304`, implemented pagination on `GET /api/documents` (bounded 100-doc default, 500 ceiling, `offset` support) — the audit's own long-standing "largest unrealized win" recommendation. Measured P95 improvement: **−76% to −85% at every concurrency** (10/25/50), cleanly clearing the target. PR #77, merged.
3. **Category 6 screenshots/recordings missing** — `docs/IMPROVEMENTS.md` itself already admitted this. Filed `TRO-305`, captured real browser screenshots (10 after-only, 1 before+after where safely reproducible, 1 terminal-capture for a sub-millisecond race) for all 11 error-handling fixes, wired into the doc. PR #78, merged.

All 3 dispatched as parallel factory agents alongside a wave-1 batch of 7 backlog tickets (`TRO-180`/DB-3, `TRO-245`/RULE-3, `TRO-300`/TEST-16, `TRO-237`/TF-4, `TRO-238`/TF-5, `TRO-175`/API-4, `TRO-194`/ERR-7 — `TRO-295` deferred per user choice, since its real fix needs live AWS credentials this environment doesn't have). All 10 tickets merged. Full narrative, the CHANGES.md merge-conflict cascade cost, the CommandPalette.tsx real-code-conflict resolution between TRO-175 and TRO-304, and the CI-run-cancellation-from-contention finding are in `progress.md`'s 2026-07-31 (evening) entry.

Working tree carries 3 pre-existing, deliberately-untouched items (unchanged from prior sessions): `.gitignore`'s local `.gstack/` line, `docs/submission/{DEMO-SCRIPT,SOCIAL-POST}.md` uncommitted edits kept local-only per instruction, and the untracked `high-end-visual-design` skill install.

## Remaining — Troy only (submission)

Personalize `DISCOVERY.md` + `SOCIAL-POST.md`, record the video from `DEMO-SCRIPT.md`, submit. Optional garnish: the PDF's Render drift demo. **Final submission deadline: Sun Aug 2, 11:59 AM.**

## Backlog remainder — re-verify against Linear before resuming, do not trust this list blindly

Roughly 20 real tickets remain (28 before this session, minus the 7 wave-1 completions, plus `TRO-303` filed by review triage). Not a fresh count — confirm live:

- **TF:** TRO-283 (TF-8), TRO-239 (TF-6), TRO-303 (module `prevent_destroy` gap, CodeRabbit-filed)
- **TEST:** TRO-228..233 (TEST-6/7/8/9/10/11)
- **TS:** TRO-210/212/213/214 (TS-5/7/8/9), TRO-297 (TS-10)
- **DB/API:** TRO-186 (DB-9), TRO-280 (API-7)
- **BUN:** TRO-201/205 (BUN-5/9)
- **RULE:** TRO-249 (RULE-8)
- **CodeRabbit-filed:** TRO-291, TRO-293, TRO-295 (TF-7 quota follow-up — needs live AWS credentials to verify/apply the real fix, not just the code-only mitigation; deferred twice now for that reason)

## Open engineering threads

1. **CI runs get cancelled under contention, not just failed for cause.** `concurrency: cancel-in-progress: true` combined with rapid sequential pushes to `main` (this session's merge cascade) produced at least one falsely-alarming `cancelled` result on `TRO-244`'s branch that looked like a real failure until a quieter re-run went fully green. Don't diagnose a `cancelled` CI conclusion as a code defect without checking whether something else was mid-push at the same time.
2. **`session-activity-race` flaked at least 4 more times this session** (PRs #71, #76 including once under `vitest --coverage` specifically — theory: coverage instrumentation overhead widens the race window) even with `TRO-300`'s completion-barrier fix merged. Not yet clear whether TRO-300's fix reduces the rate or the fix doesn't cover every path; worth a dedicated look if it keeps recurring.
3. Cat-6 screenshots done (TRO-305); VoiceOver passes (TRO-215/281 + prior a11y fixes) still owed to a human.
4. `TRO-244` ticket-ID collision confirmed real (reused across two unrelated pieces of work 2 days apart) — worth a Linear hygiene pass so it doesn't recur.

## Session lessons already in lessons.md / ship-factory SKILL.md

CHANGES.md merge-conflict cascade (N-1 re-resolutions for N PRs landing together, worse than the 2026-07-30 estimate — this session saw up to 5 resolution rounds on a single branch); stash-at-A/B-test moment; programWeeksNav flake identity; session-checkpoint discipline + orchestrator-on-Sonnet.

> — GIR: "I'm gonna sing the doom song now."
