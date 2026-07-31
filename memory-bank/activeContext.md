# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-31 (night), wave 2 of the resumed factory complete. `main` at `d41e3a1`, both remotes synced (GitLab `origin`, GitHub mirror), zero open PRs, zero worktrees.

## Where we are

After the grading-failure remediation session (TRO-244/304/305 + a 7-ticket wave-1 batch, see prior entries), the user asked to resume the factory on the remaining backlog. Pulled fresh from Linear (not the stale memory-bank list) and ran a second wave of 8 tickets in parallel: `TRO-303` (module `prevent_destroy`, batched with a still-open Aurora gap), `TRO-297` (TS-10 floating-promise burn-down, scoped to `api/` only — 389 web sites explicitly deferred), `TRO-296` (ERR-15 Yjs mark round-trip), `TRO-283` (TF-8 CloudFront compression, escalation-gated to code+validate only), `TRO-280` (API-7 Redis-backed rate limiting), `TRO-186` (DB-9 duplicate requests), `TRO-249` (RULE-8 CHANGES.md audit), `TRO-201` (BUN-5 icon glob). `TRO-295` (TF-7 quota follow-up) deferred again, same reason as before (needs live AWS credentials).

**Two findings escalated in severity during investigation, not assumed from their filing:**
- **TRO-296 (ERR-15)** was filed as "possibly latent" — investigation traced the actual `y-prosemirror`→Yjs write path and confirmed it's **live and continuously occurring**: any user applying a bold/italic/link mark in the real editor corrupted `documents.content`'s JSON backup within ~2 seconds (the debounced persist interval). Bumped Medium→High in Linear with the correction documented. Same lesson as A11Y-1: a derived reachability claim, corrected once actually traced.
- **TRO-297 (TS-10)**'s api-package fix, while extracting `server.on('upgrade', ...)`/`wss.on('connection', ...)` into named async functions to satisfy `no-misused-promises`, surfaced and fixed a real, previously-undiscovered crash: a malformed `Host` header threw synchronously in `handleUpgrade`, an unhandled rejection that took down the whole collaboration server for every connected user — same failure class as ERR-10, one layer up. Verified the refactor preserves exact synchronous-execution-before-first-await timing (the property that matters for this hazard file) before trusting it.

All 8 merged. One follow-up ticket filed from TRO-297's own recommendation: `TRO-306` (web's `src/pages/*` promise-safety burn-down, batch 1 of what will be several — ~389 sites is too large for one PR).

**8 PRs (#79–#86), all merged `--merge`, no `--squash`.** Full narrative — the CommandPalette.tsx-style batch conflicts (none this wave, all were CHANGES.md-only), the recurring gate.sh load-flake identities, and the terraform-apply discipline (never run, on any of the 3 terraform tickets this wave) — is in `progress.md`'s 2026-07-31 (night) entry.

Working tree carries 3 pre-existing, deliberately-untouched items (unchanged for weeks now): `.gitignore`'s local `.gstack/` line, `docs/submission/{DEMO-SCRIPT,SOCIAL-POST}.md` uncommitted edits kept local-only per instruction, and the untracked `high-end-visual-design` skill install.

## Remaining — Troy only (submission)

Personalize `DISCOVERY.md` + `SOCIAL-POST.md`, record the video from `DEMO-SCRIPT.md`, submit. Optional garnish: the PDF's Render drift demo. **Final submission deadline: Sun Aug 2, 11:59 AM.**

## Backlog remainder — re-verify against Linear before resuming, do not trust this list blindly

Roughly 15 real tickets remain (23 before wave 2, minus 8 completions, plus `TRO-306` filed this wave). Not a fresh count — confirm live:

- **TF:** TRO-239 (TF-6)
- **TEST:** TRO-228..233 (TEST-6/7/8/9/10/11)
- **TS:** TRO-210/212/213/214 (TS-5/7/8/9), TRO-306 (TS-10 web batch 1, filed this wave — plus an unfiled sibling batch for `components/**`+`lib/**`)
- **BUN:** TRO-205 (BUN-9)
- **CodeRabbit-filed:** TRO-291, TRO-293, TRO-295 (TF-7 quota follow-up — needs live AWS credentials, deferred three times now for that reason; consider whether the code-only security-group-split mitigation should just be shipped without the live-quota-check half, next time this comes up)

## Open engineering threads

1. **`session-activity-race` is still flaking in CI** despite `TRO-300`'s completion-barrier fix (merged wave 1) — recurred again this wave on `TRO-244`'s branch pre-merge. The barrier fix may not close every path, or this is a second, distinct load-sensitive mechanism. Worth a dedicated look if it keeps recurring rather than continuing to rerun through it.
2. Cat-6 screenshots done (TRO-305, wave 1); VoiceOver passes (TRO-215/281 + prior a11y fixes) still owed to a human.
3. `TRO-280`'s Redis-backed rate limiter is code+terraform complete but **never applied** — `terraform/redis.tf` exists, validated, not provisioned. Wiring it into the actually-live Render deployment is explicitly out of scope, noted as a follow-up in the ticket itself.
4. Two agents this wave independently caught themselves mid-violation of standing rules (a `git stash` slip on TRO-186, an ID-collision self-report on TRO-244 from wave 1) and self-corrected before it caused damage — the rules are landing, worth noting rather than filing as incidents.

## Session lessons already in lessons.md / ship-factory SKILL.md

CHANGES.md merge-conflict cascade; stash-at-A/B-test moment; programWeeksNav flake identity; session-checkpoint discipline + orchestrator-on-Sonnet; verify-reachability-before-trusting-a-severity-filing (TRO-296/TRO-297 this wave, same family as A11Y-1).

> — GIR: "I'm gonna sing the doom song now."
