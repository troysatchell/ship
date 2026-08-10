# Requirements Inventory — W6 (GFA_Week_6_PlugForge.pdf)

Extracted 2026-08-10 from `project guideliens/GFA_Week_6_PlugForge.pdf` (18 pages,
sha256 `81a3788d…`). Mechanical text cache: `audit/requirements/source-W6.md` — every
Quote below is a whitespace-normalized substring of that cache. First-extraction
skim gate: **cleared 2026-08-10** — the user confirmed the inventory; sweeps may proceed.

> Note for future sweeps: W6 work will live in its own Linear project. The config's
> `tickets.project` is currently scoped to W5 ("FleetGraph — Week 5 Project Intelligence
> Agent"); re-scope before any W6 baseline, per the config's own instructions.

---

## W6-R1

- **Source:** GFA_Week_6_PlugForge.pdf, p.1
- **Quote:** "One-week sprint with four deadlines:"
- **Meaning in code:** Process schedule — Architectural Defense Monday 1:00 PM CT; MVP Tuesday 11:59 PM CT; Early Submission Thursday 11:59 PM CT; Final Submission Sunday 11:59 AM CT (p.1 table). NOTE: p.12 Submission Requirements says "Deadline: Sunday 11:59 PM CT" — the brief contradicts itself on AM vs PM for final submission. Plan for the earlier (AM) reading.
- **Type:** process
- **Acceptance evidence:** N/A for code sweep; deadline discipline is observable in git/Linear history.
- **Status:** active

## W6-R2

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "OAuth app registration endpoint working: admin can create an app, receive a client_id, and a client_secret hashed in the database (raw secret shown exactly once on creation)."
- **Meaning in code:** An admin endpoint creating rows in an `oauth_apps` table, returning client_id + raw secret once, storing only a hash. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — registration/rotation unit tests; route registered per ship-openapi conventions.
- **Status:** active

## W6-R3

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Authorization Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token."
- **Meaning in code:** `/oauth/authorize` + consent UI + `/oauth/token` implementing RFC 6749 + 7636, proven by a Playwright e2e. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.e2e — a Playwright spec covering authorize → consent → token → authenticated call.
- **Status:** active

## W6-R4

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Bearer token middleware validates tokens on every /api/v1/* route; invalid tokens return 401, missing tokens return 401, expired tokens return 401 with a distinct error code."
- **Meaning in code:** v1-only bearer middleware with three distinguishable 401 variants. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — middleware unit tests asserting the three 401 cases and the distinct expired code.
- **Status:** active

## W6-R5

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "At least one resource (documents) implements GET list, GET by id, and POST. Each route declares its required scope via a require(scope) middleware factory."
- **Meaning in code:** `/api/v1/documents` list/get/create wired through a `require(scope)` factory. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — CRUD tests; route table shows require('documents:read'/'documents:write').
- **Status:** active

## W6-R6

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Consistent ApiError shape ({code, message, details?, request_id}) returned on every public failure, asserted by a fitness test over all /api/v1 routes."
- **Meaning in code:** Public error middleware producing the ApiError shape on every v1 failure path, plus a route-enumerating fitness test. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — the fitness test walks the v1 router and asserts the shape on failure paths.
- **Status:** active

## W6-R7

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "ScopeRegistry has scopes-as-data; insufficient scope returns 403 with the missing scope named explicitly in the error body (no opaque \"forbidden\")."
- **Meaning in code:** A ScopeRegistry data structure; 403 responses carry the missing scope in details. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — 403 test asserting the named missing scope.
- **Status:** active

## W6-R8

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "OpenAPI 3.1 spec served at /api/v1/openapi.json, generated from route metadata (never hand-written), validating against the OpenAPI schema in a unit test."
- **Meaning in code:** In-process spec generator + serving route + schema-validation unit test. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — spec-validation unit test green; `GET /api/v1/openapi.json` 200s.
- **Status:** active

## W6-R9

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token}).me()` against a running server returns the typed authenticated user."
- **Meaning in code:** `sdk/` workspace package exporting ShipClient with a working `me()`. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** verify.test — integration test of `me()` against a test server.
- **Status:** active

## W6-R10

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."
- **Meaning in code:** No regression: e2e suite green, and the three Part-1 baseline metrics (in `audit/`) stay within +10%. (MVP hard gate.)
- **Type:** non-functional
- **Acceptance evidence:** verify.e2e green; compare runs of api-perf/bundle/db-query audits vs `audit/` baselines.
- **Status:** active

## W6-R11

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Deployed and publicly accessible: deployed Ship + published OpenAPI spec URL + at least one OAuth app pre-registered with read-only scopes for graders."
- **Meaning in code:** Live deployment carrying the platform layer, public spec URL, seeded grader OAuth app. (MVP hard gate.)
- **Type:** process
- **Acceptance evidence:** verify_urls.app / deployed URL probes; seed evidence in migrations or boot code.
- **Status:** active

## W6-R12

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "Terraform deployment: a terraform/ directory with a complete config describing the deployment topology (app container, database, networking, IAM task role and execution role). Provider versions must be pinned. Run terraform plan and include the annotated output as a submission artifact. Perform a destroy-and-redeploy: tear down the environment and re-apply from the Terraform config alone to prove IaC completeness."
- **Meaning in code:** Complete IaC for the deployment (repo deploys to Render — the IAM-role language is AWS-shaped and needs adaptation), pinned providers, committed annotated plan, destroy-redeploy evidence. (MVP hard gate.)
- **Type:** functional
- **Acceptance evidence:** `terraform/` config + committed plan artifact + destroy-redeploy logs.
- **Status:** active

## W6-R13

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "oauth_apps table with id, client_id, hashed client_secret, redirect_uris, owner, requested_scopes. Raw secret shown once on creation and rotation; never recoverable thereafter."
- **Meaning in code:** Numbered migration creating `oauth_apps` with those columns; rotation also returns raw secret exactly once.
- **Type:** functional
- **Acceptance evidence:** migration file + `\d oauth_apps`; tests asserting non-recoverability.
- **Status:** active

## W6-R14

- **Source:** GFA_Week_6_PlugForge.pdf, p.2
- **Quote:** "code_challenge and code_challenge_method recorded at /oauth/authorize; code_verifier required at /oauth/token. Mismatched verifier returns 400 with invalid_grant."
- **Meaning in code:** PKCE recorded on the authorization code and verified at token exchange; negative case returns 400 invalid_grant.
- **Type:** functional
- **Acceptance evidence:** verify.test — wrong-verifier negative test.
- **Status:** active

## W6-R15

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "/oauth/device/code issues a user_code and device_code; /oauth/device/verify accepts the user_code; the client polls /oauth/token until authorized. Slow-down responses honored."
- **Meaning in code:** RFC 8628 Device Authorization Grant endpoints, including slow_down semantics honored by clients.
- **Type:** functional
- **Acceptance evidence:** verify.test — integration test polling to approval with slow_down honored.
- **Status:** active

## W6-R16

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Scopes-as-data: documents:read, documents:write, issues:read, issues:write, sprints:read, sprints:write, webhooks:manage. New scopes register at module load, never edit middleware."
- **Meaning in code:** The seven named scopes exist as registry data; adding a scope requires no middleware edit.
- **Type:** functional
- **Acceptance evidence:** ScopeRegistry source; unit test registering a new scope without middleware change.
- **Status:** active

## W6-R17

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Bearer validation; populates request with app, user, granted scopes. Invalid token: 401. Insufficient scope: 403 with missing scope named."
- **Meaning in code:** Middleware sets a principal ({app, user, scopes}) on the request; overlaps W6-R4/R7 but adds the populated-principal contract.
- **Type:** functional
- **Acceptance evidence:** verify.test — middleware tests asserting req principal contents.
- **Status:** active

## W6-R18

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "One-time-use refresh tokens with rotation. Stolen-refresh-token detection: reuse invalidates the family."
- **Meaning in code:** Refresh rotation with family-wide revocation on reuse of a rotated token.
- **Type:** functional
- **Acceptance evidence:** verify.test — rotation, reuse-detection, family-revocation unit tests.
- **Status:** active

## W6-R19

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Public routes live only at /api/v1/*. Internal endpoints stay at /api/. Lint rule fails the build if a public route imports from internal handler files."
- **Meaning in code:** Boundary enforced by ESLint `no-restricted-imports` (or equivalent) failing CI on cross-imports.
- **Type:** functional
- **Acceptance evidence:** lint config + evidence that a deliberate violation fails the build.
- **Status:** active

## W6-R20

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Opaque base64 cursors over { id, timestamp}. List responses always return { data, next_cursor}. Cursors are stable across reordering operations."
- **Meaning in code:** Keyset cursor pagination on every v1 list endpoint with the {data, next_cursor} envelope.
- **Type:** functional
- **Acceptance evidence:** verify.test — pagination stability test across insertions/reordering.
- **Status:** active

## W6-R21

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Generated from route metadata in-process. Served at /api/v1/openapi.json. Validates against the OpenAPI schema in a unit test. Spec parity asserted by fitness test."
- **Meaning in code:** Spec generation is in-process from route metadata; a fitness test asserts 100% spec ↔ route parity (see also W6-R44/R45).
- **Type:** functional
- **Acceptance evidence:** verify.test — parity fitness test green.
- **Status:** active

## W6-R22

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Event types as data: document.created, document.updated, document.deleted, issue.created, issue.assigned, issue.status_changed, sprint.started, sprint.completed. Each with a Zod schema."
- **Meaning in code:** An enumerable event registry of exactly these 8 types, each with a Zod payload schema.
- **Type:** functional
- **Acceptance evidence:** registry source + schema unit tests.
- **Status:** active

## W6-R23

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "IEventBus interface. Domain layer publishes on writes — never the route layer. In-process implementation must-ship; queue-backed implementation is a Liskov-substitutable drop-in."
- **Meaning in code:** IEventBus interface with in-process impl; publish() calls live only in the domain write path (implies consolidating Ship's currently route-scattered document writes).
- **Type:** functional
- **Acceptance evidence:** interface + impl source; grep/lint proof of zero publish calls in route files.
- **Status:** active

## W6-R24

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."
- **Meaning in code:** Subscriptions table + CRUD API under webhooks:manage. NOTE: "hashed signing secret" is unimplementable as a one-way hash (the server must possess the secret to sign) — PLUGFORGE.MD §2.2 deviates deliberately to encrypted-at-rest; this needs to be defended in the architecture doc.
- **Type:** functional
- **Acceptance evidence:** migration + CRUD tests; secret non-recoverable via API after creation.
- **Status:** active

## W6-R25

- **Source:** GFA_Week_6_PlugForge.pdf, p.3
- **Quote:** "Stripe-style header: Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>. Timestamp prevents replay; SDK rejects any signature older than 5 minutes by default."
- **Meaning in code:** HMAC-SHA256 signer producing the t=/v1= header over the timestamped payload; SDK-side 300s default tolerance.
- **Type:** functional
- **Acceptance evidence:** verify.test — signer suite (positive, tamper, expired, missing v1, boundary).
- **Status:** active

## W6-R26

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m. Subscribers returning 5xx or timing out are retried; 4xx responses are treated as permanent failures and dead-lettered."
- **Meaning in code:** Retry scheduler with exactly that schedule + jitter; 5xx/timeout retried, 4xx dead-lettered immediately.
- **Type:** functional
- **Acceptance evidence:** verify.test — deterministic-clock tests of the schedule and 4xx/5xx branching.
- **Status:** active

## W6-R27

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "After 6 failed attempts, deliveries land in a DLQ visible in the developer portal. Operators can replay manually; replays carry the original idempotency key."
- **Meaning in code:** DLQ at attempt 6, surfaced in portal UI, manual replay preserving Idempotency-Key.
- **Type:** functional
- **Acceptance evidence:** verify.test + verify.e2e — 6-failure test; portal DLQ + replay flow.
- **Status:** active

## W6-R28

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "webhook_deliveries table records every attempt with subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms. Queryable per app."
- **Meaning in code:** Delivery-log table with those columns; per-app query path (API + portal).
- **Type:** functional
- **Acceptance evidence:** migration + delivery-log API tests.
- **Status:** active

## W6-R29

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."
- **Meaning in code:** Replay endpoint re-emitting a logged delivery with its original Idempotency-Key.
- **Type:** functional
- **Acceptance evidence:** verify.test — replay test asserting original key at subscriber.
- **Status:** active

## W6-R30

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "@ship/sdk exposes resource clients: client.documents, client.issues, client.sprints, client.webhooks. Method signatures match OpenAPI spec; drift fails CI via a fitness test."
- **Meaning in code:** Resource-segregated SDK surface + spec↔SDK parity fitness test wired into CI.
- **Type:** functional
- **Acceptance evidence:** verify.test — parity fitness test; simulated drift fails.
- **Status:** active

## W6-R31

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser localStorage)."
- **Meaning in code:** SDK auth helpers for both grants + ITokenStore with the three store implementations.
- **Type:** functional
- **Acceptance evidence:** verify.test — device-login e2e against local server; store unit tests.
- **Status:** active

## W6-R32

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "for await (const doc of client.documents.iterate()) walks pages transparently. Cursors handled internally; consumer code never sees them."
- **Meaning in code:** Async-iterator pagination on SDK list clients; cursors fully internal.
- **Type:** functional
- **Acceptance evidence:** verify.test — multi-page iteration test; early-break no overfetch.
- **Status:** active

## W6-R33

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "verifyWebhook(headers, rawBody, secret) returns true/false in one call. Tampered bodies fail; expired timestamps fail; missing v1 header fails."
- **Meaning in code:** One-call SDK verifier with the three failure modes.
- **Type:** functional
- **Acceptance evidence:** verify.test — verifier suite incl. all three negatives.
- **Status:** active

## W6-R34

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "SDK errors are a discriminated union: { kind: 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server',...}. Consumers can switch on kind exhaustively."
- **Meaning in code:** Typed error union in the SDK, exhaustively switchable.
- **Type:** functional
- **Acceptance evidence:** SDK types + tests mapping ApiError codes to kinds.
- **Status:** active

## W6-R35

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "Per-app and per-token token-bucket limits. Public responses carry X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset; 429 responses carry Retry-After."
- **Meaning in code:** Two-level token buckets; headers on all v1 responses; 429 + Retry-After. (Requires exempting /api/v1 from the legacy `/api/`-prefix limiters — post-TRO-172 these are 600/min/identity + 6,000/min/IP in prod, `api/src/middleware/rate-limit.ts:130-132`; API-1's original 100/min/IP cap no longer exists.)
- **Type:** functional
- **Acceptance evidence:** verify.test — bucket tests with injected clock; header-presence fitness assertion.
- **Status:** active

## W6-R36

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "Every public API call recorded with timestamp, app client_id, user_id, route, scope used, status, latency. Queryable in the developer portal."
- **Meaning in code:** public_api_audit table + recording middleware + portal query surface.
- **Type:** functional
- **Acceptance evidence:** migration + middleware tests; portal view.
- **Status:** active

## W6-R37

- **Source:** GFA_Week_6_PlugForge.pdf, p.4
- **Quote:** "In-app UI for: listing apps, registering apps, viewing/rotating client_secret (shown once), managing subscriptions, browsing the delivery log, replaying failed deliveries."
- **Meaning in code:** Developer portal in the existing Ship web app covering those six functions.
- **Type:** functional
- **Acceptance evidence:** verify.e2e — Playwright portal flows; network evidence portal uses /api/v1.
- **Status:** active

## W6-R38

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "terraform/ directory describing app container, database, VPC/subnets, and security groups. All provider and module versions pinned. terraform plan must run cleanly; no unpinned versions permitted."
- **Meaning in code:** IaC topology (Render adaptation: no VPC/subnet/SG primitives — the adaptation must be defended per PLUGFORGE PF-902); pinned providers; clean plan.
- **Type:** functional
- **Acceptance evidence:** terraform config + plan output artifact.
- **Status:** active

## W6-R39

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Start with an AdministratorAccess task role. Lock it down to the minimum permissions the platform actually needs. Verify the service still works, then verify an action outside the policy is denied. Submit before/after IAM policy with rationale for every permission granted."
- **Meaning in code:** AWS-IAM-shaped exercise; on Render this maps to API-key scoping/service isolation — adaptation memo required (PLUGFORGE PF-902).
- **Type:** process
- **Acceptance evidence:** before/after policy artifact (or the defended Render adaptation memo) in docs/.
- **Status:** active

## W6-R40

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Demonstrate drift: manually change a resource, run terraform plan, show the detected diff. Perform terraform destroy then terraform apply from scratch. Submit screenshots or log output proving the service came back up identically."
- **Meaning in code:** Drift-detection demo + destroy-redeploy with committed evidence.
- **Type:** process
- **Acceptance evidence:** committed logs/screenshots.
- **Status:** active

## W6-R41

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Graders will present a modified terraform plan during the Architecture Defense and ask you to walk through every resource change, identify the blast radius, and flag any risky operations. Inability to read a Terraform plan without AI assistance is an auto-fail condition."
- **Meaning in code:** Human competency requirement (Troy must be able to read a plan unaided) — auto-fail stakes.
- **Type:** process
- **Acceptance evidence:** N/A in repo; preparation material (PLUGFORGE PF-902/PF-100-style briefing) is the proxy.
- **Status:** active

## W6-R42

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Complete the Authorization Code + PKCE flow in a Playwright test from a registered web app. Confirm that a wrong code_verifier on the token exchange returns invalid_grant (negative case is mandatory, not optional)."
- **Meaning in code:** Graded test scenario — PKCE e2e + mandatory negative.
- **Type:** functional
- **Acceptance evidence:** verify.e2e — the named Playwright spec incl. negative.
- **Status:** active

## W6-R43

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."
- **Meaning in code:** Graded test scenario — device flow via CLI to /api/v1/me.
- **Type:** functional
- **Acceptance evidence:** verify.test — CLI-driven integration test.
- **Status:** active

## W6-R44

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Enumerate every /api/v1/* route in a fitness test and assert each one (a) has an OpenAPI entry, (b) declares a scope, (c) returns the ApiError shape on failure paths, and (d) supports cursor pagination if it's a list endpoint."
- **Meaning in code:** Graded test scenario — the route-enumeration fitness test with the four assertions.
- **Type:** functional
- **Acceptance evidence:** verify.test — fitness test present and green; fails on an unregistered scratch route.
- **Status:** active

## W6-R45

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Validate the generated /api/v1/openapi.json against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert the SDK exposes a typed call for it."
- **Meaning in code:** Graded test scenario — spec validity + spec→SDK parity walk.
- **Type:** functional
- **Acceptance evidence:** verify.test — both assertions green.
- **Status:** active

## W6-R46

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s; verify the signature with the SDK helper; tamper with the body and verify the helper rejects it."
- **Meaning in code:** Graded test scenario — end-to-end webhook happy path + tamper negative, ≤2s first delivery.
- **Type:** functional
- **Acceptance evidence:** verify.test — e2e webhook test with latency assertion.
- **Status:** active

## W6-R47

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Make a subscriber return 500 on the first three attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each attempt) and that the fourth attempt records success in the delivery log."
- **Meaning in code:** Graded test scenario — deterministic retry test (500×3 → 200 on attempt 4).
- **Type:** functional
- **Acceptance evidence:** verify.test — deterministic-clock retry test.
- **Status:** active

## W6-R48

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Force 6 consecutive failures. Verify the delivery lands in the dead-letter queue and is visible in the developer portal. Click \"Replay\" against a now-healthy subscriber and verify the replay succeeds with the original idempotency key intact."
- **Meaning in code:** Graded test scenario — DLQ + portal visibility + replay with original key.
- **Type:** functional
- **Acceptance evidence:** verify.test + verify.e2e.
- **Status:** active

## W6-R49

- **Source:** GFA_Week_6_PlugForge.pdf, p.5
- **Quote:** "Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, pnpm install @ship/sdk → ship login → create document → receive verified webhook in under 30 minutes elapsed (in practice, seconds)."
- **Meaning in code:** Graded test scenario — the TTFE drill.
- **Type:** functional
- **Acceptance evidence:** drill run logs in CI; clean-machine run documented.
- **Status:** active

## W6-R50

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "≤ 30 min real elapsed; CI typically < 60 s"
- **Meaning in code:** TTFE targets: clean-machine ≤30 min (docs only), CI <60s (p.8 table restates: "TTFE drill runtime in CI (P95)" < 60 s).
- **Type:** non-functional
- **Acceptance evidence:** drill timing instrumentation output in CI logs.
- **Status:** active

## W6-R51

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "OAuth Auth Code + PKCE round-trip (P95)|< 3 s"
- **Meaning in code:** Performance target on the PKCE round-trip.
- **Type:** non-functional
- **Acceptance evidence:** measured in the Playwright PKCE e2e (PLUGFORGE PF-802 asserts it).
- **Status:** active

## W6-R52

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "Webhook delivery latency (P95, first attempt)|< 2 s"
- **Meaning in code:** First-attempt delivery latency target.
- **Type:** non-functional
- **Acceptance evidence:** latency_ms in delivery log; asserted in W6-R46's test.
- **Status:** active

## W6-R53

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "Webhook retry success rate after transient 5xx|100% within configured schedule"
- **Meaning in code:** Retry completeness target.
- **Type:** non-functional
- **Acceptance evidence:** retry tests + delivery-log evidence.
- **Status:** active

## W6-R54

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "Public API responses with rate-limit headers|100%"
- **Meaning in code:** Header coverage target — including error responses.
- **Type:** non-functional
- **Acceptance evidence:** header-presence assertion in the fitness test.
- **Status:** active

## W6-R55

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "CLI drill harness: pnpm drill ttfe runs the full loop end-to-end against a containerized Ship instance from a clean working directory."
- **Meaning in code:** The `pnpm drill ttfe` command with containerized Ship (testcontainers per repo pattern).
- **Type:** functional
- **Acceptance evidence:** script + CI job; drill run log.
- **Status:** active

## W6-R56

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "Timing instrumentation: each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."
- **Meaning in code:** Per-stage ms instrumentation in the drill.
- **Type:** functional
- **Acceptance evidence:** drill output showing per-stage timings.
- **Status:** active

## W6-R57

- **Source:** GFA_Week_6_PlugForge.pdf, p.6
- **Quote:** "Drill runs in CI on every PR. Any regression past the configured threshold fails the build."
- **Meaning in code:** TTFE drill wired into the graded CI (GitLab; GitHub mirror) on every PR with a failing threshold.
- **Type:** functional
- **Acceptance evidence:** CI config lines + a PR run showing the drill job.
- **Status:** active

## W6-R58

- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Quote:** "Webhook signature verification (SDK helper)|< 1 ms per call"
- **Meaning in code:** verifyWebhook performance target.
- **Type:** non-functional
- **Acceptance evidence:** perf test in the SDK suite.
- **Status:** active

## W6-R59

- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Quote:** "Drill flake rate over 20 consecutive CI runs|0% (any flake = bug in the drill or the platform)"
- **Meaning in code:** Zero-flake target tracked across 20 CI runs; a flake is a P0 platform/drill bug, never retry-masked.
- **Type:** non-functional
- **Acceptance evidence:** CI run history over 20 runs.
- **Status:** active

## W6-R60

- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Quote:** "SDK install size (production deps only)|< 250 KB minified + gzipped"
- **Meaning in code:** SDK size budget, CI-checked.
- **Type:** non-functional
- **Acceptance evidence:** CI size-check job output.
- **Status:** active

## W6-R61

- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Quote:** "Implement at Least 5 of the Following Integrations / Flows"
- **Meaning in code:** ≥5 of: CLI (must-ship), Slack (should-ship), Browser SDK demo, GitHub integration, refresh-rotation drill, Idempotency-Key drill, plugin runtime (stretch). NOTE: the Background (p.1) says "at least one working reference integration (a CLI tool is must-ship)" — the ≥5 line is the stricter, explicitly-scored one; treat ≥5 as binding.
- **Type:** functional
- **Acceptance evidence:** five gated deliverables under integrations/ + drill specs.
- **Status:** active

## W6-R62

- **Source:** GFA_Week_6_PlugForge.pdf, p.8
- **Quote:** "CLI tool with device flow — ship login, ship docs ls/get/create, ship webhooks tail (must-ship)."
- **Meaning in code:** The CLI with those exact commands; `ship webhooks tail` streams verified deliveries.
- **Type:** functional
- **Acceptance evidence:** integrations/cli source + e2e of the five-line story.
- **Status:** active

## W6-R63

- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Quote:** "the platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns — exactly as in Part 2."
- **Meaning in code:** No LLM calls anywhere in the platform layer; agent unchanged in cost shape.
- **Type:** non-functional
- **Acceptance evidence:** absence of LLM client imports under api/src/platform + cost-ledger before/after.
- **Status:** active

## W6-R64

- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Quote:** "LLM API spend during the agent rewire (Epic 7) — track per-day spend while migrating direct service calls to SDK calls; confirm the rewire does not change token volume."
- **Meaning in code:** Dev-cost tracking obligations (this plus CI minutes, Playwright compute, spec-gen overhead, delivery-log storage — same list, p.9).
- **Type:** process
- **Acceptance evidence:** cost-analysis doc with ledger-traceable figures.
- **Status:** active

## W6-R65

- **Source:** GFA_Week_6_PlugForge.pdf, p.9
- **Quote:** "Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls."
- **Meaning in code:** Production cost projections at 100/1k/10k/100k users with explicit assumptions: webhook fanout ratio, agent active rate, storage retention windows with rationale (p.9–10 "Include Assumptions").
- **Type:** process
- **Acceptance evidence:** committed cost-analysis doc with the tier table + assumptions.
- **Status:** active

## W6-R66

- **Source:** GFA_Week_6_PlugForge.pdf, p.10
- **Quote:** "Node.js + Express (existing Ship stack); TypeScript strict mode required; Zod for request/response schemas and OpenAPI generation."
- **Meaning in code:** New platform/SDK code under TypeScript strict mode; Zod schemas drive the spec.
- **Type:** non-functional
- **Acceptance evidence:** tsconfig strict flags for sdk/ + platform code; verify.typecheck.
- **Status:** active

## W6-R67

- **Source:** GFA_Week_6_PlugForge.pdf, p.1
- **Quote:** "the Part 2 agent is rewired to authenticate as a first-party OAuth app and consume the public API through the SDK — same scopes, same rate limits, same audit trail."
- **Meaning in code:** Epic 7: agent reads via app-identity OAuth, all traffic through @ship/sdk and /api/v1, provable in public_api_audit rows (per-epic proof, p.13).
- **Type:** functional
- **Acceptance evidence:** audit-trail rows for the agent's client_id; agent suite green in rewired mode.
- **Status:** active

## W6-R68

- **Source:** GFA_Week_6_PlugForge.pdf, p.11
- **Quote:** "The real queue-backed deliverer is tested with deterministic clock injection — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."
- **Meaning in code:** Deliverer tests use an injected clock; zero setTimeout-based waiting.
- **Type:** non-functional
- **Acceptance evidence:** deliverer test source shows injected clock; no timing sleeps.
- **Status:** active

## W6-R69

- **Source:** GFA_Week_6_PlugForge.pdf, p.11
- **Quote:** "External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced by a workspace dependency rule."
- **Meaning in code:** integrations/* depend only on @ship/sdk, enforced by workspace/lint rules.
- **Type:** functional
- **Acceptance evidence:** workspace config + lint rule + violation-fails-build evidence.
- **Status:** active

## W6-R70

- **Source:** GFA_Week_6_PlugForge.pdf, p.11
- **Quote:** "Architecture Document (1–2 pages) committed at docs/architecture.md."
- **Meaning in code:** docs/architecture.md with the nine mandated sections (Module Layout, SOLID Rationale, Composition Root, Public/Internal Boundary, OAuth Flows, Webhook Pipeline, SDK Surface, Agent-as-Citizen, Failure Modes — p.12 table).
- **Type:** process
- **Acceptance evidence:** the committed doc containing all nine section headings.
- **Status:** active

## W6-R71

- **Source:** GFA_Week_6_PlugForge.pdf, p.12
- **Quote:** "GitHub Repository Public; per-slice branches preserved; each PR description lists which acceptance criterion that slice advances and confirms the fitness test passed."
- **Meaning in code:** Repo/PR process discipline for the week.
- **Type:** process
- **Acceptance evidence:** PR descriptions on GitHub; branch list.
- **Status:** active

## W6-R72

- **Source:** GFA_Week_6_PlugForge.pdf, p.12
- **Quote:** "The five-line story is the demo: open a fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail produces a verified signed delivery. Then switch to the dev portal and replay one delivery."
- **Meaning in code:** Demo video (3–5 min) with that exact narrative.
- **Type:** process
- **Acceptance evidence:** recorded video + committed script.
- **Status:** active

## W6-R73

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "All three phases completed with written answers; saved AI conversation attached as a reference artifact."
- **Meaning in code:** Pre-Search document (Appendix phases 1–3) with real answers + the saved conversation artifact.
- **Type:** process
- **Acceptance evidence:** committed pre-search doc + attachment.
- **Status:** active

## W6-R74

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at docs/openapi.json in the repo. Validate against the OpenAPI schema."
- **Meaning in code:** Deployed spec URL + committed docs/openapi.json kept in parity (CI diff).
- **Type:** functional
- **Acceptance evidence:** deployed URL probe + committed file + CI parity job.
- **Status:** active

## W6-R75

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication."
- **Meaning in code:** Per-epic write-ups with the two named proofs.
- **Type:** process
- **Acceptance evidence:** committed write-ups linking CI run + audit rows.
- **Status:** active

## W6-R76

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pattern."
- **Meaning in code:** Three discovery write-ups drawn from these candidates.
- **Type:** process
- **Acceptance evidence:** three committed discovery docs.
- **Status:** active

## W6-R77

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus credentials in the README. Dev portal reachable; OpenAPI spec resolvable."
- **Meaning in code:** Grader-access deliverable — extends W6-R11 with README credentials + portal reachability.
- **Type:** process
- **Acceptance evidence:** README section + live probes.
- **Status:** active

## W6-R78

- **Source:** GFA_Week_6_PlugForge.pdf, p.13
- **Quote:** "Tag @GauntletAI. The screenshot is the ship webhooks tail terminal showing a verified signed event arriving in real time."
- **Meaning in code:** Social post deliverable with the specified screenshot.
- **Type:** process
- **Acceptance evidence:** committed draft + posted link.
- **Status:** active

## W6-R79

- **Source:** GFA_Week_6_PlugForge.pdf, p.14
- **Quote:** "Gate: Project completion + interviews required for Austin admission. The interview is where you defend your"
- **Meaning in code:** Process gate — interview defense of the public/internal boundary, OAuth flow choices, and agent-as-citizen (human competency; drives PLUGFORGE's HUMAN CHECKPOINT tickets).
- **Type:** process
- **Acceptance evidence:** N/A in repo; briefing/checkpoint artifacts are the proxy.
- **Status:** active
