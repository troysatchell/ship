# Requirements gaps — Ship (2026-08-14T09:51:08Z, commit 24183537bb03388f58ef3831d1981aee13da1b27)

**Compare sweep** `w6-mvp-wave` vs. baseline `matrix.baseline-W6.json` (commit 06a15f1, 2026-08-13T19:53:43Z). This file supersedes the baseline `gaps-W6.md` snapshot — 9 rows closed (moved to VERIFIED) since baseline and are no longer listed below; 2 rows newly PARTIAL (W6-R10, and W6-R43/R45 moved MISSING→PARTIAL) are added. See `audit/requirements/REPORT-W6.md`'s Delta section for the complete list of what changed and why.

## Unticketed requirements

Note: despite the section title (per report-format.md's template), every row below DOES
carry ticket(s) — W6 has full ticket coverage; "unticketed" here means "gap": every
MISSING or PARTIAL requirement, regardless of its own ticket status. (W6-R11 and W6-R39, this
sweep's two IMPLEMENTED-UNVERIFIED rows, are intentionally excluded — their code/doc trace is
complete and nothing is missing to scope; they only lack a captured verify-command run /
live-deployment probe, which is not a PM-scoping action. See REPORT-W6.md's Matrix for those rows.)

### W6-R3 — PARTIAL
- **Quote:** "Authorization Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token."
- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Meaning in code:** `/oauth/authorize` + consent UI + `/oauth/token` implementing RFC 6749 + 7636, proven by a Playwright e2e. (MVP hard gate.)
- **Tickets:** TRO-412, TRO-416, TRO-503, TRO-550, TRO-549
- **What is missing:** PARTIAL, but the substance of the gap changed: at baseline, TWO things blocked the literal scenario — no e2e called /oauth/token, AND /api/v1/me didn't exist to call afterward. As of this sweep, /api/v1/me exists (confirmed live in router.ts) and the token exchange is far more thoroughly tested (32 vs 18 cases, now covering PF-105's rotation/reuse-detection too) — but e2e/ has literally zero changes since baseline (confirmed via git diff --stat), so no Playwright spec was ever written to chain the three legs together. The requirement's literal ask — 'completes end-to-end via A Playwright test' — is still not met by any single test file, even though every piece it would need to call now exists and works. This is a real, surprising finding for this sweep: six MVP-gate tickets landed and the literal PKCE e2e scenario STILL isn't assembled, purely because no one wrote the connecting test.
- **Suggested scope:** Unchanged in kind from baseline, narrower in scope now: every piece the literal graded scenario needs now exists in the running system (authorize+consent proven by e2e, token exchange proven by 32/32 vitest, /api/v1/me now a real route) — the only remaining gap is that nobody has written the ONE Playwright spec chaining authorize -> consent -> /oauth/token -> GET /api/v1/me with the returned bearer token. This is now a pure test-authoring task with zero remaining backend blockers, unlike baseline where /api/v1/me didn't exist yet.

### W6-R10 — PARTIAL
- **Quote:** "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."
- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Meaning in code:** No regression: e2e suite green, and the three Part-1 baseline metrics (in `audit/`) stay within +10%. (MVP hard gate.)
- **Tickets:** TRO-593, TRO-594, TRO-595, TRO-596
- **What is missing:** Moved MISSING -> PARTIAL, not VERIFIED, per this project's own claim-provenance discipline (do not round a nuanced result to a flat pass). I independently opened and read all three compare-mode reports plus the memory-bank bisection narrative rather than trusting the delegating brief's summary: the three numeric budgets (P95 latency, bundle size, per-route query counts, all vs the 2026-07-27 Part-1 baseline) are genuinely met with real, well-caveated compare-mode runs (api-perf/db-query/bundle all report PASS, each disclosing its own confounds — Postgres 15->16 version skew, gzip compression landing independently, concurrent host load during one measurement window and a quiet-load recheck disproving the resulting artifact). The fourth clause, 'existing Playwright regression suite passes on main', is literally false today: 32 tests fail. A rigorous three-pass bisection (not merely asserted) traces every one of those 32 to pre-existing causes wholly outside the 06 commits this run swept, with zero code overlap against a verified pre-wave commit — so none of them are a regression FROM W6 work — but the suite does not pass in the unqualified sense the requirement's words state. PARTIAL is the honest tier: the requirement's harder, more specific numeric budgets are met and proven; its broader qualitative clause is not, for reasons proven unrelated to the six tickets this sweep is about. None of the four commands (api-perf/db-query/bundle compares, the e2e bisection) were run by me in this sweep — I verified their artifacts directly (opened and read the three compare .md reports and the memory-bank narrative in full) rather than re-running them, since the task briefed them as already completed by a separate, parallel verification effort and re-running a Docker-testcontainer-heavy e2e suite plus two audit categories was out of this sweep's own scope.
- **Suggested scope:** The three quantitative budgets (P95 latency, bundle size, per-route query count) are done and need no further work. What remains to make the literal quote ('existing Playwright regression suite passes on main') true is fixing or quarantining the 4 pre-existing failure clusters now ticketed as TRO-593 (High, session-timeout.spec.ts browser-context crashes), TRO-594/TRO-596 (Low), TRO-595 (Medium) — none caused by W6 work, but the suite does not pass in an unqualified sense today.

### W6-R12 — PARTIAL
- **Quote:** "Terraform deployment: a terraform/ directory with a complete config describing the deployment topology (app container, database, networking, IAM task role and execution role). Provider versions must be pinned. Run terraform plan and include the annotated output as a submission artifact. Perform a destroy-and-redeploy: tear down the environment and re-apply from the Terraform config alone to prove IaC completeness."
- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Meaning in code:** Complete IaC for the deployment (repo deploys to Render — the IAM-role language is AWS-shaped and needs adaptation), pinned providers, committed annotated plan, destroy-redeploy evidence. (MVP hard gate.)
- **Tickets:** TRO-411, TRO-415, TRO-488, TRO-420
- **What is missing:** No code changed in scope since baseline: git diff --stat 06a15f1..2418353 -- terraform/ returns empty (zero diff). None of the six landed tickets (TRO-400/402/404/405/421/425) touch terraform/ or docs/IAM-ADAPTATION-RENDER.md. Verdict carried forward unchanged: config completeness, exact provider pin, and a committed annotated plan are real; destroy-redeploy evidence for the deployment as it stands today (including this week's platform additions) is still absent. TRO-415/PF-901 remains Backlog, re-confirmed via a fresh Linear pull this sweep.
- **Suggested scope:** Unchanged from baseline: TRO-415/PF-901 needs to actually run a destroy-redeploy cycle against the full current topology (ship + postgres + this week's 8 new PF-900 env vars), scoped wider than the existing agent-only proof. Blocked on the human go-ahead memory-bank/progress.md:163 already flags — none of tonight's 6 tickets touch this.

### W6-R23 — MISSING
- **Quote:** "IEventBus interface. Domain layer publishes on writes — never the route layer. In-process implementation must-ship; queue-backed implementation is a Liskov-substitutable drop-in."
- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Meaning in code:** IEventBus interface with in-process impl; publish() calls live only in the domain write path (implies consolidating Ship's currently route-scattered document writes).
- **Tickets:** TRO-426
- **What is missing:** No code changed in scope: api/src/platform/webhooks/ and documentService.ts have empty git diff --stat 06a15f1..2418353. router.ts gained new resource mounts (TRO-400/402) but none touch event publication. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-301 (TRO-426, Backlog) ships. Smallest step: add IEventBus + in-process impl under api/src/platform/webhooks/, then redirect route-layer document writes through documentService.ts's write path with publish() calls added there.

### W6-R24 — MISSING
- **Quote:** "Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."
- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Meaning in code:** Subscriptions table + CRUD API under webhooks:manage. NOTE: "hashed signing secret" is unimplementable as a one-way hash (the server must possess the secret to sign) — PLUGFORGE.MD §2.2 deviates deliberately to encrypted-at-rest; this needs to be defended in the architecture doc.
- **Tickets:** TRO-431
- **What is missing:** Router.ts's mount list changed (4 resource routers now vs 1 at baseline) but this is TRO-400/402 work (issues/sprints/me/openapi), not webhooks. Verdict unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-302 (TRO-431, Backlog) ships. Smallest step: a migration creating webhook_subscriptions plus an /api/v1/webhooks CRUD route mounted in router.ts, gated with the already-registered requireScope('webhooks:manage') factory.

### W6-R26 — MISSING
- **Quote:** "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m. Subscribers returning 5xx or timing out are retried; 4xx responses are treated as permanent failures and dead-lettered."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Retry scheduler with exactly that schedule + jitter; 5xx/timeout retried, 4xx dead-lettered immediately.
- **Tickets:** TRO-438
- **What is missing:** No code changed in scope: both cited files empty diff. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (TRO-438, Backlog) ships — full feature build.

### W6-R27 — MISSING
- **Quote:** "After 6 failed attempts, deliveries land in a DLQ visible in the developer portal. Operators can replay manually; replays carry the original idempotency key."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** DLQ at attempt 6, surfaced in portal UI, manual replay preserving Idempotency-Key.
- **Tickets:** TRO-438, TRO-439
- **What is missing:** No code changed in scope. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (TRO-438) and PF-503 (TRO-439) both ship — both still Backlog.

### W6-R28 — MISSING
- **Quote:** "webhook_deliveries table records every attempt with subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms. Queryable per app."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Delivery-log table with those columns; per-app query path (API + portal).
- **Tickets:** TRO-438, TRO-442
- **What is missing:** Highest migration is now 046_oauth_device_codes_polling.sql, both new migrations OAuth-scoped. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (migration for webhook_deliveries, TRO-438) and PF-305 (delivery-log query API, TRO-442) ship.

### W6-R29 — MISSING
- **Quote:** "/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Replay endpoint re-emitting a logged delivery with its original Idempotency-Key.
- **Tickets:** TRO-446
- **What is missing:** No code changed in scope. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: no ticket currently covers this scope; smallest fix is (1) file a PF-306 ticket, (2) once PF-304/PF-305's delivery log exists, implement POST /api/v1/webhooks/deliveries/:id/replay.

### W6-R30 — MISSING
- **Quote:** "@ship/sdk exposes resource clients: client.documents, client.issues, client.sprints, client.webhooks. Method signatures match OpenAPI spec; drift fails CI via a fitness test."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Resource-segregated SDK surface + spec↔SDK parity fitness test wired into CI.
- **Tickets:** TRO-407, TRO-422, TRO-390
- **What is missing:** PARTIAL PROGRESS NOTED, VERDICT UNCHANGED: sdk/ now exists (PF-400/TRO-405 landed), closing baseline's total-absence finding, but the requirement's own text (client.documents/issues/sprints/webhooks + a drift-fails-CI parity test) needs PF-401/TRO-422, both still Backlog. Confirmed via sdk/src/index.ts's own barrel — only ShipClient, errors, and types are exported.
- **Suggested scope:** Ships when PF-401 (TRO-407, Backlog) lands: client.documents/issues/sprints/webhooks resource clients plus a spec<->SDK parity fitness test wired into CI. The scaffold (PF-400/TRO-405) landed this range and gives PF-401 a real package to extend, shortening the remaining dependency chain, but resource clients themselves do not exist.

### W6-R31 — MISSING
- **Quote:** "ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser localStorage)."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** SDK auth helpers for both grants + ITokenStore with the three store implementations.
- **Tickets:** TRO-418, TRO-449, TRO-390
- **What is missing:** PARTIAL PROGRESS NOTED, VERDICT UNCHANGED: the constructor's option shape already reserves room for tokenStore (deliberate, per PF-400's own docstring, so PF-404 is additive not breaking) and the device-grant backend it would call now exists and works (W6-R15, verified this sweep) — but no SDK-side auth-flow helper or token-store implementation exists yet. TRO-418/PF-404 remains Backlog.
- **Suggested scope:** Ships when PF-404 (TRO-418, Backlog) lands: authorizationCodeFlow()/deviceLogin() helpers plus the three ITokenStore implementations (in-memory, file, browser localStorage). The device-grant backend itself (PF-106/TRO-425) landed this range, so PF-404's SDK-side wiring now has a real, tested backend to call.

### W6-R32 — MISSING
- **Quote:** "for await (const doc of client.documents.iterate()) walks pages transparently. Cursors handled internally; consumer code never sees them."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Async-iterator pagination on SDK list clients; cursors fully internal.
- **Tickets:** TRO-410, TRO-449, TRO-390
- **What is missing:** No code changed in scope since baseline. TRO-410/PF-402 remains Backlog; blocked on PF-401 (W6-R30) landing first.
- **Suggested scope:** Ships when PF-402 (TRO-410, Backlog) lands, and depends on PF-401's resource clients existing first (a documents.iterate() needs a documents resource client to attach to).

### W6-R33 — MISSING
- **Quote:** "verifyWebhook(headers, rawBody, secret) returns true/false in one call. Tampered bodies fail; expired timestamps fail; missing v1 header fails."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** One-call SDK verifier with the three failure modes.
- **Tickets:** TRO-413, TRO-433, TRO-390
- **What is missing:** No code changed in scope. Per I-04 (applied silently, not re-asked): W6-R25 is satisfied by the server-side signer suite alone and does not double-count this SDK-side gap — W6-R33 is where the SDK-side verifyWebhook absence is tracked, and it remains MISSING. TRO-413/PF-403 still Backlog.
- **Suggested scope:** Ships when PF-403 (TRO-413, Backlog) lands: a one-call verifyWebhook(headers, rawBody, secret) in sdk/src/, mirroring the server-side signer's verify() logic (tamper/expired/missing-v1 negative cases already proven server-side by signer.test.ts's 20/20 — the SDK port has a correct reference implementation to match against).

### W6-R35 — MISSING
- **Quote:** "Per-app and per-token token-bucket limits. Public responses carry X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset; 429 responses carry Retry-After."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Two-level token buckets; headers on all v1 responses; 429 + Retry-After. (Requires exempting /api/v1 from the legacy `/api/`-prefix limiters — post-TRO-172 these are 600/min/identity + 6,000/min/IP in prod, `api/src/middleware/rate-limit.ts:130-132`; API-1's original 100/min/IP cap no longer exists.)
- **Tickets:** TRO-427, TRO-401, TRO-494, TRO-552, TRO-391
- **What is missing:** No code changed in scope since baseline; confirmed via git diff --stat 06a15f1..2418353 against every cited file. None of the six landed tickets touch rate-limiting.
- **Suggested scope:** Unchanged from baseline: build TRO-427 (PF-500) — per-app/per-token token-bucket limiters in api/src/platform/ratelimit/ (still an empty stub), wired onto /api/v1, emitting X-RateLimit-Limit/Remaining/Reset plus Retry-After on 429s.

### W6-R36 — MISSING
- **Quote:** "Every public API call recorded with timestamp, app client_id, user_id, route, scope used, status, latency. Queryable in the developer portal."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** public_api_audit table + recording middleware + portal query surface.
- **Tickets:** TRO-432, TRO-391
- **What is missing:** No functional code changed in scope. One documentation-staleness detail found (migration slot 046 now taken by unrelated PF-106 work) — flagged, does not affect verdict.
- **Suggested scope:** Unchanged from baseline: build TRO-432 (PF-501) — migration creating public_api_audit (will land at 047+ since 046 is now taken), recording middleware, and a query surface for the portal.

### W6-R37 — MISSING
- **Quote:** "In-app UI for: listing apps, registering apps, viewing/rotating client_secret (shown once), managing subscriptions, browsing the delivery log, replaying failed deliveries."
- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Meaning in code:** Developer portal in the existing Ship web app covering those six functions.
- **Tickets:** TRO-436, TRO-439, TRO-443, TRO-391
- **What is missing:** No code changed in scope. web/src/main.tsx diff confirmed the only new route added is /oauth-device-verify (PF-106), not portal-related.
- **Suggested scope:** Unchanged from baseline: build TRO-436 (PF-502) and TRO-439 (PF-503) as new web/src pages/components, still dependent on the still-missing W6-R35/R36 backend groundwork and webhook domain work.

### W6-R38 — PARTIAL
- **Quote:** "terraform/ directory describing app container, database, VPC/subnets, and security groups. All provider and module versions pinned. terraform plan must run cleanly; no unpinned versions permitted."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** IaC topology (Render adaptation: no VPC/subnet/SG primitives — the adaptation must be defended per PLUGFORGE PF-902); pinned providers; clean plan.
- **Tickets:** TRO-411, TRO-488, TRO-420
- **What is missing:** No code changed in scope: terraform/ and docs/IAM-ADAPTATION-RENDER.md both absent from the 06a15f1..2418353 diff. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: add a short paragraph to docs/IAM-ADAPTATION-RENDER.md or docs/architecture.md explicitly naming that Render has no VPC/subnet/security-group resource type and defending what this repo's config does instead.

### W6-R40 — PARTIAL
- **Quote:** "Demonstrate drift: manually change a resource, run terraform plan, show the detected diff. Perform terraform destroy then terraform apply from scratch. Submit screenshots or log output proving the service came back up identically."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Drift-detection demo + destroy-redeploy with committed evidence.
- **Tickets:** TRO-415
- **What is missing:** No code changed in scope since baseline: terraform/ has zero diff in this range. Verdict carried forward unchanged; TRO-415/PF-901 still Backlog.
- **Suggested scope:** Same remediation as W6-R12: TRO-415/PF-901 needs to actually run, producing (1) a live dashboard-edit-then-plan-diff drift demo, and (2) a destroy/apply cycle against the full current topology. Blocked on human go-ahead.

### W6-R42 — PARTIAL
- **Quote:** "Complete the Authorization Code + PKCE flow in a Playwright test from a registered web app. Confirm that a wrong code_verifier on the token exchange returns invalid_grant (negative case is mandatory, not optional)."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — PKCE e2e + mandatory negative.
- **Tickets:** TRO-412, TRO-416, TRO-503, TRO-550, TRO-549
- **What is missing:** Duplicate graded-scenario framing of W6-R3 — same underlying gap, same verdict, same reasoning: every piece exists and is independently proven, but no single e2e chains them. Carried forward as PARTIAL with the same evidence refresh as W6-R3.
- **Suggested scope:** Same as W6-R3: write the single Playwright spec chaining authorize -> consent -> /oauth/token (incl. the mandatory wrong-verifier negative case) -> a call against the now-real /api/v1/me. No backend blocker remains.

### W6-R43 — PARTIAL
- **Quote:** "Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — device flow via CLI to /api/v1/me.
- **Tickets:** TRO-425, TRO-448
- **What is missing:** Moved MISSING -> PARTIAL. Baseline found no device-grant code at all. The underlying grant mechanics (including the specific 'slow-down responses honored' clause) are now rigorously proven by device.test.ts, and the token is proven usable via the real bearerAuth middleware — but the requirement's literal framing ('from a test CLI', 'against /api/v1/me' specifically) isn't met: no CLI exists (confirmed via Cluster G's cross-check: no integrations/ directory, no CLI workspace package), and the introspection test calls a scratch app rather than the literal /api/v1/me route (which does now exist, per W6-R9, but isn't exercised by this specific test). This is a smaller, more honest gap than baseline's blanket MISSING.
- **Suggested scope:** The mechanics (poll-to-approval, slow_down honored, resulting token usable) are now fully proven — what remains is packaging: a CLI (PF-600/TRO-448, Backlog) that literally drives this flow, and swapping the test's scratch-app introspection for a literal call to the now-real GET /api/v1/me.

### W6-R45 — PARTIAL
- **Quote:** "Validate the generated /api/v1/openapi.json against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert the SDK exposes a typed call for it."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — spec validity + spec→SDK parity walk.
- **Tickets:** TRO-402, TRO-422
- **What is missing:** Moved MISSING -> PARTIAL. Baseline found neither half implemented. The spec-validity half now has a real, rigorous test (official schema + negative control), landed this range — but the 'walk every spec method and assert the SDK exposes a typed call for it' half cannot exist yet: the SDK has only one method (me()) against a 7-operation spec, and no such walk exists anywhere in the repo. Honest PARTIAL rather than carrying MISSING forward, since real progress happened on one of the two named clauses.
- **Suggested scope:** Ships when PF-401 (SDK resource clients, W6-R30) and PF-405 (parity fitness test, W6-R30/TRO-422) land: walk every v1OpenApiDocument path/method and assert the SDK exposes a typed call for it. The spec-validity half is already done and needs no further work.

### W6-R46 — MISSING
- **Quote:** "Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s; verify the signature with the SDK helper; tamper with the body and verify the helper rejects it."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — end-to-end webhook happy path + tamper negative, ≤2s first delivery.
- **Tickets:** TRO-455, TRO-413
- **What is missing:** PARTIAL PROGRESS NOTED, VERDICT UNCHANGED: sdk/ scaffold landed this range, closing baseline's 'no sdk/ directory exists anywhere' gap — but it ships only ShipClient.me() and error mapping; no webhooks resource client, no subscription creation, no verifyWebhook. Deliverer (PF-304) and subscriptions API (PF-302) remain wholly unbuilt. Requirement remains MISSING.
- **Suggested scope:** Ships only once the full chain lands: PF-302 (subscriptions API), PF-304 (deliverer), PF-401 (webhooks resource client in @ship/sdk), and PF-403 (verifyWebhook, TRO-413, still Backlog).

### W6-R47 — MISSING
- **Quote:** "Make a subscriber return 500 on the first three attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each attempt) and that the fourth attempt records success in the delivery log."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — deterministic retry test (500×3 → 200 on attempt 4).
- **Tickets:** TRO-438
- **What is missing:** No code changed in scope: git diff --stat empty. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (TRO-438, Backlog) ships with its deterministic-clock retry test suite.

### W6-R48 — MISSING
- **Quote:** "Force 6 consecutive failures. Verify the delivery lands in the dead-letter queue and is visible in the developer portal. Click \"Replay\" against a now-healthy subscriber and verify the replay succeeds with the original idempotency key intact."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — DLQ + portal visibility + replay with original key.
- **Tickets:** TRO-438, TRO-439
- **What is missing:** No code changed in scope. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (TRO-438) and PF-503 (TRO-439) ship, plus a PF-306-equivalent replay implementation.

### W6-R49 — MISSING
- **Quote:** "Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, pnpm install @ship/sdk → ship login → create document → receive verified webhook in under 30 minutes elapsed (in practice, seconds)."
- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Meaning in code:** Graded test scenario — the TTFE drill.
- **Tickets:** TRO-455, TRO-448
- **What is missing:** git diff --stat confirms no CLI/drill code landed. Verdict unchanged: MISSING.
- **Suggested scope:** Still needs the CLI with device-flow login (PF-600/TRO-448, Backlog) and the drill harness (PF-603/TRO-455, Backlog). Two baseline blockers are now satisfied (PF-106 device grant, sdk/ scaffold), shortening the remaining chain to PF-600 -> PF-603.

### W6-R50 — MISSING
- **Quote:** "≤ 30 min real elapsed; CI typically < 60 s"
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** TTFE targets: clean-machine ≤30 min (docs only), CI <60s (p.8 table restates: "TTFE drill runtime in CI (P95)" < 60 s).
- **Tickets:** TRO-455
- **What is missing:** No code in scope changed. Verdict carried forward: MISSING.
- **Suggested scope:** Unchanged from baseline: ships as part of PF-603 (TRO-455, Backlog).

### W6-R51 — MISSING
- **Quote:** "OAuth Auth Code + PKCE round-trip (P95)|< 3 s"
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** Performance target on the PKCE round-trip.
- **Tickets:** TRO-412, TRO-416, TRO-449
- **What is missing:** No code changed in scope: e2e/ has zero diff in this range, and PF-802/TRO-449 remains Backlog (re-confirmed via fresh Linear pull). Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: add a timing assertion to whichever spec ends up covering the full authorize->consent->token round trip once W6-R3/W6-R42's gap closes (measure wall-clock, assert <3s). Formally still blocked on PF-802/TRO-449 (Backlog), the ticket the requirement's own acceptance evidence names.

### W6-R52 — MISSING
- **Quote:** "Webhook delivery latency (P95, first attempt)|< 2 s"
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** First-attempt delivery latency target.
- **Tickets:** TRO-438
- **What is missing:** No code changed in scope. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: assessable only once PF-304's deliverer (TRO-438, Backlog) is built and instrumented with latency_ms per delivery.

### W6-R53 — MISSING
- **Quote:** "Webhook retry success rate after transient 5xx|100% within configured schedule"
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** Retry completeness target.
- **Tickets:** TRO-438
- **What is missing:** No code changed in scope. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304 (TRO-438, Backlog) ships with retry tests + delivery-log evidence.

### W6-R54 — MISSING
- **Quote:** "Public API responses with rate-limit headers|100%"
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** Header coverage target — including error responses.
- **Tickets:** TRO-427, TRO-552, TRO-391
- **What is missing:** Verdict unchanged (still MISSING, 0% header coverage), but one baseline evidence item was stale and is corrected above: the route-enumeration fitness test (PF-203/TRO-404) landed since baseline and now exists, just without a rate-limit header assertion.
- **Suggested scope:** Same fix as W6-R35 (TRO-427/PF-500), plus now that PF-203's fitness test file exists, wiring the header-presence assertion into it is a more concrete, smaller add-on than baseline's description implied.

### W6-R55 — MISSING
- **Quote:** "CLI drill harness: pnpm drill ttfe runs the full loop end-to-end against a containerized Ship instance from a clean working directory."
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** The `pnpm drill ttfe` command with containerized Ship (testcontainers per repo pattern).
- **Tickets:** TRO-455
- **What is missing:** No code in scope changed since baseline. Verdict carried forward: MISSING.
- **Suggested scope:** Unchanged from baseline: ships with PF-603 (TRO-455, Backlog).

### W6-R56 — MISSING
- **Quote:** "Timing instrumentation: each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** Per-stage ms instrumentation in the drill.
- **Tickets:** TRO-455
- **What is missing:** Repo-wide grep for 'drill'/'ttfe' re-run at HEAD — only same rate-limit/CORS comments plus one new CHANGES.md line. Verdict carried forward: MISSING.
- **Suggested scope:** Unchanged from baseline: ships with PF-603 (TRO-455, Backlog).

### W6-R57 — MISSING
- **Quote:** "Drill runs in CI on every PR. Any regression past the configured threshold fails the build."
- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Meaning in code:** TTFE drill wired into the graded CI (GitLab; GitHub mirror) on every PR with a failing threshold.
- **Tickets:** TRO-455
- **What is missing:** IMPORTANT PROCESS NOTE: .gitlab-ci.yml and .github/workflows/ci.yml did change between the two commits (verified directly), but only to wire in sdk/'s vitest suite as a CI step — no drill job, no CLI job. Verdict carried forward: MISSING.
- **Suggested scope:** Unchanged from baseline: ships with PF-603 (TRO-455, Backlog) — add a CI job to both .gitlab-ci.yml and the GitHub Actions mirror running 'pnpm drill ttfe' on every PR.

### W6-R58 — MISSING
- **Quote:** "Webhook signature verification (SDK helper)|< 1 ms per call"
- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Meaning in code:** verifyWebhook performance target.
- **Tickets:** TRO-413, TRO-433, TRO-390
- **What is missing:** PARTIAL PROGRESS NOTED, VERDICT UNCHANGED: sdk/ scaffold landed, so the destination package for verifyWebhook is no longer hypothetical — but no verifyWebhook function exists, and TRO-413/PF-403 remains Backlog. Requirement remains MISSING.
- **Suggested scope:** Ships when PF-403/TRO-413 lands with its own <1ms perf test for the SDK's verifyWebhook, now inside the real sdk/ package scaffold that exists as of this range.

### W6-R59 — MISSING
- **Quote:** "Drill flake rate over 20 consecutive CI runs|0% (any flake = bug in the drill or the platform)"
- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Meaning in code:** Zero-flake target tracked across 20 CI runs; a flake is a P0 platform/drill bug, never retry-masked.
- **Tickets:** TRO-455
- **What is missing:** Dependent entirely on W6-R55/56/57, all still MISSING. Verdict carried forward: MISSING.
- **Suggested scope:** Unchanged from baseline: not closable by a single code change — requires PF-603 (TRO-455) live in graded CI, then 20 consecutive observed runs.

### W6-R60 — MISSING
- **Quote:** "SDK install size (production deps only)|< 250 KB minified + gzipped"
- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Meaning in code:** SDK size budget, CI-checked.
- **Tickets:** TRO-422, TRO-390
- **What is missing:** sdk/ now exists (closing baseline's 'cannot be measured at all until sdk/ exists' blocker), but no CI size-check job of any kind was added this range — confirmed by re-grepping both .gitlab-ci.yml and .github/workflows/ci.yml (both of which DID change this range, but only to add sdk/'s unit-test step, not a size gate). TRO-422/PF-405 remains Backlog. Verdict carried forward as MISSING, blocker narrowed.
- **Suggested scope:** Ships when PF-405/TRO-422 lands: add a CI job (e.g. size-limit) gating sdk/'s production-dependency bundle at 250KB min+gz. sdk/ (PF-400) now exists to measure, which was baseline's blocker — the size-check job itself simply hasn't been written yet.

### W6-R61 — MISSING
- **Quote:** "Implement at Least 5 of the Following Integrations / Flows"
- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Meaning in code:** ≥5 of: CLI (must-ship), Slack (should-ship), Browser SDK demo, GitHub integration, refresh-rotation drill, Idempotency-Key drill, plugin runtime (stretch). NOTE: the Background (p.1) says "at least one working reference integration (a CLI tool is must-ship)" — the ≥5 line is the stricter, explicitly-scored one; treat ≥5 as binding.
- **Tickets:** TRO-394, TRO-448, TRO-445, TRO-447, TRO-449, TRO-451, TRO-453, TRO-454
- **What is missing:** Verdict carried forward: MISSING (0 of 5 required integration flows exist). One baseline citation (refresh_token grant absence) corrected above — the grant exists in api/'s OAuth engine now, but that is not the same as the integration-flow deliverable.
- **Suggested scope:** Sequence unchanged: E4 (sdk/, partially landed but without resource clients) -> E6 (PF-600 CLI) -> E8 (PF-800/801/802/803, the 5 committed flows). Zero of the 5 flows exist under integrations/ yet.

### W6-R62 — MISSING
- **Quote:** "CLI tool with device flow — ship login, ship docs ls/get/create, ship webhooks tail (must-ship)."
- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Meaning in code:** The CLI with those exact commands; `ship webhooks tail` streams verified deliveries.
- **Tickets:** TRO-448, TRO-450, TRO-452
- **What is missing:** Verdict carried forward: MISSING. 'ship login'/'ship docs'/'ship webhooks' strings still appear only in PLUGFORGE.MD, docs/architecture.md, and now one CHANGES.md write-up — never in actual source.
- **Suggested scope:** Unchanged: ships when PF-600 (TRO-448), PF-601 (TRO-450), PF-602 (TRO-452) are implemented. PF-600's prerequisite (PF-106 device grant) is now merged, removing one blocker.

### W6-R63 — PARTIAL
- **Quote:** "the platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns — exactly as in Part 2."
- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Meaning in code:** No LLM calls anywhere in the platform layer; agent unchanged in cost shape.
- **Tickets:** TRO-434
- **What is missing:** No code changed in scope for either clause since baseline. Part (a) — platform emits zero LLM calls — remains TRUE, re-confirmed directly. Part (b) — agent's LLM cost shape unchanged by the rewire — remains UNVERIFIABLE (Epic 7 has not started, agent/ has zero diff). Carrying PARTIAL forward unchanged.
- **Suggested scope:** No code change needed for the negative claim itself. Once Epic 7 lands, capture a cost-ledger before/after comparison proving token volume is unchanged — still the only outstanding half.

### W6-R64 — MISSING
- **Quote:** "LLM API spend during the agent rewire (Epic 7) — track per-day spend while migrating direct service calls to SDK calls; confirm the rewire does not change token volume."
- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Meaning in code:** Dev-cost tracking obligations (this plus CI minutes, Playwright compute, spec-gen overhead, delivery-log storage — same list, p.9).
- **Tickets:** TRO-434, TRO-440
- **What is missing:** No code changed in scope. The rewire (PF-701-704) still has not started. Carrying MISSING forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when Epic 7 ships. PF-905 (TRO-434) needs a dedicated doc pulling a pre/post pair once PF-701-704 land.

### W6-R65 — MISSING
- **Quote:** "Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls."
- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Meaning in code:** Production cost projections at 100/1k/10k/100k users with explicit assumptions: webhook fanout ratio, agent active rate, storage retention windows with rationale (p.9–10 "Include Assumptions").
- **Tickets:** TRO-434, TRO-395
- **What is missing:** No code changed in scope. Carrying MISSING forward unchanged.
- **Suggested scope:** Unchanged from baseline: PF-905 ships when TRO-434 lands — a new committed doc with the 100/1k/10k/100k-user cost tier table and stated assumptions.

### W6-R67 — MISSING
- **Quote:** "the Part 2 agent is rewired to authenticate as a first-party OAuth app and consume the public API through the SDK — same scopes, same rate limits, same audit trail."
- **Source:** GFA_Week_6_PlugForge.pdf, p.1
- **Meaning in code:** Epic 7: agent reads via app-identity OAuth, all traffic through @ship/sdk and /api/v1, provable in public_api_audit rows (per-epic proof, p.13).
- **Tickets:** TRO-393, TRO-417, TRO-423, TRO-428, TRO-435, TRO-440, TRO-414
- **What is missing:** No code changed in scope: agent/ is byte-for-byte unchanged. Confirmed nothing in api/src/platform issues the agent an OAuth app identity — no ship_app_fleetgraph row seeded anywhere. Carrying MISSING forward unchanged.
- **Suggested scope:** Unchanged from baseline: epic-sized. Dependency chain: PF-205 -> sdk/ (now scaffolded) -> PF-700 (human checkpoint) -> PF-701 -> PF-702 -> PF-703 -> PF-704. None have landed.

### W6-R68 — MISSING
- **Quote:** "The real queue-backed deliverer is tested with deterministic clock injection — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."
- **Source:** GFA_Week_6_PlugForge.pdf, p.11
- **Meaning in code:** Deliverer tests use an injected clock; zero setTimeout-based waiting.
- **Tickets:** TRO-438
- **What is missing:** No code changed in scope: git diff --stat empty. Verdict carried forward unchanged.
- **Suggested scope:** Unchanged from baseline: ships when PF-304's deliverer is actually built and tested (TRO-438, Backlog) using deterministic clock injection.

### W6-R69 — PARTIAL
- **Quote:** "External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced by a workspace dependency rule."
- **Source:** GFA_Week_6_PlugForge.pdf, p.11
- **Meaning in code:** integrations/* depend only on @ship/sdk, enforced by workspace/lint rules.
- **Tickets:** TRO-399, TRO-500, TRO-496
- **What is missing:** Verdict carried forward: PARTIAL. Re-ran the regression test directly at current HEAD and confirmed 10/10 still passes. No integrations/ directory or package exists yet. None of the 6 merged tickets touch this requirement's territory.
- **Suggested scope:** Unchanged: ships automatically once any package lands under integrations/* (E6/E8 work). Enforcement script already built, tested, CI-wired in both pipelines.

### W6-R72 — MISSING
- **Quote:** "The five-line story is the demo: open a fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail produces a verified signed delivery. Then switch to the dev portal and replay one delivery."
- **Source:** GFA_Week_6_PlugForge.pdf, p.12
- **Meaning in code:** Demo video (3–5 min) with that exact narrative.
- **Tickets:** TRO-444, TRO-395
- **What is missing:** No relevant change. TRO-444/PF-908 not among the six landed tickets. Carrying forward MISSING.
- **Suggested scope:** Unchanged from baseline: ships when TRO-444/PF-908 lands a new script with the five-line-story timecoded walkthrough.

### W6-R73 — MISSING
- **Quote:** "All three phases completed with written answers; saved AI conversation attached as a reference artifact."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Pre-Search document (Appendix phases 1–3) with real answers + the saved conversation artifact.
- **Tickets:** TRO-429, TRO-395
- **What is missing:** No relevant change. TRO-429/PF-904 not among the six landed tickets. Carrying forward MISSING.
- **Suggested scope:** Unchanged from baseline: HUMAN CHECKPOINT ticket, gated on Troy's actual input in addition to code.

### W6-R74 — MISSING
- **Quote:** "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at docs/openapi.json in the repo. Validate against the OpenAPI schema."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Deployed spec URL + committed docs/openapi.json kept in parity (CI diff).
- **Tickets:** TRO-409, TRO-388
- **What is missing:** Verdict unchanged (MISSING) but the reasoning materially changed: baseline called this 'fully blocked upstream by PF-202... hasn't landed either' — PF-202 has since landed (confirmed live at api/src/platform/api/v1/router.ts:50, and independently by W6-R8/R11/R21 this sweep), so PF-204/TRO-409 no longer has an upstream blocker, only its own Backlog status. No docs/openapi.json file or CI parity job exists yet either way.
- **Suggested scope:** No longer blocked upstream: PF-202 (the v1 generator + live serving route) landed this range, so the one remaining dependency baseline named is resolved. PF-204/TRO-409 (still Backlog) is now a self-contained task: commit a docs/openapi.json snapshot and add a CI job that regenerates + diffs it against the live-generated spec, failing the build on drift.

### W6-R75 — MISSING
- **Quote:** "Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Per-epic write-ups with the two named proofs.
- **Tickets:** TRO-437, TRO-395
- **What is missing:** No relevant change. E6 (TTFE drill) and E7 (agent rewire) did not land this range, so proof artifacts still don't exist. Carrying forward MISSING.
- **Suggested scope:** Unchanged from baseline: blocked on E6/E7 landing first.

### W6-R76 — MISSING
- **Quote:** "Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pattern."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Three discovery write-ups drawn from these candidates.
- **Tickets:** TRO-437, TRO-395
- **What is missing:** Two of four candidate discovery topics (Device Grant, zod->OpenAPI fitness parity) are now actually implemented, strengthening material available for the eventual write-up, but does not itself constitute it. Carrying forward MISSING.
- **Suggested scope:** Unchanged from baseline.

### W6-R77 — PARTIAL
- **Quote:** "Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus credentials in the README. Dev portal reachable; OpenAPI spec resolvable."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Grader-access deliverable — extends W6-R11 with README credentials + portal reachability.
- **Tickets:** TRO-441, TRO-411, TRO-402, TRO-436
- **What is missing:** Verdict label unchanged (PARTIAL) but evidence composition materially changed: of the two DoD sub-items MISSING at baseline, one is now closed at the code level (openapi.json registered + PR's own recorded live evidence). 'Dev portal reachable' remains genuinely missing. README's caveat is now half-stale — a real, minor documentation-drift finding.
- **Suggested scope:** Narrowed from baseline: only TRO-436/PF-502 (developer portal) remains to close this requirement's code-level gap; the OpenAPI-resolvable half is done pending live-deploy reprobe. Also: refresh README.md:356's caveat text.

### W6-R78 — MISSING
- **Quote:** "Tag @GauntletAI. The screenshot is the ship webhooks tail terminal showing a verified signed event arriving in real time."
- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Meaning in code:** Social post deliverable with the specified screenshot.
- **Tickets:** TRO-444, TRO-395
- **What is missing:** No relevant change. Same TRO-444/PF-908 ticket as W6-R72, not among the six landed tickets. The CLI (PF-600/TRO-448) this screenshot depends on also did not land. Carrying forward MISSING.
- **Suggested scope:** Unchanged from baseline.

## Orphan tickets

Ticket-mapping scope this sweep: 95 tickets in the PlugForge project (up from 86 at baseline).
10 tickets map to zero requirements (EPIC container tickets excluded by design):

- **TRO-396** "PF-001: Ship has no public API surface — platform scaffold + /api/v1 router (request IDs, public CORS)" — Foundational scaffolding ticket (Done). Its code (router.ts, requestIdMiddleware, public CORS setup) is cited as supporting EVIDENCE across many other requirements (W6-R4, R5, R6, R8, R11, R15, R43, etc.), but no PDF-graded requirement's own quote is specifically about the scaffold itself — the brief's requirement lines start from OAuth features (W6-R2 onward). Not a tracer oversight: there is no requirement line for PF-001 to attach to.
- **TRO-490** "Pre-existing: swagger.ts YAML converter emits mis-indented YAML (openapi.yaml) — JSON spec unaffected" — Internal tooling bug found incidentally during W6 work on a pre-existing (pre-W6) script; not a PF-numbered requirement ticket and no PlugForge brief requirement covers YAML-output formatting of the internal Swagger converter.
- **TRO-501** "Route-level createIssueSchema accepts 'none' priority — absent from IssuePriority union and OpenAPI schema" — A bug found in the internal (non-v1) issues route's schema, incidental to W6 work; not a PF-numbered ticket and no PlugForge brief requirement covers internal issue-priority validation.
- **TRO-551** "OpenAPI registry + MCP executor hardcode the /api prefix — non-/api routes (/oauth/*) cannot be registered without shipping 404ing MCP tools" — Ship-internal MCP/OpenAPI tooling fix (Done), thematically adjacent to PF-202 (already covered by W6-R8/R11/R21/R45 via TRO-402) but not itself the subject of any graded requirement quote — no PF number, and none of the 79 requirements name it.
- **TRO-587** "CodeQL js/insufficient-password-hash false-positive on oauth/credentials.ts — needs formal dismissal" — CodeRabbit/CodeQL review-triage follow-up from tonight's OAuth work; a security-scanner finding, not a requirement in the guideline PDF.
- **TRO-588** "/oauth/* routes have no route-scoped rate limiting" — Review-triage follow-up; overlaps W6-R35's territory (rate limiting) but is scoped to /oauth/* specifically, not named by any inventory requirement's text.
- **TRO-589** "Device-grant user_code stored plaintext, not hashed" — Review-triage follow-up from PF-106/TRO-425 (landed tonight); a hardening finding against device.ts, not itself a brief requirement.
- **TRO-590** "CodeQL js/missing-rate-limiting has a blind spot: flags test-only Express apps as production routes" — CodeQL tooling-accuracy finding, unrelated to any inventory requirement's text.
- **TRO-591** "Composite DB index opportunity flagged by PF-201's pagination work" — Performance-hardening follow-up from PF-201/TRO-400 (landed tonight); no inventory requirement names a specific index.
- **TRO-592** "Shared pagination-router factory opportunity across v1 resources" — Code-reuse/refactor follow-up from PF-201's four new v1 resources; not itself a brief requirement.

Note: TRO-593/594/595/596 (the 4 e2e-regression remediation tickets filed from this sweep's own
W6-R10 bisection) are NOT orphans — they map directly to W6-R10 above, since they trace to its
"existing Playwright regression suite passes" clause.
