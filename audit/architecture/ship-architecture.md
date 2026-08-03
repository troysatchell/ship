# Ship — application architecture
292 source files across api/web/shared, plus the AWS runtime path · troysatchell/Ship @ 791380a (2026-08-01) · profile: code

31 modules · 97 connections · 4 cycles · 12 open questions

## Modules

### Browser
- **main.tsx** [entrypoint] — SPA bootstrap + route table · fan-in 0, fan-out 4, instability 1.0 · 295 loc · consumes: spa-bundle
  Mounts the provider stack (QueryClientProvider, WorkspaceContext, auth) and declares every route. Route components are lazy — `main.routes.test.ts` exists to keep the split honest, because a static import here silently undoes code splitting for the whole app.
  source: web/src/main.tsx
- **pages/** [component] — 24 route components · fan-in 1, fan-out 6, instability 0.86 · 12489 loc
  One component per route. `UnifiedDocumentPage` is the important one: every document type (wiki, issue, program, project, sprint, person) renders through it rather than through a type-specific page, which is the load- bearing consequence of the unified document model.
  source: web/src/pages/UnifiedDocumentPage.tsx, web/src/pages/Dashboard.tsx, web/src/pages/App.tsx
- **components/** [component] — 89 files — the 4-panel shell · fan-in 4, fan-out 7, instability 0.64 · 19010 loc
  The icon rail, contextual sidebar, properties panel and every shared widget. 19,010 lines across 89 files, and it both depends on and is depended on by lib/, hooks/ and the editor — see the circular-dependency finding. This is the single largest module in the repo by line count after routes/.
  source: web/src/components/sidebars/PropertiesPanel.tsx, web/src/components/DocumentTreeItem.tsx, web/src/components/ui/
- **Editor + TipTap** [component] — one editor for every doc type · fan-in 3, fan-out 8, instability 0.73 · 6814 loc · emits: yjs-update · consumes: yjs-broadcast
  `Editor.tsx` is the single shared editor — there is deliberately no type-specific editor. It owns the Yjs document, the `y-indexeddb` persistence provider and the `y-websocket` provider pointed at `/collaboration/{docType}:{docId}`. `LazyEditor` defers the whole TipTap + Yjs bundle so it never lands in the initial payload.
  source: web/src/components/Editor.tsx, web/src/components/LazyEditor.tsx, web/src/components/editor/
- **contexts/** [datastore] — 10 React contexts · fan-in 6, fan-out 3, instability 0.33 · 622 loc
  Workspace, documents, issues, projects, programs, current document, selection persistence, uploads. Ambient client state — distinct from the server cache in queryClient, and the boundary between the two is not enforced anywhere.
  source: web/src/contexts/WorkspaceContext.tsx, web/src/contexts/DocumentsContext.tsx
- **hooks/** [module] — 27 TanStack Query hooks · fan-in 5, fan-out 6, instability 0.55 · 4540 loc
  Every server read goes through a query hook, so the query key namespace is the de-facto client data model. `useRealtimeEvents` is the odd one out: it opens a raw WebSocket to `/events` and turns server pushes into cache invalidations.
  source: web/src/hooks/useRealtimeEvents.tsx, web/src/hooks/useDocumentsQuery.ts
- **queryClient** [cache] — TanStack cache, persisted · fan-in 4, fan-out 1, instability 0.2 · 329 loc
  The query cache is persisted to IndexedDB via idb-keyval, with an explicit schema version and a corruption detector. Corruption is not silent: it surfaces as `CacheCorruptionAlert`, which clears every store and reloads.
  source: web/src/lib/queryClient.ts
- **lib/ + services/** [module] — utils, tree building, uploads · fan-in 4, fan-out 4, instability 0.5 · 1764 loc · emits: file-object · consumes: presigned-upload-url
  Document-tree construction, status colours, contrast, date maths, context- menu actions, and the upload tracker. `lib/` imports back into `components/` (13 resolved imports), which is what closes the largest circular dependency in the frontend.
  source: web/src/lib/documentTree.ts, web/src/lib/contextMenuActions.ts, web/src/services/upload.ts
- **lib/api.ts** [api] — fetch + CSRF + session handling · fan-in 7, fan-out 2, instability 0.22 · 530 loc · consumes: csrf-token
  The only place the browser talks REST. Caches a CSRF token from `/api/csrf-token`, attaches it to state-changing requests, and translates a `SESSION_EXPIRED` response into a redirect to `/login`. It deliberately does *not* redirect on a plain `UNAUTHORIZED` — a fresh visitor with no session should get a clean login, not a "session expired" modal.
  source: web/src/lib/api.ts·handleSessionExpired
- **IndexedDB** [datastore] — two independent stores · fan-in 2, fan-out 1, instability 0.33
  Two unrelated stores share the name. `ship-{roomPrefix}-{documentId}` holds the Yjs document state written by y-indexeddb, which is what makes the editor work offline. The idb-keyval store holds the persisted TanStack Query cache. Only the second one has a corruption check.
  source: web/src/components/Editor.tsx, web/src/lib/queryClient.ts

### Shared contract
- **@ship/shared** [package] — types + constants, 8 files · fan-in 9, fan-out 0, instability 0.0 · 469 loc
  469 lines. Document, auth, workspace and API response types, plus the session-timeout constants that both the auth middleware and the collaboration server import so the two cannot drift. Must be built before api or web will compile.
  source: shared/src/types/document.ts, shared/src/constants.ts

### AWS edge
- **CloudFront** [router] — one domain, two origins · fan-in 5, fan-out 2, instability 0.29
  Everything enters here. The default behaviour serves the SPA from S3 with a viewer-request function for SPA routing; five ordered behaviours (`/api/*`, `/health`, `/collaboration/*`, `/events`, `/.well-known/*`) go to the `EB-API` custom origin instead. The WebSocket behaviours use an origin request policy rather than legacy `forwarded_values` so the upgrade survives. This is also why the API must be health-checked through CloudFront: the ALB security group only admits CloudFront's prefix list.
  source: terraform/s3-cloudfront.tf, terraform/security-groups.tf, terraform/waf.tf
- **S3 — SPA bundle** [bucket] — origin access control only · fan-in 1, fan-out 0, instability 0.0 · emits: spa-bundle
  Built by `pnpm build:web` and pushed by `scripts/deploy-frontend.sh`. Private bucket; reachable only through the CloudFront origin access control. Versioned and encrypted at rest.
  source: terraform/s3-cloudfront.tf·aws_s3_bucket.frontend
- **Elastic Beanstalk** [container] — ALB + ASG, 1–4 Docker instances · fan-in 1, fan-out 1, instability 0.5
  Amazon Linux 2023 running Docker, behind an application load balancer. MinSize 1, MaxSize 4, scaling on 70% average CPU. The container entrypoint is `node dist/db/migrate.js && node dist/index.js` — migrations run on every boot, before the server listens. Two deploy paths disagree about session stickiness, and the repo does not settle which one built the live environment. `terraform/elastic-beanstalk.tf` enumerates its settings explicitly and does not include `StickinessEnabled`; `scripts/deploy-api.sh:187` sets it to `true`, but only on the `create-environment` branch — its update branch passes no option settings at all. `scripts/deploy.sh`, the documented deploy, drives terraform. Confirm against the running environment before relying on either.
  source: terraform/elastic-beanstalk.tf, Dockerfile

### API process
- **index.ts** [entrypoint] — boot order is the point · fan-in 1, fan-out 3, instability 0.75 · 228 loc
  Loads SSM secrets *before* dynamically importing `app.ts`, so nothing module-scoped reads an unset env var. Then installs the process safety net, sets Slowloris timeouts (60s/65s/66s), attaches the collaboration WebSocket server to the same HTTP server, and listens. The safety net lives here rather than in a library module on purpose: importing the app from a test or the MCP server must not hijack the host process's error handling.
  source: api/src/index.ts, api/src/process-safety.ts
- **config/ssm.ts** [module] — production secret loading · fan-in 2, fan-out 1, instability 0.33 · 212 loc · consumes: ssm-parameters
  Reads `/ship/{env}/DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN` and friends from SSM Parameter Store with a 5s per-request timeout and 3 bounded attempts. Only runs when `NODE_ENV=production` — the early return is a known test-masking hazard: a smoke test run under `NODE_ENV=development` never exercises this file at all.
  source: api/src/config/ssm.ts
- **app.ts** [router] — middleware chain + 28 mounts · fan-in 1, fan-out 4, instability 0.8 · 464 loc · emits: csrf-token
  One function, `createApp`, builds the whole chain in order: trust-proxy hop count, compression, helmet/CSP, two `/api/` rate limiters, CORS, body parsers, cookie parser, express-session, CSRF, Swagger, then 28 route mounts. Order here is behaviour — the public feedback router must precede the CSRF-protected mounts, and the login limiter must precede the auth routes.
  source: api/src/app.ts·createApp
- **middleware/** [guard] — auth, rate limit, visibility · fan-in 3, fan-out 5, instability 0.62 · 1278 loc · consumes: session-row
  `authMiddleware` accepts either a `Bearer` API token or a session cookie, enforces a 15-minute inactivity window and a 12-hour absolute cap, and writes `req.userId`/`req.workspaceId`. `visibility` scopes document reads. `redis-rate-limit-store` fronts Redis with a circuit breaker and fails open (`passOnStoreError: true`) so a Redis outage degrades to per-process limiting rather than locking everyone out.
  source: api/src/middleware/auth.ts·authMiddleware, api/src/middleware/rate-limit.ts, api/src/middleware/redis-rate-limit-store.ts
- **routes/** [endpoint] — 29 files, 23k lines · fan-in 1, fan-out 8, instability 0.89 · 23031 loc · emits: session-row, presigned-upload-url, document-content-json
  The REST surface, and by a wide margin the heaviest module in the repo: 23,031 lines across 29 files, reaching into middleware, db, services, utils, the collaboration server, the OpenAPI registry and S3. Most of that mass is raw SQL — there is no ORM, so query construction lives in the handlers.
  source: api/src/routes/documents.ts, api/src/routes/issues.ts, api/src/routes/files.ts
- **collaboration/** [service] — Yjs rooms + /events, 1,570 lines · fan-in 2, fan-out 7, instability 0.78 · 1570 loc · emits: yjs-state, yjs-broadcast · consumes: yjs-update, document-content-json
  One file doing two jobs. It runs the Yjs sync protocol over `/collaboration/{docType}:{docId}`, holding each room's `Y.Doc` and awareness state in a process-local `Map` and debouncing persistence to `documents.yjs_state` every 2s. It also serves `/events`, a plain WebSocket that route handlers push to via `broadcastToUser`. Both maps are per-process. Nothing replicates them.
  source: api/src/collaboration/index.ts, api/src/collaboration/index.ts·broadcastToUser, api/src/collaboration/index.ts
- **services/** [service] — the only outbound integrations · fan-in 2, fan-out 6, instability 0.75 · 1885 loc · consumes: caia-credentials
  CAIA OAuth (PIV smartcard auth via Treasury's OIDC server), AWS Secrets Manager, Bedrock-backed plan/retro analysis, audit logging, accountability inference, OAuth state. Every third-party call the API makes originates here — routes never reach out directly.
  source: api/src/services/caia.ts, api/src/services/ai-analysis.ts, api/src/services/secrets-manager.ts
- **utils/** [module] — Yjs<->JSON, document CRUD · fan-in 4, fan-out 1, instability 0.2 · 2065 loc
  `yjsConverter` is the interesting one: it is what lets a document created through the REST API (plain TipTap JSON in `content`) be opened by the collaborative editor, by converting JSON into Yjs the first time a room loads. Also holds the circuit breaker used by the Redis store.
  source: api/src/utils/yjsConverter.ts, api/src/utils/document-crud.ts, api/src/utils/circuitBreaker.ts
- **openapi/ + swagger** [api] — zod -> spec -> Swagger -> MCP · fan-in 2, fan-out 0, instability 0.0 · 5583 loc · emits: openapi-spec
  23 schema modules register zod definitions and paths into one registry at import time; `swagger.ts` generates the document once at module load and serves it at `/api/docs`, `/api/openapi.json` and `/api/openapi.yaml`. Registration is not optional — an endpoint that skips it is invisible to Swagger and produces no MCP tool.
  source: api/src/openapi/registry.ts, api/src/openapi/schemas/index.ts, api/src/swagger.ts
- **db/** [module] — pool, migrations, seed · fan-in 5, fan-out 2, instability 0.29 · 3381 loc
  A single `pg.Pool` — no ORM, no query builder. Pool timing, TLS resolution and which `.env` files load are each split into their own module because each was a defect: the app pool once connected in plaintext while the migrate and seed scripts either side of it negotiated TLS. `migrate.ts` applies `schema.sql` first, then numbered migrations tracked in `schema_migrations`, each in its own transaction.
  source: api/src/db/client.ts, api/src/db/migrate.ts, api/src/db/schema.sql

### Agent surface
- **mcp/server.ts** [cli] — separate stdio process · fan-in 0, fan-out 1, instability 1.0 · 524 loc · consumes: openapi-spec
  Not part of the served application. A standalone MCP server that reads `~/.claude/.env`, fetches `/api/openapi.json` from a *running* Ship instance, and generates one MCP tool per operation at startup. Its tool surface therefore tracks whichever deployment `SHIP_URL` points at — not this checkout.
  source: api/src/mcp/server.ts

### Durable state
- **PostgreSQL / Aurora** [database] — 18 tables, one for content · fan-in 2, fan-out 0, instability 0.0 · consumes: yjs-state
  Aurora PostgreSQL in private subnets, reachable only from the EB security group. Every content type — wiki, issue, program, project, sprint, person — is a row in `documents`, distinguished by `document_type`. Relationships live in `document_associations`; all three legacy association columns have been dropped. `documents.yjs_state` (bytea) holds the CRDT state and `documents.content` (jsonb) is kept in sync as a readable fallback.
  source: api/src/db/schema.sql, terraform/database.tf
- **ElastiCache Redis** [cache] — single node, rate limits only · fan-in 1, fan-out 0, instability 0.0
  One `cache.*` node, engine 7.1. Its only consumer is the rate-limit store — grep for `REDIS_URL` returns app.ts, rate-limit.ts, redis-rate-limit-store.ts and ssm.ts, and nothing else. If `REDIS_URL` is unset the limiters fall back to per-process memory stores.
  source: terraform/redis.tf, api/src/middleware/redis-rate-limit-store.ts
- **S3 — uploads** [bucket] — presigned PUT, CORS, lifecycle · fan-in 1, fan-out 0, instability 0.0 · consumes: file-object
  File attachments. The browser uploads directly with a presigned URL rather than streaming through the API, then calls `POST /api/files/:id/confirm`. Metadata rows live in the `files` table; only bytes live here.
  source: api/src/routes/files.ts, terraform/s3-cloudfront.tf

### External services
- **SSM + Secrets Manager** [vendor] — /ship/{env}/* · fan-in 2, fan-out 0, instability 0.0 · emits: ssm-parameters, caia-credentials
  Parameter Store holds runtime config (DATABASE_URL, SESSION_SECRET, CORS_ORIGIN, CDN_DOMAIN, APP_BASE_URL) read once at boot. Secrets Manager holds `/ship/{env}/caia-credentials`, re-fetched on every auth flow so a credential rotation takes effect without a restart.
  source: api/src/config/ssm.ts, api/src/services/secrets-manager.ts, terraform/ssm.tf
- **Treasury CAIA** [vendor] — OIDC / PIV smartcard · fan-in 1, fan-out 0, instability 0.0
  Treasury's Customer Authentication & Identity Architecture, spoken via openid-client v6. Supplies the PIV/X509Cert, Login.gov and ID.me credential paths. Email is the identifier that persists; `sub` explicitly is not.
  source: api/src/services/caia.ts, api/src/routes/caia-auth.ts
- **AWS Bedrock** [vendor] — claude-opus-4-5, us-east-1 · fan-in 1, fan-out 0, instability 0.0
  Scores weekly plans for falsifiability and workload, and compares retros against their plan for coverage. Degrades gracefully — a failed client init or invocation returns no score rather than failing the request.
  source: api/src/services/ai-analysis.ts, terraform/elastic-beanstalk.tf

## Connections
- main.tsx → CloudFront (GET / (SPA))
- CloudFront → S3 — SPA bundle (default behavior)
- lib/api.ts → CloudFront (/api/* + CSRF)
- Editor + TipTap → CloudFront (wss /collaboration/*)
- hooks/ → CloudFront (wss /events)
- CloudFront → Elastic Beanstalk (EB-API origin)
- Elastic Beanstalk → index.ts (migrate, then serve)
- mcp/server.ts → CloudFront (GET /api/openapi.json, inferred)
- index.ts → config/ssm.ts (secrets first)
- index.ts → app.ts
- index.ts → collaboration/ (attach ws)
- app.ts → routes/ (28 mounts)
- app.ts → middleware/ (rate limiters)
- app.ts → openapi/ + swagger (setupSwagger)
- app.ts → services/ (initializeCAIA)
- routes/ → middleware/ (authed())
- routes/ → db/ (pool.query)
- routes/ → services/
- routes/ → utils/
- routes/ → @ship/shared
- routes/ → collaboration/ (control, broadcastToUser)
- routes/ → openapi/ + swagger (registerPath)
- services/ → db/
- services/ → utils/
- services/ → @ship/shared
- middleware/ → db/
- middleware/ → utils/ (circuitBreaker)
- middleware/ → @ship/shared
- collaboration/ → db/
- collaboration/ → utils/ (yjsConverter)
- collaboration/ → middleware/ (session TTL)
- collaboration/ → @ship/shared
- utils/ → db/
- db/ → config/ssm.ts
- db/ → PostgreSQL / Aurora (pg.Pool (TLS))
- middleware/ → ElastiCache Redis (rate-limit store)
- routes/ → S3 — uploads (presigned PUT)
- config/ssm.ts → SSM + Secrets Manager (GetParameter)
- services/ → SSM + Secrets Manager (caia-credentials)
- services/ → Treasury CAIA (OIDC)
- services/ → AWS Bedrock (InvokeModel)
- collaboration/ → PostgreSQL / Aurora (data, yjs_state (2s debounce))
- main.tsx → pages/ (lazy routes)
- main.tsx → contexts/ (provider stack)
- main.tsx → queryClient
- pages/ → components/
- pages/ → hooks/
- pages/ → lib/ + services/
- pages/ → contexts/
- pages/ → lib/api.ts
- pages/ → Editor + TipTap
- components/ → lib/ + services/
- components/ → hooks/
- components/ → lib/api.ts
- components/ → @ship/shared
- components/ → contexts/
- components/ → Editor + TipTap
- components/ → queryClient
- Editor + TipTap → components/
- Editor + TipTap → lib/ + services/
- Editor + TipTap → hooks/
- Editor + TipTap → lib/api.ts
- Editor + TipTap → @ship/shared
- Editor + TipTap → contexts/
- hooks/ → lib/api.ts
- hooks/ → @ship/shared
- hooks/ → contexts/
- hooks/ → queryClient
- hooks/ → components/
- contexts/ → hooks/
- contexts/ → lib/api.ts
- contexts/ → lib/ + services/
- lib/ + services/ → components/
- lib/ + services/ → contexts/
- lib/ + services/ → lib/api.ts
- lib/ + services/ → @ship/shared
- lib/api.ts → @ship/shared
- Editor + TipTap → IndexedDB (data, Yjs state)
- queryClient → IndexedDB (data, persisted cache)
- collaboration/ → Editor + TipTap (feedback, Yjs sync + awareness, polarity -, loop B1)
- collaboration/ → hooks/ (feedback, /events push, polarity -, loop B2)
- middleware/ → lib/api.ts (feedback, 401 SESSION_EXPIRED, polarity -, loop B3)
- IndexedDB → queryClient (feedback, corruption -> clear + reload, polarity -, loop B4)
- MISSING LINK (modelled absence): collaboration/ → ElastiCache Redis (gap, no cross-instance room sync)
  DERIVED, not observed. Three observed facts: the Yjs `docs` and `awareness` Maps are process-local (collaboration/index.ts:95-130); Redis has no consumer other than the rate limiters (grep REDIS_URL -> app.ts, rate-limit.ts, redis-rate-limit-store.ts, ssm.ts); the ASG scales to 4 instances. The consequence I have NOT run: above one instance, two people editing the same document can be routed to different processes, each holding its own Y.Doc for that room and persisting over the other every 2s. Session stickiness does not address this either way — it pins a browser to an instance, not a document to an instance, so two different users on the same document can still land on two different rooms. To confirm or kill this, run two instances behind the ALB and open one document as two users.
- MISSING LINK (modelled absence): app.ts → ElastiCache Redis (gap, CSRF store is in-process)
  DERIVED from an observed fact: `app.use(session({...}))` at app.ts:335-345 passes no `store`, so express-session uses the default MemoryStore, and csrf-sync keeps the CSRF secret in that session. A token minted by `/api/csrf-token` on one instance therefore has no matching secret on another. How much this bites depends on the stickiness question in the Elastic Beanstalk note. With stickiness on, a browser keeps hitting the same instance and this mostly does not surface — until that instance is replaced by a deploy or a scale-in, at which point every in-flight CSRF secret is gone. With it off, it surfaces as intermittent 403s under load. Neither case is reproduced here. Application auth is unaffected either way: that is a real `sessions` table in Postgres, not express-session.
- SSM + Secrets Manager → services/ (data, caia-credentials, inferred)
- app.ts → lib/api.ts (data, csrf-token, inferred)
- routes/ → collaboration/ (data, document-content-json)
- lib/ + services/ → S3 — uploads (data, file-object, inferred)
- openapi/ + swagger → mcp/server.ts (data, openapi-spec, inferred)
- routes/ → lib/ + services/ (data, presigned-upload-url, inferred)
- routes/ → middleware/ (data, session-row)
- S3 — SPA bundle → main.tsx (data, spa-bundle, inferred)
- SSM + Secrets Manager → config/ssm.ts (data, ssm-parameters, inferred)
- collaboration/ → Editor + TipTap (data, yjs-broadcast)
- collaboration/ → PostgreSQL / Aurora (data, yjs-state)
- Editor + TipTap → collaboration/ (data, yjs-update, inferred)

## Cycles
- **B1** (balancing): Editor + TipTap → CloudFront → Elastic Beanstalk → index.ts → collaboration/
- **B2** (balancing): hooks/ → CloudFront → Elastic Beanstalk → index.ts → collaboration/
- **B3** (balancing): lib/api.ts → CloudFront → Elastic Beanstalk → index.ts → app.ts → middleware/
- **B4** (balancing): queryClient → IndexedDB

## Open questions (analyzer findings)
- [high] **“components/” is coupled in both directions**
  4 modules depend on it and it depends on 7 others. It is simultaneously hard to change (many dependents) and hard to keep stable (many dependencies). This is the classic shape of a module that has absorbed responsibilities that belong elsewhere — split it along the two directions of coupling.
- [high] **“hooks/” is coupled in both directions**
  5 modules depend on it and it depends on 6 others. It is simultaneously hard to change (many dependents) and hard to keep stable (many dependencies). This is the classic shape of a module that has absorbed responsibilities that belong elsewhere — split it along the two directions of coupling.
- [high] **“components/” is 12× the median module size**
  19010 lines against a median of 1570. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [high] **“routes/” is 14× the median module size**
  23031 lines against a median of 1570. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [high] **Circular dependency: Editor + TipTap → lib/ + services/ → components/ → hooks/**
  These modules import each other in a cycle. Nothing here is marked as intentional feedback, so this is a circular dependency: it makes build order, initialisation order, and test isolation all ambiguous, and it means none of these modules can be understood — or extracted — on its own.
- [medium] **Nodes are directories, so intra-directory coupling is invisible**
  Every node here is a folder, not a file. routes/ (23k lines) and components/ (19k lines) are drawn as single boxes, so the coupling *inside* them — the part most likely to hurt — does not appear. The measured import counts on each edge are cross-directory only; imports within a directory were dropped during aggregation. For file-level detail, re-extract with dependency-cruiser scoped to one directory.
- [medium] **“Editor + TipTap” reaches into 8 other modules**
  Fan-out of 8, instability 0.73. This module knows about most of the codebase, so almost any change elsewhere can break it, and reading it requires holding the whole system in your head. Look for a seam: usually a hub like this is one coordinator plus several collaborators that could be injected instead of imported.
- [medium] **“routes/” reaches into 8 other modules**
  Fan-out of 8, instability 0.89. This module knows about most of the codebase, so almost any change elsewhere can break it, and reading it requires holding the whole system in your head. Look for a seam: usually a hub like this is one coordinator plus several collaborators that could be injected instead of imported.
- [medium] **“pages/” is 7× the median module size**
  12489 lines against a median of 1570. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [medium] **“Editor + TipTap” is 4× the median module size**
  6814 lines against a median of 1570. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [medium] **The MCP tool surface is not derivable from this repository**
  mcp/server.ts has no import edge into the rest of the codebase — it builds its tools by fetching /api/openapi.json from whatever SHIP_URL points at, at startup. So its behaviour is a property of a deployment, not of a commit, and it silently tracks whichever environment the operator configured. The edge into CloudFront is marked heuristic for that reason.
- [low] **A smoke test can pass by skipping the code that breaks**
  config/ssm.ts returns early unless NODE_ENV=production (ssm.ts:39). A container smoke test run under development therefore never exercises secret loading, and has previously been reported as end-to-end verification when it was the opposite. Any claim about boot correctness has to state the NODE_ENV it ran under.
