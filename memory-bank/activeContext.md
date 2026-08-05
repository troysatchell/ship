# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-05 (~03:40Z, MVP deadline night). Focus is **Week 5 — FleetGraph**.

## Where we are

**MVP verification + remediation done (2026-08-05, see progress.md log).** FLEETGRAPH.MD passed a full
accuracy audit against the code (no more false "Pending"s), all 4 LangSmith trace links are public
share links, and — the real find — **both graded Render services were running pre-PR-C/PR-D builds
on deadline night**. Redeployed to `d124a50`, then found and fixed a second gap: PR-D's
`AGENT_INTERNAL_SECRET` + `AGENT_API_BASE_URL` existed nowhere. The grader's chat path
(login → `POST /api/agent/chat` → grounded cited answer) is now verified live on the graded deploy.

**Immediate:** FLEETGRAPH.MD + memory-bank changes were uncommitted at time of writing — commit+push
needed before the submission form. **Next:** Early Submission (Thu) — Test Cases trace links per
fixture (FG-22 / TRO-340), remaining PR-G slices; PRESEARCH.MD lacks the template's Phases 2–3 as
named sections (before-final item).

## Deadlines (from the brief)

MVP Tue 2026-08-04 23:59 (this night) · **Early Sub Thu 2026-08-06 23:59** · Final Sun 2026-08-09 12:00.

## Open questions

- `TRO-342` (shared read-path token vs per-user), `TRO-343` (React Query cache leak, repo-wide),
  `TRO-344` (circular-blocks error precision) — none blocked MVP; 342 matters before design grading.
- Week 4 final submission outcome — still not recorded in the bank.

## Standing watch-outs

- **`auto_deploy` on graded `ship`/`ship-agent` has now silently failed twice** (2026-08-04,
  2026-08-05 — 4 merges skipped the second time). After ANY merge the demo depends on: probe a route
  the merge added, or `last-modified` on `GET /`; remediation runbook in FLEETGRAPH.MD "Deployment
  model" (service ids + exact curl).
- **PR-D's env vars live ONLY in Render env config**, set 2026-08-05 via REST API:
  `AGENT_INTERNAL_SECRET` (both services; also at `~/.ship-agent-internal-secret`, mode 600) and
  `AGENT_API_BASE_URL` (ship). `terraform/render/*.tf` has zero references — a clean-machine
  `apply`/destroy-redeploy **will drop them and kill the chat/inbox path**. Untracked follow-up:
  add to terraform.
- **`terraform apply` cannot update `render_web_service.agent` at all on the free tier** (provider
  bug) — use the Render REST API for any agent-service change.
- Check GitLab CI as well as GitHub (`glab ci status --branch main -R troysatchell/ship`). Backlog
  still holds `TRO-309` (CodeQL alerts, unread) and `TRO-310` (TEST-11 batch 2).
