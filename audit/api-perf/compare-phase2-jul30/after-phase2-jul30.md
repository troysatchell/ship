# API Response Time — Compare (phase2-jul30)

**Category** `api-perf` · **Mode** `compare` · **Label** `phase2-jul30` · **Date** 2026-07-30
**Commit** `15e6cb0` (clean; branch `measure/api-perf-compare-jul30` at `main`) · **Baseline** `../baseline.json` (commit `076a183`, 2026-07-27)
**Data volume** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 project / 15 weekly_review / 6 standup / 5 program), 20 users — verified via `SELECT ... GROUP BY`, byte-identical to baseline (deterministic `seed-augment.ts`).

---

## Methodology

**Environment.** Same hardware/OS/Node as baseline (Apple Mac16,7, 14 cores/24 GB, Darwin 25.5.0, Node v23.2.0). Isolated worktree `Ship-wt-api_compare` on branch `measure/api-perf-compare-jul30`, exclusive database `ship_wt_api_compare` on the same `ship-audit-pg` (postgres:15-alpine, `:5433`) container baseline used. Query logging confirmed OFF (`log_statement=none`, `log_min_duration_statement=-1`) before measuring.

**Server mode.** `api/.env.local` sets `NODE_ENV=development` explicitly (baseline had it unset). This is not a hidden condition change: `resolveApiRateLimits()` (`api/src/middleware/rate-limit.ts:79`) computes `isDevEnv = env.NODE_ENV !== 'production'`, which is `true` for both `'development'` and `undefined` — the two conditions are behaviourally identical, and this was confirmed empirically, not just read from source: `curl -sD - http://localhost:3211/api/weeks` returned `RateLimit-Limit: 1000`, matching baseline's dev ceiling exactly.

**The rate limiter changed shape since baseline (API-1/TRO-172), but not its dev-mode ceiling.** It is now two chained limiters — `perSourceIpLimiter` (10,000/min in dev) then `perIdentityLimiter` (1,000/min in dev, keyed on the session cookie via SHA-256 fingerprint) — replacing the old single 1,000/min-per-IP limiter. Because this benchmark reuses one session cookie for every request (same as baseline), all traffic lands in one `perIdentityLimiter` bucket, so the original 900-request-burst / rate-limit-window-synchronisation design in `bench-runner.mjs` needed no change and none was made.

**Runner.** `audit/api-perf/raw/bench-runner.mjs` was reused **unmodified in methodology** — same 900-request bursts, 80-request discarded warmup at c=10, autocannon 8.0.0, concurrency [10, 25, 50], same 6 endpoints in the same order, same exact-percentile computation from raw per-response latencies. It was not literally executed byte-for-byte because it hardcodes a *different session's* scratchpad path, the main worktree's `OUT` directory, API port `3001`, and a document id that only exists in the baseline database — none of which resolve here (this worktree's API runs on `:3211` per `.factory-env`, against its own seeded database). A copy, `compare-phase2-jul30/raw/bench-runner-compare.mjs`, changes only those four constants; `diff` against the original confirms nothing else differs. The original file was never edited.

**Auth.** Identical sequence to baseline: `GET /api/csrf-token` → `POST /api/auth/login` (`dev@ship.local` / `admin123`) with `x-csrf-token`, reusing the resulting `session_id` + `connect.sid` cookie pair for all benchmark requests. All 6 endpoints verified to return HTTP 200 with real bodies before benchmarking.

**2xx confirmation.** All 18 combinations (16,200 requests) completed at 100% 2xx, 0 errors, 0 non-2xx in every *accepted* row. One discard-and-retry occurred on the very first combination (`documents-wiki` c=10, attempt 1: 900 requests, 869×200 + 31×429) — caused by this session's own pre-flight `curl` verification calls consuming rate-limit budget in that window, not by the app or the runner. Attempt 2, after waiting for a fresh window, was clean (900/900 2xx). This is exactly the discard/retry protocol baseline's own methodology documented ("assert 100% 2xx... or discard and retry in the next window") — not a rate-limiter regression.

**Background load.** Load average 2.2–6.2 (14 cores) throughout the run. Six-plus sibling worktree API dev servers (other in-flight factory tickets) were present but idle (0% CPU in `ps`) the entire time, alongside unrelated Docker containers and VS Code/Claude processes. Not "nothing else on the machine," but no other benchmark, test suite, or active traffic ran concurrently with any burst.

**Test suite.** Run after all benchmark measurements were captured (to avoid resource contention during timing-sensitive bursts): `pnpm test` → 55 API test files / 662 tests + 49 web test files / 420 tests, **all passed, 0 failures**. Running the API vitest suite truncates this worktree's exclusive database by design (documented in `api/.env.local`) — confirmed this happened only after every benchmark JSON artifact was already on disk.

**Reproduce:**
```bash
docker exec ship-audit-pg psql -U ship -d ship_wt_api_compare -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
docker exec ship-audit-pg psql -U ship -d ship_wt_api_compare -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
node audit/api-perf/compare-phase2-jul30/raw/bench-runner-compare.mjs
```

---

## Deliverable table — delta vs baseline

Latency in ms. **P95 at concurrency 25 is the headline column** (matches how baseline's own headline was framed). Positive % = slower than baseline; negative % = faster.

| Endpoint | Conc. | P50 (Δ%) | **P95 (Δ%)** | P99 (Δ%) |
|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 10 | 5.61 (+2.0%) | **8.83 (+4.5%)** | 10.99 (−18.2%) |
| `GET /api/documents?type=wiki` | 25 | 13.78 (+7.7%) | **20.44 (+18.0%)** | 39.33 (+0.4%) |
| `GET /api/documents?type=wiki` | 50 | 27.11 (−0.9%) | **37.86 (−15.7%)** | 56.24 (−10.9%) |
| `GET /api/issues` | 10 | 18.89 (−34.3%) | **26.66 (−31.3%)** | 37.57 (−13.0%) |
| `GET /api/issues` | 25 | 50.48 (−32.0%) | **65.48 (−30.7%)** | 84.97 (−30.2%) |
| `GET /api/issues` | 50 | 98.00 (−34.7%) | **110.26 (−39.4%)** | 133.99 (−35.7%) |
| `GET /api/documents` | 10 | 26.22 (+8.4%) | **39.30 (+15.6%)** | 44.95 (+12.4%) |
| `GET /api/documents` | 25 | 63.00 (+5.7%) | **85.25 (+12.5%)** | 104.73 (+5.4%) |
| `GET /api/documents` | 50 | 128.43 (+4.1%) | **144.51 (−1.4%)** | 160.20 (−1.2%) |
| `GET /api/documents/:id` | 10 | 2.80 (+7.7%) | **4.64 (−4.2%)** | 9.14 (−22.5%) |
| `GET /api/documents/:id` | 25 | 6.33 (+0.8%) | **12.67 (+38.4%)** | 28.32 (−13.9%) |
| `GET /api/documents/:id` | 50 | 12.57 (−12.0%) | **30.12 (−34.8%)** | 37.37 (−28.2%) |
| `GET /api/team/assignments` | 10 | 8.68 (+23.7%) | **12.67 (+14.7%)** | 22.38 (+6.6%) |
| `GET /api/team/assignments` | 25 | 16.59 (−4.2%) | **22.15 (−3.2%)** | 32.82 (−29.1%) |
| `GET /api/team/assignments` | 50 | 39.33 (+16.0%) | **55.03 (−3.9%)** | 74.99 (+3.4%) |
| `GET /api/weeks` | 10 | 3.97 (−7.5%) | **8.02 (+13.6%)** | 16.89 (−11.4%) |
| `GET /api/weeks` | 25 | 8.50 (−16.8%) | **15.09 (+6.5%)** | 41.39 (−10.8%) |
| `GET /api/weeks` | 50 | 18.20 (−16.4%) | **41.58 (−0.5%)** | 52.55 (−4.1%) |

**Supplementary re-run — `documents/:id` only**, prompted by the inconsistent c=25 result above (see "Root causes and regressions" below):

| Conc. | Primary run P95 (Δ%) | Recheck run P95 (Δ%) |
|---|---|---|
| 10 | 4.64 (−4.2%) | 4.60 (−5.1%) |
| 25 | 12.67 (**+38.4%**) | 10.11 (**+10.4%**) |
| 50 | 30.12 (−34.8%) | 20.03 (**−56.6%**) |

Both runs agree on direction at every concurrency: flat at c=10, worse at c=25, much better at c=50. The magnitude at c=25 shrank on the second run but the sign did not flip — this is reported as a real, reproducible (if not fully explained) concurrency-dependent pattern, not dismissed as noise.

**Payload sizes** (raw body, `Accept-Encoding: identity`; gzip/br now negotiated separately, see below):

| Endpoint | Baseline raw | Compare raw | Δ% |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | 241,338 B | **−36.5%** |
| `GET /api/documents` | 293,891 B | 293,827 B | −0.02% |
| `GET /api/documents?type=wiki` | 37,868 B | 37,806 B | −0.16% |
| `GET /api/team/assignments` | 22,655 B | 22,655 B | 0% |
| `GET /api/weeks` | 4,351 B | 4,351 B | 0% |

`team/assignments` and `weeks` are **byte-identical** to baseline — strong confirmation that `seed-augment.ts`'s deterministic LCG/epoch reproduced the exact same dataset, so any latency deltas on those two endpoints reflect code-path or environment effects, not data drift.

**Compression (API-3), validated by payload/header inspection, not loopback latency** — per baseline's own instruction, since compression CPU has nothing to win against a ~0ms loopback transfer:

| Endpoint | Raw | gzip-negotiated wire | Ratio |
|---|---|---|---|
| `GET /api/issues` | 241,338 B | 19,926 B | 12.1x |
| `GET /api/documents` | 293,827 B | 28,306 B | 10.4x |
| `GET /api/documents?type=wiki` | 37,806 B | 4,523 B | 8.4x |
| `GET /api/team/assignments` | 22,655 B | 1,746 B | 13.0x |
| `GET /api/weeks` | 4,351 B | 904 B | 4.8x |

With `Accept-Encoding: gzip, deflate, br` (curl's default), the server actually negotiates **brotli** (`Content-Encoding: br`) — `compression@1.8.1` added brotli support since baseline measured this gap. Confirms API-3 is live and effective. The autocannon bursts above do **not** exercise this: `meanBytesPerResponse` in every burst (e.g. 38,979 for `documents-wiki`) matches the *uncompressed* body size, not the ~4.5 KB compressed wire size — autocannon sends no `Accept-Encoding` header, so the latency deltas above are not confounded by compression CPU, exactly as baseline predicted.

---

## Target verdict

**Target:** ≥20% P95 reduction on at least 2 endpoints, identical conditions.

**At the headline concurrency (c=25, matching baseline's own framing): only 1 of 6 endpoints clears the bar** — `GET /api/issues` at **−30.68%**. `GET /api/documents/:id`, the other candidate, is measurably *worse* than baseline at c=25 in two independent runs (+38.4%, then +10.4%). Strictly by this framing, the category target is **not met**.

**Looking at the full concurrency sweep, a second endpoint does clear the bar, but only at c=50:** `GET /api/documents/:id` improves −34.8% (primary run) and −56.6% (recheck), reproduced across two independent measurements. `GET /api/issues` clears the bar at **every** tested concurrency (−31.3% / −30.7% / −39.4% at c=10/25/50) — the only endpoint with a robust, concurrency-independent win.

**Bottom line, stated plainly and not spun either direction:** one endpoint (`/api/issues`) unambiguously and robustly meets the ≥20% P95 bar. A second endpoint (`/api/documents/:id`) meets it only at the highest tested concurrency and is reproducibly *worse* than baseline at the middle concurrency — so whether "≥2 endpoints" is satisfied depends on whether the target is read as "at the headline concurrency" (not met, 1/2) or "at some tested concurrency, reproducibly" (met, 2/2). Both readings are reported here; neither is asserted as *the* answer.

---

## Root causes per improved endpoint

**`GET /api/issues` (API-2 / DB-5) — the only endpoint with an unambiguous, concurrency-independent win.** `api/src/routes/issues.ts:345-348` (commit `03e69ad`, merged as PR #19 / `5f879ef`) dropped `d.content` from the list `SELECT`, with the comment "`d.content` is deliberately absent: the document body is not part of the list projection (TRO-173 / API-2)." Measured raw payload fell 379,907 → 241,338 bytes (−36.5%), and P95 fell 20–39% at every concurrency tested. This matches baseline's own hypothesis exactly: the endpoint was serialization/socket-write bound (batched associations, no N+1, only 254 rows), so cutting payload size directly cuts the JSON.stringify + write cost that dominated its latency.

**`GET /api/documents/:id` at c=50 only (DB-2 / API-6) — session-write elimination, visible where connection-pool contention is highest.** `api/src/middleware/auth.ts:88` (`SESSION_ACTIVITY_UPDATE_THRESHOLD_MS = 60_000`) and the throttled write at `:325-333` (`UPDATE sessions SET last_activity = $1 WHERE id = $2 AND last_activity < $3`, commits `e953e7d`/`f1756e6`, merged as PR #13 / `ea4aacf`) replace baseline's *unconditional* per-request write. Because this benchmark reuses one session cookie across an entire ~19-minute run, and bursts are spaced ~60s apart by the rate-limit window sync, the vast majority of the 900 requests in every burst now skip the write entirely (only the first request after each ~60s gap is "due"), versus baseline where all 900 performed it. Baseline's own diagnosis is the plausible mechanism for why this shows up specifically at c=50: `pool: max 10` (dev), so at high concurrency requests already queue for a connection; removing one query per request shortens each connection's hold time, which compounds with queueing depth. At c=10 the pool isn't saturated, so the same removed query has negligible queueing benefit (flat result, ±5%).

---

## Anything that got slower by >10% — reported plainly, with hypotheses

Several cheap endpoints show a modest-to-moderate regression concentrated at **low-to-mid concurrency** (c=10/c=25), not present at c=50:

- `GET /api/documents?type=wiki` c=25: P95 +18.0%
- `GET /api/documents` c=10: P95 +15.6%; c=25: P95 +12.5%
- `GET /api/documents/:id` c=25: P95 +38.4% (primary), +10.4% (recheck) — the largest and most reproducible regression
- `GET /api/team/assignments` c=10: P95 +14.7%
- `GET /api/weeks` c=10: P95 +13.6%

**Hypothesis (not verified by profiling — flagged explicitly as inference, not measurement):** the rate limiter that replaced baseline's single IP-keyed limiter now runs **two** chained `express-rate-limit` instances per request (`perSourceIpLimiter` then `perIdentityLimiter`, `api/src/middleware/rate-limit.ts:180-201`), and the identity limiter's key is a **SHA-256 hash** of the session cookie computed on every single request (`fingerprint()`, `rate-limit.ts:139-142`) — work baseline's simple IP-based keying never did. This is a small, roughly-constant per-request CPU cost that would be proportionally largest on the cheapest endpoints (sub-15ms baseline latencies), which is exactly the set showing regressions here. It would also explain why `/api/documents/:id` swings from "worse" (c=25, added overhead visible, pool not yet the bottleneck) to "much better" (c=50, pool-contention savings from DB-2/API-6 outweigh the added hashing cost). This hypothesis was not confirmed with a profiler or a rate-limiter-disabled control run — flagging it as the most plausible explanation available from reading the code, not as an established root cause. No regression here exceeds baseline's "P95 > 1s on a flow-blocking endpoint" severity threshold; the largest (`documents/:id` +38.4% at c=25) is still an absolute P95 of 12.7ms.

`GET /api/documents` (the "unfiltered doc list" / command-palette endpoint) was never targeted by a payload-reducing fix — baseline's recommended-plan item 2 (paginate `/api/documents`) was **not implemented** (confirmed: the route's pagination is opt-in only, same as `/api/issues`, and default requests still return the full 500-document corpus at 293,827 bytes, 64 bytes off baseline's 293,891 — noise from the seed script, not a real change). Its mild across-the-board regression is consistent with the same rate-limiter-overhead hypothesis above, with no offsetting fix to counteract it at any concurrency tested.

---

## Scope note: endpoints named in the brief that are not in this benchmark

Two of the improvements named as "expected movers" in the compare brief are real, merged, and confirmed by reading the code — but are **not measurable by this P95 harness** because they were never part of the 6 benchmarked `keyEndpoints`:

- **The dashboard standups fan-out (DB-4/API-4/API-5, commit `2acd5d4`, merged as PR #29 / `1845d04`)** replaced `Dashboard.tsx`'s per-week `Promise.all` fan-out with one new endpoint, confirmed present: `GET /api/weeks/standups?week_ids=...` (`api/src/routes/weeks.ts:1093`). This is a *new* endpoint with no baseline P95 to compare against, and the fix's value is a round-trip-count and query-count reduction (db-query-audit's territory), not a per-request latency change on any of the 6 endpoints this audit measures.
- **DB-6 (the `/api/weeks` lateral join, commit `e4db0fc`, merged as PR #50 / `998583c`)** is real and does touch a benchmarked endpoint (`GET /api/weeks`), but per its own documented evidence the query already executed in ~1.2ms at this data volume ("everything is in shared buffers") — the fix reduces buffer reads 36.6% for scalability at larger volumes, not latency at 500 documents. Consistent with that, `GET /api/weeks` shows no P95 improvement here (+13.6% / +6.5% / −0.5% at c=10/25/50) — this is the expected, by-design result, not a missed fix.

---

## Recommended follow-up for whoever picks this up next

1. **Isolate the c=25 `documents/:id` regression.** Profile or add a control run with the rate limiter's identity-keying hash removed, to confirm or rule out the SHA-256/double-middleware hypothesis above.
2. **`/api/documents` still has no pagination.** Baseline's plan item 2 was never implemented; it remains the single largest unrealized win in the original recommended plan (predicted ~65% P95 reduction).
3. Re-seed the worktree database before any further use — `pnpm test`'s API suite truncated it after this comparison was captured.
