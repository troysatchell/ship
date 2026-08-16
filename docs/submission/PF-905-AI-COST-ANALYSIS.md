# PF-905 — AI Cost Analysis

**Scope:** PLUGFORGE.MD §4 PF-905 — figures traceable to ledger/CI data, not vibes. This is a
**different, W6-scoped document** from `docs/submission/AI-COST-ANALYSIS.md` (the W4 audit-sprint's
factory-tooling spend report — Claude Code session cost, not this platform's LLM/infra footprint).
Do not confuse the two.

**Method note, read before the numbers below:** every figure in this document is tagged
**OBSERVED** (measured directly, this session, against a real artifact), **DERIVED** (computed from
a real schema/config value, arithmetic shown), or **ASSUMED** (an explicit, named business
assumption with stated rationale — not measured, and never presented as if it were). §2.1 was
originally a **TODO** placeholder per this ticket's own scope constraint and was filled in with
**MEASURED** ledger rows by TRO-620 (2026-08-16). Nothing below is a number pulled from memory of
"what these things usually cost."

---

## 1. Platform is LLM-free — corrected

PLUGFORGE.MD §4's framing for this ticket states the premise as: *"Platform is LLM-free (state it;
the only LLM path remains user-initiated agent turns)."* **That premise does not hold as stated.**
Reading the actual code (not the PRD's summary of it) turns up **two** independent LLM call paths,
not one:

### 1a. FleetGraph / agent turns — user-initiated, as PLUGFORGE.MD describes

`agent/src/graph.ts` calls the **Anthropic API directly** via `@langchain/anthropic`'s
`ChatAnthropic` (confirmed by that file's own header: *"Model provider: Anthropic API directly...
accounting matches billing through the Anthropic API, not Bedrock"*). Real call sites — every one a
`model.invoke(...)` inside a distinct graph node (`respond`, `composeAnswer`, `composeStandupDraft`,
and others) — are at `agent/src/graph.ts:1348, 1545, 1593, 1721, 1828, 1932`. These only fire on a
user-initiated chat turn or a proactive-detection trigger; this part of PLUGFORGE.MD's premise is
correct.

### 1b. Weekly plan/retro AI quality scoring — NOT user-initiated in the agent sense, and NOT part of Epic 7

`api/src/services/ai-analysis.ts` calls **AWS Bedrock** (`InvokeModelCommand`, model id
`global.anthropic.claude-opus-4-5-20251101-v1:0`) directly from the base platform's own request
path — `POST /api/ai/analyze-plan` and `POST /api/ai/analyze-retro`
(`api/src/routes/ai.ts`). This fires automatically whenever a user edits a weekly plan or retro
document and its content changes (debounced client-side, server-side rate-limited to 120
requests/hour/user — `RATE_LIMIT` constant, `ai-analysis.ts:39`). It is wired to two live UI
components: `web/src/components/PlanQualityBanner.tsx` and
`web/src/components/sidebars/QualityAssistant.tsx`, both calling those two routes directly.

This feature **predates the Week 6 PlugForge epics** — its earliest commit is `8c0de05` ("feat:
Performance review enhancements — Request Changes + AI quality assistants (#169)"), dated **Feb 11
2026**, roughly six months before this sprint's E0–E9 work started. It is not part of the FleetGraph
agent-identity model (PF-700/PF-702/PF-704) at all — it's a standing, always-on Ship feature that
happens to also call an LLM, and it uses a **different provider** (Bedrock/Opus 4.5) than the agent
path (direct Anthropic API).

**Corrected statement for the record:** the platform makes *no* LLM calls in its core
document/issue/sprint CRUD or collaboration paths — that much of "LLM-free" is true and traceable
(no LLM import anywhere under `api/src/routes/documents.ts`, `issues.ts`, `projects.ts`,
`collaboration/`). But two LLM call paths exist in the shipped system, not one: FleetGraph agent
turns (Anthropic API, user- or detection-initiated) and plan/retro quality scoring (Bedrock, content-
change-triggered, no user "turn" involved). Both gracefully degrade to a no-op when their respective
credentials are unavailable (`ai-analysis.ts`'s `getClient()` catches init failure;
`agent/src/config.ts`'s own comment notes `/ready` requires `anthropicApiKey`).

---

## 2. Dev-cost tracking

### 2.1 LLM spend during Epic 7 (cost-ledger before/after)

**MEASURED (TRO-620, 2026-08-16) — real ledger rows, not estimates.** Full method, setup and the
per-turn table live in `docs/submission/PF-704-COST-LEDGER-DELTA.md` ("Measured: matched workload,
both modes"); the raw ledgers are committed as
`docs/submission/cost-ledger/tro-620-{internal,sdk,sdk-before-fix}.jsonl`. Summary:

| Configuration (same seed doc, same 3 questions, `claude-haiku-4-5-20251001`) | Docs in context | Input tokens (3 turns) | Output tokens (3 turns) | Input Δ vs internal |
|---|---:|---:|---:|---:|
| `AGENT_PLATFORM_MODE=internal` | 12 / turn | 1274 | 637 | — |
| `AGENT_PLATFORM_MODE=sdk`, after TRO-620 (`getDocument` passthrough) | 12 / turn | 1274 | 619 | **0.0%** |
| `AGENT_PLATFORM_MODE=sdk`, before TRO-620 (`content: null`, synthesized `visibility`) | 0 / turn | 197 | 323 | **−84.5%** |

**What that establishes:** the Epic 7 rewire (`internal` → `sdk` transport) does **not** change
input token volume for the `on_demand` trigger — per-turn input counts are identical (424/425/425)
once `agent/src/shipClient.ts`'s sdk-mode `getDocument` passes `content`/`visibility`/
`created_by`/`completed_at` through (TRO-605 widened the v1 route; TRO-620 wired the client). The
only output difference (Q2: 279 vs 261) is model non-determinism on an identically-sized prompt.
The pre-fix row is what PF-704's traced exception actually cost: every expansion candidate failed
`passesAskerVisibility` on the synthesized `visibility`, zero documents reached the prompt, and the
model answered from the bare question — ~85% cheaper per turn, and answering without any Ship
context. Cheaper was the wrong direction to be wrong in.

**What was and was not measured, precisely:** 9 real model calls total (3 per configuration,
≈ $0.0074); only the `on_demand`/expansion trigger — the one path PF-704 traced as exposed. The
other four prompt builders (`composeStandupDraft`, `composeBlockerEscalation`,
`composeRetroDraft`, `composePlanChangeDraft`) were not run. One operability finding surfaced on
the way (`sdk`-mode expansion trips `/api/v1`'s default `RATE_LIMIT_TOKEN_RPM=60` bucket with
HTTP 429 on a 12-document walk; the measurement ran with the limit raised locally) — recorded in
PF-704's section, out of this doc's scope.

**Provenance note (kept for the record):** an earlier revision of this section carried a literal
`TODO(TRO-434)` placeholder because PR #263 (`feat/pf-704-flag-matrix-audit-proof`, TRO-440/PF-704)
was still open/unmerged at doc-write time (`gh pr view 263 --json state` → `"state":"OPEN"`) and
`PF-704-COST-LEDGER-DELTA.md` did not yet exist on `main`. Nothing here was filled in from
estimates: the numbers above were produced after that PR landed, by re-running the workload.

### 2.2 TTFE CI minutes

**OBSERVED — the drill's own timed stages**, from 5 real `.factory/drill-ttfe.log` files left behind
by other factory worktrees (`tro_600`, `tro_455`, `tro_439`, `tro_440`, `tro_610`), each a real
`pnpm drill ttfe` (`scripts/drill/ttfe.ts`) run:

| Worktree | install_sdk | device_login | webhook_create | document_create | wait_for_delivery | verify_webhook | **total** |
|---|---:|---:|---:|---:|---:|---:|---:|
| tro_600 | 1092ms | 40ms | 7ms | 7ms | 857ms | 0ms | **2003ms** |
| tro_455 | 3929ms | 59ms | 9ms | 12ms | 994ms | 0ms | **5003ms** |
| tro_439 | 1145ms | 37ms | 5ms | 4ms | 818ms | 1ms | **2010ms** |
| tro_440 | 1022ms | 40ms | 5ms | 4ms | 929ms | 0ms | **2000ms** |
| tro_610 | 3918ms | 54ms | 11ms | 9ms | 1005ms | 1ms | **4998ms** |

Average timed-stage total: **~3.2s**, against the drill's own asserted `totalBudgetMs: 60000`
(`scripts/drill/ttfe.config.json`) — every real run passes with roughly 18x margin. This is the
in-process stage timing only; it excludes untimed Postgres/api-boot setup (logged separately at
~2.6–2.8s per run in the same log files) and the CI job's own checkout/install overhead.

**OBSERVED — real GitHub Actions job wall-clock**, `drill · TTFE (PF-603)` job
(`.github/workflows/ci.yml:405-458`), pulled via `gh run view <id> --json jobs` for 5 real completed
runs on `main` (2026-08-16, this session):

| Job start | Job end | Duration |
|---|---|---:|
| 01:58:42Z | 01:59:41Z | 59s |
| 02:19:35Z | 02:20:41Z | 66s |
| 04:03:51Z | 04:04:56Z | 65s |
| 04:21:24Z | 04:22:21Z | 57s |
| 04:29:04Z | 04:30:11Z | 67s |

Average: **~62.8s (≈1.05 min) per CI run**, covering checkout + `pnpm/action-setup` + `setup-node`
+ `pnpm install --frozen-lockfile` + the drill itself. The job is gated behind `needs: verify`
(`ci.yml:414`) — a doomed PR (failing typecheck/build/tests) never spends minutes here.

**Weekly bill projection — ASSUMED PR volume, stated explicitly:**

- Observed merge velocity this sprint: **100 PRs merged over 8 days** (2026-08-09 → 2026-08-16,
  `gh pr list --state merged --limit 100 --json mergedAt`) ≈ **87.5 PRs/week**. This is the
  **current parallel-factory-agent sprint cadence**, explicitly higher than a typical single-team
  velocity — flagged as such, not presented as a steady-state number.
- Observed ratio of total `ci.yml` workflow runs to merged PRs, same window (`gh run list
  --workflow=ci.yml --limit 300`, days 08-13/08-14/08-15 where both counts overlap: 37 runs/9 PRs,
  109/34, 109/29) ≈ **~3.7 CI runs per merged PR** (review-iteration pushes + re-runs).
- **Projection:** 87.5 PRs/week × 3.7 runs/PR ≈ 324 TTFE job runs/week × ~1.05 min/run ≈
  **~340 CI-minutes/week (~5.7 hours/week)** at this sprint's factory cadence.
- **If PR volume settles to a more typical 10–15 PRs/week post-sprint** (a stated alternative
  assumption, not observed) at the same 3.7 runs/PR ratio: ~37–56 runs/week × 1.05 min ≈
  **~39–58 CI-minutes/week** instead. Both numbers are shown because which one applies depends on
  an engineering-velocity assumption this document cannot observe in advance.

### 2.3 Playwright OAuth compute

**OBSERVED — not wired into CI today.** Neither `.github/workflows/ci.yml` nor `.gitlab-ci.yml` runs
any OAuth spec. The only Playwright job in CI (`e2e-agent` / `e2e · agent detection latency +
grounded chat`) runs exactly `e2e/agent-detection-latency.spec.ts` and
`e2e/agent-chat-grounded-response.spec.ts` (`ci.yml:392`, `.gitlab-ci.yml:203`) — confirmed by
reading both workflow files directly, not inferred. The four OAuth specs
(`e2e/oauth-pkce-chain.spec.ts`, `e2e/browser-demo-pkce.spec.ts`, `e2e/oauth-authorize.spec.ts`,
`e2e/oauth-refresh-rotation-stolen-token.spec.ts`, 8 tests total) are **local/on-demand only** —
their real CI-minutes cost today is **zero**, recurring.

**OBSERVED — real local run, this session.** Ran all 4 files (8 tests) via
`pnpm exec playwright test <files> --workers=1` in this worktree to get a genuine timing, rather
than estimate one:

- 5 of 8 tests (all of `oauth-authorize.spec.ts`, `oauth-pkce-chain.spec.ts`,
  `oauth-refresh-rotation-stolen-token.spec.ts`) passed with real per-test durations of
  **378ms–5442ms** (sum ≈7.4s test-body time; the 5442ms outlier is the first test in the worker,
  paying one-time browser/context startup).
- The remaining 3 tests (all in `browser-demo-pkce.spec.ts`, the one spec that drives a real
  Chromium browser round trip) **failed twice in a row** with `Test timeout of 60000ms exceeded
  while setting up "dbContainer"` — each spec file provisions its own isolated `testcontainers`
  Postgres (`e2e/fixtures/isolated-env.ts`). This was a real, reproduced environmental condition at
  measurement time: `docker ps` showed **18 concurrent containers** running (multiple parallel
  factory worktrees), and a direct `psql` connection to the shared `ship-postgres-1` container
  independently hit `FATAL: the database system is in recovery mode` mid-session — genuine Docker/DB
  contention from this sprint's concurrent agent load, not a defect in the OAuth code or spec.
- Total wall-clock for the full 4-file, 8-test invocation under that contention: **~147s (2.45
  min)**.

**Honest conclusion:** once environment setup succeeds, OAuth Playwright compute itself is cheap —
low-single-digit seconds per test. The dominant, variable cost is per-worker Postgres container
cold-start, which this session directly observed can exceed a 60s ceiling under concurrent factory
load. That volatility is a plausible reason these specs aren't in CI yet, though this document did
not find a ticket or comment stating that reasoning explicitly — noted as inference, not fact.

### 2.4 Spec-gen overhead

**OBSERVED**, timed directly this session:

```
$ time pnpm openapi:check
...
OK: .../docs/openapi.json matches the in-process /api/v1 OpenAPI registry.
pnpm openapi:check  0.82s user 0.18s system 84% cpu 1.196 total
```

**1.196s wall-clock.** `pnpm openapi:check` → `pnpm --filter @ship/api openapi:check:v1` → `tsx
src/scripts/generate-v1-openapi.ts --check`. Needs no `DATABASE_URL` and boots no app server — the
script's own header confirms `generateV1OpenAPIDocument()` only walks the zod-to-openapi registry
built from `platform/openapi/schemas/*.ts`. This step runs inside CI's `typecheck · build · unit
tests` job (`ci.yml:97-98`, `.gitlab-ci.yml:83`) alongside everything else in that job — at ~1.2s it
is a rounding error against that job's overall minutes, not a separately-billed cost.

(Note: there is a second, legacy internal OpenAPI generator — `api/src/scripts/generate-openapi.ts`
→ `api/openapi.json`/`.yaml`, the internal `/api/*` surface — a different document from the public
v1 spec this section measures. Not double-counted; PF-905 cares about the public
`docs/openapi.json` a third-party developer reads.)

### 2.5 Delivery-log storage growth at demo volume

**DERIVED row size** — `webhook_deliveries` (migration `048_webhook_deliveries.sql`, extended by
`050`/`051`) has **zero rows in every real environment today**: migration 048's own header states
the table "is meant to grow without bound... until a future retention ticket," and 050's header
independently confirms "`webhook_deliveries` has zero rows in every real environment right now." So
this is a derived estimate from the actual column list and representative literal sizes (measured
via Python `len()` on a realistic `document.created` envelope this session), not a read from a
populated table:

| Column | Type | Estimated bytes |
|---|---|---:|
| id, subscription_id, event_id, replayed_from_id | 4× UUID | 64 |
| event_type | TEXT (`"document.created"`, 17 chars) | ~18 |
| payload | JSONB (measured real envelope, 342 JSON chars) | ~350 |
| idempotency_key | TEXT (~22-36 chars) | ~30 |
| attempt_number | INTEGER | 4 |
| status | TEXT (`"success"`) | ~8 |
| response_status | INTEGER | 4 |
| response_excerpt | TEXT (measured ack body, 17 chars; capped at `RESPONSE_EXCERPT_MAX_CHARS = 2000`, `deliverer.ts:116`) | ~18 |
| latency_ms | INTEGER | 4 |
| next_attempt_at, created_at | 2× TIMESTAMPTZ | 8 (one is NULL on terminal rows) |
| tuple header + null bitmap | — | ~26 |
| **raw tuple subtotal** | | **~542 bytes** |
| 3 active index entries (unique-attempt, event_id, created_at/id — the pending and replayed_from_id indexes are partial and empty for a terminal, non-replay row) | | ~130-150 |
| **total, per successful delivery-attempt row** | | **~670-700 bytes ≈ 0.7 KB** |

Rounding up for realistic WAL/page-fill overhead (typically +20-40% in practice): **call it ~0.9-1.0
KB/row** as a conservative planning number.

**ASSUMED demo volume:** ≥5 reference integrations (PLUGFORGE.MD §4's own AC) × an assumed average 2
active event-type subscriptions each = 10 active subscriptions. A demo/grading walkthrough (the
TTFE drill's single document-create, plus a fuller narrated flow per `DEMO-SCRIPT.md`) is assumed to
generate on the order of **~30 event-publishing actions**, fanning out at an assumed average 1.5
matching subscriptions/event → **~45-90 delivery-attempt rows per demo session**.

At ~1 KB/row: **well under 100 KB for an entire demo session** — negligible. Even a (unrealistic)
sustained daily-repeat of that volume projects to only ~90 KB/day ≈ ~630 KB/week — still negligible
against Aurora Serverless v2's storage tier (see §3).

**Flagged gap, not glossed over:** no scheduled cleanup/retention job exists for this table or for
`public_api_audit` (migration `049`) — grepped `api/src` for `cron`/`setInterval`/`DELETE FROM
webhook_deliveries`/`DELETE FROM public_api_audit`; the only real hits are the deliverer's own 1s
poll loop (`deliverer.ts:614`, scheduling due retries, not deleting rows) and lazy per-request
session cleanup (`auth.ts` deletes one session row on the read that discovers it's expired — not a
batch job either). Both audit-shaped tables grow without bound today. Immaterial at demo volume;
material at the production tiers below — see §3.1's retention-window recommendation.

---

## 3. Production projections at 100 / 1,000 / 10,000 / 100,000 users

### 3.1 Explicit assumptions (as PF-905's AC requires)

**Webhook fanout ratio — ASSUMED, with schema grounding:**
- No code-enforced cap on subscriptions per app was found (`grep` of
  `api/src/platform/api/v1/resources/webhooks.ts` and the webhooks platform directory) — the only
  hard limit is the 8-entry `EVENT_TYPES` enum (`events.ts:99-108`), which caps one app at 8
  *distinct* active subscriptions by construction (migration 047's partial unique index is per
  `(app_id, event_type, target_url)`).
- Assumption: **1 registered OAuth app per 20 users** (apps model integrations/orgs, not individual
  people) × **3 active event-type subscriptions/app on average** (out of the 8 available) × **1.2
  events published per meaningful user action** (most actions fire one event; some, like a sprint
  transition, co-fire a `document.updated` alongside the domain event).
- Assumption: **10 event-triggering actions per user per week** (create/update documents, issues,
  sprint transitions) — a moderate-use planning tool, not a high-frequency app.

**Agent active rate — ASSUMED, explicitly NOT derived from usage data:** Ship has no production
users today (this is pre-launch coursework/demo software; verified no usage-analytics table or
production traffic exists to measure an actual rate from). Assumption: **20% of users ever trigger
an agent turn in a given week**, at an assumed **3 turns/week per active agent user**. This is a
placeholder business assumption for planning purposes, stated as such — not a number this document
can ground in observed behavior, because none exists yet.
`PLUGFORGE.MD:241`'s own count of "the agent's 10 reads (`agent/src/shipClient.ts:360-455`)" gives a
**real, DERIVED** per-turn API-call count instead: ~10 `/api/v1` reads + ~1 write for an accepted
draft ≈ **11 `/api/v1` calls per agent turn**, each writing one `public_api_audit` row
(`platform/audit/middleware.ts`'s fire-and-forget insert on `res.on('finish')`, per migration 049's
header).

**Retention windows — ASSUMED policy recommendation, with real in-codebase rationale:**
Recommend **30 days** for both `webhook_deliveries` and `public_api_audit`. Not currently
implemented (§2.5's gap applies to both tables) — this is a recommendation for a future retention
ticket, grounded in two *existing* precedents in this exact codebase rather than picked arbitrarily:
1. OAuth refresh tokens already use a 30-day window (migration `043` header; `token.ts:183`,
   *"Refresh tokens: 30 days"*).
2. This project's own Aurora CloudWatch log group already uses `retention_in_days = 30`
   (`terraform/database.tf`, the `aws_cloudwatch_log_group.aurora` resource).

Two independent parts of this codebase already converge on 30 days for "how long do we keep
operational history" — that's the rationale, not a round-number guess.

### 3.2 Projected volumes (traceable units — rows, KB, requests, CI-minutes)

Using §3.1's formulas: `apps = users/20`; `active_subs = apps × 3`; `weekly_events = users × 10 ×
1.2`; `weekly_deliveries ≈ weekly_events × 0.3` (assumed fraction of events with any matching
subscription in-workspace, folding in the fanout ratio above — stated plainly as a single
multiplier since a fully compositional per-workspace matching model would imply precision this
document doesn't have); `weekly_agent_turns = users × 0.20 × 3`; `weekly_audit_rows =
weekly_agent_turns × 11` (agent-driven floor only — OAuth-app/SDK traffic is a smaller additional
slice already covered by the same apps counted above, not double-counted here).

| Tier | Apps | Active subs | Weekly events | Weekly deliveries | Delivery-log growth/wk | Weekly agent turns | Weekly audit rows | Audit-log growth/wk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 5 | 15 | 1,200 | 360 | ~0.3 MB | 60 | 660 | ~0.5 MB |
| 1,000 | 50 | 150 | 12,000 | 3,600 | ~3.4 MB | 600 | 6,600 | ~5.0 MB |
| 10,000 | 500 | 1,500 | 120,000 | 36,000 | ~34 MB | 6,000 | 66,000 | ~50 MB |
| 100,000 | 5,000 | 15,000 | 1,200,000 | 360,000 | ~340 MB | 60,000 | 660,000 | ~500 MB |

(Delivery-log growth uses §2.5's ~0.9-1.0 KB/row; audit-log growth assumed at the same order of
magnitude per row — `public_api_audit`'s columns, migration 049, are a strict subset of
`webhook_deliveries`'s, all scalars/short text, no JSONB payload, so ~0.75 KB/row is the more
accurate figure; shown rounded above.) **With the §3.1 30-day retention window applied**, storage at
steady state caps at roughly **4.3x** a single week's growth (30 days ÷ 7) rather than growing
unbounded — e.g. the 100k-user tier's delivery log would plateau around **~1.5 GB** instead of
climbing forever.

**CI minutes — does NOT scale with production user count.** This is worth stating plainly because
the AC's phrasing ("CI minutes if usage scales CI at all") anticipates the question: CI minutes are
driven by *engineering* velocity (PRs/week, §2.2), not by how many end users the deployed product
has. All four tiers above carry the **same** ~340 CI-min/week (sprint cadence) or ~40-58 CI-min/week
(steady-state cadence) figure from §2.2 — production user count is not an input to that number.

**Per-request compute — elastic by design, not a fixed allocation.** `terraform/database.tf`
provisions Aurora Serverless v2 (`db.serverless`, `aurora_min_capacity = 0.5` / `aurora_max_capacity
= 4` ACUs, `terraform/variables.tf:55-65`) — DB compute scales with load automatically rather than
being sized per-tier. The API tier (`terraform/elastic-beanstalk.tf`) runs `t3.small` instances,
autoscaling `MinSize = 1` / `MaxSize = 4` on CPU. Neither requires a distinct provisioning decision
per user-count tier; the load-bearing, plannable variable at scale is **storage** (the tables above)
and **request rate**, not a fixed compute bucket. For request-rate grounding: the audit's own
browser trace (API-1/TRO-172, `api/src/middleware/rate-limit.ts` header) measured **63 `/api`
requests across 8 flows** for one real user session (~8 requests/flow) — at the 100k-user tier with
even a conservative 2 such sessions/user/week, that's ~12.6M internal `/api` requests/week, comfortably
within what a 4-instance `t3.small` autoscaling group plus Redis-backed rate limiting
(`redis-rate-limit-store.ts`) is designed to absorb, though this document has no load-test data at
that volume to confirm it — flagged as untested extrapolation, not verified capacity.

### 3.3 What this section deliberately does NOT do

**No dollar figures.** Ship has no production AWS bill — it is pre-launch. Converting the
row-counts/storage-GB/CI-minutes above into USD would require live Aurora Serverless ACU-hour
pricing, EB instance-hour pricing, and Bedrock/Anthropic per-token pricing applied against *actual*
traffic, none of which exist as ledger data yet. Inventing a $/month figure from list prices
recalled from memory would be exactly the "vibes number" this ticket's AC prohibits. The
traceable units above (rows, KB/GB, CI-minutes, request counts) are the honest output of this
analysis; $ conversion is a follow-up once real billing data exists post-deploy.

---

## 4. Summary — what's real vs. assumed, at a glance

| Section | Status |
|---|---|
| Platform-is-LLM-free statement | **CORRECTED** — 2 real LLM paths found (agent turns + plan/retro scoring), not 1; both cited by file:line |
| E7 LLM spend before/after | **MEASURED** (TRO-620) — 9 real ledger rows, `on_demand` trigger only: input tokens identical `internal` vs post-fix `sdk` (1274 vs 1274); pre-fix `sdk` was −84.5% with 0 docs in context |
| TTFE CI minutes | **OBSERVED** (10 real samples: 5 log files + 5 CI runs) + **ASSUMED** weekly PR volume, both cases shown |
| Playwright OAuth compute | **OBSERVED** — real run this session, including an honestly-reported partial failure under real Docker contention |
| Spec-gen overhead | **OBSERVED** — timed directly, 1.196s |
| Delivery-log storage at demo volume | **DERIVED** row size (schema + measured literals) + **ASSUMED** demo action count |
| Production projections (100/1k/10k/100k) | **DERIVED** formulas from real schema/config + **ASSUMED** business inputs, every assumption named individually in §3.1 |
| Dollar-cost figures | **Deliberately absent** — no ledger data exists to ground them; see §3.3 |
