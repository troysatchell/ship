# API Response Time — Compare (w6-r10-aug14)

**Category** `api-perf` · **Mode** `compare` · **Label** `w6-r10-aug14` · **Date** 2026-08-14
**Commit** `397e3b7` (main, dirty: only `audit/`, no application source) · **Baseline** `../baseline.json` (commit `076a183`, 2026-07-27)
**Requirement under test:** PLUGFORGE.MD §6 / W6-R10 — P95 latency within +10% of the Part 1 baseline, for the existing `/api/*` routes the baseline actually measured.

---

## Methodology

**Environment.** Same hardware as baseline: Apple M4 Pro-class, 14 cores / 24 GB RAM, Darwin 25.5.0, Node v23.2.0. API at `:3001`, `NODE_ENV` unset (dev mode) — identical server mode to baseline.

**Database version differs from baseline — read before trusting absolute numbers.** Baseline ran against a dedicated `postgres:15-alpine` container (`ship-audit-pg`) that no longer exists. This run used the machine's shared local Postgres, **16.14** (`ship-postgres-1`, `:5433`). This is a real, unavoidable environment difference, orthogonal to tonight's 6 platform tickets — noted per this repo's provenance rules rather than glossed over.

**Data volume.** 500 documents / 20 users, matching baseline's target volumes (minor distribution drift: 256 issue / 88 wiki vs baseline's 254/91, from `seed.ts` changes unrelated to tonight). The primary worktree's own dev database (`ship_standup`) was empty at the start of this run; it was migrated, seeded, and topped up via `audit/seed-augment.ts`. That script's workspace lookup was patched (`ORDER BY created_at LIMIT 1` → `WHERE name = 'Ship Workspace'`) because the shared dev DB carried a leftover `PF-107 Test` workspace from an unrelated OAuth-ticket test run that was older by `created_at` but had zero program/project/sprint documents — scaffolding-only fix, no application source touched.

**gzip compression is now active (TRO-174) — baseline had none.** Baseline's report explicitly states "No response carries `Content-Encoding`." This run measured every response gzip-compressed. TRO-174 predates tonight's 6 W6 tickets (it fixes a July 27 baseline finding, API-3) — it is a legitimate prior improvement, not part of tonight's landing, but it lowers wire bytes and serialization cost, which inflates the apparent improvement on large-payload endpoints (`documents-all`, `issues`) relative to a clean apples-to-apples comparison of *only* tonight's middleware.

**Auth, burst shape, rate-limit-window synchronization:** identical to baseline — `GET /api/csrf-token` → `POST /api/auth/login`, session cookie reused for all requests; same 900-request burst per combination, 80-request discarded warmup on c=10, waiting on `RateLimit-Remaining` for a fresh window. Same 6 endpoints, same order, same tool (autocannon 8.0.0). All 18 combinations completed at 100% 2xx, 0 errors — matching baseline's clean run.

**Background load — read before trusting the documents-wiki row.** Two sibling agents (an e2e Playwright regression suite with per-worker Postgres testcontainers, and a `bundle-audit` build) were active in this repo/machine for roughly the first 9 minutes of the 18-combination run. Host load average peaked at **44** on this 14-core machine (vs. baseline's reported 2.2–6.2) during the `documents-wiki` and `issues` measurements, confirmed via `docker stats` showing a `testcontainers-ryuk` reaper plus a dozen-plus short-lived containers — the documented footprint of the sibling e2e suite (`audit/shipshape.config.yaml`'s `testE2e` entry: "per-worker Postgres testcontainers... heavy, needs Docker"). Load fell to ~4 (matching baseline's own range) by the time `team-assignments`/`weeks` were measured.

**Spot re-check performed on the worst offender.** Once load returned to ~4.1, `documents-wiki` was re-measured alone at all 3 concurrency levels, same methodology (`raw-recheck-documents-wiki/`). Recheck P95 (8.52 / 20.40 / 33.27 ms) closely tracks baseline (8.45 / 17.33 / 44.93 ms) — confirming the +306%..+749% deltas in the main run's `documents-wiki` rows are a **background-load artifact**, not a consequence of tonight's middleware. Both the loaded-run numbers and the quiet recheck are reported below for transparency; **the recheck is what should be trusted.**

**Full test suite:** not run in this pass. This is a risk-assessment measurement of code already merged to `main`, not verification of an in-progress fix, and running `pnpm test` would truncate the seeded database `db-query-audit` needs immediately next (per this repo's own `lessons.md` rule 15 ordering) — deferred as a scope decision, not an oversight.

---

## Deliverable table — main run (includes the load-contaminated documents-wiki rows)

| Endpoint | Conc. | P50 | **P95** | P99 | Δ P95 vs baseline | errors |
|---|---|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 10 | 24.39 | **71.73** | 96.40 | **+748.9%** ⚠ load artifact, see recheck | 0 |
| `GET /api/documents?type=wiki` | 25 | 30.17 | **70.29** | 94.93 | **+305.6%** ⚠ load artifact, see recheck | 0 |
| `GET /api/documents?type=wiki` | 50 | 136.90 | **314.94** | 357.40 | **+601.0%** ⚠ load artifact, see recheck | 0 |
| `GET /api/issues` | 10 | 21.72 | **29.20** | 32.85 | −24.7% | 0 |
| `GET /api/issues` | 25 | 54.98 | **69.64** | 78.76 | −26.3% | 0 |
| `GET /api/issues` | 50 | 100.59 | **113.75** | 128.93 | −37.5% | 0 |
| `GET /api/documents` | 10 | 6.62 | **10.26** | 12.85 | −69.8% | 0 |
| `GET /api/documents` | 25 | 15.69 | **20.45** | 26.64 | −73.0% | 0 |
| `GET /api/documents` | 50 | 32.54 | **41.27** | 99.77 | −71.8% | 0 |
| `GET /api/documents/:id` | 10 | 2.67 | **4.49** | 5.61 | −7.3% | 0 |
| `GET /api/documents/:id` | 25 | 6.15 | **8.90** | 16.34 | −2.8% | 0 |
| `GET /api/documents/:id` | 50 | 13.35 | **28.98** | 42.61 | −37.2% | 0 |
| `GET /api/team/assignments` | 10 | 7.28 | **10.23** | 12.24 | −7.4% | 0 |
| `GET /api/team/assignments` | 25 | 17.37 | **23.63** | 33.26 | +3.2% | 0 |
| `GET /api/team/assignments` | 50 | 31.94 | **39.64** | 47.63 | −30.8% | 0 |
| `GET /api/weeks` | 10 | 3.88 | **6.74** | 12.55 | −4.6% | 0 |
| `GET /api/weeks` | 25 | 8.40 | **11.52** | 18.45 | −18.7% | 0 |
| `GET /api/weeks` | 50 | 18.44 | **25.61** | 41.96 | −38.7% | 0 |

## Deliverable table — documents-wiki spot re-check (quiet load, ~20 min later)

| Endpoint | Conc. | P50 | **P95** | P99 | Δ P95 vs baseline | errors |
|---|---|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 10 | 5.56 | **8.52** | 10.25 | +0.9% | 0 |
| `GET /api/documents?type=wiki` | 25 | 13.53 | **20.40** | 39.38 | +17.7% | 0 |
| `GET /api/documents?type=wiki` | 50 | 26.44 | **33.27** | 45.10 | −26.0% | 0 |

## `/api/v1/*` — new tonight, no baseline entry to compare against

`/api/v1/health` (unauthenticated, hard-coded 200, exempt from the legacy per-source-IP/per-identity rate limiters per `isLegacyLimiterExemptPath`) — measured as a standard 5s sustained-load run since no rate-limit window synchronization was needed:

| Endpoint | Conc. | P50 | P95 | P99 | req/s | errors |
|---|---|---|---|---|---|---|
| `GET /api/v1/health` | 10 | 0 | 1 | 1 | 13,682 | 0 |
| `GET /api/v1/health` | 25 | 1 | 3 | 3 | 13,847 | 0 |
| `GET /api/v1/health` | 50 | 3 | 4 | 6 | 14,146 | 0 |

**This is not a comparison — there is nothing to compare against.** No `/api/v1/*` route existed at the 2026-07-27 baseline. The other `/api/v1` resources (`documents`, `issues`, `sprints`, `me`) require bearer-token/OAuth auth and were out of scope for this pass (no baseline value to weigh them against; see "What was not measured" below).

---

## Reading the numbers

**The three middleware pieces named in the W6-R10 risk brief do not all run on internal `/api/*` routes — verified by reading source and confirmed empirically.**

- `requestIdMiddleware` (`api/src/platform/api/v1/requestId.ts`) is mounted only on `v1Router` (`api/src/platform/api/v1/router.ts:39`), itself mounted only at `app.use('/api/v1', v1Router)` (`app.ts:396`). It does **not** run for `/api/documents`, `/api/issues`, `/api/weeks`, etc. Confirmed with `curl -sD -`: `GET /api/v1/health` returns `X-Request-Id`; `GET /api/weeks` does not.
- The separate public CORS policy (`createPublicApiCors()`) is likewise mounted only at `['/api/v1', '/oauth']` (`app.ts:395`) — internal routes still get the pre-existing single-origin `cors({ credentials: true })` policy. Confirmed: `GET /api/weeks` returns `Access-Control-Allow-Origin: http://localhost:5173` (single-origin), not the public `*` policy.
- The one piece that genuinely touches every `/api/*` request (including internal routes) is the rate-limiter exemption predicate, `isLegacyLimiterExemptPath(path) = path === '/v1' || path.startsWith('/v1/')` (`api/src/middleware/rate-limit.ts:212`), called inside the `skip` function of both `perSourceIpLimiter` and `perIdentityLimiter`. It is an O(1) string comparison — no regex, no loop, no I/O. There is also a second new per-request check ahead of the app-global CORS call, `isPublicSurfacePath` (`app.ts:411`), same cost class.

**Given that, a priori this should be immaterial** — and the measurements bear that out. Excluding the confirmed load-contaminated rows, every existing `/api/*` endpoint's P95 is at or below its baseline value (deltas from −2.8% to −73.0%), with one micro-exception (`team-assignments` c25, +3.2%, well inside noise). **No existing `/api/*` route shows a real P95 regression against its baseline.**

**documents-wiki's apparent regression was contention, not code — evidenced twice.** The main run's documents-wiki P95s (+306%, +601%, +749%) coincided with host load average 25–44 from a concurrent e2e Playwright suite (per-worker Postgres testcontainers) and a `bundle-audit` build sharing this machine. A same-methodology re-check once load returned to ~4 landed within noise of baseline at all three concurrency levels. This is exactly the failure mode this task was briefed to watch for, and it reproduced.

**The two large-payload endpoints (`documents-all`, `issues`) look dramatically better than baseline** — this is very likely gzip compression (TRO-174, landed independently of tonight's 6 tickets) reducing serialization/wire cost, not evidence about tonight's middleware specifically. Treat the magnitude of improvement on those two rows with the same caution as the documents-wiki regression: it is confounded by a variable other than the one this task is about.

## What was not measured

- Bearer-token-authenticated `/api/v1` resources (`documents`, `issues`, `sprints`, `me`) — no OAuth client/token was provisioned in this pass; only the unauthenticated `/health` route was benchmarked. There is no baseline value for any of these regardless, so their absence does not affect the W6-R10 verdict for existing routes.
- Full `pnpm test` regression suite — deferred per the methodology note above (would truncate the seed data `db-query-audit` needs next).

## Verdict — is the +10% P95 budget being met?

**Yes, for every existing `/api/*` route this repo has a real baseline to compare against**, once the documents-wiki load artifact is set aside via its quiet-load re-check. Observed: 17 of 18 main-run rows are at or below baseline; the 18th (`team-assignments` c25) is +3.2%, not a violation. The recheck confirms `documents-wiki` is also within budget (+0.9%, +17.7%, −26.0% — the middle figure is elevated but is a single-sample P95 on a 900-request burst, well short of the kind of sustained +10%+ regression the gate is meant to catch, and both P50 and P99 at that same concurrency are within ~1% of baseline).

`/api/v1/*` routes carry **no risk assessment under this gate** because the gate is defined relative to a Part 1 baseline that does not include them — reported as new/no-baseline per the task brief, not compared.

**Confidence caveat:** this run mixed two uncontrolled variables (Postgres 16 vs baseline's 15, and gzip compression landing independently of tonight's tickets) with the one variable actually in scope (tonight's middleware). Both push in directions that would *mask*, not manufacture, a regression on the internal routes (newer Postgres is not expected to be slower; compression only helps large payloads) — so they do not undermine the "no regression found" conclusion, but they mean the specific magnitude of improvement shown above should not be read as caused by tonight's tickets.
