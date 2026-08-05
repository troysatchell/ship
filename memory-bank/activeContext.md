# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-05 (afternoon). Focus is **Week 5 — FleetGraph UI presentation + Early Submission (Thu)**.

## Where we are

**Agent pill built and locally verified (2026-08-05, branch `feat/agent-panel`, unpushed).** The
agent's chat moved from the Properties-Sidebar accordion to a floating bottom-center pill on every
screen (Troy's design call mid-session; Inbox deliberately untouched). Spec at
`docs/superpowers/specs/2026-08-05-agent-panel-design.md`. 554/554 web tests, type-check clean.
Along the way: `scripts/dev.sh` was genuinely broken since the agent package gained a `dev` script
(global `PORT` export made agent race API for one socket) — fixed, committed on the branch.

**Local standup test env is live** — fresh `ship_standup` DB (base seed only, FG-3 fixtures
re-anchored), full stack up including the agent with a real Anthropic key. Sign-in:
`alice.chen@ship.local` / `admin123` (2 mentions + chat verified end-to-end with citations; the
seeded blocking approval targets Emma by design — `changes_requested` routes to the owner).

## Immediate

- Troy is browser-testing the pill at the current `.ports` web URL; then PR `feat/agent-panel`.
- Early Submission Thu 2026-08-06 23:59: Test Cases trace links per fixture (FG-22 / TRO-340),
  remaining PR-G slices, PRESEARCH.MD Phases 2–3 sections.

## Open questions

- `TRO-342` (shared read-path token), `TRO-343` (React Query cache leak), `TRO-344`
  (circular-blocks error precision) — 342 matters before design grading.
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
