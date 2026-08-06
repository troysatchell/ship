# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-06 (early AM). Focus is **Week 5 — FleetGraph, Early Submission (Thu
2026-08-06 23:59)**. Backlog is genuinely near-empty now — verify against live Linear before
assuming anything below is still open.

## Where we are

**Full-backlog factory wave (2026-08-05 night → 2026-08-06 early AM) — all 5 remaining backlog
tickets built; 4 merged, 1 held for human sign-off.** User asked to survey the backlog, then said
"run factory on all 5." TRO-309 (7 CodeQL alerts — fixed a real open-redirect bypass + YAML
sanitization bug, dismissed 5 with evidence), TRO-349 (FLEETGRAPH.MD diagram, 3 missing chains),
TRO-348 (wired FG-8's `acceptDraft` to a real HTTP route + production tracker wiring), and TRO-310
(TEST-11 batch 2 — hardened `tables.spec.ts`/`backlinks.spec.ts`, found 2 real test-simulation bugs)
all merged (PRs #139–#142). **TRO-350 (proactive-poll per-recipient token investigation) is open as
PR #138, gate/CI green, deliberately NOT merged** — it touches agent auth/token semantics
(escalation.md #6), concluded accepted-risk-documented with no new infrastructure built; needs Troy's
explicit read before merge.

**5 new follow-up tickets filed from this wave, all low/medium, none blocking:** TRO-351 (stale
FLEETGRAPH.MD prose CodeRabbit + TRO-349 both flagged), TRO-352 (3 more `gate.ts` functions —
`discardItem`/`acceptProposedTransition`/`rejectProposedTransition` — with the same
no-HTTP-caller defect TRO-348 fixed for `acceptDraft`), TRO-353 (no UI page exists at all to reach a
standup draft — the frontend half of TRO-348/352 is still missing), TRO-354 (TEST-11 batch 3, ~428
sleep sites remain across 40 files), TRO-355 (a real product gap: no table row/column mutation UI
exists anywhere in `web/src` — 4 e2e tests were silently vacuous, converted to `test.fixme()`,
needs a human product decision to build or delete).

**Small bookkeeping PR #143 (review-ledger rows for TRO-349's dismissed findings) still open**,
pending its own CI — non-code, mergeable on gate+CI green alone per the factory's own exception.

## Immediate

- **Troy: read PR #138 (TRO-350) and decide** — merge as accepted-risk-documented, or ask for the
  per-user token infrastructure to actually be built.
- Merge PR #143 (bookkeeping) once its CI lands.
- Early Submission Thu 2026-08-06 23:59: PRESEARCH.MD Phases 2–3 sections still not confirmed done
  (last checked 2026-08-05 evening) — verify before the deadline.

## Open questions

- TRO-351/352/353/354/355 — not urgent, worth a look before final grading rather than before
  Thursday.
- Week 4 final submission outcome — still not recorded in the bank.

## Standing watch-outs

- **Two more sub-agents this wave hit the "started a background gate/monitor, then stopped saying
  'waiting for its notification'" anti-pattern** (lessons.md rule 22) — TRO-350's and TRO-349's
  investigators both did this despite the rule being well-established; both recovered cleanly after
  one nudge to check synchronously. Restating the rule in the brief has not been a reliable
  deterrent for this failure class either (same conclusion this file already recorded for the
  `git stash` ban) — worth a mechanical check if it recurs a third time.
- **The CHANGES.md insertion-point conflict now compounds sequentially across a whole wave**, not
  just pairwise: merging TRO-309 forced TRO-348/349/310 to each re-resolve via `merge-changes.mjs`,
  and merging each of those forced the *next* one to re-resolve again — 3 rounds deep for TRO-310,
  the last PR to land. Expect this scaling with wave size, not just PR count.
- **A native (non-required) GitHub "CodeQL" check can fail on a PR for alerts that are pre-existing
  and unrelated to that PR's diff** — confirmed again this wave on PR #141 (one alert identical to
  one TRO-309 already dismissed, one outside the PR's actual diff hunk). Check `mergeStateStatus`
  (`UNSTABLE` + `mergeable: MERGEABLE` means it's not actually blocking) before treating this as real.
- `documents.test.ts` and `UnifiedDocumentPage.programWeeksNav.test.tsx` load-flakes now confirmed
  to reproduce **in GitHub Actions CI itself**, not just locally under concurrent-worktree load —
  both cleared on a plain re-run this wave (PR #142).
- **`auto_deploy` on graded `ship`/`ship-agent` has silently failed twice** — after ANY merge,
  probe a route the merge added or `last-modified`; runbook in FLEETGRAPH.MD "Deployment model".
- **PR-D env vars live ONLY in Render env config** (`AGENT_INTERNAL_SECRET`, `AGENT_API_BASE_URL`;
  secret also at `~/.ship-agent-internal-secret`) — a clean `terraform apply` drops them and kills
  chat/inbox. Untracked: add to terraform.
- **`terraform apply` cannot update `render_web_service.agent`** (free-tier provider bug) — use the
  Render REST API.
- Local dev is on the **`ship_standup`** DB (`api/.env.local`); the audit-augmented `ship_dev`
  (638 docs) is intact.
- All three remotes (local/GitHub/GitLab) verified at identical HEAD `ba7f55c` as of this wave's
  last merge (PR #142). Check GitLab CI too (`glab ci status --branch main -R troysatchell/ship`).
