# PlugForge — Week 6 Platform & Public API — Linear tickets (team TRO), pulled 2026-08-16 ~13:45Z

113 issues in project. Format: `TICKET | status | parent | title`

TRO-613 | In Progress | — | e2e/program-mode-week-ux.spec.ts "Phase 2 Continued: Progress Graph" cluster (9 tests) asserts text WeekProgressGraph.tsx never renders
TRO-612 | Done | — | webhooks.liveServer.test.ts: oauthAppId setup guard should fail loudly, not skip
TRO-611 | Done | TRO-388 | PATCH /api/v1/documents/:id does not check visibility — any documents:write token can overwrite another user's private document content
TRO-610 | Done | — | Absolute session-timeout "I Understand" button silently extends the session it says cannot be extended
TRO-609 | Done | — | e2e/program-mode-week-ux.spec.ts: "Issues tab has sprint filter dropdown" fails, cascades to 30 skipped tests via file-level serial mode
TRO-608 | Duplicate | — | GHCR image build broken: webhooks.test.ts imports across Docker build-context boundary into docs/
TRO-607 | Done | — | SDK createSubscription() REQUEST body drifts from real server shape
TRO-606 | Duplicate | — | GHCR image-build check broken on main — TRO-447/PF-801's test imports docs/submission/ outside the Docker build context
TRO-605 | Done | TRO-388 | GET /api/v1/documents/:id omits content/visibility/created_by/completed_at — sdk-mode agent reads degrade silently
TRO-604 | Done | TRO-389 | GHCR image build broken on main — webhooks.test.ts imports docs/submission/ outside Docker build context
TRO-603 | Done | — | Inject the app's shared webhook deliverer into the replay route (retry siblings currently orphaned)
TRO-602 | Done | — | Shared /api/v1 cursor pagination silently drops rows within the same millisecond (pagination.ts precision loss)
TRO-601 | Done | TRO-390 | CI type-check runs before @ship/sdk is built — TS2307 on any workspace consumer's fresh checkout
TRO-600 | Done | — | FileTokenStore.set() is not atomic — a crash mid-write can corrupt ~/.ship/credentials.json
TRO-599 | Done | — | SDK response types drift from real server shapes: WebhookSubscription + WebhookDelivery
TRO-598 | In Progress | — | PF-800 follow-up: machine-readable error discriminator for /oauth/token invalid_grant reuse  (PR #274 open)
TRO-597 | Done | — | Chain the PKCE e2e spec through /oauth/token → /api/v1/me (closes W6-R3/R42)
TRO-596 | Done | — | program-mode-week-ux.spec.ts tests UI copy ("Who should own") that doesn't exist in web/src (pre-existing)
TRO-595 | Done | — | admin-workspace-members.spec.ts: "can add existing user" click times out (pre-existing)
TRO-594 | Done | — | accessibility-remediation.spec.ts: tooltip stays visible past hide timeout on focus (pre-existing)
TRO-593 | Done | — | session-timeout.spec.ts: 29/58 tests crash the browser context (60s timeout, pre-existing)
TRO-592 | Backlog | — | Shared pagination-router factory opportunity across v1 resources
TRO-591 | In Review | — | Composite DB index opportunity flagged by PF-201's pagination work  (PR #277 open)
TRO-590 | In Progress | — | CodeQL js/missing-rate-limiting has a blind spot: flags test-only Express apps as production routes
TRO-589 | In Progress | — | Device-grant user_code stored plaintext, not hashed  (PR #272 open)
TRO-588 | In Progress | — | /oauth/* routes have no route-scoped rate limiting  (PR #269 open, conflicting)
TRO-587 | Done | — | CodeQL js/insufficient-password-hash false-positive on oauth/credentials.ts — needs formal dismissal
TRO-552 | In Review | TRO-386 | v1-exemption boundary predicate untested at segment edges — /api/v10 and /api/v1foo  (PR #275 open)
TRO-551 | Done | TRO-388 | OpenAPI registry + MCP executor hardcode the /api prefix — non-/api routes (/oauth/*) cannot be registered
TRO-550 | Done | TRO-387 | OAuth consent screen shows generic "This application" — add trusted app-info lookup by client_id
TRO-549 | In Progress | — | E2E login-flow assertions accept any non-/login URL as proof of sign-in (6 sites)
TRO-503 | Done | TRO-395 | PF-103 follow-up: CloudFront has no ordered_cache_behavior for /oauth/* — authorize flow unreachable in prod deploy
TRO-501 | Done | TRO-388 | Route-level createIssueSchema accepts 'none' priority — absent from IssuePriority union and OpenAPI schema
TRO-500 | In Progress | TRO-386 | PF-003 follow-up: boundary lint misses dynamic import() — ImportExpression never hooked
TRO-496 | Backlog | TRO-386 | PF-003 follow-up: boundary-lint hardening — optionalDependencies bypass + untested bare **/routes pattern
TRO-495 | Done | TRO-386 | PF-002 follow-up: errors.test.ts never asserts httpStatus — 400/401/403/429 mappings unverified
TRO-494 | Done | TRO-386 | PF-004 follow-up: source-IP limiter exemption structurally unproven at 601-request volume — make thresholds test-configurable
TRO-493 | In Progress | TRO-387 | PF-102 follow-up: oauth-apps route error shape contradicts registered ErrorResponseSchema on all 5 error responses  (PR #268 open, conflicting)
TRO-492 | Done | TRO-387 | PF-102 follow-up: rotation lost-update race — FOR UPDATE + workspace_id predicate + concurrent-rotation test
TRO-491 | Backlog | TRO-387 | PF-107 follow-up: scopes typing in generated OpenAPI — decide registry-codegen vs documented tradeoff
TRO-490 | Backlog | TRO-388 | Pre-existing: swagger.ts YAML converter emits mis-indented YAML (openapi.yaml) — JSON spec unaffected
TRO-489 | Done | TRO-386 | PF-002/PF-107 follow-up: consolidate the duplicated ApiError helper after both merge
TRO-488 | Done | TRO-395 | PF-900 follow-up: terraform input hardening — secret/number validation blocks + verify-script block-scoped greps
TRO-455 | Done | TRO-392 | PF-603: TTFE drill in CI — the graded metric (<60 s, 0% flake over 20 runs)
TRO-454 | Backlog | TRO-394 | PF-805: (STRETCH, time-boxed 1 day) In-process plugin runtime — isolated-vm, one hook
TRO-453 | Backlog | TRO-394 | PF-804: (STRETCH, time-boxed 1 day) GitHub App — Ship issues ⇄ GitHub PRs
TRO-452 | Done | TRO-392 | PF-602: ship webhooks tail — the demo money shot
TRO-451 | Done | TRO-394 | PF-803: Slack integration — verified Ship webhooks → channel posts
TRO-450 | Done | TRO-392 | PF-601: ship docs ls | get | create — via SDK only
TRO-449 | Done | TRO-394 | PF-802: Browser SDK demo — PKCE SPA, no secret in browser
TRO-448 | Done | TRO-392 | PF-600: CLI scaffold + ship login via device flow
TRO-447 | Done | TRO-394 | PF-801: Idempotency-Key drill — replay dedupe contract as e2e
TRO-446 | Done | TRO-389 | PF-306: Replay from the delivery log — original Idempotency-Key preserved
TRO-445 | Done | TRO-394 | PF-800: Refresh-rotation drill — the stolen-token story as narrated e2e
TRO-444 | Backlog | TRO-395 | PF-908: Demo assets + social post — @GauntletAI with the verified-event screenshot
TRO-443 | Done | TRO-391 | PF-504: Portal scope checkpoint — written go/cut decision (PM, no code)
TRO-442 | Done | TRO-389 | PF-305: Delivery log API — every attempt visible, paginated + filterable
TRO-441 | Done | TRO-395 | PF-907: Grader access — seeded read-only app, README one-command, PUBLIC repo check
TRO-440 | Done | TRO-393 | PF-704: Flag matrix in CI + audit-trail proof — the Epic 7 submission evidence
TRO-439 | Done | TRO-391 | PF-503: Portal — subscriptions, delivery log, DLQ, replay button
TRO-438 | Done | TRO-389 | PF-304: Deliverer + retries + DLQ — deterministic clock, every attempt persisted (migration 045)
TRO-437 | Done | TRO-395 | PF-906: Per-epic write-ups + three discoveries — provenance-disciplined
TRO-436 | Done | TRO-391 | PF-502: Portal — app registration/detail/rotate with shown-once secret UX
TRO-435 | Done | TRO-393 | PF-703: Gated writes via SDK — per-call client with the acting human's token
TRO-434 | Done | TRO-395 | PF-905: AI cost analysis — figures traceable to ledger/CI data, not vibes
TRO-433 | Done | TRO-389 | PF-303: HMAC signer — Ship-Signature t=,v1= with constant-time compare
TRO-432 | Done | TRO-391 | PF-501: Public API audit trail (migration 046) + /api/v1/audit
TRO-431 | Done | TRO-389 | PF-302: Webhook subscriptions API — whsec_ shown once, AES-256-GCM at rest (migration 044)
TRO-430 | Done | TRO-387 | PF-107: Scope registry + v1 bearer middleware — both token classes, 403 names the missing scope
TRO-429 | Backlog | TRO-395 | PF-904: 🔔 HUMAN CHECKPOINT — pre-search answers + demo recording (needs Troy)
TRO-428 | Done | TRO-393 | PF-702: Agent reads via SDK behind AGENT_PLATFORM_MODE flag — parity-tested per method
TRO-427 | Done | TRO-391 | PF-500: Token buckets per app + per token, headers on 100% of v1 responses
TRO-426 | Done | TRO-389 | PF-301: Domain write path + IEventBus — consolidate inline document writes into documentService
TRO-425 | Done | TRO-387 | PF-106: Device Authorization Grant (RFC 8628) — ship login's engine
TRO-424 | Done | TRO-395 | PF-903: docs/architecture.md — the brief's mandated sections, starts Day 1
TRO-423 | Done | TRO-393 | PF-701: Seed first-party app ship_app_fleetgraph — idempotent, secret via env
TRO-422 | Done | TRO-390 | PF-405: Parity + size gates — spec↔SDK fitness, <250 KB min+gz in CI
TRO-421 | Done | TRO-387 | PF-105: Refresh rotation + family invalidation — stolen-token detection
TRO-420 | Done | TRO-395 | PF-902: IAM adaptation memo — AWS least-privilege ⇄ Render's permission model
TRO-419 | Done | TRO-389 | PF-300: Event registry — 8 event types with Zod schemas, events as data
TRO-418 | Done | TRO-390 | PF-404: SDK auth helpers — deviceLogin, PKCE flow, ITokenStore, single-flight refresh
TRO-417 | Done | TRO-393 | PF-700: 🔔 HUMAN CHECKPOINT — agent-rewire review for Troy (blocks E7 code)
TRO-416 | Done | TRO-387 | PF-104: /oauth/token — authorization_code + PKCE + client_credentials, negative cases mandatory
TRO-415 | Backlog | TRO-395 | PF-901: Destroy-redeploy + drift proof — ⚠️ HUMAN GO-AHEAD required before destroy
TRO-414 | Done | TRO-388 | PF-205: v1 agent read surface — all 10 FleetGraph reads mapped to public endpoints (unblocks E7)
TRO-413 | Done | TRO-390 | PF-403: verifyWebhook — one call, constant-time, <1 ms
TRO-412 | Done | TRO-387 | PF-103: /oauth/authorize + consent screen (S256-only PKCE, exact redirect_uri match)
TRO-411 | Done | TRO-395 | PF-900: Terraform extension — every new env var and service in terraform/render (Day 1 defense material)
TRO-410 | Done | TRO-390 | PF-402: Async-iterator pagination — consumers never see cursors
TRO-409 | Done | TRO-388 | PF-204: Static spec committed + parity in CI — drift fails the build
TRO-408 | Done | TRO-387 | PF-102: No way to register an OAuth app — admin registration, once-only secret, rotation
TRO-407 | Done | TRO-390 | PF-401: SDK resource clients — documents/issues/sprints/webhooks matching the spec
TRO-406 | Done | TRO-387 | PF-101: OAuth schema — migrations 042 + 043 (apps, codes, tokens, device codes, api_tokens.scopes)
TRO-405 | Done | TRO-390 | PF-400: @ship/sdk scaffold + core client — zero deps, typed errors, me()
TRO-404 | Done | TRO-388 | PF-203: Route-enumeration fitness test — the drift gate for every v1 route
TRO-403 | Done | TRO-387 | PF-100: 🔔 HUMAN CHECKPOINT — OAuth study brief for Troy (blocks all E1 code)
TRO-402 | Done | TRO-388 | PF-202: OpenAPI 3.1 generator + /api/v1/openapi.json
TRO-401 | Done | TRO-386 | PF-004: Legacy /api/ limiters strangle the public API — exempt /api/v1 (prod-shaped proof)
TRO-400 | Done | TRO-388 | PF-201: Issues, sprints, me — typed views over the unified document model
TRO-399 | Done | TRO-386 | PF-003: Nothing stops platform code importing internal routes — boundary lint, Day 1 one-way door
TRO-398 | Done | TRO-388 | PF-200: Documents resource — cursor-paginated list/get/create with scopes
TRO-397 | Done | TRO-386 | PF-002: Public API errors must never leak internals — ApiError contract + v1 error middleware
TRO-396 | Done | TRO-386 | PF-001: Ship has no public API surface — platform scaffold + /api/v1 router (request IDs, public CORS)
TRO-395 | Backlog | — | EPIC E9 — Infrastructure, docs, submission (PF-900–908)
TRO-394 | Backlog | — | EPIC E8 — Reference integrations (PF-800–805)
TRO-393 | Backlog | — | EPIC E7 — Agent as platform citizen 🔔 (PF-700–704)
TRO-392 | Backlog | — | EPIC E6 — CLI + TTFE drill (PF-600–603)
TRO-391 | Backlog | — | EPIC E5 — Rate limiting, audit, portal (PF-500–504)
TRO-390 | Backlog | — | EPIC E4 — @ship/sdk (PF-400–405)
TRO-389 | Backlog | — | EPIC E3 — Webhooks (PF-300–306)
TRO-388 | Backlog | — | EPIC E2 — Public resources & OpenAPI (PF-200–205)
TRO-387 | Backlog | — | EPIC E1 — OAuth core 🔔 (PF-100–107)
TRO-386 | Backlog | — | EPIC E0 — Boundary & error contract (PF-001–004)

Status tally: 82 Done · 19 Backlog (10 of them EPIC parents; 2 stretch TRO-453/454) · 8 In Progress · 2 In Review · 2 Duplicate
