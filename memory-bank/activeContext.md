# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-14 (~18:00Z). **Week 6 (PlugForge) — overnight autonomous run ended cleanly on Troy's "find a place to stop." MVP hard gate CODE-COMPLETE + verified. Post-MVP waves 1-3 done (9/9 tickets merged). `main` @ `c9007a6e959b7715e5d4f83413a49c72e4dbf4ea`, GitHub+GitLab confirmed in sync, zero open PRs.**

## Where this session stopped

Troy said "find a place to stop" mid-wave-3. TRO-438/PF-304 (webhook deliverer + DLQ, the last ticket in flight) was ~90% done at that point with real code already pushed — let it finish naturally (a few more minutes) rather than cutting it off mid-CodeRabbit-triage, then closed the queue. **No wave 4 was dispatched.** This is a deliberate stop, not a stall — the next session should pick a fresh target rather than assume something was interrupted mid-flight.

## What's done (full detail in progress.md's dated log — this file only tracks what's next)

- **MVP hard gate**: all 6 originally-outstanding tickets (PF-201/202/203/400, PF-105/106) + the one MVP-adjacent test gap (PF-104's PKCE e2e chain, TRO-597) — merged, verified, zero regressions from any of it (W6-R10 resolved via 3-pass investigation + bisection).
- **Post-MVP wave 1** (E3+E4 foundation): PF-301 domain write path (the PRD's own top structural risk), PF-401 SDK resource clients, PF-403 verifyWebhook, PF-404 SDK auth helpers.
- **Wave 2**: PF-302 webhook subscriptions API, PF-402 SDK async-iterator pagination.
- **Wave 3**: PF-304 webhook deliverer+DLQ (a real key-rotation safety bug caught and fixed), PF-405 SDK parity+size gates (closes Epic E4 entirely), PF-500 rate-limit token buckets+headers (opens Epic E5).
- **12 follow-up tickets filed** from findings along the way (TRO-587-596), none blocking, mostly Low/Medium — see progress.md log for what each is.

## Next actions, in priority order

1. **E3 remainder** — PF-305 (delivery log API) and PF-306 (replay endpoint) both unblock from PF-304 (done). Small, well-scoped.
2. **E5 remainder** — PF-501 (public audit trail, next migration number ~049 — check `ls api/src/db/migrations/ | sort -V | tail -3` fresh, don't trust any PRD-stated number) is independent. PF-502/503 (portal UI) come after, with an explicit kill-criterion (PF-504) if E6 is running behind.
3. **E6 — the actual graded metric.** PLUGFORGE.MD's own framing: "the grade is the Time-to-First-Event drill, not endpoint count." Every prerequisite is now in place (SDK complete, `/api/v1/documents` resource, webhooks end-to-end through delivery). Prioritize PF-600 (CLI scaffold + `ship login` via device flow) → PF-602 (`ship webhooks tail`, the demo money shot) → PF-603 (the drill itself, `pnpm drill ttfe`, wired into both CIs) over E5/E8 if time is tight — this is literally what's graded.
4. **🔔 Hard boundaries — never self-approved regardless of instructions to work autonomously:** PF-700 (E7 agent-rewire checkpoint) and PF-904 (pre-search + demo recording) are HUMAN CHECKPOINTs per PLUGFORGE.MD §0.1. TRO-415/PF-901 (destroy-and-redeploy against the LIVE graded environment) needs explicit human go-ahead — do not run `terraform destroy` against the real environment.
5. **Re-run `/requirements-audit`** once E3/E5/E6 have real movement, to get a current picture before scoping E8/E9 (submission docs, most of which need Troy's own input — pre-search answers, demo recording, social post).

## Standing procedure — convoy pattern, still needed for every ticket

Main moves fast during an active wave. Per ticket: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` (NOT `origin main` — GitLab, the fetch remote, lags GitHub until manually synced) → resolve `CHANGES.md`/`scorecard.jsonl` via `node scripts/factory/merge-changes.mjs --ours <(git show HEAD:CHANGES.md) --theirs <(git show origin/main:CHANGES.md) --out CHANGES.md` → `--check` → commit → `pnpm install` → re-`gate.sh` → push. After every GitHub merge, sync GitLab: `git fetch https://github.com/troysatchell/ship.git main:main && git push origin main` from the main worktree.

**Migration numbers in the PRD are all stale** — OAuth work consumed 042-046, webhooks work is now at 047-048. Always check fresh before assigning a number.

## Standing facts (for the next dispatch wave)

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for `worktree.sh`. `GH_REPO=troysatchell/ship` for all `gh` calls.
- **CodeRabbit is capacity-constrained this sprint** — try `gh pr comment <n> --body "@coderabbitai review"` once, wait ~90s; disclosed manual self-review substitutes if still limited. Occasionally clears and does a real review — check fresh each PR.
- **Only 3 checks are required for merge**: `typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)` (confirmed via `gh api repos/troysatchell/ship/branches/main/protection`). A separate non-required `CodeQL` (GitHub default Advanced Security) often flags unrelated things — check before spending time on it. `mergeStateStatus: UNSTABLE` (not `BLOCKED`) is safe to merge once the 3 required checks are green.
- **`gh pr checks` can be empty/stale for several seconds after a push** — cross-check `gh api repos/troysatchell/ship/commits/<full-sha>/check-runs` if it looks wrong.
- **`api/src/db/__tests__/migrations-042-043.test.ts`'s AC-2 fixture has an exclusion list that must be extended every time a new migration ALTERs (or FK-references) an oauth/webhooks table** — this has bitten TRO-421, TRO-425, and TRO-438 independently. The file's own header says to extend it; CI's coverage job catches this even when 8 rounds of local `gate.sh` don't (v8 coverage instrumentation changes test scheduling enough to surface it). Check this list proactively on any new migration ticket rather than waiting for CI to catch it.
- **Recurring agent failure mode across the whole session (~10+ occurrences):** a dispatched builder arms a background process for `gate.sh`/CI, then ends its turn waiting for a notification that never arrives. Always state this explicitly in dispatch briefs; still recurs — catch via `ListAgents` + `SendMessage`, don't wait indefinitely. Twice tonight this escalated to a genuine watchdog stall (system load spiked to ~28 during 3 concurrent `gate.sh` runs) — if multiple agents stall simultaneously, check `uptime` before assuming it's the self-report pattern again; it may be real resource contention, and resuming should still work either way.
- Lock the Linear ticket to In Progress BEFORE dispatching the Agent call, not after.
- Load-flake test identities keep recurring under concurrent `gate.sh` load (`weeks.test.ts`, `OrgChartPage.test.tsx`, others — rule-24 class in `lessons.md`) — always re-run standalone before believing a failure; never widen the quarantine.

## Open questions / carry-over (low priority)

- W6 deadline: **AM 2026-08-16** (brief's own AM/PM contradiction, planning for the earlier one).
- Carry-over, still untouched: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s; TRO-549/550/552 (Low/Medium, explicitly Backlog).
- TRO-593 (High) — `session-timeout.spec.ts`, 29/58 cases crash the browser context at a consistent 60s, suspected `page.clock` large-fast-forward mechanism — real pre-existing bug, not yet root-caused, worth real investigation time when there's room (unrelated to any W6 ticket, confirmed via bisection).
