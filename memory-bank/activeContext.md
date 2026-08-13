# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-13 (~02:20Z session clock; local 2026-08-12 evening). **Week 6 (PlugForge) — wave-3 tail cleared, 4 PRs open awaiting merge queue, MVP chain unblocking.**

## Current focus

1. **Merge queue — 4 open PRs, all gate-passed, all triaged, required CI green at last check:**
   - **#183** (TRO-412/PF-103): final head `ac1b55c` (e2e repair) pushed, CI re-running. 11 CR findings + 3 CodeQL Highs all triaged/dismissed-with-reasons (ledger'd). OAuth e2e spec now genuinely passes 2/2 (first-ever real runs). Merge when CI green; **its merge unblocks PF-104/TRO-416 dispatch**.
   - **#184** (TRO-441/PF-907): gate pass 12/12 at `40cc5d8` (+ convoy `36d9b26`). Awaiting CodeRabbit PR review → triage → merge. Deploy-verification half of AC explicitly deferred (portal/PF-202 don't exist).
   - **#185** (TRO-489): gate 11/12, `regression-test` fail = **documented pure-refactor exception in PR body** (TRO-420 precedent). Awaiting CodeRabbit → merge. Post-convoy errors.test.ts 16/16.
   - **#186** (TRO-398/PF-200): gate pass 12/12 at `bdff0d1` (+ convoy `e229e95`). Awaiting CodeRabbit → merge. **Its merge unblocks PF-201/TRO-400 and PF-202/TRO-402** (worktree Ship-wt-tro_402 pre-provisioned, stale base — re-provision or merge main).
   - Each merge: `--merge` via gh, then sync GitLab (`git fetch <GH URL> main && git merge --ff-only && git push origin main`, verify both ls-remote SHAs), then blind verifier per ticket (ticket + diff + gate JSON ONLY), then Done with evidence comment.
2. **MVP remainder after merges (Troy's MVP-first directive, PLUGFORGE §6):** PF-104/TRO-416 (after #183) → PF-105/TRO-421 → PF-106/TRO-425; PF-201/TRO-400 + PF-202/TRO-402 (after #186) → PF-203/TRO-404; PF-400/TRO-405 (after PF-201). PF-500/427 + PF-501/432 stay deferred.
3. **Docs/bookkeeping PR** (branch `docs/w6-wave3-bookkeeping` if not yet open): CLAUDE.md, lessons.md (3 new entries), scorecard, review-findings ledger, memory-bank. Non-ticket content → merges on CI green alone. Does NOT touch CHANGES.md so no convoy tax on open PRs. Still queued from last session and NOT yet done: "stale architecture.md hedge fix" (details lost — re-derive or drop).

## Standing facts

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for worktree.sh. `GH_REPO=troysatchell/ship` for all gh calls. serve.mjs on :7373 (may need restart in new session).
- Both remotes verified `ccd776de` after #181's merge (2026-08-13 01:56Z). #180/#182 were merged externally on 2026-08-11 evening (not by a factory session); their tickets blind-verified CONFIRMED this session.
- **One gate.sh at a time** (lesson 24). Two gate fails this session were sibling-load flakes (app-registration.test.ts, issues.test.ts — both passed standalone, both ledger'd in scorecard).
- Verifier/builder targeted test runs: `cd api && npx vitest run <path>` — NEVER `pnpm --filter @ship/api test -- <path>` (runs full suite; new lessons entry).
- Sub-agent watchdog: single silent commands >600s kill the agent. Stalled agents can be RESUMED via SendMessage with context intact (worked twice this session — cheaper than fresh dispatch).
- TRO-402's Linear "blocked by TRO-398" gates PF-202 dispatch on TRO-398 being Done (merge + blind-verify), not merely PR'd.

## Open questions

- W6 deadline contradiction (Sun AM vs PM) — planning for **AM 2026-08-16**.
- Carry-over: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s.
- CodeRabbit PR reviews on #184/#185/#186 not yet posted at handoff — if absent after ~30 min, check the app's status; do not split or route around (guardrail).

## Standing watch-outs

- TRO-361 Render `auto_deploy` broken — manual deploys + SHA verify. Graded CI is GitLab (verify GitLab pipeline after syncs). TRO-503 (CloudFront /oauth/* gap, High) is deploy-blocking for PF-103's prod path — required edge-ceiling note on the ticket.
- New tickets this session: TRO-549 (e2e login assertions, Low), TRO-550 (consent app-info lookup, Med), TRO-551 (OpenAPI /api-prefix hardcoded — **High, E1 adds more /oauth routes soon**), TRO-552 (limiter boundary predicate test, Low).
