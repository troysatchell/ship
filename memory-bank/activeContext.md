# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-15 (~19:12Z, by ship-35). **Week 6 (PlugForge) — factory running as multiple parallel Claude sessions coordinated over cross-session messages. E6 (the graded TTFE metric, PF-600/601/602/603) is the top remaining priority. `main` moved extremely fast this update (7+ merges in under 90 minutes) — expect merge-forward conflicts on any long-lived branch.**

## Where things stand (Linear, project-scoped, checked fresh this update — not carried over stale)

**This lane (ship-35) closed 7 tickets total across this session, all independently verified (PR mergedAt + both-remote SHA match, never self-report):** TRO-417/PF-700, TRO-503, TRO-449/PF-802, TRO-451/PF-803, TRO-602 (see progress.md's dated log for full detail on those), plus this update's pair: **TRO-595** (admin-workspace-members click hang — a test-code deadlock, not an app bug: `page.waitForEvent('dialog')` awaited after `.click()` instead of a handler registered before it, PR #248, merge `3c74e2b`) and **TRO-594** (tooltip hide-on-mouse-away hang — a Playwright teleporting-mouse race against Radix Tooltip's async grace-area listener attachment, PR #249, merge `825f663`). Both root-caused with direct evidence (reproduced the hang, read actionability logs / the installed library's own source — never inferred), both got dedicated new regression tests, both survived 2-3 merge-forwards each from `main` moving fast during review. **No further ticket assigned — this lane is idle pending next dispatch or a fresh session.**

**Peer lanes as of this update (`ListAgents`):** `ship-6e` busy (appears to be working the `.dockerignore`/TRO-604 area — seen mid-edit, uncommitted, in the shared main dir; left untouched per the "don't touch another session's WIP" convention), others idle.

**TRO-604 status:** filed by `ship-6e` earlier this session, appears actively being worked (uncommitted `.dockerignore` change observed in the shared main dir this update) — don't re-dispatch, check Linear status fresh before assuming still open.

## Next actions, in priority order

1. **E6 — the actual graded metric, top priority.** PF-600/601/602/603 — check status fresh, this snapshot is already stale given how fast `main` is moving. PF-603 (`pnpm drill ttfe`, <60s / 0% flake over 20 runs) is the last and most important piece.
2. **TRO-603** (webhook replay route never wired to the shared deliverer, retry siblings orphaned) — check status fresh; was In Review as of the last check this session.
3. **TRO-604** (GHCR/.dockerignore build break) — likely being actively worked by `ship-6e`; verify before re-dispatching.
4. **E7 continuation** — PF-703 (gated writes) merged this update (PR #243); PF-704 (flag matrix + audit proof) follows.
5. **E8** — done except PF-804 (GitHub App, STRETCH, optional given the deadline).
6. **🔔 Hard boundaries — never self-approved regardless of instructions to work autonomously:** PF-904 (pre-search + demo recording) is a HUMAN CHECKPOINT per PLUGFORGE.MD §0.1. TRO-415/PF-901 (destroy-and-redeploy against the LIVE graded environment) needs explicit human go-ahead.
7. **Re-run `/requirements-audit`** once E6 has real movement, before scoping E9 (submission docs — mostly needs Troy's own input).

## New pattern this update — worth carrying forward

**`main` moving this fast makes long e2e-investigation PRs expensive to land**, not because the fix is wrong but because every CI cycle (10-13 min for `typecheck · build · unit tests` under tonight's load) is a window for another lane's merge to land and force a fresh merge-forward + re-verify + re-wait cycle. TRO-595 and TRO-594 each needed 2-3 rounds of: merge-forward (`CHANGES.md` only, `scripts/factory/merge-changes.mjs`) → `pnpm build:sdk && pnpm type-check` sanity check → re-verify the target e2e spec → push → re-request review → wait ~10min for CI → repeat. When `main` is this active, budget for it rather than treating each conflict as a surprise.

## Standing procedure — convoy pattern, still needed for every ticket

Per ticket: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` (NOT `origin main` — GitLab, the fetch remote, lags GitHub until manually synced) → resolve conflicts: `CHANGES.md` via `node scripts/factory/merge-changes.mjs --ours <(git show :2:CHANGES.md) --theirs <(git show :3:CHANGES.md) --out CHANGES.md` then `--check`, `scorecard.jsonl` via manual append-both (it's append-only, so conflicts are almost always "keep both sides") → commit → `pnpm build:sdk && pnpm type-check` sanity check (a stale `node_modules` symlink or unbuilt `sdk/dist` can cause a spurious `tsc` "cannot find module '@ship/sdk'" that clears on its own re-run) → re-verify the affected test file directly (faster than a full `gate.sh` re-run mid-review) → push. After every GitHub merge, sync GitLab from the **shared main dir** (not a worktree): `git pull https://github.com/troysatchell/ship.git main --ff-only && git push origin main`, verify both `git ls-remote` SHAs match.

**Migration numbers in the PRD are stale** — check fresh before assigning a number.

## Standing facts (for the next dispatch wave)

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for `worktree.sh`. `GH_REPO=troysatchell/ship` for all `gh` calls.
- **CodeRabbit is capacity-constrained this sprint, team-wide** — the hosted check's own `pass`/`fail` label is NOT trustworthy on its own: a rate-limited skip also reports `pass`. Always cross-check: `gh pr checks <n>` shows a `"Review rate limited"` vs `"Review completed"` detail string, and `gh api repos/.../pulls/<n>/comments --jq length` — 0 comments + "rate limited" means no real review happened. When genuinely rate-limited (both hosted `@coderabbitai review` and local `coderabbit review --base main` CLI — they share one team-wide allowance), do a disclosed manual self-review of the diff rather than merging blind — it catches real issues (this session caught two: a validation gap in TRO-602's follow-up, and a `return`-inside-`finally` bug in TRO-595's new test, both before any external review ran).
- **Only 3 checks are required for merge**: `typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)` (confirmed via `gh api repos/troysatchell/ship/branches/main/protection/required_status_checks`). A separate non-required `CodeQL` (GitHub default Advanced Security), `build · push image (GHCR)`, and `e2e · agent detection latency + grounded chat` can all fail/pend without blocking. `mergeStateStatus: UNSTABLE` (not `BLOCKED`) is safe to merge once the 3 required checks are green.
- **A CI run can genuinely take 9-13 minutes for `typecheck · build · unit tests`** under this sprint's concurrent-lane load — don't assume a stall before checking the job's own `startedAt` via `gh run view --job <id> --json status,startedAt`. Load average hit 44 at one point this session; even so, jobs completed within the normal window once queued.
- **Load-flake test identities keep recurring under concurrent `gate.sh`/CI load** (rule-24 class in `lessons.md` — hit `weeks.test.ts`, `token.test.ts`, `issues.test.ts`, `webhooks.test.ts`, `server.test.ts`, `OrgChartPage.test.tsx` this session) — always re-run standalone (and check `uptime`) before believing a failure; never widen the quarantine. `gate.sh` itself already does this standalone re-check automatically — read `.factory/*-standalone.txt`, don't just re-derive it by hand.
- **e2e flakes under load are real too, not just unit tests**: `beforeEach` hook timeouts and `webServer`-startup timeouts both showed up this session and both cleared on standalone re-run. Same discipline applies — verify, don't assume regression.
- Lock the Linear ticket to In Progress BEFORE dispatching.
- **Shared main-worktree collision risk still stands:** confine all git mutations to your own ticket worktree; only `fetch`/`status`/`log`/`ls-remote` are safe in the shared main dir. If you find another session's uncommitted change there (e.g. this update's `.dockerignore`), leave it — don't stash unless it's actually blocking you.

## Open questions / carry-over (low priority)

- W6 deadline: **AM 2026-08-16** (brief's own AM/PM contradiction, planning for the earlier one) — very close now; E6 is the metric that matters most between now and then.
- Carry-over, still untouched: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s; TRO-549/550/552 (Low/Medium, explicitly Backlog).
- TRO-593 (High) — `session-timeout.spec.ts` browser-context crash, not yet root-caused, unrelated to any W6 ticket. Has its own worktree (`Ship-wt-tro_593`) already provisioned by another lane as of this update.
