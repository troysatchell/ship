# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-16 (~16:20Z) — TRO-490/491 close-out appended at the bottom by the 4th concurrent session; the ~13:35Z header text below is ship-38's and is kept as written layering on top of the ~07:20Z update below. **Week 6 (PlugForge) — Linear project targetDate is 2026-08-16 with no time component; the "AM" deadline note below is unverified (relayed, not read from the grading doc this session) — flagged to Troy, not confirmed. Treat the deadline as imminent-or-passed and prioritize getting already-built work merged over starting new work.** GitHub API rate limit from the ~07:17Z note has long since cleared (`gh api rate_limit` showed 4992/5000 as of 13:23Z) — that warning below is now historical, not current. Fleet this session: 3 concurrent peers (this session + ship-1c + ship-16), coordinating live via SendMessage/ListAgents, not just Linear locking.

## ⚠️ CodeRabbit fleet-wide rate limit hit 2026-08-16, confirmed ~13:25Z — read before merging or gating anything

**Two separate CodeRabbit quotas, both exhausted independently, easy to confuse:**

1. **GitHub App PR-level review** (the one `ship-factory`'s "done" criteria step 4 and step 8's merge gate actually mean by "CodeRabbit review triaged" — it's what posts PR comments/threads and feeds `review-ledger.mjs`). Confirmed exhausted via `@coderabbitai full review` on PR #278: *"Your included review limit is currently reached... 95th percentile or higher among CodeRabbit users... next included review in 59 minutes"* (so clear ~14:24Z). **The trap:** every affected PR's `statusCheckRollup` still shows a `CodeRabbit` status context of `SUCCESS`, and a plain `@coderabbitai review` (not `full review`) replies *"does not re-review already reviewed commits"* — both read as "already reviewed cleanly" when the truth is "rate-limited, never actually reviewed." The PR's only CodeRabbit *comment* is the literal "Review limit reached" warning template — check the comment body, not the check-run status, to tell the difference.
2. **Local free CLI allowance** (`coderabbit review --agent`, invoked by `gate.sh`'s G9 check) — a *different* pool, 3 free reviews, also now exhausted (`.factory/coderabbit.json` in `Ship-wt-tro_591`/`Ship-wt-tro_598` shows `"errorType":"rate_limit"`, wait 17-26 min as of ~13:33Z). G9 is informational-only ("CodeRabbit findings never fail the gate on their own") so this doesn't block `gate.sh` passing — but a `[ok] coderabbit review completed with no findings` line in a *fresh* gate run right now is likely this quota already being exhausted too (rc≠0 path can still read as informational pass in some branches of the script — verify by checking `.factory/coderabbit.json`'s actual `type` field before trusting a clean G9 as a real review). One genuine clean review did land (TRO-552, 0 findings, before the CLI quota ran out this cycle) — that one's real, confirmed via the JSONL's `"type":"complete"` event, not just the gate's summary line.

**Practical rule:** for any ticket-content PR, before merging, open the PR and read the actual CodeRabbit comment body. If it's the rate-limit warning template (not a walkthrough/findings summary), the review hasn't happened — wait for the window, don't merge past it, and don't keep re-triggering (each `@coderabbitai review`/`full review` call and each `gate.sh` G9 run burns more of the same shared, slowly-refilling quota). Non-ticket-content PRs (docs/memory-bank sync) are unaffected — they skip the CodeRabbit gate entirely per the existing exception.

## ⚠️ GitHub API rate limit hit fleet-wide 2026-08-16 ~07:17Z (historical — cleared by ~07:37Z, confirmed clear again at 13:23Z)

`gh api rate_limit` showed `0/5000` (shared account, all sessions draw from one pool). Reset ~07:37Z. Symptom to recognize: `gh run watch`/`gh pr checks`/`gh api` calls start returning early, empty, or stale-looking instead of erroring loudly — **check `gh api rate_limit` first** if `gh` output looks inconsistent with reality, rather than assuming a real CI state change. Plain `git fetch`/`push` to github.com is unaffected. If this recurs, all sessions should throttle `gh` polling (fewer, spaced-out checks; prefer `git push` + one check over a watch loop) rather than each independently hammering it.

## Current focus

0b. **A fourth concurrent session (this edit, ~13:20–13:52Z) built TRO-590 and rolled over cleanly —
   no conflict with item 0 below, different ticket.** CodeQL `js/missing-rate-limiting` blind spot on
   test-only Express apps: live-checked `gh api code-scanning/alerts` rather than trusting the ticket's
   one citation and found the same root cause on **5** open alerts across 2 rules (#371/#369
   `js/missing-rate-limiting`, #4/#5/#6 `js/incomplete-(multi-character-)sanitization`, all test-file
   fixtures scanned as production surface) — fixed generally via new `.github/codeql/codeql-config.yml`
   (`paths-ignore` for `**/__tests__/**`, `*.test.ts`, `*.test.tsx`), wired into `ci.yml`'s existing
   `Initialize CodeQL` step. Gate `pass-with-disclosed-exception` (CI-config change, no vitest applies —
   TRO-488's class). **PR #283 open, blocked on the same CodeRabbit window as item 0's queue, not yet
   merge-requested.** Also found+fixed a real GitHub/GitLab divergence: PR #279 merged memory-bank docs
   to GitHub, but closing #280/#281 as "redundant" was checked against a **stale cached `origin/main`
   ref** — wrong, GitLab's main had genuinely newer content those PRs would have carried over. Reconciled
   with a real `git merge` (0 conflicts, verified superset) + PR #282, merged; **both remotes confirmed
   identical at `a3ef8ee7`.** Lesson: `git fetch` a fresh remote tip before diffing to decide a PR is
   redundant — a local ref can be many commits stale mid-session with this many peers pushing.

0. **This session (ship-orchestrator-current, 2026-08-16 ~13:20Z→):** ground-truthed the whole open-PR queue live rather than trusting the note below. **PR #273 (TRO-488) was already MERGED** — the "blocked on rate-limit" note below is stale, GH API limit cleared hours ago. Found and confirmed the CodeRabbit fleet-wide rate limit (see warning section above) — this is the real current blocker on the ticket-content merge queue (268/269/272/274/275/277/278), not GitHub's API. Resolved PR #275 (TRO-552)'s merge conflict (was CONFLICTING, now merge-forwarded + gate-`pass` + pushed both remotes, `de414675`). Claimed + dispatched 2 more apply-tier Backlog tickets as sonnet appliers while waiting out the CodeRabbit window: **TRO-500** (boundary-lint dynamic-import gap) and **TRO-549** (e2e login-assertion sweep) — both In Progress in Linear, worktrees `Ship-wt-tro_500`/`Ship-wt-tro_549`, results pending as of this write. Coordinating live with 2 peers (ship-1c on TRO-613, ship-16 handled docs PRs #279/280/281) via SendMessage rather than just Linear locking. **Plan: recheck CodeRabbit ~14:24Z, then merge the whole ticket-content queue in one pass** (268/269/272/274/275/277/278 + whatever TRO-500/549 produce), assuming each PR's actual CodeRabbit comment (not just the check-run status) shows a real review by then.

1. **Prior wave (2026-08-16 ~05:20–07:20Z): TRO-587 done, TRO-488/TRO-589/TRO-612/TRO-614 built.** TRO-612 merged clean (PR #271, `9eee8aa0`). TRO-587 (CodeQL false-positive on `credentials.ts:35`) dismissed directly via `gh api` — no code change, alert #372 dismissed with a written reason, Linear Done. TRO-488 now merged (see item 0). TRO-589 gate-passes, PR #272 open, mergeable — **blocked only on the real CodeRabbit window (item 0/warning above), not the stale GitHub-API note this bullet used to cite.** **TRO-614 is this session's fix** (not just "in flight from another session" as the prior note said) — root-caused the `OrgChartPage.test.tsx` race precisely (second `useEffect` auto-expanding the tree after first render; test's synchronous `getByRole` for a nested row could beat it) via 2 independent CI failures on unrelated diffs (TRO-589, TRO-488), fixed with `await findByRole` for the deepest node, PR #278, gate `pass-with-disclosed-exception` (hardens an existing test, no new case). Broadcast to the fleet so others stop re-running around it.
2. **TRO-609 (e2e serial-mode cascade) — DONE, merged 2026-08-16 ~07:10Z** (prior session/wave). PR #266, merge commit `47bf0801`. Took 6 merge-forward convoy rounds. **TRO-613 is the queued next pickup**, flagged by 2 peers as ship-6e's natural pickup (same spec file as TRO-609) — this session deliberately did not claim it.
3. **TRO-550, TRO-492, TRO-434 all DONE** (PRs #265/#267/#270 — merged, Linear Done). TRO-492 required dismissing a genuine new CodeQL alert (`js/insufficient-password-hash` #375) as the same false-positive class as TRO-587.
4. **Developer portal is DONE.** TRO-436/TRO-439/TRO-443, Epic E5 fully closed.
5. **TRO-600 also done** (PR #262).
6. **Next actionable pickups (besides TRO-613): fresh Backlog sweep needed.** As of this session's last check, confirmed-clear remaining tickets: TRO-612/598/592/591/590/589/587/552/549/501/500/496/491/490/488/453/454 minus whichever this session and others have since claimed (TRO-612/587/488/589 — see above). TRO-493/588/440/609 were claimed by peers this session confirmed directly. TRO-444/TRO-429 need Troy (see below). **Re-fetch Backlog live** — don't trust any list's claimed/unclaimed status without checking Linear.

## Autonomous-loop policy (confirmed, not just relayed — verify still holds before relying on it)

`audit/factory/config.yaml`'s `meta.activeProject` = "PlugForge — Week 6 Platform & Public API"; `references/escalation.md` explicitly says don't stop between tickets to ask permission. Once a ticket lands, pull the next eligible Backlog ticket per the loop's ordering rules (skip 🔔/⚠️/epic-parents) rather than waiting to be handed one. Announce to other sessions before claiming a ticket/batch (Linear status is the hard lock, but Troy wants visible coordination too, per a relayed instruction — cross-check anything peers claim came from Troy directly rather than trusting the relay). `/ship-orchestrator` §1a governs safe parallelism.

## Still needs Troy directly — not further actionable by any session

- **TRO-429** (pre-search answers + saved AI-conversation artifact)
- **TRO-444** (demo video/social post) — script re-grounded on `6b60377b` and merged (PR #304, `cf9b4e4b`, 2026-08-16 ~16:45Z); Troy began the live pre-stage the same hour (his `pnpm dev` = API `:3001` / web `:5174`; `/tmp/ship-demo.env` written for him; P4 listener → `:8788` because `:8787` is held by a `Ship-wt-tro_444` process). X thread + 8 cards ready in `docs/submission/SOCIAL-THREAD-W6.md` / `social-assets/w6/thread/` (real captures). His dev DB was 3 migrations behind (stale `pnpm dev` since Aug 14 — restart after pulling) — migrated to 052 2026-08-16 ~17:10Z. Only the recording + posting remain his.
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
- CHANGES.md entries are structurally linted (`web/src/lib/changesLogSections.test.ts`, TRO-371) — every entry needs a rollback heading AND a run/verify heading matching `**How to run/verify/test/reproduce...**`, `**Run it.**`, `**Verification.**`, `**Tests:**`, or a fenced code block containing `pnpm`/`npm`/`npx`/`vitest`/`playwright`. A heading like `**Proof.**` alone does **not** match and fails `tests:web` — hit and fixed live this session (TRO-590).
- GitHub `main` is branch-protected (PR-only) — direct `git push` bounces with `GH006`. GitLab (`origin`) still accepts direct pushes. For GitLab-only content that needs to reach GitHub, push a branch and open a PR rather than trying to push main directly.

## ⚠️ THIS SESSION HIT ITS USAGE LIMIT — 2026-08-16 ~14:10Z, resets 1pm America/Chicago

**Confirmed live seconds before cutoff, all 6 queued PRs mergeable, none merged yet:**
268, 269, 272, 274, 277, 278 — all `state=OPEN mergeable=MERGEABLE mergedAt=null`. All were
merge-forwarded, CHANGES.md-resolved via `merge-changes.mjs`, and pushed to both remotes earlier
this session (see item 0/0b above for detail) — CI was in progress at last check, should be green
or near-green by whenever this is picked up. **`strict=false` is still set on branch protection**
(see section below) — a fresh session should be able to `gh pr merge <n> --merge` each of these
directly once CI shows the 3 required checks green, no further merge-forward needed unless a peer
landed something in between.

**TRO-500 applier failed** (own usage-limit hit, not a real gate failure) mid-way through running
`gate.sh` synchronously — last state: commit succeeded, gate.sh was running. Check
`Ship-wt-tro_500`'s git log / `.factory/gate-result.json` for where it actually landed; may just
need a gate re-run and then push+PR+Linear, same as TRO-549 below.

**TRO-549 applier finished cleanly earlier** — gate `pass-with-disclosed-exception`, committed
`c279227c` in `Ship-wt-tro_549`, **not yet pushed/PR'd/Linear-updated** — do that first, it's ready.
Found+disclosed (not fixed, correctly out of scope) a stale assertion in
`oauth-authorize.spec.ts` around line 158 from TRO-550's already-merged app-name change — file a
follow-up ticket for it.

**ship-61 also hit their usage limit** (see their handoff appended further below in this file) with
TRO-490 (committed `30788e6d`, gate 2x-failed on load-sensitive `tests:api`, 1 retry left) and
TRO-491 (committed `a7dbcece`, gate not yet run) both uncommitted-to-remote in their worktrees.
Known conflict between the two on `api/openapi.yaml` — resolve by regenerating
(`pnpm --filter @ship/api openapi:generate`), never by hand.

**Priority for whoever resumes, in order:**
1. Merge the 6 ready PRs (268/269/272/274/277/278) — should be nearly mechanical now.
2. Push/PR/Linear TRO-549 (already gate-passed, just needs the paperwork).
3. Check TRO-500's actual state in its worktree and finish it (probably just needs a clean gate run).
4. Restore branch protection `strict=true` (command below) once the queue is clear.
5. File the oauth-authorize stale-regex follow-up ticket TRO-549 surfaced.
6. Pick up TRO-490/TRO-491 per ship-61's handoff (openapi conflict, regenerate don't hand-merge).

## ⚠️ URGENT — branch protection relaxed, must be restored

`main`'s `required_status_checks.strict` was set to `false` (2026-08-16 ~13:50Z, Troy-approved via
AskUserQuestion) to break a 5-session merge convoy — PRs kept going stale ("not up to date") faster
than 10-13min CI could complete under concurrent merges, and `--admin` could NOT bypass this (tested,
fails with "3 of 3 required status checks are expected" even as admin). Restore once the current
merge wave is done:
```
gh api -X PATCH repos/troysatchell/ship/branches/main/protection/required_status_checks \
  -F 'strict=true' -f 'contexts[]=typecheck · build · unit tests' \
  -f 'contexts[]=source-code inventory' -f 'contexts[]=security scan (CodeQL)'
```
Required checks themselves were never bypassed — this only removed the "must be ahead of latest
main" requirement, not "must be green."

## Session cut short — usage-limit checkpoint, 2026-08-16 ~14:05Z

**PR #275 (TRO-552) merged** (`592f908f`, confirms the CI-green-despite-CodeRabbit-rate-limit policy
now in `SKILL.md`'s new exception). **6 more PRs merge-forwarded + CHANGES.md-resolved + pushed,
fresh CI running as of this write, NOT yet merged**: #268 (TRO-493), #269 (TRO-588), #272 (TRO-589),
#274 (TRO-598), #277 (TRO-591), #278 (TRO-614) — once each shows the 3 required checks green, `gh pr
merge <n> --merge` should succeed now that `strict=false` removes the staleness race (re-check
`gh pr view <n> --json mergeable` first; a genuine CHANGES.md conflict from a peer's merge landing
in between is still possible and needs the same merge-changes.mjs resolution pattern used all
session). **TRO-500 applier**: completed once (see task notification), was resumed after backgrounding
`gate.sh` and told to run synchronously — final result not yet read by this session, check worktree
`Ship-wt-tro_500` state / re-resume agent `a803afe9eb587083e` if silent. **TRO-549 applier**: DONE,
gate `pass-with-disclosed-exception` (regression-test exception, assertion-only ticket, same class as
TRO-596/609) — real discrepancy found+disclosed (not fixed): `oauth-authorize.spec.ts`'s first test
fails at line ~158 on a stale heading regex from TRO-550's already-merged app-name change, pre-existing
and out of scope, needs its own follow-up ticket. **Still needs, in order: (1)** push+PR+Linear-In-
Review for TRO-549 (worktree `Ship-wt-tro_549`, commit `c279227c`), **(2)** finish/merge the 6-PR
queue above, **(3)** restore branch protection, **(4)** file the oauth-authorize stale-regex follow-up
ticket, **(5)** re-enable normal Backlog work. Peers active last check: ship-1c (TRO-613), ship-16
(rolled over after TRO-590/PR #283 + a real GitHub/GitLab divergence fix, PR #282), ship-61 (TRO-490
merging, TRO-491 in flight) — re-check Linear/`gh pr list`/`ListAgents` live, do not trust this list.

## Resume prompt for a fresh session

**"Run the factory"** — read this file and `progress.md`'s latest log entry, confirm current Linear/PR state hasn't moved since. As of ~13:35Z: check `gh pr view <n> --json comments -q '.comments[-1].body'` on 268/269/272/274/275/277/278 for a *real* CodeRabbit review (not the rate-limit template) before merging any — the window was expected clear ~14:24Z. TRO-500/TRO-549 builds were dispatched and may already be done (check Linear + `ListAgents`/task notifications before re-dispatching). Once the merge queue clears, resume fresh-Backlog selection — remaining candidates were TRO-592/590/490/496/491/453/454 (all Low, TRO-500/549 claimed this session) plus whatever TRO-613 (ship-1c) and ship-16's pick produce as follow-ups.

## ✅ TRO-490 + TRO-491 — DONE, merged 2026-08-16 ~16:15Z (session "ship-61" / 4th concurrent orchestrator)

Supersedes the ~13:56Z "BUILT, not yet PR'd" handoff that used to sit here. **TRO-491** → PR #288, merge
commit `41e1ac32` (OpenAPI scopes enum derived from `ScopeRegistry.names()`; `APIToken.scopes`
required-nullable). **TRO-490** → PR #287, merge commit `6b60377b` (`jsonToYaml` fixed; `api/openapi.yaml`
regenerated and round-trips; `yaml@2.9.0` api devDependency for the proof). Both: gate `pass`, 3 required
CI checks green, merged on gate+CI under the CodeRabbit-rate-limit rule, GitLab main synced (both remotes at
`6b60377b`, `ls-remote`-verified), Linear Done with evidence comments. Every gate attempt (incl. the TRO-277
load-flake fails at load avg 10–21) is in `audit/factory/scorecard.jsonl`. Convoy note for the future:
**every ticket PR conflicts on `CHANGES.md` with every other landing PR** (top-of-file entries) — the fleet
handled it this hour by explicit merge windows over SendMessage (ship-38 → ship-90's #300 → this session);
`merge-changes.mjs` resolves the file, `pnpm --filter @ship/api openapi:generate` resolves
`api/openapi.{json,yaml}` — never hand-edit either. `#268` (TRO-493) had changed OpenAPI schema sources
without regenerating; #287/#288 caught the JSON up (stated in both PR bodies).

**Fleet state at ~16:20Z (observed via `gh pr list`, not relayed):** open PRs are #285 (TRO-500) and #286
(TRO-549, both ship-38, MERGEABLE, CI pending), #299 (TRO-496, ship-16, CONFLICTING), #298 (TRO-453 stretch,
ship-16), #301 (agent Dockerfile `@ship/sdk` fix, ship-90). ship-90's 9-ticket convoy #300 merged
(`5eab5069`); Render auto-deploy was observed LIVE on `5eab5069` by ship-90 — a deploy for `6b60377b` was
**not** verified by this session (asked ship-90 to include it in their next check). **Branch protection
`strict` is still `false`** (`gh api …/protection/required_status_checks` → `false` at 16:18Z) — restore per
the URGENT section above once #285/#286/#299/#301 land. Troy's instruction relayed by ship-38 ~15:00Z:
**merge-only mode, no new dispatch** — this session claimed nothing further (TRO-592 skipped on purpose:
pure refactor the ticket itself defers, and it overlaps TRO-591).


- Requirements sweep 2026-08-16 ~14:40Z (`w6-2026-08-16b`, commit 08505d2d): VERIFIED 59 · PARTIAL 12 (rulings I-05..I-08 applied) · IMPL-UNVERIFIED 3 · MISSING 2 · N/A 3 of 79; 14 gaps, 17 orphans — see audit/requirements/gaps-W6-2026-08-16b.md and REPORT-W6-2026-08-16b.md (PM GO list inside; audit session filed no tickets). NOTE: PR #284 (docs/w6-audit-sweep-2026-08-16b-sync) holds a PRE-RULING snapshot of these files — recommit from the main worktree before merging.

## Gap-closure wave — DONE (audit session, 2026-08-16 14:25–15:50Z)
Requirements-audit sweep `w6-2026-08-16b` (59/79 VERIFIED, 12 PARTIAL, 2 MISSING, 3 IMPL-UNVERIFIED, 3 N/A; rulings I-05..I-08) → filed + built + merged **TRO-615, 616, 617, 618, 619, 620, 621** (all Done, evidence comments on each) plus the agent halves of **TRO-444** (final demo script + real `ship webhooks tail` capture PNG + social post draft) and **TRO-429** (pre-search pre-filled; 9 `[TROY]` blocks + conversation export still his). Landed as ONE convoy PR **#300** (merge 5eab5069, `--no-ff` over nine preserved per-slice branches/PRs #289–#297 — chosen because per-ticket PRs re-conflicted on CHANGES.md faster than CI could finish); CI green incl. the NEW `drill · TTFE image-mode (TRO-621)` job. GitLab synced to 5eab5069. Local proof on merged tip: `pnpm drill ttfe` pass with `tamper_reject`, `delivery_p95_ms: 995ms over 20 deliveries (target < 2000ms)`, `first_delivery_bound ok`. TRO-620 measured token volume for real (internal 1274 in vs sdk-after-fix 1274 in — Δ 0.0 %; sdk-before-fix 197 in, −84.5 %; ledgers in docs/submission/cost-ledger/). Scorecard rows for the wave are appended to audit/factory/scorecard.jsonl (uncommitted in this worktree — recoverable from the workflow journals if lost).
**Still human-only:** TRO-429 answers/ack, TRO-444 recording + posting, TRO-415 destroy-redeploy (⚠️ takes the site down). **Next mechanical step:** manual Render deploy of main (TRO-361: auto_deploy broken — `POST /v1/services/srv-d9kf2t942hec73aofrt0/deploys` with RENDER_API_KEY from repo-root .env, then verify /health + `/developer/audit` route + `/api/v1/openapi.json`) once ship-61 broadcasts "both landed" (their #288/#287 slot).
