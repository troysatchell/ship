# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-13 (~18:47Z session clock). **Week 6 (PlugForge) — MVP-path merge queue fully cleared (5 tickets Done+blind-verified); 4 more E1/E2 builders dispatched and running in background at session end.**

## Current focus

1. **4 builders in flight at rollover, none babysat to completion this session — check state first, don't re-dispatch:**
   - `Ship-wt-tro_400` (TRO-400/PF-201, issues/sprints/me) and `Ship-wt-tro_402` (TRO-402/PF-202, `/api/v1` OpenAPI 3.1 registry) — dispatched in parallel, PF-202 explicitly scoped to NOT wait for PF-201's routes (same pattern as TRO-551/TRO-416 below).
   - `Ship-wt-tro_421` (TRO-421/PF-105, refresh rotation) and `Ship-wt-tro_425` (TRO-425/PF-106, device auth grant — the biggest ticket, API+web+migration; agent was told to say so if it outgrows one ticket rather than ship half-done).
   - For each: `cd <worktree> && git log --oneline -8` to see if it committed/pushed; if pushed, independently re-run `scripts/factory/gate.sh` yourself (never trust self-report) before opening a PR. If a worktree shows no new commits and no push, the agent may still be running or got stuck — check `ListAgents`/`SendMessage` to the agent name before re-dispatching from scratch.
2. **Every PR this wave will need a `main`-forward convoy before it merges — main moved 5+ times in ~2hrs.** Pattern proven working: `git fetch origin main && git merge origin/main` → resolve `CHANGES.md` conflict via `node scripts/factory/merge-changes.mjs --ours <(git show HEAD:CHANGES.md) --theirs <(git show origin/main:CHANGES.md) --out CHANGES.md` (or via tmp files) → `--check` → commit → `pnpm install` → re-`gate.sh` → push. Expect it more than once per PR; #185/#189 each needed 4-5 rounds this session as `main` kept advancing underneath them.
3. **After 400/402/421/425 land:** PF-203/TRO-404 (after PF-202 Done) and PF-400/TRO-405 (after PF-201 Done) are the last two MVP-gate tickets. PF-500/TRO-427 + PF-501/TRO-432 stay explicitly deferred (post-MVP, PLUGFORGE §6's own cut list). Full MVP gate = E0+E1+PF-200/202/203+PF-400+terraform(done)+deployed grader(done) — check PLUGFORGE.MD §6 again once these land, don't assume from memory.

## Standing facts

- Factory Postgres: docker `ship-postgres-1` (:5433); `FACTORY_PG_CONTAINER=ship-postgres-1` for `worktree.sh`. `GH_REPO=troysatchell/ship` for all `gh` calls.
- **CodeRabbit (hosted PR review AND local free-CLI allowance) is capacity-constrained this session** — Troy confirmed another higher-priority project is consuming it. When it's rate-limited on a PR: try `gh pr comment <n> --body "@coderabbitai review"` once: if still limited, do a careful manual diff read yourself (documented as a stated exception in the PR body, same precedent class as the git-stash-guard override) rather than blocking. Don't assume this has cleared — check fresh each PR.
- **GitHub Actions sometimes never triggers a `pull_request` run on push** (webhook miss, not a queue issue) — if `gh api "repos/.../actions/runs?branch=<b>"` shows nothing for 30-60s after a push, `gh workflow run ci.yml --ref <branch>` to force it. When polling for a run by SHA, use the FULL 40-char SHA — a short SHA silently matches nothing.
- **New real CVE this session:** `nanoid <3.3.18` (GHSA-2v37-7h3g-55p8, transitive via `vitest>vite>postcss`), advisory updated 2026-08-13T15:43Z, blocked `dependency-audit-diff` repo-wide. Fixed via a `pnpm.overrides` entry in root `package.json` (same pattern as the existing js-yaml override) — already merged to `main`. If it recurs, it's already fixed; look for a NEW advisory instead of re-adding this one.
- **Load-flake identities seen THIS session** (all confirmed: file untouched by the failing branch's diff, passes standalone via `gate.sh`'s own re-run) — joining the rule-24 set in `lessons.md`: `OrgChartPage.test.tsx`, `files.test.ts`, `weeks.test.ts` (previously catalogued), `UnifiedDocumentPage.programWeeksNav.test.tsx` (previously catalogued), and **new**: `documents-pagination.test.ts`. Root cause suspected: heavy concurrent `gate.sh` usage (up to 5 worktrees this session) PLUS a confirmed concurrent peer session (`implement-tro-558-559-ocr-eval`) hitting the same `ship-postgres-1` container. Not yet folded into `lessons.md` itself — do that next session if it recurs a 3rd+ time this wave (rule: 3+ recurrence → mechanical gate check, not just a bigger warning).
- **CodeQL "missing rate limiting" on `/oauth/*` routes is an accepted, already-ticketed gap** (PF-500/TRO-427, explicitly post-MVP) — same dismissal PR #183 used; applies again to any future `/oauth/*` route (PF-105/106 will likely hit it too). Not a required merge check.
- **Lock the Linear ticket to In Progress BEFORE dispatching the Agent call, not after** — missed this for TRO-551/TRO-416 initially, caught it when a peer session asked about collisions, fixed retroactively. Applied correctly for TRO-400/402/421/425.
- Blind verification this session: dispatch a **fresh** agent (no shared context) with only the ticket body + `gh pr diff` output + `.factory/gate-result.json` written to files — orchestrator having already read the builder's report disqualifies it from verifying blind.

## Open questions

- W6 deadline: **AM 2026-08-16** (contradiction noted, planning for the earlier one).
- TRO-441's blind verifier found a trivial dead import (`generateClientId`, unused) — not worth its own ticket, fix opportunistically if that file is touched again.
- TRO-489's blind verifier found a stale doc reference (`oauth/README.md:18` still names the now-deleted `apiError.ts`) — same, opportunistic fix only.
- Carry-over from before this wave, still untouched: PR #138 (TRO-350) merge-or-hold; TRO-353 inbox draft 404s; TRO-549/550/552 (Low/Medium CodeRabbit follow-ups, explicitly left in Backlog, not MVP-gate).

## Standing watch-outs

- TRO-503 (CloudFront `/oauth/*` routing gap, High) — separate from the rate-limiting dismissal above, this is about `/oauth/authorize` being unreachable through CloudFront on the AWS deploy path. Still open, still relevant once PF-104/105/106 need a real deploy.
- TRO-551 (OpenAPI `/api`-prefix fix) is merged — the mechanism exists now, but PF-104/105/106's `/oauth/*` routes remain UNREGISTERED by design (each ticket deferred it since the sibling tickets weren't landed yet at dispatch time). **This is real accumulating debt, not a mistake** — a follow-up ticket to register all of E1's routes at once (now that PF-103/104 exist, and 105/106 will soon) is a good candidate for after this wave, batching per the "shared root cause" dispatch principle rather than one ticket per route.
