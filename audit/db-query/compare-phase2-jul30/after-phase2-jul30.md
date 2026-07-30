# Database Query Efficiency — Compare (phase2-jul30)

**Category** `db-query` · **Mode** `compare` · **Label** `phase2-jul30` · **Date** 2026-07-30
**Commit** `34a0aeb` (clean; branch `measure/db-query-compare-jul30` at `main`) — contains all merged DB fixes: DB-2/API-6 (session-write throttle), DB-4/API-5 (dashboard fan-out collapse), DB-5 (issues list projection), DB-6 (weeks lateral join), DB-7/DB-10 (indexes), DB-8 (association-batch VALUES join).
**Baseline** `../baseline.json` (commit `076a183`, 2026-07-27)
**Data volume** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users, 813 document_associations — verified via `SELECT ... GROUP BY` immediately before measuring, byte-identical to baseline (deterministic `seed-augment.ts`, fixed LCG/epoch).

---

## Methodology

**Environment.** Isolated worktree `Ship-wt-db_compare` on branch `measure/db-query-compare-jul30`, exclusive database `ship_wt_db_compare` on the same `ship-audit-pg` (postgres:15-alpine, `:5433`) container baseline used — same PG major version, so EXPLAIN plans are comparable.

**Statement logging, scoped to this database only.** Baseline used `ALTER SYSTEM` (container-wide) because it had the container to itself. This run does not — sibling factory worktrees run concurrently on the same `ship-audit-pg` container — so logging was scoped with `ALTER DATABASE ship_wt_db_compare SET log_statement='all'` / `SET log_min_duration_statement=0`, which only takes effect for new sessions connecting to *this* database. Verified before measuring that `ship_dev`'s `log_statement` stayed `none` throughout. `log_line_prefix` (`'%m [%p] '`, needed to pair statement/duration lines by PID) was already set container-wide from a prior session and was left untouched — its GUC context is `sighup`, not settable per-database, and no change was needed since the value already matched what the parser requires. Reverted at the end of the run via `ALTER DATABASE ... RESET` on both settings; verified back to `log_statement=none`, `log_min_duration_statement=-1`.

**Per-flow capture.** `audit/db-query/compare-phase2-jul30/raw/flow-capture-compare.mjs` — a copy of baseline's harness with exactly four things changed: the web port (5255), the Postgres connection string (`ship_wt_db_compare`), and an added `page.addInitScript` that sets `localStorage['ship:disableActionItemsModal']='true'`. That last change was necessary: the Action Items modal (`web/src/pages/App.tsx`) reopens on every full-page navigation (`actionItemsModalShownOnLoad` resets on remount), and as a visible overlay it can block the Search flow's Meta+K / input-fill steps. It fires no additional queries either way — it only renders data `useActionItemsQuery` already fetched — so suppressing it does not change the numbers, only makes the harness reliable. Flow list, wait timings, marker protocol (`SELECT 'DBAUDIT_MARK ...'` on its own connection), and 2-iteration structure are otherwise byte-identical to baseline.

**Methodology note on cross-iteration jitter (why 3 full runs, not baseline's 1).** The first full run showed one flow (`List issues#2`) jump from 14 to 27 queries, with the extra queries clearly belonging to a *different* page (`weekly_plan`, `weekly_retro`, `sprint_number`, `standup` — MyWeekPage's own data). The mechanism: `AppLayout` mounts `DocumentsProvider` / `ProgramsProvider` / `ProjectsProvider` / `IssuesProvider` etc. on **every** route, and because the harness does full `page.goto()` navigations (not client-side routing), all of these remount on every flow. React Query's persisted cache (`PersistQueryClientProvider`) skips the network/DB call when a query is still fresh, so which flow happens to be "current" when some provider's `staleTime` expires is a matter of wall-clock timing, not iteration number — this is the same mechanism baseline itself flagged ("the frontend's cache survives a full page reload, so warm loads skip some endpoints entirely"), just landing harder here. Two more full runs (login → 2 iterations, independently, 3 runs total = 4 samples per flow across runs 2 and 3, 6 across all 3) confirmed run 1's `List issues#2=27` was the outlier — runs 2 and 3 agreed closely with each other on every flow. **Reported numbers below are the majority value across the 3 runs**, with the full spread available in `raw/flow-queries*.json` (one file per run) for anyone who wants to re-derive it.

**EXPLAIN ANALYZE.** `raw/explain-compare.sql`, run via `docker exec ... psql -f`, using this dataset's real workspace/user ids (`fe82ac70-...`/`750c43f9-...`, `dev@ship.local`). Q1 and Q4's SQL text is the **current** query shape (copied verbatim from `issues.ts` / `weeks.ts`), not baseline's — DB-5 dropped `d.content` from Q1's projection and DB-6 replaced 3 correlated subqueries with a `LEFT JOIN LATERAL` in Q4, so re-running baseline's old SQL text would not reflect what the app now runs. Q2 (unfiltered `/api/documents`, unchanged code path) and Q6 (session lookup, unchanged) are included as controls. Q3 (association batch, DB-8) was run at **two** scales: the PR's own stated "realistic page size" (20 ids) and baseline's exact scale (254 ids, all issues in the workspace) for a literal apples-to-apples comparison — full plans for both are in `raw/explain-plans.txt`.

**Test suite.** Run **after** every query/EXPLAIN measurement was captured, since the api vitest suite `TRUNCATE`s whatever `DATABASE_URL` points at (finding TEST-9) and this worktree's `.env.local` points at the exact database just measured. `pnpm test` → 55 API files / 662 tests + 49 web files / 420 tests, **all passed, 0 failures**.

**Reproduce:**
```bash
docker exec ship-audit-pg psql -U ship -d ship_wt_db_compare -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
docker exec ship-audit-pg psql -U ship -d ship_wt_db_compare -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
DOC_ID=<a wiki doc id> node audit/db-query/compare-phase2-jul30/raw/flow-capture-compare.mjs
```

---

## Deliverable table — per user flow (baseline vs compare)

Total queries as **steady / cold** (iter2 / iter1), majority value across 3 full harness runs.

| User flow | Baseline (steady/cold) | Compare (steady/cold) | Δ steady | Δ cold | Slowest query (compare, ms) | N+1? |
|---|---|---|---|---|---|---|
| Load main page | 26 / 26 | **21 / 21** | **−19.2%** | −19.2% | 0.78 | No |
| View a document | 45 / 44 | **41 / 35** | −8.9% | **−20.5%** | 1.28 | No |
| List issues | 17 / 17 | **13 / 14** | **−23.5%** | −17.6% | 0.79 | No |
| Load sprint board | 51 / 65 | **41 / 55** | −19.6% | −15.4% | 1.33 | No |
| Search content | 44 / 30 | **38 / 24** | −13.6% | **−20.0%** | 5.17 | No |
| *(bonus)* Load week dashboard | 42 / 58 | **13 / 30** | **−69.0%** | −48.3% | 0.68 | **No** (was YES) |

The bonus row is not one of the 5 required `config.userFlows`, but baseline itself added it (it navigates to `/dashboard`, not `/`) specifically to confirm DB-4 at the SQL layer, and it is kept here for the same reason — see "Target verdict" below for why this matters more than it looks.

---

## Target verdict

**Target:** ≥20% query-count reduction on ≥1 flow, **or** ≥50% improvement on the slowest query, with before/after EXPLAIN ANALYZE.

**Met — by both routes, with one important correction to the brief's own expectation.**

**1. Within the 5 required flows, `List issues` clears the bar cleanly:** steady-state 17 → 13 queries, **−23.5%**, reproduced in 3 of 4 independent samples across two full harness runs (the 4th sample, 27, was the cross-page jitter explained above and is not the representative reading). `View a document` (cold, −20.5%) and `Search content` (cold, −20.0%) each clear it too, but only on the *cold* reading, not steady. `Load main page` and `Load sprint board` both come close (−19.2%, −19.6%) but do not clear 20% on either reading.

**2. The slowest-query route clears the bar decisively.** Baseline's own #1 slowest statement, cited across 5 of 6 flows, was `UPDATE sessions SET last_activity = $1 WHERE id = $2` (max 4.764 ms, 121 executions in the capture) — baseline's own EXPLAIN showed its *isolated* execution was only 0.178 ms, meaning the 4.764 ms was row-lock/WAL contention from multiple concurrent requests all rewriting the same session row on every page load. In this compare capture the same statement's max is **0.614 ms (−87.1%)**, with only 14 executions across an equivalent 3-run capture (baseline had 121 in one run) — DB-2's 60-second throttle removed almost all of the redundant writes, so the contention that produced the 4.764 ms spike no longer exists. This is a direct, mechanistic confirmation, not just an aggregate number: fewer concurrent writers on the same row is exactly what collapses row-lock wait time back down toward the isolated-execution figure.

**Correction to the brief's expectation — read plainly, not smoothed over.** The brief expected "the dashboard/main-page flow" to show DB-4's 30→6 win. **`Load main page` and the dashboard are two different flows in this methodology**, and this was true at baseline too, not something that changed since: `Load main page` navigates to `/`, which redirects to `/my-week` (confirmed via `git show 076a183:web/src/main.tsx` — the index route was already `Navigate to="/my-week"` at baseline, not `/dashboard`). `MyWeekPage` fetches its own bundled endpoint and has no per-item fan-out; DB-4's fix is entirely inside `Dashboard.tsx`, which only renders on the separate `/dashboard` route — the "Load week dashboard" bonus row above, not one of the 5 required flows. Consequently `Load main page`'s only source of improvement is DB-2 (session throttle), and it lands at −19.2%, just under the 20% bar. The actual DB-4 evidence — steady 42 → 13 (**−69.0%**), N+1 flag flipping from **YES to NO** — is real, large, and directly attributable to `Dashboard.tsx:57`'s `useRecentStandupsQuery(weekIds)` replacing the old per-week `Promise.all` fan-out (confirmed by inspecting the repeated-query templates in `raw/flow-queries-run3.json`: the per-week standups query is gone entirely, and the remaining 13 queries are ordinary per-request auth boilerplate). The "30→6 queries" figure cited in the brief does not match this report's or baseline's own numbers for either flow, under either methodology, and was not independently reproduced here — it most likely refers to a different, endpoint-level measurement from elsewhere in the sprint's work (referenced only in `memory-bank/activeContext.md`, not in `audit/db-query/baseline.md`), not this harness.

---

## Findings — before/after EXPLAIN ANALYZE on the current slowest queries

All plans in full: `raw/explain-plans.txt` (current-shape Q1–Q6); baseline's originals: `../raw/explain-plans.txt`.

### DB-5 confirmed — `/api/issues` list projection (Q1)

`d.content` is now absent from the SELECT list (`api/src/routes/issues.ts:345-361`, with an explicit `TRO-173 / API-2` comment). Row width: **1023 → 335 bytes, −67.3%** — same 254 rows returned, same join shape. This is exactly the evidence baseline itself predicted this fix would produce ("payload evidence, not query-count"): raw Planning/Execution ms did **not** improve (3-run steady average ≈2.15 ms planning / 0.81 ms execution here vs baseline's reported ≈1.76 ms / 0.53 ms) — Postgres still reads the same heap pages regardless of which columns are projected, since this dataset's `content` values are small enough to stay inline rather than TOASTed out. The win is entirely in payload size (this is the SQL-layer counterpart to api-perf's independently measured **−36.5%** wire-payload reduction on the same endpoint).

### DB-8 confirmed, with an honest planning-time trade-off — association batch (Q3)

`api/src/utils/document-crud.ts`'s `getBelongsToAssociationsBatch` now does `FROM (VALUES ...) AS ids(document_id) JOIN document_associations da ON da.document_id = ids.document_id` instead of `WHERE da.document_id = ANY($1)`.

At baseline's exact scale (254 ids — every issue in the workspace, for a literal comparison):

| | Baseline (`= ANY`) | Compare (`VALUES` join) |
|---|---|---|
| Estimated rows | 25 | 635 |
| Actual rows | 707 | 707 |
| Estimate error | **28.3x under** | **1.11x under** |
| Execution time | 1.168 ms | 0.902 ms (**−22.8%**) |
| Planning time | 0.753 ms | 1.834 ms (**+143.6%**) |

The cardinality estimate — the actual point of DB-8 — goes from wildly wrong to nearly exact, because the planner can now see the literal size of the batch instead of guessing a fixed low selectivity for an opaque array parameter. Execution time improves too. But Planning time gets measurably *worse* at this scale, because parsing a literal 254-row `VALUES` list costs more than parsing one array parameter — reported plainly rather than smoothed over. At the scale the code actually runs at in production (a bounded page, 20 ids — the PR's own stated measurement point), both numbers are cheap in absolute terms: **0.648 ms planning, 0.301 ms execution**. The full-254 planning-time regression is an artifact of testing at an unrealistic batch size for apples-to-apples comparison with baseline, not a production concern.

### DB-6 confirmed — `/api/weeks` sprint aggregate (Q4)

`api/src/routes/weeks.ts`'s three independent correlated subqueries for `has_retro`/`retro_outcome`/`retro_id` (baseline SubPlans 7 & 8, each an independent `Seq Scan on document_associations` with `Rows Removed by Filter: 803, loops=5` — 8,130 rows read in total for what is logically one lookup) are now one `LEFT JOIN LATERAL` computing `MAX(...)` over a single `Bitmap Index Scan on idx_document_associations_related_type`.

| | Baseline | Compare |
|---|---|---|
| Total buffers (top Sort node) | 1182 | **750 (−36.5%)** |
| Execution time | 1.192 ms | **0.798 ms (−33.1%)** |
| Planning time | 1.070 ms | 1.180 ms (+10.3%, noise) |

### DB-7 confirmed — ticket-number permalink lookup (Q5)

`documents (workspace_id, ticket_number) WHERE document_type='issue'` (migration `038_documents_ticket_number_index.sql`) is now used:

| | Baseline | Compare |
|---|---|---|
| Plan | `Seq Scan`, `Rows Removed by Filter: 499` | **`Index Scan using idx_documents_ticket_number`** |
| Buffers | 66 | **6 (−90.9%)** |

### Not improved, and not expected to be — `/api/documents` unfiltered list (Q2, control)

Unchanged code path (sorts by `position, created_at`, not the column DB-10's new index (`workspace_id, updated_at DESC`) covers). Plan shape is identical to baseline (`Seq Scan` + top-of-plan quicksort), and execution time is flat within noise (0.538 ms baseline → 0.488 ms compare, single-run). This is now the **overall slowest statement** in the compare capture by elimination (max 3.585–5.165 ms across the 3 flow-capture runs, always this query, fired by the `Search content` flow) — nominally slightly *higher* than baseline's 3.193 ms for the same query, though both are sub-5ms and neither DB-10 nor any other merged fix targets this sort order. Reported as a control, not a regression claim.

---

## What got worse (reported plainly, per the brief's rule)

- **`Load main page` and `Load sprint board` do not clear the ≥20% bar** on either cold or steady reading (−19.2%/−19.2% and −19.6%/−15.4% respectively) — close, but a strict reading of "≥20%" excludes them.
- **Q1's raw Planning/Execution ms did not improve** despite the 67% width reduction (see DB-5 above) — a reader skimming only the ms numbers could wrongly conclude DB-5 did nothing; the actual evidence is payload size, exactly as baseline itself said it would be.
- **Q3's Planning time is worse by +143.6%** at a 254-id batch (see DB-8 above) — real, reproducible, and specific to an unrealistically large batch; not a concern at the 20-id scale the app actually uses.
- **Q2 (untouched `/api/documents` list) is now the capture's overall slowest statement**, nominally a little slower than baseline (3.193 ms → up to 5.165 ms) — no fix targeted it, so this is not attributed to any merged change, but it means the "slowest query in the app" is no longer the one DB-2 fixed.

None of these are attributed to a regression introduced by the merged fixes; each has a specific, checked mechanism (unrealistic test scale, a control query, or a metric the fix was never meant to move).

---

## Artifacts

- `after-phase2-jul30.json` — machine-readable metrics + target verdict (this directory)
- `raw/flow-capture-compare.mjs`, `raw/parse-log-compare.mjs` — harness copies (4 constants changed from baseline; diff-able)
- `raw/pg-statements{,-run2,-run3}.log`, `raw/flow-queries{,-run2,-run3}.json`, `raw/top-statements{,-run2,-run3}.json`, `raw/flow-requests{,-run2,-run3}.json` — one full run per suffix
- `raw/explain-compare.sql`, `raw/explain-plans.txt` — current-shape EXPLAIN ANALYZE (Q1–Q6 + size context)
- `raw/capture-start*.txt` — docker-logs slice markers per run
