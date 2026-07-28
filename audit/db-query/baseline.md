## Database Query Efficiency — Baseline

**Category:** `db-query` · **Commit:** `076a183` (dirty: audit/, memory-bank/, .claude/, .gitignore only — no application source) · **Date:** 2026-07-27

**Environment:** Apple Mac16,7, 14 cores / 24 GB RAM (arm64) · Darwin 25.5.0 / macOS 26.5.1 · Node v23.2.0 · PostgreSQL **15.13**-alpine in Docker on `:5433`
**Data volume:** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users, 813 document_associations — verified immediately before and after the run.

> **Version-skew caveat.** `docker-compose.local.yml` declares `postgres:16`, but Docker Hub pulls are blocked in this environment and only `postgres:15-alpine` was cached. Every EXPLAIN plan and planner cost estimate below reflects **PG15**. A compare run must use the same major version or the plans are not comparable.

---

### Methodology

Every number below comes from one of four commands. Nothing is eyeballed.

**1. Statement logging (scaffolding — reverted at end of run)**

```bash
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_statement='all';"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_min_duration_statement=0;"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_line_prefix='%m [%p] ';"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "SELECT pg_reload_conf();"
# ... measure ...
# reverted with ALTER SYSTEM RESET on all three + pg_reload_conf()
# verified back to log_statement=none, log_min_duration_statement=-1
```

**2. Per-flow capture.** `audit/db-query/raw/flow-capture.mjs` drives headless Chromium (repo Playwright 1.57.0), logged in as `dev@ship.local`, and brackets each flow with a marker statement (`SELECT 'DBAUDIT_MARK START <flow> iter<n>'`) emitted on its own `pg` connection so the log can be sliced exactly. Each flow runs **twice**; the page is parked on `about:blank` for 2.5 s between flows so no stray requests bleed across a slice.

```bash
DOC_ID=d8a6222f-ebfd-4273-912e-95daf1c518f5 node audit/db-query/raw/flow-capture.mjs \
  > audit/db-query/raw/flow-requests.json
docker logs ship-audit-pg --since "$(cat audit/db-query/raw/capture-start.txt)" \
  > audit/db-query/raw/pg-statements.log
node audit/db-query/raw/parse-log.mjs audit/db-query/raw/pg-statements.log
```

`parse-log.mjs` folds multi-line log entries, counts `statement:` and `execute <unnamed>:` entries as queries (never the `parse`/`bind` protocol lines), pairs each with the following bare `duration:` line on the same PID, excludes the marker connection's own PIDs, and groups by statement template for N+1 detection. Templates are already normalised because the app uses parameterised SQL (`$1`, `$2`) throughout.

**3. Endpoint isolation.** The six now-CONFIRMED `keyEndpoints` were probed serially with a session-cookie `curl` jar, 3 iterations each, bracketed by the same markers — because the frontend's client cache means some endpoints never re-fire during a flow.

**4. EXPLAIN ANALYZE.** `audit/db-query/raw/explain.sql`, run via `docker exec ... psql -f`, using the exact parameter values Postgres logged (workspace `e8d25b0f…`, user `2a56903a…`, `isSuperAdmin = TRUE`). Full plans in `audit/db-query/raw/explain-plans.txt`.

**Raw artifacts:** `raw/pg-statements.log` (964 KB, 11 369 lines), `raw/flow-queries.json` (per-flow slices), `raw/flow-requests.json` (HTTP trace), `raw/top-statements.json`, `raw/explain-plans.txt`, plus the three harnesses.

**A note on the two iterations.** Iteration 1 is a cold client cache, iteration 2 warm. Unusually, iteration 2 is sometimes *lower* — the frontend's cache survives a full page reload, so warm loads skip some endpoints entirely. Per the skill's convention the steady-state (iter 2) figure is the headline, but the cold figure is the one a first-time visitor actually pays, so both are reported.

---

### Deliverable table — per user flow

| User flow | Total queries (steady / cold) | Slowest query (ms) | Slowest statement | Auth boilerplate | N+1 detected? |
|---|---|---|---|---|---|
| Load main page | 26 / 26 | 1.471 | `UPDATE sessions SET last_activity` | 18 (69%) | No |
| View a document | 45 / 44 | 1.994 | `UPDATE sessions SET last_activity` | 27 (60%) | No — but 3x duplicate `/backlinks` (DB-9) |
| List issues | 17 / 17 | 1.183 | `UPDATE sessions SET last_activity` | 16 (**94%**) | No |
| Load sprint board | 51 / 65 | **4.764** | `UPDATE sessions SET last_activity` | 34 (67%) | No — but 2x duplicates on 3 endpoints (DB-9) |
| Load week dashboard | 42 / 58 | 4.133 | `UPDATE sessions SET last_activity` | 31 (74%) | **YES** — 5 weeks x 5 queries (DB-4) |
| Search content | 44 / 30 | 3.193 | `SELECT … FROM documents WHERE workspace_id …` | 23 (52%) | No |

The single most important column is the last-but-one. **In five of six flows the slowest statement is not a query at all — it is the auth middleware's session write**, and between 52% and 94% of every flow's queries are session/membership boilerplate rather than application data.

`Load week dashboard` is not in `config.userFlows`; it was added to capture at the SQL layer the `/api/weeks` → per-week standups fan-out that api-perf flagged as suspected N+1 (**API-4**). It is now confirmed.

### Deliverable table — per confirmed keyEndpoint (isolated, steady state)

| Endpoint | Queries | of which auth | Slowest (ms) | Response bytes |
|---|---|---|---|---|
| `GET /api/issues` | 5 | 3 | 2.782 | 379 907 |
| `GET /api/documents` | 4 | 3 | 1.324 | 293 953 |
| `GET /api/documents?type=wiki` | 4 | 3 | 0.268 | 37 930 |
| `GET /api/documents/:id` | 4 | 3 | 0.077 | 4 091 |
| `GET /api/team/assignments` | 6 | 3 | 0.655 | 22 655 |
| `GET /api/weeks` | 5 | 3 | 0.713 | 4 351 |

Payload sizes reproduce api-perf's trace byte-for-byte, confirming both audits measured the same dataset. Note that **no endpoint runs more than 3 data queries** — the query layer batches associations correctly with `= ANY($1)`. The inefficiency is not in how many data queries the app runs; it is in the fixed 3-query auth toll, in planning overhead, and in how much each query drags back.

### Top-5 slowest statements

| # | Statement | Max ms observed | n in capture | Plan red flag |
|---|---|---|---|---|
| 1 | `UPDATE sessions SET last_activity = $1 WHERE id = $2` | **4.764** | 121 | Isolated exec is only 0.178 ms — the in-flight cost is row-lock + WAL contention. `Buffers: shared hit=11 dirtied=1` **on every read request** |
| 2 | `SELECT … FROM documents WHERE workspace_id … ORDER BY position, created_at` (`/api/documents`) | 3.193 | 5 | Seq Scan 500 rows; top-of-plan quicksort, 190 kB |
| 3 | `SELECT d.id … d.content … FROM documents d LEFT JOIN users … LEFT JOIN documents person_doc …` (`/api/issues`) | 2.782 | 3 | **Planning 1.543 ms vs Execution 0.494 ms (3.1x)**; Seq Scan 500 rows → 254; `width=1023` because of `d.content` |
| 4 | `SELECT da.document_id … WHERE da.document_id = ANY($1)` (issue associations) | 1.206 | 3 | **rows=25 estimated vs 707 actual (28x under)**; index `idx_document_associations_document_id` unused |
| 5 | `SELECT d.id … (8 correlated subqueries) … WHERE d.document_type = 'sprint'` (`/api/weeks`) | 0.944 | 4 | 8 SubPlans x loops=5; SubPlans 7 & 8 **Seq Scan document_associations, Rows Removed by Filter: 803, loops=5**; 1182 buffers for 5 rows |

**Aggregate planning tax across the whole capture:** 622 parse entries (91.5 ms) + 622 bind entries (169.5 ms) = 261.0 ms, against 684 execute entries totalling 167.2 ms. **61.0% of all database time was spent planning queries, not running them.** Every entry is logged as `parse <unnamed>` / `bind <unnamed>` — no plan is ever reused.

### Missing-index candidates

| Column set | Evidence | Verdict |
|---|---|---|
| `documents (workspace_id, ticket_number) WHERE document_type='issue'` | `issues.ts:371`; EXPLAIN → `Seq Scan … Rows Removed by Filter: 499`, 66 buffers to return 1 row | **Add** (DB-7) |
| `documents (workspace_id, updated_at DESC)` | `ORDER BY … updated_at DESC` in 7 route modules; both list plans end in an unsupported quicksort | Add with pagination (DB-10) |
| `document_associations (document_id)` — exists but unused | `= ANY($1)` defeats the estimate (28x under), planner picks Seq Scan | Rewrite query, not add index (DB-8) |
| `documents (workspace_id, document_type) WHERE archived_at IS NULL AND deleted_at IS NULL` | `idx_documents_active` **already exists** and matches the hot predicate exactly; planner correctly prefers Seq Scan at 66 pages | No action — re-check above ~10k rows |
| `documents.created_by` | Repo-mapping lead said "missing"; in fact covered by `idx_documents_visibility_created_by (visibility, created_by)`, which is how the visibility filter uses it | **Lead corrected — no action** |
| GIN on `documents.properties` | `idx_documents_properties` exists; hot paths use `properties->>'x'` scalar extraction, which GIN cannot serve | Not a gap, but see DB-3 — no expression statistics means bad estimates |

`documents` carries **13 indexes** on a 920 kB / 500-row table. That is itself a cost: every plan must consider all of them, which is a direct contributor to DB-3.

---

### Findings

Ranked by measured impact. One Critical outranks the rest combined.

#### DB-1 — Critical — `pnpm db:migrate` silently skips 32 of 42 migrations and exits 0
`api/src/db/migrate.ts:103-111` · trigger: `migrations/010_oauth_state.sql:8` vs `schema.sql:90`

Handed over from the prerequisite gate and **independently reproduced here** on a throwaway database (`ship_migrate_repro`, created and dropped inside the audit container; the audited DB was re-verified at 500/20/813 afterwards):

```
Running migration: 010_oauth_state.sql
Database schema already exists, continuing...
EXIT CODE: 0
→ schema_migrations: 10 rows (001-009 + 007b), against 42 migration files
```

Running it a second time produced identical output and still 10 rows — it does not self-heal. `schema.sql:90` creates `oauth_state` with `IF NOT EXISTS`; `010_oauth_state.sql:8` then creates it *without*, throws `relation "oauth_state" already exists`, and the catch at `migrate.ts:106` matches **any** message containing `already exists`, logs "Database schema already exists, continuing…", and returns normally — abandoning the loop at `migrate.ts:69-95`.

The reason this has gone unnoticed is worth stating precisely, because it also bounds the blast radius. On a *fresh* database the result looks perfect: a column-level diff of the deploy-path DB against a fully-migrated DB found **163 identical columns and zero differences**, because `schema.sql` already carries the end-state schema. But `schema.sql` contains 17 `CREATE TABLE`, 59 `CREATE INDEX`, one function and one trigger — and **zero `ALTER TABLE` and zero DML**. The 31 unexecuted files contain **19 `ALTER TABLE` and 42 DML statements**. Those are the *only* mechanism by which an already-existing database is ever changed.

Migrations run automatically on deploy (per CLAUDE.md). So against real prod or shadow — the one case that isn't already at the end state — the deploy prints success, exits 0, and silently skips every schema alteration and every data backfill, including 027/029 (drop legacy association columns), 033 (sprint→week rename) and 014b/028/034 (backfills). This is a live data-integrity risk and it means the migration sequence is effectively untested. It is also a prerequisite for trusting the rest of this report: it determines whether the schema measured here is the schema production actually has.

#### DB-2 — High — every request writes to `sessions`; 52-94% of per-flow queries are auth boilerplate
`api/src/middleware/auth.ts:205-208`, `auth.ts:126-133`, `api/src/middleware/visibility.ts:7-11`

Every authenticated request runs three queries before touching application data: a session+user `SELECT`, a `SELECT role FROM workspace_memberships`, and an unconditional `UPDATE sessions SET last_activity`. That is 3 of the 4-6 queries on every isolated keyEndpoint, 16 of 17 queries on `List issues` (94%), and 34 of 51 on `Load sprint board`.

The `UPDATE` is the sharp edge. It ran 121 times during the capture and is the **slowest statement in five of the six flows** (peak 4.764 ms), even though EXPLAIN puts its isolated execution at 0.178 ms — the gap is row-lock and WAL contention, since a single page load fires 5-13 requests that all `UPDATE` the same one session row. Every read request dirties a buffer.

The fix is already written, three lines below the bug. `auth.ts:210-221` throttles the *cookie* refresh to once per 60 s with the comment "throttled to avoid overhead"; the same threshold was simply never applied to the database write.

#### DB-3 — High — 61% of all database time is planning, not execution
`api/src/db/client.ts` + all inline `pool.query(text, values)` call sites

Across the full capture: parse 91.5 ms + bind 169.5 ms = **261.0 ms**, versus execute **167.2 ms**. Every log entry is `parse <unnamed>` / `bind <unnamed>` — Postgres's marker for a plan it will throw away immediately. Confirmed independently on `/api/issues`, three consecutive steady-state runs:

```
Planning Time: 2.160 ms   Execution Time: 0.594 ms
Planning Time: 1.582 ms   Execution Time: 0.495 ms
Planning Time: 1.543 ms   Execution Time: 0.494 ms
```

The planner costs **3.1x the executor** and touches 674 buffers to execution's 78. node-postgres sends every query unnamed, so nothing is ever cached. The `documents` table amplifies it: 13 indexes to consider on every plan, plus JSONB expression predicates (`properties->>'priority'`, `properties->>'assignee_id'`) for which no expression statistics exist.

#### DB-4 — High — week dashboard N+1: one request per active week, 25 of the flow's 42 queries
`web/src/pages/Dashboard.tsx:69-85` (client fan-out) · handler `api/src/routes/weeks.ts:1833-1887`

`GET /api/weeks` returns 5 active weeks; `Dashboard.tsx:69` then maps them to one `fetch('/api/weeks/${sprint.id}/standups')` each inside a `Promise.all`. At the SQL layer that is 5x the sprint access check, 5x the standups `SELECT`, and 5x the DB-2 auth trio — **25 of the flow's 42 steady-state queries (60%)**.

The server handler is blameless: it already batches issue-link lookups (`batchLookupIssues`, `weeks.ts:1872`). The N+1 is entirely client-side, and the waste compounds — the per-week query at `weeks.ts:1856` has no `LIMIT` and returns each standup's full `content`, yet `Dashboard.tsx:92` immediately discards everything but the 10 most recent across all weeks. Cost grows linearly with active weeks: 5 today, +5 queries and +1 round trip for each new one.

This is the SQL-layer confirmation of api-perf's **API-4**, which flagged the same fan-out from the HTTP side. Cross-reference, not a duplicate.

#### DB-5 — Medium — `/api/issues` fetches every issue's full document body for a list view
`api/src/routes/issues.ts:126`

For the 254 live issue documents, `sum(pg_column_size(content))` = **158 kB — 64.5% of the total row bytes**. EXPLAIN shows the consequence in the plan: `width=1023` per row, against `width=300` for the `/api/documents` projection that omits `content`. All of it is forced through the sort node, serialised, and shipped; the list UI never renders it.

This is the SQL-layer confirmation of api-perf's **API-2** (380 KB unpaginated, 72.3% content), with on-disk byte figures. Cross-reference, not a duplicate. The list and detail views share a single SELECT projection; only the detail view needs the body.

#### DB-6 — Medium — `/api/weeks` aggregate: 8 correlated subplans per row, two seq-scanning per row
`api/src/routes/weeks.ts` · plan Q4 in `raw/explain-plans.txt`

Returns 5 rows, touches **1182 shared buffers** — 236 per row. Eight SubPlans each run with `loops=5`. SubPlans 7 and 8 (`retro_outcome`, `retro_id`) each do `Seq Scan on document_associations` with `Rows Removed by Filter: 803, loops=5` — reading all 813 association rows five times apiece, despite `idx_document_associations_related_type` being available and correctly chosen by SubPlans 2/3/4/6 for the identical predicate. SubPlans 7 and 8 differ only in which column they return from the same row, so that scan happens twice over.

An N+1 folded into one SQL statement. Execution is 1.192 ms today only because the table is 416 kB and fully cached; the plan shape is sprints x associations.

#### DB-7 — Medium — no index on `documents.ticket_number`
`api/src/routes/issues.ts:371`

```
Seq Scan on documents d
  Filter: ((ticket_number = 42) AND (workspace_id = …) AND (document_type = 'issue'))
  Rows Removed by Filter: 499
  Buffers: shared hit=66
```

500 rows examined to return 1, on the issue-permalink path. Cost grows with *total* document count, not issue count. Confirms the repo-mapping lead for `ticket_number`; the same lead's `created_by` claim is corrected above.

#### DB-8 — Medium — planner underestimates the association batch by 28x
`api/src/routes/issues.ts` association batch · plan Q3

`rows=25` estimated, `rows=707` actual, `Rows Removed by Filter: 106`, `idx_document_associations_document_id` unused. Postgres cannot see the cardinality of a parameterised array at plan time and guesses a fixed low selectivity. The batch itself is *correct design* — it is exactly what keeps `/api/issues` at 5 queries instead of 255 — but it is planned on a bad estimate that will keep selecting seq scans and nested loops as the table grows.

#### DB-9 — Medium — flows fire byte-identical requests two and three times
Sprint board and document view

Steady-state, from `raw/flow-requests.json`:

| Flow | Duplicated request | Times | Bytes each |
|---|---|---|---|
| Load sprint board | `GET /api/team/assignments` | 2x | 22 655 |
| Load sprint board | `GET /api/team/grid` | 2x | 5 948 |
| Load sprint board | `GET /api/team/projects` | 2x | 3 403 |
| View a document | `GET /api/documents/:id/backlinks` | 3x | 2 |

Each duplicate re-runs the endpoint's full query set *including* the DB-2 auth trio — which is how the sprint board reaches 51 queries. api-perf's independent trace shows the same doubling, so it reproduces across harnesses.

#### DB-10 — Low — no index on `documents.updated_at`
`ORDER BY … updated_at DESC` in `issues|documents|weeks|projects|programs|dashboard|search.ts`

Both list plans end in an unsupported top-of-plan quicksort (270 kB / 190 kB). Invisible at 500 rows. It matters when a sort spills to disk, or when these lists get the pagination api-perf recommended — at which point `(workspace_id, updated_at DESC)` is what makes `LIMIT` cheap.

---

### Recommended improvement plan

**Improvement target for this category:** ≥20% query-count reduction on at least one flow, **or** ≥50% improvement on the slowest query, with before/after EXPLAIN ANALYZE as evidence.

**Fix first, outside the target — DB-1.** It is Critical, it is a one-line correctness fix, and it decides whether the schema this audit measured matches production. Narrow the `already exists` catch to the `schema.sql` call at `migrate.ts:41` only, and let the migration loop fail loudly; then make `010_oauth_state.sql` idempotent (`CREATE TABLE IF NOT EXISTS`) and repair `025`, `035`, and `033` (which fails on `"sprint_plan" is not an existing enum label`). Evidence of the fix is `schema_migrations` reaching 42 rows on a fresh database, and a non-zero exit when a migration genuinely fails.

Then, in order of measured yield per unit of effort:

| Rank | Fix | Finding | Projected result | Clears target? |
|---|---|---|---|---|
| 1 | Batch the standups fan-out into one query for all active weeks, with `LIMIT 10` | DB-4 | Week dashboard **42 → ~22 queries (-48%)**, and constant rather than linear in active weeks | **Yes**, 2.4x the 20% bar |
| 2 | Gate the `last_activity` write on the 60 s threshold already used for the cookie | DB-2 | List issues **17 → 12 (-29%)**, sprint board **51 → 40 (-22%)**, week dashboard **42 → 32 (-24%)**; removes the slowest statement in 5 of 6 flows | **Yes**, on three flows |
| 3 | Name the hot prepared statements so Postgres caches their plans | DB-3 | `/api/issues` DB time **2.04 ms → ~0.49 ms (-76%)**; removes most of the 261 ms capture-wide planning tax | **Yes**, via the ≥50%-slowest-query route |
| 4 | Deduplicate the repeated client fetches | DB-9 | Sprint board **51 → ~40 (-22%)**, 32 KB less duplicated payload | **Yes** |
| 5 | Drop `d.content` from the `/api/issues` list projection | DB-5 | ~70% narrower sort rows, 158 kB less body text per request; pairs with api-perf **API-2** | Payload evidence, not query-count |
| 6 | Add `documents (workspace_id, ticket_number) WHERE document_type='issue'` | DB-7 | Permalink lookup: 500 rows examined → 1, 66 buffers → ~3 | Seq Scan → Index Scan |
| 7 | Collapse the 6 count-subqueries in `/api/weeks` into one grouped join; merge SubPlans 7/8 | DB-6 | ~1182 → low-hundreds buffers; removes 10 full scans of `document_associations` | Structural |
| 8 | Rewrite `= ANY($1)` as `JOIN unnest($1)`; add `(workspace_id, updated_at DESC)` with pagination | DB-8, DB-10 | Fixes the 28x misestimate; makes future `LIMIT` cheap | Preventative |

**Recommended first compare run: DB-4 + DB-2 together.** They are independent, they touch different layers (one React effect, one middleware line), and they compound on the same flow — `Load week dashboard` should fall from **42 to roughly 17 queries (-60%)**. Re-run `flow-capture.mjs` and `parse-log.mjs` unchanged against the same 500/20/813 dataset on PG15, and the delta table drops out of the same harness.

**Two cautions for whoever runs compare mode.** First, PG15 vs PG16 — matching the major version is not optional if the evidence is EXPLAIN plans. Second, and this is a genuine hazard rather than a nitpick: **do not run `pnpm test`** to validate these fixes as the conventions' identical-conditions rule would normally require. Finding **TEST-9** established that the api suite `TRUNCATE`s whatever `DATABASE_URL` points at, and it points at the seeded audit database. Validate against a separate throwaway database, or the baseline this report rests on is destroyed.
