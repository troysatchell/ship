# API Response Time — Baseline

**Category** `api-perf` · **Mode** `baseline` · **Date** 2026-07-27
**Commit** `076a183` (dirty: only `.claude/`, `.gitignore`, `audit/`, `memory-bank/` — no application source)
**Data volume** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users — re-verified unchanged after the run.

---

## Methodology

**Environment.** Apple Mac16,7, 14 cores / 24 GB (arm64); Darwin 25.5.0 / macOS 26.5.1; Node v23.2.0. API at `http://localhost:3001` (`:3000` is occupied by an unrelated container), web at `:5173`. PostgreSQL 15-alpine in Docker (`ship-audit-pg`, `:5433`), pg `Pool` max 10.

**Server mode: development.** `NODE_ENV` is unset on the running API process (pid 16460, `tsx watch src/index.ts`). This matters twice over: it puts `apiLimiter` on its 1000 req/min dev branch instead of the production 100 (`api/src/app.ts:83`), and it means no production build optimisations were active. The server could not be restarted into production mode without disturbing the shared audit environment, so absolute latencies are mildly pessimistic for JS execution; the payload and query costs that dominate these numbers are unaffected.

**Query logging deliberately OFF.** Verified before measuring (`SHOW log_statement` → `none`, `SHOW log_min_duration_statement` → `-1`). Enabling it is `db-query-audit`'s job and runs *after* this audit, so it cannot skew these timings.

**Endpoint selection (config `keyEndpoints` were provisional — these are the confirmed set).** Headless Chromium (repo Playwright 1.57.0) logged in as `dev@ship.local`, ran every `userFlows` entry plus login/dashboard/docs, recording all `/api/*` requests: **63 requests across 8 flows, 49 unique**. Raw trace: `raw/frontend-trace.json`, script `raw/frontend-trace.mjs`. The six endpoints below were picked by frequency × user-visibility and written back into `audit/shipshape.config.yaml`.

Two provisional entries were removed as unreachable: `/api/search?q=...` (the `/api/search` router's only frontend consumer is `/api/search/mentions` for editor @-autocomplete; UI document search filters client-side over the full `/api/documents` payload) and `/api/dashboard` (not a route — the real ones are `/api/dashboard/my-week` and `/api/dashboard/my-focus`, both 1.2–2.9 KB).

**Auth.** `GET /api/csrf-token` → `{"token": ...}`, then `POST /api/auth/login` with `x-csrf-token` on the same cookie jar (`dev@ship.local` / `admin123`). Authenticated **once**; the resulting `session_id` + `connect.sid` cookie pair was reused as a `Cookie:` header for all 16,200 benchmark requests. Every endpoint was verified to return HTTP 200 with a real body before benchmarking.

**Load tool.** autocannon **8.0.0**, driven programmatically (`raw/bench-runner.mjs`) so that per-response latencies could be collected from the instance `response` event. autocannon's own report has no P95 (it emits p90 and p97_5), so **P50/P95/P99 are computed exactly from every measured response**, not interpolated.

**The rate limiter forced a non-standard run shape — read this before comparing.** The skill's default is ≥30 s per endpoint × concurrency. That is impossible against this app: `app.use('/api/', apiLimiter)` caps all `/api/` traffic at 1000 req/min per IP in dev. The first attempt (30 s at concurrency 10) returned **511,872 responses, every one of them HTTP 429, zero 2xx** — benchmarking that would have measured the limiter, not the API. Raising the limit would mean editing application source, which baseline mode forbids. So each combination is instead a **rate-limit-window-synchronised burst**:

1. Poll `/api/weeks` until `RateLimit-Remaining` ≥ 940 (a fresh 60 s window), sleeping on `RateLimit-Reset`.
2. Fire a fixed burst of **900 requests at the target concurrency** (one discarded 80-request warmup per endpoint, sharing the c=10 window; budget per window = 1 probe + 80 + 900 = 981 < 1000).
3. Assert the burst was **100% 2xx** with zero errors, or discard and retry in the next window.

All 18 combinations passed on the first clean window: **16,200 requests, 16,200 × HTTP 200, 0 errors, 0 non-2xx.** Trade-off to carry into compare mode: each sample is 900 requests over ~1–3 s rather than 30 s, so sustained-load effects (GC pressure, connection churn) are under-sampled, and P99 rests on 9 observations. P50/P95 are solid. **Compare mode must reproduce this exact shape** — same 900-request bursts, same window synchronisation, same order.

**Throughput caveat.** autocannon samples at 1 s granularity, so its own `req/s` is floored at ~891 for bursts that finish in under a second. The req/s column below is therefore derived by Little's Law (`concurrency ÷ mean latency`) from the measured mean, which is exact for all rows.

**Reproduce:**
```bash
# 1. verify data volume
docker exec ship-audit-pg psql -U ship -d ship_dev -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
# 2. confirm query logging is off
docker exec ship-audit-pg psql -U ship -d ship_dev -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
# 3. authenticate once into a cookie jar, then
node audit/api-perf/raw/bench-runner.mjs      # writes raw/*.json + raw/_all.json
```

---

## Deliverable table

6 endpoints × 3 concurrency levels. **P95 at concurrency 25 is the headline column.** Latency in ms; req/s derived (Little's Law); zero errors and zero non-2xx everywhere.

| Endpoint | Conc. | P50 | **P95** | P99 | req/s | errors |
|---|---|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 10 | 5.50 | **8.45** | 13.43 | 1862 | 0 |
| `GET /api/documents?type=wiki` | 25 | 12.79 | **17.33** | 39.16 | 1897 | 0 |
| `GET /api/documents?type=wiki` | 50 | 27.35 | **44.93** | 63.08 | 1715 | 0 |
| `GET /api/issues` | 10 | 28.76 | **38.78** | 43.20 | 353 | 0 |
| `GET /api/issues` | 25 | 74.19 | **94.47** | 121.73 | 331 | 0 |
| `GET /api/issues` | 50 | 150.14 | **182.00** | 208.36 | 329 | 0 |
| `GET /api/documents` | 10 | 24.20 | **34.01** | 40.01 | 413 | 0 |
| `GET /api/documents` | 25 | 59.58 | **75.75** | 99.33 | 415 | 0 |
| `GET /api/documents` | 50 | 123.40 | **146.54** | 162.06 | 406 | 0 |
| `GET /api/documents/:id` | 10 | 2.60 | **4.84** | 11.79 | 4049 | 0 |
| `GET /api/documents/:id` | 25 | 6.28 | **9.16** | 32.89 | 3765 | 0 |
| `GET /api/documents/:id` | 50 | 14.28 | **46.16** | 52.05 | 3034 | 0 |
| `GET /api/team/assignments` | 10 | 7.02 | **11.05** | 20.99 | 1420 | 0 |
| `GET /api/team/assignments` | 25 | 17.31 | **22.89** | 46.27 | 1393 | 0 |
| `GET /api/team/assignments` | 50 | 33.90 | **57.28** | 72.54 | 1396 | 0 |
| `GET /api/weeks` | 10 | 4.29 | **7.06** | 19.07 | 2336 | 0 |
| `GET /api/weeks` | 25 | 10.21 | **14.18** | 46.41 | 2285 | 0 |
| `GET /api/weeks` | 50 | 21.76 | **41.80** | 54.77 | 2131 | 0 |

### Payload sizes (measured; `gzip -9` of the identical body)

| Endpoint | Raw | gzip | Ratio |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | 24,627 B | **15.4x** |
| `GET /api/documents` | 293,891 B | 27,749 B | 10.5x |
| `GET /api/documents?type=wiki` | 37,868 B | 4,559 B | 8.3x |
| `GET /api/team/assignments` | 22,655 B | 1,750 B | 12.9x |
| `GET /api/weeks` | 4,351 B | 918 B | 4.7x |
| `GET /api/documents/:id` | 1,041 B | — | — |

No response carries `Content-Encoding`; every one of these ships at its raw size.

### Reading the numbers

**Nothing is slow yet at this data volume.** The worst headline figure is `GET /api/issues` at P95 94.5 ms (c=25) — an order of magnitude under the 1 s threshold that would make latency itself a High finding. Ship's API is comfortably fast against 500 documents.

**Latency scales linearly with concurrency, everywhere.** P50 ratios from c=10 to c=50 (a 5x increase) are 4.83x, 4.98x, 5.08x, 5.10x, 5.22x, 5.50x. Nothing grows superlinearly, so there is no lock convoy or contention pathology to chase — the single Node process (no clustering in `api/src/index.ts`) is simply throughput-saturated, and latency is queueing.

**Payload size, not query cost, separates the endpoints.** The two 300–380 KB endpoints plateau at ~330–415 req/s while the small ones sustain 1,400–4,000 req/s. `GET /api/issues` batches its associations correctly (`getBelongsToAssociationsBatch`, one `ANY($1)` query — no N+1) and touches only 254 rows, so the ~3x throughput penalty is serialization and socket writes, not the database.

**So the real findings are structural, not latency.** They are about what happens as data grows, what the wire costs a remote user, and — first — a limiter that makes all of this academic in production.

---

## Findings

### API-1 · Critical · Rate limiter caps production at 100 req/min per IP while one page view costs 4–16 requests; 429s are never retried, so throttled writes are dropped

**Location** `api/src/app.ts:81-88` (`apiLimiter`), `:137`; `web/src/lib/queryClient.ts:141-149` (query retry), `:152-159` (mutation retry)

**Evidence.** 30 s at concurrency 10 against `/api/documents?type=wiki` returned **511,872 responses, 100% HTTP 429, zero 2xx** (`statusCodeStats: {"429":{"count":511872}}`). The limiter — not the application — is the binding throughput constraint, and this audit's entire benchmark had to be rebuilt around it. The browser trace measured **63 `/api` requests across 8 flows** (49 unique): login 16, dashboard 12, document view 10, sprint board 10. Production evaluates `max: 100` per 60 s per IP (`app.ts:83`, with `isTestEnv` and `isDevEnv` both false). Client-side, `grep -rn "429" web/src` returns **zero matches**, and both retry predicates return `false` for every status in `[400,500)`.

**Hypothesis.** The ceiling was sized as if one page view were one request, but this SPA issues 4–16 XHRs per navigation — so a single user exhausts the window after roughly **6–10 navigations per minute**. In the deployed topology (CloudFront → Elastic Beanstalk; `trust proxy 1` at `app.ts:93`) every user behind one agency NAT egress collapses into a single rate-limit key, so a team shares one 100 req/min budget collectively. Because react-query treats 429 as a non-retryable 4xx **for mutations as well as queries**, a throttled `PATCH` of document metadata (title, state, priority, assignee) fails permanently with only a toast. Yjs editor body text survives — `/collaboration` WebSocket traffic is not behind the `/api/` limiter — but metadata writes are not so lucky.

**Estimated impact.** Raising the limit to a per-page-view-realistic value, or keying it per session rather than per IP, removes an artificial ~1.7 req/s production ceiling and stops silent write loss. Until then **no latency optimisation is observable in production**, because the limiter bounds throughput far below anything measured here (299–4,049 req/s). *Cross-reference: the dropped-write path should be reproduced end-to-end by `error-handling-audit` (ERR).*

### API-2 · High · `GET /api/issues` returns 380 KB with no pagination, 72% of it a `content` field the list UI never reads

**Location** `api/src/routes/issues.ts:126` (`SELECT d.content`), `:99` (`content: row.content`), `:215-224` (`ORDER BY` with no `LIMIT`/`OFFSET`)

**Evidence.** Measured payload **379,907 bytes** for 254 issues — the slowest endpoint at every level (P95 38.8 / 94.5 / 182.0 ms; P99 208.4 ms at c=50), and the only one whose throughput floor sits at ~330 req/s. `grep -n "LIMIT\|OFFSET" api/src/routes/issues.ts` returns no matches. In Postgres, `content` is **138 kB of the 191 kB (72.3%)** of live issue text. The list UI never dereferences it: grep for `.content` across `web/src/components/IssuesList.tsx` and `web/src/pages/Issues.tsx` yields only unrelated prop names and comments.

**Hypothesis.** Serialization-bound, not query-bound. The handler batches associations correctly (`api/src/utils/document-crud.ts:148-180`, one `ANY($1)` query — no N+1) over just 254 rows, so the ~330 req/s ceiling and the clean linear latency curve point at `JSON.stringify` plus socket writes of 381 KB per response on a single Node process.

**Estimated impact.** Dropping `content` from the list projection shrinks the payload ~2.6x and should cut **P95 at c=25 from 94.5 ms to roughly 35–40 ms (~55–60%)** — clearing the ≥20% target on this endpoint alone. Adding `LIMIT`/`OFFSET` additionally caps growth, currently linear: at 10x seed volume this response is ~3.8 MB.

### API-3 · High · No response compression anywhere; the largest payload ships 15.4x larger than it needs to

**Location** `api/src/app.ts` (no `compression` middleware registered); `api/package.json` (`compression` is not a dependency)

**Evidence.** `curl -H 'Accept-Encoding: gzip, deflate, br'` against `/api/issues` returns `Content-Length: 379907` and **no `Content-Encoding` header** — the body is sent uncompressed even when the client advertises support. `gzip -9` of the identical body is 24,627 bytes (**15.4x**). See the payload table above for the other four.

**Hypothesis.** The middleware was never added. The gap is invisible locally and in this benchmark because loopback transfer is effectively free, so it never surfaces in a localhost latency number — it costs only real users on a WAN link.

**Estimated impact.** On a 10 Mbps agency link the `/api/issues` body alone is ~304 ms of transfer, dropping to ~20 ms with gzip. **Important for compare mode:** enabling gzip will *not* reduce P95 over loopback and may raise it slightly (compression CPU added, transfer time already ~0). Validate this fix by payload size or over a bandwidth-shaped link, never by re-running this localhost benchmark. Also confirm whether CloudFront edge compression already masks part of it in the deployed stack.

### API-4 · Medium · Command palette (cmd+K) re-downloads the entire 294 KB corpus on every open, bypassing the cache

**Location** `web/src/components/CommandPalette.tsx:143-166`

**Evidence.** The `useEffect` is keyed on `[open]` and calls plain `apiGet('/api/documents')` into local `useState`, bypassing the `queryClient` (`staleTime` 5 min, `gcTime` 24 h) entirely — every open is a cold fetch. Measured payload **293,891 bytes for all 500 documents**; the browser trace confirms exactly one such request on opening the palette. P95 34.0 / 75.7 / 146.5 ms. `GET /api/documents` has no `LIMIT`/`OFFSET` (`api/src/routes/documents.ts:94-154`).

**Hypothesis.** Search is client-side filtering over the full corpus (`groupedDocuments` useMemo at `:169`) rather than a server-side query. A `/api/search` router exists, but its only frontend consumer is `/api/search/mentions` for editor @-autocomplete (`web/src/components/editor/MentionExtension.ts:23`), so no server-side document search is reachable from the UI.

**Estimated impact.** Cost grows linearly with workspace size — at 10x seed volume each cmd+K press transfers ~2.9 MB. Routing the palette through the existing search router plus react-query caching removes a 294 KB fetch from an interactive keystroke path and returns 1 of the 100 req/min production budget per open.

### API-5 · Medium · Dashboard issues one request per active week for standups (client-side N+1)

**Location** `web/src/pages/Dashboard.tsx:69-83`

**Evidence.** `Promise.all` over `activeWeeks` issuing `GET /api/weeks/${sprint.id}/standups` per week. The dashboard trace shows 12 API requests, **5 of them this fan-out**, each returning exactly 2 bytes (`[]`) — 10 bytes of useful payload spread over 5 round trips. The parent `GET /api/weeks` is itself cheap (4,351 B, P95 14.2 ms at c=25). Request count grows with the number of active weeks.

**Hypothesis.** No batch endpoint for standups-by-week exists, so the client loops. Each iteration re-enters `authMiddleware`, paying the full per-request auth cost (API-6) for a 2-byte result.

**Estimated impact.** A single `GET /api/weeks/standups?week_ids=...` collapses 5 round trips into 1, cutting the dashboard from 12 to 8 requests (−33%) and reclaiming budget against API-1. *Cross-reference: the server-side query-count counterpart belongs to `db-query-audit` (DB).*

### API-6 · Medium · Every authenticated request — including every GET — performs a session write

**Location** `api/src/middleware/auth.ts:203-206` (`UPDATE sessions SET last_activity`), `:126-133` (session SELECT); `api/src/middleware/visibility.ts:6-24` (per-handler `isWorkspaceAdmin`)

**Evidence.** Every authenticated request runs `SELECT` session `JOIN` users, then **unconditionally** `UPDATE sessions SET last_activity = $1 WHERE id = $2`, and each handler then runs its own `isWorkspaceAdmin`/`getVisibilityContext` SELECT — at least 3 queries before any endpoint work. Measured floor: `GET /api/documents/:id` returns only 2,195 bytes from one indexed primary-key lookup, yet still costs P50 2.6 ms / P95 4.8 ms at c=10 and P50 14.3 ms / P95 46.2 ms at c=50. Latency scales linearly on all six endpoints (4.83x–5.50x for 5x concurrency), so this is saturation, **not** lock convoy — the shared-row write is not yet the binding constraint at this volume.

**Hypothesis.** Sliding-session bookkeeping is inline and unthrottled, even though the cookie refresh immediately below it (`auth.ts:209-212`) is already throttled to 60 s. The pg pool is capped at `max: 10` in dev / 20 in production (`api/src/db/client.ts:20`), so at concurrency 50 requests queue for connections while each holds one to perform a write that changes nothing meaningful 99% of the time.

**Estimated impact.** Throttling the `last_activity` write to the same ~60 s threshold already used for the cookie removes one write per request, roughly a third of the query count on cheap endpoints, and stops every GET from generating WAL. It is also a prerequisite for ever serving reads from a replica. *Cross-reference: per-flow query counts belong to `db-query-audit` (DB).*

---

## Recommended improvement plan

Target for a future `compare` run: **≥20% P95 reduction on at least 2 endpoints**, under identical conditions, root cause documented per bottleneck.

| # | Change | Endpoint(s) moved | Predicted P95 @ c=25 | Measurable on loopback? |
|---|---|---|---|---|
| 1 | Drop `content` from the `/api/issues` list projection (`issues.ts:126`, `:99`) | `GET /api/issues` | 94.5 ms → ~35–40 ms (**~55–60%**) | **Yes** |
| 2 | Paginate `/api/documents` (`LIMIT`/`OFFSET` + total count) and stop the palette fetching the whole corpus | `GET /api/documents` | 75.7 ms → ~20–25 ms (**~65%**) | **Yes** |
| 3 | Throttle the `last_activity` write to 60 s (API-6) | all six, cheap ones most | ~10–20% on `/api/documents/:id`, `/api/weeks` | Partially |
| 4 | Add `compression` middleware (API-3) | all | no loopback change — 15.4x wire reduction | **No** — verify by payload size |
| 5 | Re-scale or re-key `apiLimiter` (API-1) | none directly | unblocks every other gain in production | No — correctness fix |

**Sequencing.** Items 1 and 2 alone clear the improvement target and are pure deletions of unused data — lowest risk, highest measured return. Item 5 is the one to ship first regardless of what the latency numbers say: it is a Critical correctness issue (dropped writes), and while it stands, none of items 1–4 can help a production user who is being throttled before the request is ever served.

**For whoever runs compare mode.** Re-verify the 500/20 row counts; reuse `raw/bench-runner.mjs` unchanged (900-request window-synchronised bursts, autocannon 8.0.0, concurrency 10/25/50, same endpoint order); confirm every burst is 100% 2xx; keep PostgreSQL query logging off; and expect item 4 to show *no* improvement here by design.
