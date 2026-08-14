# Database Query Efficiency — Compare (w6-r10-aug14)

**Category** `db-query` · **Commit** `397e3b7` (main) · **Date** 2026-08-14 · **Baseline** `../baseline.json` (commit `076a183`, 2026-07-27)
**Requirement under test:** PLUGFORGE.MD §6 / W6-R10 — per-route query counts within +10% of the Part 1 baseline, for existing `/api/*` routes.

Run strictly after `api-perf-audit`'s compare pass (`audit/api-perf/compare-w6-r10-aug14/`), never concurrently, per this repo's `ship-factory` lessons rule 15.

---

## Methodology

**Environment.** Same hardware as baseline. **Postgres version differs**: baseline used a dedicated `postgres:15-alpine` container that no longer exists; this run used the shared local `postgres:16.14` container (`ship-postgres-1`, `:5433`) that also hosts ~40 other worktree databases for concurrent sibling-agent activity. Baseline itself flagged this as a version-skew risk for EXPLAIN comparisons — carried forward here, though this pass does not lean on EXPLAIN plans (see below).

**Statement logging scoped per-database, not system-wide.** Baseline used `ALTER SYSTEM SET log_statement='all'` because it had an isolated, single-purpose container. This container is shared, so system-wide logging would have captured every other worktree's unrelated traffic (degrading their performance and polluting this capture). Used `ALTER DATABASE ship_standup SET log_statement='all'` / `log_min_duration_statement=0` instead — scoped to only this database's sessions. The API server was restarted after the `ALTER DATABASE` call (existing pooled connections predate a per-database setting change and don't pick it up) and restarted again afterward once the setting was reverted (`ALTER DATABASE ... RESET`, confirmed empty in `pg_db_role_setting`).

**Data volume.** 500 documents / 20 users / 818 associations — matches baseline's 500/20/813 closely (reused from the same seeded database the api-perf-audit compare pass just set up).

**Capture method — endpoint isolation, not full user-flow walk.** Baseline used two methods: a Playwright browser-flow walk (6 flows) and a curl-based per-`keyEndpoint` isolation pass (3 iterations each, `DBAUDIT_MARK` markers). This pass reproduces only the second: the 6 `keyEndpoints` from `audit/shipshape.config.yaml`, 3 iterations each, one authenticated session, bracketed by the identical marker convention and parsed with baseline's own `parse-log.mjs` (logic unmodified, only its two output paths repointed). The full 6-flow browser walk was **not** re-run — see "What was not measured."

**Query counts were stable across all 3 iterations** for every endpoint (e.g. documents-wiki: 3, 3, 3; team-assignments: 5, 5, 5) — no first-hit/cache variance, unlike baseline's browser-flow captures which saw cold/warm drift from the frontend's client cache. This is expected: curl-driven isolated endpoint hits have no client-side cache to warm.

**Background load.** The sibling e2e-test-runner/bundle-audit load that affected the preceding api-perf-audit pass had subsided by the time this capture ran (host load average ~3.3–4 throughout, matching baseline's reported range). Query *counts* are not sensitive to CPU contention the way latency is — a route either issues N queries or it doesn't, regardless of how fast the machine is — so this pass carries much less of that risk than the latency pass did. Included for completeness per the task brief's instruction to note load conditions either way.

**Full test suite:** not run, for the same reason noted in the api-perf-audit compare report — this is a risk assessment of already-merged code, not verification of an in-progress fix, and `pnpm test` would truncate the seeded database. Scope decision, not an oversight.

---

## Deliverable table — per confirmed keyEndpoint (isolated, steady state, 3 iterations)

| Endpoint | Queries (compare) | Queries (baseline) | Δ | of which auth | Slowest (ms) |
|---|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 3 | 4 | **−25.0%** | 2 | 0.455–0.702 |
| `GET /api/issues` | 4 | 5 | **−20.0%** | 2 | 0.670–1.480 |
| `GET /api/documents` | 3 | 4 | **−25.0%** | 2 | 0.356–0.402 |
| `GET /api/documents/:id` | 3 | 4 | **−25.0%** | 2 | 0.027–0.067 |
| `GET /api/team/assignments` | 5 | 6 | **−16.7%** | 2 | 0.419–0.539 |
| `GET /api/weeks` | 4 | 5 | **−20.0%** | 2 | 0.289–0.593 |

Every endpoint is **under** baseline, not over — trivially within the +10% budget. No `errors`/non-200s across all 18 captured requests.

### `/api/v1/health` — new tonight, no baseline entry to compare against

**0 database queries.** It is a hard-coded `res.status(200).json({status:'ok'})` handler behind `requestIdMiddleware` + `errorMiddleware`/`notFoundHandler` — none of which touch the database. Reported as new/no-baseline per the task brief, not compared. The other `/api/v1` resources (`documents`, `issues`, `sprints`, `me`) require bearer-token auth and were not measured in this pass (no baseline value exists for them either way).

---

## Reading the numbers — why every count dropped by exactly 1

**Traced, not assumed.** Baseline's own top finding (`baseline.md`, Top-5 slowest statements, #1) was `UPDATE sessions SET last_activity = $1 WHERE id = $2`, present on **every** read request, 4.764ms worst case, flagged for row-lock/WAL contention. `grep -c 'UPDATE sessions' compare-w6-r10-aug14/raw/pg-statements.log` on this run's capture returns **0** — across all 18 requests. Reading `api/src/middleware/auth.ts:325-358` explains why: the write is now throttled, guarded by `AND last_activity < $3`, and documented at line 96 as "how often an authenticated request is allowed to rewrite `sessions.last_activity`." All 18 requests in this capture came from one session, freshly logged in, all within the same throttle window — so the write correctly fires at most once and never inside this capture window.

**With that one query subtracted, every endpoint's data-query count is byte-identical to baseline:** documents-wiki=1, issues=2, documents-all=1, documents-byid=1, team-assignments=3, weeks=2 — same as baseline's own auth-excluded breakdown, endpoint for endpoint. This is a clean, complete match, not an approximation.

**This throttle fix is not one of tonight's 6 W6 tickets.** Those are OAuth/`/api/v1` scoped (PF-1xx/2xx/4xx per commit history); the session-write throttle is a separate, pre-existing improvement that happens to also reduce the measured counts here. It should not be credited to tonight's middleware, any more than gzip compression (noted in the sibling api-perf-audit report) should be.

**Why zero query-count impact from tonight's middleware was the expected outcome, not a lucky result.** None of the three pieces this task named do any database I/O:
- `request_id` generation is `crypto.randomUUID()` — in-memory, no DB.
- The public CORS policy for `/api/v1`/`/oauth` sets response headers — no DB.
- The rate-limiter exemption predicate (`isLegacyLimiterExemptPath`, `api/src/middleware/rate-limit.ts:212`) is `path === '/v1' || path.startsWith('/v1/')` — an in-memory string comparison, no DB. (The rate limiters themselves use an in-memory/Redis store per `redis-rate-limit-store.ts`, not Postgres.)

Given that, the data-query counts matching baseline exactly is exactly what should be expected on priors, and the measurement confirms it rather than merely being consistent with it.

## What was not measured

- The 6 full user-flow captures (Load main page, View a document, List issues, Load sprint board, Load week dashboard, Search content) — only the 6 isolated `keyEndpoint` hits were reproduced. A flow-level regression that only manifests through a different call sequence (e.g. a new query fired only when a `/api/v1` OAuth check runs mid-flow) would not be caught by this pass. Given none of the three in-scope middleware pieces touch the database (see above), this is considered low-risk to have skipped, but is named explicitly per this repo's provenance discipline rather than left implicit.
- EXPLAIN ANALYZE / index-plan comparison — not repeated. The query *counts* matching baseline exactly, combined with none of the three middleware pieces performing DB I/O, made a plan-level re-analysis unnecessary for answering the specific W6-R10 question (counts, not plan shape). The baseline's existing missing-index findings (DB-4, DB-9, etc.) are untouched by tonight's tickets and remain exactly as documented in `baseline.md`.
- Bearer-token-authenticated `/api/v1` resources — same reasoning as the api-perf-audit report; no baseline value exists for them.

## Verdict — is the +10% query-count budget being met?

**Yes, for every existing `/api/*` route this repo has a baseline to compare against.** All six measured endpoints show query counts at or below baseline (−16.7% to −25.0%), and the underlying data-query counts (auth toll excluded) match baseline exactly, one for one. No route shows any increase, let alone one exceeding +10%. The measured decrease is attributable to a pre-existing session-write throttle fix, not to tonight's 6 W6 tickets, whose three named middleware pieces are confirmed — by source reading and by the exact count match — to perform no database I/O at all.

`/api/v1/health` (0 queries) is reported as new/no-baseline, consistent with the task brief; it carries no risk under this gate because the gate is defined relative to a Part 1 baseline it postdates.
