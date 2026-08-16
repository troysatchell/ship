# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-16 (~07:10Z), after TRO-609 merged. **Week 6 (PlugForge) — deadline AM 2026-08-16, inside the deadline window. Troy has explicitly signed off for the night — all sessions run fully unattended, announce-before-claim to peers only, no check-ins expected.** Full detail in `progress.md`'s 2026-08-16 log entries — this file is the pointer, not the record. Many sessions active concurrently (fleet reported ~20 worktrees at one point) — always re-check Linear/PR state live before trusting anything below as current.

## Current focus

1. **TRO-609 (e2e serial-mode cascade) — DONE, merged 2026-08-16 ~07:10Z.** PR #266, merge commit `47bf0801`, GitHub/GitLab SHA-verified identical, Linear Done. Took 6 merge-forward convoy rounds (main moved roughly every 8-10 min from concurrent landings — TRO-600/550/492/434/612/440 all merged underneath it), each resolved via `scripts/factory/merge-changes.mjs` + a fresh `gate.sh` pass before pushing. Root cause + fix detail in `progress.md`'s TRO-609 entry.
2. **This session is handing off here** — TRO-609 was a natural, sizeable piece of work (investigation + 6-round convoy) and this is a clean boundary per `.claude/CLAUDE.md`'s session-hygiene rule. **TRO-613 is the queued next pickup** (unrelated progress-graph text assertion failure, same spec file as TRO-609 — this session has full context but did not start it) — a fresh session can pick it up directly, or this session's continuation can if resumed promptly. Check its Linear status live before assuming it's still unclaimed.
3. **TRO-550, TRO-492, TRO-434 all DONE** (PRs #265/`fd3db28`, #267/`64901ff`, #270/`c415992` — merged, GitHub/GitLab SHA-verified, Linear Done). TRO-492 required dismissing a genuine new CodeQL alert (`js/insufficient-password-hash` #375 on its own regression test) as the same false-positive class as TRO-587.
4. **Developer portal is DONE.** TRO-436/PF-502 (PR #259) and TRO-439/PF-503 (PR #260) merged and reconciled onto one shell. TRO-443's kill-criterion checkpoint closed Done. Epic E5 fully closed.
5. **TRO-600 also done** (`FileTokenStore` atomicity, PR #262).
6. **Next actionable pickups (besides TRO-613): fresh Backlog sweep needed.** As of the last check this session, remaining real (non-epic, non-checkpoint) tickets included TRO-552, TRO-598/592/591/590/501/500/496/491/490/453/454 (mostly Low), TRO-588 (Medium, `/oauth/*` rate limiting — touches the same `rate-limit.ts` as TRO-552, don't run both in true parallel), TRO-493 (Medium, oauth-apps error shape), TRO-444/TRO-429 (High, need Troy — see below). Many sessions concurrently claiming from this list — **re-fetch Backlog live**, don't trust this list's claimed/unclaimed status. Also watch for TRO-614 (OrgChartPage e2e timing-race fix, PR #278, in flight from another session as of ~06:15Z) landing on main.

## Autonomous-loop policy (confirmed, not just relayed — verify still holds before relying on it)

`audit/factory/config.yaml`'s `meta.activeProject` = "PlugForge — Week 6 Platform & Public API"; `references/escalation.md` explicitly says don't stop between tickets to ask permission. Once a ticket lands, pull the next eligible Backlog ticket per the loop's ordering rules (skip 🔔/⚠️/epic-parents) rather than waiting to be handed one. Announce to other sessions before claiming a ticket/batch (Linear status is the hard lock, but Troy wants visible coordination too, per a relayed instruction — cross-check anything peers claim came from Troy directly rather than trusting the relay). `/ship-orchestrator` §1a governs safe parallelism.

## Still needs Troy directly — not further actionable by any session

- **TRO-429** (pre-search answers + saved AI-conversation artifact)
- **TRO-444** (demo video/social post — also blocked on `ship webhooks tail`/TRO-452, which is already merged, so this is now unblocked and ready whenever Troy wants to record it)
- TRO-437 (per-epic write-ups) is already done as of this session, so it's off this list.

## Standing facts (still true)

- `GH_REPO=troysatchell/ship` for all `gh` calls. Factory Postgres is `ship-postgres-1` (`:5433`) — always pass `FACTORY_PG_CONTAINER=ship-postgres-1` explicitly to `worktree.sh`.
- Convoy pattern: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` → resolve `CHANGES.md`/`scorecard.jsonl` conflicts via `scripts/factory/merge-changes.mjs` (append-only, union both sides) → gate → push both remotes → verify `git ls-remote` SHAs match before calling a merge landed. **Main is moving fast this session (4 sessions active) — expect 2-4 merge-forward rounds per PR, not one.**
- To sync GitLab without disturbing the shared `Ship` worktree's checked-out `main` (which may have uncommitted concurrent-session edits): `git fetch https://github.com/troysatchell/ship.git main:refs/remotes/github-verify/main && git push origin refs/remotes/github-verify/main:main` — never fetch straight into a checked-out branch with dirty state.
- CodeRabbit is capacity-constrained team-wide and rate-limits unpredictably — check GitHub's own CodeRabbit check-run, not just local `gate.sh`.
- Only 3 checks are required for merge: `typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)`. CI genuinely takes 9-13 min.
- The TRO-277/TEST-12 load-sensitive flake class now confirmed to hit both API and web suites, and both local `gate.sh` and GitHub's coverage-mode CI run — `gh run rerun <id> --failed` is the fast recovery once a standalone rerun confirms it's not a real regression.
- Live redeploy is not implied by a merged PR — verify the deployed service after any merge meant to reach production.
- Multiple sessions share this machine's `Ship` main worktree and its `memory-bank/` files — check `git status`/re-read before overwriting.

## Resume prompt for a fresh session

**"Run the factory"** — read this file and `progress.md`'s latest log entry, confirm current Linear/PR state hasn't moved since, then pick up TRO-434 or the next eligible Backlog ticket per `/ship-factory`'s ordering rules.
