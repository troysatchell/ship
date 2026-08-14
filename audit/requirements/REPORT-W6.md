# Requirements Audit — Ship
**Commit:** 24183537bb03388f58ef3831d1981aee13da1b27 · **Date:** 2026-08-14T09:51:08Z · **Docs:** W6 (GFA_Week_6_PlugForge.pdf, 18pp) · **Mode:** compare (`w6-mvp-wave`, baseline `matrix.baseline-W6.json` @ 06a15f1, 2026-08-13T19:53:43Z)

## Summary

- VERIFIED: 23 (was 14)
- IMPLEMENTED-UNVERIFIED: 2 (was 1)
- PARTIAL: 11 (was 11 — same count, different composition, see Delta)
- MISSING: 40 (was 50)
- N/A: 3 (unchanged)
- BLOCKED: 0 (unchanged)
- ASSUMED: 0 (unchanged)

Six MVP-gate tickets landed since the baseline (TRO-400/PF-201 issues+sprints+me, TRO-402/PF-202
OpenAPI v1 generator, TRO-404/PF-203 route-fitness test, TRO-405/PF-400 `@ship/sdk` scaffold,
TRO-421/PF-105 refresh rotation, TRO-425/PF-106 device grant), and the MVP hard gate (W6-R2–R12)
moved from **4/11 VERIFIED to 7/11 VERIFIED** — R6, R8, R9 joined R2/R4/R5/R7 as VERIFIED, all with
freshly re-run, real test output against a dedicated scratch database. The finding this report
leads with is the one gap that **did not** close despite all that landing: **W6-R3** — "Authorization
Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent →
/oauth/token → usable access token" — is still PARTIAL, for a narrower but equally real reason than
at baseline. Every individual piece the literal scenario needs now exists and works
(`/api/v1/me` is live, `token.test.ts` is 32/32 including the mandatory wrong-verifier negative,
device grant and refresh rotation both landed too) — but `e2e/oauth-authorize.spec.ts` is
byte-identical to baseline (confirmed via `git diff --stat`: zero e2e specs changed in this
78-commit range). Nobody wrote the one Playwright test that chains authorize → consent → token →
`/api/v1/me`, even though every backend blocker to writing it is now gone. W6-R10 (regression
budget) moved MISSING → PARTIAL: three independently-verified compare-mode audits (api-perf,
db-query, bundle) all PASS within the Part-1 ±10% budget, and a rigorous three-pass bisection
proves the 32 failing e2e tests are pre-existing and unrelated to tonight's six tickets (zero code
overlap against a verified pre-wave commit) — but the suite does not pass in the literal,
unqualified sense the requirement's words state, so PARTIAL, not VERIFIED, is the honest tier. See
the Delta section for the complete list of 13 verdict changes.

## Coverage and limitations

- **Still no full `pnpm test`/`pnpm test:e2e` run performed directly by this sweep.** Targeted
  `vitest run <file>` commands scoped to each requirement's own test file ran instead, this time
  against a dedicated scratch database (`ship_audit_w6mvp_scratch`, created and migrated fresh for
  this sweep, dropped after — never the shared worktree dev DB) rather than a worktree DB baseline
  used. W6-R10's regression-budget clauses lean on three *separately* completed compare-mode audits
  (api-perf/db-query/bundle) plus a documented e2e bisection, opened and read directly rather than
  re-run in this sweep — see W6-R10's evidence and `commands_run`.
- **Live-deployment checks still did not run.** No network egress was attempted against any deployed
  URL; W6-R11 and W6-R77 (published spec URL / portal reachability) are judged on code presence
  only, per `NOT RUN` entries in `commands_run`. W6-R11 moved PARTIAL → IMPLEMENTED-UNVERIFIED
  because the code-level spec-URL blocker closed this range (PF-202 landed) — only the live probe
  remains unrun.
- **`terraform plan`/`apply`/`destroy` still did not run** — `terraform/` has zero diff since
  baseline (confirmed via `git diff --stat`), so W6-R12/R38/R39/R40 carry forward unchanged,
  relying on the same previously-committed plan/destroy-redeploy artifacts baseline cited.
- **Ticket dimension was NOT blocked.** Linear was reachable; a fresh pull this sweep found 95
  tickets in the project (up from 86 at baseline) — see `ticket_mapping.scope` in the matrix JSON.
  No row's `tickets` array is `["BLOCKED"]`.
- **Compare methodology:** each of the 79 rows was independently re-traced this sweep (not merely
  copy-forwarded) — either directly by the lead sweep (the 37 IDs closest to the six landed
  tickets: W6-R2–R21, R30–R34, R38–R45, R51, R60, R66, R74) or by five parallel subagents each
  covering one feature-area cluster (webhooks, rate-limit/audit/portal, CLI/TTFE/integrations,
  agent-rewire/cost, docs/process/submission). Every row confirmed its cited evidence still opens
  and still supports its note — files that grew since baseline (`CHANGES.md`, `memory-bank/*.md`)
  needed line-number corrections in several rows even where the underlying claim didn't change;
  those are called out per-row rather than silently re-pointed.
- **Independent citation verification this sweep** spot-checked a sample of citations across every
  cluster (not just the lead sweep's own 37) by opening the file at the exact cited line — one
  real error was found and fixed: `pnpm-workspace.yaml`'s `sdk` package entry is at line 6, not
  line 1/4 as several draft citations first stated (the file's `packages:` header is line 1; `sdk`
  is the 5th list item). Corrected everywhere it occurred before this report was finalized.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| W6-R1 | Process schedule — Architectural Defense Monday 1:00 PM CT; MVP Tuesday 11:59 PM CT; Early... | — | — | N/A |
| W6-R2 | An admin endpoint creating rows in an `oauth_apps` table, returning client_id + raw secret once,... | TRO-408, TRO-492, TRO-493 | api/src/platform/oauth/appRegistration.ts:109, api/src/routes/oauth-apps.ts:60, api/src/db/migrations/042_oauth_apps.sql:31 | VERIFIED |
| W6-R3 | `/oauth/authorize` + consent UI + `/oauth/token` implementing RFC 6749 + 7636, proven by a... | TRO-412, TRO-416, TRO-503, TRO-550, TRO-549 | e2e/oauth-authorize.spec.ts:102, e2e/oauth-authorize.spec.ts:9, CHANGES.md:209 (+2 more) | PARTIAL |
| W6-R4 | v1-only bearer middleware with three distinguishable 401 variants. | TRO-430 | api/src/platform/oauth/bearerAuth.ts:116, api/src/platform/api/v1/resources/documents.ts:117, api/src/platform/oauth/__tests__/bearerAuth.test.ts:246 | VERIFIED |
| W6-R5 | `/api/v1/documents` list/get/create wired through a `require(scope)` factory. | TRO-398, TRO-430 | api/src/platform/api/v1/resources/documents.ts:115, api/src/platform/api/v1/resources/documents.ts:201, api/src/platform/api/v1/resources/documents.ts:254 (+3 more) | VERIFIED |
| W6-R6 | Public error middleware producing the ApiError shape on every v1 failure path, plus a... | TRO-397, TRO-489, TRO-495, TRO-404 | api/src/platform/api/v1/errors.ts:31, api/src/platform/api/v1/errorMiddleware.ts:1, api/src/platform/api/v1/__tests__/route-fitness.test.ts:335 (33/33 fresh) | **VERIFIED** (was PARTIAL) |
| W6-R7 | A ScopeRegistry data structure; 403 responses carry the missing scope in details. | TRO-430 | api/src/platform/scopes/requireScope.ts:37, api/src/platform/scopes/registry.ts:23, api/src/platform/oauth/__tests__/bearerAuth.test.ts:219 | VERIFIED |
| W6-R8 | In-process spec generator + serving route + schema-validation unit test. | TRO-402 | api/src/platform/openapi/index.ts:23, api/src/platform/api/v1/router.ts:50, api/src/platform/openapi/__tests__/document.test.ts:99 (9/9 fresh) | **VERIFIED** (was MISSING) |
| W6-R9 | `sdk/` workspace package exporting ShipClient with a working `me()`. | TRO-405, TRO-390 | sdk/src/client.ts:90, sdk/src/__tests__/client.liveServer.test.ts:163 (3/3 fresh, real TCP round trip) | **VERIFIED** (was MISSING) |
| W6-R10 | No regression: e2e suite green, and the three Part-1 baseline metrics (in `audit/`) stay within... | TRO-593, TRO-594, TRO-595, TRO-596 | audit/api-perf/compare-w6-r10-aug14/after-w6-r10-aug14.md:90, audit/db-query/.../after-w6-r10-aug14.md:66, audit/bundle/.../after-w6-aug14.md:43, memory-bank/activeContext.md:23 | **PARTIAL** (was MISSING) |
| W6-R11 | Live deployment carrying the platform layer, public spec URL, seeded grader OAuth app. | TRO-441, TRO-411, TRO-402 | api/src/platform/oauth/seedGraderApp.ts:80, api/src/db/seed.ts:100, api/src/platform/api/v1/router.ts:50 (openapi.json now registered) | **IMPLEMENTED-UNVERIFIED** (was PARTIAL) |
| W6-R12 | Complete IaC for the deployment (repo deploys to Render — the IAM-role language is AWS-shaped... | TRO-411, TRO-415, TRO-488, TRO-420 | terraform/render/versions.tf:9, terraform/render/postgres.tf:9, terraform/render/web_service.tf:9 (+4 more) | PARTIAL |
| W6-R13 | Numbered migration creating `oauth_apps` with those columns; rotation also returns raw secret... | TRO-406, TRO-408, TRO-492, TRO-493 | api/src/db/migrations/042_oauth_apps.sql:31, api/src/platform/oauth/appRegistration.ts:177, api/src/routes/oauth-apps.ts:235 | VERIFIED |
| W6-R14 | PKCE recorded on the authorization code and verified at token exchange; negative case returns... | TRO-412, TRO-416 | api/src/platform/oauth/authorize.ts:139, api/src/db/migrations/043_oauth_tokens_and_codes.sql:35, api/src/platform/oauth/token.ts:127 (+2 more) | VERIFIED |
| W6-R15 | RFC 8628 Device Authorization Grant endpoints, including slow_down semantics honored by clients. | TRO-425 | api/src/platform/oauth/device.ts:1, api/src/platform/oauth/__tests__/device.test.ts:256 (9/9 fresh, compounding slow_down proven) | **VERIFIED** (was MISSING) |
| W6-R16 | The seven named scopes exist as registry data; adding a scope requires no middleware edit. | TRO-430, TRO-491 | api/src/platform/scopes/registry.ts:57, api/src/platform/scopes/__tests__/registry.test.ts:21 | VERIFIED |
| W6-R17 | Middleware sets a principal ({app, user, scopes}) on the request; overlaps W6-R4/R7 but adds the... | TRO-430 | api/src/platform/oauth/bearerAuth.ts:146, api/src/platform/oauth/__tests__/bearerAuth.test.ts:177 | VERIFIED |
| W6-R18 | Refresh rotation with family-wide revocation on reuse of a rotated token. | TRO-421 | api/src/platform/oauth/token.ts:650 (rotateRefreshToken), :590 (revokeTokenFamily), token.test.ts (32/32 fresh, incl. forced concurrency test) | **VERIFIED** (was MISSING) |
| W6-R19 | Boundary enforced by ESLint `no-restricted-imports` (or equivalent) failing CI on cross-imports. | TRO-399, TRO-500, TRO-496 | eslint.config.mjs:111, eslint.config.mjs:164, api/src/platform/__tests__/boundary-lint.test.ts:77 | VERIFIED |
| W6-R20 | Keyset cursor pagination on every v1 list endpoint with the {data, next_cursor} envelope. | TRO-398, TRO-400, TRO-404 | api/src/platform/api/v1/pagination.ts:33, api/src/platform/api/v1/pagination.ts:44, api/src/platform/api/v1/resources/documents.ts:192 (+2 more) | VERIFIED |
| W6-R21 | Spec generation is in-process from route metadata; a fitness test asserts 100% spec ↔ route... | TRO-402, TRO-404 | api/src/platform/openapi/index.ts:11, api/src/platform/api/v1/__tests__/route-fitness.test.ts:284 (33/33 fresh) | **VERIFIED** (was MISSING) |
| W6-R22 | An enumerable event registry of exactly these 8 types, each with a Zod payload schema. | TRO-419 | api/src/platform/webhooks/events.ts:99, api/src/platform/webhooks/events.ts:237, api/src/platform/webhooks/events.ts:255 (+1 more) | VERIFIED |
| W6-R23 | IEventBus interface with in-process impl; publish() calls live only in the domain write path... | TRO-426 | api/src/platform/webhooks/README.md:16, api/src/services/documentService.ts:16, docs/architecture.md:300 | MISSING |
| W6-R24 | Subscriptions table + CRUD API under webhooks:manage. NOTE: "hashed signing secret" is... | TRO-431 | api/src/platform/webhooks/README.md:16, api/src/platform/scopes/registry.ts:82, api/src/db/migrations/044_oauth_tokens_authorization_code_id.sql:25 (+1 more) | MISSING |
| W6-R25 | HMAC-SHA256 signer producing the t=/v1= header over the timestamped payload; SDK-side 300s... | TRO-433, TRO-413 | api/src/platform/webhooks/signer.ts:121, api/src/platform/webhooks/signer.ts:144, api/src/platform/webhooks/__tests__/signer.test.ts:1 | VERIFIED |
| W6-R26 | Retry scheduler with exactly that schedule + jitter; 5xx/timeout retried, 4xx dead-lettered... | TRO-438 | api/src/platform/webhooks/README.md:16, docs/architecture.md:274 | MISSING |
| W6-R27 | DLQ at attempt 6, surfaced in portal UI, manual replay preserving Idempotency-Key. | TRO-438, TRO-439 | api/src/platform/webhooks/README.md:16, docs/architecture.md:267 | MISSING |
| W6-R28 | Delivery-log table with those columns; per-app query path (API + portal). | TRO-438, TRO-442 | api/src/db/migrations/044_oauth_tokens_authorization_code_id.sql:25, api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R29 | Replay endpoint re-emitting a logged delivery with its original Idempotency-Key. | TRO-446 | api/src/platform/webhooks/README.md:16, docs/architecture.md:181 | MISSING |
| W6-R30 | Resource-segregated SDK surface + spec↔SDK parity fitness test wired into CI. | TRO-407, TRO-422, TRO-390 | docs/architecture.md:195, docs/architecture.md:214, PLUGFORGE.MD:256 (+1 more) | MISSING |
| W6-R31 | SDK auth helpers for both grants + ITokenStore with the three store implementations. | TRO-418, TRO-449, TRO-390 | docs/architecture.md:202, docs/architecture.md:216, PLUGFORGE.MD:259 (+1 more) | MISSING |
| W6-R32 | Async-iterator pagination on SDK list clients; cursors fully internal. | TRO-410, TRO-449, TRO-390 | docs/architecture.md:214, PLUGFORGE.MD:257, PLUGFORGE.MD:289 | MISSING |
| W6-R33 | One-call SDK verifier with the three failure modes. | TRO-413, TRO-433, TRO-390 | api/src/platform/webhooks/signer.ts:144, docs/architecture.md:205, PLUGFORGE.MD:258 (+1 more) | MISSING |
| W6-R34 | Typed error union in the SDK, exhaustively switchable. | TRO-405, TRO-390 | sdk/src/errors.ts:39, :76, :115, errors.test.ts (16/16 fresh, exhaustive it.each) | **VERIFIED** (was MISSING) |
| W6-R35 | Two-level token buckets; headers on all v1 responses; 429 + Retry-After. (Requires exempting... | TRO-427, TRO-401, TRO-494, TRO-552, TRO-391 | api/src/platform/ratelimit/README.md:8, api/src/middleware/rate-limit.ts:212, api/src/middleware/rate-limit.ts:333 (+2 more) | MISSING |
| W6-R36 | public_api_audit table + recording middleware + portal query surface. | TRO-432, TRO-391 | api/src/platform/audit/README.md:4, api/src/platform/oauth/bearerAuth.ts:30, CHANGES.md:1118 (+1 more) | MISSING |
| W6-R37 | Developer portal in the existing Ship web app covering those six functions. | TRO-436, TRO-439, TRO-443, TRO-391 | web/src/pages:1, PLUGFORGE.MD:266 | MISSING |
| W6-R38 | IaC topology (Render adaptation: no VPC/subnet/SG primitives — the adaptation must be defended... | TRO-411, TRO-488, TRO-420 | terraform/render/versions.tf:9, terraform/render/postgres.tf:9, terraform/render/web_service.tf:9 (+3 more) | PARTIAL |
| W6-R39 | AWS-IAM-shaped exercise; on Render this maps to API-key scoping/service isolation — adaptation... | TRO-420 | docs/IAM-ADAPTATION-RENDER.md:10, docs/IAM-ADAPTATION-RENDER.md:48, docs/IAM-ADAPTATION-RENDER.md:100 (+2 more) | IMPLEMENTED-UNVERIFIED |
| W6-R40 | Drift-detection demo + destroy-redeploy with committed evidence. | TRO-415 | terraform/render/plan/tro-316-destroy-redeploy-proof.md:23, terraform/render/plan/tro-316-destroy-redeploy-proof.md:25, memory-bank/progress.md:163 | PARTIAL |
| W6-R41 | Human competency requirement (Troy must be able to read a plan unaided) — auto-fail stakes. | — | docs/submission/PLUGFORGE-DEFENSE-DECK.html:428 | N/A |
| W6-R42 | Graded test scenario — PKCE e2e + mandatory negative. | TRO-412, TRO-416, TRO-503, TRO-550, TRO-549 | e2e/oauth-authorize.spec.ts:102, api/src/platform/oauth/__tests__/token.test.ts:324 | PARTIAL |
| W6-R43 | Graded test scenario — device flow via CLI to /api/v1/me. | TRO-425, TRO-448 | api/src/platform/oauth/__tests__/device.test.ts:256, :330 (introspected via real bearerAuth, not literally /api/v1/me; no CLI exists) | **PARTIAL** (was MISSING) |
| W6-R44 | Graded test scenario — the route-enumeration fitness test with the four assertions. | TRO-404 | api/src/platform/api/v1/__tests__/route-fitness.test.ts:271, :41 (33/33 fresh, incl. real deliberate-drift AC proof) | **VERIFIED** (was MISSING) |
| W6-R45 | Graded test scenario — spec validity + spec→SDK parity walk. | TRO-402, TRO-422 | api/src/platform/openapi/__tests__/document.test.ts:99 (5/5 fresh, spec-validity half done); sdk/ has no parity walk (SDK-parity half absent) | **PARTIAL** (was MISSING) |
| W6-R46 | Graded test scenario — end-to-end webhook happy path + tamper negative, ≤2s first delivery. | TRO-455, TRO-413 | api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R47 | Graded test scenario — deterministic retry test (500×3 → 200 on attempt 4). | TRO-438 | api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R48 | Graded test scenario — DLQ + portal visibility + replay with original key. | TRO-438, TRO-439 | api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R49 | Graded test scenario — the TTFE drill. | TRO-455, TRO-448 | pnpm-workspace.yaml:1, CHANGES.md:1599, memory-bank/progress.md:189 (+1 more) | MISSING |
| W6-R50 | TTFE targets: clean-machine ≤30 min (docs only), CI <60s (p.8 table restates: "TTFE drill... | TRO-455 | api/src/middleware/rate-limit.ts:48, .gitlab-ci.yml:41 | MISSING |
| W6-R51 | Performance target on the PKCE round-trip. | TRO-412, TRO-416, TRO-449 | e2e/oauth-authorize.spec.ts:1 | MISSING |
| W6-R52 | First-attempt delivery latency target. | TRO-438 | api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R53 | Retry completeness target. | TRO-438 | api/src/platform/webhooks/README.md:16 | MISSING |
| W6-R54 | Header coverage target — including error responses. | TRO-427, TRO-552, TRO-391 | api/src/platform/ratelimit/README.md:8, PLUGFORGE.MD:264, api/src/middleware/rate-limit.ts:333 | MISSING |
| W6-R55 | The `pnpm drill ttfe` command with containerized Ship (testcontainers per repo pattern). | TRO-455 | package.json:12, scripts:1 | MISSING |
| W6-R56 | Per-stage ms instrumentation in the drill. | TRO-455 | api/src/platform/config.ts:30 | MISSING |
| W6-R57 | TTFE drill wired into the graded CI (GitLab; GitHub mirror) on every PR with a failing threshold. | TRO-455 | .gitlab-ci.yml:9, .github/workflows:1 | MISSING |
| W6-R58 | verifyWebhook performance target. | TRO-413, TRO-433, TRO-390 | api/src/platform/webhooks/__tests__/signer.test.ts:203, api/src/platform/webhooks/__tests__/signer.test.ts:221, PLUGFORGE.MD:258 (+1 more) | MISSING |
| W6-R59 | Zero-flake target tracked across 20 CI runs; a flake is a P0 platform/drill bug, never retry-masked. | TRO-455 | .gitlab-ci.yml:9 | MISSING |
| W6-R60 | SDK size budget, CI-checked. | TRO-422, TRO-390 | PLUGFORGE.MD:260, .gitlab-ci.yml:1 | MISSING |
| W6-R61 | ≥5 of: CLI (must-ship), Slack (should-ship), Browser SDK demo, GitHub integration,... | TRO-394, TRO-448, TRO-445, TRO-447, TRO-449, TRO-451, TRO-453, TRO-454 | pnpm-workspace.yaml:1, scripts/check-integration-deps.mjs:12, api/src/platform/oauth/token.ts:402 (+1 more) | MISSING |
| W6-R62 | The CLI with those exact commands; `ship webhooks tail` streams verified deliveries. | TRO-448, TRO-450, TRO-452 | pnpm-workspace.yaml:1, PLUGFORGE.MD:272, PLUGFORGE.MD:273 (+2 more) | MISSING |
| W6-R63 | No LLM calls anywhere in the platform layer; agent unchanged in cost shape. | TRO-434 | api/src/platform:0, api/package.json:24, agent/package.json:30 (+2 more) | PARTIAL |
| W6-R64 | Dev-cost tracking obligations (this plus CI minutes, Playwright compute, spec-gen overhead,... | TRO-434, TRO-440 | docs/submission/AI-COST-ANALYSIS.md:1, agent/src/costTracking.ts:1, agent/cost-ledger-snapshot.jsonl:1 | MISSING |
| W6-R65 | Production cost projections at 100/1k/10k/100k users with explicit assumptions: webhook fanout... | TRO-434, TRO-395 | PLUGFORGE.MD:301, docs/submission/AI-COST-ANALYSIS.md:1 | MISSING |
| W6-R66 | New platform/SDK code under TypeScript strict mode; Zod schemas drive the spec. | — | tsconfig.json:13, sdk/tsconfig.json:2 (extends root, `tsc --noEmit` exit 0), Zod in platform code | **VERIFIED** (was PARTIAL) |
| W6-R67 | Epic 7: agent reads via app-identity OAuth, all traffic through @ship/sdk and /api/v1, provable... | TRO-393, TRO-417, TRO-423, TRO-428, TRO-435, TRO-440, TRO-414 | agent/src/shipClient.ts:1, agent/package.json:1, docs/architecture.md:228 (+1 more) | MISSING |
| W6-R68 | Deliverer tests use an injected clock; zero setTimeout-based waiting. | TRO-438 | api/src/platform/webhooks/README.md:16, api/src/platform/webhooks/__tests__/signer.test.ts:61 | MISSING |
| W6-R69 | integrations/* depend only on @ship/sdk, enforced by workspace/lint rules. | TRO-399, TRO-500, TRO-496 | scripts/check-integration-deps.mjs:1, scripts/__tests__/check-integration-deps.test.mjs:128, .gitlab-ci.yml:83 (+3 more) | PARTIAL |
| W6-R70 | docs/architecture.md with the nine mandated sections (Module Layout, SOLID Rationale,... | TRO-424, TRO-395 | docs/architecture.md:23, docs/architecture.md:46, docs/architecture.md:56 (+8 more) | VERIFIED |
| W6-R71 | Repo/PR process discipline for the week. | — | PLUGFORGE.MD:20, CHANGES.md:482 | VERIFIED |
| W6-R72 | Demo video (3–5 min) with that exact narrative. | TRO-444, TRO-395 | PLUGFORGE.MD:304, docs/submission/DEMO-SCRIPT.md:1, docs/submission/FLEETGRAPH-DEMO-SCRIPT.md:1 | MISSING |
| W6-R73 | Pre-Search document (Appendix phases 1–3) with real answers + the saved conversation artifact. | TRO-429, TRO-395 | PRESEARCH.MD:1, PLUGFORGE.MD:300 | MISSING |
| W6-R74 | Deployed spec URL + committed docs/openapi.json kept in parity (CI diff). | TRO-409, TRO-388 | api/src/platform/api/v1/router.ts:35, api/openapi.json:2, api/src/platform/openapi/README.md:5 | MISSING |
| W6-R75 | Per-epic write-ups with the two named proofs. | TRO-437, TRO-395 | PLUGFORGE.MD:302, docs/submission/DISCOVERY.md:4 | MISSING |
| W6-R76 | Three discovery write-ups drawn from these candidates. | TRO-437, TRO-395 | PLUGFORGE.MD:302, docs/submission/DISCOVERY.md:6 | MISSING |
| W6-R77 | Grader-access deliverable — extends W6-R11 with README credentials + portal reachability. | TRO-441, TRO-411, TRO-402, TRO-436 | README.md:311, README.md:356, api/src/platform/oauth/seedGraderApp.ts:80 (+1 more) | PARTIAL |
| W6-R78 | Social post deliverable with the specified screenshot. | TRO-444, TRO-395 | PLUGFORGE.MD:304, docs/submission/SOCIAL-POST.md:1, docs/submission/SOCIAL-THREAD-W4-W5.md:1 | MISSING |
| W6-R79 | Process gate — interview defense of the public/internal boundary, OAuth flow choices, and... | TRO-403, TRO-417, TRO-429, TRO-395 | docs/submission/PF-100-OAUTH-STUDY-BRIEF.md:1, PLUGFORGE.MD:32 | N/A |

## Gaps

### W6-R3 — PARTIAL
- **Quote:** "Authorization Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token."
- **What's missing (updated 2026-08-14):** Narrower than at baseline, but not closed. Every individual piece the literal scenario needs now exists and works: `/api/v1/me` is live (PF-201/TRO-400 landed), `token.test.ts` is 32/32 including the mandatory wrong-verifier negative (grew from 18/18 via PF-105's rotation additions), and the authorize→consent leg is still proven by `e2e/oauth-authorize.spec.ts` (2/2, byte-identical to baseline). What's still missing is purely that nobody wrote the ONE Playwright spec chaining all three hops together — `e2e/` has zero diff since baseline (confirmed via `git diff --stat`), so this is now a pure test-authoring gap with zero remaining backend blockers, unlike baseline where `/api/v1/me` didn't exist yet.
- **Suggested scope:** Extend `e2e/oauth-authorize.spec.ts` (or add a new spec) to continue past the redirect: exchange the code via `POST /oauth/token`, then call `GET /api/v1/me` with the resulting token, chaining all three hops into one Playwright test. No backend work is needed — this is now purely a test-writing task.

### W6-R10 — PARTIAL (was MISSING)
- **Quote:** "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."
- **What's missing:** The three numeric budgets are done: `audit/api-perf/compare-w6-r10-aug14/after-w6-r10-aug14.md`, `audit/db-query/compare-w6-r10-aug14/after-w6-r10-aug14.md`, and `audit/bundle/compare-w6-aug14/after-w6-aug14.md` (all opened and read directly this sweep, not merely trusted) each report a clean PASS vs. the 2026-07-27 Part-1 baseline, with disclosed confounds (Postgres 15→16 version skew, gzip landing independently of tonight's tickets, one load-contaminated latency window disproven by a same-methodology quiet-load recheck). The fourth clause — "existing Playwright regression suite passes on main" — is literally false today: 32 tests fail. A rigorous three-pass bisection (documented in `memory-bank/activeContext.md:23`) traces every one of those 32 to causes wholly pre-existing and outside this range, with zero code overlap against a verified pre-wave commit (`6000c94`) — so none are a regression *from* W6 work — but the suite does not pass in the unqualified sense the requirement's words state. Filed as 4 remediation tickets (TRO-593 High, TRO-594/596 Low, TRO-595 Medium), none blocking MVP.
- **Suggested scope:** The three quantitative budgets need no further work. Fix or quarantine the 4 pre-existing failure clusters (TRO-593..596) to make the literal "suite passes" clause true — none are caused by W6 work, so this is cleanup, not remediation of tonight's tickets.

> W6-R11 moved PARTIAL → IMPLEMENTED-UNVERIFIED this sweep (all three named pieces now have real
> code; only a live-deployment probe remains) and is no longer part of this MISSING+PARTIAL subset —
> see the Delta section below for its full evidence.

### W6-R12 — PARTIAL
- **Quote:** "Terraform deployment: a terraform/ directory with a complete config describing the deployment topology (app container, database, networking, IAM task role and execution role). Provider versions must be pinned. Run terraform plan and include the annotated output as a submission artifact. Perform a destroy-and-redeploy: tear down the environment and re-apply from the Terraform config alone to prove IaC completeness."
- **What's missing:** Config completeness, exact provider pin, and a committed annotated plan artifact are all real and present. The one piece that is not: destroy-redeploy evidence for the deployment as it stands today, including this week's platform additions (SECRET_ENCRYPTION_KEY, both new OAuth-secret env vars, rate-limit config, etc.) — the only destroy-redeploy proof on file predates PF-900's env vars and covers a single, narrower resource. TRO-415/PF-901 (the ticket meant to close this) is explicitly Backlog and flagged as needing human sign-off before any real terraform destroy against the graded environment.
- **Suggested scope:** Once TRO-415/PF-901 gets its human go-ahead, run a real destroy → apply cycle against the current terraform/render/ topology (all three resources, not just the agent), and commit the proof the same way tro-316-destroy-redeploy-proof.md was committed for the narrower case. This is the same underlying gap as W6-R40 — closing one closes both.

> W6-R15 (device grant), W6-R18 (refresh rotation), W6-R21 (spec parity fitness test), W6-R44
> (route-fitness graded scenario), W6-R34 (SDK error union), W6-R66 (TS strict mode), and W6-R8/R9/R6
> (see above) all moved to VERIFIED this sweep — the six landed tickets closed them outright. See
> the Delta section below for each row's fresh evidence rather than duplicating it here.

### W6-R23 — MISSING
- **Quote:** "IEventBus interface. Domain layer publishes on writes — never the route layer. In-process implementation must-ship; queue-backed implementation is a Liskov-substitutable drop-in."
- **What's missing:** No IEventBus interface, no in-process implementation, and no publish() call exists anywhere in api/src (grep for 'IEventBus|EventBus|eventBus' across api/src and shared/src returns only events.ts's unrelated content, the architecture-doc-sections test, and this same documentService.ts scaffold comment). Ticket TRO-426/PF-301 is Backlog, consistent with the code state.
- **Suggested scope:** Ships when PF-301 (TRO-426, Backlog) ships. Smallest step: add an IEventBus interface + in-process synchronous implementation under api/src/platform/webhooks/, then redirect the ~9 route files that currently do inline document INSERT/UPDATE/DELETE (documents.ts, issues.ts, projects.ts, programs.ts, admin.ts, team.ts, workspaces.ts, feedback.ts, setup.ts — per PF-301's own ticket scoping note) through documentService.ts's write path, adding publish() calls there. documentService.ts already exists as the landing point but currently only has createDocument().

### W6-R24 — MISSING
- **Quote:** "Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."
- **What's missing:** (no code trace found)
- **Suggested scope:** Ships when PF-302 (TRO-431, Backlog) ships. Smallest step: a migration creating webhook_subscriptions (app_id, event_type, target_url, encrypted signing secret, active flag) plus an /api/v1/webhooks CRUD route mounted in router.ts and gated with the already-registered requireScope('webhooks:manage') factory (api/src/platform/scopes/requireScope.ts already exists and is reusable).

### W6-R26 — MISSING
- **Quote:** "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m. Subscribers returning 5xx or timing out are retried; 4xx responses are treated as permanent failures and dead-lettered."
- **What's missing:** No deliverer, retry scheduler, or backoff logic exists anywhere in api/src (grep for backoff/exponential/retryScheduler/retry.*schedule turns up only unrelated files: ssm.ts's SSM-retry config, circuitBreaker.ts, db seed/migration-CLI retry helpers — none webhook-related).
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships — no partial version exists to point to; this is a full feature build (migration 045 + retry-schedule module with 1s/4s/16s/1m/5m/30m + jitter and 5xx/timeout-vs-4xx branching).

### W6-R27 — MISSING
- **Quote:** "After 6 failed attempts, deliveries land in a DLQ visible in the developer portal. Operators can replay manually; replays carry the original idempotency key."
- **What's missing:** (no code trace found)
- **Suggested scope:** Ships when PF-304 (deliverer/DLQ, TRO-438) and PF-503 (portal DLQ view + replay button, TRO-439) both ship — neither exists yet; both are Backlog. No smaller slice closes this gap since it requires both the DLQ mechanism and its portal surface.

### W6-R28 — MISSING
- **Quote:** "webhook_deliveries table records every attempt with subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms. Queryable per app."
- **What's missing:** (no code trace found)
- **Suggested scope:** Ships when PF-304 (migration 045 for webhook_deliveries, TRO-438) and PF-305 (per-app delivery-log query API, TRO-442) ship — neither the table nor the query route exists yet.

### W6-R29 — MISSING
- **Quote:** "/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."
- **What's missing:** No Linear ticket in the given W6 population maps to PF-306 by title or PF-number — PLUGFORGE.MD:251 defines PF-306 ('Replay') as its own ticket-shaped unit of work, distinct from PF-304/PF-305, but no corresponding Linear issue was found in the supplied ticket list. This looks like an unticketed gap worth flagging to the PM independent of the code gap.
- **Suggested scope:** No ticket currently covers this scope; smallest fix is two-part: (1) file a PF-306 ticket, (2) once PF-304/PF-305's delivery log exists, implement POST /api/v1/webhooks/deliveries/:id/replay re-emitting the logged event with its original Idempotency-Key.

### W6-R30 — MISSING
- **Quote:** "@ship/sdk exposes resource clients: client.documents, client.issues, client.sprints, client.webhooks. Method signatures match OpenAPI spec; drift fails CI via a fitness test."
- **What's missing:** No sdk/ directory, so no DocumentsClient/IssuesClient/SprintsClient/WebhooksClient classes and no spec↔SDK parity fitness test exist anywhere in the repo (confirmed by the same sdk/-absence evidence documented under W6-R9). TRO-407 (PF-401) and TRO-422 (PF-405) are both Backlog.
- **Suggested scope:** Ships when PF-401/TRO-407 (resource clients) and PF-405/TRO-422 (spec↔SDK parity fitness test wired into CI) land; PF-401 itself depends on PF-400's scaffold (TRO-405) existing first.

### W6-R31 — MISSING
- **Quote:** "ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser localStorage)."
- **What's missing:** Not implemented — no sdk/ exists (see W6-R9 evidence). TRO-418/PF-404 (primary implementer) is Backlog, and also depends on PF-106/TRO-425 (device grant, currently In Progress, not yet merged) for deviceLogin() to have a real server-side flow to drive. TRO-449/PF-802 is a downstream demo that will exercise the browser localStorage store once built, not itself an implementer.
- **Suggested scope:** Ships when PF-404/TRO-418 lands: authorizationCodeFlow()/deviceLogin() + MemoryTokenStore/FileTokenStore (+ browser localStorage store, exercised by PF-802/TRO-449). Blocked on PF-106/TRO-425 (device grant) merging to main first.

### W6-R32 — MISSING
- **Quote:** "for await (const doc of client.documents.iterate()) walks pages transparently. Cursors handled internally; consumer code never sees them."
- **What's missing:** Not implemented — no sdk/ exists. TRO-410/PF-402 is Backlog and depends on PF-400 (scaffold) and PF-401 (resource clients) landing first, since there is nothing to call `.iterate()` on yet.
- **Suggested scope:** Ships when PF-402/TRO-410 lands: async-iterator iterate() on SDK list clients with cursor handling fully internal. Needs PF-400 + PF-401 first.

### W6-R33 — MISSING
- **Quote:** "verifyWebhook(headers, rawBody, secret) returns true/false in one call. Tampered bodies fail; expired timestamps fail; missing v1 header fails."
- **What's missing:** The underlying cryptographic algorithm and shared cross-validation fixtures already exist and are well-tested via PF-303 (server-side signer.ts, Done), but the requirement explicitly names an SDK helper ('One-call SDK verifier') — no sdk/ package exists to hold it, and TRO-413/PF-403 (the ticket that wraps signer.ts's logic as an SDK-exported verifyWebhook) is Backlog.
- **Suggested scope:** Ships when PF-403/TRO-413 lands. Smaller gap than sibling SDK tickets — the algorithm and shared test vectors already exist (PF-303); PF-403 mainly needs sdk/ to exist first (PF-400) as a home for the thin wrapper + its own test suite.

### W6-R35 — MISSING
- **Quote:** "Per-app and per-token token-bucket limits. Public responses carry X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset; 429 responses carry Retry-After."
- **What's missing:** Grepped api/src for X-RateLimit, RateLimit-Limit/Remaining/Reset, Retry-After, and TokenBucket implementations (not just the string 'Token' or 'Bucket' separately) — zero hits outside comments/READMEs describing the not-yet-built feature. The only rate-limiting code that touches /api/v1 today is the exemption from the legacy per-IP/per-identity limiters (PF-004/TRO-401, Done) — that is a prerequisite, not the requirement itself. TRO-552 (Backlog) is a narrower follow-up about the exemption predicate's own test coverage at segment boundaries, tangential but related to the same code path. No ambiguity here — the code plainly does not implement token buckets or the three headers; verdict is a direct observation, not an inference.
- **Suggested scope:** Build TRO-427 (PF-500): implement per-app and per-token token-bucket limiters in api/src/platform/ratelimit/ (currently an empty stub), wire them onto the /api/v1 router, and emit X-RateLimit-Limit/X-RateLimit-Remaining/X-RateLimit-Reset on every v1 response plus Retry-After on 429s. Unit-test bucket exhaustion/refill with an injected clock (per the requirement's own acceptance evidence). This is currently deferred to post-MVP by an explicit Wave-3 scoping decision, so the gap will not close until that ticket is picked up.

### W6-R36 — MISSING
- **Quote:** "Every public API call recorded with timestamp, app client_id, user_id, route, scope used, status, latency. Queryable in the developer portal."
- **What's missing:** Confirmed no public_api_audit table exists: grepped api/src/db/schema.sql and every migration (highest is now `046_oauth_device_codes_polling.sql`, landed by TRO-425/PF-106 this range — unrelated to audit logging) — no public_api_audit anywhere. **Update 2026-08-14:** the comment in `bearerAuth.ts:30` and this section's own baseline text named "migration 046" as PF-501's future slot — that specific number is now stale, since migration slot 046 was taken by tonight's unrelated device-grant work. PF-501's eventual migration will land as 047+. The substantive gap (table doesn't exist) is unchanged.
- **Suggested scope:** Build TRO-432 (PF-501): a migration (047+) creating public_api_audit (timestamp, app client_id, user_id, route, scope, status, latency columns per the requirement), middleware that writes one row per /api/v1 call, and a query surface (GET /api/v1/audit, admin/owner-scoped) for the portal to read from. Currently deferred post-MVP; also a listed blocker for the portal's audit view (W6-R37) and for PF-703's audit-trail proof.

### W6-R37 — MISSING
- **Quote:** "In-app UI for: listing apps, registering apps, viewing/rotating client_secret (shown once), managing subscriptions, browsing the delivery log, replaying failed deliveries."
- **What's missing:** Grepped web/src case-insensitively for 'oauth' and 'webhook' — only Login.tsx, OAuthConsent.tsx (the consent screen, unrelated to app management), and main.tsx (routing) match; no portal/app-registration/webhook-subscription/delivery-log/DLQ/replay components anywhere. Also searched e2e/ for portal or oauth-app specs — none exist, consistent with no UI to test. TRO-443 (PF-504, 'Portal scope checkpoint') is a go/cut evaluation ticket about whether to build the portal at all if Epic 6 runs late — included in the ticket list as directly relevant context, but it does not itself implement any of the six UI functions.
- **Suggested scope:** Build TRO-436 (PF-502: app list/register/detail/rotate) and TRO-439 (PF-503: subscription CRUD, delivery log with pagination, DLQ view, replay button) as new pages/components in web/src. Both depend on backend groundwork that is also missing or in-progress: PF-500/501 for rate-limit/audit visibility, and PF-301/302/305/306 (webhook domain, subscriptions API, delivery log API, replay) for the delivery/DLQ half. Given the dependency chain and the existence of TRO-443's kill-criterion ticket, this may legitimately be a 'ships when Epic 6 leaves room' item rather than a small fix.

### W6-R38 — PARTIAL
- **Quote:** "terraform/ directory describing app container, database, VPC/subnets, and security groups. All provider and module versions pinned. terraform plan must run cleanly; no unpinned versions permitted."
- **What's missing:** App-container + database + pinned providers + a clean committed plan are all real (I could not re-run terraform myself — no terraform binary in this sandbox, confirmed via `which terraform` — so the plan-cleanliness claim rests on the committed capture, not a run I performed). The one genuine content gap: the brief's literal 'VPC/subnets, and security groups' language has no dedicated adaptation defense anywhere — docs/IAM-ADAPTATION-RENDER.md (PF-902) is scoped to IAM/task-role, not network topology, and the only network-adjacent material is a scattered one-line comment in postgres.tf plus a README table row about ip_allow_list. This isn't a blocker (Render genuinely has no VPC/SG primitives, so there's nothing more to configure), but the brief also wants the adaptation *defended*, and that defense is thin/scattered rather than consolidated.
- **Suggested scope:** Add a short paragraph to docs/IAM-ADAPTATION-RENDER.md (or a new small section in docs/architecture.md's Cross-References) explicitly naming that Render has no VPC/subnet/security-group resource type, listing what this repo's config does instead (region-scoped services, ip_allow_list defaults, private-network-only Postgres per the null ipAllowList finding in terraform/render/README.md:125), and why that's an acceptable trade for this deployment — mirroring the IAM section's own structure.

### W6-R40 — PARTIAL
- **Quote:** "Demonstrate drift: manually change a resource, run terraform plan, show the detected diff. Perform terraform destroy then terraform apply from scratch. Submit screenshots or log output proving the service came back up identically."
- **What's missing:** Searched for any manual-drift demo against the live Render dashboard (PLUGFORGE.MD's own AC: 'change an env var in the Render dashboard -> terraform plan shows the diff') — found none; grep for 'dashboard.*drift'/'manual-drift' across terraform/, docs/, memory-bank/ returned nothing. The only drift demo in this repo (audit/terraform/drift-demo/, dated 2026-07-27) is the W4 local-provider exercise governed by interpretation I-01 — a different requirement (W4-R26), a different provider (hashicorp/local, 2 local_file resources), not the Render deployment this requirement is about. The destroy-redeploy half has real, executed proof, but scoped to one resource (the FleetGraph agent) from before this week's platform env vars existed — not the full current topology. TRO-415/PF-901, the ticket that owns both halves of this requirement, is still Backlog with no scorecard/review-findings entries (confirmed by grep against audit/factory/scorecard.jsonl and review-findings.jsonl).
- **Suggested scope:** Same remediation as W6-R12: TRO-415/PF-901 needs to actually run, producing both artifacts this requirement names — (1) a live dashboard-edit-then-plan-diff drift demo against terraform/render/, and (2) a destroy/apply cycle against the full current topology (ship + agent + postgres, all 8 new PF-900 env vars included), not just the agent-only slice already proven. Blocked on the human go-ahead memory-bank/progress.md:163-164 already flags.

### W6-R42 — PARTIAL
- **Quote:** "Complete the Authorization Code + PKCE flow in a Playwright test from a registered web app. Confirm that a wrong code_verifier on the token exchange returns invalid_grant (negative case is mandatory, not optional)."
- **What's missing (updated 2026-08-14):** Same underlying gap as W6-R3, same conclusion: the mandatory wrong-verifier negative case is real and passing (now 32/32 in token.test.ts, up from 18/18), but still lives only in the vitest suite, not chained onto the Playwright authorize→consent flow (`e2e/oauth-authorize.spec.ts`, byte-identical to baseline). No backend blocker remains.
- **Suggested scope:** Same as W6-R3: add the wrong-verifier negative case to the same new/extended Playwright spec once it exists — pure test-authoring, no backend work needed.

### W6-R43 — PARTIAL (was MISSING)
- **Quote:** "Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."
- **What's missing:** The device-grant mechanics are now rigorously proven: `api/src/platform/oauth/__tests__/device.test.ts`'s poll-to-approval test (deterministic clock, real DB) shows the slow_down interval genuinely compounding across three early polls (5s→10s→15s), then a successful token mint, then that token resolving the correct principal through the REAL production `bearerAuth` middleware. What's still missing to satisfy the requirement's literal framing: (1) no CLI exists anywhere in the repo (confirmed: no `integrations/` directory, no CLI workspace package) — "from a test CLI" isn't literally satisfiable yet; (2) the token-introspection assertion in device.test.ts calls a scratch Express app mounting `bearerAuth` directly, not literally `GET /api/v1/me` (which now exists, per W6-R9, but isn't exercised by this specific test).
- **Suggested scope:** The mechanics are done. What remains is packaging: build the CLI (PF-600/TRO-448, Backlog), and either extend device.test.ts (or a new integration test) to call the literal `/api/v1/me` route with the minted token instead of a scratch introspection app.

### W6-R45 — PARTIAL (was MISSING)
- **Quote:** "Validate the generated /api/v1/openapi.json against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert the SDK exposes a typed call for it."
- **What's missing:** The spec-validity half is now fully done: `api/src/platform/openapi/__tests__/document.test.ts` validates the real generated document against the official OpenAPI 3.1 JSON Schema (draft 2020-12) with a working negative control, landed by PF-202/TRO-402. The SDK-parity-walk half is still absent: `@ship/sdk` exposes only `ShipClient.me()` against the spec's 7 operations, and no walk of any kind exists (grepped `sdk/` and `api/src/platform/` for "parity" — the only hit is unrelated wording in a webhook signer test).
- **Suggested scope:** Ships when PF-401 (SDK resource clients, W6-R30) and PF-405 (the parity fitness test itself, TRO-422) land: walk every `v1OpenApiDocument` path/method and assert the SDK exposes a typed call for it. The spec-validity half needs no further work.

### W6-R46 — MISSING
- **Quote:** "Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s; verify the signature with the SDK helper; tamper with the body and verify the helper rejects it."
- **What's missing:** This graded e2e scenario requires: SDK-driven subscription creation (PF-302 + @ship/sdk, neither exists — find confirms no sdk/ directory anywhere in the repo), a working deliverer (PF-304, missing per W6-R26), and the SDK's verifyWebhook helper (PF-403/TRO-413, Backlog). None of the constituent pieces exist yet.
- **Suggested scope:** Ships only once the full chain lands: PF-302 (subscriptions API), PF-304 (deliverer), sdk/ package scaffold (PF-400, a hard dependency), and PF-403 (verifyWebhook, TRO-413). This is an integration-level graded scenario, not a single small fix.

### W6-R47 — MISSING
- **Quote:** "Make a subscriber return 500 on the first three attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each attempt) and that the fourth attempt records success in the delivery log."
- **What's missing:** (no code trace found)
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships with its deterministic-clock test suite, per PLUGFORGE.MD:249's own stated AC (500x3-then-200 with correct ≥1s/4s/16s waits).

### W6-R48 — MISSING
- **Quote:** "Force 6 consecutive failures. Verify the delivery lands in the dead-letter queue and is visible in the developer portal. Click \"Replay\" against a now-healthy subscriber and verify the replay succeeds with the original idempotency key intact."
- **What's missing:** Same underlying gap as W6-R27/W6-R29 combined into one graded scenario (DLQ + portal visibility + replay-with-original-key).
- **Suggested scope:** Ships when PF-304 (TRO-438) and PF-503 (TRO-439) ship, plus a PF-306-equivalent replay implementation (currently unticketed — see W6-R29's note).

### W6-R49 — MISSING
- **Quote:** "Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, pnpm install @ship/sdk → ship login → create document → receive verified webhook in under 30 minutes elapsed (in practice, seconds)."
- **What's missing:** No CLI package, no @ship/sdk package, no drill script, and no device-authorization-grant route (PF-106/TRO-425 is still 'In Progress', not merged) exist in the repo at 06a15f1. The full TTFE scenario this requirement describes (pnpm install @ship/sdk -> ship login -> create document -> receive verified webhook) has zero implementing code. This is a graded end-to-end scenario spanning PF-600 (CLI/ship login) and PF-603 (the drill itself); both are Backlog.
- **Suggested scope:** No small patch closes this — it requires the SDK package (PF-400/TRO-405, Backlog), the CLI with device-flow login (PF-600/TRO-448, Backlog), and the drill harness (PF-603/TRO-455, Backlog) to all exist, which in turn need PF-106's device grant route (TRO-425, In Progress) merged first. Ships when epic E6 is built per the dependency spine E0->E1->E2->{E3,E4}->E5->E6->E7 in PLUGFORGE.MD:212.

### W6-R50 — MISSING
- **Quote:** "≤ 30 min real elapsed; CI typically < 60 s"
- **What's missing:** No drill exists to instrument, so there is no <30min or <60s target being measured anywhere in CI or docs. TRO-455 (PF-603) titled '<60s, 0% flake over 20 runs' is the ticket that would implement this target but is Backlog.
- **Suggested scope:** Ships as part of PF-603 (TRO-455): once the drill exists, it must assert its own elapsed time against a <60s CI threshold and document the <30min real-elapsed clean-machine target per PLUGFORGE.MD:275.

### W6-R51 — MISSING
- **Quote:** "OAuth Auth Code + PKCE round-trip (P95)|< 3 s"
- **What's missing:** Searched CHANGES.md and the codebase broadly for any P95/round-trip timing instrumentation tied to the OAuth authorize/token flow -- none exists. The requirement's own acceptance evidence names PF-802 (browser SDK demo) as the thing that 'asserts it'; PF-802/TRO-449 is Backlog with no code in the repo (confirmed: only a passing doc-comment mention in CHANGES.md, no integrations/ or sdk-demo source). No performance measurement of the PKCE round-trip exists at this pinned commit.
- **Suggested scope:** Add a timing assertion to whichever Playwright spec ends up covering the full authorize->consent->token round trip once W6-R3/W6-R42's gap closes (measure wall-clock from authorize navigation to token receipt, assert < 3s) -- currently blocked on that same missing full-flow spec, and formally on PF-802 (TRO-449) landing per the PRD's own acceptance-evidence pointer.

### W6-R52 — MISSING
- **Quote:** "Webhook delivery latency (P95, first attempt)|< 2 s"
- **What's missing:** Non-functional latency target on a system that does not exist yet; nothing to measure.
- **Suggested scope:** No small fix — this is a measured-outcome requirement that can only be assessed once PF-304's deliverer (TRO-438, Backlog) is built and instrumented with latency_ms per delivery.

### W6-R53 — MISSING
- **Quote:** "Webhook retry success rate after transient 5xx|100% within configured schedule"
- **What's missing:** (no code trace found)
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships with retry tests + delivery-log evidence; same underlying build as W6-R26.

### W6-R54 — MISSING
- **Quote:** "Public API responses with rate-limit headers|100%"
- **What's missing:** This is the same code gap as W6-R35 (the PDF states it twice: once as a functional requirement on p.4, once as a scored NFR target on p.6), so I traced it to the identical evidence rather than treat it as independent. Grepped for any header-setting code (res.set/res.header/setHeader) near 'RateLimit' across api/src — none found. **Correction (2026-08-14):** baseline's suggested_scope said the fitness test itself didn't exist yet — it now does (`api/src/platform/api/v1/__tests__/route-fitness.test.ts`, landed by TRO-404/PF-203 this range) but contains zero RateLimit/Retry-After references, so wiring in the header-presence assertion is now a smaller, more concrete add-on than baseline's phrasing implied.
- **Suggested scope:** Same fix as W6-R35 (build TRO-427/PF-500). Closing this specific NFR additionally requires wiring a header-presence assertion into the now-existing route-enumeration fitness test (`api/src/platform/api/v1/__tests__/route-fitness.test.ts`) so the 100% figure is machine-verified per-route rather than asserted by inspection — no longer blocked on writing the fitness test itself.

### W6-R55 — MISSING
- **Quote:** "CLI drill harness: pnpm drill ttfe runs the full loop end-to-end against a containerized Ship instance from a clean working directory."
- **What's missing:** The 'pnpm drill ttfe' command does not exist anywhere in the monorepo — no script definition, no CLI harness, no testcontainers-based drill runner.
- **Suggested scope:** Ships with PF-603 (TRO-455): add a 'drill' script (root package.json) invoking a new drill harness under a new integrations/cli or a dedicated drill package, using testcontainers per the repo's existing pattern (used elsewhere for isolated DB tests) to spin up a containerized Ship instance from a clean working directory.

### W6-R56 — MISSING
- **Quote:** "Timing instrumentation: each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."
- **What's missing:** Since the drill itself (W6-R55) does not exist, there is no per-stage (install/login/register subscription/create document/receive webhook/verify signature) millisecond instrumentation to find. Confirmed via repo-wide grep for 'drill'/'ttfe' across all code_roots — only the three rate-limit/CORS comment hits and doc/progress mentions already cited under W6-R49/50 turned up.
- **Suggested scope:** Ships with PF-603 (TRO-455): the drill harness must record elapsed-ms per named stage and log/assert them, per PLUGFORGE.MD:275 ('Per-stage elapsed-ms instrumentation logged and asserted').

### W6-R57 — MISSING
- **Quote:** "Drill runs in CI on every PR. Any regression past the configured threshold fails the build."
- **What's missing:** Neither the graded GitLab CI nor the GitHub mirror runs any drill job on any PR — there is nothing to regress or gate. memory-bank/progress.md:183-186 records the design decision that the drill will be 'environment-dual: testcontainers locally/GitHub, native GitLab services: + direct boot in the graded pipeline' but confirms this is planned, not built ('the TTFE drill harness is new work').
- **Suggested scope:** Ships with PF-603 (TRO-455): add a CI job to both .gitlab-ci.yml and the GitHub Actions mirror that runs 'pnpm drill ttfe' on every PR and fails the build on a threshold regression, per the environment-dual design already recorded in memory-bank/progress.md:184-186.

### W6-R58 — MISSING
- **Quote:** "Webhook signature verification (SDK helper)|< 1 ms per call"
- **What's missing:** No perf test exists for the verify-side path at all (only sign() is perf-tested, by a different ticket/module), and neither lives in an SDK package. This is a non-functional target on an artifact (the SDK's verifyWebhook, W6-R33) that does not exist yet.
- **Suggested scope:** Ships when PF-403/TRO-413 lands with its own <1ms perf test for the SDK's verifyWebhook. A thin wrapper is likely to inherit signer.ts's already-proven sub-millisecond verify() performance, but that has not been measured directly nor packaged as SDK code yet.

### W6-R59 — MISSING
- **Quote:** "Drill flake rate over 20 consecutive CI runs|0% (any flake = bug in the drill or the platform)"
- **What's missing:** This is a process metric that presupposes the drill (W6-R55/56/57) is live in CI. Since none of that exists, there is no run history to measure a 0% flake rate against. Even after the drill is built, this requirement cannot be VERIFIED by a single code change — it needs 20 consecutive live CI runs to observe.
- **Suggested scope:** Not closable by a code change alone. First requires PF-603 (TRO-455) to ship and go live in the graded CI on every PR (closing W6-R55-57), then requires observing 20 consecutive runs with zero flakes — an elapsed-time/process requirement, not a point-in-time code fix.

### W6-R60 — MISSING
- **Quote:** "SDK install size (production deps only)|< 250 KB minified + gzipped"
- **What's missing:** No CI job checks bundle size for anything named sdk (grepped .gitlab-ci.yml, root package.json, and .github — zero hits for size-limit/bundlesize/250KB). Cannot be measured at all until sdk/ exists to measure; TRO-422/PF-405 is Backlog.
- **Suggested scope:** Ships when PF-405/TRO-422 lands: add a CI job (e.g. size-limit or an esbuild metafile check) gating sdk/'s production-dependency bundle at 250KB min+gz. No existing CI size-check infrastructure to extend — entirely new job, and requires sdk/ (PF-400) to exist first.

### W6-R61 — MISSING
- **Quote:** "Implement at Least 5 of the Following Integrations / Flows"
- **What's missing:** Directory-existence check (`ls integrations/`, `ls sdk/`) confirms neither exists in the working tree at 06a15f1. PLUGFORGE.MD §1.4.2 commits to exactly 5: CLI (must-ship) + refresh-rotation drill + Idempotency-Key drill + Browser SDK demo + Slack; GitHub App and plugin runtime are time-boxed stretch. All 8 matching Linear tickets (the 4-committed-in-E8 + CLI-in-E6 + 2 stretch + the E8 epic) are status Backlog. memory-bank/activeContext.md's 2026-08-13 entry confirms current factory focus is still E0-E2 (MVP path), nowhere near E6/E8. Zero of 5 required integrations exist.
- **Suggested scope:** Not a small fix — this is a multi-epic dependency chain. Every one of the 5 committed flows needs sdk/ (PF-400-405, Epic E4) to exist first, since integrations/* is constitutionally forbidden from importing api/src/ directly (PF-003's own enforcement script, already built and CI-wired). Sequence: E4 (sdk/) → E6 (PF-600 CLI) → E8 (PF-800/801/802/803). None have landed.

### W6-R62 — MISSING
- **Quote:** "CLI tool with device flow — ship login, ship docs ls/get/create, ship webhooks tail (must-ship)."
- **What's missing:** Repo-wide search for 'ship login', 'ship docs', 'ship webhooks', 'pnpm drill' finds these strings only in PLUGFORGE.MD (the spec) and docs/architecture.md (a design diagram) — never in actual source. This tracks exactly with the three PF-600/601/602 tickets all sitting in Backlog, and with their prerequisite PF-106 device-grant route (TRO-425) still In Progress and unmerged, so 'ship login' has no backend endpoint to call against yet either.
- **Suggested scope:** Ships when PF-600 (TRO-448, CLI scaffold + device-flow ship login), PF-601 (TRO-450, ship docs ls/get/create), and PF-602 (TRO-452, ship webhooks tail) are all implemented — three separate Backlog tickets under EPIC E6 (TRO-392). PF-600 additionally needs PF-106's device authorization grant route (TRO-425, currently In Progress) merged first, since the CLI's login command has nothing to call without it.

### W6-R63 — PARTIAL
- **Quote:** "the platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns — exactly as in Part 2."
- **What's missing:** Two-part requirement: (a) the platform layer makes zero LLM calls — TRUE for everything built so far, confirmed by direct grep, a real check not an inference; (b) the agent's LLM cost shape is unchanged by the rewire — UNVERIFIABLE yet because the rewire (Epic 7, PF-701-704) hasn't started, so there is no 'after' state to compare against agent/cost-ledger-snapshot.jsonl's pre-rewire baseline. Marked PARTIAL rather than MISSING because part (a) is affirmatively, currently true and independently checked — not merely undisclosed.
- **Suggested scope:** No code change needed for the negative claim itself (the grep sweep already confirms zero LLM-client imports under api/src/platform). Once Epic 7 (PF-700-704, agent SDK rewire) lands, capture a cost-ledger before/after comparison (agent/cost-ledger-snapshot.jsonl before vs. after the rewire) proving token volume is unchanged -- that before/after proof is the only outstanding half of this requirement's acceptance evidence.

### W6-R64 — MISSING
- **Quote:** "LLM API spend during the agent rewire (Epic 7) — track per-day spend while migrating direct service calls to SDK calls; confirm the rewire does not change token volume."
- **What's missing:** grep across docs/ for 'token volume', 'webhook fanout', '100k users', 'agent active rate' (the PF-905 §9-10 content this requirement's sibling W6-R65 also needs) returns zero matches anywhere in the repo. TRO-434 (PF-905) and TRO-440 (PF-704, whose AC literally reads 'cost-ledger before/after shows unchanged token volume (feeds PF-905)') are both status Backlog. There is no per-day spend tracking during the rewire because the rewire (PF-701-704) has not started.
- **Suggested scope:** Ships when Epic 7 ships — there is no 'per-day spend while migrating' to track until PF-701-704 actually perform the migration. Once they land, PF-905 (TRO-434) needs a dedicated doc pulling a pre/post pair from agent/src/costTracking.ts's ledger, distinct from the existing AI-COST-ANALYSIS.md (which should stay as-is; it answers a different question about the build process itself).

### W6-R65 — MISSING
- **Quote:** "Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls."
- **What's missing:** TRO-434 (PF-905: AI cost analysis) is status Backlog and has no CHANGES.md entry (grepped, zero hits) — not yet built. The only doc at the expected path is the prior week's (W5) cost report, reused-path but wrong content, not a partial draft of the W6 deliverable. Nothing in api/, terraform/, docs/, or memory-bank/ contains a platform-cost-at-scale tier table.
- **Suggested scope:** PF-905 ships when TRO-434 lands: a new committed doc (or a rewritten AI-COST-ANALYSIS.md section) with the 100/1k/10k/100k-user cost tier table and stated assumptions for webhook fanout ratio, agent active rate, and delivery-log/audit-row retention windows, traceable to ledger/CI data per the ticket's own AC.

> W6-R66 moved PARTIAL → VERIFIED this sweep, exactly as baseline's own suggested_scope predicted:
> `sdk/tsconfig.json` now extends the root strict config and `tsc --noEmit` exits 0 — see Delta.

### W6-R67 — MISSING
- **Quote:** "the Part 2 agent is rewired to authenticate as a first-party OAuth app and consume the public API through the SDK — same scopes, same rate limits, same audit trail."
- **What's missing:** grep -rn 'ship_app_fleetgraph' across agent/ and api/src/db/migrations/ returns zero matches (no seeded first-party app — PF-701). grep -rn 'AGENT_PLATFORM_MODE' across the whole repo (excluding node_modules) returns zero matches (no mode flag — PF-702/703/704). All of E7's tickets (TRO-393 epic, TRO-417 human checkpoint, TRO-423/428/435/440) are status Backlog, as is TRO-414 (PF-205, the v1 agent-read-surface ticket whose own title says it 'unblocks E7' — a hard prerequisite). Same-store, no CHANGES.md entries exist for any of TRO-393/414/417/423/428/435/440.
- **Suggested scope:** Epic-sized, not a small fix. Dependency chain per PLUGFORGE.MD's dependency spine: PF-205 (agent read surface, unblocks E7) → sdk/ (PF-400-405, Epic E4) → PF-700 (🔔 human checkpoint — blocks all E7 code until Troy acks per PLUGFORGE.MD §0.1) → PF-701 (seed first-party app) → PF-702 (reads via SDK) → PF-703 (gated writes via SDK) → PF-704 (flag matrix + audit proof). None have landed.

### W6-R68 — MISSING
- **Quote:** "The real queue-backed deliverer is tested with deterministic clock injection — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."
- **What's missing:** Requirement specifically concerns 'the real queue-backed deliverer' tests, which have no code to trace since PF-304 is unbuilt (TRO-438, Backlog). The Clock-injection convention this requirement mandates is already precedented elsewhere in the repo (signer.ts's Clock type + signer.test.ts's clockAt()), which the PF-304 implementer will presumably reuse, but that is a prediction, not evidence of compliance.
- **Suggested scope:** Ships when PF-304's deliverer is actually built and tested (TRO-438, Backlog) using deterministic clock injection — the pattern to follow already exists in api/src/platform/webhooks/signer.ts's Clock type and __tests__/signer.test.ts's clockAt() helper.

### W6-R69 — PARTIAL
- **Quote:** "External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced by a workspace dependency rule."
- **What's missing:** Ran the actual regression test directly (not part of a bare pnpm test) in the scratch worktree: `node --test scripts/__tests__/check-integration-deps.test.mjs` — 10/10 pass, 0 fail, including the violation-detection case. The enforcement mechanism itself is real, tested green, and wired into both the graded GitLab pipeline and the GitHub mirror — that part of the requirement ('Enforced by a workspace dependency rule') is genuinely built. What's still absent is the substantive fact the requirement's first clause describes: 'External integrations live in integrations/' — no such directory or package exists yet (confirmed: pnpm-workspace.yaml has no integrations/* member, and `ls integrations/` fails). PARTIAL rather than VERIFIED because the rule currently has nothing real to enforce against; PARTIAL rather than MISSING because the enforcement half is not merely planned but built, tested, and CI-wired.
- **Suggested scope:** Ships automatically once any package lands under integrations/* (E6/E8 work, e.g. PF-600 CLI scaffold via TRO-448) -- the enforcement script (scripts/check-integration-deps.mjs) is already built, tested (10/10), and wired into both CI pipelines. No additional code is needed for the rule itself, only a real integrations/* package for it to enforce against.

### W6-R72 — MISSING
- **Quote:** "The five-line story is the demo: open a fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail produces a verified signed delivery. Then switch to the dev portal and replay one delivery."
- **What's missing:** TRO-444 (PF-908) is status Backlog with no CHANGES.md entry. Both demo-script files present in docs/submission/ are for earlier weeks; neither is a draft of the W6 five-line-story script.
- **Suggested scope:** Ships when TRO-444/PF-908 lands: a new (or renamed/rewritten) script file with the five-line-story timecoded walkthrough — fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail verified delivery → switch to portal, replay one delivery.

### W6-R73 — MISSING
- **Quote:** "All three phases completed with written answers; saved AI conversation attached as a reference artifact."
- **What's missing:** TRO-429 (PF-904, HUMAN CHECKPOINT) is status Backlog; no CHANGES.md entry. The only pre-search document in the repo is the pre-existing FleetGraph (W5) one — same generic filename pattern, unrelated content (agent trigger model, node design, state management — not OAuth/platform topics, hours/day, skill inventory, budget ceilings).
- **Suggested scope:** Ships when TRO-429/PF-904 lands: either a new PRESEARCH-PLUGFORGE.MD (or equivalent) with the three PlugForge-specific phases pre-filled from the PRD plus Troy's real answers, and the saved AI conversation attached as a reference artifact — this is a HUMAN CHECKPOINT ticket, so it is also gated on Troy's actual input, not code alone.

### W6-R74 — MISSING
- **Quote:** "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at docs/openapi.json in the repo. Validate against the OpenAPI schema."
- **What's missing:** No `docs/openapi.json` file exists anywhere in the repo (repo-wide find returned nothing). No CI job in `.github/workflows/` (ci.yml, ci-failure-rollback.yml, agent-rollback-check.yml) or `.gitlab-ci.yml` mentions openapi. TRO-409 (PF-204) is status Backlog with no CHANGES.md entry. This requirement is fully blocked upstream: PF-202 (the v1 OpenAPI generator itself, TRO-402, status In Progress) hasn't landed either, so there is no live /api/v1/openapi.json to snapshot yet.
- **Suggested scope:** Blocked upstream by PF-202 (TRO-402, In Progress) landing the v1 generator + serving route first. Once that exists, PF-204/TRO-409 is: commit a docs/openapi.json snapshot, add a CI job that regenerates and diffs it against the live-generated spec, and fail the build on drift.

### W6-R75 — MISSING
- **Quote:** "Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication."
- **What's missing:** TRO-437 (PF-906) is status Backlog, no CHANGES.md entry. No per-epic (E0-E9) before/fix/after/proof write-ups exist anywhere under docs/ or memory-bank/ for the PlugForge epics; E6 (TTFE drill) and E7 (agent rewire) themselves are Backlog/In Progress so their proofs (CI-green drill, audit-log rows) don't exist yet either.
- **Suggested scope:** Blocked on the epics themselves landing first (E6 TTFE drill, E7 agent rewire) since the proof artifacts this requirement names are their outputs; the write-up document itself (TRO-437) is otherwise a same-size effort to PF-100/PF-903's doc tickets once those epics are done.

### W6-R76 — MISSING
- **Quote:** "Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pattern."
- **What's missing:** Same ticket (TRO-437/PF-906, Backlog) and same missing-artifact situation as W6-R75 — DISCOVERY.md exists at the expected path but is the prior week's content, not PlugForge-specific.
- **Suggested scope:** Same as W6-R75: ships when TRO-437/PF-906 lands a rewritten (or new) discovery doc drawing from the four named PlugForge candidates (Device Grant, zod-OpenAPI fitness parity, HMAC anti-replay, async-iterator pagination) rather than the W4/W5 audit discoveries currently at that path.

### W6-R77 — PARTIAL
- **Quote:** "Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus credentials in the README. Dev portal reachable; OpenAPI spec resolvable."
- **What's missing (updated 2026-08-14):** README credentials + one-command setup + the seeded read-only grader app remain real and done (TRO-441/PF-907, Done). Of the two DoD items baseline found missing — 'Dev portal reachable' and 'OpenAPI spec resolvable' — one is now closed at the code level: `/api/v1/openapi.json` is registered and publicly served (PF-202/TRO-402 landed; PR #192 recorded a live curl against a running instance, 200, independently re-validated against the real OpenAPI 3.1 schema). 'Dev portal reachable' remains genuinely missing — no portal component exists anywhere under web/src. Note: README.md:356's own caveat text still describes the OpenAPI gap as unbuilt — now stale and worth a small doc-freshness follow-up, though it doesn't change this verdict.
- **Suggested scope:** Narrowed from baseline: only TRO-436/PF-502 (developer portal — even a bare app-registration/detail page counts as 'reachable') remains to close this requirement's code-level gap. The OpenAPI-resolvable half is done pending a live-deploy reprobe (this sweep did not attempt network egress). Also refresh README.md:356's now-stale caveat text.

### W6-R78 — MISSING
- **Quote:** "Tag @GauntletAI. The screenshot is the ship webhooks tail terminal showing a verified signed event arriving in real time."
- **What's missing:** Same underlying ticket as W6-R72 (TRO-444/PF-908, Backlog, no CHANGES.md entry) — both the demo-video and social-post halves of PF-908 are unbuilt. All social-post drafts in docs/submission/ are for the earlier weeks' audit work.
- **Suggested scope:** Ships alongside W6-R72 when TRO-444/PF-908 lands: a new social-post draft tagging @GauntletAI with a screenshot of `ship webhooks tail` showing a verified signed event arriving — depends on the CLI (PF-600/TRO-448, Backlog) and webhook delivery pipeline (E3, mostly Backlog) existing first to produce a real screenshot.

## Orphan tickets

Ticket-mapping scope this sweep: **95 tickets** in the PlugForge project (up from 86 at baseline) —
see `ticket_mapping.scope` in the matrix JSON for the exact population and rationale. **10 tickets**
map to zero requirements (up from 4 at baseline; EPIC container tickets TRO-386–395 excluded by
design, per requirements-audit's own Step 4 methodology):

- **TRO-396** "PF-001: Ship has no public API surface — platform scaffold + /api/v1 router (request IDs, public CORS)" — Foundational scaffolding ticket (Done). Its code (router.ts, requestIdMiddleware, public CORS setup) is cited as supporting EVIDENCE across many other requirements, but no PDF-graded requirement's own quote is specifically about the scaffold itself. Not a tracer oversight: there is no requirement line for PF-001 to attach to. (Unchanged from baseline.)
- **TRO-490** "Pre-existing: swagger.ts YAML converter emits mis-indented YAML (openapi.yaml) — JSON spec unaffected" — Internal tooling bug, pre-existing script; no PlugForge brief requirement covers it. (Unchanged from baseline.)
- **TRO-501** "Route-level createIssueSchema accepts 'none' priority — absent from IssuePriority union and OpenAPI schema" — A bug in the internal (non-v1) issues route's schema; no PlugForge brief requirement covers internal issue-priority validation. (Unchanged from baseline.)
- **TRO-551** "OpenAPI registry + MCP executor hardcode the /api prefix — non-/api routes (/oauth/*) cannot be registered without shipping 404ing MCP tools" — Ship-internal MCP/OpenAPI tooling fix (Done), thematically adjacent to PF-202 but not itself the subject of any graded requirement quote. (Unchanged from baseline.)
- **TRO-587** (NEW) "CodeQL js/insufficient-password-hash false-positive on oauth/credentials.ts — needs formal dismissal" — CodeRabbit/CodeQL review-triage follow-up from tonight's OAuth work; a security-scanner finding, not a requirement in the guideline PDF.
- **TRO-588** (NEW) "/oauth/* routes have no route-scoped rate limiting" — Review-triage follow-up; overlaps W6-R35's territory but is scoped to /oauth/* specifically, not named by any inventory requirement's text.
- **TRO-589** (NEW) "Device-grant user_code stored plaintext, not hashed" — Review-triage follow-up from PF-106/TRO-425 (landed tonight); a hardening finding, not itself a brief requirement.
- **TRO-590** (NEW) "CodeQL js/missing-rate-limiting has a blind spot: flags test-only Express apps as production routes" — CodeQL tooling-accuracy finding, unrelated to any inventory requirement's text.
- **TRO-591** (NEW) "Composite DB index opportunity flagged by PF-201's pagination work" — Performance-hardening follow-up from PF-201/TRO-400 (landed tonight); no inventory requirement names a specific index.
- **TRO-592** (NEW) "Shared pagination-router factory opportunity across v1 resources" — Code-reuse/refactor follow-up from PF-201's four new v1 resources; not itself a brief requirement.

Note: **TRO-593/594/595/596** (the 4 e2e-regression remediation tickets filed from this sweep's own
W6-R10 bisection) are NOT orphans — they are mapped directly to W6-R10 (see its Matrix row and Delta
entry), since they trace to the requirement's own "existing Playwright regression suite passes"
clause.

## Blocked / assumed

None, this sweep or the baseline. `needs_ruling` is empty (I-04, ruled at baseline, is the only
interpretation governing any W6 row and was applied silently per its own ruling — no new ambiguity
surfaced across any of the 79 re-traced rows this sweep). No row carries verdict `BLOCKED` or
`ASSUMED`.

## Delta

Compare sweep `w6-mvp-wave`, run 2026-08-14T09:51:08Z against commit `2418353` (clean tree), vs.
baseline `matrix.baseline-W6.json` (commit `06a15f1`, 2026-08-13T19:53:43Z). All 79 active
requirements were independently re-traced this sweep — this table lists only the 13 whose verdict
changed. Every other row's evidence citations were re-confirmed to still open and still support
their notes; several needed line-number corrections only (files that grew since baseline —
`CHANGES.md`, `memory-bank/*.md`, `token.ts`, `documents.ts`, `requireScope.ts`) and are called out
in their own Matrix/Gaps entries above where relevant, not repeated here.

| ID | baseline verdict | now | what changed |
|---|---|---|---|
| W6-R6 | PARTIAL | **VERIFIED** | PF-203/TRO-404's route-fitness test landed — 33/33 fresh, asserts the ApiError shape on every route's failure path via a live router-stack walk. |
| W6-R8 | MISSING | **VERIFIED** | PF-202/TRO-402 landed — /api/v1/openapi.json generated in-process, served, validated against the real OpenAPI 3.1 JSON Schema with a working negative control (9/9 fresh). |
| W6-R9 | MISSING | **VERIFIED** | PF-400/TRO-405 landed — `sdk/` now exists; `ShipClient.me()` proven via a real TCP round trip against a real running server (3/3 fresh), the requirement's own literal acceptance test. |
| W6-R10 | MISSING | **PARTIAL** | Three independently-verified compare-mode audits (api-perf/db-query/bundle) all PASS within the Part-1 ±10% budget; a rigorous bisection proves the 32 failing e2e tests are pre-existing and unrelated to W6 (zero code overlap vs. commit 6000c94) — but the suite does not pass in the unqualified sense the requirement's words state, so PARTIAL not VERIFIED. |
| W6-R11 | PARTIAL | **IMPLEMENTED-UNVERIFIED** | PF-202 landing closed the code-level "published OpenAPI spec URL" blocker baseline named; only a live-deployment probe (not attempted this sweep) remains. |
| W6-R15 | MISSING | **VERIFIED** | PF-106/TRO-425 landed — device grant fully implemented; deterministic-clock test proves slow_down interval genuinely compounds across three early polls, then a real usable token (9/9 fresh). |
| W6-R18 | MISSING | **VERIFIED** | PF-105/TRO-421 landed — one-time-use refresh rotation with family-wide revocation, proven by both a sequential-reuse case and a forced, deterministic concurrency race (32/32 fresh, up from 18/18). |
| W6-R21 | MISSING | **VERIFIED** | Same landing as W6-R6/R8 — route-fitness.test.ts's check (a) is exactly the spec↔route parity walk this requirement names (33/33 fresh). |
| W6-R34 | MISSING | **VERIFIED** | PF-400/TRO-405's error module ships the full discriminated union (superset of the requirement's 5 named kinds), exhaustively mapped and tested (16/16 fresh). |
| W6-R43 | MISSING | **PARTIAL** | Device-grant mechanics (slow_down honored, resulting token usable) now rigorously proven — but no CLI exists yet, and the token-usability test calls a scratch app, not literally `/api/v1/me`. |
| W6-R44 | MISSING | **VERIFIED** | Same landing as W6-R6 (this is the graded-scenario framing of the same fitness test) — 33/33 fresh across all 4 assertions. |
| W6-R45 | MISSING | **PARTIAL** | Spec-validity half now fully proven (document.test.ts, real schema + negative control); SDK-parity-walk half still absent — SDK has only 1 of 7 spec operations implemented, no walk exists. |
| W6-R66 | PARTIAL | **VERIFIED** | Exactly as baseline's own suggested_scope predicted: `sdk/tsconfig.json` now extends the root strict config and `tsc --noEmit` exits 0. |

**What did NOT move, worth naming explicitly:** W6-R3 and W6-R42 (the literal graded PKCE
Playwright scenario) stayed PARTIAL despite every backend piece they need now existing —
`e2e/oauth-authorize.spec.ts` has zero diff since baseline. This is the sweep's sharpest finding:
six MVP-gate tickets landed and the literal end-to-end e2e still isn't assembled, purely because no
one wrote the connecting test. W6-R12/R38/R39/R40 (Terraform/IaC) also stayed unchanged — `terraform/`
has zero diff in this range, confirmed via `git diff --stat`. All 15 webhooks-cluster rows (E3),
all 9 CLI/TTFE-cluster rows (E6/E8), all 4 rate-limit/audit/portal rows (E5), all 4 agent-rewire
rows (E7), and all 10 docs/process rows stayed at their baseline verdict — independently confirmed
by five parallel subagents, each of whom verified via `git diff --stat` that no code in their
cluster's territory changed, then re-opened every cited file to confirm the citation still holds
(finding and fixing several stale evidentiary claims along the way — e.g. W6-R36/R54's "migration
046" references, made stale by tonight's unrelated device-grant work taking that migration slot;
W6-R77's evidence, since PF-202 landing closed one of its two named DoD gaps even though its
verdict label stayed PARTIAL).

## Verification performed

### Compare sweep (2026-08-14, `w6-mvp-wave`) — commands run this pass

| Command | Result | Bears on |
|---|---|---|
| `cd api && DATABASE_URL=...ship_audit_w6mvp_scratch npx tsx src/db/migrate.ts` | 51 migration(s) applied successfully | (scratch DB setup) |
| `cd api && ... npx vitest run route-fitness/error-middleware/errors/documents/issues/sprints/me.test.ts` | 7 test files, 77 tests passed (77) | W6-R5, W6-R6, W6-R20, W6-R21, W6-R44 |
| `cd api && ... npx vitest run bearerAuth/app-registration/token/device/authorize/seedGraderApp/registry/boundary-lint/v1-router/document/endpoint.test.ts` | 11 test files, 102 tests passed (102) | W6-R2, W6-R4, W6-R7, W6-R8, W6-R13, W6-R14, W6-R16, W6-R17, W6-R19 |
| `cd api && ... npx vitest run token.test.ts device.test.ts` (isolated re-run for per-file counts) | 2 test files, 41 tests passed (41) — 32 token.test.ts, 9 device.test.ts | W6-R14, W6-R15, W6-R18, W6-R43 |
| `cd api && ... npx vitest run signer.test.ts events.test.ts` | 2 test files, 42 tests passed (42) | W6-R22, W6-R25 |
| `cd sdk && npx vitest run client.test.ts errors.test.ts` | 2 test files, 26 tests passed (26) | W6-R9, W6-R34 |
| `cd sdk && DATABASE_URL=...ship_audit_w6mvp_scratch npx vitest run src/__tests__/client.liveServer.test.ts` | 1 test file, 3 tests passed (3) — real TCP round trip, real http.Server wrapping createApp() | W6-R9 |
| `cd sdk && npx tsc --noEmit -p tsconfig.json` | exit 0, no output | W6-R66 |
| `gh repo view ...; git log --oneline --merges 06a15f1..2418353; gh pr view 192 --json body` | PUBLIC, deleteBranchOnMerge:false; 6 distinct per-ticket merge PRs (#192/193/194/195/197/198); PR #192 body confirms mandated PR-discipline pattern | W6-R71 |
| Read `audit/api-perf/compare-w6-r10-aug14/after-w6-r10-aug14.md`, `audit/db-query/compare-w6-r10-aug14/after-w6-r10-aug14.md`, `audit/bundle/compare-w6-aug14/after-w6-aug14.md` directly (not re-run) | All three PASS vs. 2026-07-27 Part-1 baseline, each disclosing real confounds (Postgres version skew, gzip landing independently, one load-contaminated window disproven by a quiet-load recheck) | W6-R10 |
| Read `memory-bank/activeContext.md:23` directly | Three-pass e2e bisection: 32 failures confirmed pre-existing, zero code overlap vs. commit 6000c94; filed as TRO-593..596 | W6-R10 |
| `pnpm test` (full root suite) / `pnpm test:e2e` (full Playwright suite) | NOT RUN | W6-R10 |
| `terraform plan/apply/destroy` against `terraform/render/` | NOT RUN | W6-R12, W6-R38, W6-R39, W6-R40 |
| Live network probe of any deployed URL | NOT RUN | W6-R11, W6-R77 |
| `mcp__linear__list_issues` scoped to the PlugForge project | 95 tickets returned (up from 86 at baseline) | ticket_mapping |
| Five parallel subagent sweeps, each independently confirming via `git diff --stat 06a15f1..2418353` that their cluster's territory had zero relevant code changes, then re-opening every cited file | Webhooks (15 rows), rate-limit/audit/portal (4 rows), CLI/TTFE/integrations (9 rows), agent-rewire/cost (4 rows), docs/process (10 rows) — all 42 rows carried forward unchanged, several evidence corrections found and fixed (see Delta) | W6-R22–R29, R35–R37, R46–R48, R49–R57, R52–R53, R54, R58–R59, R61–R63, R65, R67–R69, R1, R70–R73, R75–R76, R78–R79 |

### Baseline (2026-08-13) — carried forward for reference

| Command | Result | Bears on |
|---|---|---|
| grep -n 'W6-R49\\|W6-R50\\|W6-R55\\|W6-R56\\|W6-R57\\|W6-R59\\|W6-R62' audit/requirements/inventory-W6.md; then Read lines 440-599 | Extracted exact Quote/Meaning/Type/Acceptance-evidence text for all 7 assigned IDs | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59, W6-R62 |
| Read audit/requirements/interpretations.md in full | Only I-01, I-02, I-03 exist, governing W4-R26 and W5-*/W5-R36 — none govern any W6 ID, confirmed empty for W6 as expected | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59, W6-R62 |
| find . -maxdepth 4/5 -iname '*drill*' / '*integrations*' / '*cli*' (excluding node_modules) | No drill or integrations directory anywhere; 'cli' hits are all unrelated (db/client.ts, codacy CLI, docs file names) | W6-R49, W6-R55, W6-R62 |
| cat pnpm-workspace.yaml; cat package.json (root scripts) | Workspace packages: api, web, shared, agent only — no sdk/cli package; root scripts have no 'drill' entry | W6-R49, W6-R55, W6-R62 |
| grep -rniI 'ttfe\\|drill' across *.ts/*.tsx/*.js/*.json/*.yml/*.yaml/*.md/*.sh (excluding node_modules, dist, audit/requirements) | Only hits: CHANGES.md (2 comment mentions), memory-bank/progress.md (2 mentions confirming build-not-started), api/src/middleware/rate-li... | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59 |
| Read CHANGES.md:1590-1610, CHANGES.md:2045-2065, memory-bank/progress.md:175-220 | Confirms the TTFE-drill mentions are forward-looking justification comments only; progress.md 2026-08-10 kickoff entry states explicitly ... | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59, W6-R62 |
| grep -rniI 'device.*flow\|device_code\|device authorization' api/src shared/src; grep -rniI 'ship login\|ship docs\|ship webhooks\|pnpm drill' . (excl node_modules/dist/audit/requirements) | Device-grant hits are only test-file references expecting the feature (architectureDocSections.test.ts, migrations-042-043.test.ts) — no ... | W6-R49, W6-R62 |
| find api/src -iname '*oauth*' (excl __tests__) | No device/code or device/verify route file exists among oauth-apps.ts, oauth-authorize.ts, oauth-token.ts — confirms PF-106 (device grant... | W6-R49, W6-R62 |
| find .github .gitlab-ci.yml -maxdepth 3 -type f; grep -rniI 'drill\|ttfe' .github .gitlab-ci.yml | CI files present (ci.yml, ci-failure-rollback.yml, agent-rollback-check.yml, .gitlab-ci.yml) but zero mentions of drill/ttfe in any of them | W6-R50, W6-R55, W6-R56, W6-R57, W6-R59 |
| ls scripts/; grep -rniI 'drill\|ttfe' scripts/ e2e/; grep -n 'drill' package.json api/package.json web/package.json shared/package.json agent/package.json; grep -ni ... docker-compose.local.yml README.md PRESEARCH.MD FLEETGRAPH.MD | Zero matches anywhere in scripts/, e2e/, any package.json script block, docker-compose.local.yml, README.md, PRESEARCH.MD, FLEETGRAPH.MD | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59, W6-R62 |
| grep -n 'PF-60\|E6' PLUGFORGE.MD; sed -n '145,170p' docs/architecture.md | Confirmed PF-600/601/602/603 spec text used for ticket-mapping notes; confirmed docs/architecture.md's device-flow section is an ASCII de... | W6-R49, W6-R62 |
| grep -n '"name"' */package.json; find . -maxdepth 3 -iname package.json (excl node_modules) | Confirmed only @ship/web, @ship/api, @ship/shared, @ship/agent exist as packages — no @ship/sdk, no CLI package | W6-R49, W6-R62 |
| vitest / e2e targeted test run for any drill/CLI test file | NOT RUN | W6-R49, W6-R50, W6-R55, W6-R56, W6-R57, W6-R59, W6-R62 |
| pnpm type-check (run centrally by orchestrator) | exit 0 — all packages clean | W6-R22, W6-R23, W6-R24, W6-R25, W6-R26, W6-R27, W6-R28, W6-R29, W6-R46, W6-R4... |
| Read audit/requirements/inventory-W6.md (full file) and audit/requirements/interpretations.md | Extracted W6-R35/R36/R37/R54 quotes; confirmed interpretations.md has no ruling governing any of these four IDs (only I-01/I-02/I-03, all... | W6-R35, W6-R36, W6-R37, W6-R54 |
| grep -n 'PF-500\\|PF-501\\|PF-502\\|PF-503\\|PF-504\\|EPIC E5' PLUGFORGE.MD | Confirmed the five PF-numbers (500-504) and their AC text under EPIC E5, used to map tickets and cite ACs. | W6-R35, W6-R36, W6-R37, W6-R54 |
| find api/src/platform/ratelimit and api/src/platform/audit for files; Read both READMEs | Both directories contain only a README stating 'Empty until PF-500/PF-501 lands' — no implementation code. | W6-R35, W6-R36, W6-R54 |
| grep -n 'X-RateLimit\|RateLimit-Limit\|RateLimit-Remaining\|RateLimit-Reset\|Retry-After\|TokenBucket' across api/src, shared/src, terraform, api/src/openapi | Zero implementation hits (only doc/comment references describing the future feature). | W6-R35, W6-R54 |
| grep -n 'public_api_audit' api/src -r; ls api/src/db/migrations \| tail -20; find api/src/db/migrations -name '046*' | No public_api_audit table in schema.sql or any migration; highest migration is 044; only two comment-level references to the not-yet-buil... | W6-R36 |
| grep -rli 'oauth' and 'webhook' web/src; ls web/src/pages; find e2e -iname '*portal*' -o -iname '*oauth-app*' -o -iname '*webhook*' | No portal/app-management/webhook UI components or e2e specs exist; only Login.tsx and OAuthConsent.tsx (the consent screen, a different r... | W6-R37 |
| grep -n 'isLegacyLimiterExemptPath\|export function createApiRateLimiters' api/src/middleware/rate-limit.ts; read context around lines 110-150 and 200-360 | Confirmed the PF-004/TRO-401 exemption (skip predicate) is real and wired at lines 212/333/351 — the prerequisite is done, distinct from ... | W6-R35, W6-R54 |
| grep -n 'PF-500\|PF-501\|PF-502\|PF-503\|PF-504\|TRO-427\|TRO-432\|TRO-436\|TRO-439\|TRO-443' CHANGES.md | Multiple corroborating changelog entries (TRO-430, TRO-401) explicitly stating PF-500/PF-501 have not landed as of those tickets. | W6-R35, W6-R36, W6-R54 |
| grep -n 'PF-500\|PF-501\|PF-502\|PF-503\|portal\|E5' memory-bank/progress.md | Line 91: dated Wave-3 scoping note 'PF-500/501 deferred as post-MVP' — direct confirmation from the project's own working memory. | W6-R35, W6-R36, W6-R37, W6-R54 |
| find api/src -iname '*fitness*' -o -iname '*route-enum*' | No fitness-test file exists in the repo at all, confirming the header-presence assertion PF-500's AC and W6-R54 reference has no home to ... | W6-R54 |
| cd Ship-wt-audit_w6/api && npx vitest run <targeted file> | NOT RUN | W6-R35, W6-R36, W6-R37, W6-R54 |
| cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && source ../.factory-env && npx vitest run src/platform/webhooks/__tests__/events.test.ts src/platform/webhooks/__tests__/signer.test.ts | Both files green: signer.test.ts 20/20 passed (421ms), events.test.ts 22/22 passed (377ms). Test Files 2 passed (2), Tests 42 passed (42). | W6-R22, W6-R25 |
| grep -rln "IEventBus\|EventBus\|eventBus" api/src shared/src ; grep -rln "webhooks:manage" api/src shared/src ; grep -rln "webhook_deliveries\|webhook_subscriptions" api/src ; find . -maxdepth 2 -iname sdk -o -iname integrations ; grep -rln "backoff\|exponential.*jitter\|retryScheduler" api/src | Confirmed: no IEventBus/deliverer/subscriptions/DLQ/replay code exists anywhere in api/src or shared/src beyond planning comments and the... | W6-R23, W6-R24, W6-R26, W6-R27, W6-R28, W6-R29, W6-R46, W6-R47, W6-R48, W6-R5... |
| cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/services/documentService.ts (webhook deliverer / DLQ / replay / subscriptions test targets) | NOT RUN | W6-R23, W6-R24, W6-R26, W6-R27, W6-R28, W6-R29, W6-R46, W6-R47, W6-R48, W6-R5... |
| cd /Users/troy/repos/GAUNTLET/Ship && git rev-parse HEAD && git rev-parse main | both return 06a15f147d443fbe405b51d4ea77ea2141f21e6e — confirmed the repo root is exactly at the pinned commit on main | W6-R5, W6-R8, W6-R20, W6-R21, W6-R44, W6-R45 |
| cd /Users/troy/repos/GAUNTLET/Ship && git merge-base --is-ancestor feat/pf-202-openapi-v1-generator main; git log --oneline main..feat/pf-202-openapi-v1-generator | not an ancestor; 3 unmerged commits (04edbdd feat, 9d0216b test, 263582e docs, all TRO-402) sitting on an unmerged branch | W6-R8, W6-R21, W6-R45 |
| cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/platform/api/v1/resources/__tests__/documents.test.ts | PASS — 8/8 tests, 1 file, 458ms. AC-1 (pagination stability), AC-2 (GET :id incl. 404), AC-3 (POST + scope 403), AC-4 (validation_failed/... | W6-R5, W6-R20 |
| grep -rln "fitness\|route-enumeration\|enumerat" --include=*.ts api/src web e2e shared agent scripts | no hits relevant to a route-enumeration walk (the few hits that matched substrings — collaboration/index.ts, itemStore.ts, graph.ts, gate... | W6-R21, W6-R44 |
| find /Users/troy/repos/GAUNTLET/Ship -maxdepth 2 -type d ; cat pnpm-workspace.yaml | workspace packages are exactly api, web, shared, agent — no sdk/ directory or workspace entry exists | W6-R45 |
| pnpm test (whole api suite) / pnpm test:e2e | NOT RUN | W6-R5, W6-R8, W6-R20, W6-R21, W6-R44, W6-R45 |
| Read audit/requirements/inventory-W6.md (full file, 724 lines) | Extracted exact Quote/Meaning-in-code/Type/Acceptance-evidence text for W6-R9, R30, R31, R32, R33, R34, R58, R60. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| grep -n 'PF-40\|PF-303\|PF-403\|PF-105\|Epic 4\|EPIC E4' PLUGFORGE.MD | Located PF-400..PF-405 (lines 255-260) and PF-303 (line 248) definitions, confirming which Linear ticket implements each requirement. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| git log --oneline -1; ls -la; find . -maxdepth 2 -iname '*sdk*' -not -path './node_modules/*' | HEAD is 06a15f1 (matches pinned commit). No sdk-named directory found anywhere at repo root. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| cat pnpm-workspace.yaml | packages: api, web, shared, agent — no 'sdk' entry. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| grep -rl 'ShipClient' --include='*.ts' --include='*.tsx' --include='*.md' . (excluding node_modules/dist) | Only hits are agent/src/*.ts (FleetGraph's own unrelated ShipClient), docs/architecture.md (design doc), memory-bank/progress.md, CHANGES... | W6-R9, W6-R31 |
| Read agent/src/shipClient.ts (lines 1-60) | Confirmed via docstring this is FleetGraph's internal client (GET /api/change-feed, /api/documents/:id, /api/team/people) — unrelated to ... | W6-R9 |
| Read docs/architecture.md (lines 180-250, SDK Surface + Agent-as-Citizen sections) | Confirms the planned (design-only) ShipClient shape, resource clients, verifyWebhook, ITokenStore, iterate() — explicitly future-tense, n... | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58 |
| Read memory-bank/activeContext.md (full file) | Confirms PF-400/TRO-405 is one of 'the last two MVP-gate tickets' still pending as of 2026-08-13, not yet dispatched to a builder; no SDK... | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| grep -n 'PF-303\|Ship-Signature' api/src -l; find api/src -iname '*signature*' -o -iname '*signer*' -o -iname '*hmac*'; find shared -iname '*webhook*' -o -iname '*signature*' | Found api/src/platform/webhooks/signer.ts + signer.test.ts (PF-303/TRO-433, Done, server-side) and shared/fixtures/webhook-signature-vect... | W6-R33, W6-R58 |
| Read api/src/platform/webhooks/signer.ts (full file) | Confirmed server-side verify(header, rawBody, secret, toleranceSeconds, clock) exists with correct semantics, but is not an SDK-exported ... | W6-R33 |
| Read api/src/platform/webhooks/__tests__/signer.test.ts (lines 195-260) | Perf test at lines 203-221 asserts sign() mean < 5ms (target < 1ms) — NOT a verify()-side perf test, and lives in api/ not sdk/. | W6-R58 |
| grep -rn 'ApiErrorKind\|kind: .auth.\|SdkError\|DiscriminatedError' repo-wide (excluding node_modules/dist) | Zero hits outside the requirements-inventory files themselves. | W6-R34 |
| grep -rn '250 ?KB\|250KB\|size-limit\|bundlesize\|min+gz' .github .gitlab-ci.yml package.json | Zero matches — no CI size-check job exists anywhere. | W6-R60 |
| grep -n 'sdk/' CHANGES.md | Only 2 hits in the whole 1.37MB changelog: line 1854 (PF-903 entry explicitly confirming 'no ... sdk/ ... exists yet') and an unrelated @... | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| ls api/src/platform/api/v1/resources/ | Only documents.ts and workspaceContext.ts exist — no me.ts, issues.ts, or sprints.ts yet (PF-201/TRO-400 still In Progress). | W6-R9 |
| grep -n '@ship/sdk' pnpm-lock.yaml; grep -n '"name"' api/package.json web/package.json shared/package.json agent/package.json | No @ship/sdk anywhere in the lockfile; the four existing packages are @ship/api, @ship/web, @ship/shared, @ship/agent only. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58, W6-R60 |
| npx vitest run <sdk test file> | NOT RUN — no sdk/ package or test files exist anywhere in the repo for any of these 8 requirements; there is nothing to target. | W6-R9, W6-R30, W6-R31, W6-R32, W6-R33, W6-R34, W6-R58 |
| CI size-check job for sdk/ bundle | NOT RUN — no such job exists in .gitlab-ci.yml or .github, and there is no sdk/dist to measure. | W6-R60 |
| api/src/platform/webhooks/__tests__/signer.test.ts full suite | NOT RUN — this file belongs to a different requirement (W6-R25, another cluster's PF-303) and only perf-tests sign(), not the SDK verify(... | W6-R33, W6-R58 |
| git rev-parse HEAD | 06a15f147d443fbe405b51d4ea77ea2141f21e6e (confirms main repo HEAD is the pinned commit) | W6-R2, W6-R3, W6-R4, W6-R6, W6-R7, W6-R13, W6-R14, W6-R15, W6-R16, W6-R17, W6... |
| git merge-base --is-ancestor 33843e1 06a15f1 (device grant commit vs pinned) | NOT ancestor -- device flow work is not on main at this commit | W6-R15, W6-R43 |
| git merge-base --is-ancestor 82c6460 06a15f1 (refresh rotation commit vs pinned) | NOT ancestor -- refresh rotation work is not on main at this commit | W6-R18 |
| gh pr list --search pf-106 --state all / gh pr list --state all --limit 50 \| grep -i 425 | no PR found for TRO-425/pf-106 | W6-R15, W6-R43 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/oauth/__tests__/app-registration.test.ts | 10/10 passed | W6-R2, W6-R13 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/oauth/__tests__/token.test.ts | 18/18 passed | W6-R3, W6-R14, W6-R42 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/oauth/__tests__/bearerAuth.test.ts | 11/11 passed | W6-R4, W6-R7, W6-R17 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/scopes/__tests__/registry.test.ts | 4/4 passed | W6-R16 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/oauth/__tests__/authorize.test.ts | 13/13 passed | W6-R3, W6-R14, W6-R42 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/__tests__/boundary-lint.test.ts | 2/2 passed | W6-R19 |
| cd Ship-wt-audit_w6/api && npx vitest run src/platform/api/v1/__tests__/error-middleware.test.ts src/platform/api/v1/__tests__/errors.test.ts | 20/20 passed | W6-R6 |
| cd Ship-wt-audit_w6 && npx playwright test e2e/oauth-authorize.spec.ts --workers=1 --reporter=list | 2 passed (28.7s) -- fully isolated via testcontainers, safe to run in scratch worktree | W6-R3, W6-R42, W6-R51 |
| grep for device_code/user_code/authorization_pending/slow_down across api/src (excluding tests/config) | zero implementation hits outside migrations/tests -- confirms no device route code on main | W6-R15, W6-R43 |
| grep for router.stack/listRoutes/enumerateRoutes and fitness/route-enum filenames across api/src | no matches -- confirms PF-203 route-enumeration fitness test does not exist | W6-R6 |
| find api/src/platform/api/v1 for a /me route; read router.ts | only /health and /documents mounted -- confirms /api/v1/me does not exist | W6-R3, W6-R42, W6-R43 |
| NOT RUN: pnpm test:e2e / full e2e suite | NOT RUN | W6-R3, W6-R42, W6-R51 |
| NOT RUN: any migrate/seed command against main repo or non-scratch worktrees | NOT RUN | — |
| cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/__tests__/architectureDocSections.test.ts | PASS — 15/15 tests, 1 file, 367ms | W6-R70 |
| find /Users/troy/repos/GAUNTLET/Ship -iname openapi.json -not -path '*/node_modules/*' -not -path '*/.git/*' | one hit: api/openapi.json (the pre-existing internal 3.0.0 spec, not docs/openapi.json) | W6-R74 |
| ls .github/workflows/ && grep -n openapi .gitlab-ci.yml | 3 workflow files (ci.yml, ci-failure-rollback.yml, agent-rollback-check.yml), none openapi-related; zero matches in .gitlab-ci.yml | W6-R74 |
| gh repo view troysatchell/ship --json visibility,isPrivate,url | {"isPrivate":false,"url":"https://github.com/troysatchell/ship","visibility":"PUBLIC"} | W6-R71 |
| gh repo view troysatchell/ship --json deleteBranchOnMerge | {"deleteBranchOnMerge":false} | W6-R71 |
| gh pr list --repo troysatchell/ship --state merged --limit 10 --json number,title,headRefName | 10 recent merged PRs listed, all W6 tickets, distinct branch-per-PR pattern confirmed | W6-R71 |
| gh pr view 183/186/189/182 --repo troysatchell/ship --json body -q .body | All 4 bodies name the closed ticket + AC/PF-number and report gate-pass evidence ('Advances the AC:', 'Gate (observed): pass N/N') | W6-R71 |
| git branch -a \| grep -i -E 'pf-9\|w6\|architecture\|cost\|presearch\|demo\|social' | Confirmed per-slice branches (docs/pf-902-iam-memo, docs/pf-903-architecture-doc, feat/pf-900-terraform-w6, feat/pf-907-grader-access, et... | W6-R71 |
| grep -rn 'TRO-434\|TRO-409\|TRO-437\|TRO-444\|TRO-429\|TRO-403' CHANGES.md (run per-ticket) | Zero hits for TRO-434, TRO-409, TRO-437, TRO-444, TRO-429, TRO-403 — none of these tickets have a CHANGES.md entry, consistent with their... | W6-R65, W6-R72, W6-R73, W6-R74, W6-R75, W6-R76, W6-R78, W6-R79 |
| Read docs/submission/AI-COST-ANALYSIS.md, DEMO-SCRIPT.md, SOCIAL-POST.md, DISCOVERY.md, FLEETGRAPH-DEMO-SCRIPT.md, PRESEARCH.MD in full/in part | All confirmed to be prior-week (W4/W5) submission artifacts reused at plausible-sounding paths, none containing W6/PlugForge-specific con... | W6-R65, W6-R72, W6-R73, W6-R75, W6-R76, W6-R78 |
| git log --oneline -3 -- api/openapi.json && git log --oneline -3 -- docs/submission/PF-100-OAUTH-STUDY-BRIEF.md | api/openapi.json last touched by TRO-551 (unrelated to PF-204); PF-100 brief committed in 226de0c (w6 kickoff commit) | W6-R74, W6-R79 |
| NOT RUN: gh pr view for the remaining ~11 merged W6 PRs | NOT RUN | W6-R71 |
| NOT RUN: pnpm drill ttfe / any TTFE CI drill command | NOT RUN | W6-R75 |
| Read /Users/troy/repos/GAUNTLET/Ship/audit/requirements/inventory-W6.md (full, 724 lines) | extracted exact Quote/Meaning/Type/Acceptance for W6-R61, R63, R64, R67, R69 | W6-R61, W6-R63, W6-R64, W6-R67, W6-R69 |
| Read /Users/troy/repos/GAUNTLET/Ship/PLUGFORGE.MD (full, 347 lines) | confirmed PF-number-to-epic mapping (E6/E8 for R61, E7 PF-700-704 for R67, PF-905 for R63/R64, PF-003 §2.1 for R69) and §1.4.2's explicit... | W6-R61, W6-R63, W6-R64, W6-R67, W6-R69 |
| git log -1 --oneline 06a15f1; git merge-base --is-ancestor 06a15f1 HEAD; git rev-parse HEAD | confirmed working tree HEAD IS 06a15f1 exactly (Merge PR #190) | W6-R61, W6-R63, W6-R64, W6-R67, W6-R69 |
| ls integrations/ ; ls sdk/ | both: 'No such file or directory' | W6-R61, W6-R67, W6-R69 |
| cat pnpm-workspace.yaml; find . -maxdepth 1 -type d | workspace = api/web/shared/agent only; no sdk or integrations directories at repo root | W6-R61, W6-R67, W6-R69 |
| git ls-tree -d --name-only HEAD \| grep -E '^(sdk\|integrations)$' | empty output — confirmed absent in the committed tree, not just gitignored | W6-R61, W6-R67, W6-R69 |
| Read eslint.config.mjs (full, 243 lines) | confirmed the only import-boundary rule is api/src/platform/api/v1/** vs api/src/routes/**; no integrations/** rule | W6-R69 |
| Read api/src/platform/__tests__/boundary-lint.test.ts (top section) | confirmed this test file covers only the routes/** boundary, not integrations/@ship/sdk | W6-R69 |
| grep -rln 'integrations/\|packages/sdk\|sdk' docker-compose.local.yml .github/workflows/*.yml .gitlab-ci.yml; then grep -n same in matched files | found scripts/check-integration-deps.mjs wired into both .gitlab-ci.yml:83/89 and .github/workflows/ci.yml:98/104 | W6-R69 |
| Read scripts/check-integration-deps.mjs (full, 143 lines) | real, non-stub enforcement logic; Day-1-correct (exits 0 on absent/empty integrations/) | W6-R69 |
| Read scripts/__tests__/check-integration-deps.test.mjs (full, 145 lines) | 10 real test cases including an actual violation-detection fixture | W6-R69 |
| cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6 && source .factory-env && node --test scripts/__tests__/check-integration-deps.test.mjs | 10/10 pass, 0 fail (targeted run, not bare pnpm test) | W6-R69 |
| grep -rln '@ship/sdk' agent/; grep -rn 'AGENT_PLATFORM_MODE' --include='*.ts' --include='*.md' . | both empty — no @ship/sdk usage in agent/, no AGENT_PLATFORM_MODE flag anywhere | W6-R67 |
| grep -rn 'ship_app_fleetgraph\|is_first_party\|client_credentials' agent/ api/src/db/migrations/ | only is_first_party column definition in migration 042 (schema support exists); no seed data or agent-side usage | W6-R67 |
| Read agent/src/shipClient.ts (lines 1-40, module docstring) | confirmed still targets internal /api routes via ResilientClient, unchanged from Week 5 | W6-R67 |
| Read docs/architecture.md (full, 330 lines) | confirmed 'Agent as Platform Citizen' (line 220) and file header (line 1-13) both state the E7 rewire is design intent only, not yet buil... | W6-R67, W6-R63, W6-R69 |
| grep -rln 'bedrock\|Bedrock\|BedrockRuntime' api/src --include='*.ts' \| grep -v test; then Read api/src/services/ai-analysis.ts lines 1-20 | found @aws-sdk/client-bedrock-runtime used only in api/src/services/ai-analysis.ts (pre-existing weekly plan/retro AI analysis feature) —... | W6-R63 |
| grep -rn 'anthropic\|Anthropic\|claude-' api/src/platform -i; grep -i 'anthropic\|langchain\|langgraph' api/package.json agent/package.json | zero matches under api/src/platform; agent/package.json has the 3 LLM deps, api/package.json does not | W6-R63 |
| Read docs/submission/AI-COST-ANALYSIS.md (full, 149 lines) | confirmed this doc covers the W5 meta-build cost (factory/ticket-agent spend), not PF-905's Epic-7 rewire spend or production cost projec... | W6-R64 |
| find docs -iname '*cost*'; find . -maxdepth 2 -iname '*cost*' -not -path '*/node_modules/*'; find . -iname '*PF-905*' | only docs/submission/AI-COST-ANALYSIS.md and agent/cost-ledger-snapshot.jsonl exist; no PF-905-specific doc | W6-R64 |
| Read agent/src/costTracking.ts (header); cat agent/cost-ledger-snapshot.jsonl \| head -5 | confirmed pre-existing Week-5 FG-21 cost ledger infra exists as a pre-rewire baseline only | W6-R64 |
| grep -n '^## TRO-4[1-5][0-9]' CHANGES.md \| grep -E 'TRO-(423\|428\|434\|435\|440\|445\|447\|448\|449\|450\|451\|452\|453\|454\|455\|417\|393\|394\|414)' | zero matches — confirms none of these tickets have landed any CHANGES.md entry | W6-R61, W6-R64, W6-R67 |
| tail -80 memory-bank/activeContext.md | confirms current factory wave is entirely E0-E2 (MVP path); no mention of E7/E8 work in flight | W6-R61, W6-R67 |
| cat /Users/troy/repos/GAUNTLET/Ship/audit/requirements/interpretations.md | only I-01/I-02/I-03 exist, all governing W4/W5 IDs — none apply to W6-R61/63/64/67/69 | W6-R61, W6-R63, W6-R64, W6-R67, W6-R69 |
| grep -rn 'drill' --include='*.ts' --include='*.md' --include='*.json' . (excluding .claude/audit/PLUGFORGE) | only comment mentions in CHANGES.md, memory-bank, rate-limit.ts, platform/config.ts, platform/README.md — no actual pnpm drill ttfe scrip... | W6-R61 |
| grep -n "'drill'" package.json (root scripts) | no 'drill' entry in root package.json scripts block | W6-R61 |
| Full agent Playwright/CLI drill run, terraform apply/destroy, live deployed-URL probe for any of these requirements | NOT RUN | W6-R61, W6-R67 |
| Read /Users/troy/repos/GAUNTLET/Ship/audit/requirements/inventory-W6.md (full file) | Extracted W6-R1, W6-R10, W6-R11, W6-R12, W6-R38, W6-R39, W6-R40, W6-R41, W6-R77 quote/meaning/type/acceptance-evidence text. | W6-R1, W6-R10, W6-R11, W6-R12, W6-R38, W6-R39, W6-R40, W6-R41, W6-R77 |
| Read /Users/troy/repos/GAUNTLET/Ship/audit/requirements/interpretations.md (full file) | I-01 governs W4-R26 only; I-02 governs W5-R29/47/48/49; I-03 governs W5-R36. None apply to my W6 cluster. | — |
| grep -n "PF-9" PLUGFORGE.MD \| head -80 | Located PF-900..908 ticket descriptions and the MVP cut-line / graded-scenario tables. | W6-R11, W6-R12, W6-R38, W6-R39, W6-R40, W6-R41, W6-R77 |
| grep -n -i 'regression\|baseline\|P95 latency\|bundle size' PLUGFORGE.MD \| head -40 | Confirmed the +10% baseline compare is a cross-cutting MVP-gate line item, not owned by a dedicated PF ticket. | W6-R10 |
| git log -1 --format='%H %ci' && find terraform -maxdepth 3 -type f | Confirmed pinned commit 06a15f1 (2026-08-13 14:11 -0500) and enumerated the full terraform/ tree. | W6-R12, W6-R38, W6-R40 |
| Read docs/IAM-ADAPTATION-RENDER.md (full, 197 lines) | Confirmed the PF-902 memo's content: AWS task-role/least-privilege exercise mapped to Render's API-key/service-isolation model, what Rend... | W6-R38, W6-R39 |
| Read terraform/render/plan/tro-316-destroy-redeploy-proof.md (full, 148 lines) | Real destroy->create cycle executed against render_web_service.agent only (W5/TRO-316), predates W6 platform env vars. | W6-R12, W6-R40 |
| Read terraform/render/plan/tro-411-pf900-w6-env-vars.md (full, 502 lines) | Live credentialed terraform plan capture for the W6 env-var additions, clean (Plan: 3 to add, 0 to change, 0 to destroy), redaction-check... | W6-R12, W6-R38 |
| Read terraform/render/README.md (full, 219 lines) | Confirmed the import-vs-clean-apply adoption gap is unresolved (still HOLD FOR HUMAN), verified-live-facts table, and the ipAllowList net... | W6-R12, W6-R38 |
| grep -n -i 'dashboard.*drift\|drift.*dashboard\|manual-drift\|manual drift' terraform/ docs/ memory-bank/ | No matches — no manual dashboard-edit drift demo exists for the Render deployment anywhere in the repo. | W6-R40 |
| grep -n 'TRO-415\|PF-901' audit/factory/scorecard.jsonl audit/factory/review-findings.jsonl | No matches in either file — TRO-415/PF-901 has never been dispatched to the factory (consistent with its Backlog status). | W6-R12, W6-R40 |
| grep -n -B5 -A15 'TRO-415' memory-bank/progress.md; grep -n -i 'TRO-411\|TRO-420\|TRO-441\|TRO-415' memory-bank/activeContext.md memory-bank/progress.md | Found the explicit 'human go-ahead required before terraform destroy' flag (progress.md:163-164) and the W6 wave status lines confirming ... | W6-R12, W6-R40 |
| grep -n -i 'grader\|alice.chen\|GRADER_OAUTH' README.md; Read README.md lines 300-375 | Confirmed the Grader Access section content, one-command setup, and the README's own disclosed caveat that portal-reachable and openapi.j... | W6-R11, W6-R77 |
| Read api/src/platform/oauth/seedGraderApp.ts (full, 113 lines); grep -n seedGraderApp api/src/db/seed.ts | Confirmed a real, idempotent, read-only-scoped grader OAuth app seed implementation wired into db:seed at seed.ts:100. | W6-R11, W6-R77 |
| grep -rn 'openapi.json' api/src --include='*.ts' \| grep -v test; Read api/src/platform/openapi/README.md; Read api/src/platform/api/v1/router.ts (full) | Confirmed no /api/v1/openapi.json route exists anywhere; v1Router only registers /health and /documents; platform/openapi/ module is empt... | W6-R11, W6-R77 |
| find web/src -iname '*portal*' -o -iname '*developer*'; grep -rln 'oauth.apps\|OAuthApps\|oauth-apps' web/src --include='*.tsx' | No matches — no developer-portal UI exists in web/src at this commit, consistent with E5 (TRO-436/439/443) all being Backlog. | W6-R77 |
| ls audit/api-perf audit/bundle audit/db-query; head -5 audit/{api-perf,bundle,db-query}/baseline.md | All three baselines dated 2026-07-27; only pre-W6-dated compare subdirectories exist (compare-phase2-jul30, documents-pagination-jul31) —... | W6-R10 |
| grep -n -i "e2e.*green\|e2e.*pass\|playwright.*suite\|regression suite" memory-bank/activeContext.md; grep -n -i '852-test\|api suite green\|test suite' memory-bank/progress.md | No mention of a full Playwright e2e regression run since W6 platform work began; only unit-test-suite status ('852-test api suite green')... | W6-R10 |
| which terraform; terraform version | terraform: command not found — confirmed no terraform binary available in this sandbox, so I could not re-run terraform validate/plan mys... | W6-R12, W6-R38, W6-R40 |
| grep -n -o -i 'terraform[^<]*' docs/submission/PLUGFORGE-DEFENSE-DECK.html \| head -20; grep -n -B3 -A25 'Terraform is the truth' docs/submission/PLUGFORGE-DEFENSE-DECK.html | Found Slide 5 'Infrastructure & blast radius' — real prep content walking the render/ topology and a worked blast-radius example, used as... | W6-R41 |
| Live deploy/browser probe of a public URL, /api/v1/openapi.json, or the dev portal (W6-R11, W6-R77) | NOT RUN | W6-R11, W6-R77 |
| terraform destroy / terraform apply against any real Render or AWS environment (W6-R12, W6-R40) | NOT RUN | W6-R12, W6-R40 |
| Full Playwright e2e regression suite and compare-mode api-perf-audit/bundle-audit/db-query-audit skills (W6-R10) | NOT RUN | W6-R10 |

### Captured output — this sweep's newly-VERIFIED rows (2026-08-14)

**W6-R6, W6-R21, W6-R44** — `cd api && DATABASE_URL=...ship_audit_w6mvp_scratch npx vitest run src/platform/api/v1/__tests__/route-fitness.test.ts`
> ✓ src/platform/api/v1/__tests__/route-fitness.test.ts (33 tests) 144ms — Test Files 1 passed (1), Tests 33 passed (33)

**W6-R8** — `cd api && ... npx vitest run src/platform/openapi/__tests__/document.test.ts src/platform/openapi/__tests__/endpoint.test.ts`
> document.test.ts (5 tests) 189ms + endpoint.test.ts (4 tests) 128ms — Test Files 2 passed (2), Tests 9 passed (9)

**W6-R9** — `cd sdk && DATABASE_URL=...ship_audit_w6mvp_scratch npx vitest run src/__tests__/client.liveServer.test.ts`
> ✓ src/__tests__/client.liveServer.test.ts (3 tests) 60ms — real TCP round trip against a real http.Server wrapping createApp(); Test Files 1 passed (1), Tests 3 passed (3)

**W6-R15** — `cd api && ... npx vitest run src/platform/oauth/__tests__/device.test.ts`
> ✓ src/platform/oauth/__tests__/device.test.ts (9 tests) 173ms — includes the compounding-slow_down poll-to-approval case; Test Files 1 passed (1), Tests 9 passed (9)

**W6-R18** — `cd api && ... npx vitest run src/platform/oauth/__tests__/token.test.ts`
> ✓ src/platform/oauth/__tests__/token.test.ts (32 tests) 353ms — incl. "negative: reuse of a rotated refresh token -> revokes the whole family" and "genuine concurrent rotation of the same refresh token"; Test Files 1 passed (1), Tests 32 passed (32)

**W6-R34** — `cd sdk && npx vitest run src/errors.test.ts`
> ✓ src/errors.test.ts (16 tests) 3ms — Test Files 1 passed (1), Tests 16 passed (16)

**W6-R66** — `cd sdk && npx tsc --noEmit -p tsconfig.json`
> exit 0, no output (clean typecheck under sdk/tsconfig.json's inherited strict:true)

### Captured output — VERIFIED rows

**W6-R2** — `cd api && npx vitest run src/platform/oauth/__tests__/app-registration.test.ts`
> 10/10 passed (AC-1 through AC-5, incl. 'raw secret absent from logs/later responses' and 'rotation invalidates immediately')

**W6-R4** — `cd api && npx vitest run src/platform/oauth/__tests__/bearerAuth.test.ts`
> 11/11 passed, including the three distinct 401 cases (missing_token/invalid_token/expired_token)

**W6-R5** — `cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/platform/api/v1/resources/__tests__/documents.test.ts`
> ✓ src/platform/api/v1/resources/__tests__/documents.test.ts (8 tests) 458ms — Test Files 1 passed (1), Tests 8 passed (8)

**W6-R7** — `cd api && npx vitest run src/platform/oauth/__tests__/bearerAuth.test.ts`
> 11/11 passed, including AC-3's named-missing-scope 403 case

**W6-R13** — `cd api && npx vitest run src/platform/oauth/__tests__/app-registration.test.ts`
> 10/10 passed, including 'AC-4: rotation invalidates the old secret immediately, no grace period' and 'AC-3: raw secret is absent from any later response'

**W6-R14** — `cd api && npx vitest run src/platform/oauth/__tests__/token.test.ts && npx vitest run src/platform/oauth/__tests__/authorize.test.ts`
> token.test.ts: 18/18 passed (incl. 'negative: wrong code_verifier -> 400 invalid_grant'); authorize.test.ts: 13/13 passed

**W6-R16** — `cd api && npx vitest run src/platform/scopes/__tests__/registry.test.ts`
> 4/4 passed, including 'registers exactly the seven §2.3 scopes at module load'

**W6-R17** — `cd api && npx vitest run src/platform/oauth/__tests__/bearerAuth.test.ts`
> 11/11 passed, including AC-1's two req.principal-population cases

**W6-R19** — `cd api && npx vitest run src/platform/__tests__/boundary-lint.test.ts`
> 2/2 passed, proving the rule catches a real cross-boundary import and does not false-positive on a sibling import

**W6-R20** — `cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/platform/api/v1/resources/__tests__/documents.test.ts`
> ✓ AC-1: cursor-paginated list — stable across a mid-iteration insertion > no duplicate/skipped ids across pages after an insert between the page boundary; next_cursor round-trips opaquely — 8/8 tests passed

**W6-R22** — `cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/platform/webhooks/__tests__/events.test.ts`
> ✓ src/platform/webhooks/__tests__/events.test.ts (22 tests) 377ms — Test Files 1 passed (1), Tests 22 passed (22)

**W6-R25** — `cd api && npx vitest run src/platform/webhooks/__tests__/signer.test.ts`
> 20 tests | 20 passed (positive, tampered body, expired timestamp, missing v1, boundary 300s/301s, trailing-garbage hex, fail-open guards, constant-time-compare proof, shared fixture cross-check)

**W6-R70** — `cd /Users/troy/repos/GAUNTLET/Ship-wt-audit_w6/api && npx vitest run src/__tests__/architectureDocSections.test.ts`
> src/__tests__/architectureDocSections.test.ts (15 tests) 367ms — Test Files 1 passed (1), Tests 15 passed (15)

**W6-R71** — `gh repo view troysatchell/ship --json deleteBranchOnMerge; gh pr view 183/186/189/182 --repo troysatchell/ship --json body -q .body`
> deleteBranchOnMerge: false (per-slice branches not auto-deleted on merge); 4 sampled merged W6 PR bodies (#183/#186/#189/#182) each name the closed ticket + PF-number/AC and report 'Gate (observed): pass N/N' or equivalent (sample of 4 of ~15+ W6 PRs, not exhaustive)


## Independent verification: citations fixed and verdicts changed

> **2026-08-14 compare-sweep addendum:** this section documents the baseline sweep's own citation
> fixes (2026-08-13). This sweep's own citation fixes: `pnpm-workspace.yaml` was cited at line 1 or
> line 4 in several draft rows describing the `sdk` package entry — the file's `packages:` header is
> line 1, and `sdk` is the 6th line, the 5th list item (after `api`, `web`, `shared`, `agent`).
> Corrected to line 6 everywhere it occurred (W6-R9, R43, and four Cluster-G rows) before this report
> was finalized. Spot-checked ~20 other citations across every cluster by opening the file at the
> cited line; no other errors found.

Per the requirements-audit skill's hard rule ("a true claim with a false citation is still a false
citation"), every one of this sweep's 255 evidence citations across all 79 requirements was opened
directly (file existence, line-in-range, content plausibly supports the note) before this report was
written. Fixes made:

**File:line corrections (6):**
- **W6-R66** — `tsconfig.json` line 10 → **13** (line 10 was `"declarationMap": true,`; `"strict": true,`
  is actually at line 13).
- **W6-R8** — `api/src/platform/api/v1/router.ts` line 44 → **43** (line 44 was a blank line; the
  `/documents` route registration the note describes is at line 43).
- **W6-R11** — `terraform/render/plan/tro-411-pf900-w6-env-vars.md` line 166 → **299** (line 166 was
  generic plan-header boilerplate; the actual `"GRADER_OAUTH_CLIENT_SECRET"` plan-output block is at
  line 299).
- **W6-R19** — `eslint.config.mjs` line 159 → **164** (line 159 was an opening brace; the
  `files: ['api/src/platform/api/v1/**/*.ts']` line the note describes is at line 164).
- **W6-R27** — `docs/architecture.md` line 259 → **267** (line 259 was mid-paragraph in the "Mid-flight
  secret rotation" section; the "Deliverer crash" section the note describes starts at line 267).
- **W6-R61** — `package.json` line 8 → **11** (line 8 is inside the `engines` block, `"pnpm":
  ">=9.0.0"`; the `"scripts": {` block the note describes — checked for a missing `drill` entry —
  opens at line 11).

**Note-text corrections (3, content inaccuracy — citation itself was valid):**
- **W6-R28** — note said "migration 045" was earmarked for `webhook_subscriptions`; the cited file
  itself says migration **044** was earmarked for it (044 is also the file's own migration number).
  Corrected the note.
- **W6-R50** — note claimed CI stages are "verify/inventory/image-build"; `.gitlab-ci.yml`'s real
  `stages:` block is `verify, e2e, image`. Corrected. The underlying MISSING verdict is unaffected
  (grep for drill/ttfe in the file independently confirmed zero matches either way).
- **W6-R57** — same stage-name error, same fix, same unaffected verdict.

**Verdict changes (2):**
- **W6-R25**: PARTIAL → **VERIFIED**, per interpretation I-04 (see Blocked/assumed above).
- **W6-R39**: VERIFIED → **IMPLEMENTED-UNVERIFIED** (downgrade). This requirement's evidence is
  exclusively a prose/document review of `docs/IAM-ADAPTATION-RENDER.md`; the tracing cluster's own
  note already said "this is a document-verification, not a test-run verification." The tier
  vocabulary's VERIFIED bar requires a verify command that ran with captured output — a careful
  reading of a real, substantively-responsive memo does not meet that bar, however well the memo
  itself succeeds at PF-902's actual acceptance criterion.

**Schema-compliance fix (not a factual error):**
- **W6-R69** carried a non-null `verification` field on a PARTIAL row, which `report-format.md`
  reserves for VERIFIED rows only. Nulled it; the underlying green-test fact (`node --test
  scripts/__tests__/check-integration-deps.test.mjs`, 10/10 pass) is preserved verbatim in the row's
  `notes`, so no information was lost.

**Missing `verification` field populated on already-genuinely-VERIFIED rows (9):** W6-R2, R4, R7,
R13, R14, R16, R17, R19, R71 — each had passing behavioral evidence already recorded in the row's own
`notes` and independently corroborated in the merged `commands_run` array (the underlying vitest/gh
commands really did run and pass), but the structured `verification` field was left null. Populated
from the existing record; no new commands were run to produce these.

**Ticket-mapping fix (1):** W6-R29 (webhook replay, PF-306) had an empty `tickets` array despite its
own ticket, **TRO-446** ("PF-306: Replay from the delivery log"), existing in the Linear project and
matching this requirement's subject exactly. Added — this also removes TRO-446 from the orphan list.

**suggested_scope filled in (5):** W6-R3, R6, R42, R63, R69 had `verdict` in `{MISSING, PARTIAL}`
but `suggested_scope: null`, violating `report-format.md`'s explicit requirement. Filled with a real
1–2 sentence assessment for each (see the Gaps section above for the text).
