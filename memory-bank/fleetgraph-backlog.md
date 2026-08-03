# FleetGraph — Scoped, Not Built

*Week 5 work that is verified and ready to ticket. Nothing here is implemented. Each item lists
what was checked, so a PM/scoping agent does not have to re-derive it.*

**Last updated:** 2026-08-03. Source: Phase 1 presearch (`PRESEARCH.md`).

---

## 1. Add a `blocks` relationship to Ship — highest value, smallest change

**Why:** Ship cannot express "issue A blocks issue B." The `relationship_type` enum is only
`parent | project | sprint | program`, and `document_links` (backlinks) has 0 rows. This means
Ship has a containment tree and an org chart but **no dependency graph at all**.

That gap kills FleetGraph's strongest use case (tracing a blocker whose impact crosses reporting
lines — no Ship view can show it today). It also limits Ship itself as a product. Decision made
2026-08-03: build the missing relationship rather than design around it.

**Verified scope — the association infrastructure already does everything except know the word:**

| What | Where | Note |
|---|---|---|
| Enum definition | `api/src/db/schema.sql` | `CREATE TYPE relationship_type AS ENUM (...)` |
| Migration precedent | `api/src/db/migrations/017_standup_sprint_review_types.sql` | Exact copy-paste pattern: `DO $$ BEGIN ALTER TYPE ... ADD VALUE IF NOT EXISTS ...; EXCEPTION WHEN duplicate_object THEN null; END $$;` |
| Hardcoded type list #1 | `shared/src/types/document.ts:7` | `BelongsToType` union |
| Hardcoded type list #2 | `api/src/routes/associations.ts:12` | zod `z.enum([...])` |
| Hardcoded type list #3 | `api/src/routes/associations.ts:33` | `validTypes` array |
| CRUD endpoints | `api/src/routes/associations.ts` | Already generic over relationship type — **no new endpoints needed** |

**Miss any of the three type lists and it fails at runtime, not compile time.**

**Directionality:** `document_associations` has `document_id` and `related_id`, so a single
`blocks` value is directional (`document_id` blocks `related_id`). "Blocked by" is a reverse
query. No second enum value needed.

**Blocker — cycle protection does not exist.** `prevent_circular_parent` guards `parent_id` on
`documents` only; it does not touch `document_associations`. A-blocks-B-blocks-A is insertable
today. Any graph traversal would loop. **This must land before agent code walks the graph.**
The existing `prevent_circular_parent` function already does a depth-capped walk and is a good
model to adapt.

**Also required:** OpenAPI registration for any `/api/*` surface change (CLAUDE.md rule).

**Suggested ticket split:**

1. Cycle-protection trigger on `document_associations` — blocks the rest
2. Migration + the three type-list edits + OpenAPI
3. Issue-page UI: "Blocks / Blocked by" in the properties sidebar

**Rough size:** items 1–2 are small. Item 3 is the bulk of it.

---

## 2. Add a change-feed endpoint to Ship's API — blocks FleetGraph's proactive mode

**Why:** There is no way to ask Ship what changed. Verified: zero occurrences of
`since` / `updated_since` / `modified_since` as a query param anywhere in `api/src/routes/` or
the OpenAPI schemas. `GET /api/documents` sorts by `position, created_at` — recently-updated
documents never surface at the head. Paging is offset-only, and a source comment states that
proper cursor paging is a known gap. The endpoints that do sort by `updated_at DESC` are
fixed-purpose (two dashboard widgets, search, one internal sprint lookup) and take no time filter.

An agent deployed separately cannot bypass this — Aurora sits in private subnets reachable only
from the EB security group.

**Decision recorded:** add the endpoint rather than move the agent inside the VPC. Keeping
permission enforcement inside Ship's API matters in a system carrying federal performance
ratings, and the index already exists.

**The index is already there:** `idx_documents_workspace_updated_at (workspace_id, updated_at DESC)`,
created by migration 039 — which exists *because* of Week 4 audit finding DB-10.

**Cursor safety gotcha:** a naive high-water mark on `updated_at` permanently misses rows whose
transaction commits after the cursor advanced past their timestamp. `document_history.id` is
`SERIAL` and has the same flaw (sequence values are assigned pre-commit). Needs a lag window plus
dedupe on `(id, updated_at)`. Do not ship the naive version.

---

## 3. Fixture work — two agent conditions have no reachable trigger state

The dev seed is a Week 4 load-testing fixture (built to "500+ documents, 100+ issues, 20+ users,
10+ sprints"). It never exercises three write paths, so two FleetGraph conditions cannot be
demonstrated:

| Field | State in seed | Blocks |
|---|---|---|
| `document_history` | 0 rows | Post-approval scope drift |
| `started_at` / `completed_at` | NULL on all 254 issues, incl. all 71 `done` | Structural stall detection |
| `plan_approval` | Never set on any of 35 weeks | Post-approval scope drift |

The code that writes all three exists and runs in normal use. Building these states is fixture
work, not research. The Week 5 brief explicitly asks for "the Ship state that should trigger the
agent," so constructing them is the assignment.

---

## 4. Resolved — the agent drafts, it does not grade

**Decided 2026-08-03.** Standup-quality policing is cut. The whole design was re-oriented from
detection to assistance after the observation that *people write "stuff" because writing it
properly is tedious, and enforcement does not fix tedium.*

Three changes, all now reflected in `PRESEARCH.md` and `FLEETGRAPH.md`:

1. **Every output is either an action a query proved, or a draft a human confirms.** The agent
   never leaves an opinion it expects someone to act on. "Your standup is thin" became "here is
   your standup, drafted from what actually moved."
2. **The current view seeds an on-demand question; it does not fence it.** The boundary is what
   the user can see (enforced by running under their own token), not what is on screen. The agent
   walks outward along associations, mentions and history, and names every document it pulled in.
3. **Mentions go into one ranked list, not individual pings.** What a person wants on arrival is
   everything that needs them in one place — an inbox, not a stream.

Consequence worth carrying forward: **drafting lowers the cost of being wrong**, which lets the
confidence bar come down, which lets the agent do more. The earlier precision obsession was
downstream of a bad output format rather than a real constraint.

Also note the production quality signal this unlocks, which detection never had: **how much of a
draft survives to the posted version.** Measurable with no labelling effort.

---

## Data caveat that applies to everything above

All counts come from the dev database (`ship_dev`: 523 documents, 254 issues, 20 users, 20
people, 35 weeks, weeks 11–17). It is a **load-testing fixture, not a behavioural corpus** —
weekly plans and retros are drawn from 11 fixed content pools, and `confidence` is computed from
how far in the past a week is plus random noise.

**Counts from it measure the fixture, not Ship's users.** Do not build a use-case justification
on incidence numbers from this database. Justify from the mechanism gap, which is provable from
source regardless of who wrote the documents.
