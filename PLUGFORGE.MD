# PLUGFORGE — Week 6 PRD

**Project:** Ship becomes a platform — versioned public API, OAuth 2.0, signed webhooks, typed SDK, developer portal, and the FleetGraph agent rewired as a platform citizen.
**Repo:** this repository (`Ship`, pnpm monorepo: `api`, `web`, `shared`, `agent`).
**Deploy target:** Render (extend `terraform/render/`). Graded CI: GitLab (`.gitlab-ci.yml`); GitHub Actions is the mirror.
**Deadlines:** Architectural Defense → MVP (hard gate, +1 day) → Early Submission → Final Submission (**plan for Sunday 11:59 AM CT** — the brief contradicts itself on AM/PM; all work lands Saturday night).
**Source brief:** `GFA_Week_6_PlugForge.pdf` (Gauntlet Week 6). The grade is the **Time-to-First-Event drill**, not endpoint count: *a stranger goes from `pnpm install @ship/sdk` to a verified signed webhook in under 30 minutes using only the published docs; under 60 seconds scripted in CI; 0% flake over 20 runs.*

---

## 0. How to execute this document

This PRD is the single source of truth for Week 6. It is designed to be handed to an executing agent (or the ship-factory pipeline) with **no other context needed**.

**Execution model: ship-factory tickets.**
1. Read `.claude/CLAUDE.md` and follow its rituals (memory-bank read/update, response canary, claim-provenance discipline).
2. Feed this document into the repo's factory pipeline: treat PLUGFORGE.MD as the approved spec for `/ship-pm`'s scope gate, use `/ship-architect` to turn the `PF-###` blocks into Linear tickets (existing `TRO-###` sequence — the blocks are the pre-approved decomposition; the architect adds file-level detail, not new scope), run `/ship-test-designer` so acceptance tests are designed before implementation, then `/ship-factory` executes. Each `PF-###` block is ticket-sized: one ticket → one worktree → one evidence-gated PR.
3. Every ticket runs in an isolated worktree with an **exclusive database** (`.factory-env`) — non-negotiable because `pnpm test` TRUNCATEs whatever `DATABASE_URL` points at (audit finding TEST-9).
4. Every PR carries `scripts/factory/gate.sh` evidence (type-check, build, unit tests vs quarantine baseline, tests-not-weakened) plus the coverage gate. Coverage thresholds (api 43% / web 20% / shared 95% statements) live in each package's `vitest.config.ts` and are re-asserted in CI by `.github/workflows/ci.yml:176-179` (`coverage-summary.mjs`) and run in the **graded GitLab pipeline's `verify` job** (`.gitlab-ci.yml` — the platform that counts) — they are NOT in gate.sh; don't look for them there.
5. Grading rules that apply to every ticket: before/after proof; regression test per bug; `CHANGES.md` entry **with rollback instructions** (use `scripts/factory/merge-changes.mjs` for conflicts); no cosmetic changes; commit discipline — the graders read git history. **Brief mandate on PRs:** per-slice branches are preserved (never deleted after merge), and every PR description names the acceptance criterion that slice advances and confirms the fitness test passed. This overrides the prior weeks' PR-bundling habit — Week 6 is one ticket → one branch → one PR.
6. Never `git commit --no-verify`. Never run `pnpm test:e2e` directly (use `/e2e-test-runner`).

### 0.1 HUMAN CHECKPOINT protocol (blocking — do not skip)

Three tickets are marked **🔔 HUMAN CHECKPOINT**. These exist because Troy must personally learn and defend this material in a live interview. The protocol:

1. When a checkpoint ticket becomes unblocked, **notify Troy immediately** (use `scripts/factory/notify.mjs`, plus a message in the driving session) with the checkpoint's briefing content.
2. **Halt all work on that epic** until Troy explicitly acknowledges (a reply in session, or an "ack" comment on the Linear ticket).
3. Other epics with no dependency on the checkpointed epic may continue in parallel.
4. A checkpoint is never marked complete by an agent on its own authority.

Checkpoints: **PF-100** (OAuth study, before any E1 code), **PF-700** (agent-rewire review, before E7 code), **PF-904** (pre-search answers + demo recording, needs Troy's real input).

### 0.2 Known landmines in this repo (verified during PRD research, 2026-08-10)

| Landmine | Consequence | Mitigation |
|---|---|---|
| TEST-9: `pnpm test` truncates the DB at `DATABASE_URL` | Data loss on shared DBs | Exclusive DB per worktree, always |
| DB-1: `db:migrate` has silently skipped migrations and exited 0 | Schema drift between envs | `scripts/dev.sh` migration-count verification; verify new migrations applied with `\d` checks in gate evidence |
| Legacy `/api/` rate limiters would swallow `/api/v1` — the old API-1 cap (100 req/min/IP) is **already fixed** by TRO-172; prod is now 600/min/identity + 6,000/min/IP (`api/src/middleware/rate-limit.ts:130-132`), but both limiters mount on the `/api/` prefix with no skip logic (`api/src/app.ts:326-327`), so a v1 router inherits them | Wrong limiter semantics (IP/identity, not app/token) strangle the public API and the TTFE drill | PF-004 exempts `/api/v1` before anything else ships |
| TRO-361: Render `auto_deploy` is broken | Deploys silently don't happen | Deploy manually via Render API; verify deployed SHA in evidence |
| Dependency-audit baseline drift | Unrelated PRs blocked on advisory schedule | Scoped `pnpm.overrides` pin + baseline refresh (pattern documented in root `package.json` comments) |
| Philosophy reviewer auto-triggers on schema/route changes | Blocks PRs that add "content tables" | See §2.1 — the new tables are infrastructure, defense pre-written |
| Legacy columns `documents.sprint_id/project_id/program_id` | Dropped by migrations 027/029 — but some DBs may not have applied them | Never reference them; `sprint_iterations.sprint_id` is a different, current column |

---

## 1. Context

### 1.1 What Ship is
Collaborative document platform (docs/issues/projects/teams) for government teams. **Everything is a document**: one `documents` table differentiated by `document_type` (`wiki | issue | program | project | sprint | person | weekly_plan | weekly_retro | standup | weekly_review`). React 18 + Vite + TanStack Query front end; Express 4 + raw-SQL Postgres back end; TipTap/Yjs real-time collaboration over WebSocket; REST API at `/api/{resource}` with an OpenAPI registry (`api/src/openapi/registry.ts`, zod + `@asteasolutions/zod-to-openapi`, Swagger at `/api/docs`, MCP server auto-generated from the spec).

### 1.2 What Week 5 built (the rewire target)
FleetGraph (`agent/`): a standalone LangGraph service (port 3100, Anthropic `claude-haiku-4-5-20251001` — the pinned snapshot ID, `agent/src/server.ts:140` — no tool use, no streaming) that drafts standups/retros/escalations and answers document-seeded questions. Two clients matter here:
- `agent/src/shipClient.ts` → `ShipClient` (`:337`): exactly 10 **read** methods against Ship's internal REST API (`getChangeFeed`, `getDocument`, `getPeople`, `getAssociations`, `getReverseAssociations`, `getBacklinks`, `getComments`, `getIssuesByAssignee`, `listDocuments`, `getWeekDates`).
- `GateShipClient` (same file, `shipClient.ts:569`): exactly **three writes** (`postStandup`, `setStandupContent`, `applyIssueTransition`), each taking the **acting human's token** as an explicit parameter; the class holds no token of its own. Only `agent/src/gate.ts` writes; `graph.ts` structurally cannot (proven by `graphWriteBoundary.test.ts`).

### 1.3 What Week 6 demands
The surfaces a third-party developer needs: `/api/v1/` with consistent errors and cursor pagination; OAuth 2.0 (Authorization Code + PKCE, Device Authorization Grant, refresh rotation, scopes-as-data); HMAC-signed webhooks with retries/DLQ/replay; `@ship/sdk`; rate limiting with headers; public audit trail; a developer portal that eats the dog food; ≥5 reference integrations; and Epic 7 — the agent authenticates as a first-party OAuth app and consumes the public API through the SDK. *"The agent stops being a privileged insider and becomes a platform citizen."*

### 1.4 Decisions already made (with Troy, 2026-08-10)
1. **Deploy stays on Render** — the brief's stack table explicitly sanctions it. IaC work extends `terraform/render/`; the IAM least-privilege exercise is adapted to Render's permission model and the adaptation is defended in writing (PF-902).
2. **Five integrations**: CLI (must-ship) + refresh-token-rotation drill + Idempotency-Key drill + Browser SDK demo + Slack. GitHub App and in-process plugin runtime are **time-boxed stretch** — attempt only if all five are done and gated.
3. **Execution via ship-factory tickets** (this document's structure).
4. **Agent identity is hybrid** (E7, PF-702/PF-703): app-identity reads (Client Credentials, read-only scopes), human-token writes — both through `@ship/sdk`.
5. **Hand-rolled OAuth** (IETF-correct minimal: RFC 6749 + 7636 + 8628). Troy is not yet familiar with OAuth internals → 🔔 PF-100 blocks E1.
6. **All non-code deliverables are tickets** in this PRD (E9).

---

## 2. Architecture

### 2.1 Module layout

```
api/src/platform/           # NEW — the platform layer
  oauth/                    #   flows, endpoints, PKCE, token issuance/rotation
  scopes/                   #   ScopeRegistry (scopes as data)
  ratelimit/                #   token buckets + header middleware
  webhooks/                 #   event registry, IEventBus, signer, deliverer, DLQ, replay
  audit/                    #   public API audit trail
  api/v1/                   #   the public router: resources, ApiError, pagination
  openapi/                  #   v1 OpenAPI 3.1 registry + generator
sdk/                        # NEW — @ship/sdk workspace package
integrations/               # NEW — cli/, browser-demo/, slack/  (import ONLY @ship/sdk)
```

**Boundary rules (one-way doors, enforced Day 1 by lint — PF-003):**
- **TypeScript strict mode is a brief mandate** for the new surface: `sdk/` and every `integrations/*` package ship with `strict: true` tsconfigs, and platform code under `api/src/platform/` stays `pnpm type-check`-clean like the rest of `api`.
- `api/src/platform/api/v1/**` must not import from `api/src/routes/**` (internal handlers). Both layers call the same domain services.
- `integrations/*` packages may depend only on `@ship/sdk` (never `api/src`). Enforced by workspace dependency rules + import lint. This is what makes "the agent is a platform citizen" structurally true.
- Public routes live only at `/api/v1/*`; internal endpoints stay at `/api/*`. The `/api/v1` router shares **no internal auth/CSRF/rate-limit middleware** with internal routes — bearer auth, scope checks, per-app buckets, audit, and webhook publication attach only at the public layer. (App-global middleware — helmet, compression, CORS, body/cookie parsing, session at `app.ts:286-337` — necessarily runs on both; "no shared middleware" would be false and unlintable. Target the lint/fitness checks at the auth/CSRF/limiter layer.)
- **Public CORS:** the global `cors()` is single-origin with credentials (`app.ts:328-331`) — a browser SPA on another origin cannot call `/oauth/token` or `/api/v1/*` through it. Mount a separate, env-configurable permissive CORS policy on exactly `/api/v1/*` + the `/oauth` token/device endpoints (bearer tokens, no cookies → `credentials: false`); without this, PF-802's PKCE demo fails on first contact. *Covered in PF-001's AC.*

**Composition root:** `api/src/app.ts` remains the single wiring point — concrete OAuth stores, rate limiter, event bus, and webhook deliverer are constructed there and injected; tests wire in-memory doubles. (This is also a mandated section of `docs/architecture.md`.)

**Philosophy compliance (pre-written defense for `/ship-philosophy-reviewer`):** the new tables (§2.2) are *infrastructure* tables — credentials, delivery bookkeeping, audit rows. They store no user content and introduce no new content type. "Everything is a document" governs content; OAuth apps and webhook deliveries are not documents any more than `sessions` or `api_tokens` are. No new editors, no new content surfaces; the portal is UI over the public API.

### 2.2 Data model (numbered migrations, starting at 042 — current max is `041_add_blocks_relationship.sql`)

| Migration | Table | Key columns |
|---|---|---|
| 042 | `oauth_apps` | `id`, `workspace_id`, `name`, `client_id` (unique, `ship_app_…`), `client_secret_hash` (SHA-256, same pattern as `api_tokens`), `redirect_uris text[]`, `requested_scopes text[]`, `owner_user_id`, `is_first_party bool`, `created_at`, `revoked_at` |
| 043 | `oauth_authorization_codes` | `code_hash`, `app_id`, `user_id`, `scopes text[]`, `code_challenge`, `code_challenge_method` (`S256` only), `redirect_uri`, `expires_at` (10 min), `consumed_at` |
| 043 | `oauth_tokens` | `id`, `app_id`, `user_id` (**nullable** — null for Client Credentials), `scopes text[]`, `access_token_hash`, `refresh_token_hash` (nullable), `family_id`, `parent_id`, `expires_at`, `revoked_at` |
| 043 | `oauth_device_codes` | `device_code_hash`, `user_code` (human-typable, e.g. `BDWJ-KXQT`), `app_id`, `scopes`, `interval_seconds`, `expires_at`, `user_id` (null until verified), `status` (`pending/approved/denied/expired`) |
| 043 (same migration) | `api_tokens` (ALTER) | adds `scopes text[]` — null = legacy unscoped internal token (unchanged behavior, never valid at `/api/v1`); non-null = scoped personal token, the second token class PF-107's bearer middleware accepts. The current table has no scopes column (`schema.sql:254-267`), so "scoped personal tokens" require this extension — issuance gains a `scopes` parameter |
| 044 | `webhook_subscriptions` | `id`, `app_id`, `event_type`, `target_url`, `signing_secret_ciphertext` (AES-256-GCM under env `SECRET_ENCRYPTION_KEY` — see note), `active bool`, `created_at` |
| 045 | `webhook_deliveries` | `id`, `subscription_id`, `event_id`, `event_type`, `payload jsonb`, `idempotency_key`, `attempt_number`, `status` (`pending/success/failed/dead`), `response_status`, `response_excerpt`, `latency_ms`, `next_attempt_at`, `created_at` |
| 046 | `public_api_audit` | `id`, `request_id`, `app_client_id`, `user_id` (nullable), `method`, `route`, `scope_used`, `status`, `latency_ms`, `created_at` |

> **Signing-secret note:** the brief says "hashed signing secret", but the server must *possess* the secret to compute HMAC signatures — a one-way hash is unimplementable here. Decision: generate `whsec_…` secrets, return the plaintext **exactly once** on creation/rotation, store encrypted at rest (AES-256-GCM, key from env). Stripe does the equivalent. State this openly in `docs/architecture.md` — it is a deliberate, defensible deviation, and a likely interview question.

Token TTLs: access 1 hour; refresh 30 days, one-time-use with rotation; reuse of a rotated refresh token revokes the entire `family_id` (stolen-token detection). Auth codes 10 minutes, single-use.

### 2.3 Scopes (as data — `ScopeRegistry`)

`documents:read`, `documents:write`, `issues:read`, `issues:write`, `sprints:read`, `sprints:write`, `webhooks:manage`. New scopes register at module load; middleware is never edited to add one (OCP — cite in the SOLID rationale). Insufficient scope → `403` with the **missing scope named** in `details` (never an opaque "forbidden").

### 2.4 Public resources over the unified document model

`/api/v1/documents`, `/api/v1/issues`, `/api/v1/sprints` are three typed public resources backed by the single `documents` table (`document_type` filter). `issues` responses lift typed fields (state, priority, assignee) out of `properties` JSONB into the response schema. `/api/v1/me` returns the authenticated principal: `{ user, app, scopes }`. This preserves the SDK's resource-segregated surface (ISP) without violating everything-is-a-document. Own this mapping explicitly in the architecture doc.

### 2.5 Error contract & pagination

```ts
interface ApiError {
  code: "unauthorized" | "forbidden" | "not_found"
      | "validation_failed" | "rate_limited" | "server_error";
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}
```
Every `/api/v1` failure ships this shape — enforced by error middleware at the public layer and asserted by the fitness test (PF-203). Distinct 401 codes for invalid vs missing vs expired tokens (in `details.reason`).

Cursor pagination: opaque `base64url({ id, created_at })`. Every list endpoint returns `{ data, next_cursor }`. Cursors are keyset-based (WHERE `(created_at, id) < (…)`) so they are stable across reordering.

### 2.6 Event pipeline

```
domain write (documentService) → IEventBus.publish → subscription matcher
  → HMAC signer → IWebhookDeliverer (retry scheduler) → delivery log → DLQ → replay
```

- **Event registry (8 types, each with a Zod schema):** `document.created`, `document.updated`, `document.deleted`, `issue.created`, `issue.assigned`, `issue.status_changed`, `sprint.started`, `sprint.completed`. Because issues/sprints *are* documents, issue/sprint events are derived in the domain write path from `document_type` + property transitions (PF-300 includes a discovery task to pin the exact property names against `shared/src/types`).
- **Publishing happens in the domain layer, never the route layer.** Ship's writes are currently scattered across route handlers, so E3 includes a deliberately scoped refactor (PF-301): consolidate document create/update/delete into a `documentService` write path that both `/api` and `/api/v1` call; `IEventBus.publish` lives there. This is targeted plumbing, not a rewrite — handlers keep their validation/authz and delegate the write.
- **In-process bus and in-memory delivery queue must-ship** (single Render instance — same justified precedent as FleetGraph's `ItemStore`), but **every attempt is persisted** to `webhook_deliveries`, so the log, DLQ, and replay survive restarts. `IEventBus`/`IWebhookDeliverer` are interfaces; a queue-backed implementation is a Liskov-substitutable drop-in (DIP — cite in SOLID rationale).
- **Signature:** `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`; signed payload is `${t}.${rawBody}`; default tolerance 300 s. Timestamp prevents replay.
- **Retry schedule:** 1s, 4s, 16s, 1m, 5m, 30m with jitter. 5xx/timeout → retry; 4xx → permanent failure, dead-letter immediately; 6 failed attempts → DLQ. Tested with an **injected deterministic clock** — never `setTimeout` waits in tests.
- **Replay:** `POST /api/v1/webhooks/deliveries/:id/replay` re-emits a logged event carrying the original `Idempotency-Key` header so subscribers can dedupe.

### 2.7 Rate limiting & audit

Token buckets per **app** (default 120 req/min) and per **token** (default 60 req/min), config via env. 100% of `/api/v1` responses carry `X-RateLimit-Limit / -Remaining / -Reset`; 429s carry `Retry-After`. The legacy express-rate-limit `/api/` limiters (post-TRO-172: 600/min/identity + 6,000/min/IP in prod, `api/src/middleware/rate-limit.ts:130-132`; API-1's original 100/min/IP cap is history) **exempt `/api/v1`** — the per-app/per-token buckets replace them there (PF-004, before anything else ships).

Every public API call writes a `public_api_audit` row: `request_id`, app `client_id`, `user_id`, method, route, scope used, status, latency. Queryable in the portal. This is Epic 7's proof: after the rewire, `grep` the audit trail for the agent's `client_id`.

### 2.8 `@ship/sdk` surface

```ts
class ShipClient {
  readonly documents: DocumentsClient;   // list/get/create + iterate()
  readonly issues:    IssuesClient;
  readonly sprints:   SprintsClient;
  readonly webhooks:  WebhooksClient;    // create/list/delete subs, deliveries, replay
  constructor(opts: { token?: string; baseUrl?: string; tokenStore?: ITokenStore });
  me(): Promise<Me>;
  static authorizationCodeFlow(opts): Promise<ShipClient>;   // browser PKCE, no secret
  static deviceLogin(opts: { onUserCode: (code, verifyUrl) => void;
                             tokenStore?: ITokenStore }): Promise<ShipClient>;
}
function verifyWebhook(headers, rawBody, secret, toleranceSec = 300): boolean; // < 1 ms
```

- Errors are a typed discriminated union: `{ kind: 'auth' | 'forbidden' | 'not_found' | 'validation' | 'rate_limit' | 'server' | 'network', … }` — consumers switch exhaustively.
- Pagination via async iterators (`for await (const doc of client.documents.iterate())`) — consumers never see cursors.
- `ITokenStore` (get/set/clear tokens, including refresh) with `MemoryTokenStore` and `FileTokenStore`; browser demo uses localStorage. Refresh under concurrent calls: single-flight mutex.
- **Zero runtime dependencies** (native `fetch`) — the <250 KB minified+gzipped budget becomes trivial and CI-checked.
- **Cheap construction, no I/O in constructor** — required by the agent gate, which builds a per-human-token client per write (PF-703).
- Hand-written, fitness-tested against the OpenAPI spec for parity (drift fails CI). Trade-off (type quality over generated drift-safety) documented for the interview.

### 2.9 Developer portal (dog-fooding)

Portal UI lives in the existing Ship web app (respect the 4-panel layout; a "Developer" section in the contextual sidebar). It **consumes the public API like any other client**: on entry it mints a short-lived scoped personal token via the `api_tokens` mechanism — extended with `scopes text[]` by migration 043 (§2.2) — session-authed, and uses it for `/api/v1` calls. Screens: app list/registration (secret shown exactly once, copy-to-clipboard, never re-displayed), app detail (rotate secret, redirect URIs, scopes), webhook subscriptions CRUD, delivery log (server-side pagination + status filter), DLQ view with **Replay** button. **Kill-criterion (pre-agreed):** if E5 is running behind after the CLI + drills are green, portal collapses to the read-only delivery-log viewer + replay — app registration falls back to an admin API call documented in the README.

### 2.10 Infrastructure (Render + Terraform)

Extend `terraform/render/` (provider `render-oss/render`, versions pinned): both services (`ship`, `agent`), Postgres, all new env vars (`SECRET_ENCRYPTION_KEY`, OAuth TTL config, rate-limit config) — no console-only configuration. Deliverables: annotated `terraform plan` output as a submission artifact; **destroy-and-redeploy** run with logs proving the service came back identically (the brief's proof that IaC is the source of truth); a manual-drift demo (change an env var in the Render dashboard → `terraform plan` shows the diff). **IAM adaptation (PF-902):** Render has no IAM roles — write a one-page mapping (AWS task role/execution role/least-privilege ⇄ Render API-key scoping, service isolation, env-var secret handling), state what Render cannot express, and defend why the trade is acceptable for this deployment. Bring this to the Architecture Defense — graders will present a modified terraform plan; be ready to walk resource-by-resource through blast radius.

---

## 3. What already exists — build on it, don't duplicate it

| Existing asset | Location | Reuse in PlugForge |
|---|---|---|
| OpenAPI registry + zod-to-openapi | `api/src/openapi/registry.ts` | Same pattern, new 3.1 registry instance for v1 |
| Bearer token auth path | `api/src/middleware/auth.ts`, `api/src/routes/api-tokens.ts` | Pattern for hashing/validation; portal token minting |
| Change feed (cursor-lagged) | `api/src/routes/change-feed.ts` | Stays as-is for the agent's polling; webhooks are the new push path — do **not** conflate them |
| Agent read/write clients | `agent/src/shipClient.ts`, `agent/src/gate.ts` | The exact seams E7 swaps |
| Resilience kit | `agent/src/resilientClient.ts`, `circuitBreaker.ts`, `rateLimiter.ts` | Reference for the webhook deliverer's outbound HTTP |
| Cost ledger | `agent/src/costTracking.ts` + committed snapshot | Before/after proof that the rewire didn't change token volume (PF-905) |
| Testcontainers Postgres fixture + Playwright + axe | `e2e/fixtures/isolated-env.ts:119`; repo-root `playwright.isolated.config.ts` is a **spike-only** config covering one spec (`spike-isolated.spec.ts`) | Pattern for the TTFE drill's containerized Ship — the drill harness itself is new work, not reuse; OAuth consent e2e |
| Factory | `scripts/factory/*`, `.claude/skills/ship-factory` | The execution engine for this PRD |

---

## 4. Epics and tickets

Sequencing follows the brief's priority order: OAuth first (nothing has a contract without tokens), boundary lint Day 1 (one-way door), error shape before resources, OpenAPI generator before more resources, webhooks end-to-end, SDK consumed by the CLI as it's built, TTFE drill in CI as soon as SDK + one resource exist.

**Dependency spine:** E0 → E1 → E2 → {E3, E4} → E5 → E6 → E7; E8 after E3+E4; E9 partially parallel (arch doc + terraform start immediately for the defense).

Every ticket implicitly includes: unit tests, gate evidence, `CHANGES.md` entry with rollback, OpenAPI registration for any new public route, before/after proof.

### E0 — Boundary & error contract

- **PF-001 — Platform scaffold + `/api/v1` router.** Create `api/src/platform/` layout (§2.1); mount a fresh v1 router in `app.ts` sharing no internal auth/CSRF/limiter middleware with internal routes (app-global middleware still applies — §2.1); public CORS policy per §2.1 on `/api/v1/*` + `/oauth` token/device endpoints; `request_id` (UUID) middleware on every v1 request, echoed in responses and logs. *AC:* `GET /api/v1/health` 200s; a cross-origin fetch of it succeeds in a test; internal routes untouched (regression suite green).
- **PF-002 — `ApiError` + public error middleware.** The §2.5 shape from every v1 failure path, distinct 401 reasons, 404 fallthrough, 500 sanitization (no stack leaks). *AC:* unit tests per code; unknown-route and thrown-error paths both produce the shape.
- **PF-003 — Boundary lint rules.** ESLint `no-restricted-imports`: `platform/api/v1/**` cannot import `api/src/routes/**`; workspace rule + lint: `integrations/*` depend only on `@ship/sdk`; CI fails on violation. *AC:* a deliberate violation in a scratch branch fails the build (include as evidence, then revert).
- **PF-004 — Rate-limiter exemption (legacy `/api/` limiter collision).** API-1's 100 req/min/IP cap is already gone (TRO-172); what remains are the per-identity (600/min prod) and per-IP (6,000/min prod) limiters mounted on the `/api/` prefix with no skip logic (`app.ts:326-327`, `rate-limit.ts:130-132`) — a v1 router inherits both. Exempt `/api/v1`; the per-app/per-token buckets (PF-500) replace them there. *AC:* a test instantiating the limiters with prod-shaped limits (test-env defaults are 10,000/identity and 100,000/IP, so sequential requests under defaults prove nothing) shows v1 requests bypass both legacy limiters while internal `/api/` routes remain capped; document before/after.

### E1 — OAuth core  🔔

- **PF-100 — 🔔 HUMAN CHECKPOINT: OAuth walkthrough.** Before any E1 code: prepare and deliver to Troy a ~30-minute study brief — RFC 6749 roles and the two grants we implement, RFC 7636 PKCE (why public clients can't hold secrets; what S256 buys over `client_secret`), RFC 8628 device flow (user_code UX, `slow_down`), refresh rotation + family invalidation — each tied to the exact endpoint/table it becomes in Ship, plus the likely interview questions from the brief. **Block E1 until Troy acks.**
- **PF-101 — OAuth schema.** Migrations 042 + 043 (§2.2). *AC:* migrations apply cleanly on a fresh DB and on a prod-shaped DB; `\d` evidence in gate output.
- **PF-102 — App registration.** Admin endpoint to create an OAuth app: returns `client_id` + **raw secret exactly once**; SHA-256 hash at rest; rotation endpoint (old secret invalidated immediately — document the no-grace-period choice). *AC:* creation/rotation/revocation tests; raw secret absent from logs and from any subsequent response.
- **PF-103 — `/oauth/authorize` + consent screen.** Session-authed consent page in the web app (dedicated minimal route; `frame-ancestors 'none'` against clickjacking); records `code_challenge` (+ method, S256 only), validates `redirect_uri` against the app's registered list (exact match), issues single-use code. *AC:* Playwright: login → authorize → consent → redirect with code. Deny path returns `access_denied`.
- **PF-104 — `/oauth/token` (authorization_code + PKCE).** Verify `code_verifier` (S256), single-use enforcement, client auth for confidential clients. **Negative cases mandatory:** wrong verifier → `400 invalid_grant`; reused code → `invalid_grant` + revoke tokens issued from it; wrong redirect_uri → `invalid_grant`. *AC:* the graded Playwright e2e (authorize → consent → token → token works on `/api/v1/me`) plus all negative tests.
- **PF-105 — Refresh rotation + family invalidation.** One-time-use refresh tokens; rotation issues a child in the same `family_id`; **reuse of a rotated token revokes the whole family**. *AC:* unit tests for rotation, reuse-detection, family revocation; this is also the E8 drill's engine (PF-800).
- **PF-106 — Device Authorization Grant.** `POST /oauth/device/code` (user_code + device_code + interval), verification page at `/oauth/device/verify` (paste user_code, session-authed approve), `/oauth/token` polling with `authorization_pending` / `slow_down` (honored: interval increases) / `expired_token`. *AC:* integration test polling to approval; slow_down honored; this is `ship login`'s engine.
- **PF-107 — Scope registry + bearer middleware.** `ScopeRegistry` (§2.3); v1 bearer middleware populating `req.principal = { app, user, scopes }`; `require(scope)` middleware factory; 401 variants; 403 names the missing scope. The middleware accepts **two token classes**: OAuth access tokens (app + optional user) and short-lived **scoped personal tokens** minted via the `api_tokens` mechanism as extended by migration 043's `scopes text[]` column (user + scopes, `app` null; today's table has no scopes — see §2.2) — both §2.9's portal and PF-703's gated writes depend on the second class, so it is in scope here, not an afterthought. *AC:* middleware unit tests covering both token classes; a route with `require('documents:read')` rejects a token lacking it, names it in `details.missing_scope`.

### E2 — Resources & OpenAPI

- **PF-200 — Documents resource.** `GET /api/v1/documents` (cursor-paginated, keyset), `GET /:id`, `POST` — via the domain service path, `require()` scopes, Zod request/response schemas adjacent to handlers. *AC:* CRUD tests incl. pagination stability across insertions; 404/validation errors in ApiError shape.
- **PF-201 — Issues, sprints, me.** Typed views over `documents` (§2.4); `/api/v1/me` returns `{ user, app, scopes }`. *AC:* issues expose typed state/priority; sprints list; `me` works for both user tokens and client-credentials tokens (user null).
- **PF-202 — OpenAPI 3.1 generator.** v1 registry instance; spec generated from route metadata in-process, served at `/api/v1/openapi.json`; unit test validates output against the OpenAPI 3.1 JSON Schema. *AC:* spec valid; every registered route present.
- **PF-203 — Route-enumeration fitness test.** Walk the v1 router stack; assert every route (a) has an OpenAPI entry, (b) declares a scope, (c) returns ApiError on failure paths, (d) paginates if a list. **This test is the drift gate — a new route that skips registration fails CI.** *AC:* test fails when a deliberately unregistered scratch route is added (evidence, then revert).
- **PF-204 — Static spec + parity in CI.** Commit `docs/openapi.json`; CI job regenerates and diffs — drift fails the build. *AC:* drift simulation fails; refresh procedure documented.
- **PF-205 — v1 agent read surface (unblocks E7).** The agent's 10 reads (`agent/src/shipClient.ts:360-455`) map onto only 2 of the resources specced above — without this ticket, PF-702/PF-704's "every agent action through /api/v1" is unimplementable. Add read-only endpoints, each with scope + OpenAPI entry + ApiError + cursor pagination where a list: `GET /api/v1/changes` (public change-feed contract), `GET /api/v1/people`, `GET /api/v1/documents/:id/{associations,reverse-associations,backlinks,comments}`, a `?type=` filter on `GET /api/v1/documents` (PF-200 needs it anyway), an `?assignee_id=` filter on `GET /api/v1/issues`, and sprint-cadence/week-dates carried on `GET /api/v1/sprints/:id`. All under read scopes (people are documents — `documents:read` covers them; architect may split a `people:read` if consent UX wants it). PF-405's parity gate forces the matching SDK methods. *AC:* a committed checklist mapping all 10 agent reads → v1 calls; every new route passes PF-203's fitness walk.

### E3 — Webhooks

- **PF-300 — Event registry.** 8 event types with Zod payload schemas (§2.6); events-as-data (registry, not switch statements). Includes the discovery task: pin exact `properties` field names for issue state/assignee and sprint start/complete transitions against `shared/src/types` and the sprint-iterations model; record findings in the ticket. *AC:* schema unit tests; registry enumerable (portal + docs consume it).
- **PF-301 — Domain write path + `IEventBus`.** Consolidate document create/update/delete into `documentService`; both internal and v1 routes delegate; `publish()` fires there with derived issue/sprint events; in-process synchronous bus implementation. **Scoping fact (surveyed 2026-08-10):** no domain write layer exists today — `documents` INSERT/UPDATE/DELETE is inline SQL in at least nine route files (`documents.ts:624/1025/1211`, `issues.ts:858/1184/1635`, `projects.ts:702/914/1052`, `programs.ts:250/381/441`, plus `admin.ts`, `team.ts`, `workspaces.ts`, `feedback.ts`, `setup.ts`; `utils/document-crud.ts` covers only associations/history, never document rows). A tenth write site is NOT a route file and is easy to miss: the collaboration server's Yjs persist (`api/src/collaboration/index.ts:207`) does `UPDATE documents SET yjs_state, content, properties` on a debounce for every live editing session. **Decision: collab persists are excluded from event publication** — `document.updated` fires from explicit API writes only; the alternative is a webhook per keystroke-batch. Defend the exclusion in `docs/architecture.md` (PF-903). The ticket must enumerate which sites route through `documentService` (minimum: the four resource routers) and explicitly list the exclusions — a write that bypasses the service fires no webhook, so the exclusion list is a documented, defended decision, not an accident. *AC:* internal regression suite green (the refactor proof); creating an issue-type document publishes `document.created` + `issue.created`; **no publish calls exist in any route layer** (lint/grep check).
- **PF-302 — Subscriptions API.** Migration 044; `/api/v1/webhooks` CRUD gated by `webhooks:manage`; `whsec_` secret returned once, AES-256-GCM at rest (§2.2 note); active flag. *AC:* CRUD tests; secret non-recoverable via API after creation; rotation endpoint.
- **PF-303 — HMAC signer.** `Ship-Signature: t=<unix>,v1=<hex>` over `${t}.${rawBody}`; constant-time compare. Full suite: positive, tampered body, expired timestamp, missing v1, clock-skew tolerance boundary. *AC:* suite green; signing < 1 ms.
- **PF-304 — Deliverer + retries + DLQ.** Migration 045. In-memory queue, persisted attempts; schedule 1s/4s/16s/1m/5m/30m + jitter; 5xx/timeout retries, 4xx dead-letters immediately, 6 failures → DLQ. **Deterministic clock injection** — the test advances time; zero `setTimeout` waits. *AC:* the graded scenario (500×3 then 200 → succeeds on attempt 4 with correct waits ≥ 1s/4s/16s) and 6-failure → DLQ, both as fast deterministic tests.
- **PF-305 — Delivery log API.** `GET /api/v1/webhooks/deliveries` (paginated, filter by subscription/status). *AC:* every attempt visible with attempt_number, response_status, latency_ms.
- **PF-306 — Replay.** `POST /api/v1/webhooks/deliveries/:id/replay` re-emits with original `Idempotency-Key`. *AC:* replayed delivery reaches subscriber with the original key; new delivery row recorded; the graded replay-after-DLQ scenario passes.

### E4 — `@ship/sdk`

- **PF-400 — Package scaffold + core client.** `sdk/` workspace package, zero runtime deps, tsc build (ESM + types); `ShipClient` with token auth, `me()`, ApiError → typed error union mapping; cheap constructor (no I/O). *AC:* `new ShipClient({token}).me()` returns the typed user against a running server (the MVP gate check).
- **PF-401 — Resource clients.** `documents/issues/sprints/webhooks` per §2.8; method signatures match the OpenAPI spec. *AC:* integration tests for each client against a test server.
- **PF-402 — Async-iterator pagination.** `iterate()` on list clients; cursors fully internal. *AC:* iterating 3+ pages transparently; early-break doesn't overfetch.
- **PF-403 — `verifyWebhook`.** One call: parse header, tolerance check (default 300 s), constant-time HMAC compare. *AC:* valid passes; tampered fails; > 5-min-old fails; missing v1 fails; < 1 ms per call (perf test).
- **PF-404 — Auth helpers + `ITokenStore`.** `deviceLogin()` (full RFC 8628 client incl. slow_down), `authorizationCodeFlow()` (PKCE, browser), Memory/File token stores, refresh-on-401 single-flight, rotation handled. *AC:* device login e2e against local server; refresh rotation transparent to caller.
- **PF-405 — Parity + size gates.** Fitness test walking every OpenAPI operation and asserting a typed SDK method exists (and no orphan SDK methods); CI size check < 250 KB min+gz. *AC:* both gates fail on simulated drift/bloat (evidence, then revert).

### E5 — Rate limiting, audit, portal

- **PF-500 — Token buckets + headers.** Per-app and per-token buckets (§2.7); headers on 100% of v1 responses incl. errors; 429 + `Retry-After`. *AC:* header-presence fitness assertion added to PF-203's walk; bucket exhaustion/refill unit-tested with injected clock.
- **PF-501 — Public audit trail.** Migration 046; middleware records every v1 call; `GET /api/v1/audit` (admin/owner-scoped) for the portal. *AC:* rows carry request_id/app/user/route/scope/status/latency; queryable per app.
- **PF-502 — Portal: apps.** Registration + detail + rotate (shown-once UX: modal, copy button, never re-fetchable; warn before close). *AC:* Playwright flow; a11y (axe) pass; portal calls go through `/api/v1` (network-tab evidence).
- **PF-503 — Portal: subscriptions + deliveries + replay.** Subscription CRUD, delivery log w/ server-side pagination + status filter, DLQ view, replay button. *AC:* Playwright: force a failure, see it in DLQ, replay against healthy target, watch it succeed.
- **PF-504 — Portal scope checkpoint.** Explicit eval ticket: if E5 is behind after E6 is green, invoke the kill-criterion (§2.9), document the cut in the per-epic write-up. *AC:* a written go/cut decision with rationale.

### E6 — CLI + TTFE drill

- **PF-600 — CLI scaffold + `ship login`.** `integrations/cli` (commander), device flow via SDK `deviceLogin`, `FileTokenStore` at `~/.ship/credentials.json` (0600). *AC:* `ship login` prints user_code + verify URL, polls to success, `ship whoami` works.
- **PF-601 — `ship docs ls | get <id> | create --title`.** Via SDK only. *AC:* commands work against local + deployed Ship; non-zero exit + stderr ApiError rendering on failure.
- **PF-602 — `ship webhooks tail`.** Starts a local HTTP listener, registers a subscription targeting it, streams deliveries to stdout with live `verifyWebhook` check (`✓ verified` / `✗ rejected`), cleans up subscription on exit. Works against local/containerized Ship (server can reach the listener); for remote instances document the tunnel requirement. *AC:* the five-line demo story works end-to-end locally; this is the demo-video money shot.
- **PF-603 — TTFE drill in CI.** `pnpm drill ttfe`: containerized Ship (testcontainers, per repo pattern) from a clean working dir → install SDK → device login (auto-approve via API in test) → `webhooks.create` → `documents.create` → wait for signed POST → `verifyWebhook`. Per-stage elapsed-ms instrumentation logged and asserted; total < 60 s; wired into `.gitlab-ci.yml` (graded) and GitHub mirror **on every PR**; threshold config in repo. *AC:* drill green in CI on the PR; regression past threshold fails the build. The 0%-flake target is then tracked over the next 20 CI runs — any flake becomes a P0 ticket (fix the platform or the drill, never retry-mask).

### E7 — Agent as platform citizen  🔔

- **PF-700 — 🔔 HUMAN CHECKPOINT: rewire review.** Before E7 code: deliver to Troy the before/after call-path diagram (before: agent → internal `/api` with internal secret + minted tokens; after: reads as OAuth app via SDK, writes as human via SDK) and the scope defense (why the app needs only `documents:read, issues:read, sprints:read`). Named interview topic. **Block E7 until ack.**
- **PF-701 — Seed first-party app.** Idempotent boot/migration seed: `ship_app_fleetgraph`, `is_first_party`, Client Credentials grant enabled, read-only scopes; secret via env, never committed; seeding guaranteed in deployed env (terraform env var + boot check). *AC:* fresh deploy has the app; `client_credentials` grant returns a token whose `/api/v1/me` shows app identity, null user.
- **PF-702 — Reads via SDK behind flag.** `AGENT_PLATFORM_MODE=sdk|internal` (default `internal`); in `sdk` mode `ShipClient` (the agent's) delegates all 10 reads to `@ship/sdk` with the app token (client-credentials refresh handled) — **requires PF-205's v1 read surface**; `agent/` gains the `@ship/sdk` workspace dep (allowed: the agent is a platform client — `integrations/`-equivalent status; document in boundary rules). *AC:* full agent test suite green in **both** modes; behavior-parity test per read method (same fixtures → equivalent outputs).
- **PF-703 — Gated writes via SDK.** `GateShipClient`'s three writes construct a per-call `ShipClient` with the **acting human's token** in `sdk` mode; write-boundary invariants preserved (`graphWriteBoundary` suite still proves graph can't write; gate still holds no token of its own). **Token semantics (decided, consistent with §2.9):** the human's write token is a short-lived scoped personal token from the extended `api_tokens` mechanism (migration 043 adds `scopes text[]` — §2.2), accepted by the v1 bearer middleware (PF-107's second token class); the gate receives it per accepted write and retains nothing. Minting per-user OAuth tokens instead was rejected as needless flow machinery for a first-party surface. *AC:* boundary tests green in both modes; writes attribute to the human user in `public_api_audit`.
- **PF-704 — Flag matrix + audit proof.** CI runs agent tests with flag on and off; e2e in `sdk` mode: an agent turn (read-heavy chat + one accepted draft write) followed by an audit-trail query proving **every** agent action went through `/api/v1` — reads under `ship_app_fleetgraph`, the write under the human's identity — and rate-limit headers were present. *AC:* the audit rows are the Epic 7 submission proof; cost-ledger before/after shows unchanged token volume (feeds PF-905).

### E8 — Reference integrations (4 here + the CLI in E6 = the committed 5; 2 stretch)

- **PF-800 — Refresh-rotation drill.** E2E: obtain tokens → rotate → *reuse the old refresh token* → assert entire family invalidated, active sessions killed, distinct error code. Written as a narrated test ("the stolen-token story") — it doubles as a discovery write-up. *AC:* deterministic e2e green in CI.
- **PF-801 — Idempotency-Key drill.** E2E: deliver → replay via API → reference subscriber (test fixture) dedupes on the key; delivery log distinguishes fresh vs replayed keys. Documents the subscriber-dedupe contract. *AC:* deterministic e2e green in CI.
- **PF-802 — Browser SDK demo.** `integrations/browser-demo`: minimal SPA (Vite vanilla-TS), `authorizationCodeFlow()` with PKCE (no secret in browser), lists the user's documents via async iterator; localStorage token store. *AC:* Playwright: full PKCE round-trip P95 < 3 s; README with run instructions.
- **PF-803 — Slack integration.** `integrations/slack`: Express receiver that verifies Ship webhooks (`verifyWebhook`) and posts `document.created` / `issue.assigned` to channels via Slack OAuth (bolt or plain web API). *AC:* live demo path documented (workspace setup steps); e2e with a mocked Slack API; screenshot evidence for the demo.
- **PF-804 — (stretch, time-boxed 1 day) GitHub integration.** Ship issues ⇄ GitHub PRs via webhook + GitHub App. Attempt only after PF-800–803 are gated.
- **PF-805 — (stretch, time-boxed 1 day) In-process plugin runtime.** `isolated-vm`, one `document.beforeCreate` hook, hard CPU/memory caps, explicitly experimental. Attempt only after everything else including stretch #1.

### E9 — Infrastructure, docs, submission

- **PF-900 — Terraform extension.** All new env vars/services in `terraform/render/`; providers pinned; annotated `terraform plan` output committed as a submission artifact. **Start Day 1 — defense material.** *AC:* plan runs clean; zero console-only config.
- **PF-901 — Destroy-redeploy + drift.** Full `terraform destroy` → `apply` from config alone; logs proving identical service recovery (incl. seeded grader + agent apps); manual-drift demo (dashboard edit → plan diff). Mind TRO-361: deploy verification is manual via Render API. *AC:* both evidence artifacts committed.
- **PF-902 — IAM adaptation memo.** One page: AWS task/execution role + least-privilege exercise mapped to Render's model (API-key scoping, service isolation, secret handling); what Render can't express; why acceptable here. Feeds the defense. *AC:* memo in `docs/`, referenced by architecture doc.
- **PF-903 — `docs/architecture.md`.** 1–2 pages, exactly the brief's mandated sections: module layout tree (one sentence per module) · SOLID rationale with file paths (ScopeRegistry→OCP, IEventBus→DIP, SDK resource clients→ISP) · composition-root pseudo-code + in-memory test wiring sibling · public/internal boundary sequence diagram · OAuth flow diagrams (PKCE validation + rotation points marked) · webhook pipeline (signature + Idempotency-Key origins marked) · SDK surface w/ stable-vs-pre-1.0 marks · agent-as-citizen before/after (audit-log payoff marked) · failure modes (corrupted token store / mid-flight secret rotation / deliverer crash / OpenAPI generator boot-throw — one paragraph each). **Start Day 1 — defense material.**
- **PF-904 — 🔔 HUMAN CHECKPOINT: pre-search + demo.** Draft the three-phase Pre-Search document with everything derivable from this PRD pre-filled; **notify Troy** for the answers only he has (hours/day, honest skill inventory, budget ceilings) and for demo-video recording (agent writes the script/shot list: five-line story in a fresh terminal → portal replay → TTFE CI run). *AC:* pre-search complete with Troy's real answers attached; the saved AI conversation exported and attached as a reference artifact (brief mandate — the PRD-research/review conversations qualify); script committed; Troy has recorded or scheduled the video.
- **PF-905 — AI cost analysis.** Platform is LLM-free (state it; the only LLM path remains user-initiated agent turns). Dev-cost tracking: LLM spend during E7 (cost-ledger before/after proving unchanged token volume), TTFE CI minutes (timed Day 1, weekly bill projected), Playwright OAuth compute, spec-gen overhead, delivery-log storage growth at demo volume. Production projections at 100/1k/10k/100k users with **explicit assumptions: webhook fanout ratio, agent active rate, retention windows (delivery log + audit rows) with rationale**. *AC:* committed doc; figures traceable to ledger/CI data, not vibes.
- **PF-906 — Per-epic write-ups + three discoveries.** Before → fix → after → proof per epic (E6's proof: TTFE green in CI; E7's: the audit rows). Three discoveries drafted from the strongest candidates: Device Grant in TypeScript, zod→OpenAPI fitness parity, Stripe-style HMAC anti-replay, async-iterator pagination DX. *AC:* committed; claims follow CLAUDE.md provenance discipline (observed vs derived, evidence linked).
- **PF-907 — Grader access.** Seeded read-only grader OAuth app; credentials + one-command setup in README (per repo convention, alongside existing `alice.chen` grader creds); deployed instance verified: portal reachable, `/api/v1/openapi.json` resolvable publicly. *AC:* a clean-machine run of the README steps succeeds; GitHub repo visibility verified **public** (brief mandate — not yet checked as of 2026-08-10).
- **PF-908 — Demo assets + social post.** Final demo script (3–5 min): five-line story → portal DLQ replay → CI drill run; social post draft tagging @GauntletAI with the `ship webhooks tail` verified-event screenshot. *AC:* committed; Troy posts (human action).

---

## 5. Graded testing scenarios → where they're covered

| Brief's test | Covered by |
|---|---|
| PKCE e2e via Playwright + wrong-verifier negative | PF-103, PF-104 |
| Device flow from a test CLI, slow_down honored, token works on `/me` | PF-106, PF-600 |
| Fitness: every v1 route has spec entry / scope / ApiError / pagination | PF-203 (+ PF-500 headers) |
| `openapi.json` validates against OpenAPI 3.1 schema; SDK exposes every method | PF-202, PF-405 |
| Subscription via SDK → doc create → signed POST < 2 s → tamper rejected | PF-603, PF-403 |
| 500×3 then 200 → retries at ≥ 1s/4s/16s → success logged | PF-304 |
| 6 failures → DLQ → portal-visible → replay w/ original idempotency key | PF-304, PF-306, PF-503 |
| TTFE drill end-to-end < 60 s CI / < 30 min clean machine | PF-603, PF-907 |

**Performance targets** (asserted where testable): TTFE CI P95 < 60 s · TTFE clean-machine ≤ 30 min · PKCE round-trip P95 < 3 s · spec parity 100% · first-attempt webhook latency P95 < 2 s · retry success after transient 5xx 100% within schedule · rate-limit headers 100% · `verifyWebhook` < 1 ms · SDK < 250 KB min+gz · drill flake 0%/20 runs · P95 latency, bundle size, per-route query counts ≤ +10% vs the Part 1 baselines in `audit/` (existing baseline files are the comparison source).

---

## 6. MVP cut line (hard gate, day 2)

All of: PF-001…004 · PF-100…107 (OAuth registration, PKCE e2e w/ negatives, bearer middleware, scope 403s) · PF-200 (documents GET-list/GET/POST w/ scopes) · PF-202 + PF-203 (spec served + fitness) · PF-400 (`me()` via SDK) · regression suite green with ≤ +10% baselines · PF-900 (terraform plan artifact) · deploy live with grader app (PF-907 minimum: seeded app + README creds).
Everything else is post-MVP. If the gate is at risk, cut from the top of E5 (portal) and E8 (Slack) first — never from E1/E2 correctness or negative tests.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| OAuth subtle-wrongness (top grading risk) | PF-100 study checkpoint; negative tests mandated per ticket; IETF-minimal scope (no implicit grant, no plain PKCE, S256 only) |
| PF-301 domain refactor destabilizes internal API | Smallest-possible consolidation; full regression suite is the gate; flag-free (refactor, not behavior change) |
| TTFE flake (0% tolerance) | Deterministic clocks everywhere; testcontainers isolation; no timing-based waits; flake = P0 bug |
| Render can't express an IaC requirement literally | PF-902 memo converts a gap into defense material |
| Agent behavior drift in `sdk` mode | Per-method parity tests (PF-702); flag default stays `internal` until PF-704 matrix is green |
| Sunday AM deadline | Everything lands Saturday night; E9 defense artifacts start Day 1, not last |

---

## 8. Out of scope (explicitly)

GraphQL; npm-publishing the SDK (workspace package + documented publish procedure only); horizontal scaling of the webhook queue (interface-ready, not built); platform-layer LLM features of any kind ("smart scope suggestions" is named scope-creep in the brief); new content types or editors; GitHub/plugin-runtime beyond their time boxes.
