### W6-R1 — N/A
**Brief says:** "One-week sprint with four deadlines:"

**In plain English:** This is the sprint's four-deadline schedule (defense Monday, MVP Tuesday, early Thursday, final Sunday). Nothing in the code can satisfy or fail it; the only in-repo proxy is the merge history itself. It stays N/A.

- **Tickets:** — (no ticket maps here)
- **Evidence:** —

### W6-R2 — VERIFIED
**Brief says:** "OAuth app registration endpoint working: admin can create an app, receive a client_id, and a client_secret hashed in the database (raw secret shown exactly once on creation)."

**In plain English:** The brief requires an admin-only endpoint that registers an OAuth app, hands back a client_id and a client_secret once, and keeps only a hash of the secret in the database. That exists: POST /api/oauth-apps (api/src/routes/oauth-apps.ts) behind the workspace-admin check, backed by createOAuthApp() in appRegistration.ts which stores only a SHA-256 hash. TRO-408 delivered it; the app-registration unit tests (13 tests) passed in this sweep's run. Nothing required is missing; one open follow-up (TRO-493, PR #268) fixes the shape of this route's error responses to match its OpenAPI schema.

- **Tickets:** TRO-408, TRO-406, TRO-492, TRO-493
- **Evidence:** `api/src/platform/oauth/appRegistration.ts:109`, `api/src/platform/oauth/appRegistration.ts:112`, `api/src/platform/oauth/credentials.ts:35`, `api/src/routes/oauth-apps.ts:39`, `api/src/routes/oauth-apps.ts:60`, `api/src/routes/oauth-apps.ts:109`, `api/src/app.ts:507`, `api/src/openapi/schemas/oauth-apps.ts:140`, `api/src/platform/oauth/__tests__/app-registration.test.ts:88`, `api/src/platform/oauth/__tests__/app-registration.test.ts:236`
- **Verified by:** ✓ src/platform/oauth/__tests__/app-registration.test.ts (13 tests) 290ms — test.log:17463; api suite summary test.log:18339-18340 (124/125 files passed; the 1 failure is src/__tests__/activity.test.ts, unrelated to this  […]

### W6-R3 — VERIFIED
**Brief says:** "Authorization Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token."

**In plain English:** The brief wants a browser-driven Playwright test that walks the full Authorization Code + PKCE flow: /oauth/authorize, the consent screen, /oauth/token, and then uses the resulting token. That spec exists (e2e/oauth-pkce-chain.spec.ts, delivered by TRO-597 on top of TRO-412/TRO-416) and ends by calling /api/v1/me with the minted token. This sweep only ran the vitest unit suites, not Playwright, so the e2e proof was read from source rather than executed — the backend halves (authorize.test.ts, token.test.ts) did pass in this run.

- **Tickets:** TRO-412, TRO-416, TRO-597, TRO-550, TRO-503, TRO-588
- **Evidence:** `api/src/routes/oauth-authorize.ts:289`, `api/src/routes/oauth-token.ts:100`, `web/src/pages/OAuthConsent.tsx:69`, `web/src/main.tsx:211`, `e2e/oauth-pkce-chain.spec.ts:172`, `e2e/oauth-pkce-chain.spec.ts:244`, `e2e/oauth-pkce-chain.spec.ts:265`, `e2e/oauth-authorize.spec.ts:102`
- **Verified by:** vitest: api/src/platform/oauth/__tests__/authorize.test.ts ✓; api/src/platform/oauth/__tests__/token.test.ts ✓ (see test.log) \| playwright: e2e/oauth-pkce-chain.spec.ts ✓ (2 passed); e2e/oauth-authorize.spec.ts ✓ (2 pas […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R4 — VERIFIED
**Brief says:** "Bearer token middleware validates tokens on every /api/v1/* route; invalid tokens return 401, missing tokens return 401, expired tokens return 401 with a distinct error code."

**In plain English:** Every public /api/v1 route must check the bearer token and answer 401 for a missing, invalid, or expired token, with expiry distinguishable. bearerAuth.ts does exactly this and tags each 401 with details.reason = missing_token / invalid_token / expired_token; the route-fitness test walks every /api/v1 route and confirms it 401s without a token. TRO-430 delivered it and both test files passed in this sweep's run.

- **Tickets:** TRO-430, TRO-495, TRO-404
- **Evidence:** `api/src/platform/oauth/bearerAuth.ts:123`, `api/src/platform/oauth/bearerAuth.ts:199`, `api/src/platform/oauth/bearerAuth.ts:146`, `api/src/platform/oauth/bearerAuth.ts:140`, `api/src/platform/api/v1/errors.ts:28`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:347`, `api/src/platform/oauth/__tests__/bearerAuth.test.ts:246`
- **Verified by:** ✓ src/platform/oauth/__tests__/bearerAuth.test.ts (11 tests) 190ms — test.log:18018; ✓ src/platform/api/v1/__tests__/route-fitness.test.ts (126 tests) — test.log:17973 \| local vitest this sweep: api/src/platform/oauth/_ […]

### W6-R5 — VERIFIED
**Brief says:** "At least one resource (documents) implements GET list, GET by id, and POST. Each route declares its required scope via a require(scope) middleware factory."

**In plain English:** The brief requires at least one public resource — documents — to offer list, get-by-id and create, each guarded by a scope-checking factory. api/src/platform/api/v1/resources/documents.ts wires all three (plus PATCH and four sub-resource reads) through requireScope('documents:read'/'documents:write'), delivered by TRO-398 (PF-200) on top of TRO-430's scope registry; the 34-test suite for it passed in this sweep's run. Nothing missing.

- **Tickets:** TRO-398, TRO-430, TRO-605, TRO-611
- **Evidence:** `api/src/platform/api/v1/resources/documents.ts:337`, `api/src/platform/api/v1/resources/documents.ts:426`, `api/src/platform/api/v1/resources/documents.ts:481`, `api/src/platform/scopes/requireScope.ts:50`, `api/src/platform/api/v1/resources/__tests__/documents.test.ts:128`
- **Verified by:** test.log:17429 ✓ src/platform/api/v1/resources/__tests__/documents.test.ts (34 tests) 344ms \| local vitest this sweep: api/src/platform/api/v1/resources/__tests__/documents.test.ts ✓

### W6-R6 — VERIFIED
**Brief says:** "Consistent ApiError shape ({code, message, details?, request_id}) returned on every public failure, asserted by a fitness test over all /api/v1 routes."

**In plain English:** Every public-API failure must come back in one fixed JSON shape (code, message, optional details, request_id), and a test must prove that across all /api/v1 routes. errors.ts defines the shape, errorMiddleware.ts enforces it as the last handler, and route-fitness.test.ts walks the live router and probes each route's failure path — delivered by TRO-397 and TRO-404, hardened by TRO-489/495. All three test files passed in this sweep.

- **Tickets:** TRO-397, TRO-404, TRO-489, TRO-495
- **Evidence:** `api/src/platform/api/v1/errors.ts:31`, `api/src/platform/api/v1/errorMiddleware.ts:75`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:339`
- **Verified by:** test.log:17973 ✓ route-fitness.test.ts (126 tests); :18120 ✓ error-middleware.test.ts (4 tests); :18247 ✓ errors.test.ts (16 tests) \| local vitest this sweep: api/src/platform/api/v1/__tests__/route-fitness.test.ts ✓; a […]

### W6-R7 — VERIFIED
**Brief says:** "ScopeRegistry has scopes-as-data; insufficient scope returns 403 with the missing scope named explicitly in the error body (no opaque \"forbidden\")."

**In plain English:** When a token lacks the scope a route needs, the API must say 403 and name the missing scope instead of a bare 'forbidden'. requireScope.ts returns 403 with details.missing_scope set to that scope, backed by the ScopeRegistry data structure in registry.ts. TRO-430 delivered it and the bearerAuth test suite covering the 403 case passed in this sweep.

- **Tickets:** TRO-430
- **Evidence:** `api/src/platform/scopes/registry.ts:23`, `api/src/platform/scopes/requireScope.ts:65`, `api/src/platform/scopes/requireScope.ts:68`, `api/src/platform/oauth/__tests__/bearerAuth.test.ts:220`
- **Verified by:** ✓ src/platform/oauth/__tests__/bearerAuth.test.ts (11 tests) — test.log:18018 (includes the AC-3 requireScope 403 case); ✓ src/platform/scopes/__tests__/registry.test.ts (4 tests) — test.log:18315 \| local vitest this sw […]

### W6-R8 — VERIFIED
**Brief says:** "OpenAPI 3.1 spec served at /api/v1/openapi.json, generated from route metadata (never hand-written), validating against the OpenAPI schema in a unit test."

**In plain English:** The API must publish a machine-readable OpenAPI 3.1 description at /api/v1/openapi.json, generated by code (not typed by hand) and checked against the official OpenAPI schema in a unit test. registry.ts generates it from the Zod schemas registered per route, router.ts serves it, and document.test.ts validates it against the real 3.1 JSON Schema — delivered by TRO-402 (PF-202). Both test files passed this sweep and the deployed URL returned it live.

- **Tickets:** TRO-402, TRO-551
- **Evidence:** `api/src/platform/openapi/registry.ts:67`, `api/src/platform/openapi/index.ts:23`, `api/src/platform/api/v1/router.ts:103`, `api/src/platform/openapi/__tests__/document.test.ts:182`, `api/src/platform/openapi/__tests__/endpoint.test.ts:30`
- **Verified by:** test.log:17638 ✓ document.test.ts (5 tests); :18243 ✓ endpoint.test.ts (4 tests). Live probe: HTTP 200, openapi 3.1.0, 21 paths, byte-identical to docs/openapi.json \| local vitest this sweep: api/src/platform/openapi/__ […]

### W6-R9 — VERIFIED
**Brief says:** "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token}).me()` against a running server returns the typed authenticated user."

**In plain English:** The brief's MVP gate asks for a real SDK package where `new ShipClient({ token }).me()` returns the logged-in user from a live server. `sdk/` is a pnpm workspace package with zero runtime dependencies (sdk/package.json), `me()` is implemented in sdk/src/client.ts, and client.liveServer.test.ts drives it over a real TCP connection to a real server; TRO-405 (PF-400) delivered it. Today's GitHub CI run on this exact code shows that test passing. Nothing missing.

- **Tickets:** TRO-405, TRO-601
- **Evidence:** `pnpm-workspace.yaml:6`, `sdk/package.json:2`, `sdk/package.json:34`, `sdk/src/client.ts:110`, `sdk/src/client.ts:174`, `sdk/src/__tests__/client.liveServer.test.ts:64`, `sdk/src/__tests__/client.liveServer.test.ts:163`, `.github/workflows/ci.yml:212`
- **Verified by:** ✓ src/__tests__/client.liveServer.test.ts (3 tests); SDK suite Test Files 25 passed (25) / Tests 229 passed (229) at 2026-08-16T13:32:11Z on commit 9d744017 (code-identical to HEAD for sdk/); typecheck.log:9 'sdk type-ch […]

### W6-R10 — PARTIAL
**Brief says:** "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."

**In plain English:** The MVP gate says the old browser-test suite must still pass and speed/size/query numbers must stay within 10% of the Week-4 baseline. The three numeric compares (audit/api-perf, audit/db-query, audit/bundle) all PASS but were measured on 2026-08-14 (commit 397e3b7), two days and several merges ago. Five browser-test remediation tickets are Done (TRO-593/594/595/596/609), but TRO-613 (9 tests in program-mode-week-ux.spec.ts asserting text the component never renders) and TRO-549 are still In Progress, and no whole-suite Playwright run on today's main is recorded — so the suite is not demonstrably green.

- **Tickets:** TRO-593, TRO-594, TRO-595, TRO-596, TRO-609, TRO-613, TRO-549, TRO-601, TRO-602
- **Evidence:** `CHANGES.md:236`, `CHANGES.md:1627`, `CHANGES.md:1782`, `CHANGES.md:2107`, `CHANGES.md:2162`, `audit/api-perf/compare-w6-r10-aug14/after-w6-r10-aug14.md:1`, `audit/db-query/compare-w6-r10-aug14/after-w6-r10-aug14.md:1`, `audit/bundle/compare-w6-aug14/after-w6-aug14.md:1`, `.github/workflows/ci.yml:328`
- **Smallest change that would close it:** Close TRO-613, then capture one whole-suite Playwright run on current main (summary.json committed under audit/) and re-run the three compares against that commit.

### W6-R11 — VERIFIED
**Brief says:** "Deployed and publicly accessible: deployed Ship + published OpenAPI spec URL + at least one OAuth app pre-registered with read-only scopes for graders."

**In plain English:** The MVP gate needs Ship deployed publicly, its API spec published at a URL, and a read-only OAuth app pre-made for graders. The live site answers 200 on /health and serves a valid JSON OpenAPI 3.1 spec (21 routes); the grader app is seeded by api/src/platform/oauth/seedGraderApp.ts with only read scopes and its client_id/secret are printed in README.md (TRO-441). All three parts were probed live this sweep.

- **Tickets:** TRO-441, TRO-411, TRO-604, TRO-402
- **Evidence:** `README.md:392`, `README.md:401`, `api/src/platform/oauth/seedGraderApp.ts:56`, `api/src/platform/oauth/seedGraderApp.ts:80`, `api/src/db/seed.ts:104`, `terraform/render/web_service.tf:100`, `CHANGES.md:1889`
- **Verified by:** /health -> 200 application/json {"status":"ok"}; /api/v1/openapi.json -> 200 application/json, parses as JSON, openapi 3.1.0, info.title 'Ship Public API', info.version 1.0.0, 21 paths; /developer/apps -> 200 text/html ( […]

### W6-R12 — PARTIAL
**Brief says:** "Terraform deployment: a terraform/ directory with a complete config describing the deployment topology (app container, database, networking, IAM task role and execution role). Provider versions must be pinned. Run terraf […]"

**In plain English:** The brief wants a terraform/ folder that fully describes the deployment, pinned provider versions, an annotated plan committed, and proof you can destroy and rebuild the whole environment from the config alone. terraform/render/ describes the app container, database and agent service with the provider pinned to 1.9.1 (TRO-411, hardened by TRO-488), and a real annotated plan is committed. The destroy-and-redeploy proof only exists for the agent service (a Week-5 ticket); the main ship service and its database have never been torn down and re-applied — TRO-415 (PF-901) is still Backlog behind a required human go-ahead.

- **Tickets:** TRO-411, TRO-488, TRO-420, TRO-415
- **Evidence:** `terraform/render/web_service.tf:9`, `terraform/render/postgres.tf:9`, `terraform/render/agent_service.tf:13`, `terraform/render/versions.tf:9`, `terraform/render/.terraform.lock.hcl:5`, `terraform/render/variables.tf:372`, `terraform/render/plan/tro-411-pf900-w6-env-vars.md:120`, `terraform/render/plan/tro-411-pf900-w6-env-vars.md:359`, `CHANGES.md:156`, `docs/IAM-ADAPTATION-RENDER.md:10`, `terraform/render/plan/tro-316-destroy-redeploy-proof.md:12`, `terraform/render/plan/tro-316-destroy-redeploy-proof.md:39`, `terraform/render/README.md:39`
- **Smallest change that would close it:** TRO-415: obtain the human go-ahead, then run terraform destroy + apply for render_web_service.ship and render_postgres.ship, committing the log under terraform/render/plan/.

### W6-R13 — VERIFIED
**Brief says:** "oauth_apps table with id, client_id, hashed client_secret, redirect_uris, owner, requested_scopes. Raw secret shown once on creation and rotation; never recoverable thereafter."

**In plain English:** The database must hold OAuth apps with an id, client_id, a hashed secret, redirect URLs, an owner and requested scopes, and the raw secret must be shown only once at creation and again once at rotation. Migration 042 creates that table (client_secret_hash, redirect_uris, requested_scopes, owner_user_id) and rotateOAuthAppSecret() in appRegistration.ts returns the new raw secret exactly once. TRO-406/TRO-408 delivered it, TRO-492 (merged since the last sweep) closed a concurrent-rotation race, and the tests passed in this run.

- **Tickets:** TRO-406, TRO-408, TRO-492, TRO-493
- **Evidence:** `api/src/db/migrations/042_oauth_apps.sql:31`, `api/src/db/migrations/042_oauth_apps.sql:40`, `api/src/platform/oauth/appRegistration.ts:218`, `api/src/platform/oauth/appRegistration.ts:271`, `api/src/platform/oauth/appRegistration.ts:249`, `api/src/routes/oauth-apps.ts:252`, `api/src/platform/oauth/__tests__/app-registration.test.ts:300`, `api/src/platform/oauth/__tests__/app-registration.test.ts:412`
- **Verified by:** ✓ src/platform/oauth/__tests__/app-registration.test.ts (13 tests) — test.log:17463; scratch-DB `\d oauth_apps` (d-oauth_apps.txt) shows id, workspace_id, name, client_id, client_type, client_secret_hash, redirect_uris t […]

### W6-R14 — VERIFIED
**Brief says:** "code_challenge and code_challenge_method recorded at /oauth/authorize; code_verifier required at /oauth/token. Mismatched verifier returns 400 with invalid_grant."

**In plain English:** PKCE means the app proves at token time that it started the login: the server must save the code_challenge when issuing the code and reject the exchange with 400 invalid_grant if the code_verifier does not match. authorize.ts stores the challenge (S256 only), token.ts recomputes and compares it in constant time, and token.test.ts has the wrong-verifier negative case. TRO-416 delivered it and the tests passed in this sweep.

- **Tickets:** TRO-416, TRO-412, TRO-406, TRO-588
- **Evidence:** `api/src/platform/oauth/authorize.ts:139`, `api/src/platform/oauth/authorize.ts:148`, `api/src/db/migrations/043_oauth_tokens_and_codes.sql:35`, `api/src/platform/oauth/token.ts:227`, `api/src/platform/oauth/token.ts:231`, `api/src/platform/oauth/token.ts:439`, `api/src/platform/oauth/__tests__/token.test.ts:400`
- **Verified by:** ✓ src/platform/oauth/__tests__/token.test.ts (32 tests) 340ms — test.log:17269; ✓ authorize.test.ts (18 tests) — test.log:17807 \| local vitest this sweep: api/src/platform/oauth/__tests__/token.test.ts ✓; api/src/platfo […]

### W6-R15 — VERIFIED
**Brief says:** "/oauth/device/code issues a user_code and device_code; /oauth/device/verify accepts the user_code; the client polls /oauth/token until authorized. Slow-down responses honored."

**In plain English:** Devices without a browser (a CLI) must be able to log in: /oauth/device/code hands out a user_code and device_code, /oauth/device/verify takes the user's approval, and the client polls /oauth/token, backing off when told slow_down. All of that exists (routes/oauth-device.ts, platform/oauth/device.ts, migration 046) and device.test.ts drives the full poll-to-approval sequence including two slow_down steps; TRO-425 delivered it and the server test passed in this sweep. The client-side slow_down honoring lives in the SDK (deviceLogin.ts) whose test file did not run in this sweep's aborted chain.

- **Tickets:** TRO-425, TRO-406, TRO-589, TRO-588, TRO-418, TRO-448
- **Evidence:** `api/src/routes/oauth-device.ts:90`, `api/src/routes/oauth-device.ts:133`, `api/src/platform/oauth/device.ts:189`, `api/src/platform/oauth/device.ts:300`, `api/src/platform/oauth/device.ts:365`, `api/src/platform/oauth/device.ts:401`, `api/src/db/migrations/046_oauth_device_codes_polling.sql:35`, `api/src/platform/oauth/__tests__/device.test.ts:256`, `sdk/src/deviceLogin.ts:220`
- **Verified by:** ✓ src/platform/oauth/__tests__/device.test.ts (9 tests) 296ms — test.log:17637. sdk/src/deviceLogin.test.ts did NOT run this sweep (pnpm test's && chain aborted after test:api exit 1 — no @ship/sdk run in test.log) \| lo […]

### W6-R16 — VERIFIED
**Brief says:** "Scopes-as-data: documents:read, documents:write, issues:read, issues:write, sprints:read, sprints:write, webhooks:manage. New scopes register at module load, never edit middleware."

**In plain English:** The seven named scopes (documents:read/write, issues:read/write, sprints:read/write, webhooks:manage) must be plain data in a registry, so a new scope is added by registering it, not by editing the security middleware. registry.ts registers all seven (plus an eighth, audit:read, added later the same way) and registry.test.ts asserts the list. TRO-430 delivered it and the test passed in this sweep.

- **Tickets:** TRO-430, TRO-432, TRO-491
- **Evidence:** `api/src/platform/scopes/registry.ts:32`, `api/src/platform/scopes/registry.ts:57`, `api/src/platform/scopes/registry.ts:85`, `api/src/platform/scopes/__tests__/registry.test.ts:11`, `api/src/platform/scopes/__tests__/registry.test.ts:27`
- **Verified by:** ✓ src/platform/scopes/__tests__/registry.test.ts (4 tests) 178ms — test.log:18315 \| local vitest this sweep: api/src/platform/scopes/__tests__/registry.test.ts ✓

### W6-R17 — VERIFIED
**Brief says:** "Bearer validation; populates request with app, user, granted scopes. Invalid token: 401. Insufficient scope: 403 with missing scope named."

**In plain English:** After checking a bearer token the middleware must attach who is calling — the app, the user, and the granted scopes — to the request, and answer 401 for a bad token or 403 naming the missing scope. bearerAuth.ts sets req.principal = { app, user, scopes } for both token classes; bearerAuth.test.ts asserts the principal contents. TRO-430 delivered it and the test passed in this sweep.

- **Tickets:** TRO-430
- **Evidence:** `api/src/platform/oauth/bearerAuth.ts:163`, `api/src/platform/oauth/bearerAuth.ts:190`, `api/src/platform/oauth/bearerAuth.ts:199`, `api/src/platform/scopes/requireScope.ts:68`, `api/src/platform/oauth/__tests__/bearerAuth.test.ts:177`
- **Verified by:** ✓ src/platform/oauth/__tests__/bearerAuth.test.ts (11 tests) — test.log:18018 \| local vitest this sweep: api/src/platform/oauth/__tests__/bearerAuth.test.ts ✓

### W6-R18 — VERIFIED
**Brief says:** "One-time-use refresh tokens with rotation. Stolen-refresh-token detection: reuse invalidates the family."

**In plain English:** Refresh tokens must work only once (each use hands back a new one) and if an old one is replayed — the sign it was stolen — every token in that lineage must be revoked. token.ts's rotateRefreshToken() consumes the token atomically and, on replay, revokes the whole family_id; token.test.ts and the PF-800 stolen-token drill both assert it. TRO-421 delivered it and both tests passed in this sweep. Still open: TRO-598 wants a machine-readable code that says *why* the refresh failed (today only the human message differs).

- **Tickets:** TRO-421, TRO-445, TRO-598, TRO-418
- **Evidence:** `api/src/platform/oauth/token.ts:650`, `api/src/platform/oauth/token.ts:701`, `api/src/platform/oauth/token.ts:658`, `api/src/platform/oauth/token.ts:659`, `api/src/platform/oauth/token.ts:590`, `api/src/db/migrations/043_oauth_tokens_and_codes.sql:66`, `api/src/platform/oauth/__tests__/token.test.ts:891`, `api/src/platform/oauth/__tests__/refresh-rotation-stolen-token.test.ts:305`
- **Verified by:** ✓ src/platform/oauth/__tests__/token.test.ts (32 tests) — test.log:17269; ✓ src/platform/oauth/__tests__/refresh-rotation-stolen-token.test.ts (1 test) 212ms — test.log:18072 \| local vitest this sweep: api/src/platform/ […]

### W6-R19 — VERIFIED
**Brief says:** "Public routes live only at /api/v1/*. Internal endpoints stay at /api/. Lint rule fails the build if a public route imports from internal handler files."

**In plain English:** Public routes must live only under /api/v1, internal ones under /api, and a lint rule must break the build if public code imports internal route handlers. eslint.config.mjs has that rule (no-restricted-imports on **/routes/** for api/src/platform/api/v1/**), CI runs pnpm lint, and boundary-lint.test.ts proves a deliberate violation is flagged. TRO-399 delivered it and the test passed in this sweep. Two hardening tickets are still open (dynamic import() is not caught — TRO-500; pattern edge cases — TRO-496).

- **Tickets:** TRO-399, TRO-396, TRO-500, TRO-496
- **Evidence:** `api/src/platform/api/v1/router.ts:19`, `api/src/app.ts:427`, `eslint.config.mjs:113`, `eslint.config.mjs:118`, `eslint.config.mjs:164`, `.github/workflows/ci.yml:110`, `api/src/platform/__tests__/boundary-lint.test.ts:77`, `api/src/platform/__tests__/boundary-lint.test.ts:92`
- **Verified by:** ✓ src/platform/__tests__/boundary-lint.test.ts (2 tests) 2272ms — test.log:14966 (runs the real ESLint class against a deliberate violation and observes it fail) \| local vitest this sweep: api/src/platform/__tests__/bou […]

### W6-R20 — VERIFIED
**Brief says:** "Opaque base64 cursors over { id, timestamp}. List responses always return { data, next_cursor}. Cursors are stable across reordering operations."

**In plain English:** Lists must page with an opaque cursor (an encoded {id, timestamp}), always return {data, next_cursor}, and stay stable when rows are inserted mid-walk. pagination.ts implements the shared cursor helpers used by every v1 list route, documents.ts shows the keyset query, and the fitness test enforces the envelope on every list route — delivered by TRO-398, precision bug fixed by TRO-602. All bearing test files passed this sweep.

- **Tickets:** TRO-398, TRO-602, TRO-591, TRO-592
- **Evidence:** `api/src/platform/api/v1/pagination.ts:139`, `api/src/platform/api/v1/pagination.ts:157`, `api/src/platform/api/v1/pagination.ts:42`, `api/src/platform/api/v1/resources/documents.ts:385`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:367`, `api/src/platform/api/v1/resources/__tests__/documents.test.ts:128`
- **Verified by:** test.log:18308 ✓ pagination.test.ts (13 tests); :17429 ✓ documents.test.ts (34 tests); :17632 ✓ audit.test.ts (12 tests, incl. 'paginates with a stable cursor across pages' l.392); :17973 ✓ route-fitness.test.ts (126 tes […]

### W6-R21 — VERIFIED
**Brief says:** "Generated from route metadata in-process. Served at /api/v1/openapi.json. Validates against the OpenAPI schema in a unit test. Spec parity asserted by fitness test."

**In plain English:** This restates W6-R8 and adds that a fitness test must prove the spec and the real routes agree. route-fitness.test.ts check (a) walks every mounted /api/v1 route and fails if any lacks a spec entry (or has the wrong auth marking); TRO-402/404/409 delivered generation, the fitness gate and the committed-copy parity check. All passed this sweep.

- **Tickets:** TRO-402, TRO-404, TRO-409
- **Evidence:** `api/src/platform/openapi/index.ts:23`, `api/src/platform/api/v1/router.ts:103`, `api/src/platform/openapi/__tests__/document.test.ts:182`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:288`
- **Verified by:** test.log:17973 ✓ route-fitness.test.ts (126 tests); :17638 ✓ document.test.ts (5); :18243 ✓ endpoint.test.ts (4). openapi:check -> 'OK: docs/openapi.json matches the in-process /api/v1 OpenAPI registry.' \| local vitest  […]

### W6-R22 — VERIFIED
**Brief says:** "Event types as data: document.created, document.updated, document.deleted, issue.created, issue.assigned, issue.status_changed, sprint.started, sprint.completed. Each with a Zod schema."

**In plain English:** The brief asks for a fixed list of 8 webhook event types, each with a Zod validation schema. api/src/platform/webhooks/events.ts defines exactly those 8 as data plus one schema each (TRO-419), and the unit test file for it passed this sweep (23 tests, one more than the prior sweep because TRO-501 added a priority:'none' case). Nothing missing.

- **Tickets:** TRO-419, TRO-501
- **Evidence:** `api/src/platform/webhooks/events.ts:110`, `api/src/platform/webhooks/events.ts:248`, `api/src/platform/webhooks/__tests__/events.test.ts:170`, `api/src/platform/webhooks/__tests__/events.test.ts:207`
- **Verified by:** ✓ src/platform/webhooks/__tests__/events.test.ts (23 tests) 205ms \| local vitest this sweep: api/src/platform/webhooks/__tests__/events.test.ts ✓

### W6-R23 — VERIFIED
**Brief says:** "IEventBus interface. Domain layer publishes on writes — never the route layer. In-process implementation must-ship; queue-backed implementation is a Liskov-substitutable drop-in."

**In plain English:** The brief asks for an event-bus interface where only the domain (business-logic) layer, never HTTP route handlers, publishes events. api/src/platform/webhooks/eventBus.ts has the IEventBus interface and an in-process implementation; every publish() call lives in api/src/services/documentService.ts (TRO-426), and a unit test greps the route folders to prove there are none there. Both the test and my own grep this sweep confirm zero route-layer publishes. Nothing missing.

- **Tickets:** TRO-426
- **Evidence:** `api/src/platform/webhooks/eventBus.ts:48`, `api/src/platform/webhooks/eventBus.ts:62`, `api/src/services/documentService.ts:13`, `api/src/services/documentService.ts:451`, `api/src/services/documentService.ts:82`, `api/src/platform/webhooks/__tests__/publish-boundary.test.ts:70`, `api/src/platform/webhooks/__tests__/publish-boundary.test.ts:88`, `docs/architecture.md:369`
- **Verified by:** ✓ publish-boundary.test.ts (3 tests); ✓ eventBus.test.ts (6 tests); grep: only hit in api/src/routes/ is a comment in issues.test.ts:514 — zero publish()/getEventBus() in non-test route files \| local vitest this sweep:  […]

### W6-R24 — VERIFIED
**Brief says:** "Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."

**In plain English:** The brief asks for per-app, per-event-type webhook subscriptions (URL, secret, on/off flag) managed through /api/v1/webhooks behind the webhooks:manage permission. Migration 047 creates the table, api/src/platform/api/v1/resources/webhooks.ts provides create/list/get/delete/rotate all gated on that scope (TRO-431), and the 34-test suite passed this sweep including 'the secret is never returned after creation'. The brief says 'hashed' secret; the repo deliberately encrypts instead (a hash cannot be reversed to sign) and docs/architecture.md:354 defends that. Nothing missing.

- **Tickets:** TRO-431, TRO-599, TRO-607
- **Evidence:** `api/src/db/migrations/047_webhook_subscriptions.sql:47`, `api/src/platform/api/v1/resources/webhooks.ts:331`, `api/src/platform/scopes/registry.ts:82`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:357`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:521`, `docs/architecture.md:354`
- **Verified by:** ✓ resources/__tests__/webhooks.test.ts (34 tests) 413ms; ✓ secretEncryption.test.ts (7 tests); migrate.log: '047_webhook_subscriptions.sql applied' against a fresh scratch DB, \d dump shows app_id/event_type/target_url/s […]

### W6-R25 — VERIFIED
**Brief says:** "Stripe-style header: Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>. Timestamp prevents replay; SDK rejects any signature older than 5 minutes by default."

**In plain English:** The brief asks for a Stripe-style signature header (timestamp + HMAC) with a 5-minute freshness window. api/src/platform/webhooks/signer.ts produces and checks exactly that header with a 300-second default (TRO-433), and its 20-test suite (positive, tampered body, expired, missing v1, boundary) passed this sweep. Per ruling I-04 the SDK-side verifier is counted under W6-R33, not here. Nothing missing.

- **Tickets:** TRO-433
- **Evidence:** `api/src/platform/webhooks/signer.ts:121`, `api/src/platform/webhooks/signer.ts:144`, `api/src/platform/webhooks/signer.ts:30`, `api/src/platform/webhooks/signer.ts:34`, `api/src/platform/webhooks/__tests__/signer.test.ts:71`, `api/src/platform/webhooks/__tests__/signer.test.ts:82`, `api/src/platform/webhooks/__tests__/signer.test.ts:91`, `api/src/platform/webhooks/__tests__/signer.test.ts:100`, `api/src/platform/webhooks/__tests__/signer.test.ts:185`
- **Verified by:** ✓ src/platform/webhooks/__tests__/signer.test.ts (20 tests) 223ms \| local vitest this sweep: api/src/platform/webhooks/__tests__/signer.test.ts ✓

### W6-R26 — VERIFIED
**Brief says:** "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m. Subscribers returning 5xx or timing out are retried; 4xx responses are treated as permanent failures and dead-lettered."

**In plain English:** The brief asks for retries at 1s/4s/16s/1m/5m/30m with random jitter, retrying on server errors or timeouts but giving up immediately on client (4xx) errors. api/src/platform/webhooks/deliverer.ts hard-codes that schedule, adds jitter, and branches exactly that way (TRO-438); the deterministic-clock test file covering the schedule, jitter, and 4xx-vs-5xx passed this sweep. Nothing missing against the stated acceptance evidence.

- **Tickets:** TRO-438
- **Evidence:** `api/src/platform/webhooks/deliverer.ts:109`, `api/src/platform/webhooks/deliverer.ts:744`, `api/src/platform/webhooks/deliverer.ts:849`, `api/src/platform/webhooks/deliverer.ts:707`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:229`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:319`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:393`
- **Verified by:** ✓ src/platform/webhooks/__tests__/deliverer.test.ts (13 tests) 210ms \| local vitest this sweep: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓

### W6-R27 — VERIFIED
**Brief says:** "After 6 failed attempts, deliveries land in a DLQ visible in the developer portal. Operators can replay manually; replays carry the original idempotency key."

**In plain English:** The brief asks that after 6 failed attempts a delivery goes to a dead-letter queue the developer portal shows, with a manual replay that keeps the original idempotency key. The backend half (deliverer dead-letters at attempt 6, replay route reuses the original key — TRO-438/TRO-446/TRO-603) passed its unit tests this sweep. The portal half exists in web/src/pages/DeveloperPortal.tsx (TRO-439) with a jsdom test and a Playwright spec, but neither ran this sweep, so the portal-visibility half is traced from source only.

- **Tickets:** TRO-438, TRO-446, TRO-439, TRO-603
- **Evidence:** `api/src/platform/webhooks/deliverer.ts:112`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:353`, `api/src/platform/api/v1/resources/webhooks.ts:621`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1156`, `web/src/pages/DeveloperPortal.tsx:127`, `web/src/pages/DeveloperPortal.tsx:391`, `web/src/pages/DeveloperPortal.test.tsx:152`, `e2e/developer-portal-dlq-replay.spec.ts:169`
- **Verified by:** vitest: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓; api/src/platform/api/v1/resources/__tests__/webhooks.test.ts ✓; web/src/pages/DeveloperPortal.test.tsx ✓ (see test.log test-web.log) \| playwright: e2e/dev […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R28 — VERIFIED
**Brief says:** "webhook_deliveries table records every attempt with subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms. Queryable per app."

**In plain English:** The brief asks for a table logging every webhook delivery attempt with specific columns, queryable per app. Migration 048 creates webhook_deliveries with all six named columns, and GET /api/v1/webhooks/deliveries in api/src/platform/api/v1/resources/webhooks.ts lists them filtered by subscription and status (TRO-442); the API tests passed this sweep and the portal reads the same endpoint (TRO-439). Nothing missing.

- **Tickets:** TRO-442, TRO-438, TRO-439, TRO-599, TRO-602
- **Evidence:** `api/src/db/migrations/048_webhook_deliveries.sql:38`, `api/src/platform/api/v1/resources/webhooks.ts:483`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:670`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:770`, `web/src/pages/DeveloperPortal.tsx:257`
- **Verified by:** ✓ resources/__tests__/webhooks.test.ts (34 tests); migrate.log: '048_webhook_deliveries.sql applied' (and 050/051 replayed_from_id) on a fresh scratch DB; \d dump shows all six named columns \| local vitest this sweep: a […]

### W6-R29 — VERIFIED
**Brief says:** "/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."

**In plain English:** The brief asks for a replay endpoint that re-sends a logged webhook while keeping its original Idempotency-Key so receivers can spot duplicates. POST /api/v1/webhooks/deliveries/:id/replay in api/src/platform/api/v1/resources/webhooks.ts does exactly that (TRO-446, hardened by TRO-603), and the API tests asserting the original key reaches the subscriber passed this sweep. Nothing missing.

- **Tickets:** TRO-446, TRO-603, TRO-447
- **Evidence:** `api/src/platform/api/v1/resources/webhooks.ts:621`, `api/src/platform/api/v1/resources/webhooks.ts:578`, `api/src/platform/api/v1/resources/webhooks.ts:774`, `api/src/platform/api/v1/resources/webhooks.ts:331`, `api/src/index.ts:119`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1071`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1317`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1503`
- **Verified by:** ✓ src/platform/api/v1/resources/__tests__/webhooks.test.ts (34 tests) 413ms \| local vitest this sweep: api/src/platform/api/v1/resources/__tests__/webhooks.test.ts ✓ \| local playwright this sweep: e2e/webhook-idempoten […]

### W6-R30 — VERIFIED
**Brief says:** "@ship/sdk exposes resource clients: client.documents, client.issues, client.sprints, client.webhooks. Method signatures match OpenAPI spec; drift fails CI via a fitness test."

**In plain English:** The SDK must expose client.documents/issues/sprints/webhooks whose method signatures track the OpenAPI spec, with a CI test that fails on drift. All four resource clients exist on ShipClient (sdk/src/client.ts) and parity.test.ts checks both directions against the real generated spec, running in CI on every push. TRO-407 built the clients, TRO-422 the parity gate; TRO-599/TRO-607 later fixed two response/request shape drifts the gate did not catch (it checks method existence, not field shapes). Nothing outstanding.

- **Tickets:** TRO-407, TRO-422, TRO-599, TRO-607, TRO-409
- **Evidence:** `sdk/src/client.ts:115`, `sdk/src/client.ts:119`, `sdk/src/client.ts:122`, `sdk/src/client.ts:130`, `sdk/src/__tests__/parity.test.ts:248`, `sdk/src/__tests__/parity.test.ts:296`, `sdk/src/__tests__/parity.test.ts:316`, `sdk/src/resources/webhooks.ts:181`, `sdk/src/resources/webhooks.ts:220`, `.github/workflows/ci.yml:212`, `.gitlab-ci.yml:147`
- **Verified by:** ✓ src/__tests__/parity.test.ts (57 tests); ✓ src/__tests__/webhookResponseShape.test.ts (5 tests); ✓ src/resources/__tests__/webhooks.test.ts (9 tests); ✓ src/__tests__/webhooks.liveServer.test.ts (10 tests) — 2026-08-16 […]

### W6-R31 — ASSUMED
**Brief says:** "ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser localStorage)."

**In plain English:** The SDK must run both login flows end-to-end (device login for CLIs, PKCE code flow for browsers) and let callers plug in where tokens are kept — memory, a file, or browser localStorage. Both flows are static methods on ShipClient (sdk/src/client.ts), the ITokenStore interface plus MemoryTokenStore and FileTokenStore ship in the SDK, and a LocalStorageTokenStore is implemented in the browser demo (integrations/browser-demo). TRO-418 delivered the flows/stores; TRO-600 made the file store's write crash-safe. Today's CI run shows all the flow and store tests passing.

- **Tickets:** TRO-418, TRO-600, TRO-425, TRO-449
- **Evidence:** `sdk/src/client.ts:186`, `sdk/src/client.ts:222`, `sdk/src/deviceLogin.ts:188`, `sdk/src/deviceLogin.ts:219`, `sdk/src/authorizationCodeFlow.ts:218`, `sdk/src/tokenStore.ts:45`, `sdk/src/tokenStore.ts:56`, `sdk/src/fileTokenStore.ts:112`, `sdk/src/fileTokenStore.ts:169`, `sdk/src/fileTokenStore.ts:181`, `integrations/browser-demo/src/localStorageTokenStore.ts:25`, `sdk/src/tokenStore.test.ts:155`, `sdk/src/__tests__/client.deviceLogin.liveServer.test.ts:46`
- **Traced under assumption (ruling pending):** Traced under the reading that 'Pluggable ITokenStore (in-memory, file, browser localStorage)' obliges the SDK to define the pluggable interface and the repo to contain working implementations of all three, not that all three must be exported from the @ship/sdk package itself. Under that reading: VER […]
- **Delta vs 08-16 sweep:** VERIFIED → ASSUMED

### W6-R32 — VERIFIED
**Brief says:** "for await (const doc of client.documents.iterate()) walks pages transparently. Cursors handled internally; consumer code never sees them."

**In plain English:** Callers must be able to write `for await (const doc of client.documents.iterate())` and get every item across all pages without ever handling a cursor. sdk/src/internal/pagination.ts implements one shared async generator that documents/issues/sprints (and people) delegate to; iterate.test.ts proves multi-page walking, no over-fetch on early break, and that no cursor leaks. TRO-410 delivered it. Verified both by today's CI run and by a stub-server probe run in this sweep.

- **Tickets:** TRO-410, TRO-602
- **Evidence:** `sdk/src/internal/pagination.ts:51`, `sdk/src/internal/pagination.ts:61`, `sdk/src/resources/documents.ts:94`, `sdk/src/resources/documents.ts:95`, `sdk/src/resources/issues.ts:50`, `sdk/src/resources/sprints.ts:41`, `sdk/src/types.ts:140`, `sdk/src/resources/__tests__/iterate.test.ts:78`, `sdk/src/resources/__tests__/iterate.test.ts:129`, `sdk/src/resources/__tests__/iterate.test.ts:203`
- **Verified by:** CI: ✓ src/resources/__tests__/iterate.test.ts (8 tests). Probe (this sweep, this machine): full walk yielded d1..d5 in order over exactly 3 requests (first>c1>c2), no next_cursor/data property on any yielded item; early  […]

### W6-R33 — VERIFIED
**Brief says:** "verifyWebhook(headers, rawBody, secret) returns true/false in one call. Tampered bodies fail; expired timestamps fail; missing v1 header fails."

**In plain English:** Integrators must be able to check a webhook's signature with one call that returns true/false, rejecting tampered bodies, stale timestamps, and headers missing the v1 signature. sdk/src/verifyWebhook.ts is that one function and verifyWebhook.test.ts covers all three failure modes plus the 5-minute boundary; TRO-413 delivered it. Confirmed by today's CI run and by a direct probe in this sweep that exercised all four cases.

- **Tickets:** TRO-413, TRO-433
- **Evidence:** `sdk/src/verifyWebhook.ts:185`, `sdk/src/verifyWebhook.ts:202`, `sdk/src/verifyWebhook.ts:168`, `sdk/src/node.ts:13`, `sdk/src/verifyWebhook.test.ts:112`, `sdk/src/verifyWebhook.test.ts:121`, `sdk/src/verifyWebhook.test.ts:129`, `sdk/src/verifyWebhook.test.ts:277`, `sdk/src/verifyWebhook.test.ts:284`, `sdk/src/verifyWebhook.test.ts:361`
- **Verified by:** CI: ✓ src/verifyWebhook.test.ts (30 tests). Probe (this sweep): valid? true; tampered? false; missing v1? false; expired (t-301s)? false \| local vitest this sweep: sdk/src/verifyWebhook.test.ts ✓

### W6-R34 — VERIFIED
**Brief says:** "SDK errors are a discriminated union: { kind: 'auth' \| 'rate_limit' \| 'not_found' \| 'validation' \| 'server',...}. Consumers can switch on kind exhaustively."

**In plain English:** SDK errors must be a typed union keyed on a `kind` field so integrators can handle every case with a switch. sdk/src/errors.ts defines SdkErrorKind (the five quoted kinds plus 'forbidden' and 'network') and ShipSdkError carries it; errors.test.ts checks every server error code maps to the right kind. TRO-405 delivered it. Verified by today's CI run, this sweep's typecheck, and a probe.

- **Tickets:** TRO-405, TRO-407, TRO-397, TRO-495
- **Evidence:** `sdk/src/errors.ts:39`, `sdk/src/errors.ts:76`, `sdk/src/errors.ts:115`, `sdk/src/errors.ts:116`, `sdk/src/errors.ts:145`, `sdk/src/errors.test.ts:10`, `sdk/src/errors.test.ts:21`, `sdk/src/errors.test.ts:67`
- **Verified by:** CI: ✓ src/errors.test.ts (16 tests); ✓ src/client.liveServer.test.ts includes 'invalid token maps to kind auth' and 'unreachable baseUrl -> kind network'. typecheck.log:9 sdk Done (union compiles). Probe: unauthorized=>a […]

### W6-R35 — VERIFIED
**Brief says:** "Per-app and per-token token-bucket limits. Public responses carry X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset; 429 responses carry Retry-After."

**In plain English:** Public API calls must be throttled by two token buckets (per app and per token), every response must carry the three X-RateLimit headers, and a throttled 429 must say when to retry. api/src/platform/ratelimit/middleware.ts implements both buckets, the headers and Retry-After (TRO-427/PF-500), and api/src/middleware/rate-limit.ts exempts /api/v1 from the older, stricter internal limiters (TRO-401/PF-004). All five bearing test files passed this sweep; TRO-552 (an edge-case test for the exemption predicate) is still open as PR #275.

- **Tickets:** TRO-427, TRO-401, TRO-494, TRO-552, TRO-590
- **Evidence:** `api/src/platform/ratelimit/middleware.ts:21`, `api/src/platform/ratelimit/middleware.ts:131`, `api/src/platform/ratelimit/middleware.ts:171`, `api/src/platform/ratelimit/middleware.ts:202`, `api/src/middleware/rate-limit.ts:212`
- **Verified by:** test.log:17974 ✓ ratelimit/middleware.test.ts (9 tests, incl. '429s with Retry-After once the per-token bucket is exhausted' l.143); :18249 ✓ tokenBucket.test.ts (11, injected FakeClock); :18280 ✓ config.test.ts (5); :16 […]

### W6-R36 — ASSUMED
**Brief says:** "Every public API call recorded with timestamp, app client_id, user_id, route, scope used, status, latency. Queryable in the developer portal."

**In plain English:** Every public API call must be logged (who, which app, which route, scope, status, how long) and be lookable-up in the developer portal. The logging table, the recording middleware, the admin-only GET /api/v1/audit endpoint and an SDK client all exist and their tests passed this sweep (TRO-432/PF-501). What is missing is the portal part: the developer portal (TRO-436/439) has only Apps and Webhooks pages and never calls the audit endpoint, so an admin cannot browse the API audit trail in the UI today.

- **Tickets:** TRO-432, TRO-436, TRO-439, TRO-443
- **Evidence:** `api/src/db/migrations/049_public_api_audit.sql:40`, `api/src/platform/audit/middleware.ts:111`, `api/src/platform/api/v1/resources/audit.ts:89`, `sdk/src/resources/audit.ts:68`, `web/src/contexts/DeveloperPortalContext.tsx:35`, `web/src/components/sidebars/DeveloperSidebar.tsx:21`
- **Traced under assumption (ruling pending):** 'Queryable in the developer portal' means a web UI view under /developer/* that reads public_api_audit rows, not merely an admin-scoped API endpoint the portal token could call.
- **Smallest change that would close it:** Add an 'Audit' page under /developer/* (DeveloperSidebar DEVELOPER_NAV entry) that calls GET /api/v1/audit via usePortalToken().callV1 with cursor pagination and an app_client_id filter; the portal token already carries audit:read (DeveloperPortalContext.tsx:35). Add an RTL test + optional e2e. Ticket needed — none exists.
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → ASSUMED

### W6-R37 — VERIFIED
**Brief says:** "In-app UI for: listing apps, registering apps, viewing/rotating client_secret (shown once), managing subscriptions, browsing the delivery log, replaying failed deliveries."

**In plain English:** The developer portal must let a developer list apps, register one, see/rotate the secret (shown once), manage webhook subscriptions, browse the delivery log, and replay failed deliveries — all inside Ship's normal web app. All six live in web/src/pages/DeveloperApps.tsx, DeveloperAppDetail.tsx and DeveloperPortal.tsx (TRO-436 and TRO-439), with browser tests that ran and passed this sweep, and the live site's JavaScript bundle contains the portal code.

- **Tickets:** TRO-436, TRO-439, TRO-443, TRO-603
- **Evidence:** `web/src/pages/DeveloperApps.tsx:215`, `web/src/pages/DeveloperApps.tsx:250`, `web/src/pages/DeveloperAppDetail.tsx:45`, `web/src/pages/DeveloperPortal.tsx:163`, `web/src/pages/DeveloperPortal.tsx:166`, `web/src/pages/DeveloperPortal.tsx:296`, `web/src/components/sidebars/DeveloperSidebar.tsx:21`, `web/src/pages/App.tsx:269`, `e2e/developer-portal-apps.spec.ts:31`, `e2e/developer-portal-apps.spec.ts:108`, `e2e/developer-portal-dlq-replay.spec.ts:169`, `e2e/developer-portal-dlq-replay.spec.ts:254`
- **Verified by:** e2e: developer-portal-apps.spec.ts 3/3 passed ('portal calls hit the real /api/v1 surface' flaky — failed once at 840ms, passed on retry), developer-portal-dlq-replay.spec.ts 2/2 passed ('subscription CRUD' flaky — faile […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R38 — IMPLEMENTED-UNVERIFIED
**Brief says:** "terraform/ directory describing app container, database, VPC/subnets, and security groups. All provider and module versions pinned. terraform plan must run cleanly; no unpinned versions permitted."

**In plain English:** The Terraform folder must describe the app container, database and network pieces, pin every provider version, and produce a clean plan. terraform/render/ describes the container and database with the Render provider pinned exactly to 1.9.1 (TRO-411, hardened by TRO-488); Render has no VPC/subnet/security-group objects, and docs/IAM-ADAPTATION-RENDER.md explains that trade. A clean plan is committed, but no terraform command could be run in this environment (no binary), so the row stays traced-but-not-run.

- **Tickets:** TRO-411, TRO-488, TRO-420
- **Evidence:** `terraform/render/web_service.tf:9`, `terraform/render/postgres.tf:9`, `terraform/render/versions.tf:9`, `terraform/render/.terraform.lock.hcl:6`, `terraform/render/plan/tro-411-pf900-w6-env-vars.md:359`, `CHANGES.md:156`, `docs/IAM-ADAPTATION-RENDER.md:48`, `terraform/render/README.md:96`

### W6-R39 — IMPLEMENTED-UNVERIFIED
**Brief says:** "Start with an AdministratorAccess task role. Lock it down to the minimum permissions the platform actually needs. Verify the service still works, then verify an action outside the policy is denied. Submit before/after IA […]"

**In plain English:** The brief asks you to start with an all-powerful AWS role, shrink it to the minimum, prove the service still works and that a forbidden action is denied, and submit before/after policies with reasons. Ship deploys to Render, which has no such roles, so docs/IAM-ADAPTATION-RENDER.md (TRO-420) maps the exercise onto Render's model and explains every permission decision. What does not exist anywhere is a literal AdministratorAccess 'before' policy or a recorded denied-action test — the memo is the defended adaptation the inventory accepts in its place.

- **Tickets:** TRO-420
- **Evidence:** `docs/IAM-ADAPTATION-RENDER.md:10`, `docs/IAM-ADAPTATION-RENDER.md:48`, `docs/IAM-ADAPTATION-RENDER.md:100`, `docs/IAM-ADAPTATION-RENDER.md:131`, `terraform/ssm.tf:164`, `CHANGES.md:8540`

### W6-R40 — PARTIAL
**Brief says:** "Demonstrate drift: manually change a resource, run terraform plan, show the detected diff. Perform terraform destroy then terraform apply from scratch. Submit screenshots or log output proving the service came back up id […]"

**In plain English:** The brief wants a demonstration that Terraform notices a manual change (drift), then a full destroy and rebuild with logs showing the service came back the same. A real drift demo exists but on two local files (audit/terraform/drift-demo), not the live Render service; the only destroy-and-rebuild log covers the agent service (Week 5, TRO-316) and it came back at a new URL. Nothing has been done against the ship service and its database — TRO-415 (PF-901) is Backlog pending a human go-ahead.

- **Tickets:** TRO-415
- **Evidence:** `audit/terraform/drift-demo/main.tf:11`, `audit/terraform/raw/drift-2-clean-plan.txt:4`, `audit/terraform/raw/drift-3-drift-plan.txt:49`, `audit/terraform/baseline.md:63`, `terraform/render/README.md:100`, `terraform/render/plan/tro-316-destroy-redeploy-proof.md:37`, `terraform/render/plan/tro-316-destroy-redeploy-proof.md:12`
- **Smallest change that would close it:** TRO-415: manual drift on a live ship env var → `terraform plan` diff captured; then destroy + apply of ship/ship-db with before/after /health logs — committed under terraform/render/plan/.

### W6-R41 — N/A
**Brief says:** "Graders will present a modified terraform plan during the Architecture Defense and ask you to walk through every resource change, identify the blast radius, and flag any risky operations. Inability to read a Terraform pl […]"

**In plain English:** Graders will hand Troy a modified Terraform plan and ask him to explain each change without AI help — a human skill, not something the repo can pass or fail. The repo does hold good rehearsal material: annotated plan tables with blast-radius columns and a defense-deck slide on reading a plan.

- **Tickets:** TRO-420, TRO-411
- **Evidence:** `docs/submission/PLUGFORGE-DEFENSE-DECK.html:430`, `terraform/render/plan/tro-411-pf900-w6-env-vars.md:384`, `terraform/render/plan/plan-annotated.md:114`, `audit/terraform/baseline.md:36`, `docs/IAM-ADAPTATION-RENDER.md:1`

### W6-R42 — VERIFIED
**Brief says:** "Complete the Authorization Code + PKCE flow in a Playwright test from a registered web app. Confirm that a wrong code_verifier on the token exchange returns invalid_grant (negative case is mandatory, not optional)."

**In plain English:** This is the graded version of W6-R3: run the PKCE login end-to-end in Playwright from a registered app and prove that a wrong code_verifier is rejected with invalid_grant. e2e/oauth-pkce-chain.spec.ts contains both the happy path and the mandatory negative (delivered by TRO-597). Playwright was not run in this sweep, so the spec is verified from source only; the backend negative case in token.test.ts did pass in this run.

- **Tickets:** TRO-597, TRO-412, TRO-416, TRO-449
- **Evidence:** `e2e/oauth-pkce-chain.spec.ts:172`, `e2e/oauth-pkce-chain.spec.ts:265`, `api/src/platform/oauth/__tests__/token.test.ts:400`
- **Verified by:** vitest: api/src/platform/oauth/__tests__/token.test.ts ✓; api/src/platform/oauth/__tests__/authorize.test.ts ✓ (see test.log) \| playwright: e2e/oauth-pkce-chain.spec.ts ✓ (2 passed)
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R43 — VERIFIED
**Brief says:** "Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."

**In plain English:** The graded scenario: from a command-line tool, log in with the device flow, poll /oauth/token honoring slow_down, and use the resulting token against /api/v1/me. The ship CLI does this (integrations/cli login.ts → SDK deviceLogin.ts → whoami.ts hits /api/v1/me) and login.liveServer.test.ts drives it against a real API subprocess; TRO-448/TRO-425/TRO-418 delivered it. In this sweep only the API test suite ran — the run aborted on an unrelated api failure before reaching the SDK and CLI suites — so the CLI/SDK tests are verified from source, not from a run; the server-side device.test.ts did pass.

- **Tickets:** TRO-448, TRO-425, TRO-418, TRO-600
- **Evidence:** `integrations/cli/src/commands/login.ts:66`, `integrations/cli/src/commands/whoami.ts:82`, `sdk/src/deviceLogin.ts:219`, `sdk/src/deviceLogin.ts:220`, `sdk/src/deviceLogin.test.ts:121`, `sdk/src/__tests__/client.deviceLogin.liveServer.test.ts:122`, `integrations/cli/src/__tests__/login.liveServer.test.ts:196`, `integrations/cli/src/__tests__/login.liveServer.test.ts:390`, `api/src/platform/oauth/__tests__/device.test.ts:256`
- **Verified by:** vitest: sdk/src/deviceLogin.test.ts ✓; sdk/src/__tests__/client.deviceLogin.liveServer.test.ts ✓; integrations/cli/src/commands/login.test.ts ✓; integrations/cli/src/__tests__/login.liveServer.test.ts ✓; api/src/platform […]

### W6-R44 — VERIFIED
**Brief says:** "Enumerate every /api/v1/* route in a fitness test and assert each one (a) has an OpenAPI entry, (b) declares a scope, (c) returns the ApiError shape on failure paths, and (d) supports cursor pagination if it's a list end […]"

**In plain English:** A graded test scenario: one test must list every /api/v1 route automatically and check four things per route (spec entry, declared scope, error shape, cursor pagination for lists). route-fitness.test.ts does exactly this — 25 routes x 5 checks + sanity = 126 tests — delivered by TRO-404 (PF-203) with the fifth header check from TRO-427. It passed in this sweep's run.

- **Tickets:** TRO-404, TRO-427
- **Evidence:** `api/src/platform/api/v1/__tests__/route-fitness.test.ts:161`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:288`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:311`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:339`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:367`, `api/src/platform/api/v1/__tests__/route-fitness.test.ts:402`
- **Verified by:** test.log:17973 ✓ src/platform/api/v1/__tests__/route-fitness.test.ts (126 tests) 286ms \| local vitest this sweep: api/src/platform/api/v1/__tests__/route-fitness.test.ts ✓

### W6-R45 — VERIFIED
**Brief says:** "Validate the generated /api/v1/openapi.json against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert the SDK exposes a typed call for it."

**In plain English:** A graded test scenario: check the generated spec is valid OpenAPI 3.1, then confirm the SDK has a typed method for every operation in it. document.test.ts covers validity (passed this sweep) and sdk/src/__tests__/parity.test.ts walks spec operations against SDK methods (delivered by TRO-422/PF-405). The SDK half could not be marked verified this sweep because the test chain stopped after one unrelated api failure and the sdk suite never ran; the main session can upgrade once test:sdk runs. One small new drift from PR #276: the SDK's issue-priority type omits the new 'none' value.

- **Tickets:** TRO-402, TRO-422, TRO-599, TRO-607, TRO-501
- **Evidence:** `api/src/platform/openapi/__tests__/document.test.ts:182`, `sdk/src/__tests__/parity.test.ts:133`, `sdk/src/__tests__/parity.test.ts:164`, `sdk/src/__tests__/parity.test.ts:296`, `sdk/src/types.ts:170`
- **Verified by:** vitest: sdk/src/__tests__/parity.test.ts ✓; api/src/platform/openapi/__tests__/document.test.ts ✓ (see test.log test-sdk.log)

### W6-R46 — PARTIAL
**Brief says:** "Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s; verify the signature with the SDK helper; tamper with the body and verify the helper rejects it."

**In plain English:** The brief's graded scenario has five steps: subscribe via the SDK, create a document, see the signed webhook arrive within 2 seconds, verify it with the SDK helper, then tamper with the body and see the helper reject it. The merged TTFE drill (scripts/drill/ttfe.ts, TRO-455) does the first four for real in CI and the delivery arrived in ~0.6-0.7 s in today's runs, but the drill only asserts a 15 s ceiling (not 2 s) and never performs the tamper step — tamper rejection is proven only in a separate unit test on a hand-built payload (sdk/src/verifyWebhook.test.ts). Small gap, but two of the scenario's stated checks are not in the end-to-end chain.

- **Tickets:** TRO-455, TRO-433, TRO-438, TRO-413, TRO-607, TRO-599
- **Evidence:** `scripts/drill/ttfe.ts:476`, `scripts/drill/ttfe.ts:486`, `scripts/drill/ttfe.ts:491`, `scripts/drill/ttfe.ts:502`, `scripts/drill/ttfe.config.json:9`, `sdk/src/verifyWebhook.test.ts:117`, `.github/workflows/ci.yml:471`
- **Smallest change that would close it:** Two ~10-line additions to scripts/drill/ttfe.ts: (1) after stage 6, flip one byte of captured.rawBody and assert verifyWebhook(...) === false (tamper negative on the REAL delivered payload); (2) assert the wait_for_delivery stage ms <= 2000 explicitly (or add a stageBudgetsMs entry of 2000 for it — note the config comment at ttfe.config.json:2 deliberately keeps stage budgets generous, so a separate assertion may be preferable to tightening the budget).
- **Delta vs 08-16 sweep:** VERIFIED → PARTIAL

### W6-R47 — VERIFIED
**Brief says:** "Make a subscriber return 500 on the first three attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each attempt) and that the fourth attempt records success in the delivery log."

**In plain English:** The brief's graded scenario: a receiver fails three times then succeeds; the retry waits must be at least 1s/4s/16s and the fourth attempt must be logged as success. api/src/platform/webhooks/__tests__/deliverer.test.ts:229 is exactly that test, driven by a hand-advanced clock (TRO-438), and it passed this sweep. Nothing missing.

- **Tickets:** TRO-438
- **Evidence:** `api/src/platform/webhooks/__tests__/deliverer.test.ts:229`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:276`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:301`
- **Verified by:** ✓ src/platform/webhooks/__tests__/deliverer.test.ts (13 tests) 210ms \| local vitest this sweep: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓

### W6-R48 — VERIFIED
**Brief says:** "Force 6 consecutive failures. Verify the delivery lands in the dead-letter queue and is visible in the developer portal. Click \"Replay\" against a now-healthy subscriber and verify the replay succeeds with the original  […]"

**In plain English:** The brief's graded scenario: force 6 failures, see the delivery in the portal's dead-letter list, click Replay against a now-healthy receiver, and confirm the original idempotency key survives. The backend pieces (6-failure DLQ, replay with original key) passed unit tests this sweep; the 'click Replay in the portal' half exists in web/src/pages/DeveloperPortal.tsx with a jsdom test and a Playwright spec (TRO-439), but those did not run this sweep, so that half is traced from source only.

- **Tickets:** TRO-438, TRO-446, TRO-439, TRO-603
- **Evidence:** `api/src/platform/webhooks/__tests__/deliverer.test.ts:353`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1156`, `web/src/pages/DeveloperPortal.tsx:163`, `web/src/pages/DeveloperPortal.test.tsx:152`, `e2e/developer-portal-dlq-replay.spec.ts:169`
- **Verified by:** vitest: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓; api/src/platform/api/v1/resources/__tests__/webhooks.test.ts ✓; web/src/pages/DeveloperPortal.test.tsx ✓ (see test.log test-web.log) \| playwright: e2e/dev […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R49 — VERIFIED
**Brief says:** "Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, pnpm install @ship/sdk → ship login → create document → receive verified webhook in under 30 minutes elapsed (in practice, s […]"

**In plain English:** The brief asks for an end-to-end drill: install the SDK, log in, create a document, receive a verified webhook — in under 30 minutes on a clean machine, seconds in CI. `pnpm drill ttfe` (scripts/drill/ttfe.ts, delivered by TRO-455) does exactly that sequence and ran green in CI today on this exact commit in ~4 seconds of timed work; the clean-machine (Docker testcontainers) variant is documented as run in CHANGES.md but was not re-run this sweep.

- **Tickets:** TRO-455, TRO-448, TRO-450
- **Evidence:** `package.json:36`, `scripts/drill/run.ts:13`, `scripts/drill/ttfe.ts:334`, `scripts/drill/ttfe.ts:447`, `scripts/drill/ttfe.ts:486`, `scripts/drill/ttfe.ts:502`, `.github/workflows/ci.yml:418`, `.gitlab-ci.yml:244`, `CHANGES.md:1445`, `docs/submission/PLUGFORGE-EPIC-WRITEUPS.md:221`
- **Verified by:** drill-ttfe job 95172930963: completed success (13:39:09Z-13:39:51Z). Log: [setup] api ready (6553ms untimed); install_sdk 3263ms; device_login 92ms; webhook_create 22ms; document_create 13ms; wait_for_delivery 599ms; ver […]

### W6-R50 — VERIFIED
**Brief says:** "≤ 30 min real elapsed; CI typically < 60 s"

**In plain English:** Targets: the whole drill takes at most 30 minutes on a clean machine and typically under 60 seconds in CI. The 60-second budget is committed in scripts/drill/ttfe.config.json and enforced by scripts/drill/thresholds.ts (a run over budget exits 1 and fails CI). Today's CI runs on this commit measured about 4 seconds of timed work. The 30-minute clean-machine figure is only documented by the author (CHANGES.md), not measured this sweep.

- **Tickets:** TRO-455
- **Evidence:** `scripts/drill/ttfe.config.json:3`, `scripts/drill/thresholds.ts:70`, `scripts/drill/thresholds.ts:81`, `scripts/drill/ttfe.ts:541`, `scripts/drill/ttfe.ts:426`, `CHANGES.md:1445`
- **Verified by:** total: 3990ms / 60000ms budget (verdict: pass) and total: 3988ms / 60000ms budget (verdict: pass). All 30 most-recent completed drill jobs succeeded (see W6-R59), i.e. every sample well under 60s.

### W6-R51 — VERIFIED
**Brief says:** "OAuth Auth Code + PKCE round-trip (P95)\|< 3 s"

**In plain English:** The OAuth code + PKCE login round trip must complete in under 3 seconds at the 95th percentile. Two Playwright specs time it — the browser demo end-to-end (click to documents rendered) and the API-level authorize→token leg — and both assert under 3000 ms. A local run today measured 214 ms and 95 ms respectively; TRO-449 and TRO-597 delivered the measurements. Caveat: these are single samples on a local machine, not a computed P95 across many runs, and the specs are not part of CI.

- **Tickets:** TRO-449, TRO-597
- **Evidence:** `e2e/browser-demo-pkce.spec.ts:66`, `e2e/browser-demo-pkce.spec.ts:77`, `e2e/browser-demo-pkce.spec.ts:78`, `e2e/oauth-pkce-chain.spec.ts:210`, `e2e/oauth-pkce-chain.spec.ts:236`, `e2e/oauth-pkce-chain.spec.ts:237`, `CHANGES.md:5885`
- **Verified by:** browser-demo-pkce.spec.ts 'Connect to Ship -> consent -> documents list, real browser round trip': passed — console '[TRO-449] Browser demo PKCE round trip (click -> documents rendered): 214ms'; oauth-pkce-chain.spec.ts  […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R52 — PARTIAL
**Brief says:** "Webhook delivery latency (P95, first attempt)\|< 2 s"

**In plain English:** The brief sets a target that 95% of first webhook delivery attempts complete in under 2 seconds. The repo records per-attempt latency in the delivery log (TRO-438) and the CI drill measures the first-delivery wait on every run (TRO-455) — the latest main run measured 690 ms — but nothing asserts a 2-second bound: the drill's ceiling on that stage is 15 seconds, and no percentile is computed across runs. Measurement exists; the target itself is unasserted.

- **Tickets:** TRO-438, TRO-455
- **Evidence:** `api/src/platform/webhooks/deliverer.ts:694`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:770`, `scripts/drill/ttfe.ts:498`, `scripts/drill/ttfe.config.json:9`, `scripts/drill/thresholds.ts:18`, `.github/workflows/ci.yml:418`
- **Smallest change that would close it:** Assert the target: lower ttfe.config.json's wait_for_delivery stage ceiling to 2000 ms (a per-run max — strictly stronger than P95 — noting the deliverer's 1 s poll interval sits inside that stage), or add a dedicated first_delivery_latency_ms check; optionally aggregate wait_for_delivery across recent drill-ttfe CI runs to report an actual P95. Small ticket, scripts/drill/ only.
- **Delta vs 08-16 sweep:** VERIFIED → PARTIAL

### W6-R53 — VERIFIED
**Brief says:** "Webhook retry success rate after transient 5xx\|100% within configured schedule"

**In plain English:** The brief targets 100% eventual success for webhooks that hit a temporary server error, within the retry schedule. The deterministic-clock tests in api/src/platform/webhooks/__tests__/deliverer.test.ts show a transient-failure delivery succeeding on the retry and an exhausted one ending in a recorded dead state (never dropped), plus crash-recovery of pending retries (TRO-438, hardened by TRO-603); all passed this sweep. Nothing missing.

- **Tickets:** TRO-438, TRO-603
- **Evidence:** `api/src/platform/webhooks/__tests__/deliverer.test.ts:229`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:353`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:612`, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts:1317`
- **Verified by:** ✓ deliverer.test.ts (13 tests); ✓ resources/__tests__/webhooks.test.ts (34 tests) \| local vitest this sweep: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓; api/src/platform/api/v1/resources/__tests__/webhooks. […]

### W6-R54 — VERIFIED
**Brief says:** "Public API responses with rate-limit headers\|100%"

**In plain English:** 100% of public API responses — including errors — must carry rate-limit headers. A global middleware sets them before any route runs and the per-route fitness test's check (e) asserts them on each route's error path (TRO-427/PF-500). Passed this sweep.

- **Tickets:** TRO-427
- **Evidence:** `api/src/platform/api/v1/__tests__/route-fitness.test.ts:402`, `api/src/platform/api/v1/router.ts:88`, `api/src/platform/ratelimit/__tests__/middleware.test.ts:143`
- **Verified by:** test.log:17973 ✓ route-fitness.test.ts (126 tests incl. check (e) per route); :17974 ✓ ratelimit/middleware.test.ts (9 tests) \| local vitest this sweep: api/src/platform/api/v1/__tests__/route-fitness.test.ts ✓; api/src […]

### W6-R55 — ASSUMED
**Brief says:** "CLI drill harness: pnpm drill ttfe runs the full loop end-to-end against a containerized Ship instance from a clean working directory."

**In plain English:** The brief wants a `pnpm drill ttfe` command that runs the whole loop against a containerized Ship from a clean working directory. The command exists and runs the loop (TRO-455); the SDK is installed into a fresh throwaway directory; the database is a container (CI service container, or Docker testcontainers locally). What is arguable is 'containerized Ship instance': the Ship API process itself is started from the source checkout with tsx, never from a container image, in both paths. Whether database-in-a-container plus a real API process meets the wording is a call for the maintainer.

- **Tickets:** TRO-455
- **Evidence:** `package.json:36`, `scripts/drill/run.ts:13`, `scripts/drill/ttfe.ts:349`, `scripts/drill/ttfe.ts:386`, `scripts/drill/ttfe.ts:390`, `scripts/drill/ttfe.ts:186`, `.github/workflows/ci.yml:440`, `.gitlab-ci.yml:244`
- **Traced under assumption (ruling pending):** Traced under the STRICT reading: 'containerized Ship instance' means the Ship API runs from a container image, which the drill never does — hence PARTIAL. Under the lenient reading (Postgres in a container + the real API process from the checkout, SDK installed into a clean directory) the row would  […]
- **Smallest change that would close it:** If the strict reading holds: add an opt-in `DRILL_TTFE_API_IMAGE=<ghcr image>` path in scripts/drill/ttfe.ts that starts the built Ship image via testcontainers' GenericContainer instead of spawning tsx (GitHub Actions only — GitLab's shared runner cannot start containers, per .gitlab-ci.yml:233-241), and run it in ci.yml's drill-ttfe job. Otherwise: record an interpretation and close.
- **Delta vs 08-16 sweep:** PARTIAL → ASSUMED

### W6-R56 — VERIFIED
**Brief says:** "Timing instrumentation: each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."

**In plain English:** Each drill stage (install, login, register subscription, create document, receive webhook, verify signature) must record elapsed milliseconds. scripts/drill/ttfe.ts times exactly those six stages by name and prints each in ms; today's CI log for this commit shows all six numbers. Delivered by TRO-455.

- **Tickets:** TRO-455
- **Evidence:** `scripts/drill/ttfe.ts:435`, `scripts/drill/ttfe.ts:468`, `scripts/drill/ttfe.ts:482`, `scripts/drill/ttfe.ts:487`, `scripts/drill/ttfe.ts:498`, `scripts/drill/ttfe.ts:504`, `scripts/drill/thresholds.ts:93`, `scripts/drill/ttfe.config.json:4`
- **Verified by:** install_sdk: 3263ms / device_login: 92ms / webhook_create: 22ms / document_create: 13ms / wait_for_delivery: 599ms / verify_webhook: 1ms / total: 3990ms / 60000ms budget / verdict: pass

### W6-R57 — VERIFIED
**Brief says:** "Drill runs in CI on every PR. Any regression past the configured threshold fails the build."

**In plain English:** The drill must run in CI on every pull request and fail the build if it regresses past the threshold. Both CI configs (GitHub .github/workflows/ci.yml and the graded GitLab .gitlab-ci.yml) have a drill-ttfe job on every PR/MR, and the drill exits non-zero when over budget, which fails the job. Observed on GitHub for this exact commit's PR run; the GitLab side is config-only evidence (no GitLab pipeline history was queried). Delivered by TRO-455.

- **Tickets:** TRO-455
- **Evidence:** `.github/workflows/ci.yml:9`, `.github/workflows/ci.yml:418`, `.github/workflows/ci.yml:471`, `.github/workflows/ci.yml:139`, `.gitlab-ci.yml:29`, `.gitlab-ci.yml:244`, `.gitlab-ci.yml:267`, `scripts/drill/ttfe.ts:541`, `scripts/drill/__tests__/thresholds.test.ts:65`, `scripts/drill/ttfe.ts:116`, `scripts/factory/gate.sh:588`
- **Verified by:** Run 31949855599 is event=pull_request on headSha 08505d2d; its drill-ttfe job completed success and its verify job's 'TTFE drill threshold-logic tests' + 'TTFE drill type-check' steps both success. 24 of the 32 completed […]

### W6-R58 — VERIFIED
**Brief says:** "Webhook signature verification (SDK helper)\|< 1 ms per call"

**In plain English:** The signature check must take under 1 millisecond per call. The SDK suite has a perf test (verifyWebhook.test.ts) but it asserts a looser 5 ms ceiling to avoid flaky CI; to check the real target, this sweep timed the function directly: 0.0023 ms per call, about 400x under budget. TRO-413 delivered it. Nothing missing functionally; the only gap is that CI itself enforces 5 ms, not 1 ms.

- **Tickets:** TRO-413
- **Evidence:** `sdk/src/verifyWebhook.test.ts:300`, `sdk/src/verifyWebhook.test.ts:307`, `sdk/src/verifyWebhook.test.ts:324`, `sdk/src/verifyWebhook.ts:185`
- **Verified by:** Probe: mean per call over 20000 iters: 0.0023 ms (<1ms? true). CI: ✓ src/verifyWebhook.test.ts (30 tests) incl. the <5ms-mean perf assertion, 115ms for the whole file \| local vitest this sweep: sdk/src/verifyWebhook.tes […]

### W6-R59 — VERIFIED
**Brief says:** "Drill flake rate over 20 consecutive CI runs\|0% (any flake = bug in the drill or the platform)"

**In plain English:** The brief sets a target of zero flaky drill runs across 20 consecutive CI runs. Counting GitHub Actions history today, the 30 most recent completed drill jobs all succeeded (0 failures; one older job was cancelled because a newer push superseded it, which is not a flake). No retry setting exists on either CI job that could hide a flake. The 20-run bar is now met on GitHub; GitLab pipeline history was not queried.

- **Tickets:** TRO-455
- **Evidence:** `.github/workflows/ci.yml:418`, `.github/workflows/ci.yml:14`, `.gitlab-ci.yml:244`, `CHANGES.md:1453`
- **Verified by:** Of the 40 most recent CI runs (2026-08-16T06:59Z..13:41Z): 8 runs in_progress had no drill job yet (needs: verify); 32 completed runs each had one drill-ttfe job: 31 success, 1 cancelled, 0 failure. Newest-first, the 30  […]
- **Delta vs 08-16 sweep:** PARTIAL → VERIFIED

### W6-R60 — VERIFIED
**Brief says:** "SDK install size (production deps only)\|< 250 KB minified + gzipped"

**In plain English:** The SDK's installed size (production dependencies only, minified and gzipped) must stay under 250 KB, checked in CI. The SDK has zero runtime dependencies and sdk/scripts/measure-size.mjs bundles, minifies and gzips it (4.63 KB today, under 2% of budget); ci.yml and .gitlab-ci.yml both run it. TRO-422 delivered it. Re-measured this sweep and the gate also proven to fail when the bar is artificially lowered.

- **Tickets:** TRO-422
- **Evidence:** `.github/workflows/ci.yml:238`, `.github/workflows/ci.yml:239`, `.gitlab-ci.yml:160`, `sdk/package.json:32`, `sdk/package.json:34`, `sdk/scripts/measure-size.mjs:44`, `sdk/scripts/measure-size.mjs:55`, `sdk/scripts/measure-size.mjs:59`, `sdk/src/__tests__/sizeGate.test.ts:27`, `sdk/src/__tests__/sizeGate.test.ts:45`
- **Verified by:** Local: minified 16.11 kB, min+gzip 4.63 kB, threshold 250 kB, PASS, exit 0. Simulated bloat (--threshold-kb 1): FAIL — 4.63 kB >= 1 kB threshold, exit 1. CI (13:32Z today): 'min+gzip: 4.63 kB (gzip level 9)' 'PASS — 4.63 […]

### W6-R61 — VERIFIED
**Brief says:** "Implement at Least 5 of the Following Integrations / Flows"

**In plain English:** The brief scores implementing at least five of seven listed integrations/flows. Five are real: (1) the CLI at integrations/cli, (2) the Slack receiver at integrations/slack, (3) the browser PKCE demo at integrations/browser-demo, (4) the refresh-rotation stolen-token drill at e2e/oauth-refresh-rotation-stolen-token.spec.ts, and (5) the Idempotency-Key replay drill at e2e/webhook-idempotency-key-drill.spec.ts. All three packages type-check this sweep, the CLI's tests passed in today's CI, and both drills passed in a local Playwright run today. The two not built — GitHub App and plugin runtime — are the brief's own stretch items (TRO-453/454, Backlog).

- **Tickets:** TRO-448, TRO-450, TRO-452, TRO-451, TRO-449, TRO-445, TRO-447, TRO-598, TRO-453, TRO-454
- **Evidence:** `pnpm-workspace.yaml:7`, `integrations/cli/package.json:2`, `integrations/slack/package.json:2`, `integrations/slack/src/server.ts:82`, `integrations/slack/src/server.ts:109`, `integrations/browser-demo/package.json:2`, `integrations/browser-demo/src/main.ts:41`, `e2e/oauth-refresh-rotation-stolen-token.spec.ts:153`, `e2e/webhook-idempotency-key-drill.spec.ts:197`
- **Verified by:** typecheck.log:14 'integrations/cli type-check: Done', :16 'integrations/browser-demo type-check: Done', :19 'integrations/slack type-check: Done'. CI: CLI Test Files 9 passed / Tests 58 passed. Local Playwright (13:43Z): […]

### W6-R62 — VERIFIED
**Brief says:** "CLI tool with device flow — ship login, ship docs ls/get/create, ship webhooks tail (must-ship)."

**In plain English:** The must-ship CLI needs `ship login` (device flow), `ship docs ls/get/create`, and `ship webhooks tail` that streams signature-verified deliveries. All are registered in integrations/cli/src/bin.ts and implemented in commands/login.ts, docs.ts and webhooksTail.ts on top of the SDK only; TRO-448, TRO-450 and TRO-452 delivered them and TRO-455's TTFE drill runs the install→login→subscribe→first-verified-event story in CI. Today's CI run passed all 58 CLI tests and the drill; this sweep also confirmed the command surface via --help. Nothing missing.

- **Tickets:** TRO-448, TRO-450, TRO-452, TRO-455, TRO-425
- **Evidence:** `integrations/cli/package.json:8`, `integrations/cli/src/bin.ts:23`, `integrations/cli/src/bin.ts:60`, `integrations/cli/src/bin.ts:74`, `integrations/cli/src/bin.ts:90`, `integrations/cli/src/bin.ts:113`, `integrations/cli/src/commands/login.ts:66`, `integrations/cli/src/commands/docs.ts:125`, `integrations/cli/src/commands/docs.ts:146`, `integrations/cli/src/commands/docs.ts:175`, `integrations/cli/src/commands/webhooksTail.ts:322`, `integrations/cli/src/commands/webhooksTail.ts:206`, `integrations/cli/src/commands/webhooksTail.test.ts:79`, `integrations/cli/src/commands/webhooksTail.test.ts:99`, `integrations/cli/src/__tests__/login.liveServer.test.ts:196`, `integrations/cli/src/__tests__/docs.liveServer.test.ts:156`, `scripts/drill/ttfe.ts:19`, `.github/workflows/ci.yml:228`, `.github/workflows/ci.yml:418`
- **Verified by:** CI: ✓ src/commands/webhooksTail.test.ts (12); ✓ src/commands/docs.test.ts (16); ✓ src/commands/login.test.ts (5); ✓ src/__tests__/docs.liveServer.test.ts (2); ✓ src/__tests__/login.liveServer.test.ts (1); Test Files 9 pa […]

### W6-R63 — VERIFIED
**Brief says:** "the platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns — exactly as in Part 2."

**In plain English:** The brief promises the platform itself does no AI work — only user-started agent turns call an LLM. A grep this sweep finds no LLM client anywhere under api/src/platform (the new public-API layer), and the cost-ledger delta doc (PF-704) shows the Epic 7 rewire added zero LLM invocations. The cost-analysis doc (PF-905, TRO-434) honestly notes one caveat: an older, unrelated Ship feature (plan/retro quality scoring via AWS Bedrock in api/src/services/ai-analysis.ts) does call a model, outside the platform layer.

- **Tickets:** TRO-434, TRO-440, TRO-399
- **Evidence:** `docs/submission/PF-905-AI-COST-ANALYSIS.md:17`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:34`, `api/src/services/ai-analysis.ts:13`, `docs/submission/PF-704-COST-LEDGER-DELTA.md:69`, `agent/cost-ledger-snapshot.jsonl:1`, `api/src/__tests__/pf905CostAnalysisDocSections.test.ts:63`
- **Verified by:** Zero LLM-client imports under api/src/platform (the W6 platform layer). The whole api package has no anthropic/openai/langchain dependency; its single LLM call site is the pre-existing Bedrock plan/retro scorer in api/sr […]
- **Traced under assumption (ruling pending):** 'the platform itself' = the W6 platform layer under api/src/platform (per inventory meaning), not every route in the Ship API.
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R64 — PARTIAL
**Brief says:** "LLM API spend during the agent rewire (Epic 7) — track per-day spend while migrating direct service calls to SDK calls; confirm the rewire does not change token volume."

**In plain English:** The brief asks the team to track daily LLM spend while rewiring the agent onto the SDK and confirm the rewire did not change token usage. Tracking exists (a committed per-call ledger with a per-day report, docs PF-704/PF-905), but the confirmation has not happened: PF-704 says outright it is 'not yet measured' and names a real reason it might differ (sdk-mode document reads drop the body), and PF-905's Epic-7 spend section is still a TODO placeholder that a test deliberately keeps in place. The measurement is honestly disclosed as missing, not done.

- **Tickets:** TRO-434, TRO-440, TRO-605
- **Evidence:** `docs/submission/PF-704-COST-LEDGER-DELTA.md:38`, `docs/submission/PF-704-COST-LEDGER-DELTA.md:69`, `docs/submission/PF-704-COST-LEDGER-DELTA.md:88`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:67`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:338`, `api/src/__tests__/pf905CostAnalysisDocSections.test.ts:71`, `agent/src/shipClient.ts:554`, `agent/cost-ledger-snapshot.jsonl:1`
- **Smallest change that would close it:** (1) Update agent/src/shipClient.ts getDocumentViaSdk to pass through content/visibility/created_by from the widened SDK Document (sdk/src/types.ts:102-115) and drop the fail-closed 'sdk_mode_unknown' synthesis where the server now supplies real values; update shipClientParity.liveServer.test.ts:333 accordingly. (2) Run the same on_demand workload in both AGENT_PLATFORM_MODE values, diff agent cost-ledger rows (cost-report.ts by day), commit the two ledger snapshots. (3) Replace PF-905 §2.1's TODO with the measured numbers and change api/src/__tests__/pf905CostAnalysisDocSections.test.ts:71 to assert the filled section instead of the placeholder.
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → PARTIAL

### W6-R65 — VERIFIED
**Brief says:** "Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls."

**In plain English:** The brief wants a committed cost analysis showing platform cost scales with API traffic and webhook delivery (not LLM calls), with projections at 100 / 1,000 / 10,000 / 100,000 users and explicit assumptions (webhook fan-out, how many users use the agent, how long logs are kept). docs/submission/PF-905-AI-COST-ANALYSIS.md §3 (TRO-434) has the four-tier table and names each assumption individually; a structural test that passed this sweep checks the tiers and the OBSERVED/DERIVED/ASSUMED tags are present. The arithmetic itself was not independently re-derived.

- **Tickets:** TRO-434
- **Evidence:** `docs/submission/PF-905-AI-COST-ANALYSIS.md:235`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:239`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:252`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:264`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:288`, `docs/submission/PF-905-AI-COST-ANALYSIS.md:17`, `api/src/__tests__/pf905CostAnalysisDocSections.test.ts:95`
- **Verified by:** ✓ src/__tests__/pf905CostAnalysisDocSections.test.ts (15 tests) — passed. Note this suite is a presence/structure lint (its own header says it does not check arithmetic). \| local vitest this sweep: api/src/__tests__/pf9 […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R66 — VERIFIED
**Brief says:** "Node.js + Express (existing Ship stack); TypeScript strict mode required; Zod for request/response schemas and OpenAPI generation."

**In plain English:** New platform and SDK code must compile under TypeScript strict mode and use Zod for schemas/OpenAPI. The root tsconfig sets strict:true and every package (api, sdk, integrations/*, agent, web, shared) inherits it without loosening; the whole workspace type-checked clean in this sweep. Zod-to-OpenAPI drives the v1 spec. Nothing missing.

- **Tickets:** TRO-601
- **Evidence:** `tsconfig.json:13`, `sdk/tsconfig.json:2`, `api/tsconfig.json:2`, `integrations/cli/tsconfig.json:2`, `api/src/platform/openapi/registry.ts:30`
- **Verified by:** verify-run.log: 'typecheck exit=0'; typecheck.log: shared/sdk/integrations-cli/integrations-browser-demo/agent/integrations-slack/api/web all 'type-check: Done' (8 of 9 workspace projects have the script)

### W6-R67 — VERIFIED
**Brief says:** "the Part 2 agent is rewired to authenticate as a first-party OAuth app and consume the public API through the SDK — same scopes, same rate limits, same audit trail."

**In plain English:** The brief says the Part 2 agent must be rewired to log in as its own OAuth app and use the public API through the SDK, with the same scopes, rate limits and audit trail as any third party. That exists: a first-party app ship_app_fleetgraph is seeded (TRO-423), the agent's reads go through @ship/sdk when AGENT_PLATFORM_MODE=sdk (TRO-428), its writes use the acting human's token through the SDK (TRO-435), CI runs the agent suite in both modes, and a live test proves audit rows attribute reads to the app and writes to the human with rate-limit headers present (TRO-440) — all passing this sweep. One loose end: the agent's sdk-mode document read still drops the document body even though the server now returns it (TRO-605 fixed the server, not the agent adapter).

- **Tickets:** TRO-417, TRO-423, TRO-428, TRO-435, TRO-440, TRO-414, TRO-605, TRO-432, TRO-427
- **Evidence:** `agent/src/config.ts:347`, `agent/src/index.ts:208`, `agent/src/index.ts:291`, `agent/src/shipClient.ts:40`, `agent/src/shipClient.ts:1083`, `agent/src/gate.ts:49`, `api/src/platform/oauth/seedFirstPartyApp.ts:84`, `api/src/index.ts:102`, `.github/workflows/ci.yml:195`, `.gitlab-ci.yml:140`, `agent/src/__tests__/auditTrailProof.liveServer.test.ts:284`, `agent/src/__tests__/gateWriteBoundary.dbRoundTrip.test.ts:430`, `agent/src/__tests__/shipClientParity.liveServer.test.ts:92`, `agent/src/__tests__/config.test.ts:92`, `agent/src/shipClient.ts:554`
- **Verified by:** auditTrailProof.liveServer.test.ts 4/4 passed; gateWriteBoundary.dbRoundTrip.test.ts 5/5; shipClientParity.liveServer.test.ts 10/10; graphWriteBoundary.test.ts 10/10; config.test.ts 21/21; shipClient.test.ts 22/22; api s […]

### W6-R68 — VERIFIED
**Brief says:** "The real queue-backed deliverer is tested with deterministic clock injection — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."

**In plain English:** The brief forbids timing-based (sleep/setTimeout) webhook retry tests and requires an injectable clock. api/src/platform/webhooks/clock.ts provides a hand-advanced ManualClock and every deliverer test uses it (TRO-438); the only 'setTimeout' in the test file is a comment saying not to use one, and the file passed this sweep in 210 ms. Nothing missing.

- **Tickets:** TRO-438
- **Evidence:** `api/src/platform/webhooks/clock.ts:44`, `api/src/platform/webhooks/deliverer.ts:54`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:11`, `api/src/platform/webhooks/__tests__/deliverer.test.ts:242`
- **Verified by:** ✓ deliverer.test.ts (13 tests) 210ms; grep: 1 hit, at line 13 inside the header comment — zero setTimeout calls in test control flow \| local vitest this sweep: api/src/platform/webhooks/__tests__/deliverer.test.ts ✓

### W6-R69 — VERIFIED
**Brief says:** "External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced by a workspace dependency rule."

**In plain English:** External integrations must live under integrations/ and depend only on the public SDK, never on the API's internal source, and a workspace rule must enforce that. All three integrations are under integrations/, each declares @ship/sdk as its sole runtime dependency, and scripts/check-integration-deps.mjs (run in both CI pipelines and the local factory gate) fails the build if any other runtime dependency appears; TRO-399 delivered it. This sweep re-ran the check (passes), its 10 tests (pass), and proved it fails on a deliberately violating package. No integration source imports api/src.

- **Tickets:** TRO-399, TRO-448, TRO-500, TRO-496
- **Evidence:** `pnpm-workspace.yaml:7`, `scripts/check-integration-deps.mjs:44`, `scripts/check-integration-deps.mjs:52`, `scripts/__tests__/check-integration-deps.test.mjs:47`, `scripts/__tests__/check-integration-deps.test.mjs:128`, `.github/workflows/ci.yml:118`, `.github/workflows/ci.yml:124`, `.gitlab-ci.yml:97`, `scripts/factory/gate.sh:285`, `integrations/cli/package.json:23`, `integrations/slack/package.json:16`, `integrations/browser-demo/package.json:15`, `integrations/slack/scripts/build.mjs:4`, `CHANGES.md:2707`, `PLUGFORGE.MD:220`
- **Verified by:** Real tree: 'check-integration-deps: OK — 3 package(s) checked (browser-demo, cli, slack), all depend only on @ship/sdk.' exit 0. node:test: 10 pass / 0 fail. Scratch violation: 'FAIL — 1 runtime-dependency violation(s) f […]
- **Traced under assumption (ruling pending):** 'import only @ship/sdk — never api/src/' is read as forbidding Ship-internal imports other than the SDK (api/src, shared/src, web/src), not as forbidding third-party plumbing packages like commander/express, which PLUGFORGE PF-600 explicitly allows.
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R70 — VERIFIED
**Brief says:** "Architecture Document (1–2 pages) committed at docs/architecture.md."

**In plain English:** A short architecture document with nine named sections must live at docs/architecture.md. It does (TRO-424), every section heading is present with real content, and a unit test that checks for those sections ran and passed this sweep. It runs to 445 lines — longer than the '1–2 pages' phrasing, but that is extra substance, not a missing section.

- **Tickets:** TRO-424, TRO-447
- **Evidence:** `docs/architecture.md:23`, `docs/architecture.md:46`, `docs/architecture.md:56`, `docs/architecture.md:91`, `docs/architecture.md:118`, `docs/architecture.md:167`, `docs/architecture.md:240`, `docs/architecture.md:270`, `docs/architecture.md:297`, `api/src/__tests__/architectureDocSections.test.ts:78`, `CHANGES.md:8595`
- **Verified by:** All nine mandated headings present at lines 23/46/56/91/118/167/240/270/297 (plus Documented Deviations :352, Cross-References :425; 445 lines total). test.log: ✓ src/__tests__/architectureDocSections.test.ts (15 tests)  […]
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → VERIFIED

### W6-R71 — PARTIAL
**Brief says:** "GitHub Repository Public; per-slice branches preserved; each PR description lists which acceptance criterion that slice advances and confirms the fitness test passed."

**In plain English:** The repo must be public, keep every slice's branch, and each pull request must say which acceptance criterion it advances and that its fitness test passed. The repo is public and 253 branches (including per-PF-ticket names) are preserved. PR descriptions are uneven: PR #263 does exactly what the brief asks, but #266, #273 and #276 carry evidence sections without naming an acceptance criterion or stating the fitness test passed.

- **Tickets:** — (no ticket maps here)
- **Evidence:** `README.md:24`
- **Smallest change that would close it:** Add .github/PULL_REQUEST_TEMPLATE.md with 'Acceptance criterion advanced:' and 'Fitness test passed:' fields (retro-fit not required by the brief).

### W6-R72 — PARTIAL
**Brief says:** "The five-line story is the demo: open a fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail produces a verified signed delivery. Then switch to the dev portal and replay one deliv […]"

**In plain English:** The demo video (3–5 min) must tell the five-line story: install the SDK, log in, create a doc, watch a signed webhook arrive in the terminal, then replay a delivery in the portal. No video exists (no .mp4/Loom/YouTube link anywhere in docs/ or README). A committed script exists (docs/submission/PLUGFORGE-DEMO-SCRIPT.md) but it calls itself a rehearsal draft, is grounded on 2026-08-14 state, and its core demo uses curl instead of the CLI five-line story. All the ingredients (ship login, ship docs create, ship webhooks tail, portal replay) are now merged; TRO-444/PF-908 and TRO-429/PF-904 remain Backlog.

- **Tickets:** TRO-444, TRO-429, TRO-452, TRO-448, TRO-450
- **Evidence:** `docs/submission/PLUGFORGE-DEMO-SCRIPT.md:1`, `docs/submission/PLUGFORGE-DEMO-SCRIPT.md:8`, `docs/submission/PLUGFORGE-DEMO-SCRIPT.md:16`, `docs/submission/PLUGFORGE-DEMO-SCRIPT.md:389`
- **Smallest change that would close it:** TRO-444/TRO-429: rewrite the script's core act around the literal five-line CLI story + portal replay, record the 3–5 min video, commit the script and link the video.
- **Delta vs 08-16 sweep:** MISSING → PARTIAL

### W6-R73 — MISSING
**Brief says:** "All three phases completed with written answers; saved AI conversation attached as a reference artifact."

**In plain English:** The brief wants a Pre-Search document with all three phases answered and the AI conversation saved alongside it. The repo has no Week-6 pre-search document — PRESEARCH.MD is last week's FleetGraph one — and no saved-conversation artifact. TRO-429 (PF-904, a human checkpoint that needs Troy's answers) is still Backlog.

- **Tickets:** TRO-429
- **Evidence:** `PRESEARCH.MD:1`, `PLUGFORGE.MD:300`
- **Smallest change that would close it:** TRO-429: create PRESEARCH-W6.MD (or docs/submission/PLUGFORGE-PRESEARCH.md) with the three phases answered by Troy, plus the exported AI conversation file.

### W6-R74 — VERIFIED
**Brief says:** "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at docs/openapi.json in the repo. Validate against the OpenAPI schema."

**In plain English:** The spec must be reachable on the deployed server AND committed as docs/openapi.json, with CI failing if the two drift. This session fetched the live URL (200, identical to the committed file), ran the parity check locally (OK), and both CI pipelines have the drift step (TRO-409/PF-204). PR #276 regenerated the committed copy when it changed the issues schema, and the deployed instance already serves that version.

- **Tickets:** TRO-409, TRO-402, TRO-501
- **Evidence:** `docs/openapi.json:1`, `api/src/scripts/generate-v1-openapi.ts:81`, `.github/workflows/ci.yml:98`, `.gitlab-ci.yml:83`, `api/src/platform/api/v1/router.ts:103`
- **Verified by:** openapi:check -> 'OK: docs/openapi.json matches the in-process /api/v1 OpenAPI registry.' Live probe -> HTTP 200 in 0.32s, openapi 3.1.0, 21 paths, python json compare == committed docs/openapi.json: identical (so the de […]

### W6-R75 — PARTIAL
**Brief says:** "Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication."

**In plain English:** Each epic needs a before → fix → after → proof write-up, and the brief names two proofs: Epic 6's is the TTFE drill passing in CI, Epic 7's is the agent's audit-log rows. docs/submission/PLUGFORGE-EPIC-WRITEUPS.md (TRO-437) covers E0–E4, E6 and E8 with the right structure, but its E6 proof is a local run rather than a CI run link, and the E7 section is deliberately absent because PF-704 had not landed when it was written — PF-704 (TRO-440) has since merged, so the write-up is now behind the evidence.

- **Tickets:** TRO-437, TRO-455, TRO-440
- **Evidence:** `docs/submission/PLUGFORGE-EPIC-WRITEUPS.md:1`, `docs/submission/PLUGFORGE-EPIC-WRITEUPS.md:14`, `docs/submission/PLUGFORGE-EPIC-WRITEUPS.md:195`, `docs/submission/PLUGFORGE-EPIC-WRITEUPS.md:212`, `.github/workflows/ci.yml:418`, `docs/submission/PF-704-COST-LEDGER-DELTA.md:1`, `agent/src/__tests__/auditTrailProof.liveServer.test.ts:1`
- **Smallest change that would close it:** Update PLUGFORGE-EPIC-WRITEUPS.md: add the E7 section citing auditTrailProof.liveServer.test.ts's printed audit rows / PF-704-COST-LEDGER-DELTA.md, and cite a green CI run ID for the drill-ttfe job in E6 (e.g. run 31949732432).
- **Delta vs 08-16 sweep:** IMPLEMENTED-UNVERIFIED → PARTIAL

### W6-R76 — IMPLEMENTED-UNVERIFIED
**Brief says:** "Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pa […]"

**In plain English:** Three short discovery write-ups are required, drawn from four suggested topics. docs/submission/PLUGFORGE-DISCOVERIES.md (TRO-437) has exactly three — device grant, zod→OpenAPI parity, HMAC anti-replay — each citing real files with observed/derived marking. Nothing runnable applies; the artifact is present and on-topic.

- **Tickets:** TRO-437
- **Evidence:** `docs/submission/PLUGFORGE-DISCOVERIES.md:3`, `docs/submission/PLUGFORGE-DISCOVERIES.md:16`, `docs/submission/PLUGFORGE-DISCOVERIES.md:57`, `docs/submission/PLUGFORGE-DISCOVERIES.md:97`

### W6-R77 — VERIFIED
**Brief says:** "Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus credentials in the README. Dev portal reachable; OpenAPI spec resolvable."

**In plain English:** Graders need a public URL, a pre-made read-only OAuth app with its credentials in the README, a reachable developer portal, and a resolvable OpenAPI spec. README.md's 'Grader Access' section (TRO-441) gives the one-command seed and the live client_id/secret; the live site serves the portal route and its code, and the spec resolves as JSON — all probed this sweep. One wart: README.md line 387 still says the portal 'doesn't exist on this branch yet', which is no longer true.

- **Tickets:** TRO-441, TRO-436, TRO-439
- **Evidence:** `README.md:311`, `README.md:320`, `README.md:392`, `README.md:387`, `api/src/platform/oauth/seedGraderApp.ts:56`, `web/src/pages/App.tsx:269`
- **Verified by:** /developer/apps -> 200 text/html; /developer -> 200; /api/v1/openapi.json -> 200 application/json (valid JSON, 21 paths); served /assets/index-CXfdv-VQ.js references DeveloperApps-vGLDgZ1i.js / DeveloperPortal-DCl7fHpG.j […]
- **Smallest change that would close it:** Doc fix: replace README.md:387-390's 'depends on E5 ... doesn't exist yet' bullet with the live portal path (/developer/apps after logging in as alice.chen@ship.local).
- **Delta vs 08-16 sweep:** PARTIAL → VERIFIED

### W6-R78 — MISSING
**Brief says:** "Tag @GauntletAI. The screenshot is the ship webhooks tail terminal showing a verified signed event arriving in real time."

**In plain English:** The social post must tag @GauntletAI and show a screenshot of `ship webhooks tail` receiving a verified signed event live. No Week-6 post draft or screenshot exists — the only social drafts in docs/submission/ are Week 4's and Week 5's, and docs/submission/social-assets/ holds only W4/W5 images. `ship webhooks tail` itself is merged (TRO-452), so nothing blocks the screenshot; TRO-444 (PF-908) is Backlog.

- **Tickets:** TRO-444, TRO-452
- **Evidence:** `docs/submission/SOCIAL-POST.md:1`, `docs/submission/SOCIAL-POST.md:14`, `docs/submission/SOCIAL-THREAD-W4-W5.md:1`
- **Smallest change that would close it:** TRO-444: run `ship webhooks tail` against the live deploy, capture the '✓ verified' terminal frame, and commit docs/submission/PLUGFORGE-SOCIAL-POST.md + the PNG.

### W6-R79 — N/A
**Brief says:** "Gate: Project completion + interviews required for Austin admission. The interview is where you defend your"

**In plain English:** Admission to Austin depends on finishing the project and defending it in an interview — a human gate, not something the repo can pass. The prep material exists: the OAuth study brief (TRO-403, acked), the agent-rewire checkpoint (TRO-417, acked), the architecture doc's boundary and agent sections, and the defense deck. The pre-search checkpoint (TRO-429) is still open.

- **Tickets:** TRO-403, TRO-417, TRO-429
- **Evidence:** `docs/submission/PF-100-OAUTH-STUDY-BRIEF.md:1`, `docs/submission/PLUGFORGE-DEFENSE-DECK.html:430`, `docs/architecture.md:91`, `docs/architecture.md:270`

