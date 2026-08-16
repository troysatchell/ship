# Ship Platform Architecture

**Status:** Day-1 skeleton (PF-903 / TRO-424). Living document — updated as each Week 6 epic
(E0–E9, see `PLUGFORGE.MD`) lands; final accuracy pass near submission. Sections below describe
**decided design** (`PLUGFORGE.MD` §2 + the PM triage decisions recorded across the project's
tickets), not yet-observed runtime behavior for the new platform surface specifically — as of this
writing no platform code has landed (verified: no `api/src/platform/`, `sdk/`, or `integrations/`
directories exist in this worktree). **Scope of that caveat:** it applies to paths under
`api/src/platform/`, `sdk/`, and `integrations/` — those are planned locations, refreshed against
the real code once the owning ticket lands. It does **not** apply to citations of code that already
exists and ships today — `api/src/app.ts`, `agent/src/shipClient.ts:337`,
`api/src/collaboration/index.ts:207` — which are observed (read directly, 2026-08-10) and describe
current behavior this platform work builds on top of, not a future state.

**Scope:** PlugForge (Week 6) — Ship's public platform layer: `/api/v1`, OAuth 2.0, signed
webhooks, `@ship/sdk`, and the FleetGraph agent rewired as a platform citizen. `PLUGFORGE.MD` is
the source of record for the full PRD; this document covers only the brief's mandated
architecture sections. Where the two disagree, `PLUGFORGE.MD` wins — file a doc-fix ticket rather
than trusting this file over it.

---

## Module Layout

New code lands under three roots (`PLUGFORGE.MD` §2.1), one sentence per module:

```text
api/src/platform/           # NEW — the platform layer
  oauth/                    #   OAuth 2.0 flows, endpoints, PKCE, token issuance/rotation
  scopes/                   #   ScopeRegistry — scopes registered as data, not switch statements
  ratelimit/                #   Per-app/per-token token buckets + response-header middleware
  webhooks/                 #   Event registry, IEventBus, HMAC signer, deliverer, DLQ, replay
  audit/                    #   Public API audit trail (writes public_api_audit rows)
  api/v1/                   #   The public router: resources, ApiError shape, cursor pagination
  openapi/                  #   v1 OpenAPI 3.1 registry + in-process spec generator
sdk/                        # NEW — @ship/sdk workspace package; the only sanctioned way integrations/* reach Ship
integrations/               # NEW — cli/, browser-demo/, slack/ — depend on @ship/sdk only, never api/src
```

Existing modules (`api/src/routes/**`, `api/src/middleware/**`, `web/`, `agent/`) keep their
current shape. `api/src/platform/api/v1/**` calls the same domain services the internal routes
call — it must never import `api/src/routes/**` directly (enforced by lint, PF-003).

---

## SOLID Rationale

| Component | File path (planned) | Principle | Why |
|---|---|---|---|
| `ScopeRegistry` | `api/src/platform/scopes/` | **OCP** (Open/Closed) | New scopes register themselves at module load (§2.3); the enforcement path (`require(scope)` middleware) is never edited to add one — open for extension via registration, closed for modification of the check itself. |
| `IEventBus` | `api/src/platform/webhooks/` | **DIP** (Dependency Inversion) | The domain write path depends on the `IEventBus` / `IWebhookDeliverer` interfaces, not a concrete queue. The must-ship in-process/in-memory implementation is a Liskov-substitutable drop-in for a future queue-backed one — high-level policy ("publish on write") doesn't depend on low-level delivery detail. |
| SDK resource clients (`DocumentsClient`, `IssuesClient`, `SprintsClient`, `WebhooksClient`) | `sdk/src/` | **ISP** (Interface Segregation) | `@ship/sdk`'s `ShipClient` exposes one narrow client per resource instead of one god-object with every method — a CLI consuming only `documents` never depends on `webhooks`' surface. |

---

## Composition Root

`api/src/app.ts` remains the single wiring point (§2.1). It constructs every platform dependency
concretely and injects it — nothing below reaches into a singleton.

```ts
// api/src/app.ts — composition root (pseudo-code; PF-001 fills in the real wiring)
const scopeRegistry = new ScopeRegistry()                          // registers scopes at import time
const rateLimiter    = new TokenBucketRateLimiter({ perApp: 120, perToken: 60 })
const eventBus       = new InProcessEventBus()                     // IEventBus
const deliverer      = new InMemoryWebhookDeliverer(pool, systemClock) // IWebhookDeliverer, persists every attempt
const oauthStore     = new PostgresOAuthStore(pool)

const apiV1Router = createApiV1Router({ scopeRegistry, rateLimiter, eventBus, oauthStore, deliverer })
app.use('/api/v1', apiV1Router)
```

**In-memory test-wiring sibling** — tests construct the same dependency graph with in-memory
doubles, so unit tests never touch Postgres or a real timer:

```ts
// api/src/platform/**/__tests__ wiring — in-memory sibling of the composition root above
const scopeRegistry = new ScopeRegistry()                          // same as composition root — no I/O, no double needed
const rateLimiter    = new TokenBucketRateLimiter({ perApp: 120, perToken: 60 }) // same as composition root — no I/O, no double needed
const eventBus       = new InProcessEventBus()                     // already in-memory — no double needed
const deliverer      = new InMemoryWebhookDeliverer(new FakePool(), new FakeClock()) // in-memory pool double + deterministic clock (§2.6)
const oauthStore     = new InMemoryOAuthStore()                    // test double
const router = createApiV1Router({ scopeRegistry, rateLimiter, eventBus, oauthStore, deliverer })
```

Same pattern FleetGraph's own tests already use for `ItemStore` (`agent/`): construct the real
composition-root shape, swap only the I/O-bound piece.

---

## Public/Internal Boundary — Sequence Diagram

Skeleton fidelity — refine once PF-001/PF-107 land.

```mermaid
sequenceDiagram
    participant Client
    participant V1 as /api/v1 router (platform/api/v1)
    participant Bearer as Bearer auth + ScopeRegistry
    participant Domain as documentService (domain layer)
    participant Internal as /api router (internal)
    participant DB as Postgres

    Client->>V1: GET /api/v1/documents (Authorization: Bearer ...)
    V1->>Bearer: authenticate + require('documents:read')
    Bearer-->>V1: req.principal = { app, user, scopes }
    V1->>Domain: documentService.list(...)
    Domain->>DB: SELECT ... FROM documents
    DB-->>Domain: rows
    Domain-->>V1: typed resource
    V1-->>Client: 200 { data, next_cursor } + X-RateLimit-* headers

    Note over Internal,Domain: Internal routes call the SAME documentService.<br/>Neither router imports the other (PF-003 lint) — no shared<br/>auth/CSRF/rate-limit middleware, app-global middleware excepted.
```

---

## OAuth Flow Diagrams

Skeleton fidelity — refine as E1 (PF-100–PF-107) lands. Three grants ship, hand-rolled and
IETF-minimal (RFC 6749 + 7636 + 8628 — no implicit grant, no plain-method PKCE, S256 only): two
user-facing grants + `client_credentials` for first-party apps. `PLUGFORGE.MD`'s "two grants"
phrasing refers to the two user-facing ones diagrammed below (Authorization Code + PKCE, Device
Authorization); `client_credentials` is a third, architect-added grant (PF-104) for first-party
apps only — its sole consumer is the FleetGraph agent (`ship_app_fleetgraph`, see Agent as Platform
Citizen, below), so no separate flow diagram: RFC 6749 §4.4 is a single token-endpoint POST with no
redirect or polling steps to sequence.

### Authorization Code + PKCE (rotation points marked)

```mermaid
sequenceDiagram
    participant App as Client app
    participant Browser
    participant Ship as /oauth/authorize, /oauth/token

    App->>App: generate code_verifier; code_challenge = S256(code_verifier)
    App->>Browser: redirect to /oauth/authorize?code_challenge=...&method=S256
    Browser->>Ship: session-authed consent screen
    Ship-->>Browser: redirect with single-use code (10 min TTL)
    Browser-->>App: code
    App->>Ship: POST /oauth/token { code, code_verifier }
    Ship->>Ship: verify code_verifier against stored code_challenge (S256)
    Ship-->>App: access_token (1h) + refresh_token (30d, one-time-use)

    Note right of Ship: ROTATION POINT 1 — refresh: each use issues a child<br/>token in the same family_id and consumes the parent.
    App->>Ship: POST /oauth/token { grant_type: refresh_token }
    Ship-->>App: new access_token + rotated refresh_token

    Note right of Ship: ROTATION POINT 2 — reuse of an already-rotated refresh<br/>token revokes the ENTIRE family_id (stolen-token detection).
```

### Device Authorization Grant

```text
ship login  --->  POST /oauth/device/code
                     <--- { device_code, user_code: "BDWJ-KXQT", verify_url, interval }
CLI prints user_code + verify_url, polls POST /oauth/token { device_code }

User      --->  visits verify_url, enters user_code, approves (session-authed)

CLI poll  <---  authorization_pending  -->  (slow_down: interval++)  -->  access_token
```

---

## Webhook Pipeline

```text
domain write (documentService) -> IEventBus.publish -> subscription matcher
  -> HMAC signer -> IWebhookDeliverer (retry scheduler) -> delivery log -> DLQ -> replay
```

- **Signature origin:** computed by the HMAC signer (`api/src/platform/webhooks/`) at delivery
  time, over `${t}.${rawBody}` using the subscription's decrypted signing secret (decrypted only
  to compute the HMAC key, never for display) — header
  `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`, attached immediately before the
  outbound POST. Subscribers call the SDK's `verifyWebhook()` (default 300s tolerance,
  constant-time compare).
- **Idempotency-Key origin:** the *original* delivery's identifier. A first-attempt delivery
  generates one; `POST /api/v1/webhooks/deliveries/:id/replay` reuses that **same** key on the
  replayed delivery, so a subscriber's own dedupe logic treats a replay as "already seen," not as
  a new event (PF-306).
- Retry schedule: 1s, 4s, 16s, 1m, 5m, 30m with jitter. 5xx/timeout retries; 4xx dead-letters
  immediately; 6 failed attempts → DLQ. Tested with an **injected deterministic clock** — never a
  real `setTimeout` wait (§2.6).

### Subscriber dedupe contract (PF-801 / TRO-447)

The "Idempotency-Key origin" bullet above states the platform-side half of this contract; this is
the integrator-facing half — what a real subscriber implements on the receiving end, now proven
end-to-end (deliver → replay → dedupe) by `e2e/webhook-idempotency-key-drill.spec.ts` and, at the
tier the factory gate actually executes, `api/src/platform/api/v1/resources/__tests__/webhooks.test.ts`'s
own "PF-801" describe block.

1. **Idempotency keys are stable across replay.** A first-attempt delivery mints a fresh
   `Idempotency-Key` (`deliverer.ts`'s `enqueueEvent()`, `randomUUID()` per logical delivery).
   `POST /api/v1/webhooks/deliveries/:id/replay` never generates a new one — it reads
   `idempotency_key` off the original delivery row and resends it verbatim
   (`resources/webhooks.ts`'s own header). A genuinely NEW event always gets a genuinely NEW key;
   a REPLAY of an existing delivery always carries the SAME key its original attempt did. That
   single fact is what makes `Idempotency-Key` a valid dedupe key in the first place.
2. **How to implement dedup: check-then-store on `Idempotency-Key`, always return 200.** On each
   inbound POST — after verifying `Ship-Signature` — check whether `Idempotency-Key` has already
   been recorded. If not, process it and store the key (with whatever durability a real production
   subscriber needs — the reference implementation below uses an in-memory `Map`, which is
   sufficient to prove the contract but not what a production subscriber should ship). If the key
   HAS been seen before, do not reprocess it as a new logical delivery — but still respond with a
   2xx status either way. This second half matters as much as the first: Ship's own deliverer
   (`deliverer.ts`) reads a non-2xx/non-5xx response as a permanent failure (dead-lettered
   immediately) and a 5xx/timeout as retryable (re-sent per the retry schedule above) — neither
   outcome means "already handled." Only 2xx tells the sender to stop.
   **Missing or empty `Idempotency-Key`:** reject with a 4xx (the reference implementation uses
   400) — there is nothing to dedupe on, and a 4xx tells the sender's retry logic this is a
   permanent failure to fix, not a transient one to retry as-is.
   **Make the claim atomic — a real integration point CodeRabbit's review of this ticket correctly
   raised.** The reference implementation's check-then-store is safe only because it is
   synchronous, single-threaded JavaScript with no `await` between the check and the store — Node's
   event loop cannot interleave two deliveries mid-handler. A REAL production subscriber almost
   never has that guarantee: if "check" and "store" are separate operations against a database
   (even a fast one), two concurrent deliveries with the same key can both pass the check before
   either has stored it, and both get processed as if fresh. Implement the claim as a single atomic
   operation — a unique constraint on `idempotency_key` plus `INSERT ... ON CONFLICT DO NOTHING`
   (or equivalent), never a separate read-then-write — and treat "the insert found an existing row"
   as the dedupe signal itself, not a prior `SELECT`. Define what happens when a claim is already
   in progress (another request for the same key hasn't finished processing yet): either block
   until it resolves, or return 2xx immediately and let the original request's outcome stand —
   document whichever choice a real implementation makes, since a caller polling for consistency
   needs to know which.

**Copyable reference implementation:** `docs/submission/demo-webhook-listener.mjs`'s
`createReferenceSubscriber()` — a genuine, small, standalone HTTP listener implementing exactly
this contract (verify `Ship-Signature`, check-then-store on `Idempotency-Key`, 200 either way, in
about 60 lines). Run it directly as a CLI demo (`node docs/submission/demo-webhook-listener.mjs`),
or import `createReferenceSubscriber` the same way this repo's own e2e drill and vitest coverage
do — it's the identical function in all three places, not three separate reimplementations.

---

## SDK Surface

`@ship/sdk` (`sdk/`), zero runtime dependencies, native `fetch`:

```ts
class ShipClient {
  readonly documents: DocumentsClient;
  readonly issues:    IssuesClient;
  readonly sprints:   SprintsClient;
  readonly webhooks:  WebhooksClient;
  constructor(opts: { token?: string; baseUrl?: string; tokenStore?: ITokenStore });
  me(): Promise<Me>;
  static authorizationCodeFlow(opts): Promise<ShipClient>;   // browser PKCE, no secret
  static deviceLogin(opts): Promise<ShipClient>;
}
function verifyWebhook(headers, rawBody, secret, toleranceSec = 300): boolean; // < 1 ms
```

**Stable vs. pre-1.0** — this is this project's own API-shape commitment, not semver of a
published package (`sdk/` stays a workspace package; npm-publishing is explicitly out of scope,
§8):

| Surface | Mark | Why |
|---|---|---|
| `ShipClient` constructor, `me()`, `documents` / `issues` / `sprints` resource clients, `verifyWebhook`, async-iterator pagination (`iterate()`) | **stable** | Directly mirrors the OpenAPI spec; PF-405's parity fitness test keeps it that way. Shape is fixed by the resources in §2.4 and shouldn't change without a spec change. |
| `webhooks` resource client (subscriptions / deliveries / replay CRUD) | **stable** once PF-401 lands | Same parity guarantee as above — called out separately only because it ships slightly later (E4). |
| `deviceLogin()` / `authorizationCodeFlow()` auth helpers, `ITokenStore` with three built-in stores — `MemoryTokenStore` and `LocalStorageTokenStore` (browser, `{ storageKey? }`) from `@ship/sdk`, `FileTokenStore` from `@ship/sdk/node` (TRO-617) | **pre-1.0** | Hand-written against the OAuth flows, not generated from the spec — §2.8 names this openly as a trade-off (type quality over generated drift-safety). Signatures may still move during E4/E6 build-out (CLI, browser demo) before they're proven against real integrations. |

---

## Agent as Platform Citizen — Before / After

**Before (Week 5, shipped):** FleetGraph (`agent/`) reads Ship's internal REST API directly via
its own `ShipClient` (`agent/src/shipClient.ts:337`, 10 read methods) and writes through
`GateShipClient` (`:569`, 3 writes) using the acting human's token, passed explicitly per call. No
OAuth, no scopes, no public audit trail — the agent is a privileged insider talking to internal
routes with a hand-rolled client.

**After (Epic 7, PF-700–PF-704):** the agent authenticates as a first-party OAuth app
(`ship_app_fleetgraph`, Client Credentials grant, read-only scopes `documents:read, issues:read,
sprints:read`) for its 10 reads, and as the acting human (a short-lived scoped personal token —
PF-107's second token class) for its 3 gated writes. **Both paths go through `@ship/sdk`** — the
same package any third-party integration uses — gated behind `AGENT_PLATFORM_MODE=sdk|internal`
(default stays `internal` until PF-704's flag matrix is green). The write-boundary invariant is
unchanged: `graph.ts` still structurally cannot write (`graphWriteBoundary.test.ts` still proves
it), only `gate.ts` can, and it still holds no token of its own — before and after, only the
transport underneath the gate's writes changes.

**Audit-log payoff:** every agent action — the 10 reads under `ship_app_fleetgraph`'s `client_id`,
each of the 3 writes under the acting human's `user_id` — now lands a row in `public_api_audit`
(request_id, client_id, user_id, route, scope used, status, latency). Epic 7's submission proof
(PF-704) is literally querying that audit trail for the agent's `client_id` and showing every
action it took — a fact that was structurally unobservable before this rewire, because internal
routes carry no such trail.

**TTFE drill — two API modes (TRO-621, W6-R55).** `pnpm drill ttfe` (`scripts/drill/ttfe.ts`,
PLUGFORGE.MD §4/§5's timed install → device login → webhook → document → signed delivery →
`verifyWebhook` proof) runs the API under test in one of two modes, printed as `api: tsx child`
or `api: image <ref>` in its header and above its per-stage table. The default (`tsx`) spawns
`api/src/index.ts` from the checkout, unchanged since TRO-455 — what `gate.sh` G12, GitLab's
`drill-ttfe`, and GitHub's `drill-ttfe` job run. Setting `DRILL_TTFE_API_IMAGE=<image ref>` (ruling
I-07, "containerized Ship instance") instead starts that image — the root `Dockerfile`, the same
artifact CI's `build-image` job pushes — with testcontainers' `GenericContainer` under the image's
own `NODE_ENV=production`, waits for `GET /health` 200, and runs the identical six stages against
the host-mapped port; GitHub's `drill-ttfe-image` job does this on every PR (GitHub-only: GitLab's
shared runner cannot start containers). Production mode is what makes this a real proof and what
constrains it: `api/src/db/ssl.ts` requires TLS to Postgres in production, so the drill either
reuses an ambient `DATABASE_URL` whose server accepts TLS (reached from the container via
`host.docker.internal`) or — when the ambient server is plaintext-only, or no `DATABASE_URL` is
set — starts its own `ssl=on` Postgres on a private docker network the API container joins by
alias, saying which it did and why. Mode selection, the container env, and that TLS decision are
pure functions in `scripts/drill/ttfe-api-mode.ts` (unit-tested; see its header).

---

## Failure Modes

**Corrupted token store.** `oauth_tokens` / `oauth_apps` hold hashes, not raw tokens
(`access_token_hash`, `client_secret_hash`) — a corrupted or truncated hash column fails closed:
the incoming bearer token's hash won't match any row, so the request gets an ordinary
`401 unauthorized` (`details.reason: invalid`), not a crash or an auth bypass. The dangerous case
is corruption of the `family_id` / `parent_id` chain that refresh-rotation reuse-detection depends
on — a broken family graph could fail to revoke a stolen token's family correctly. Mitigation:
rotation/family-invalidation logic is unit-tested directly against the schema (PF-105); a
corrupted store is a data-integrity incident to catch via routine `\d`-style verification (per this
repo's DB-1 precedent), not something the request path is expected to self-heal.

**Mid-flight secret rotation.** A webhook signing secret (`whsec_...`) is shown once and stored
encrypted (see Documented Deviations, below) — rotating it invalidates the old secret immediately
(the same no-grace-period choice as OAuth app-secret rotation, PF-102). A delivery already queued
or mid-retry at rotation time was signed correctly under the secret valid at send time; the
failure mode is a subscriber-side race between "receive delivery" and "pick up the new secret from
the portal," not a signing defect on Ship's side. Documented here as an explicit gap: no
dual-secret verification window ships in Week 6.

**Deliverer crash.** The webhook deliverer is an in-memory queue on a single Render instance
(§2.6 — same justified precedent as FleetGraph's `ItemStore`), so a process crash loses whatever
existed only in memory. What survives: every attempt already made is persisted to
`webhook_deliveries` (migration 048 — PLUGFORGE.MD's own §2.6 table says "045", but that number was
long consumed by PF-104's OAuth work; same renumbering situation 046/047 already document) before
the deliverer moves on, so the delivery log, DLQ, and replay are durable. What's lost on crash: an
attempt that was scheduled (`next_attempt_at` computed) but not yet persisted, and any in-flight
HTTP call whose response never got recorded. **Recovery: shipped (PF-304, TRO-438).**
`InMemoryWebhookDeliverer.rehydrate()` (`api/src/platform/webhooks/deliverer.ts`) scans every
`webhook_deliveries` row with `status = 'pending'` — a row-per-attempt lifecycle means only
`'pending'` ever means "scheduled but not yet executed"; a `'failed'` row is itself a completed,
terminal record of one past attempt, and the still-outstanding retry it scheduled is always a
separate `'pending'` sibling row (see migration 048's header for the full state machine) — and
re-enqueues each one into the fresh in-memory queue, due at its persisted `next_attempt_at`. Wired
from `api/src/index.ts` (the real process entrypoint), called once at boot before the deliverer
starts polling — never from `app.ts`/`createApp()`, which every test file imports, so no background
recovery scan or polling timer runs during `pnpm test`. Proven by
`platform/webhooks/__tests__/deliverer.test.ts`'s "rehydrate() restores a pending attempt into a
FRESH deliverer instance after a simulated crash" case: one deliverer instance schedules a retry,
its in-memory queue is discarded (simulating the crash), and a brand-new instance restores and
completes that same delivery via `rehydrate()` alone.

**OpenAPI generator boot-throw.** The v1 spec (`/api/v1/openapi.json`) is generated in-process
from route metadata at boot (PF-202), not committed-then-served — if a route's Zod schema fails to
compose into valid OpenAPI (a circular `z.lazy()` reference, or a route registered without the
scope/response metadata PF-203's fitness walk expects), the generator throws during `app.ts`'s
composition-root construction. Decision: this should fail the boot, not silently serve a stale or
partial spec — an API whose spec can't be trusted is worse than an API that won't start, and
PF-203's fitness test is the CI-time backstop meant to catch a malformed route before it ever
reaches a running boot. Not yet decided: whether a future iteration should instead log-and-exclude
just the offending route while still failing CI, if one bad route blocking all of `/api/v1` proves
too disruptive in practice — revisit if PF-202/PF-203 hit this for real.

---

## Documented Deviations

**Signing secret: encrypted, not hashed (§2.2 note).** The brief says "hashed signing secret." A
one-way hash is unimplementable for this purpose: the server must recover the plaintext secret at
delivery time to compute the HMAC signature, and a hash cannot be reversed by design. Decision:
generate `whsec_...` secrets, return the plaintext exactly once (creation/rotation), and store it
**encrypted** at rest (AES-256-GCM, key from `SECRET_ENCRYPTION_KEY`) rather than hashed — the same
pattern Stripe uses for webhook signing secrets. This is a deliberate, defensible deviation from
the brief's literal wording, not an oversight, and a likely interview question.

Implemented by PF-302 (Linear TRO-431, migration `047_webhook_subscriptions.sql`):
`api/src/platform/webhooks/secretEncryption.ts` (`encryptSecret`/`decryptSecret`, the packing
format for the single `signing_secret_ciphertext` column) and `api/src/platform/webhooks/secrets.ts`
(`whsec_...` generation). `/api/v1/webhooks` (`api/src/platform/api/v1/resources/webhooks.ts`)
returns the plaintext exactly once, on `POST /` and `POST /:id/rotate` — no other route, including
`GET`/list, ever selects or serializes the ciphertext column.

**Collab-persist events excluded from webhook publication (PF-301, landed TRO-426).** The Yjs
collaboration server's autosave (`api/src/collaboration/index.ts:207`) does a debounced
`UPDATE documents SET yjs_state, content, properties ...` on every live editing session — a tenth
document-write site alongside the nine route files that did inline writes before this ticket — a
count of *files*, not of individual write call sites; several of those nine (and the four
consolidated routers themselves) contain more than one `INSERT`/`UPDATE`/`DELETE` each (CodeRabbit,
TRO-426: flagged this framing as ambiguous — see CHANGES.md's TRO-426 entry for the full
site-by-site enumeration, including secondary endpoints inside the four consolidated routers that
this PR left inline).
Decision: `document.updated` fires only from explicit API writes routed through `documentService`
(the four resource routers), never from the collaboration autosave path. The alternative — a webhook
per keystroke-batch debounce — would mean a subscriber gets an event every few seconds per open
editor, which is not what "a document changed" means to an integration. This is a documented,
defended exclusion, not an accident: any write that bypasses `documentService` fires no webhook, and
enumerating exactly which sites route through it versus which are excluded is PF-301's own AC.

**Two more exclusions, found only by re-grepping the live tree at implementation time (the
2026-08-10 survey above was stale, exactly as this ticket's own brief warned it might be):**
- **`api/src/routes/weeks.ts`** owns every sprint/standup/weekly_review/weekly_plan document write —
  including the actual production sprint `planning → active → completed` transitions
  (`POST /:id/start`, `PATCH /:id`). It is not one of the four named resource routers, so it was
  left as inline SQL. `documentService.updateDocument()` still implements and unit-tests
  `sprint.started`/`sprint.completed` derivation. Reachability, precisely: `documents.ts`'s generic
  `PATCH /:id` is the ONE consolidated primary endpoint with no `document_type` filter at all — it
  would reach sprint derivation if called against a sprint document's id, and is the only one of the
  eight consolidated primary endpoints (four routers × create/update/delete, minus create/delete
  which don't apply here) for which that's even possible. `projects.ts`'s and `programs.ts`'s
  `PATCH /:id` are filtered to `document_type = 'project'`/`'program'` respectively and structurally
  cannot reach it; `issues.ts`'s `PATCH /:id` has no filter either but is only ever called against
  issue ids by every real caller. In practice, no production caller sends a sprint id to
  `documents.ts`'s `PATCH /:id` today, so the derivation is exercised only by
  `documentService.test.ts`'s direct unit tests, not by any live request path. A ~3600-line file
  with ~20 write sites was judged out of proportion for "smallest-possible
  consolidation" on this ticket's own stated risk profile. Note the precise claim here: none of the
  four routers' *consolidated primary create/update/delete* endpoints ever touch a sprint document
  (each filters to its own `document_type`) — that is narrower than "none of the four router *files*
  ever write a sprint document," which is false: `projects.ts`'s secondary, non-consolidated
  `POST /:id/sprints` endpoint genuinely creates `document_type = 'sprint'` documents (CodeRabbit,
  TRO-426, caught an earlier draft overstating this). See CHANGES.md's secondary-write-sites list.
- **`api/src/routes/feedback.ts:146`** creates `document_type = 'issue'` documents from a public,
  unauthenticated external-feedback endpoint — directly on point for "creating an issue-type
  document," so issues created this way do not fire `issue.created`. Excluded for the same
  blast-radius reasoning; flagged as a known gap rather than silently implied fixed.

**Composition root note.** The pseudo-code above shows `eventBus` constructed in `app.ts` and
injected via `createApiV1Router({ ..., eventBus, ... })`. That full composition root is PF-001's
job and does not exist yet — nothing else it would be injected alongside (`rateLimiter`,
`deliverer`, `oauthStore`) is a real class yet either. `documentService.ts` reaches the bus via
`eventBus.ts`'s `getEventBus()` module singleton instead (with `setEventBusForTesting()` /
`resetEventBusForTesting()` seams for test isolation) — a deliberate, minimal stand-in that does not
block the DI wiring shown above: `InProcessEventBus` is exported and constructible exactly as the
pseudo-code expects, so a future ticket can inject a concrete instance through `app.ts` and update
`documentService` to accept it, without changing the class itself.

---

## Cross-References

- **IAM adaptation memo** (Render vs. AWS least-privilege mapping) — **PF-902**, at
  `docs/IAM-ADAPTATION-RENDER.md`. *(Derived, not independently verified from this worktree: as of
  this writing PF-902 has landed on branch `docs/pf-902-iam-memo`, not yet merged to `main` — the
  path is a cross-ticket fact, not a file read directly. Confirm the path once that branch merges.)*
- **Per-epic before/after write-ups and the three discovery drafts** — **PF-906**.
- `PLUGFORGE.MD` §2 is the source of record for the data model, scopes list, error contract, and
  rate-limit defaults; this document restates only what the brief's mandated sections require.

---

*Last updated: 2026-08-10 (PF-903 Day-1 skeleton, TRO-424); Webhook Pipeline / Documented Deviations
sections refreshed 2026-08-14 as PF-301 (TRO-426) landed `api/src/platform/webhooks/eventBus.ts`
(`IEventBus` / `InProcessEventBus`, observed, read directly) and the `documentService.ts` write path
it publishes from. Citations elsewhere under `api/src/platform/`, `sdk/`, and `integrations/` may
still describe planned rather than observed state where their owning ticket hasn't landed yet or
this file hasn't caught up — treat any specific claim as decided design unless it names the ticket
that landed it, and refresh against the real code before relying on it. Citations to
non-platform code (`api/src/app.ts`, `agent/src/shipClient.ts`, `api/src/collaboration/index.ts`)
were read directly and are observed.*
