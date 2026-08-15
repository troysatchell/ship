# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-15 (~20:52Z, by the chief-orchestrator session, rolling over now). **Week 6 (PlugForge) — factory running as multiple parallel Claude sessions. The submission-readiness assessment surfaced two real, concrete gaps this session (32 pre-existing failing e2e tests violating the rubric's "suite must pass" requirement, and no published/working grader OAuth credential) — both now provisioned. A THIRD, more urgent gap was found mid-fix: the live Render deploy has been silently broken since ~05:00 UTC (`.dockerignore` bug, now fixed and merged), meaning six merged PRs including a live auth gap (TRO-611) never actually reached production. That auth gap must land before the redeploy fires — it's the one thing still blocking.**

## What's actually in flight right now — read this before doing anything else

1. **TRO-604 (PR #247) — MERGED and both remotes verified in sync** (`main` @ `64ed589` at merge time, since moved further as TRO-596 landed too). Puts the `.dockerignore` fix on `main` — the root-cause fix for the live deploy being stuck on a ~12h-old commit. **The redeploy trigger is still held — see item 2.**
2. **TRO-611 (Urgent, worktree `Ship-wt-tro_611`, dispatched to ship-6e) — implemented and self-verified, not yet merged as of this handoff.** Fix: new `assertDocumentWritable()` check (`visibility='workspace' OR created_by=viewer`) gating the `PATCH /api/v1/documents/:id` write path; 404 on block (matches this file's existing convention); admin-bypass deliberately omitted (`Principal` has no role/admin concept — correctly failed toward restrictive rather than guessing one). Verified red-before-green (reverted, confirmed `expected 200 to be 404` reproduces the real vuln, restored, 34/34 green) and confirmed the document's DB `content` is byte-for-byte unchanged after a blocked attempt, not just the HTTP status. As of the last status ping (~20:52Z), delayed only by `gate.sh` retries under this session's sustained high system load (confirmed load-induced: standalone-passing, zero file overlap with concurrent lanes) — on attempt 2/3, expected to push+PR imminently. **This is the ONLY thing blocking the redeploy.** Check Linear (`TRO-611`) and `gh pr list --search "TRO-611"` fresh — may already be merged by the time you read this.
3. **TRO-596 (PR #246) — MERGED**, both remotes verified in sync. CHANGES.md exact-count fix; running the real `/e2e-test-runner` sweep surfaced a genuine pre-existing unrelated bug, filed as **TRO-609** — a file-level `test.describe.configure({mode:'serial'})` means one early failure skips 30 of 54 tests silently. Low priority, untouched.

## The redeploy sequence, once TRO-611 lands

1. Confirm TRO-604 is on `main` (both remotes in sync — `git ls-remote` both, SHAs must match).
2. Confirm TRO-611 is on `main` too.
3. Trigger `POST https://api.render.com/v1/services/srv-d9kf2t942hec73aofrt0/deploys` (Render API, `RENDER_API_KEY` from repo-root `.env`, `terraform/render/README.md`'s documented pattern). This is the `ship` service (`ship-rr6m.onrender.com`) — do NOT touch `ship-agent` (`srv-d9otunmgekts73eqs0h0`) or `labelhunter-*` (different project, same account).
4. Poll the deploy until it succeeds (previous 7 attempts since ~05:00 UTC all failed on the now-fixed dockerignore bug — this one should actually complete).
5. Run `pnpm db:seed` against the **production** database with `GRADER_OAUTH_CLIENT_SECRET` (already set live via the Render API this session — value is in `/private/tmp/claude-501/.../scratchpad/grader-secret.txt` in the orchestrator's session, `chmod 600`, treat as sensitive; regenerate if that scratchpad is gone rather than guessing).
6. Verify the live `/oauth/token` client_credentials flow against the real prod URL (not the local scratch DB used for pre-verification earlier).
7. Publish `client_id` + the secret in `README.md` next to `alice.chen`'s existing web-login credentials.

None of steps 3–7 have happened yet. Step 3 is explicitly gated on TRO-611.

## Standing facts carried forward from the prior rollover (still true)

- `GH_REPO=troysatchell/ship` for all `gh` calls. Factory Postgres: `ship-postgres-1` (:5433).
- Convoy pattern per ticket: `git fetch https://github.com/troysatchell/ship.git main && git merge FETCH_HEAD` (NOT `origin main` — GitLab lags) → `CHANGES.md` via `scripts/factory/merge-changes.mjs --ours/--theirs/--out` then `--check` → `scorecard.jsonl` conflicts are append-only, union both sides by hand (never `-X ours`/`-X theirs`, it drops real rows) → commit → `pnpm install` → gate → push.
- **`main` moved extremely fast this session** — 6+ merges landed while just two PRs (TRO-604, TRO-596) were each mid-CI. Budget for repeated merge-forward rounds as normal, not a surprise.
- **CodeRabbit is capacity-constrained team-wide this sprint.** A `"pass"` bucket can mean "rate limited," not "reviewed" — check the detail string (`"Review rate limited"` vs `"Review completed"`) before trusting it.
- **Only 3 checks are required for merge**: `typecheck · build · unit tests`, `source-code inventory`, `security scan (CodeQL)`. Non-required checks (`CodeQL`, `build · push image (GHCR)`, `e2e · agent detection latency + grounded chat`) can fail without blocking.
- **A CI run can genuinely take 9–13 minutes** for `typecheck · build · unit tests` under this sprint's concurrent-lane load. Check `gh run view --json jobs` for `startedAt` before assuming a stall.
- **Load-flake test identities keep recurring under concurrent `gate.sh` load** (rule-24 class) — this session added `ratelimit/middleware.test.ts`, `token.test.ts`, `backlinks.test.ts`, `webhooks.test.ts` to the list of tests seen flaking. Always verify via `.factory/*-standalone.txt` (gate.sh does this automatically) before treating as a regression. When local `gate.sh` itself hangs or takes 3-5x its normal duration under heavy concurrent load, killing and pushing to rely on GitHub's CI (unaffected by local contention) is a reasonable call — this session did that once for TRO-604 after a 15+ minute outlier.
- A `pass-with-disclosed-exception` gate verdict is legitimate and precedented (PF-900/terraform tickets, TRO-293/TRO-596 test-deletion tickets) when the failing check (`regression-test`, `tests:not-weakened`) is structurally inapplicable to the ticket's own nature and the CHANGES.md entry already documents why — don't chase an unreachable "pass" on those specific checks.

## Deadline

W6 deadline: **AM 2026-08-16** — very close. E6 (PF-600/601/602/603, the graded TTFE metric) is still the top substantive priority once the redeploy/auth-gap sequence above resolves; PF-603 (`pnpm drill ttfe`, <60s / 0% flake over 20 runs) is the last and most important piece and has not been picked up this session.

## Open, lower priority

- TRO-609 (e2e serial-mode cascade + one unrelated failing test, filed this session) — Medium, Backlog, untouched.
- TRO-593 (session-timeout browser-context crash) — was In Progress on ship-e8 as of the last check this session; verify status fresh.
- Carry-over from before: PR #138 (TRO-350), TRO-353, TRO-549/550/552 — all still untouched, Backlog.
