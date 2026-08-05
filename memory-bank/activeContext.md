# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-05 (evening). Focus is **Week 5 — FleetGraph, Early Submission (Thu
2026-08-06 23:59)**. Backlog is now genuinely thin — verify against live Linear before assuming
anything below is still open.

## Where we are

**FleetGraph backlog factory wave (2026-08-05 evening) — PR-E and PR-F bundles merged, 3 loose
tickets closed, 3 new follow-ups filed.** PR-E (TRO-335 retro drafts + TRO-336 scope-drift
discrimination) and PR-F (TRO-322 regression suite + real CI-rollback proof + TRO-338 golden set)
both merged. TRO-343 (React Query cache leak) merged. TRO-344 (circular-blocks 409 code) and
TRO-342 (agent per-user Ship tokens, on-demand half only) have PRs open (#135, #136), gate-verified
pass, mergeable, waiting on GitHub CI to finish before merging. New backlog from this wave, all
low/medium and explicitly not blocking Early Submission: **TRO-348** (FG-8's accept flow has no
HTTP route — draft-survival metric can't record live), **TRO-349** (FLEETGRAPH.MD graph diagram 3
chains stale), **TRO-350** (proactive-poll half of the per-user-token gap — needs new token
infrastructure, correctly not built speculatively).

**Agent pill built and locally verified (2026-08-05 PM, branch `feat/agent-panel`, unpushed
— untouched by this evening's factory wave).** The agent's chat moved from the Properties-Sidebar
accordion to a floating bottom-center pill on every screen. Spec at
`docs/superpowers/specs/2026-08-05-agent-panel-design.md`. 554/554 web tests, type-check clean.

**Local standup test env is live** — fresh `ship_standup` DB (base seed only, FG-3 fixtures
re-anchored), full stack up including the agent with a real Anthropic key. Sign-in:
`alice.chen@ship.local` / `admin123`.

## Immediate

- Merge PR #135 (TRO-344) and #136 (TRO-342) once CI finishes — both gate-verified, mergeable, just
  waiting on GitHub Actions.
- Troy is browser-testing the `feat/agent-panel` pill; then PR it.
- Early Submission Thu 2026-08-06 23:59: Test Cases trace links per fixture (FG-22 / TRO-340,
  already Done), remaining PR-G slices, PRESEARCH.MD Phases 2–3 sections.

## Open questions

- TRO-348/349/350 (see above) — not urgent, worth a look before final grading rather than before
  Thursday.
- Week 4 final submission outcome — still not recorded in the bank.

## Standing watch-outs

- **`auto_deploy` on graded `ship`/`ship-agent` has silently failed twice** — after ANY merge,
  probe a route the merge added or `last-modified`; runbook in FLEETGRAPH.MD "Deployment model".
- **PR-D env vars live ONLY in Render env config** (`AGENT_INTERNAL_SECRET`, `AGENT_API_BASE_URL`;
  secret also at `~/.ship-agent-internal-secret`) — a clean `terraform apply` drops them and kills
  chat/inbox. Untracked: add to terraform.
- **`terraform apply` cannot update `render_web_service.agent`** (free-tier provider bug) — use the
  Render REST API.
- Local dev is now on the **`ship_standup`** DB (`api/.env.local`); the audit-augmented `ship_dev`
  (638 docs) is intact — swap DATABASE_URL back if a compare run ever needs it.
- Check GitLab CI too (`glab ci status --branch main -R troysatchell/ship`). Backlog: `TRO-309`
  (CodeQL alerts, unread), `TRO-310` (TEST-11 batch 2).
