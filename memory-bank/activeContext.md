# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-08-03. Focus is now **Week 5 — FleetGraph** (project intelligence agent for Ship). Week 4 items moved to progress.md.

## Where we are

**FleetGraph is fully ticketed and PM-reviewed; nothing is built yet.** Linear project "FleetGraph — Week 5 Project Intelligence Agent" holds 7 PR-bundle epics (PR-A…PR-G, `TRO-325`–`TRO-331`) and 23 FG tickets (`TRO-312`–`TRO-324`, `TRO-332`–`TRO-341`). Phase 1 design is complete in `FLEETGRAPH.MD` + `PRESEARCH.MD`. A PM review this session (2026-08-03) verified every cited file:line against source — **all held** — then amended 4 tickets and created 1:

- `TRO-333`/FG-15 — **scope amendment supersedes its edit #2**: `blocks` must NOT enter `belongs_to` (the belongs_to queries in `document-crud.ts:131-146`/`:188-196` have no type filter; containment allowlist added to the spec).
- `TRO-331`/PR-G — ships as **three slices, one per gate** (G-MVP Tue · G-Early Thu · G-Final Sun); declared exception to one-bundle-one-PR.
- `TRO-327`/PR-C — branch **stacking authorized**: C starts on A+B branches, D on C; do not wait for merges.
- `TRO-332`/FG-14 — trigger cannot prove acyclicity under concurrent inserts; agent traversal keeps its own visited-set.
- `TRO-341`/FG-23 (**new**) — graded-environment topology + seeding was unowned; recommended Render Ship (`ship-rr6m.onrender.com`) + agent + seeded Render Postgres.

## Deadlines (from the brief)

**MVP Tue 2026-08-04 23:59** · Early Sub Thu 2026-08-06 23:59 · Final Sun 2026-08-09 12:00.
MVP critical path: **A ∥ B → C → D → G-MVP in ~26h** including two CodeRabbit reviews — stacking is what makes this feasible.

## Open questions

- **Model provider** (Anthropic API vs Bedrock) — owned by `TRO-313`, decide there, not silently.
- ~~Architecture Defense timing~~ — resolved 2026-08-03: **already held** (Troy). FG-4's live-demo clause is moot; noted on `TRO-315`.
- Week 4 final submission was due 2026-08-02 11:59 AM — outcome not recorded in the bank.

## Standing watch-outs

Check GitLab CI as well as GitHub (`glab ci status --branch main -R troysatchell/ship`). Backlog still holds `TRO-309` (CodeQL alerts, unread) and `TRO-310` (TEST-11 batch 2).
