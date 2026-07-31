# API Response Time — Compare (documents-pagination-jul31)

**Category** `api-perf` · **Mode** `compare` · **Label** `documents-pagination-jul31` · **Date** 2026-07-31
**Commit** `2ca800ae47b1fef0368bb86869de19e602297571` (`main`, worktree branch `fix/api-3-documents-pagination`
carries the change under test as an uncommitted-then-committed diff — see "Methodology" for how before/after
was isolated without `git stash`)
**Baseline for this doc**: the *same* endpoint, *same* seed, on the code as it stood immediately before
TRO-304's fix — not `audit/api-perf/baseline.json` (2026-07-27) or the phase2 compare
(`compare-phase2-jul30/after-phase2-jul30.md`, 2026-07-30). Those two already established that
`GET /api/documents` had no pagination as of their measurements; this doc measures the delta of adding it.
**Data volume** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person /
15 project / 15 weekly_review / 6 standup / 5 program), 20 users — verified via the same
`SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC` check the existing compare docs
use, byte-identical to both prior docs' seeded distribution (deterministic `seed-augment.ts`, reproduced fresh
for this measurement after this worktree's own test runs had TRUNCATEd the database — see "A seeding
correction" below).

---

## Methodology

**Environment.** Apple Mac16,7 (arm64), 14 cores, Darwin 25.5.0, Node v23.2.0 — same machine as both prior
docs. Worktree `Ship-wt-tro_304` on branch `fix/api-3-documents-pagination`, exclusive database
`ship_wt_tro_304` on `ship-audit-pg` (postgres:15-alpine, `:5433`), same container the baseline and phase2
compare used. Query logging confirmed OFF (`log_statement=none`, `log_min_duration_statement=-1`) before
measuring. `api/.env.local` sets `NODE_ENV=development` explicitly, same as phase2 compare's documented
condition; confirmed empirically via `RateLimit-Limit: 1000` on a live probe, matching the dev ceiling both
prior docs measured against.

**One difference from phase2 compare, stated plainly:** that run had "six-plus sibling worktree API dev
servers... present but idle" during measurement. This run had none — `ps aux` showed no other `tsx watch`/api
process running. Background load average was 3.88 (1-min) at measurement time, within the phase2 compare's
observed 2.2–6.2 range, but the absence of idle sibling processes is a real, if probably immaterial,
environmental difference from that doc and is disclosed here rather than assumed not to matter.

**Server mode / rate limiter.** Identical to phase2 compare: `perSourceIpLimiter` (10,000/min dev) then
`perIdentityLimiter` (1,000/min dev, keyed on the session cookie). One session cookie was reused for every
request in both the before and after runs, so all traffic landed in one `perIdentityLimiter` bucket — same
window-synchronization design as both prior docs, unchanged.

**Runner.** `audit/api-perf/documents-pagination-jul31/raw/bench-runner-documents.mjs` reuses
`compare-phase2-jul30/raw/bench-runner-compare.mjs`'s methodology **unmodified**: same 900-request bursts, an
80-request discarded warmup at c=10, autocannon 8.0.0, concurrency [10, 25, 50], identical exact-percentile
computation from raw per-response latencies, identical discard/retry-on-non-2xx protocol. It is a copy, not an
edit, for the same reason `bench-runner-compare.mjs` was itself a copy of the original `bench-runner.mjs`: the
prior file's hardcoded scratchpad path, output directory, API port, and cookie file are specific to a
different session and worktree and cannot resolve here (`API_PORT=3813` per this worktree's `.factory-env`).
Diff against `compare-phase2-jul30/raw/bench-runner-compare.mjs` to verify only those constants, plus the
`ENDPOINTS` array (scoped to one endpoint) and a `before`/`after` label, differ.

**Scoped to one endpoint.** Unlike the phase2 compare (all 6 `keyEndpoints`), this run measures only
`GET /api/documents` (no query params) — the exact call TRO-304 changes, and the exact call
`bench-runner-compare.mjs` already showed was unaffected by any prior fix (phase2 compare: +8.4%/+5.7%/+4.1%
P50 at c=10/25/50, i.e. mildly *worse* than the original 2026-07-27 baseline, with the note "never targeted by
a payload-reducing fix"). The other 5 endpoints are untouched by this ticket's diff and were not re-measured.

**Before/after isolation without `git stash`.** Factory rule 9 prohibits `git stash` in this worktree (shared
stash ref across concurrent worktrees). Instead: the fixed `api/src/routes/documents.ts` and
`api/src/openapi/schemas/documents.ts` were copied aside to the scratchpad, `git checkout -- <those two
files>` reverted the working tree to the pre-fix version (tracked in `git diff` against `HEAD`, i.e. the
version this ticket started from), the API dev server was restarted, and the "before" burst set was captured.
The two fixed files were then copied back from the scratchpad (verified via `git status --short` showing them
modified again), the server was restarted again, and the "after" burst set was captured. No other file
changed between the two runs. Same server process lifecycle both times (`pnpm --filter @ship/api dev`, i.e.
`tsx watch src/index.ts`), same already-seeded database, same session cookie (obtained once, before either
run, and confirmed still valid — session TTL is 15 minutes of activity, well inside the ~4-minute total
measurement window).

**A seeding correction, disclosed for provenance.** Before this measurement, this worktree's own regression
test files (`documents-pagination.test.ts`, `param-validation-regression.test.ts`,
`documents-visibility.test.ts`, `documents.test.ts`, `documents-query-count.test.ts`) were run directly via
`npx vitest run <files>` to confirm red-before-green. `api/src/test/setup.ts`'s `beforeAll` TRUNCATEs 16
tables including `workspaces` on **every** test file, not only via `pnpm test` — running individual test
files has the identical effect. This wiped the seeded corpus, exactly the failure mode standing rule 2 warns
about ("benchmark BEFORE running the full suite"). It was caught before benchmarking (a `GET /api/documents`
login probe failed with `INVALID_CREDENTIALS` because `dev@ship.local` no longer existed), not after: `pnpm
db:seed` was re-run, followed by `audit/seed-augment.ts`, which itself surfaced a second latent issue — a
leftover orphaned workspace from a test file whose `afterAll` had not run in that combined session caused
`seed-augment.ts` to pick the wrong (emptied) workspace and crash on an undefined `.id`. That orphaned
workspace and its rows were deleted by hand (`DELETE ... WHERE workspace_id = '<orphan-id>'` across
`sessions`, `document_associations`, `documents`, `workspace_memberships`, `users`, `workspaces`, run in that
FK-safe order), leaving exactly one workspace, then `db:seed` + `seed-augment.ts` were re-run cleanly. The
resulting distribution (verified via the `GROUP BY` query above) is byte-identical to both prior docs'. This
is reported here rather than silently smoothed over — it is exactly the kind of "verified under what
conditions" gap CLAUDE.md's claim-provenance section asks to be surfaced, not asserted away.

**2xx confirmation.** All 6 burst/concurrency combinations (before: 3, after: 3; 5,400 requests total)
completed at 100% 2xx, 0 errors, 0 timeouts, 0 non-2xx on the **first** attempt — no discard/retry needed in
either run (raw JSON: `audit/api-perf/documents-pagination-jul31/raw/before-documents-all-c{10,25,50}.json`,
`after-documents-all-c{10,25,50}.json`).

**Test suite.** Not run between seeding and benchmarking, and not run again until after this document was
written — running any api test file truncates the database, exactly as it did earlier in this session (see
above). The regression tests added for this ticket (`api/src/routes/documents-pagination.test.ts`,
`web/src/hooks/useDocumentsQuery.test.tsx`, `web/src/components/CommandPalette.test.tsx`) were confirmed
red-before-green *before* this seeding/benchmarking pass, against the same copy-aside before/after code
swap described above, then the database was re-seeded fresh for the benchmark itself.

**Reproduce:**
```bash
docker exec ship-audit-pg psql -U ship -d ship_wt_tro_304 -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
docker exec ship-audit-pg psql -U ship -d ship_wt_tro_304 -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
node audit/api-perf/documents-pagination-jul31/raw/bench-runner-documents.mjs before   # run against pre-fix code
node audit/api-perf/documents-pagination-jul31/raw/bench-runner-documents.mjs after    # run against post-fix code
```

---

## Deliverable table — before vs after, `GET /api/documents` (no params)

Latency in ms. **P95 at concurrency 25 is the headline column** (matches how both prior docs framed their
headline). Negative % = faster after the fix.

| Conc. | P50 before → after (Δ%) | **P95 before → after (Δ%)** | P99 before → after (Δ%) |
|---|---|---|---|
| 10 | 27.545 → 6.429 (**−76.7%**) | **40.127 → 9.662 (−75.9%)** | 47.108 → 10.649 (−77.4%) |
| 25 | 65.456 → 16.517 (**−74.8%**) | **73.975 → 24.719 (−66.6%)** | 83.28 → 35.772 (−57.1%) |
| 50 | 146.006 → 32.15 (**−78.0%**) | **292.14 → 42.435 (−85.5%)** | 344.59 → 60.846 (−82.3%) |

**Payload size** (autocannon's own per-response byte count, `meanBytesPerResponse`, no `Accept-Encoding`
header sent — same measurement basis phase2 compare used for its burst-time bytes/response):

| Metric | Before | After | Δ% |
|---|---|---|---|
| `GET /api/documents` bytes/response | 295,020 B | 53,927 B | **−81.7%** |
| Row count returned | 500 | 100 | −80.0% |

Cross-checked with a direct `curl --compressed off` content-length (body only, no headers, so it differs
from autocannon's per-response byte count by a small constant): 293,845 B before (`?limit=500`, i.e. the
full corpus at this endpoint's new explicit ceiling) vs 52,754 B after (default, no params) — consistent with
both prior docs' baseline/compare figures for this same endpoint (293,891 B / 293,827 B), confirming the
byte-identical seed once again.

**Full raw autocannon output**: `audit/api-perf/documents-pagination-jul31/raw/{before,after}-documents-all-c{10,25,50}.json`.

---

## Target verdict

**Target:** ≥20% P95 reduction on at least 2 endpoints, identical conditions.

**This document's contribution to that target:** `GET /api/documents` now clears the ≥20% P95 bar at
**every** tested concurrency, by a wide margin — 75.9% (c=10), 66.6% (c=25), 85.5% (c=50). This is not a
borderline or concurrency-dependent result like `documents/:id`'s in the phase2 compare; every percentile
(P50/P95/P99) at every concurrency improved by at least 57%, with no discards or retries needed at any
combination.

**Combined with phase2 compare's own finding:** `GET /api/issues` already robustly clears ≥20% P95 reduction
at every concurrency (−31.3% / −30.7% / −39.4% at c=10/25/50, `compare-phase2-jul30/after-phase2-jul30.md`).
`GET /api/documents` now does too, at every concurrency, by a larger margin. **Reading the category target as
"≥2 endpoints, robustly, at every tested concurrency" — the stricter of the two readings phase2 compare left
open — it is now met: 2/2.** This does not retroactively change phase2 compare's own verdict about the state
of the world on 2026-07-30 (which was, correctly, "not met" under the strict headline-concurrency reading,
"met" only under the looser "at some concurrency" reading, with `documents/:id` as the second endpoint). It
states plainly that TRO-304's fix, measured today, closes the gap phase2 compare identified as still open —
matching that document's own "Recommended follow-up" #2, which predicted "~65% P95 reduction" for this exact
change. The measured reduction (66.6%–85.5% depending on concurrency) meets or exceeds that prediction at
every concurrency tested.

**No concurrency where the target is not cleared.** Unlike phase2 compare's `documents/:id` finding (worse at
c=25, much better at c=50), this fix is uniformly and substantially positive across the full concurrency
sweep — there is no percentile or concurrency in this measurement where the improvement is marginal, absent,
or reversed.

---

## Why the fix produces this result

`api/src/routes/documents.ts`'s list route previously applied a `LIMIT` clause only when the caller passed an
explicit `limit` query param — an omitted `limit` meant "every matching row" (up to 500 at this seed volume).
The fix (`DEFAULT_DOCUMENTS_LIST_LIMIT = 100`) applies a `LIMIT` unconditionally, defaulting to 100 when
`limit` is absent. This is the same class of fix phase2 compare identified for `GET /api/issues` (API-2:
"cutting payload size directly cuts the JSON.stringify + write cost that dominated its latency") — a
sub-millisecond query returning 254 or 500 rows was never the bottleneck; serializing and writing that many
rows to the socket was. Cutting the default row count 500 → 100 (−80%) cuts payload 295,020 → 53,927 bytes
(−81.7%), and the measured P95 reduction (66.6%–85.5%) tracks that payload reduction closely, exactly as
API-2's mechanism predicted for a serialization-bound endpoint.

The larger-than-linear P95 improvement at c=50 (−85.5%, vs −80% row-count reduction) is consistent with
phase2 compare's own DB-2/API-6 finding about connection-pool queueing at high concurrency (`pool: max 10` in
dev): a smaller per-request payload shortens each connection's hold time, which compounds with queueing depth
as concurrency rises past the pool size. This is offered as the same plausible mechanism phase2 compare used
for its own concurrency-dependent finding, not as a newly profiled root cause — flagged as inference, not
measurement, consistent with that document's own disclosure standard for unverified hypotheses.

---

## Scope note

This measurement covers only `GET /api/documents` with no query params — the one call this ticket's fix
changes the default behavior of. It does not re-measure the other 5 `keyEndpoints` phase2 compare covered
(`documents?type=wiki`, `issues`, `documents/:id`, `team/assignments`, `weeks`); none of their route code
changed in this ticket's diff, so there is no reason to expect their numbers to move, and none were
re-benchmarked to avoid an unsupported claim either way.
