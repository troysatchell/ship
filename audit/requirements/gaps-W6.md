# Requirements gaps — Ship (2026-08-13T19:53:43Z, commit 06a15f147d443fbe405b51d4ea77ea2141f21e6e)

## Unticketed requirements

Note: despite the section title (per report-format.md's template), every row below DOES
carry ticket(s) — W6 has full ticket coverage; "unticketed" here means "gap": every
MISSING or PARTIAL requirement, regardless of its own ticket status. (W6-R39, the sweep's
one IMPLEMENTED-UNVERIFIED row, is intentionally excluded — its code/doc trace is complete
and nothing is missing to scope; it only lacks a captured verify-command run, which is not
a PM-scoping action. See REPORT-W6.md's Matrix for that row.)

### W6-R3 — PARTIAL
- **Quote:** "Authorization Code + PKCE flow completes end-to-end via a Playwright test: /oauth/authorize → consent → /oauth/token → usable access token."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** `/oauth/authorize` + consent UI + `/oauth/token` implementing RFC 6749 + 7636, proven by a Playwright e2e. (MVP hard gate.)
- **Tickets:** TRO-412, TRO-416, TRO-503, TRO-550, TRO-549
- **What is missing:** The authorize-to-consent-to-redirect-with-code leg is genuinely implemented and proven by a real, freshly-re-run Playwright e2e (VERIFIED for that portion). The requirement's full literal scope -- one Playwright spec spanning authorize -> consent -> token -> a usable access token against a real authenticated route -- is not met: no Playwright spec calls /oauth/token, and there is no /api/v1/me route yet to call with the resulting token. This is not an interpretive ambiguity; the codebase's own CHANGES.md entry (TRO-416) states the gap directly. Ticket list: TRO-412 (authorize/consent, Done), TRO-416 (/oauth/token, Done), TRO-503 (Backlog -- CloudFront has no /oauth/* cache behavior, a deploy-time follow-up flagged in the same spec's header), TRO-550 (Backlog -- consent screen shows generic app info, referenced directly in the spec's own comments), TRO-549 (Backlog -- weak/plausible match: the e2e login-flow assertion pattern this spec itself uses, 'not toHaveURL(/login)', is the exact pattern that ticket questions).
- **Suggested scope:** Once PF-201/TRO-400 lands /api/v1/me, extend e2e/oauth-authorize.spec.ts (or add a new spec) to continue past the redirect: exchange the code via POST /oauth/token and call /api/v1/me with the resulting token, chaining all three hops (authorize -> token -> protected resource) into one Playwright test instead of two separately-proven halves (e2e for authorize+consent, vitest for token exchange).

### W6-R6 — PARTIAL
- **Quote:** "Consistent ApiError shape ({code, message, details?, request_id}) returned on every public failure, asserted by a fitness test over all /api/v1 routes."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Public error middleware producing the ApiError shape on every v1 failure path, plus a route-enumerating fitness test. (MVP hard gate.)
- **Tickets:** TRO-397, TRO-489, TRO-495, TRO-404
- **What is missing:** The ApiError contract itself is solid and gate-tested (ran api/src/platform/api/v1/__tests__/error-middleware.test.ts + errors.test.ts: 20/20 passed; documents.test.ts independently exercises it on a real resource). The requirement's second, explicitly-named acceptance clause -- 'asserted by a fitness test over all /api/v1 routes' (PF-203) -- does not exist in the repo: no file walks v1Routes.stack or asserts shape-coverage across every registered route (searched for router.stack/listRoutes/enumerateRoutes patterns, none found), and TRO-404 (PF-203) is Backlog, confirmed independently by the project's own memory-bank as the last unmerged MVP-gate item. Not an ambiguity -- the artifact (memory-bank) states this plainly, per this repo's own claim-provenance discipline.
- **Suggested scope:** Land PF-203/TRO-404: a fitness test that walks every registered /api/v1 route and asserts each error path returns the exact ApiErrorBody shape, replacing the current ad hoc two-scratch-route coverage in error-middleware.test.ts. Currently Backlog, blocked behind PF-202/TRO-402 per memory-bank/activeContext.md.

### W6-R8 — MISSING
- **Quote:** "OpenAPI 3.1 spec served at /api/v1/openapi.json, generated from route metadata (never hand-written), validating against the OpenAPI schema in a unit test."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** In-process spec generator + serving route + schema-validation unit test. (MVP hard gate.)
- **Tickets:** TRO-402
- **What is missing:** PF-202 (TRO-402, Linear status 'In Progress') is genuinely unmerged work-in-progress: a branch `feat/pf-202-openapi-v1-generator` exists with 3 commits ('feat/test/docs(TRO-402)') but `git merge-base --is-ancestor feat/pf-202-openapi-v1-generator main` returns false at the pinned commit — it is not an ancestor of main. memory-bank/activeContext.md line 11 corroborates: work is sitting uncommitted/in-progress in worktree `Ship-wt-tro_402`, dispatched but not landed at session rollover. The only OpenAPI surface reachable at this commit is the pre-existing internal `/api/openapi.json` (api/src/swagger.ts:39, api/src/openapi/registry.ts), which is a different registry instance serving `/api/*` (internal), not `/api/v1/*` (public). No unit test validating a v1 spec against the OpenAPI 3.1 schema exists in-repo.
- **Suggested scope:** Ships when TRO-402/PF-202 merges (already in flight in another worktree per memory-bank) — add the v1 OpenAPI registry, a GET /api/v1/openapi.json route registered on v1Routes, and the schema-validation unit test. No new design work needed; this is a landing/merge gap, not a missing design.

### W6-R9 — MISSING
- **Quote:** "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token}).me()` against a running server returns the typed authenticated user."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** `sdk/` workspace package exporting ShipClient with a working `me()`. (MVP hard gate.)
- **Tickets:** TRO-405, TRO-390
- **What is missing:** No `sdk/` directory exists anywhere in the repo, no `@ship/sdk` in pnpm-lock.yaml, and it is absent from pnpm-workspace.yaml. TRO-405/PF-400 is Backlog and per memory-bank/activeContext.md has not even been dispatched to a builder yet. A same-named `ShipClient` class exists at agent/src/shipClient.ts but is confirmed (by reading its docstring) to be an unrelated internal client, not this requirement's artifact.
- **Suggested scope:** Ships when PF-400/TRO-405 lands: scaffold sdk/ as a pnpm workspace package (@ship/sdk), a ShipClient class with token-auth constructor + me(), and an integration test against a running test server. Also blocked on PF-201/TRO-400 (issues/sprints/me route, currently In Progress) landing first since me() has no live /api/v1/me endpoint to call yet.

### W6-R10 — MISSING
- **Quote:** "Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** No regression: e2e suite green, and the three Part-1 baseline metrics (in `audit/`) stay within +10%. (MVP hard gate.)
- **Tickets:** (none)
- **What is missing:** This is a cross-cutting MVP-gate constraint (no dedicated PF ticket owns it — it's referenced as an AC clause inside several tickets, e.g. PF-001's 'internal routes untouched (regression suite green)', but never as its own deliverable). As of this commit (06a15f1, mid-sprint, 2026-08-13) no compare-mode run of api-perf-audit/bundle-audit/db-query-audit has been captured against the 2026-07-27 Part-1 baselines, and no full Playwright regression run is documented since W6 platform code (oauth_apps, /api/v1 router, rate limiters, etc.) started landing. Given the volume of new middleware mounted on every request (request_id, CORS, rate-limit exemption logic in app.ts) this is a real, not merely paperwork, risk to the +10% latency/bundle/query-count budget. I did not run the full suites myself — W6-R10's acceptance evidence does not name a specific targeted test file (it names whole audit categories + the full e2e suite), so per the task's own instruction I could not treat this as a 'run only the named file' case, and running the entire suite/all three audits was explicitly out of scope for a targeted verify.
- **Suggested scope:** Before final submission: run compare-mode api-perf-audit, bundle-audit, and db-query-audit skills against the current branch, plus the full e2e regression suite, and diff against audit/{api-perf,bundle,db-query}/baseline.{md,json} (2026-07-27). Commit the resulting compare artifacts (audit/{api-perf,bundle,db-query}/compare-w6-<date>/) the same way compare-phase2-jul30/ was committed for the prior comparison. If any metric exceeds +10%, that becomes its own remediation ticket before the gate closes.

### W6-R11 — PARTIAL
- **Quote:** "Deployed and publicly accessible: deployed Ship + published OpenAPI spec URL + at least one OAuth app pre-registered with read-only scopes for graders."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Live deployment carrying the platform layer, public spec URL, seeded grader OAuth app. (MVP hard gate.)
- **Tickets:** TRO-441, TRO-411, TRO-402
- **What is missing:** Two of the three required pieces have real code: the grader OAuth app seed (Done, TRO-441) and its Terraform env-var wiring (TRO-411). The third — 'published OpenAPI spec URL' — cannot exist yet because /api/v1/openapi.json is not registered anywhere in the router (confirmed by reading router.ts directly, not inferred). Separately, 'deployed and publicly accessible' requires a live URL probe I cannot perform in this sandbox (no network egress attempted; per task instructions this stays unverified rather than assumed) — but that live-check gap is secondary to the harder fact that the spec-URL component is missing at the code level regardless of deployment.
- **Suggested scope:** Land TRO-402/PF-202 (the /api/v1/openapi.json route) — once that exists, this requirement's spec-URL leg becomes a live-deploy verification question rather than a missing-code question. The grader-app and Terraform legs are already done and just need a real deploy + probe.

### W6-R12 — PARTIAL
- **Quote:** "Terraform deployment: a terraform/ directory with a complete config describing the deployment topology (app container, database, networking, IAM task role and execution role). Provider versions must be pinned. Run terraform plan and include the annotated output as a submission artifact. Perform a destroy-and-redeploy: tear down the environment and re-apply from the Terraform config alone to prove IaC completeness."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Complete IaC for the deployment (repo deploys to Render — the IAM-role language is AWS-shaped and needs adaptation), pinned providers, committed annotated plan, destroy-redeploy evidence. (MVP hard gate.)
- **Tickets:** TRO-411, TRO-415, TRO-488, TRO-420
- **What is missing:** Config completeness, exact provider pin, and a committed annotated plan artifact are all real and present. The one piece that is not: destroy-redeploy evidence for the deployment as it stands today, including this week's platform additions (SECRET_ENCRYPTION_KEY, both new OAuth-secret env vars, rate-limit config, etc.) — the only destroy-redeploy proof on file predates PF-900's env vars and covers a single, narrower resource. TRO-415/PF-901 (the ticket meant to close this) is explicitly Backlog and flagged as needing human sign-off before any real terraform destroy against the graded environment.
- **Suggested scope:** Once TRO-415/PF-901 gets its human go-ahead, run a real destroy → apply cycle against the current terraform/render/ topology (all three resources, not just the agent), and commit the proof the same way tro-316-destroy-redeploy-proof.md was committed for the narrower case. This is the same underlying gap as W6-R40 — closing one closes both.

### W6-R15 — MISSING
- **Quote:** "/oauth/device/code issues a user_code and device_code; /oauth/device/verify accepts the user_code; the client polls /oauth/token until authorized. Slow-down responses honored."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** RFC 8628 Device Authorization Grant endpoints, including slow_down semantics honored by clients.
- **Tickets:** TRO-425
- **What is missing:** No /oauth/device/code, /oauth/device/verify, or grant_type=urn:ietf:...:device_code branch exists anywhere in api/src/routes or api/src/platform/oauth at pinned commit 06a15f1 (grepped for device_code/user_code/authorization_pending/slow_down in api/src -- zero hits outside test/config/CORS-allowlist files). The real implementation exists as commit 33843e1 'feat(TRO-425): PF-106 device authorization grant (RFC 8628)' on branch feat/pf-106-device-auth-grant, confirmed via `git merge-base --is-ancestor 33843e1 06a15f1` = NOT an ancestor, and no PR (open or merged) references TRO-425/pf-106 (gh pr list --state all checked). At the pinned commit this requirement is unimplemented, not merely unverified.
- **Suggested scope:** Not a small fix -- the full implementation already exists and is tested (422 lines of device.ts, 189-line route file, 9 passing test cases per the branch's own commit message) on feat/pf-106-device-auth-grant. Closing this gap means merging that branch, not writing new code; ships when TRO-425's PR lands on main.

### W6-R18 — MISSING
- **Quote:** "One-time-use refresh tokens with rotation. Stolen-refresh-token detection: reuse invalidates the family."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Refresh rotation with family-wide revocation on reuse of a rotated token.
- **Tickets:** TRO-421
- **What is missing:** Refresh tokens ARE minted and stored (refresh_token_hash) at authorization_code issuance (api/src/platform/oauth/token.ts:360), but there is no route or service code anywhere on main that redeems a refresh_token grant, rotates it, or performs family-wide revocation on reuse. The real implementation is commit 82c6460 'feat(TRO-421): POST /oauth/token grant_type=refresh_token -- rotation + family invalidation' on branch feat/pf-105-refresh-rotation, confirmed NOT an ancestor of 06a15f1 via git merge-base --is-ancestor, with no PR yet on GitHub for TRO-421/pf-105.
- **Suggested scope:** Not a small fix -- full implementation (migration 045 + token.ts refresh_token grant + 14-case regression suite incl. a forced concurrency test) already exists on feat/pf-105-refresh-rotation per that branch's own commit history; closing this gap means merging that branch.

### W6-R21 — MISSING
- **Quote:** "Generated from route metadata in-process. Served at /api/v1/openapi.json. Validates against the OpenAPI schema in a unit test. Spec parity asserted by fitness test."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Spec generation is in-process from route metadata; a fitness test asserts 100% spec ↔ route parity (see also W6-R44/R45).
- **Tickets:** TRO-402, TRO-404
- **What is missing:** This requirement restates W6-R8 (spec generation + serving + schema-validation test) and adds the spec/route parity fitness-test clause, which is W6-R44/PF-203. Both halves are unimplemented at this commit for the same reason documented under W6-R8: TRO-402/PF-202 is unmerged WIP (branch not an ancestor of main) and TRO-404/PF-203 is still Backlog with zero code found anywhere in the repo (grep for 'fitness'/'route-enumeration'/'enumerat' across api/web/e2e/agent/scripts turned up no route-enumeration test).
- **Suggested scope:** Ships when both TRO-402/PF-202 (openapi generator + route) and TRO-404/PF-203 (route-enumeration fitness test) land — TRO-402 is already in flight in another worktree; TRO-404 explicitly depends on TRO-402 per memory-bank/activeContext.md's stated MVP-gate order ('PF-203/TRO-404 after PF-202 Done').

### W6-R23 — MISSING
- **Quote:** "IEventBus interface. Domain layer publishes on writes — never the route layer. In-process implementation must-ship; queue-backed implementation is a Liskov-substitutable drop-in."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** IEventBus interface with in-process impl; publish() calls live only in the domain write path (implies consolidating Ship's currently route-scattered document writes).
- **Tickets:** TRO-426
- **What is missing:** No IEventBus interface, no in-process implementation, and no publish() call exists anywhere in api/src (grep for 'IEventBus|EventBus|eventBus' across api/src and shared/src returns only events.ts's unrelated content, the architecture-doc-sections test, and this same documentService.ts scaffold comment). Ticket TRO-426/PF-301 is Backlog, consistent with the code state.
- **Suggested scope:** Ships when PF-301 (TRO-426, Backlog) ships. Smallest step: add an IEventBus interface + in-process synchronous implementation under api/src/platform/webhooks/, then redirect the ~9 route files that currently do inline document INSERT/UPDATE/DELETE (documents.ts, issues.ts, projects.ts, programs.ts, admin.ts, team.ts, workspaces.ts, feedback.ts, setup.ts — per PF-301's own ticket scoping note) through documentService.ts's write path, adding publish() calls there. documentService.ts already exists as the landing point but currently only has createDocument().

### W6-R24 — MISSING
- **Quote:** "Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Subscriptions table + CRUD API under webhooks:manage. NOTE: "hashed signing secret" is unimplementable as a one-way hash (the server must possess the secret to sign) — PLUGFORGE.MD §2.2 deviates deliberately to encrypted-at-rest; this needs to be defended in the architecture doc.
- **Tickets:** TRO-431
- **What is missing:** (no notes recorded)
- **Suggested scope:** Ships when PF-302 (TRO-431, Backlog) ships. Smallest step: a migration creating webhook_subscriptions (app_id, event_type, target_url, encrypted signing secret, active flag) plus an /api/v1/webhooks CRUD route mounted in router.ts and gated with the already-registered requireScope('webhooks:manage') factory (api/src/platform/scopes/requireScope.ts already exists and is reusable).

### W6-R26 — MISSING
- **Quote:** "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m. Subscribers returning 5xx or timing out are retried; 4xx responses are treated as permanent failures and dead-lettered."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Retry scheduler with exactly that schedule + jitter; 5xx/timeout retried, 4xx dead-lettered immediately.
- **Tickets:** TRO-438
- **What is missing:** No deliverer, retry scheduler, or backoff logic exists anywhere in api/src (grep for backoff/exponential/retryScheduler/retry.*schedule turns up only unrelated files: ssm.ts's SSM-retry config, circuitBreaker.ts, db seed/migration-CLI retry helpers — none webhook-related).
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships — no partial version exists to point to; this is a full feature build (migration 045 + retry-schedule module with 1s/4s/16s/1m/5m/30m + jitter and 5xx/timeout-vs-4xx branching).

### W6-R27 — MISSING
- **Quote:** "After 6 failed attempts, deliveries land in a DLQ visible in the developer portal. Operators can replay manually; replays carry the original idempotency key."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** DLQ at attempt 6, surfaced in portal UI, manual replay preserving Idempotency-Key.
- **Tickets:** TRO-438, TRO-439
- **What is missing:** (no notes recorded)
- **Suggested scope:** Ships when PF-304 (deliverer/DLQ, TRO-438) and PF-503 (portal DLQ view + replay button, TRO-439) both ship — neither exists yet; both are Backlog. No smaller slice closes this gap since it requires both the DLQ mechanism and its portal surface.

### W6-R28 — MISSING
- **Quote:** "webhook_deliveries table records every attempt with subscription_id, event_id, attempt_number, response_status, response_excerpt, latency_ms. Queryable per app."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Delivery-log table with those columns; per-app query path (API + portal).
- **Tickets:** TRO-438, TRO-442
- **What is missing:** (no notes recorded)
- **Suggested scope:** Ships when PF-304 (migration 045 for webhook_deliveries, TRO-438) and PF-305 (per-app delivery-log query API, TRO-442) ship — neither the table nor the query route exists yet.

### W6-R29 — MISSING
- **Quote:** "/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Replay endpoint re-emitting a logged delivery with its original Idempotency-Key.
- **Tickets:** TRO-446
- **What is missing:** No Linear ticket in the given W6 population maps to PF-306 by title or PF-number — PLUGFORGE.MD:251 defines PF-306 ('Replay') as its own ticket-shaped unit of work, distinct from PF-304/PF-305, but no corresponding Linear issue was found in the supplied ticket list. This looks like an unticketed gap worth flagging to the PM independent of the code gap.
- **Suggested scope:** No ticket currently covers this scope; smallest fix is two-part: (1) file a PF-306 ticket, (2) once PF-304/PF-305's delivery log exists, implement POST /api/v1/webhooks/deliveries/:id/replay re-emitting the logged event with its original Idempotency-Key.

### W6-R30 — MISSING
- **Quote:** "@ship/sdk exposes resource clients: client.documents, client.issues, client.sprints, client.webhooks. Method signatures match OpenAPI spec; drift fails CI via a fitness test."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Resource-segregated SDK surface + spec↔SDK parity fitness test wired into CI.
- **Tickets:** TRO-407, TRO-422, TRO-390
- **What is missing:** No sdk/ directory, so no DocumentsClient/IssuesClient/SprintsClient/WebhooksClient classes and no spec↔SDK parity fitness test exist anywhere in the repo (confirmed by the same sdk/-absence evidence documented under W6-R9). TRO-407 (PF-401) and TRO-422 (PF-405) are both Backlog.
- **Suggested scope:** Ships when PF-401/TRO-407 (resource clients) and PF-405/TRO-422 (spec↔SDK parity fitness test wired into CI) land; PF-401 itself depends on PF-400's scaffold (TRO-405) existing first.

### W6-R31 — MISSING
- **Quote:** "ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser localStorage)."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** SDK auth helpers for both grants + ITokenStore with the three store implementations.
- **Tickets:** TRO-418, TRO-449, TRO-390
- **What is missing:** Not implemented — no sdk/ exists (see W6-R9 evidence). TRO-418/PF-404 (primary implementer) is Backlog, and also depends on PF-106/TRO-425 (device grant, currently In Progress, not yet merged) for deviceLogin() to have a real server-side flow to drive. TRO-449/PF-802 is a downstream demo that will exercise the browser localStorage store once built, not itself an implementer.
- **Suggested scope:** Ships when PF-404/TRO-418 lands: authorizationCodeFlow()/deviceLogin() + MemoryTokenStore/FileTokenStore (+ browser localStorage store, exercised by PF-802/TRO-449). Blocked on PF-106/TRO-425 (device grant) merging to main first.

### W6-R32 — MISSING
- **Quote:** "for await (const doc of client.documents.iterate()) walks pages transparently. Cursors handled internally; consumer code never sees them."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Async-iterator pagination on SDK list clients; cursors fully internal.
- **Tickets:** TRO-410, TRO-449, TRO-390
- **What is missing:** Not implemented — no sdk/ exists. TRO-410/PF-402 is Backlog and depends on PF-400 (scaffold) and PF-401 (resource clients) landing first, since there is nothing to call `.iterate()` on yet.
- **Suggested scope:** Ships when PF-402/TRO-410 lands: async-iterator iterate() on SDK list clients with cursor handling fully internal. Needs PF-400 + PF-401 first.

### W6-R33 — MISSING
- **Quote:** "verifyWebhook(headers, rawBody, secret) returns true/false in one call. Tampered bodies fail; expired timestamps fail; missing v1 header fails."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** One-call SDK verifier with the three failure modes.
- **Tickets:** TRO-413, TRO-433, TRO-390
- **What is missing:** The underlying cryptographic algorithm and shared cross-validation fixtures already exist and are well-tested via PF-303 (server-side signer.ts, Done), but the requirement explicitly names an SDK helper ('One-call SDK verifier') — no sdk/ package exists to hold it, and TRO-413/PF-403 (the ticket that wraps signer.ts's logic as an SDK-exported verifyWebhook) is Backlog.
- **Suggested scope:** Ships when PF-403/TRO-413 lands. Smaller gap than sibling SDK tickets — the algorithm and shared test vectors already exist (PF-303); PF-403 mainly needs sdk/ to exist first (PF-400) as a home for the thin wrapper + its own test suite.

### W6-R34 — MISSING
- **Quote:** "SDK errors are a discriminated union: { kind: 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server',...}. Consumers can switch on kind exhaustively."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Typed error union in the SDK, exhaustively switchable.
- **Tickets:** TRO-405, TRO-390
- **What is missing:** Zero implementation and zero design-doc coverage anywhere in the repo — grepped for ApiErrorKind, `kind: 'auth'`, SdkError, DiscriminatedError; the only hits are the requirements-inventory files themselves. Unlike the rest of the SDK surface, this specific piece (the typed error kind union) isn't even sketched in docs/architecture.md's otherwise-detailed SDK Surface section, though it is named in PF-400's Linear AC.
- **Suggested scope:** Ships when PF-400/TRO-405 lands — add the kind union type ({kind:'auth'|'rate_limit'|'not_found'|'validation'|'server',...}) + an ApiError-code-to-kind mapping function + exhaustiveness-switch tests as part of PF-400's scope.

### W6-R35 — MISSING
- **Quote:** "Per-app and per-token token-bucket limits. Public responses carry X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset; 429 responses carry Retry-After."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Two-level token buckets; headers on all v1 responses; 429 + Retry-After. (Requires exempting /api/v1 from the legacy `/api/`-prefix limiters — post-TRO-172 these are 600/min/identity + 6,000/min/IP in prod, `api/src/middleware/rate-limit.ts:130-132`; API-1's original 100/min/IP cap no longer exists.)
- **Tickets:** TRO-427, TRO-401, TRO-494, TRO-552, TRO-391
- **What is missing:** Grepped api/src for X-RateLimit, RateLimit-Limit/Remaining/Reset, Retry-After, and TokenBucket implementations (not just the string 'Token' or 'Bucket' separately) — zero hits outside comments/READMEs describing the not-yet-built feature. The only rate-limiting code that touches /api/v1 today is the exemption from the legacy per-IP/per-identity limiters (PF-004/TRO-401, Done) — that is a prerequisite, not the requirement itself. TRO-552 (Backlog) is a narrower follow-up about the exemption predicate's own test coverage at segment boundaries, tangential but related to the same code path. No ambiguity here — the code plainly does not implement token buckets or the three headers; verdict is a direct observation, not an inference.
- **Suggested scope:** Build TRO-427 (PF-500): implement per-app and per-token token-bucket limiters in api/src/platform/ratelimit/ (currently an empty stub), wire them onto the /api/v1 router, and emit X-RateLimit-Limit/X-RateLimit-Remaining/X-RateLimit-Reset on every v1 response plus Retry-After on 429s. Unit-test bucket exhaustion/refill with an injected clock (per the requirement's own acceptance evidence). This is currently deferred to post-MVP by an explicit Wave-3 scoping decision, so the gap will not close until that ticket is picked up.

### W6-R36 — MISSING
- **Quote:** "Every public API call recorded with timestamp, app client_id, user_id, route, scope used, status, latency. Queryable in the developer portal."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** public_api_audit table + recording middleware + portal query surface.
- **Tickets:** TRO-432, TRO-391
- **What is missing:** Confirmed no public_api_audit table exists: grepped api/src/db/schema.sql and every file under api/src/db/migrations/ (highest numbered is 044_oauth_tokens_authorization_code_id.sql) — no migration 046 and no public_api_audit anywhere. Grepped api/src for the literal string public_api_audit — the only two hits are the bearerAuth.ts comment and the platform/audit README, both describing the gap, not filling it. Not ambiguous: the specific migration number (046) and table name are named directly in the requirement's own PLUGFORGE AC text and confirmed absent by direct inspection, not inference.
- **Suggested scope:** Build TRO-432 (PF-501): migration 046 creating public_api_audit (timestamp, app client_id, user_id, route, scope, status, latency columns per the requirement), middleware that writes one row per /api/v1 call, and a query surface (GET /api/v1/audit, admin/owner-scoped) for the portal to read from. Currently deferred post-MVP; also a listed blocker for the portal's audit view (W6-R37) and for PF-703's audit-trail proof.

### W6-R37 — MISSING
- **Quote:** "In-app UI for: listing apps, registering apps, viewing/rotating client_secret (shown once), managing subscriptions, browsing the delivery log, replaying failed deliveries."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Developer portal in the existing Ship web app covering those six functions.
- **Tickets:** TRO-436, TRO-439, TRO-443, TRO-391
- **What is missing:** Grepped web/src case-insensitively for 'oauth' and 'webhook' — only Login.tsx, OAuthConsent.tsx (the consent screen, unrelated to app management), and main.tsx (routing) match; no portal/app-registration/webhook-subscription/delivery-log/DLQ/replay components anywhere. Also searched e2e/ for portal or oauth-app specs — none exist, consistent with no UI to test. TRO-443 (PF-504, 'Portal scope checkpoint') is a go/cut evaluation ticket about whether to build the portal at all if Epic 6 runs late — included in the ticket list as directly relevant context, but it does not itself implement any of the six UI functions.
- **Suggested scope:** Build TRO-436 (PF-502: app list/register/detail/rotate) and TRO-439 (PF-503: subscription CRUD, delivery log with pagination, DLQ view, replay button) as new pages/components in web/src. Both depend on backend groundwork that is also missing or in-progress: PF-500/501 for rate-limit/audit visibility, and PF-301/302/305/306 (webhook domain, subscriptions API, delivery log API, replay) for the delivery/DLQ half. Given the dependency chain and the existence of TRO-443's kill-criterion ticket, this may legitimately be a 'ships when Epic 6 leaves room' item rather than a small fix.

### W6-R38 — PARTIAL
- **Quote:** "terraform/ directory describing app container, database, VPC/subnets, and security groups. All provider and module versions pinned. terraform plan must run cleanly; no unpinned versions permitted."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** IaC topology (Render adaptation: no VPC/subnet/SG primitives — the adaptation must be defended per PLUGFORGE PF-902); pinned providers; clean plan.
- **Tickets:** TRO-411, TRO-488, TRO-420
- **What is missing:** App-container + database + pinned providers + a clean committed plan are all real (I could not re-run terraform myself — no terraform binary in this sandbox, confirmed via `which terraform` — so the plan-cleanliness claim rests on the committed capture, not a run I performed). The one genuine content gap: the brief's literal 'VPC/subnets, and security groups' language has no dedicated adaptation defense anywhere — docs/IAM-ADAPTATION-RENDER.md (PF-902) is scoped to IAM/task-role, not network topology, and the only network-adjacent material is a scattered one-line comment in postgres.tf plus a README table row about ip_allow_list. This isn't a blocker (Render genuinely has no VPC/SG primitives, so there's nothing more to configure), but the brief also wants the adaptation *defended*, and that defense is thin/scattered rather than consolidated.
- **Suggested scope:** Add a short paragraph to docs/IAM-ADAPTATION-RENDER.md (or a new small section in docs/architecture.md's Cross-References) explicitly naming that Render has no VPC/subnet/security-group resource type, listing what this repo's config does instead (region-scoped services, ip_allow_list defaults, private-network-only Postgres per the null ipAllowList finding in terraform/render/README.md:125), and why that's an acceptable trade for this deployment — mirroring the IAM section's own structure.

### W6-R40 — PARTIAL
- **Quote:** "Demonstrate drift: manually change a resource, run terraform plan, show the detected diff. Perform terraform destroy then terraform apply from scratch. Submit screenshots or log output proving the service came back up identically."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Drift-detection demo + destroy-redeploy with committed evidence.
- **Tickets:** TRO-415
- **What is missing:** Searched for any manual-drift demo against the live Render dashboard (PLUGFORGE.MD's own AC: 'change an env var in the Render dashboard -> terraform plan shows the diff') — found none; grep for 'dashboard.*drift'/'manual-drift' across terraform/, docs/, memory-bank/ returned nothing. The only drift demo in this repo (audit/terraform/drift-demo/, dated 2026-07-27) is the W4 local-provider exercise governed by interpretation I-01 — a different requirement (W4-R26), a different provider (hashicorp/local, 2 local_file resources), not the Render deployment this requirement is about. The destroy-redeploy half has real, executed proof, but scoped to one resource (the FleetGraph agent) from before this week's platform env vars existed — not the full current topology. TRO-415/PF-901, the ticket that owns both halves of this requirement, is still Backlog with no scorecard/review-findings entries (confirmed by grep against audit/factory/scorecard.jsonl and review-findings.jsonl).
- **Suggested scope:** Same remediation as W6-R12: TRO-415/PF-901 needs to actually run, producing both artifacts this requirement names — (1) a live dashboard-edit-then-plan-diff drift demo against terraform/render/, and (2) a destroy/apply cycle against the full current topology (ship + agent + postgres, all 8 new PF-900 env vars included), not just the agent-only slice already proven. Blocked on the human go-ahead memory-bank/progress.md:163-164 already flags.

### W6-R42 — PARTIAL
- **Quote:** "Complete the Authorization Code + PKCE flow in a Playwright test from a registered web app. Confirm that a wrong code_verifier on the token exchange returns invalid_grant (negative case is mandatory, not optional)."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — PKCE e2e + mandatory negative.
- **Tickets:** TRO-412, TRO-416, TRO-503, TRO-550, TRO-549
- **What is missing:** Identical underlying gap to W6-R3, viewed through this requirement's graded-scenario framing: the PRD asks specifically for 'a Playwright test from a registered web app' confirming the wrong-verifier negative. That exact negative case is real and passing, but lives in the vitest suite, not chained onto/after the Playwright authorize-consent flow which stops before ever calling /oauth/token. PARTIAL, not MISSING, because both halves of the mandated behavior individually exist and pass -- they are just not unified into the one Playwright artifact the requirement names.
- **Suggested scope:** Add a negative-case Playwright test to e2e/oauth-authorize.spec.ts: drive the browser through authorize -> consent to obtain a real code, then POST to /oauth/token with a wrong code_verifier and assert the 400 invalid_grant response. The negative case is already proven at the vitest/supertest level (token.test.ts:324) but not yet inside the graded Playwright spec itself.

### W6-R43 — MISSING
- **Quote:** "Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — device flow via CLI to /api/v1/me.
- **Tickets:** TRO-425, TRO-448
- **What is missing:** This graded scenario needs three things that all currently do not exist on main: the device flow itself (W6-R15's gap -- TRO-425 unmerged), a test CLI (TRO-448/PF-600 CLI scaffold + 'ship login via device flow', status Backlog, no cli/ or integrations/ directory found in the repo root listing), and /api/v1/me (PF-201/TRO-400, status In Progress, not present in v1Routes). Confirmed by direct inspection of the route table, not inferred.
- **Suggested scope:** Blocked on three separate unmerged/unbuilt pieces landing: TRO-425 (device grant, branch exists), TRO-400/PF-201 (/api/v1/me), and TRO-448/PF-600 (CLI). No small fix closes this alone -- ships when all three land.

### W6-R44 — MISSING
- **Quote:** "Enumerate every /api/v1/* route in a fitness test and assert each one (a) has an OpenAPI entry, (b) declares a scope, (c) returns the ApiError shape on failure paths, and (d) supports cursor pagination if it's a list endpoint."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — the route-enumeration fitness test with the four assertions.
- **Tickets:** TRO-404
- **What is missing:** Grepped api/web/shared/agent/e2e/scripts for 'fitness', 'route-enumeration', and 'enumerat' — no route-enumeration walk exists anywhere in the repo. TRO-404 (PF-203) is Backlog. This requirement is also structurally blocked on W6-R8/PF-202 landing first (there is no OpenAPI registry yet for assertion (a), 'has an OpenAPI entry', to check against).
- **Suggested scope:** Ships when TRO-404/PF-203 is built: a test that walks v1Router's registered stack and asserts, per route, an OpenAPI entry exists, a scope is declared, failures produce the ApiError shape, and list routes paginate. Blocked on TRO-402/PF-202 landing first for assertion (a).

### W6-R45 — MISSING
- **Quote:** "Validate the generated /api/v1/openapi.json against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert the SDK exposes a typed call for it."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — spec validity + spec→SDK parity walk.
- **Tickets:** TRO-402, TRO-422
- **What is missing:** Both halves are missing: (1) no /api/v1/openapi.json to validate (blocked on TRO-402/PF-202, same as W6-R8/W6-R21), and (2) no @ship/sdk package exists at all yet (TRO-405/PF-400 — a directory listing plus pnpm-workspace.yaml confirms it doesn't exist), so there is nothing for a spec-method walk to assert typed SDK coverage against. TRO-422/PF-405 (the parity+size gate ticket) is Backlog.
- **Suggested scope:** Ships in sequence after: TRO-402/PF-202 (spec exists) -> TRO-405/PF-400 (SDK skeleton exists) -> TRO-407/PF-401 (resource clients) -> TRO-422/PF-405 (the actual parity-walk + size-gate test this requirement describes). This is a multi-ticket dependency chain, not a small fix.

### W6-R46 — MISSING
- **Quote:** "Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s; verify the signature with the SDK helper; tamper with the body and verify the helper rejects it."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — end-to-end webhook happy path + tamper negative, ≤2s first delivery.
- **Tickets:** TRO-455, TRO-413
- **What is missing:** This graded e2e scenario requires: SDK-driven subscription creation (PF-302 + @ship/sdk, neither exists — find confirms no sdk/ directory anywhere in the repo), a working deliverer (PF-304, missing per W6-R26), and the SDK's verifyWebhook helper (PF-403/TRO-413, Backlog). None of the constituent pieces exist yet.
- **Suggested scope:** Ships only once the full chain lands: PF-302 (subscriptions API), PF-304 (deliverer), sdk/ package scaffold (PF-400, a hard dependency), and PF-403 (verifyWebhook, TRO-413). This is an integration-level graded scenario, not a single small fix.

### W6-R47 — MISSING
- **Quote:** "Make a subscriber return 500 on the first three attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each attempt) and that the fourth attempt records success in the delivery log."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — deterministic retry test (500×3 → 200 on attempt 4).
- **Tickets:** TRO-438
- **What is missing:** (no notes recorded)
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships with its deterministic-clock test suite, per PLUGFORGE.MD:249's own stated AC (500x3-then-200 with correct ≥1s/4s/16s waits).

### W6-R48 — MISSING
- **Quote:** "Force 6 consecutive failures. Verify the delivery lands in the dead-letter queue and is visible in the developer portal. Click \"Replay\" against a now-healthy subscriber and verify the replay succeeds with the original idempotency key intact."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — DLQ + portal visibility + replay with original key.
- **Tickets:** TRO-438, TRO-439
- **What is missing:** Same underlying gap as W6-R27/W6-R29 combined into one graded scenario (DLQ + portal visibility + replay-with-original-key).
- **Suggested scope:** Ships when PF-304 (TRO-438) and PF-503 (TRO-439) ship, plus a PF-306-equivalent replay implementation (currently unticketed — see W6-R29's note).

### W6-R49 — MISSING
- **Quote:** "Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, pnpm install @ship/sdk → ship login → create document → receive verified webhook in under 30 minutes elapsed (in practice, seconds)."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Graded test scenario — the TTFE drill.
- **Tickets:** TRO-455, TRO-448
- **What is missing:** No CLI package, no @ship/sdk package, no drill script, and no device-authorization-grant route (PF-106/TRO-425 is still 'In Progress', not merged) exist in the repo at 06a15f1. The full TTFE scenario this requirement describes (pnpm install @ship/sdk -> ship login -> create document -> receive verified webhook) has zero implementing code. This is a graded end-to-end scenario spanning PF-600 (CLI/ship login) and PF-603 (the drill itself); both are Backlog.
- **Suggested scope:** No small patch closes this — it requires the SDK package (PF-400/TRO-405, Backlog), the CLI with device-flow login (PF-600/TRO-448, Backlog), and the drill harness (PF-603/TRO-455, Backlog) to all exist, which in turn need PF-106's device grant route (TRO-425, In Progress) merged first. Ships when epic E6 is built per the dependency spine E0->E1->E2->{E3,E4}->E5->E6->E7 in PLUGFORGE.MD:212.

### W6-R50 — MISSING
- **Quote:** "≤ 30 min real elapsed; CI typically < 60 s"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** TTFE targets: clean-machine ≤30 min (docs only), CI <60s (p.8 table restates: "TTFE drill runtime in CI (P95)" < 60 s).
- **Tickets:** TRO-455
- **What is missing:** No drill exists to instrument, so there is no <30min or <60s target being measured anywhere in CI or docs. TRO-455 (PF-603) titled '<60s, 0% flake over 20 runs' is the ticket that would implement this target but is Backlog.
- **Suggested scope:** Ships as part of PF-603 (TRO-455): once the drill exists, it must assert its own elapsed time against a <60s CI threshold and document the <30min real-elapsed clean-machine target per PLUGFORGE.MD:275.

### W6-R51 — MISSING
- **Quote:** "OAuth Auth Code + PKCE round-trip (P95)|< 3 s"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Performance target on the PKCE round-trip.
- **Tickets:** TRO-412, TRO-416, TRO-449
- **What is missing:** Searched CHANGES.md and the codebase broadly for any P95/round-trip timing instrumentation tied to the OAuth authorize/token flow -- none exists. The requirement's own acceptance evidence names PF-802 (browser SDK demo) as the thing that 'asserts it'; PF-802/TRO-449 is Backlog with no code in the repo (confirmed: only a passing doc-comment mention in CHANGES.md, no integrations/ or sdk-demo source). No performance measurement of the PKCE round-trip exists at this pinned commit.
- **Suggested scope:** Add a timing assertion to whichever Playwright spec ends up covering the full authorize->consent->token round trip once W6-R3/W6-R42's gap closes (measure wall-clock from authorize navigation to token receipt, assert < 3s) -- currently blocked on that same missing full-flow spec, and formally on PF-802 (TRO-449) landing per the PRD's own acceptance-evidence pointer.

### W6-R52 — MISSING
- **Quote:** "Webhook delivery latency (P95, first attempt)|< 2 s"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** First-attempt delivery latency target.
- **Tickets:** TRO-438
- **What is missing:** Non-functional latency target on a system that does not exist yet; nothing to measure.
- **Suggested scope:** No small fix — this is a measured-outcome requirement that can only be assessed once PF-304's deliverer (TRO-438, Backlog) is built and instrumented with latency_ms per delivery.

### W6-R53 — MISSING
- **Quote:** "Webhook retry success rate after transient 5xx|100% within configured schedule"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Retry completeness target.
- **Tickets:** TRO-438
- **What is missing:** (no notes recorded)
- **Suggested scope:** Ships when PF-304 (TRO-438, Backlog) ships with retry tests + delivery-log evidence; same underlying build as W6-R26.

### W6-R54 — MISSING
- **Quote:** "Public API responses with rate-limit headers|100%"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Header coverage target — including error responses.
- **Tickets:** TRO-427, TRO-552, TRO-391
- **What is missing:** This is the same code gap as W6-R35 (the PDF states it twice: once as a functional requirement on p.4, once as a scored NFR target on p.6), so I traced it to the identical evidence rather than treat it as independent. Grepped for any header-setting code (res.set/res.header/setHeader) near 'RateLimit' across api/src — none found.
- **Suggested scope:** Same fix as W6-R35 (build TRO-427/PF-500). Closing this specific NFR additionally requires wiring a header-presence assertion into the route-enumeration fitness test (PF-203/TRO-404, itself Backlog and not yet written) so the 100% figure is machine-verified per-route rather than asserted by inspection.

### W6-R55 — MISSING
- **Quote:** "CLI drill harness: pnpm drill ttfe runs the full loop end-to-end against a containerized Ship instance from a clean working directory."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** The `pnpm drill ttfe` command with containerized Ship (testcontainers per repo pattern).
- **Tickets:** TRO-455
- **What is missing:** The 'pnpm drill ttfe' command does not exist anywhere in the monorepo — no script definition, no CLI harness, no testcontainers-based drill runner.
- **Suggested scope:** Ships with PF-603 (TRO-455): add a 'drill' script (root package.json) invoking a new drill harness under a new integrations/cli or a dedicated drill package, using testcontainers per the repo's existing pattern (used elsewhere for isolated DB tests) to spin up a containerized Ship instance from a clean working directory.

### W6-R56 — MISSING
- **Quote:** "Timing instrumentation: each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Per-stage ms instrumentation in the drill.
- **Tickets:** TRO-455
- **What is missing:** Since the drill itself (W6-R55) does not exist, there is no per-stage (install/login/register subscription/create document/receive webhook/verify signature) millisecond instrumentation to find. Confirmed via repo-wide grep for 'drill'/'ttfe' across all code_roots — only the three rate-limit/CORS comment hits and doc/progress mentions already cited under W6-R49/50 turned up.
- **Suggested scope:** Ships with PF-603 (TRO-455): the drill harness must record elapsed-ms per named stage and log/assert them, per PLUGFORGE.MD:275 ('Per-stage elapsed-ms instrumentation logged and asserted').

### W6-R57 — MISSING
- **Quote:** "Drill runs in CI on every PR. Any regression past the configured threshold fails the build."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** TTFE drill wired into the graded CI (GitLab; GitHub mirror) on every PR with a failing threshold.
- **Tickets:** TRO-455
- **What is missing:** Neither the graded GitLab CI nor the GitHub mirror runs any drill job on any PR — there is nothing to regress or gate. memory-bank/progress.md:183-186 records the design decision that the drill will be 'environment-dual: testcontainers locally/GitHub, native GitLab services: + direct boot in the graded pipeline' but confirms this is planned, not built ('the TTFE drill harness is new work').
- **Suggested scope:** Ships with PF-603 (TRO-455): add a CI job to both .gitlab-ci.yml and the GitHub Actions mirror that runs 'pnpm drill ttfe' on every PR and fails the build on a threshold regression, per the environment-dual design already recorded in memory-bank/progress.md:184-186.

### W6-R58 — MISSING
- **Quote:** "Webhook signature verification (SDK helper)|< 1 ms per call"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** verifyWebhook performance target.
- **Tickets:** TRO-413, TRO-433, TRO-390
- **What is missing:** No perf test exists for the verify-side path at all (only sign() is perf-tested, by a different ticket/module), and neither lives in an SDK package. This is a non-functional target on an artifact (the SDK's verifyWebhook, W6-R33) that does not exist yet.
- **Suggested scope:** Ships when PF-403/TRO-413 lands with its own <1ms perf test for the SDK's verifyWebhook. A thin wrapper is likely to inherit signer.ts's already-proven sub-millisecond verify() performance, but that has not been measured directly nor packaged as SDK code yet.

### W6-R59 — MISSING
- **Quote:** "Drill flake rate over 20 consecutive CI runs|0% (any flake = bug in the drill or the platform)"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Zero-flake target tracked across 20 CI runs; a flake is a P0 platform/drill bug, never retry-masked.
- **Tickets:** TRO-455
- **What is missing:** This is a process metric that presupposes the drill (W6-R55/56/57) is live in CI. Since none of that exists, there is no run history to measure a 0% flake rate against. Even after the drill is built, this requirement cannot be VERIFIED by a single code change — it needs 20 consecutive live CI runs to observe.
- **Suggested scope:** Not closable by a code change alone. First requires PF-603 (TRO-455) to ship and go live in the graded CI on every PR (closing W6-R55-57), then requires observing 20 consecutive runs with zero flakes — an elapsed-time/process requirement, not a point-in-time code fix.

### W6-R60 — MISSING
- **Quote:** "SDK install size (production deps only)|< 250 KB minified + gzipped"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** SDK size budget, CI-checked.
- **Tickets:** TRO-422, TRO-390
- **What is missing:** No CI job checks bundle size for anything named sdk (grepped .gitlab-ci.yml, root package.json, and .github — zero hits for size-limit/bundlesize/250KB). Cannot be measured at all until sdk/ exists to measure; TRO-422/PF-405 is Backlog.
- **Suggested scope:** Ships when PF-405/TRO-422 lands: add a CI job (e.g. size-limit or an esbuild metafile check) gating sdk/'s production-dependency bundle at 250KB min+gz. No existing CI size-check infrastructure to extend — entirely new job, and requires sdk/ (PF-400) to exist first.

### W6-R61 — MISSING
- **Quote:** "Implement at Least 5 of the Following Integrations / Flows"
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** ≥5 of: CLI (must-ship), Slack (should-ship), Browser SDK demo, GitHub integration, refresh-rotation drill, Idempotency-Key drill, plugin runtime (stretch). NOTE: the Background (p.1) says "at least one working reference integration (a CLI tool is must-ship)" — the ≥5 line is the stricter, explicitly-scored one; treat ≥5 as binding.
- **Tickets:** TRO-394, TRO-448, TRO-445, TRO-447, TRO-449, TRO-451, TRO-453, TRO-454
- **What is missing:** Directory-existence check (`ls integrations/`, `ls sdk/`) confirms neither exists in the working tree at 06a15f1. PLUGFORGE.MD §1.4.2 commits to exactly 5: CLI (must-ship) + refresh-rotation drill + Idempotency-Key drill + Browser SDK demo + Slack; GitHub App and plugin runtime are time-boxed stretch. All 8 matching Linear tickets (the 4-committed-in-E8 + CLI-in-E6 + 2 stretch + the E8 epic) are status Backlog. memory-bank/activeContext.md's 2026-08-13 entry confirms current factory focus is still E0-E2 (MVP path), nowhere near E6/E8. Zero of 5 required integrations exist.
- **Suggested scope:** Not a small fix — this is a multi-epic dependency chain. Every one of the 5 committed flows needs sdk/ (PF-400-405, Epic E4) to exist first, since integrations/* is constitutionally forbidden from importing api/src/ directly (PF-003's own enforcement script, already built and CI-wired). Sequence: E4 (sdk/) → E6 (PF-600 CLI) → E8 (PF-800/801/802/803). None have landed.

### W6-R62 — MISSING
- **Quote:** "CLI tool with device flow — ship login, ship docs ls/get/create, ship webhooks tail (must-ship)."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** The CLI with those exact commands; `ship webhooks tail` streams verified deliveries.
- **Tickets:** TRO-448, TRO-450, TRO-452
- **What is missing:** Repo-wide search for 'ship login', 'ship docs', 'ship webhooks', 'pnpm drill' finds these strings only in PLUGFORGE.MD (the spec) and docs/architecture.md (a design diagram) — never in actual source. This tracks exactly with the three PF-600/601/602 tickets all sitting in Backlog, and with their prerequisite PF-106 device-grant route (TRO-425) still In Progress and unmerged, so 'ship login' has no backend endpoint to call against yet either.
- **Suggested scope:** Ships when PF-600 (TRO-448, CLI scaffold + device-flow ship login), PF-601 (TRO-450, ship docs ls/get/create), and PF-602 (TRO-452, ship webhooks tail) are all implemented — three separate Backlog tickets under EPIC E6 (TRO-392). PF-600 additionally needs PF-106's device authorization grant route (TRO-425, currently In Progress) merged first, since the CLI's login command has nothing to call without it.

### W6-R63 — PARTIAL
- **Quote:** "the platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns — exactly as in Part 2."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** No LLM calls anywhere in the platform layer; agent unchanged in cost shape.
- **Tickets:** TRO-434
- **What is missing:** Two-part requirement: (a) the platform layer makes zero LLM calls — TRUE for everything built so far, confirmed by direct grep, a real check not an inference; (b) the agent's LLM cost shape is unchanged by the rewire — UNVERIFIABLE yet because the rewire (Epic 7, PF-701-704) hasn't started, so there is no 'after' state to compare against agent/cost-ledger-snapshot.jsonl's pre-rewire baseline. Marked PARTIAL rather than MISSING because part (a) is affirmatively, currently true and independently checked — not merely undisclosed.
- **Suggested scope:** No code change needed for the negative claim itself (the grep sweep already confirms zero LLM-client imports under api/src/platform). Once Epic 7 (PF-700-704, agent SDK rewire) lands, capture a cost-ledger before/after comparison (agent/cost-ledger-snapshot.jsonl before vs. after the rewire) proving token volume is unchanged -- that before/after proof is the only outstanding half of this requirement's acceptance evidence.

### W6-R64 — MISSING
- **Quote:** "LLM API spend during the agent rewire (Epic 7) — track per-day spend while migrating direct service calls to SDK calls; confirm the rewire does not change token volume."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Dev-cost tracking obligations (this plus CI minutes, Playwright compute, spec-gen overhead, delivery-log storage — same list, p.9).
- **Tickets:** TRO-434, TRO-440
- **What is missing:** grep across docs/ for 'token volume', 'webhook fanout', '100k users', 'agent active rate' (the PF-905 §9-10 content this requirement's sibling W6-R65 also needs) returns zero matches anywhere in the repo. TRO-434 (PF-905) and TRO-440 (PF-704, whose AC literally reads 'cost-ledger before/after shows unchanged token volume (feeds PF-905)') are both status Backlog. There is no per-day spend tracking during the rewire because the rewire (PF-701-704) has not started.
- **Suggested scope:** Ships when Epic 7 ships — there is no 'per-day spend while migrating' to track until PF-701-704 actually perform the migration. Once they land, PF-905 (TRO-434) needs a dedicated doc pulling a pre/post pair from agent/src/costTracking.ts's ledger, distinct from the existing AI-COST-ANALYSIS.md (which should stay as-is; it answers a different question about the build process itself).

### W6-R65 — MISSING
- **Quote:** "Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Production cost projections at 100/1k/10k/100k users with explicit assumptions: webhook fanout ratio, agent active rate, storage retention windows with rationale (p.9–10 "Include Assumptions").
- **Tickets:** TRO-434, TRO-395
- **What is missing:** TRO-434 (PF-905: AI cost analysis) is status Backlog and has no CHANGES.md entry (grepped, zero hits) — not yet built. The only doc at the expected path is the prior week's (W5) cost report, reused-path but wrong content, not a partial draft of the W6 deliverable. Nothing in api/, terraform/, docs/, or memory-bank/ contains a platform-cost-at-scale tier table.
- **Suggested scope:** PF-905 ships when TRO-434 lands: a new committed doc (or a rewritten AI-COST-ANALYSIS.md section) with the 100/1k/10k/100k-user cost tier table and stated assumptions for webhook fanout ratio, agent active rate, and delivery-log/audit-row retention windows, traceable to ledger/CI data per the ticket's own AC.

### W6-R66 — PARTIAL
- **Quote:** "Node.js + Express (existing Ship stack); TypeScript strict mode required; Zod for request/response schemas and OpenAPI generation."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** New platform/SDK code under TypeScript strict mode; Zod schemas drive the spec.
- **Tickets:** (none)
- **What is missing:** The constraint holds for everything that exists today: all four workspace packages (including api/src/platform/) inherit strict:true from the root tsconfig, and platform code that exists (openapi registry, webhooks/events.ts, v1 documents resource) uses Zod for schemas feeding OpenAPI generation. But the requirement's own acceptance evidence names sdk/ specifically, and no sdk/ workspace package exists in this repo yet (that's W6-R9/R30-34's territory, tracked by other clusters) — so half of the named surface is unverifiable by absence rather than by failure. No single ticket implements this requirement; it's a blanket engineering standard PLUGFORGE.MD states once and every E1-E4 ticket is expected to honor via inherited tsconfig, so 0 tickets is the honest ticket mapping rather than forcing a match.
- **Suggested scope:** Closes automatically once the sdk/ workspace package (W6-R9/PF-400, TRO-405) is created with its own strict:true tsconfig — no separate action needed beyond ensuring that ticket's tsconfig extends or matches the root strict config.

### W6-R67 — MISSING
- **Quote:** "the Part 2 agent is rewired to authenticate as a first-party OAuth app and consume the public API through the SDK — same scopes, same rate limits, same audit trail."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Epic 7: agent reads via app-identity OAuth, all traffic through @ship/sdk and /api/v1, provable in public_api_audit rows (per-epic proof, p.13).
- **Tickets:** TRO-393, TRO-417, TRO-423, TRO-428, TRO-435, TRO-440, TRO-414
- **What is missing:** grep -rn 'ship_app_fleetgraph' across agent/ and api/src/db/migrations/ returns zero matches (no seeded first-party app — PF-701). grep -rn 'AGENT_PLATFORM_MODE' across the whole repo (excluding node_modules) returns zero matches (no mode flag — PF-702/703/704). All of E7's tickets (TRO-393 epic, TRO-417 human checkpoint, TRO-423/428/435/440) are status Backlog, as is TRO-414 (PF-205, the v1 agent-read-surface ticket whose own title says it 'unblocks E7' — a hard prerequisite). Same-store, no CHANGES.md entries exist for any of TRO-393/414/417/423/428/435/440.
- **Suggested scope:** Epic-sized, not a small fix. Dependency chain per PLUGFORGE.MD's dependency spine: PF-205 (agent read surface, unblocks E7) → sdk/ (PF-400-405, Epic E4) → PF-700 (🔔 human checkpoint — blocks all E7 code until Troy acks per PLUGFORGE.MD §0.1) → PF-701 (seed first-party app) → PF-702 (reads via SDK) → PF-703 (gated writes via SDK) → PF-704 (flag matrix + audit proof). None have landed.

### W6-R68 — MISSING
- **Quote:** "The real queue-backed deliverer is tested with deterministic clock injection — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Deliverer tests use an injected clock; zero setTimeout-based waiting.
- **Tickets:** TRO-438
- **What is missing:** Requirement specifically concerns 'the real queue-backed deliverer' tests, which have no code to trace since PF-304 is unbuilt (TRO-438, Backlog). The Clock-injection convention this requirement mandates is already precedented elsewhere in the repo (signer.ts's Clock type + signer.test.ts's clockAt()), which the PF-304 implementer will presumably reuse, but that is a prediction, not evidence of compliance.
- **Suggested scope:** Ships when PF-304's deliverer is actually built and tested (TRO-438, Backlog) using deterministic clock injection — the pattern to follow already exists in api/src/platform/webhooks/signer.ts's Clock type and __tests__/signer.test.ts's clockAt() helper.

### W6-R69 — PARTIAL
- **Quote:** "External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced by a workspace dependency rule."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** integrations/* depend only on @ship/sdk, enforced by workspace/lint rules.
- **Tickets:** TRO-399, TRO-500, TRO-496
- **What is missing:** Ran the actual regression test directly (not part of a bare pnpm test) in the scratch worktree: `node --test scripts/__tests__/check-integration-deps.test.mjs` — 10/10 pass, 0 fail, including the violation-detection case. The enforcement mechanism itself is real, tested green, and wired into both the graded GitLab pipeline and the GitHub mirror — that part of the requirement ('Enforced by a workspace dependency rule') is genuinely built. What's still absent is the substantive fact the requirement's first clause describes: 'External integrations live in integrations/' — no such directory or package exists yet (confirmed: pnpm-workspace.yaml has no integrations/* member, and `ls integrations/` fails). PARTIAL rather than VERIFIED because the rule currently has nothing real to enforce against; PARTIAL rather than MISSING because the enforcement half is not merely planned but built, tested, and CI-wired.
- **Suggested scope:** Ships automatically once any package lands under integrations/* (E6/E8 work, e.g. PF-600 CLI scaffold via TRO-448) -- the enforcement script (scripts/check-integration-deps.mjs) is already built, tested (10/10), and wired into both CI pipelines. No additional code is needed for the rule itself, only a real integrations/* package for it to enforce against.

### W6-R72 — MISSING
- **Quote:** "The five-line story is the demo: open a fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail produces a verified signed delivery. Then switch to the dev portal and replay one delivery."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Demo video (3–5 min) with that exact narrative.
- **Tickets:** TRO-444, TRO-395
- **What is missing:** TRO-444 (PF-908) is status Backlog with no CHANGES.md entry. Both demo-script files present in docs/submission/ are for earlier weeks; neither is a draft of the W6 five-line-story script.
- **Suggested scope:** Ships when TRO-444/PF-908 lands: a new (or renamed/rewritten) script file with the five-line-story timecoded walkthrough — fresh terminal → pnpm install @ship/sdk → ship login → ship docs create → ship webhooks tail verified delivery → switch to portal, replay one delivery.

### W6-R73 — MISSING
- **Quote:** "All three phases completed with written answers; saved AI conversation attached as a reference artifact."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Pre-Search document (Appendix phases 1–3) with real answers + the saved conversation artifact.
- **Tickets:** TRO-429, TRO-395
- **What is missing:** TRO-429 (PF-904, HUMAN CHECKPOINT) is status Backlog; no CHANGES.md entry. The only pre-search document in the repo is the pre-existing FleetGraph (W5) one — same generic filename pattern, unrelated content (agent trigger model, node design, state management — not OAuth/platform topics, hours/day, skill inventory, budget ceilings).
- **Suggested scope:** Ships when TRO-429/PF-904 lands: either a new PRESEARCH-PLUGFORGE.MD (or equivalent) with the three PlugForge-specific phases pre-filled from the PRD plus Troy's real answers, and the saved AI conversation attached as a reference artifact — this is a HUMAN CHECKPOINT ticket, so it is also gated on Troy's actual input, not code alone.

### W6-R74 — MISSING
- **Quote:** "Live at /api/v1/openapi.json on the deployed instance, plus a static copy at docs/openapi.json in the repo. Validate against the OpenAPI schema."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Deployed spec URL + committed docs/openapi.json kept in parity (CI diff).
- **Tickets:** TRO-409, TRO-388
- **What is missing:** No `docs/openapi.json` file exists anywhere in the repo (repo-wide find returned nothing). No CI job in `.github/workflows/` (ci.yml, ci-failure-rollback.yml, agent-rollback-check.yml) or `.gitlab-ci.yml` mentions openapi. TRO-409 (PF-204) is status Backlog with no CHANGES.md entry. This requirement is fully blocked upstream: PF-202 (the v1 OpenAPI generator itself, TRO-402, status In Progress) hasn't landed either, so there is no live /api/v1/openapi.json to snapshot yet.
- **Suggested scope:** Blocked upstream by PF-202 (TRO-402, In Progress) landing the v1 generator + serving route first. Once that exists, PF-204/TRO-409 is: commit a docs/openapi.json snapshot, add a CI job that regenerates and diffs it against the live-generated spec, and fail the build on drift.

### W6-R75 — MISSING
- **Quote:** "Before → fix → after → proof. For Epic 6, proof is the TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app authentication."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Per-epic write-ups with the two named proofs.
- **Tickets:** TRO-437, TRO-395
- **What is missing:** TRO-437 (PF-906) is status Backlog, no CHANGES.md entry. No per-epic (E0-E9) before/fix/after/proof write-ups exist anywhere under docs/ or memory-bank/ for the PlugForge epics; E6 (TTFE drill) and E7 (agent rewire) themselves are Backlog/In Progress so their proofs (CI-green drill, audit-log rows) don't exist yet either.
- **Suggested scope:** Blocked on the epics themselves landing first (E6 TTFE drill, E7 agent rewire) since the proof artifacts this requirement names are their outputs; the write-up document itself (TRO-437) is otherwise a same-size effort to PF-100/PF-903's doc tickets once those epics are done.

### W6-R76 — MISSING
- **Quote:** "Strong candidates: OAuth Device Authorization Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a developer-experience pattern."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Three discovery write-ups drawn from these candidates.
- **Tickets:** TRO-437, TRO-395
- **What is missing:** Same ticket (TRO-437/PF-906, Backlog) and same missing-artifact situation as W6-R75 — DISCOVERY.md exists at the expected path but is the prior week's content, not PlugForge-specific.
- **Suggested scope:** Same as W6-R75: ships when TRO-437/PF-906 lands a rewritten (or new) discovery doc drawing from the four named PlugForge candidates (Device Grant, zod-OpenAPI fitness parity, HMAC anti-replay, async-iterator pagination) rather than the W4/W5 audit discoveries currently at that path.

### W6-R77 — PARTIAL
- **Quote:** "Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus credentials in the README. Dev portal reachable; OpenAPI spec resolvable."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Grader-access deliverable — extends W6-R11 with README credentials + portal reachability.
- **Tickets:** TRO-441, TRO-411, TRO-402, TRO-436
- **What is missing:** README credentials + one-command setup + the seeded read-only grader app are real and done (TRO-441/PF-907, Done). The other two DoD items this requirement names verbatim — 'Dev portal reachable' and 'OpenAPI spec resolvable' — are not yet buildable: no portal component exists anywhere under web/src (grep for portal/developer components found nothing), and /api/v1/openapi.json is not registered in the v1 router. The README itself already discloses this gap in plain language rather than claiming completeness, which is worth noting as good practice, but it doesn't change the verdict: two of the four named sub-requirements are genuinely missing at the code level, not merely unverified live.
- **Suggested scope:** Land TRO-402/PF-202 (openapi.json route) and at minimum TRO-436/PF-502 (portal — even a bare app-registration/detail page counts as 'reachable'). Once both exist, re-run this check against a real deploy for the live-probe half; the credentials/README/seed half is already closed.

### W6-R78 — MISSING
- **Quote:** "Tag @GauntletAI. The screenshot is the ship webhooks tail terminal showing a verified signed event arriving in real time."
- **Source:** GFA_Week_6_PlugForge.pdf
- **Meaning in code:** Social post deliverable with the specified screenshot.
- **Tickets:** TRO-444, TRO-395
- **What is missing:** Same underlying ticket as W6-R72 (TRO-444/PF-908, Backlog, no CHANGES.md entry) — both the demo-video and social-post halves of PF-908 are unbuilt. All social-post drafts in docs/submission/ are for the earlier weeks' audit work.
- **Suggested scope:** Ships alongside W6-R72 when TRO-444/PF-908 lands: a new social-post draft tagging @GauntletAI with a screenshot of `ship webhooks tail` showing a verified signed event arriving — depends on the CLI (PF-600/TRO-448, Backlog) and webhook delivery pipeline (E3, mostly Backlog) existing first to produce a real screenshot.

## Orphan tickets

- TRO-396 "PF-001: Ship has no public API surface — platform scaffold + /api/v1 router (request IDs, public CORS)" — Foundational scaffolding ticket (Done). Its code (router.ts, requestIdMiddleware, public CORS setup) is cited as supporting EVIDENCE across many other requirements (W6-R4, R5, R6, R8, R11, R15, R43, etc.), but no PDF-graded requirement's own quote is specifically about the scaffold itself — the brief's requirement lines start from OAuth features (W6-R2 onward). Not a tracer oversight: there is no requirement line for PF-001 to attach to.
- TRO-490 "Pre-existing: swagger.ts YAML converter emits mis-indented YAML (openapi.yaml) — JSON spec unaffected" — Internal tooling bug found incidentally during W6 work on a pre-existing (pre-W6) script; not a PF-numbered requirement ticket and no PlugForge brief requirement covers YAML-output formatting of the internal Swagger converter.
- TRO-501 "Route-level createIssueSchema accepts 'none' priority — absent from IssuePriority union and OpenAPI schema" — A bug found in the internal (non-v1) issues route's schema, incidental to W6 work; not a PF-numbered ticket and no PlugForge brief requirement covers internal issue-priority validation.
- TRO-551 "OpenAPI registry + MCP executor hardcode the /api prefix — non-/api routes (/oauth/*) cannot be registered without shipping 404ing MCP tools" — Ship-internal MCP/OpenAPI tooling fix (Done), thematically adjacent to PF-202 (already covered by W6-R8/R11/R21/R45 via TRO-402) but not itself the subject of any graded requirement quote — no PF number, and none of the 79 requirements name it.