# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-14 (~14:30Z). **Week 6 (PlugForge) — MVP hard gate CODE-COMPLETE + W6-R10 RESOLVED + the last MVP-adjacent gap (W6-R3/R42) closed. Post-MVP: waves 1-2 done (6/6 tickets merged+verified), wave 3 in flight (3 tickets). Full narrative in `progress.md`'s dated log — this file only tracks what's live right now.**

## Overnight session note

Troy asked to run the factory autonomously overnight with zero check-ins ("I'll come back in the morning"). This session has been working continuously since ~05:00Z. Worktrees + Linear + `gh pr list` + `audit/factory/scorecard.jsonl` are the source of truth, not this file's prose — treat this as a snapshot, re-verify before trusting.

**Recurring agent failure mode, still live:** a dispatched builder arms a background process for `gate.sh`/CI, then ends its turn waiting for a notification that never arrives (subagents don't get woken the way the top-level session does). Hit ~8-10 times across ~13 dispatches so far. Fix every time: `ListAgents` to spot a suspiciously-idle `completed` status, `SendMessage` an explicit "nothing will wake you, wait synchronously" correction. Expected friction at this point, not a surprise — check in proactively rather than waiting indefinitely.

## Right now — wave 3 in flight

Dispatched ~14:24Z, not yet confirmed landed:
- **TRO-438/PF-304** — webhook deliverer + retries + DLQ. Migration 048. The graded deterministic-clock scenario (500×3→200 succeeds attempt 4; 6-failure→DLQ).
- **TRO-422/PF-405** — SDK spec↔SDK parity fitness test + <250KB bundle-size CI gate. Closes Epic E4 (every other E4 ticket is merged).
- **TRO-427/PF-500** — rate-limit token buckets (per-app/per-token) + headers on 100% of `/api/v1` responses, extends PF-203's route-fitness walk. Opens Epic E5.

Check `gh pr list --state open` and Linear status for TRO-438/422/427 before assuming any of these landed or are still blocking.

## Next actions once wave 3 lands

1. **E3 remainder:** PF-305 (delivery log API) and PF-306 (replay) both unblock from PF-304.
2. **E5 remainder:** PF-501 (public audit trail, migration ~049) is independent, can dispatch alongside E3's tail. PF-502/503 (portal UI) come after.
3. **E6 (the actual graded TTFE metric)** — `pnpm drill ttfe` — becomes buildable once SDK (done) + at least one resource (done) + webhooks end-to-end (PF-302 done, PF-304 landing now) are in place. This is the highest-value remaining work: PLUGFORGE.MD's own framing is "the grade is the Time-to-First-Event drill, not endpoint count." Prioritize PF-600 (CLI scaffold + device login) → PF-602 (`ship webhooks tail`, the demo money shot) → PF-603 (the drill itself) once E3's delivery chain is solid.
4. **🔔 Hard boundaries — "no check-ins" does not override these:** PF-700 (E7 agent-rewire checkpoint) and PF-904 (pre-search + demo recording) are HUMAN CHECKPOINTs per PLUGFORGE.MD §0.1 — never self-approved. TRO-415/PF-901 (destroy-and-redeploy against the LIVE graded environment) needs human go-ahead — do not run `terraform destroy` against the real environment.
5. **Re-run `/requirements-audit`** once E3/E4/E5 settle down, to get a current picture before deciding what's left for submission (E8 integrations, E9 docs — PF-908/904 need Troy's input regardless).
6. **12 follow-up tickets filed from wave findings, none triaged against the main backlog:** TRO-587-592 (CodeQL dismissals, minor gaps, refactor opportunities — all Low/Medium) + TRO-593-596 (pre-existing e2e bugs — TRO-593 High, worth real investigation time when there's room).

## Standing procedure — convoy pattern, still needed for every ticket

Main moves fast. Per ticket: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` (NOT `origin main` — GitLab, the fetch remote, lags GitHub until manually synced) → resolve `CHANGES.md`/`scorecard.jsonl` via `node scripts/factory/merge-changes.mjs --ours <(git show HEAD:CHANGES.md) --theirs <(git show origin/main:CHANGES.md) --out CHANGES.md` → `--check` → commit → `pnpm install` → re-`gate.sh` → push. After every GitHub merge, sync GitLab: `git fetch https://github.com/troysatchell/ship.git main:main && git push origin main` from the main worktree.

**Migration numbers in the PRD are all stale** — OAuth work consumed 042-046, webhooks work is now at 047-048+. Always check `ls api/src/db/migrations/ | sort -V | tail -3` fresh before assigning a number; never trust the PRD's stated number.

## Standing facts

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for `worktree.sh`. `GH_REPO=troysatchell/ship` for all `gh` calls.
- **CodeRabbit is capacity-constrained this sprint** (another project consuming it) — try `gh pr comment <n> --body "@coderabbitai review"` once, wait ~90s; if still limited, a disclosed manual self-review substitutes. Occasionally clears and completes a real review (e.g. TRO-431) — check fresh each PR, don't assume it's still limited.
- **GitHub Actions sometimes never triggers a `pull_request` run on push** (webhook miss) — if `gh api "repos/.../actions/runs?branch=<b>"` shows nothing for 30-60s, `gh workflow run ci.yml --ref <branch>` to force it. Poll by the FULL 40-char SHA.
- **`gh pr checks` can be empty/stale for several seconds after a push** — cross-check `gh api repos/troysatchell/ship/commits/<full-sha>/check-runs` directly if `gh pr checks` looks wrong.
- **Only 3 checks are actually required for merge** (`typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)` — confirmed via `gh api repos/troysatchell/ship/branches/main/protection`). A separate, non-required `CodeQL` (GitHub default Advanced Security) check often flags things unrelated to required merge — check if it's pre-existing/out-of-scope before spending time on it; `mergeStateStatus: UNSTABLE` (not `BLOCKED`) means it's safe to merge once the 3 required checks are green even if a non-required check is still pending.
- **Lock the Linear ticket to In Progress BEFORE dispatching the Agent call, not after.**
- Load-flake test identities keep recurring under concurrent `gate.sh` load (rule-24 class in `lessons.md`) — always re-run standalone before believing a failure; never widen the quarantine.

## Open questions / carry-over (low priority, not urgent)

- W6 deadline: **AM 2026-08-16** (brief's own AM/PM contradiction, planning for the earlier one).
- Carry-over from before this session, still untouched: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s; TRO-549/550/552 (Low/Medium CodeRabbit follow-ups, explicitly Backlog).
- TRO-503 (CloudFront `/oauth/*` routing gap, High) — `/oauth/authorize` unreachable through CloudFront on the AWS deploy path (Ship deploys to Render, not AWS, for this sprint — check whether this is still live-relevant before investing time).
