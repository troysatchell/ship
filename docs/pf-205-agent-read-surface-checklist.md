# PF-205 checklist — the agent's 10 reads mapped to `/api/v1`

**Linear:** TRO-414. **PRD:** `PLUGFORGE.MD` §4, PF-205. **AC:** "a committed checklist mapping all
10 agent reads → v1 calls; every new route passes PF-203's fitness walk."

The agent's 10 read calls live in `agent/src/shipClient.ts:360-455`. Before this ticket, they hit 2
of the resources `/api/v1` had specced (`documents`, `issues` — both read-only, internal routes
still). This table is the mapping the AC asks for — the `sdkMode` switch PF-702 needs later reads
straight off this table, not off `agent/src/shipClient.ts`'s internal-route URLs.

| # | Agent method (`shipClient.ts`) | Internal route it calls today | New `/api/v1` call | Scope |
|---|---|---|---|---|
| 1 | `getChangeFeed()` (:360-367) | `GET /api/change-feed` | `GET /api/v1/changes?since=&limit=` | `documents:read` |
| 2 | `getDocument()` (:369-371) | `GET /api/documents/:id` | `GET /api/v1/documents/:id` *(already existed — PF-200)* | `documents:read` |
| 3 | `getPeople()` (:373-375) | `GET /api/team/people` | `GET /api/v1/people` | `documents:read` |
| 4 | `getAssociations()` (:381-387) | `GET /api/documents/:id/associations` | `GET /api/v1/documents/:id/associations` | `documents:read` |
| 5 | `getReverseAssociations()` (:392-398) | `GET /api/documents/:id/reverse-associations` | `GET /api/v1/documents/:id/reverse-associations` | `documents:read` |
| 6 | `getBacklinks()` (:403-405) | `GET /api/documents/:id/backlinks` | `GET /api/v1/documents/:id/backlinks` | `documents:read` |
| 7 | `getComments()` (:411-413) | `GET /api/documents/:id/comments` | `GET /api/v1/documents/:id/comments` | `documents:read` |
| 8 | `getIssuesByAssignee()` (:419-426) | `GET /api/issues?assignee_id=` | `GET /api/v1/issues?assignee_id=&limit=` | `issues:read` |
| 9 | `listDocuments()` (:438-445) | `GET /api/documents?type=` | `GET /api/v1/documents?type=&limit=` *(already existed — PF-200, `documents.ts:81` / `:169-172`)* | `documents:read` |
| 10 | `getWeekDates()` (:453-455) | `GET /api/weeks/:id` (narrowed to `workspace_sprint_start_date`) | `GET /api/v1/sprints/:id` — extended with `sprint_number`/`owner_id`/`status`/`workspace_sprint_start_date`/`start_date`/`end_date` | `sprints:read` |

All 10 under existing **read** scopes — no `people:read` split. `documents:read`'s own registered
description ("wiki/issue/project/program/sprint/person content and properties",
`api/src/platform/scopes/registry.ts:58-60`) already covers person documents; no evidence of a
consent-UX requirement was found anywhere in this repo (`PLUGFORGE.MD`, `docs/`,
`shared/src/types`) that would justify inventing a separate scope, per the ticket's own instruction
not to do so speculatively.

## Claim-provenance corrections against the PRD block's literal wording

Two of the PRD's six bullet points describe the ticket's starting state inaccurately — checked
against the actual code before writing this, not assumed from the PRD's prose (CLAUDE.md's
claim-provenance rule):

- **`?type=` on `GET /api/v1/documents`** — the PRD block says "PF-200 needs it anyway" as though
  it were missing. It was not: `ListDocumentsQuerySchema.type` and the `WHERE document_type = $n`
  branch were both present in PF-200's *original* commit (`31684d3`), and `documents.test.ts`
  already carried a passing test for it, headed *"architect note — PF-205 needs it too"*. This
  ticket made no code change here — verified, not assumed.
- **Sprint cadence "already exists" on `GET /api/v1/sprints/:id`** — `sprintsRouter`
  (`api/src/platform/api/v1/resources/sprints.ts`) registered only `GET /` before this ticket; no
  `:id` route existed at all. Built fresh in this diff, then extended with the cadence/week-dates
  fields the PRD block asks for — the same net result the PRD describes, from a different starting
  point than its wording implied.

## New endpoints added by this ticket

- `GET /api/v1/changes` (`platform/api/v1/resources/changes.ts`) — the public change-feed contract,
  mirroring `api/src/routes/change-feed.ts`'s cursor-lag semantics (never advances the cursor past
  `now - 5s`) without importing from it (the `platform/api/v1/**` → `api/src/routes/**` one-way
  boundary ban). Merges the internal route's three parallel arrays
  (`documents`/`document_history`/`comments`) into one `data` array tagged by a `resource`
  discriminator, so PF-203's fitness check (d) — every GET collection route needs a
  `{ data: [...], next_cursor }` response shape — is genuinely satisfied, not faked with an empty
  `data: []` alongside the real payload elsewhere.
- `GET /api/v1/people` (`platform/api/v1/resources/people.ts`) — a typed view over
  `documents WHERE document_type = 'person'`, same pattern as `resources/issues.ts` lifting
  `state`/`priority`/`assignee_id`.
- `GET /api/v1/documents/:id/associations` / `/reverse-associations` / `/backlinks` / `/comments`
  (added to `platform/api/v1/resources/documents.ts`) — cursor-paginated. The two association routes
  deliberately omit the joined related document's title/type (unlike the internal route), per
  `shipClient.ts`'s own `AssociationForwardEdge` docstring explaining why that join is a visibility
  leak on the internal route; this is a *new public* endpoint, so it must not reintroduce it.
- `?assignee_id=` on `GET /api/v1/issues` (`platform/api/v1/resources/issues.ts`).
- `GET /api/v1/sprints/:id` (`platform/api/v1/resources/sprints.ts`) — extends the existing
  `serializeSprint()` envelope with `sprint_number`/`owner_id`/`status` (lifted from `properties`)
  and `workspace_sprint_start_date`/`start_date`/`end_date` (computed from the workspace's
  sprint-cadence anchor + this sprint's own `sprint_number`, duplicating `routes/weeks.ts`'s /
  `routes/team.ts`'s existing day-math rather than importing it, for the same boundary reason as
  `/changes`).

Every route above: OpenAPI-registered (`platform/openapi/schemas/{documents,people,changes,sprints}.ts`),
scoped via `requireScope(...)`, fails in the `ApiError` shape, and cursor-paginated where it is a
list. `api/src/platform/api/v1/__tests__/route-fitness.test.ts` walks the live router and asserts
all four mechanically for every route it discovers, including these — 101/101 passing after this
ticket (was 77/77 before; 6 new routes × ~4 checks each, one route (`GET /people`) plus `GET
/changes` counted once more for the pagination check that only applies to non-`{param}` GETs).

## The SDK consequence (PF-405's parity gate)

The PRD block's own sentence — "PF-405's parity gate forces the matching SDK methods" — is literal,
not rhetorical: `sdk/src/__tests__/parity.test.ts` (already merged, from PF-405) walks the real,
generated `/api/v1` OpenAPI document and fails on any operation with no corresponding typed
`@ship/sdk` method. Every one of the 7 new operations above tripped it. Closed in the same PR:

- `DocumentsClient.getAssociations/getReverseAssociations/getBacklinks/getComments`
- `SprintsClient.get`
- new `PeopleClient` (`.people.list`/`.people.iterate`) and `ChangesClient` (`.changes.list` —
  deliberately no `iterate()`; see `sdk/src/resources/changes.ts`'s header for why this resource's
  `since`/`next_cursor` shape doesn't fit the shared `iteratePages()` helper)

`parity.test.ts` is 49/49 passing after this ticket (was 41/41 before). Request-shape tests for all
seven new SDK methods: `sdk/src/resources/__tests__/pf205.test.ts` (mocked `fetch` — the real
server-side behavior is already covered by this ticket's api-side tests, so this file proves the
SDK's request/response wiring, not a duplicate of server coverage).

## Not verified / deliberate scope decisions

- **Visibility filtering.** Every existing v1 list route (`documents.ts`, `issues.ts`, `sprints.ts`)
  scopes only by `workspace_id` (+ `deleted_at IS NULL`), not by the internal API's
  `getVisibilityContext`/`VISIBILITY_FILTER_SQL` per-user visibility. The four new
  `documents.ts` sub-resources and `/changes` follow that same, already-established precedent for
  consistency rather than introducing per-resource inconsistency — this is a pre-existing gap in the
  v1 surface as a whole, not something newly introduced by this ticket, and is called out explicitly
  here because a bearer-token `Principal` may be a Client Credentials app token with no `user` at
  all, so there is no direct analogue to port forward even if this ticket wanted to.
