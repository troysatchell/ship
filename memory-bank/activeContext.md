# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-15 (~15:20Z, by ship-35, rolling over after a long session — see progress.md's dated log for full detail on everything below). **Week 6 (PlugForge) — factory running as multiple parallel Claude sessions coordinated over cross-session messages. E6 (the graded TTFE metric, PF-600/601/602/603) actively In Progress across lanes — this is the top remaining priority. E7's PF-703 in progress. E8's 5 committed reference integrations all Done.**

## Where things stand (Linear, project-scoped, checked fresh this update — not carried over stale)

**In Progress right now:** TRO-448/PF-600 (CLI scaffold), TRO-450/PF-601 (`ship docs`), TRO-452/PF-602 (`ship webhooks tail` — the demo money shot), TRO-455/PF-603 (**the TTFE drill itself — the actual graded metric**), TRO-435/PF-703 (gated writes via SDK). **In Review:** TRO-603 (a real found bug — webhook replay route was never wired to the app's shared deliverer, retry siblings orphaned).

**This lane (ship-35) closed 5 tickets across this session, all independently verified (PR mergedAt + both-remote SHA match, never self-report):** TRO-417/PF-700 (E7 checkpoint, human-acked), TRO-503 (CloudFront `/oauth/*`, plan-only), TRO-449/PF-802 (browser SDK demo — found+fixed a real `@ship/sdk` packaging bug), TRO-451/PF-803 (Slack integration, E8's 5th/last committed integration), **TRO-602** (shared cursor-pagination precision bug, PR #240, merge `97a4d67` — this session's final piece of work, two genuine CodeRabbit rounds both fixed). **No further ticket assigned — this lane is now idle pending the next dispatch or a fresh session picking up.**

**Peer lanes as of this update (`ListAgents`):** `ship-6e` busy, `ship-e8` shell/idle, `ship-ef` idle, `ship-ce` idle. `ship-6e` independently hit the same GHCR build break this lane found (see below) and filed the ticket for it.

**New ticket filed this update, still unclaimed: TRO-604** — the non-required `build · push image (GHCR)` CI job is broken on `main` (TRO-447/PF-801's `webhooks.test.ts` imports `docs/submission/demo-webhook-listener.mjs` via a path outside the Docker build context). Not blocking any PR (non-required check, `mergeStateStatus: UNSTABLE` is the documented-safe merge state), but the actual container image GHCR pushes is broken right now — a real deployability gap worth someone picking up.

## Next actions, in priority order

1. **E6 — the actual graded metric, top priority, actively in flight.** PF-600/601/602/603 all In Progress across lanes as of this update. PF-603 (`pnpm drill ttfe`, wired into both CIs, <60s / 0% flake over 20 runs) is the last and most important piece — check its status fresh, don't assume from this snapshot.
2. **TRO-604** (GHCR build break, filed this update) — unclaimed. Cheap fix once picked up: don't import the demo script directly from a test file; inline the fixture or relocate the script within the Docker build context.
3. **TRO-603** (In Review) — check CI/CodeRabbit status fresh and merge if clean; this is a real bug (orphaned retry siblings on webhook replay), not cosmetic.
4. **E7 continuation** — PF-703 (gated writes) in progress; PF-704 (flag matrix + audit proof) follows.
5. **E8** — done except PF-804 (GitHub App, explicitly STRETCH, optional given the deadline).
6. **🔔 Hard boundaries — never self-approved regardless of instructions to work autonomously:** PF-904 (pre-search + demo recording) is a HUMAN CHECKPOINT per PLUGFORGE.MD §0.1. TRO-415/PF-901 (destroy-and-redeploy against the LIVE graded environment) needs explicit human go-ahead.
7. **Re-run `/requirements-audit`** once E6 has real movement, before scoping E9 (submission docs — mostly needs Troy's own input).

## Standing procedure — convoy pattern, still needed for every ticket

Main moves fast during an active wave — this session hit it 3 separate times in one PR's review cycle. Per ticket: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` (NOT `origin main` — GitLab, the fetch remote, lags GitHub until manually synced) → resolve conflicts: `CHANGES.md` via `node scripts/factory/merge-changes.mjs --ours <(git show :2:CHANGES.md) --theirs <(git show :3:CHANGES.md) --out CHANGES.md` then `--check`, `scorecard.jsonl` via manual append-both (it's append-only, so conflicts are almost always "keep both sides") → commit → re-`gate.sh` (if `sdk/` or a new workspace dependency changed, run `pnpm install` and `pnpm build:sdk` first — a stale `node_modules` symlink or unbuilt `sdk/dist` can cause a spurious `tsc` "cannot find module '@ship/sdk'" that clears on its own re-run once `sdk/dist` finishes writing) → push. After every GitHub merge, sync GitLab from the **shared main dir** (not a worktree): `git pull https://github.com/troysatchell/ship.git main --ff-only && git push origin main`, verify both `git ls-remote` SHAs match.

**Migration numbers in the PRD are stale** — check fresh before assigning a number.

## Standing facts (for the next dispatch wave)

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for `worktree.sh`. `GH_REPO=troysatchell/ship` for all `gh` calls.
- **CodeRabbit is capacity-constrained this sprint, team-wide** — the hosted check's own `pass`/`fail` label is NOT trustworthy on its own: a rate-limited skip also reports `pass`. Always cross-check: `gh pr checks <n>` shows a `"Review rate limited"` vs `"Review completed"` detail string, and `gh api repos/.../pulls/<n>/comments --jq length` — 0 comments + "rate limited" means no real review happened. When genuinely rate-limited (both hosted `@coderabbitai review` and local `coderabbit review --base main` CLI — they share one team-wide allowance), do a disclosed manual self-review of the diff rather than merging blind. When it does complete, it can find real, non-obvious findings worth fixing (TRO-602 round 2's calendar-validation gap was genuinely subtle) — don't rubber-stamp a "pass" without reading what actually posted.
- **Only 3 checks are required for merge**: `typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)` (confirmed via `gh api repos/troysatchell/ship/branches/main/protection/required_status_checks`). A separate non-required `CodeQL` (GitHub default Advanced Security) and `build · push image (GHCR)` (currently broken, see TRO-604) can both fail without blocking. `mergeStateStatus: UNSTABLE` (not `BLOCKED`) is safe to merge once the 3 required checks are green.
- **A CI run can genuinely take 9-12 minutes for `typecheck · build · unit tests`** under this sprint's concurrent-lane load — don't assume a stall before checking the job's own `startedAt` via `gh run view --job <id> --json status,startedAt`.
- **Load-flake test identities keep recurring under concurrent `gate.sh`/CI load** (rule-24 class in `lessons.md` — hit `weeks.test.ts`, `token.test.ts`, `issues.test.ts`, `webhooks.test.ts`, `server.test.ts` this session alone) — always re-run standalone (and check `uptime`) before believing a failure; never widen the quarantine. `gate.sh` itself already does this standalone re-check automatically and reports it in its output — read `.factory/*-standalone.txt`, don't just re-derive it by hand.
- Lock the Linear ticket to In Progress BEFORE dispatching.
- **Shared main-worktree collision risk still stands:** confine all git mutations to your own ticket worktree; only `fetch`/`status`/`log`/`ls-remote` are safe in the shared main dir.

## Open questions / carry-over (low priority)

- W6 deadline: **AM 2026-08-16** (brief's own AM/PM contradiction, planning for the earlier one) — getting close; E6 is the metric that matters most between now and then.
- Carry-over, still untouched: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s; TRO-549/550/552 (Low/Medium, explicitly Backlog).
- TRO-593 (High) — `session-timeout.spec.ts` browser-context crash, not yet root-caused, unrelated to any W6 ticket.

---

**🔁 Session rollover: start a fresh session now.** This session ran long (5 tickets: TRO-417, TRO-503, TRO-449, TRO-451, TRO-602) and has been resending a very large transcript on every tool call. Resume prompt: **"run the factory"** — the board rebuilds cleanly from Linear, `git worktree list`, `gh pr list`, and `audit/factory/scorecard.jsonl`, not from anything held only in this session's memory.
