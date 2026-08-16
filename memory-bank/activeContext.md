# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-16 (~07:20Z), by a second concurrent session (this one) layering its own wave on top of the ~07:10Z update below. **Week 6 (PlugForge) — deadline AM 2026-08-16, inside the deadline window. Troy has explicitly signed off for the night — all sessions run fully unattended, announce-before-claim to peers only, no check-ins expected.** Full detail in `progress.md`'s 2026-08-16 log entries — this file is the pointer, not the record. Many sessions active concurrently (fleet reported ~20 worktrees at one point) — always re-check Linear/PR state live before trusting anything below as current.

## ⚠️ GitHub API rate limit hit fleet-wide 2026-08-16 ~07:17Z

`gh api rate_limit` showed `0/5000` (shared account, all sessions draw from one pool). Reset ~07:37Z. Symptom to recognize: `gh run watch`/`gh pr checks`/`gh api` calls start returning early, empty, or stale-looking instead of erroring loudly — **check `gh api rate_limit` first** if `gh` output looks inconsistent with reality, rather than assuming a real CI state change. Plain `git fetch`/`push` to github.com is unaffected. If this recurs, all sessions should throttle `gh` polling (fewer, spaced-out checks; prefer `git push` + one check over a watch loop) rather than each independently hammering it.

## Current focus

1. **This session's wave (2026-08-16 ~05:20–07:20Z): TRO-587 done, TRO-488/TRO-589/TRO-612/TRO-614 built.** TRO-612 merged clean (PR #271, `9eee8aa0`). TRO-587 (CodeQL false-positive on `credentials.ts:35`) dismissed directly via `gh api` — no code change, alert #372 dismissed with a written reason, Linear Done. TRO-488 (terraform input hardening) and TRO-589 (device `user_code` hash) both gate-pass, PR #273/#272 open, mergeable, green on their last full CI pass — **blocked only on the rate-limit window above**, resume merging once it clears. **TRO-614 is this session's fix** (not just "in flight from another session" as the prior note said) — root-caused the `OrgChartPage.test.tsx` race precisely (second `useEffect` auto-expanding the tree after first render; test's synchronous `getByRole` for a nested row could beat it) via 2 independent CI failures on unrelated diffs (TRO-589, TRO-488), fixed with `await findByRole` for the deepest node, PR #278, gate `pass-with-disclosed-exception` (hardens an existing test, no new case). Broadcast to the fleet so others stop re-running around it.
2. **TRO-609 (e2e serial-mode cascade) — DONE, merged 2026-08-16 ~07:10Z** (prior session/wave). PR #266, merge commit `47bf0801`. Took 6 merge-forward convoy rounds. **TRO-613 is the queued next pickup**, flagged by 2 peers as ship-6e's natural pickup (same spec file as TRO-609) — this session deliberately did not claim it.
3. **TRO-550, TRO-492, TRO-434 all DONE** (PRs #265/#267/#270 — merged, Linear Done). TRO-492 required dismissing a genuine new CodeQL alert (`js/insufficient-password-hash` #375) as the same false-positive class as TRO-587.
4. **Developer portal is DONE.** TRO-436/TRO-439/TRO-443, Epic E5 fully closed.
5. **TRO-600 also done** (PR #262).
6. **Next actionable pickups (besides TRO-613): fresh Backlog sweep needed.** As of this session's last check, confirmed-clear remaining tickets: TRO-612/598/592/591/590/589/587/552/549/501/500/496/491/490/488/453/454 minus whichever this session and others have since claimed (TRO-612/587/488/589 — see above). TRO-493/588/440/609 were claimed by peers this session confirmed directly. TRO-444/TRO-429 need Troy (see below). **Re-fetch Backlog live** — don't trust any list's claimed/unclaimed status without checking Linear.

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
- **Main is moving so fast tonight (~5+ concurrent sessions) that a PR can go from `MERGEABLE` back to `CONFLICTING` between opening it and finishing one CI run.** Budget for repeated merge-forward rounds right up to the merge itself, not just once after gate.sh.

## Resume prompt for a fresh session

**"Run the factory"** — read this file and `progress.md`'s latest log entry, confirm current Linear/PR state hasn't moved since (especially PR #272/#273/#278's merge status — all three were gate-green and only blocked on the GitHub rate-limit window as of ~07:20Z), then pick up TRO-434 or the next eligible Backlog ticket per `/ship-factory`'s ordering rules.
