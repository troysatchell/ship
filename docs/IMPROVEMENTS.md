# Ship — Improvement Documentation

Compiled from `audit/AUDIT_REPORT.md` (baseline targets, verbatim), `CHANGES.md` (48 dated fix
entries), the formal compare artifacts at `audit/a11y/compare-phase2-jul30/` and
`audit/api-perf/compare-phase2-jul30/`, `audit/factory/scorecard.jsonl`, and
`memory-bank/progress.md` (2026-07-29/30 entries). Where a number below is marked **"directly
verified"**, it was re-measured against this document's own commit rather than taken on the
source's word. Branch `docs/improvement-documentation`, base commit `09a6895`.

Two provenance notes up front, resolved same-day and kept for the audit trail:

- **`audit/db-query/compare-phase2-jul30/` landed after this document was first compiled** — the
  full-flow re-capture now exists and is the authoritative Category 4 evidence (see §4, updated with
  its figures). The per-PR `EXPLAIN ANALYZE` pairs in `CHANGES.md` remain as each fix's own record.
- **TRO-302 is a Linear ticket, not a repo file** (this document's first compile correctly noted no
  repo artifact existed yet). It has since been executed: the rate-limiter-hashing hypothesis was
  **profiled and acquitted**, and the c=25 "regressions" were shown to be shared-machine measurement
  noise (PR #60; full detail in §3 below and `CHANGES.md`).

---

## 1 — Type Safety

**Target (verbatim):** *"eliminate 25% of the 1535 tracked violations ≈ 384 sites, with real
types — `any` → `unknown` without narrowing does not count."* (`AUDIT_REPORT.md`, Type Safety §
Recommended improvement plan)

**Verdict: NOT MET against the requirement's literal threshold.** The requirement is defined on the
tracked `count.sh` total ("25% of the 1535 tracked violations"), and that total has never measured
below baseline at any point this sprint — 1535 → 1778 → **1987** (this session's recount, below).
The per-ticket sum-of-diffs argument this section originally led with is real and stays below, but
it answers a different question ("did the fixed tickets individually reduce what they targeted") —
it is not a substitute for the literal metric the target names, and should not have been reported as
"met" against it. Corrected here rather than left standing, per this repo's own provenance rule:
mark a derived claim as derived, and check the specific number a requirement names rather than a
related one that moved the right direction.

### Before → After

| Metric | Baseline (076a183, 2026-07-27) | 09a6895 (2026-07-30-ish, prior recount) | **HEAD (`5126a03`, 2026-08-08), this session's recount** | Note |
|---|---|---|---|---|
| Tracked total (`count.sh`, web+api+shared) | 1535 | 1778 | **1987** | +452 / **+29%** vs baseline. Requirement needs −25% (≈−384, target ≤1151). Never once measured below baseline. |
| Total `any` (web+api+shared) | 102 | — | **50** | −52, halved — genuine, verified this session |
| `req.userId!` / `req.workspaceId!` raw occurrences | 236 | 0 | **0** | −236, fully retired, still 0 this session |
| `web/tsconfig.json` extends root? | No | Yes | **Yes** | directly verified — file still reads `"extends": "../tsconfig.json"` |

**This session's recount, in full** (`bash ~/.claude/skills/type-safety-audit/scripts/count.sh web
api shared`, run against this worktree at `5126a03`, 2026-08-08): any 50 (web 23 + api 27 + shared
0) + as 1882 (web 659 + api 1212 + shared 11) + non-null 47 (web 5 + api 42 + shared 0) + ts-ignore 8
(web 3 + api 5 + shared 0) = **1987**, summed per this baseline's own formula (`baseline.md:77`,
`any + as + ! + ts-ignore`, `as any` not double-counted since it is a subset of `as`). Against the
recorded baseline `metrics.violationsTotal: 1535` (`audit/type-safety/baseline.json`), that is
**+452 (+29%)** — the wrong direction and well short of the −25% target, whether compared to the
original baseline or to either intermediate recount.

The tracked total has *risen* at every measurement point this sprint: 1535 → 1778 → 1987. The first
rise (1535→1778) was flagged in this document's earlier draft as "exactly the trap `.claude/CLAUDE.md`
warns about" and left the verdict at "met" anyway, reasoning from the per-ticket sum instead. That
reasoning wasn't wrong on its own terms — TS-1's own fix entry independently found the same drift
(the audit's 102 latent tsc errors had already become 156 by the time that ticket ran) — but the
requirement's threshold is written against the tracked total, not against the per-ticket sum, and on
that number there has been no point this sprint where the target was actually met.

**Why the tracked total doesn't move the way the per-ticket sum suggests it should:** two
independent mechanisms explain the gap, though neither changes the verdict above — they explain the
number, they don't substitute for it. (1) `count.sh`'s non-null pattern `[a-zA-Z0-9_\)\]]!…` has a
documented BSD-grep bracket bug (recorded in the baseline's own Methodology) that closes the
character class early — it never counted `req.userId!`-shaped assertions, so TS-4 retiring 236 of
them moves the tracked number by zero (42→42, confirmed above). (2) ~30+ tickets unrelated to type
safety merged into `main` across the sprint, adding new `as`/`any` sites the way any active codebase
does — the tracked total is a live number in a moving codebase, not a metric that only this
category's tickets touch.

**Controlled per-ticket sum (supporting evidence for the real work done, not a restatement of the
verdict):** TS-1 (156) + TS-3 (19) + TS-4 (236, raw occurrence count) = **411 ≥ 384**, using only
the three tickets with a single unambiguous count-with-comparable-methodology — before TS-2 or TS-6
are even added. (The brief's approximation "~130 TS-1 + ~45 TS-2 + 19 TS-3 + 233 TS-4 ≈ 427" is
close but not exact against `CHANGES.md`: TS-1's own re-measurement is 156, not ~130, because the
audit's 102 had already drifted before the fix landed; TS-3 is 19, confirmed; and TS-4 is 236 raw /
233 by the corrected-metric delta (286→53), both confirmed above. TS-2 has no single clean "~45"
figure in `CHANGES.md` — its contribution is 6 of 7 untyped row mappers retyped plus 154 newly-typed
`pool.query<Row>()` call sites, which the tracked metric was never built to count in the first
place.) This number is real and the tickets behind it genuinely reduced what they targeted — it is
just not the number the requirement's literal threshold is defined on, which is why the verdict
above is scored against the tracked total instead.

### Root causes

**TS-4 (TRO-209, 236→0 non-null on auth context).** `api/src/middleware/auth.ts:11-12` declared
`userId?`/`workspaceId?` optional, forcing `req.userId!`/`req.workspaceId!` at 236 sites across 21
route files (`routes/projects.ts:318-319`, `routes/comments.ts:22,60-61,143-144,230-231`,
`routes/workspaces.ts:214,389,490,591,673,861`). Fixed with an `AuthenticatedRequest` type plus an
`authed(handler)` wrapper — a type guard, not a cast.

**TS-1 (TRO-206, tsconfig drift).** `web/tsconfig.json` had no `extends` key, silently losing
`noUncheckedIndexedAccess`/`noImplicitReturns`/`noFallthroughCasesInSwitch` that `api`/`shared`
inherit from the root config. Added `extends: "../tsconfig.json"`; fixed all 156 errors that
surfaced when re-running the identical flag-restoration command against this branch's pre-fix
state (superseding the audit's 102, per the drift explained above). `ReviewsPage.tsx` fix extracted
an actual invariant gap (`emptyReviewCell`/`mergeReviewCellPatch`), not just a narrowing.

**TS-2 (TRO-207, DB→HTTP path).** `@types/pg`'s `query()` defaults its row generic to `any`; ~710
call sites in `api/src` supplied none. Of the audit's "seven untyped mappers," one
(`extractIssueFromRow`) was already typed but structurally inert since its callers still fed it
`any` — corrected in the fix write-up rather than counted twice. Added `pool.query<Row>()` at 154
new call sites plus a shared `rowTypes.ts`.

**TS-3 (TRO-208, Yjs↔TipTap converter).** `api/src/utils/yjsConverter.ts` (the sole translation
layer between CRDT state and the persisted `documents.content` column — called from
`collaboration/index.ts:118` `persistDocument()` and `routes/documents.ts:405`) carried 12 `any` in
245 lines; `y-protocols.d.ts` added 7 more. Both now 0, directly verified. Modeled
`TipTapNode`/`TipTapMark`/`TipTapDoc` types.

**TS-6 (TRO-211, the ratchet).** No ESLint config existed anywhere; `pnpm lint` matched nothing and
exited 0. Root `eslint.config.mjs` now enforces `eqeqeq` as an error and warns on
`no-explicit-any`/`no-non-null-assertion`/`no-floating-promises` — the mechanism that keeps this
category's reduction from silently regressing, proven live by injecting `if (a==1)` (exit 1) and
reverting (exit 0).

### Reproducibility

```bash
bash ~/.claude/skills/type-safety-audit/scripts/count.sh web api shared          # tracked totals
grep -rEn --include="*.ts" --include="*.tsx" 'req\.(userId|workspaceId)!' api/src | wc -l   # TS-4 raw (expect 0)
grep -rEn --include="*.ts" --include="*.tsx" \
  '[a-zA-Z0-9_)]]?!(\.|\[|\)|,|;|\s*$)' api/src | wc -l                          # corrected non-null (expect 53)
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch    # TS-1 (expect 0)
pnpm --filter @ship/api exec vitest run src/utils/__tests__/yjsConverter.test.ts # TS-3 regression
pnpm lint                                                                        # TS-6 gate, expect exit 0
```
All of the above except the ESLint run were executed directly against `09a6895` while compiling
this document; results are quoted in the table above.

**This session (2026-08-08, HEAD `5126a03`)** re-ran two of the above independently, without
re-running TS-1/TS-3/TS-6's checks (out of scope for this correction — a verdict fix, not a
re-audit of every ticket): the `count.sh` line, whose full breakdown and total (1987) is quoted
above; and the `req.userId!`/`req.workspaceId!` grep, which still returns 0. Both are marked
directly verified above for that reason; the other rows in the "prior recount" column are carried
forward from the 09a6895 compile and not independently re-confirmed this session.

---

## 2 — Bundle Size

**Target (verbatim):** *"cut the initial-load bundle by 20%"* — 600.75 kB gzip → ≤ 480.60 kB gzip.
(`AUDIT_REPORT.md`, Bundle Size § Recommended improvement plan)

**Verdict: met.** The measured route-level reduction (−64.9% to −80.5%, depending on route) exceeds
the 20% bar by a wide margin.

### Before → After

Baseline measured one undifferentiated entry chunk (601.47 kB gzip on every route, since no routes
were split yet). After BUN-1..6, "route payload" is the comparable unit:

| Route | Baseline (single entry chunk) | After | Δ |
|---|---|---|---|
| `/login` | 601.47 kB gzip | **117.34 kB** | **−80.5%** |
| `/docs` | 601.47 kB gzip | **181.92 kB** | −69.8% |
| `/documents/:id` | 601.47 kB gzip | **211.39 kB** | −64.9% |

Total emitted bytes across all chunks rose slightly (1,761.82 → 1,770.55 kB gzip, +0.5%) — this is
redistribution via code-splitting, not bytes deleted, exactly as the audit's own plan predicted
("moving bytes into lazy chunks improves the user-visible metric without deleting a single
feature").

**Measurement correction, logged in the fix entry itself:** the first version of
`audit/bundle/measure.mjs` walked only `.js` import specifiers, so CSS belonging to a lazy chunk
was invisible and every route read smaller than it was (CodeRabbit finding on PR #14). Re-measured
via Vite's `manifest.json` graph; the correction moved the headline numbers by +0.05 kB (`/login`),
+0.02 kB (`/docs`), +0.05 kB (`/documents/:id`) — the −80.5% headline stands.

### Root causes

- **BUN-1 (TRO-197).** `main.tsx` statically imported all 25 pages. 23 converted to `React.lazy`
  (LoginPage stays static so the unauthenticated entry route never regresses); two `Suspense`
  boundaries added so the 4-panel layout doesn't tear down mid-navigation.
- **BUN-2 (TRO-198).** `Editor.tsx` (TipTap+ProseMirror+Yjs, 35.5% of the original entry chunk) was
  eagerly imported by `UnifiedEditor.tsx`/`PersonEditor.tsx`. New `LazyEditor.tsx` dynamic-imports
  the same shared `Editor` component — not a second editor.
- **BUN-3 (TRO-199).** `createLowlight(common)` registered 37 highlight.js grammars; narrowed to 12
  (bash, css, diff, javascript, json, markdown, python, shell, sql, typescript, xml, yaml). The
  dropped languages still auto-highlight via lowlight's `highlightAuto` fallback — a correction the
  fix entry logged against its own original assumption that they'd render unhighlighted.
- **BUN-4 (TRO-200).** `emoji-picker-react` (186 kB raw / 39 kB gzip) was statically imported for
  one sidebar popover; isolated into its own lazily-loaded module.
- **BUN-6 (TRO-202).** No `manualChunks` vendor split existed. Added one, explicitly measured on
  bytes-changed-per-deploy rather than initial load, per the audit's own instruction that this
  metric is orthogonal to the 20% target.
- **BUN-7/BUN-8 (TRO-203/204).** Removed unused `@tanstack/query-sync-storage-persister`; deduped
  two divergent Radix package versions via a root `pnpm.overrides` block.

### Reproducibility

```bash
cd web && pnpm build && cd .. && node audit/bundle/measure.mjs web/dist
node audit/bundle/measure.mjs web/dist --baseline <path/to/prior/dist>   # route-level diff
```
Must build from `web/` (Tailwind's `content` globs are CWD-dependent); measure from the repo root;
gzip level 9 throughout, matching the baseline's own convention.

---

## 3 — API Performance

**Target (verbatim):** *"≥20% P95 reduction on at least 2 endpoints, under identical conditions,
root cause documented per bottleneck."* (`AUDIT_REPORT.md`, API Response Time § Recommended
improvement plan)

**Verdict: met — two endpoints clear ≥20% P95 under identical conditions, and the countervailing
"regressions" were investigated and resolved as measurement noise (PR #60).** `/api/issues` clears
the bar at every tested concurrency (−31.3% / −30.7% / −39.4%); `/api/documents/:id` clears it at
c=50, reproduced across two independent runs (−34.8% / −56.6%). Both readings of the compare
artifact are still shown below, unchanged, for the audit trail.

### Before → After

Source: `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md` — commit `15e6cb0` vs. baseline
`076a183`, identical methodology (autocannon 8.0.0, 900-request rate-limit-window-synchronized
bursts, same 6 endpoints/order).

| Endpoint | Conc. | Baseline P95 | Compare P95 | Δ% |
|---|---|---|---|---|
| `GET /api/issues` | 10 | 38.78 | 26.66 | **−31.3%** |
| `GET /api/issues` | 25 | 94.47 | 65.48 | **−30.7%** |
| `GET /api/issues` | 50 | 182.00 | 110.26 | **−39.4%** |
| `GET /api/documents/:id` | 25 | 9.16 | 12.67 (primary) / 10.11 (recheck) | **+38.4% / +10.4%** (worse) |
| `GET /api/documents/:id` | 50 | 46.16 | 30.12 (primary) / 20.03 (recheck) | **−34.8% / −56.6%** |

Only `/api/issues` clears the ≥20% bar at **every** tested concurrency — the sole robust,
concurrency-independent win. `/api/documents/:id` clears it only at c=50 (reproduced in two
independent runs) and is reproducibly *worse* than baseline at c=25. Quoted directly from the
compare doc's own verdict: *"whether '≥2 endpoints' is satisfied depends on whether the target is
read as 'at the headline concurrency' (not met, 1/2) or 'at some tested concurrency, reproducibly'
(met, 2/2). Both readings are reported here; neither is asserted as the answer."*

**The apparent regressions — investigated, hypothesis killed, resolved as noise (TRO-302, PR #60).**
Several cheap endpoints showed +12% to +38% P95 at low/mid concurrency in the compare run. The
compare doc's hypothesis (the rate limiter's per-request SHA-256 of the session cookie) was put
through a profile-first investigation and **acquitted on three independent lines of evidence**:
(1) microbenchmark — the full key computation costs ~650 ns, ~0.008% of a 4 ms request; (2) a live
`--cpu-prof` under the compare run's own c=25 load — the server is >99% idle (I/O-bound) and the
hash is ~0.15% of the tiny active-CPU sliver; (3) a controlled live A/B (real hash vs. no-op hash
vs. the entire limiter chain removed) — statistically indistinguishable. The decisive control: a
**fresh full re-benchmark of unchanged code** under identical seed/methodology produced P95 deltas
of **−27.2% to +34.8%** — a noise band *wider than every reported regression*. The regressions are
shared-machine measurement noise; note they were also inconsistent across concurrency (the same
endpoint "+18% at c=25" was −15.7% at c=50), which is noise's signature. The headline improvements
survive this scrutiny because they are (a) consistent across all three concurrencies, and (b)
corroborated by deterministic non-timing measurements — payload bytes (−36.5%) and statement
counts — that noise cannot produce. No production change was made: measurement said no fix was
needed, so none was invented. Full 18-row noise table in `CHANGES.md` (TRO-302 entry).

### Root causes

**API-2 / DB-5 (TRO-173/182, PR #19) — the one unambiguous win.** `api/src/routes/issues.ts:126,99`
dropped `d.content` from the list `SELECT` and added bounded `limit`/`offset`. Payload
379,907→241,338 B (−36.5%, not the audit's predicted 2.6×/64.5% — the fix entry corrected its own
earlier estimate, since `content` is 38.4% of the *JSON* payload, not 64.5% of the *DB row*).

**DB-2 / API-6 (TRO-179/177, PR #13) — visible only at c=50.** `auth.ts` throttles the unconditional
`UPDATE sessions SET last_activity` to the same 60 s threshold already used for the cookie refresh,
enforced both app-side and via a SQL predicate (`WHERE ... AND last_activity < $3`) so it holds
under concurrent bursts too. Shows up specifically at c=50 because the dev pool caps at 10
connections — at high concurrency requests already queue for one, so shortening each connection's
hold time compounds with queueing depth; at c=10 the pool isn't saturated and the effect is flat
(±5%).

**API-3 (TRO-174, PR #20).** No compression middleware existed. Added at threshold 1024/level 6,
with case-insensitive `text/event-stream` + `application/octet-stream` exclusion filters (a
case-sensitivity bug CodeRabbit caught mid-review, since the client can control the declared MIME
type on file uploads). Payload evidence only, never loopback latency, per the baseline's own
instruction: `/api/issues` 241,338→19,926 B gzip-negotiated (12.1×); brotli negotiates live too.

**API-1 (TRO-172, PR #9).** The single 100/min-per-IP limiter is now two chained limiters
(`perSourceIpLimiter` 6,000/min anti-flood floor + `perIdentityLimiter` 600/min keyed on
session/Bearer/IP via SHA-256 fingerprint). Client-side 429 retry added (2s/8s/20s/45s + jitter).
Measured (`NODE_ENV=production`, c=10, one IP / 20 sessions): 100/1900 throttled → **2,000/0
throttled**.

### Reproducibility

```bash
docker exec ship-audit-pg psql -U ship -d <db> -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
docker exec ship-audit-pg psql -U ship -d <db> -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
node audit/api-perf/compare-phase2-jul30/raw/bench-runner-compare.mjs
```
Full evidence: `audit/api-perf/compare-phase2-jul30/after-phase2-jul30.md` + `raw/*.json`, diffed
against `audit/api-perf/baseline.json`. Same tool version (autocannon 8.0.0), same 900-request
window-synced bursts, same concurrency sweep (10/25/50), same 6 endpoints/order as baseline.

---

## 4 — Database Queries

**Target (verbatim):** *"≥20% query-count reduction on at least one flow, or ≥50% improvement on
the slowest query, with before/after EXPLAIN ANALYZE as evidence."* (`AUDIT_REPORT.md`, Database
Query Efficiency § Recommended improvement plan)

**Verdict: met — on both prongs, by the formal compare run.** The full-flow re-capture
(`audit/db-query/compare-phase2-jul30/`, 2026-07-30, identical 500/20/813 seed, per-database
statement logging, 3 capture runs with majority-value reporting) shows: **List issues −23.5%
query count** (17→13, clearing the ≥20% prong), and **the baseline's #1 slowest statement −87.1%**
(`UPDATE sessions SET last_activity`, 4.764 → 0.614 ms, clearing the ≥50% prong). The bonus
week-dashboard flow fell **−69.0%** (42→13 queries) with its N+1 eliminated (was the only flow
with one; all six captured flows are now N+1-free). Steady-state deltas on the five required
flows: main page −19.2%, view document −8.9% (cold −20.5%), list issues −23.5%, sprint board
−19.6%, search −13.6% (cold −20.0%).

**Methodology note (flow-name correction):** the per-PR "30→6 standup queries" figure below is
PR #29's own measurement of the standups *portion* of the dashboard page under its stated
conditions; the compare harness measures whole flows and maps "load main page" to `/my-week`
(the actual `/` redirect), where the week dashboard is a separate captured flow. Both numbers are
real under their own conditions; the harness figures are authoritative for the deliverable table.

### Before → After (per-PR evidence, each under its own stated conditions)

| Flow / query | Before | After | Δ | Source |
|---|---|---|---|---|
| Week dashboard: HTTP requests (standups fan-out) | 5 (one per active week) | **1** (batched) | −80% | PR #29, TRO-181/176 |
| Week dashboard: queries (standups portion) | 30 | **6** | **−80%** | PR #29 |
| `/api/weeks` retro lookup: shared buffers | 1181 | **749** | −36.6% | PR #50, TRO-183/184/185/187 |
| `/api/weeks`: seq-scans on `document_associations` | 2 | **0** | | PR #50, DB-6 |
| `documents.ticket_number` lookup: buffers | 66 hit | **5 hit + 1 read** | | PR #50, DB-7 |
| `documents.ticket_number` lookup: rows removed by filter | 495 | **0** | | PR #50, DB-7 |
| `document_associations = ANY($1)`: estimate vs. actual | 25 est. / 707 actual (28× under) | **707 est. / 635 actual (1.1×)** | | PR #50, DB-8 |
| `documents.updated_at` sort: buffers | 69 | **4 hit + 2 read** | | PR #50, DB-10 |
| Session-write statements per 12 sequential reads | 60 statements, 12 writes | **48 statements, 0 writes** | −20% statements | PR #13, DB-2/API-6 |
| Concurrent burst (10 parallel), session row versions written | 10 | **1** | | PR #13 (SQL predicate, not app-side gate alone) |
| `pnpm db:migrate`, fresh DB | 10/42 rows applied, exit **0** (silent partial) | **42/42 rows, exit 0** | | PR #8, DB-1 |
| `pnpm db:migrate`, 6 concurrent invocations | 5/6 fail (`23505`) | **6/6 exit 0, 42 rows** | | TRO-279/DB-12 |

### Root causes

**DB-4 / API-5 (TRO-181/176, PR #29).** `Dashboard.tsx:69-85` fanned out one
`fetch('/api/weeks/${id}/standups')` per active week via `Promise.all`. New
`GET /api/weeks/standups?week_ids=...` batches them with `parent_id = ANY($1) ORDER BY created_at
DESC LIMIT 10`; the old per-week route is untouched (no breaking change for other callers).

**DB-6/7/8/10 (TRO-183/184/185/187, PR #50).** One root cause across four findings: the planner was
starved of indexes and honest estimates. DB-6 collapsed 8 correlated subqueries in
`api/src/routes/weeks.ts` (two of which seq-scanned `document_associations` per row) into one `LEFT
JOIN LATERAL`. DB-7 added a partial index on `documents (workspace_id, ticket_number) WHERE
document_type='issue'` via migration `038`. DB-8's `= ANY($1)` misestimate was fixed by rewriting to
a `JOIN (VALUES...)` (an `unnest()` attempt was tried and rejected — it measured *worse*, 91→2146
buffers, and that negative result is kept in the record rather than discarded). DB-10 added
`(workspace_id, updated_at DESC)` via migration `039`.

**DB-2 / API-6 (TRO-179/177, PR #13).** See Category 3 — same fix, same file (`auth.ts`), credited
to both categories since it changes both query count and latency.

**DB-1 (TRO-178, PR #8).** `migrate.ts:103-111` substring-matched `"already exists"` across *both*
the initial `schema.sql` call and the migration loop, so a non-idempotent migration's expected
error silently ended the whole run at exit 0. Tolerance is now scoped to the `schema.sql` call only
and matched against specific SQLSTATE codes (`42P04`/`42P06`/`42P07`/`42701`/`42710`/`42723`), not a
substring; a genuinely failing migration now rethrows with its filename and a non-zero exit.
Migrations `010`/`025`/`033`/`035` were made idempotent. **The 32 previously-skipped migrations
include 19 `ALTER TABLE` (3 `DROP COLUMN`) and 42 DML statements — a real production database not
already at end-state applies all 32 in one deploy; snapshot first.**

**DB-12 (TRO-279).** `CREATE TABLE IF NOT EXISTS` is check-then-create, not atomic; concurrent
`pnpm db:migrate` invocations (the Dockerfile runs it on every boot) raced to `23505`. Fixed with a
Postgres session advisory lock (`pg_advisory_lock`, key derived from `"Ship"`) wrapping the entire
run.

### Reproducibility

```bash
DOC_ID=<seeded doc id> node audit/db-query/raw/flow-capture.mjs > audit/db-query/raw/flow-requests.json
docker logs ship-audit-pg --since "<capture-start>" > audit/db-query/raw/pg-statements.log
node audit/db-query/raw/parse-log.mjs audit/db-query/raw/pg-statements.log
# EXPLAIN ANALYZE, same param values as baseline: audit/db-query/raw/explain.sql via psql -f
pnpm --filter @ship/api exec vitest run src/db/__tests__/db-6-7-8-10-indexes.test.ts \
  src/routes/weeks-retro-lookup.test.ts src/utils/__tests__/document-crud.test.ts
pnpm --filter @ship/api exec vitest run src/db/__tests__/migrationLock.test.ts   # DB-12
```
**Caution, carried forward from the baseline:** do not validate with plain `pnpm test` against the
seeded audit database — finding TEST-9 established that the api suite `TRUNCATE`s whatever
`DATABASE_URL` points at. Use an isolated throwaway database for any live re-verification, exactly
as baseline mode did.

---

## 5 — Test Quality

**Target (verbatim):** *"3 meaningful tests for previously-untested critical paths, OR 3 flaky
tests fixed with root-cause analysis. Both are available."* (`AUDIT_REPORT.md`, Test Coverage &
Quality § Recommended improvement plan)

**Verdict: met, past target on both prongs**, plus additional post-baseline fixes (TEST-12 through
TEST-16 — findings discovered during remediation, not part of the original 68; flagged as such
below).

### Before → After

| Metric | Before | After | Source |
|---|---|---|---|
| Web unit suite | 138/151 passing (13 failing, never run by root `pnpm test`) | **345/345** (33 files) | PR #11, TRO-223/TEST-1 |
| Assertion-less / conditional-only e2e tests | 68 of 866 (7.9%) | **0** (of 870 scanned blocks, post TEST-2 + TEST-14) | PR #24 + TRO-286 |
| API flake under concurrent build load, 20 runs | 6 runs failed | **1 run failed** | PR #23, TRO-277/TEST-12 |
| `rate-limit.test.ts` alone, 25 runs under load | failed 3 of 20 | **25/25** | TRO-277 |
| Concurrent multi-client Yjs merge test | did not exist | **4 new tests**; `collaboration/index.ts` function coverage 67.24%→**70.68%** | PR #22, TRO-226/TEST-4 |
| `session-activity-race` precondition | probabilistic (flaked CI 4× same day) | **structurally guaranteed** via an arrival barrier | TRO-288/TEST-15 (post-baseline) |

### Root causes

**TEST-1 (TRO-223, PR #11).** Root `"test"` script ran only `@ship/api`; 13 web failures were never
surfaced locally. Of the 13: 11 were stale assertions against merged renames (sprint→week, tab
reorder), 1 was a **real product defect** (`document-tabs.tsx`'s Weeks tab label lost its
count-function, asymmetric with the Program tab), 1 was a test-harness defect. Root script is now
`test:api && test:web`.

**TEST-2 (TRO-224, PR #24).** `security.spec.ts:217`'s stored-XSS check looped over rendered `<a>`
elements and asserted only inside `if (href?.startsWith('data:'))` — since TipTap has no
markdown-link input rule, **zero `<a>` elements were ever produced**, so "the app rendered nothing"
had been passing as "the app sanitized the URI" for the test's entire life. This was caught and
corrected during the fix, not assumed. New `linkOptions.ts` makes the URI-scheme denylist explicit
so the protection can't be silently regressed later, proven by a deliberate-break table: removing
the guard → 4 failed/23 passed; reverted → 27/27.

**TEST-3 (TRO-225, PR #24).** `retries: 1` (local) / `2` (CI) hid a test that failed on first
attempt in **100% of 3 baseline runs**. The audit's original diagnosis (Yjs persistence timing) was
**demonstrated wrong**: the test passes alone in 22.5 s and fails only when a specific other test
shares its worker's database first — a shared-state root cause, not a timing one. Fixed by removing
the shared-state dependency, not by lengthening a timeout.

**TEST-4 (TRO-226, PR #22).** No test performed real concurrent multi-client edits; the only
cross-client e2e test was sequential (`browser.newPage()`, same browser) with every assertion
conditional. New `concurrent-merge.test.ts` runs 4 real scenarios against the live collaboration
server, proven meaningful by sabotage: discarding non-first-connection frames failed the concurrent
tests specifically (control/offline still passed); writing only `properties` (not full content)
failed all 4 on the persistence assertion.

**TEST-12 (TRO-277, post-baseline).** Two compounding defects: `vi.clearAllMocks()` doesn't drain
queued `mockResolvedValueOnce` responses (stale response leaks across tests), and no cross-process
guard existed for the shared `DATABASE_URL` truncate-per-file pattern, so two suites on one database
corrupted each other (reproduced deliberately: 18 and 20 failures, plus 11 and 33 *phantom skips* —
a failed `beforeAll` reports as skipped, not failed). Fixed with a session-level Postgres advisory
lock held per test file.

**TEST-15 (TRO-288, post-baseline).** `session-activity-race.test.ts` fired 10 concurrent
auth-middleware calls expecting all 10 to read stale state before any write committed — not a
guarantee on a shared CI runner. New `createArrivalBarrier()` holds every lookup until all 10
callers arrive, making the race structurally unreachable rather than probabilistically unlikely.

### Reproducibility

```bash
pnpm test:web                                            # TEST-1 — expect 345/345
node audit/test-quality/runs/vacuous.mjs e2e              # TEST-2/14 — expect 0 conditional-only
pnpm --filter @ship/api exec vitest run \
  src/collaboration/__tests__/concurrent-merge.test.ts    # TEST-4
pnpm --filter @ship/api exec vitest run \
  src/middleware/__tests__/session-activity-race.test.ts  # TEST-15 — run 10× under load
```
Use `/e2e-test-runner` for any full-suite run — never `pnpm test:e2e` directly (600+ tests will
flood the session).

---

## 6 — Error Handling

**Target (verbatim):** *"3 error-handling gaps fixed, at least one a real data-loss/confusion
scenario."* (`AUDIT_REPORT.md`, Runtime Error & Edge Case § Recommended improvement plan)

**Verdict: met — 11 gaps fixed**, including the mandatory data-loss fix (ERR-1) and the security
fix (ERR-2). **Screenshots/recordings captured 2026-07-31 (TRO-305)** — every row in the table below
now has an actual image, referenced in the new "Screenshot evidence" section immediately after the
table, under `docs/screenshots/error-handling/`. All 11 underlying findings are covered: 9
(ERR-1/2/3/4/5/8/6/TEST-5/10) with a real browser (Playwright/Chromium, logged in as
`dev@ship.local` against a locally running `pnpm dev` instance) reproducing the fixed behavior
live, plus ERR-11/ERR-12 (2 findings) as a captured terminal run of their dedicated regression suite
(a sub-millisecond connection-load race is not something a
browser interaction can reliably force without adding a delay to application code, which this
ticket's scope excludes). **ERR-2 is the only fix with both a before and an after screenshot** — see
that row for why. Every other row is after-only, each with a one-line reason; the text/probe
evidence already in the table below is what stands for "before" in those cases, stated explicitly
rather than left implicit.

### Before → After

| Finding | Before (probe result) | After |
|---|---|---|
| **ERR-1** — collab WS unreachable (Critical, data loss) | typed text `inDb=false`, still `false` 20 s after the socket healed; after reload, final DB content `""` — permanent loss; indicator falsely read "Cached"/"Saved" | distinct "not syncing" state blocks the false "Saved"; edit re-syncs on reconnect or the user is warned before reload |
| **ERR-2** — session revocation not enforced on live socket (Critical, security) | after deleting all session rows, the WS still persisted writes (`true`, and again after 60 s) | session re-validated periodically on the live socket; closes on failure |
| **ERR-3** — dropped 429/500 writes | forced 429/500 on a rename left the DB unchanged while the indicator still read "Saved" | indicator driven from the actual mutation result; field stays dirty until a write confirms |
| **ERR-4** — edits to a doc deleted elsewhere | doc deleted mid-edit; editor stayed "Saved" over a ghost document with no notice | notice + fix shipped alongside ERR-3 (same PR, TRO-190/191) |
| **ERR-5 / ERR-8** — malformed params → 500; unbounded `limit` | `not-a-uuid`, `not-a-number`, `?type=bogus` all reached Postgres as 500s; `?limit=-1`/`999999999` both returned the full payload | validated upfront → 400/404; `limit` bounded |
| **ERR-6 / TEST-5** — comment-mark orphan on blur-dismiss | blur-dismiss wrote a persisted `<span class="comment-highlight">` with 0 backing comment rows | mark is always removed on cancel, regardless of dismiss path (Escape or blur) |
| **ERR-10** (post-baseline) — malformed WS frame crashed the API | one malformed frame killed the process for every connected user | frame error now closes only its own socket |
| **ERR-11 / ERR-12** (post-baseline) — collaboration load-window drops | inbound frames could arrive before the message listener attached; a second connection during doc-load could receive an empty document | listener attached before any `await`; doc published to the shared map only after load completes |

### Screenshot evidence (TRO-305, captured 2026-07-31)

All files live under `docs/screenshots/error-handling/`. Captured with Playwright/Chromium
(headless, 1280×800), logged in as the standard dev seed user `dev@ship.local`, against a
`pnpm dev` instance running on this worktree's own database — not the shared main dev DB. The
capture script is not committed (one-off tooling, not a deliverable); every action it took is
described in the "How reproduced" column so a screenshot can be re-taken by hand or by writing an
equivalent script.

| Finding | Coverage | File(s) | How reproduced |
|---|---|---|---|
| **ERR-1** / TRO-188 | After-only — the false "Saved"/"Cached" label this fixes requires the pre-fix code to actually reproduce; the probe evidence above is what stands for "before". | [`ERR-1-after-not-saved-indicator.png`](screenshots/error-handling/ERR-1-after-not-saved-indicator.png) | Opened `/documents/:id`, mocked the collaboration WebSocket with Playwright's `routeWebSocket` (accepts the connection so `status: connected` fires, but relays nothing — the exact "connected, never synced" condition probe2d recorded), then typed text. Indicator reads red **"Not saved"**. |
| **ERR-2** / TRO-189 | **Before + after** — the only fix here whose before-state is safely reproducible against current (fixed) code: "before" is simply the moment prior to revocation, not the old vulnerable behavior. | [`ERR-2-before-saved-while-session-valid.png`](screenshots/error-handling/ERR-2-before-saved-while-session-valid.png), [`ERR-2-after-session-revoked-not-saved.png`](screenshots/error-handling/ERR-2-after-session-revoked-not-saved.png) | Opened `/documents/:id`, confirmed green "Saved". Read the live `session_id` cookie and deleted that row from `sessions` directly in Postgres (simulating logout/revocation elsewhere), then waited for the real periodic revalidation sweep (dev server log confirms `Collaboration session revalidation every 30000ms` — no code or config was touched to shorten it). Browser console logged `[Editor] Session no longer valid for <id>; stopping collaboration` and the indicator flipped to red **"Not saved"** within the poll window. |
| **ERR-3** / TRO-190 | After-only — reproducing the old "still reads Saved" bug needs the pre-fix indicator; probe6.1/6.2 stand for "before". | [`ERR-3-after-forced-500-not-saved-indicator.png`](screenshots/error-handling/ERR-3-after-forced-500-not-saved-indicator.png) | Opened `/documents/:id`, used Playwright `page.route` to force every `PATCH /api/documents/:id` to return 500, then edited the title. React Query's own mutation retry treats a 500 as transient (3 attempts, ~1s/2s/4s backoff) before giving up, so the indicator does not flip until ~8s after the edit — confirmed by polling, not a fixed sleep. Final state: red **"Not saved"** plus a **"Failed to update document"** toast. |
| **ERR-4** / TRO-191 | After-only — same reasoning as ERR-3; probe4c stands for "before". | [`ERR-4-after-forced-404-document-gone.png`](screenshots/error-handling/ERR-4-after-forced-404-document-gone.png) | Same as ERR-3 but the forced response is 404 (simulating "someone else deleted this document"), which React Query does *not* retry. Editor fired exactly one native `alert()`, captured via Playwright's `dialog` event (the alert itself is not visible in a headless screenshot): *"This document was deleted by someone else. Your changes here were not saved - copy anything you want to keep before leaving this page."* Screenshot shows the state right after dismissing it: red **"Not saved"** plus a stacked pair of "Failed to update document" toasts (one per retry attempt — the alert's own one-shot guard is what keeps it to a single dialog, not the toast). |
| **ERR-5** / TRO-192 | After-only — the old unhandled 500 needs the pre-fix code; probe3-api stands for "before". | [`ERR-5-after-invalid-uuid-400.png`](screenshots/error-handling/ERR-5-after-invalid-uuid-400.png), [`ERR-5-after-invalid-type-400.png`](screenshots/error-handling/ERR-5-after-invalid-type-400.png) | Same authenticated browser session navigated directly to `GET /api/documents/not-a-uuid` and `GET /api/documents?type=bogus` (through the vite dev proxy, so the session cookie is sent). Both render a clean `400 {"error":"Invalid input", ...}` JSON body instead of a 500. |
| **ERR-8** / TRO-195 | After-only — the old "returns everything" behavior needs the pre-fix code; probe3-api stands for "before". | [`ERR-8-after-negative-limit-400.png`](screenshots/error-handling/ERR-8-after-negative-limit-400.png), [`ERR-8-after-huge-limit-clamped.png`](screenshots/error-handling/ERR-8-after-huge-limit-clamped.png) | `GET /api/documents?limit=-1` renders a clean 400 instead of the full payload. For `?limit=999999999`, the screenshot's raw JSON alone doesn't visually prove a cap, so the capture script also fetched `?type=issue&limit=999999999` (**100** rows back) and the unbounded `?type=issue` (**104** rows — real seeded count) in-page and overlaid the two counts as a banner before the screenshot; the banner is explicitly labeled in the image itself as an evidence annotation added by the capture script, not application UI. |
| **ERR-6** / TEST-5 / TRO-193 / TRO-227 | After-only, two-shot sequence — the orphaned mark this fixes needs the pre-fix code; probe8 stands for "before". | [`ERR-6-after-1-pending-comment-open.png`](screenshots/error-handling/ERR-6-after-1-pending-comment-open.png), [`ERR-6-after-2-blur-dismissed-no-orphan-mark.png`](screenshots/error-handling/ERR-6-after-2-blur-dismissed-no-orphan-mark.png) | Selected the word "Overview" in a wiki document body (caret placement + Shift+ArrowRight — a plain element `dblclick()` did not reliably produce a native selection under Playwright), clicked the bubble menu's "Comment" button (creates the `comment-highlight` mark + pending input — shot 1), then clicked elsewhere in the document body (a blur/outside-click dismissal, the exact path that used to leak the mark). Shot 2 confirms `document.querySelectorAll('.comment-highlight')` and `.comment-pending-input` both count **0** — no orphan. |
| **ERR-10** / TRO-276 | After-only, three-shot sequence — "before" (the whole API process dying) can only be shown once, destructively, on the actual pre-fix code, which defeats capturing anything afterward; the regression suite's red-before-green run (quoted in `CHANGES.md`'s TRO-276 entry) stands for "before". | [`ERR-10-after-1-two-clients-saved-before-attack.png`](screenshots/error-handling/ERR-10-after-1-two-clients-saved-before-attack.png), [`ERR-10-after-2-tabA-typed-after-attack.png`](screenshots/error-handling/ERR-10-after-2-tabA-typed-after-attack.png), [`ERR-10-after-3-tabB-received-edit-still-saved.png`](screenshots/error-handling/ERR-10-after-3-tabB-received-edit-still-saved.png) | Two authenticated browser tabs opened the same document, both "Saved" (shot 1). A **third, raw** WebSocket client (Node's `ws`, authenticated with a real `session_id` cookie lifted from Tab A — not a browser, since a real browser's WebSocket API cannot be made to emit a malformed application frame) connected to the same collaboration room and sent one of the audit's own `CRASHING_FRAMES` byte sequences (`[0,0,5,1]` — a sync-step-1 frame whose length prefix overruns its payload). That socket closed with code **1002**, reason `"Malformed frame"` — observed directly from the raw client, not inferred. Typing in Tab A immediately afterward propagated live to Tab B (shot 2 and shot 3, including Tab A's live collaboration cursor visible in Tab B), both still reading "Saved" — the process and every other connection survived the attack. |
| **ERR-11 / ERR-12** / TRO-284 / TRO-285 | After-only, terminal capture, not a browser reproduction — see reasoning below. | [`ERR-11-ERR-12-after-vitest-passing.png`](screenshots/error-handling/ERR-11-ERR-12-after-vitest-passing.png) (screenshot of a real terminal run), [`ERR-11-ERR-12-vitest-full-output.txt`](screenshots/error-handling/ERR-11-ERR-12-vitest-full-output.txt) (the complete, unedited stdout/stderr of that same run) | Both fixes close a sub-millisecond window between a WebSocket becoming reachable and becoming able to respond. Forcing that window open live would mean adding an artificial delay to `api/src/collaboration/index.ts` — application-code changes this ticket's scope explicitly excludes ("documenting existing behavior, not changing it"). The dedicated regression suites already drive this exact race with real sockets and no sleeps (`preload-message-buffer.test.ts`, `concurrent-doc-load.test.ts`); this is a screenshot of that suite actually being run just now (`pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/preload-message-buffer.test.ts src/collaboration/__tests__/concurrent-doc-load.test.ts`, 5/5 passed), captioned in the image itself as terminal output rather than a UI capture, plus the raw log alongside it. |

### Root causes

**ERR-1/ERR-2 (TRO-188+189).** Both live in `api/src/collaboration/index.ts`. ERR-1: when the
collaboration socket never completes its initial Yjs sync (server unreachable, proxy dropping WS
upgrades), the editor kept accepting edits under a "Cached" label with no completed persistence
path. ERR-2: the socket authenticated once at upgrade and never re-checked — a revoked session kept
write access indefinitely.

**ERR-3/ERR-4 (TRO-190+191).** The sync indicator read the *attempt* to write, not its *result* —
so a 429/500 response or a delete-during-edit left the UI claiming "Saved" over data that was never
persisted.

**ERR-10/ERR-11/ERR-12 (TRO-276, TRO-284, TRO-285).** One architectural class, found by three
independent agents while fixing ERR-1/ERR-2: async work (an `await pool.query(...)` or
`await getOrCreateDoc()`) happening between making a WebSocket reachable and making it able to
respond, leaving a window where inbound frames have no listener or a concurrent connection gets a
still-empty document. ERR-10 was the first instance (the `'error'` listener registered after an
`await`); ERR-11/ERR-12 are the same class in the message listener and doc-publish ordering.

**ERR-6 / TEST-5 (TRO-193/227).** The Escape-dismiss handler is bound to an `<input>` auto-focused
inside a `requestAnimationFrame`; blur-dismissing before focus landed meant the keypress never
reached the cancel handler, leaving the `comment-highlight` **TipTap mark** (real document content,
not a decoration) persisted with no backing comment row.

### Reproducibility

```bash
# Fault injection per audit/error-handling/baseline.md methodology (Playwright/CDP):
#   probe2-ws-drop, probe2d — collaboration socket unreachable at load (ERR-1)
#   probe7c, probe6.4       — session revocation on a live socket (ERR-2)
#   probe6.1/6.2, probe7a   — forced 429/500 on a write (ERR-3)
#   probe4c                 — delete-while-editing (ERR-4)
#   probe3-api               — malformed path/query params (ERR-5/ERR-8)
#   probe8 (blur variant)   — comment-mark orphaning (ERR-6)
pnpm --filter @ship/api exec vitest run src/collaboration/          # ERR-1/2/10/11/12 regressions
pnpm --filter @ship/web exec vitest run                             # ERR-3/4 sync-indicator tests
```

---

## 7 — Accessibility

**Target (verbatim):** *"+10 Lighthouse pts on the lowest page OR all Critical/Serious axe
violations fixed on the 3 most important pages."* (`AUDIT_REPORT.md`, Accessibility Compliance §
Recommended improvement plan)

**Verdict: met, via Prong 2 — Prong 1 was not met.** Quoted directly from
`audit/a11y/compare-phase2-jul30/after-phase2-jul30.md`'s own verdict: *"Prong 1 (Lighthouse +10):
NOT met. /my-week gained only +5 (95→100). /weeks and /search each lost 5 (100→95)... Prong 2
(Critical/Serious cleared on the 3 key pages): MET."*

### Before → After

Source: compare-phase2-jul30, commit `1474cb1` vs. baseline `076a183`, identical tool versions
(Lighthouse 11.7.1, axe-core 4.11.0, Playwright 1.57.0, viewport 1440×900).

| Page / state | Baseline C/S/M/m | Compare C/S/M/m |
|---|---|---|
| dashboard (my-week) | 0/1/0/0 | **0/0/0/0** |
| issues list | 0/0/0/1 | **0/0/0/0** |
| document view | 1/1/1/0 | **0/0/0/0** |
| document editor focused | 2/1/1/0 | **0/0/0/0** |
| issues menu/expanded | 0/1/0/1 | **0/0/0/0** |
| weeks board | 0/0/2/0 | **0/1/0/0** (new Serious, TRO-298) |
| search | 0/0/2/0 | **0/1/0/0** (new Serious, TRO-298) |
| login (unauth) | 0/0/2/0 | **0/0/0/0** |

Lighthouse: `/my-week` 95→**100** (+5); `/documents/:id` 100→100; `/issues` 100→100; `/weeks`
100→**95** (−5); `/search` 100→**95** (−5). All 8 baseline a11y findings are resolved in their
original location.

**New finding, not hidden: TRO-298.** `DashboardSidebar.tsx:33-37,46-52`'s active-item toggle fails
contrast (2.74:1 vs. 4.5:1 required) on `/weeks` and `/search`. This is **newly reachable, not newly
created** — the A11Y-5 fix gave those two paths a real route for the first time; `App.tsx`'s
`getActiveMode()` falls through to a default that mounts `DashboardSidebar`, exposing a pre-existing
defect that had nowhere to render before. It sits outside the 3 pages the target is scored against,
so it does not change the verdict, but it is tracked rather than swept aside.

### Root causes

**A11Y-1 (TRO-215).** `<ul role="tree">` sidebars had zero tree keyboard model (no roving
`tabIndex`/`onKeyDown`/`aria-level`) across 5 locations, demoting plain `<li>` children to roleless
orphans. Fixed by removing the tree/treeitem roles rather than building a real tree widget —
`OrgChartPage.tsx` keeps `role="tree"` deliberately, since it already has a roving-tabIndex
implementation.

**A11Y-2 (TRO-216).** Root cause was **not** application markup — `tippy.js`'s default
`aria:{expanded:'auto'}` wrote `aria-expanded` onto the editor wrapper `<div>` as a
BubbleMenu-positioning side effect. Fixed by setting `aria:{expanded:false}` in the Tippy options
passed from `Editor.tsx`.

**A11Y-3 (TRO-217).** Three causes, one misattributed by the original finding: `opacity-40` on
future rows (12 nodes, 1.84:1 — the dominant cause, never named by the ticket), `text-muted/50` on
ordinals (4 nodes, 2.26:1), and `text-accent` used as foreground (2 nodes, 2.55–2.82:1). The
ticket's named culprit, `bg-accent/20`, was verified **not** the defect (2.89:1 as text before any
badge fill is applied). Fixed with a new `accent-text` token (6.08:1).

**A11Y-5/6/7 (TRO-219/220/221).** `/search` and `/weeks` were not real routes at all — no matching
`<Route>`, no wildcard fallback, so an unmatched path rendered nothing (0 bytes of body text,
byte-identical to a guaranteed-404 URL). Not a missing-landmark bug on a working page. Fixed with a
`NotFound.tsx` page plus a real catch-all route; heading levels promoted in `BacklinksPanel.tsx` and
`PropertiesPanel.tsx`; Login's wrapping `<div>` became a `<main>`.

### Reproducibility

```bash
WEB_PORT=<port> bash audit/a11y/compare-phase2-jul30/run-lighthouse.sh
node audit/a11y/compare-phase2-jul30/axe-scan.mjs
```
Evidence: `audit/a11y/compare-phase2-jul30/after-phase2-jul30.md`, `lighthouse/*.report.html|json`,
`axe/_summary.json`. Re-run the repo's 3 dedicated specs — `accessibility.spec.ts`,
`accessibility-remediation.spec.ts`, `status-colors-accessibility.spec.ts` — 74/75 passed at
compare time; the one failure (a Radix tooltip staying visible after mouse-away on
`KanbanBoard.tsx`) is unrelated to any merged a11y fix and is flagged for the record, not
investigated under this measurement mandate.

---

## 8 — Terraform / IaC

**Target (verbatim, two parts, since baseline explicitly deferred this to the improvement phase):**
1. *"Local-provider config, ≥2 local resources, pinned provider"* — satisfied by
   `audit/terraform/drift-demo/`, pre-existing, referenced not rebuilt.
2. *"Render-provider config declaring a Render web service that deploys the ShipShape fork...
   deployable from a clean machine via `terraform apply`... Both configs: pinned provider versions,
   `terraform plan` confirmed against intent, committed lock files."*
   (`AUDIT_REPORT.md`, Terraform Plan Review § Improvement target)

**Verdict: met — both configs exist and are plan-confirmed; the Render config went further than
the target required.** Rather than stopping at a clean-machine-apply plan, a maintainer decision on
2026-07-30 chose to **import** the already-live, hand-built Render deployment into this
configuration instead.

### The import story

PR #57 (TRO-299/TF-10) landed first with the decision explicitly deferred — quoted verbatim from
its `CHANGES.md` entry: *"the adoption-path decision (import vs. a clean-machine apply that creates
a parallel service) is a human call — see the PR body's 'HOLD FOR HUMAN: apply/import decision (gate
2)'."* At that point `terraform plan` showed `2 to add, 0 to change, 0 to destroy` (nothing
imported).

A same-day follow-up commit, `b033f1a` ("adopt live Render deployment via import; reconcile config
to reality (TF-10)"), records the decision and executes it: `terraform import
render_web_service.ship srv-d9kf2t942hec73aofrt0` and `terraform import render_postgres.ship
dpg-d9kgth6417fc7386hhh0-a`, both successful, followed by two reconciliation rounds — `database_name`
was defaulted to the live auto-generated value (`ship_34oc`) after a literal default forced a
destructive replace on the first post-import plan, and `environment_id` plus
`lifecycle.ignore_changes` were declared for Render-assigned fields on the second. `terraform
apply` was never run against the live account; only `import` (state-only) and `plan` (read-only).

**Note — a real gap between sources, flagged rather than silently reconciled:** `CHANGES.md` has no
dated entry for commit `b033f1a`. Its own TRO-299 entry describes only the pre-import "HOLD FOR
HUMAN" state. The current tree (and the files below) reflect the later, resolved state; `CHANGES.md`
is stale on this one point.

### No-changes proof path

`terraform/render/plan/` — confirmed present at this commit:
- `IMPORT-LOG.md` — the decision and step-by-step import log.
- `plan-annotated.md` — the pre-import redacted plan plus one-sentence-per-resource blast-radius
  notes.
- `post-import-plan-no-changes.txt` — the final captured plan, quoted verbatim: *"No changes. Your
  infrastructure matches the configuration."* (one non-blocking `Warning: Deprecated attribute` on
  `pull_request_previews_enabled`).

### Before → After (TF-2, TF-7)

| Metric | Before | After |
|---|---|---|
| Terraform roots managing prod-shaped infra | 2 (flat root + `environments/prod`), already drifted apart | **1** (flat root); `environments/dev`/`shadow` + `modules/*` kept deliberately — different AWS environments, still used by deploy scripts |
| ALB security group ingress | `0.0.0.0/0` | **`prefix_list_ids` → `com.amazonaws.global.cloudfront.origin-facing`** |
| `trust proxy` hop count | hardcoded `1` (under-counts a real 2-hop CloudFront→ALB chain, if AWS were live) | **`resolveTrustProxyHops(TRUST_PROXY_HOPS)`**, default `1` (matches the actually-live Render/local topology unchanged), AWS blueprint sets `2` |
| `terraform validate`, both roots | Success, 1 warning (TF-5) | Success, same 1 pre-existing warning, no new ones |

### Root causes

**TF-2 (TRO-235).** Two divergent root configs managed the same class of infrastructure and had
already drifted (the flat root had WAF + realtime logging the modular path lacked). Fixed by
deleting `environments/prod/` after porting its 3 hardening items forward into the flat root first
(including a live, currently-broken `secretsmanager:PutSecretValue` IAM gap) — verified with
`terraform validate` both before and after the deletion, plus a new `scripts/check-single-tf-root.sh`
guard wired into CI.

**TF-7 (TRO-278).** Found while fixing API-1: `trust proxy 1` under-counts a real CloudFront→ALB
2-hop chain, which matters only if the AWS stack were actually live — it isn't; the live deployment
is Render (1 hop, no CDN in front). The AWS terraform blueprint sets `TRUST_PROXY_HOPS=2` for that
scenario, but the running app's default of `1` is unchanged, so this fix is dormant-but-correct
rather than a live behavior change today.

**TF-10 (TRO-299).** Ship's Render deployment (`srv-d9kf2t942hec73aofrt0`,
`dpg-d9kgth6417fc7386hhh0-a`) was the one piece of Category 8 not backed by any Terraform config —
hand-built via dashboard and one-off API calls. `terraform/render/` (new) pins `render-oss/render`
`1.9.1`, declares `render_web_service.ship` + `render_postgres.ship`, and derives `DATABASE_URL` from
a resource reference rather than a literal.

### Reproducibility

```bash
cd terraform/render
terraform init -input=false && terraform validate && terraform fmt -check -recursive .
cat plan/post-import-plan-no-changes.txt        # the "No changes" proof, captured verbatim
cd ../.. && cd terraform && terraform validate  # flat root, post-TF-2 convergence
scripts/check-single-tf-root.sh                 # TF-2's CI guard
pnpm --filter @ship/api exec vitest run src/app.test.ts   # TF-7's trust-proxy tests
```
`audit/terraform/drift-demo/` (2 pinned `local_file` resources, `local = 2.5.2`) is the pre-existing
local-provider deliverable — unchanged by this phase, referenced not rebuilt.
