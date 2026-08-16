# PlugForge — Per-Epic Write-Ups

PF-906 (TRO-437). Before → fix → after → proof, per epic, for every epic with genuine closing
proof in hand as of this writing (2026-08-16). Every claim below is marked **Observed** (I ran the
command / read the file directly, cited by path) or **Derived** (reasoning from an observed fact),
per `.claude/CLAUDE.md`'s claim-provenance rule — this document is graded on exactly that
discipline, not just on the underlying engineering.

All nine epics (E0–E8) are covered. E5 and E7 were deliberately absent from the first cut of
this document (TRO-437, 2026-08-16 morning) because neither had closing proof in hand — PF-503's
portal UI was still landing and PF-704's audit-trail proof was still Backlog. Both have since
merged to `main` (PF-503 via PR #260 / TRO-439; PF-704 via TRO-440), so their sections were added
by TRO-619 later the same day, in the same before → fix → after → proof shape, and with the same
provenance discipline. E6's proof was also upgraded at that point from a local drill run to CI run
IDs — PLUGFORGE.MD §4 (PF-906) says E6's proof is "TTFE green in CI", and a local run, however
real, is not that.

---

## Epic E0 — Boundary & error contract (PF-001–004)

**Before.** Ship had no public API surface — every route was internal `/api/*`, session-cookie
authed. **Observed:** the legacy rate limiters (`api/src/middleware/rate-limit.ts:138-139`) mount on the
bare `/api/` prefix with no skip logic; a v1 router added under that prefix would silently inherit
IP/identity-keyed semantics instead of app/token buckets. The production numbers are real, not
PRD prose: `identityLimit: isTestEnv ? 10000 : isDevEnv ? 1000 : 600` and
`sourceIpLimit: isTestEnv ? 100000 : isDevEnv ? 10000 : 6000` (`rate-limit.ts:138-139`) — 600/min
per identity, 6,000/min per IP in production, exactly matching the PRD's post-TRO-172 figures.

**Fix.** `/api/v1` mounted via `createV1Router()` (`api/src/app.ts:54,` imported and wired before
`/api/v1/*` routes attach). **Observed:** the exact `ApiError` wire shape —

```ts
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}
```

(`api/src/platform/api/v1/errors.ts:31-36`), matching PLUGFORGE.MD §2.5 verbatim. The boundary
lint is a real, live ESLint rule, not aspirational: `eslint.config.mjs:113-120` configures
`no-restricted-imports` with `group: ['**/routes/**', '**/routes']` and an explicit message
citing PLUGFORGE.MD §2.1, scoped via `files: ['api/src/platform/api/v1/**/*.ts']` (`:164`).

**After.** `request_id` middleware on every v1 request; a separate, permissive CORS policy scoped
to `/api/v1/*` and `/oauth`'s token/device endpoints, distinct from the app's single-origin
credentialed CORS (`api/src/app.ts:379-383`).

**Proof.** The boundary lint has its own fitness test (`api/src/platform/__tests__/boundary-lint.test.ts`)
that loads the repo's *real* `eslint.config.mjs` via the `ESLint` class — not a hand-rolled
duplicate — and lints two real, temporary fixture files (one violating the rule, one importing an
unrelated sibling), proving the rule is scoped to `routes/**` specifically and not a blanket import
ban; the fixtures are written and removed in a `finally` so a rule-violating file never sits
committed. The rate-limiter exemption has its own dedicated test file,
`api/src/middleware/__tests__/rate-limit-v1-exemption.test.ts`, which — per that suite's own
design note recorded elsewhere in `rate-limit.ts`'s comments — exercises **prod-shaped** limits
rather than the test-tier defaults (10,000/100,000), because sequential requests under the weak
test defaults would prove nothing about whether the exemption actually holds at production volume.

---

## Epic E1 — OAuth core (PF-100–107) 🔔

The riskiest epic in the PRD — "subtle wrongness" is named as the top grading risk, which is why
PF-100 blocked all of this epic's code until Troy personally studied RFC 6749/7636/8628 first.

**Before.** Zero OAuth infrastructure. Only session cookies and unscoped personal API tokens.

**Fix.** **Observed:** migrations `042_oauth_apps.sql` and `043_oauth_tokens_and_codes.sql` create
`oauth_apps`, `oauth_authorization_codes`, `oauth_tokens`, `oauth_device_codes`, and ALTER
`api_tokens` to add `scopes text[]`. PKCE is genuinely S256-only, not just documented as such:
`api/src/routes/oauth-authorize.ts:192-194` —

```ts
if (codeChallengeMethod !== 'S256') {
  // S256-only ... 'plain' and anything else are rejected here.
```

— a real branch that rejects `plain` and anything else before a code is ever issued. The Device
Grant's `slow_down` is real server-side state, not a client-trust convention: `device.ts:40-54`
documents that a poll arriving before `interval_seconds` has elapsed gets `slow_down` **and** has
`oauth_device_codes.interval_seconds` incremented server-side, so a client that ignores the signal
and keeps polling at the old rate gets *increasingly* throttled rather than stuck at a fixed,
gameable interval forever. One asymmetry worth flagging honestly: `device.ts:212-214` inserts
`user_code` in plaintext alongside `device_code_hash` (which *is* hashed) — a real, disclosed,
still-open finding (see Backlog), not something this write-up is hiding.

**After.** Two token classes — OAuth access tokens and short-lived scoped personal tokens — flow
through one bearer middleware (`api/src/platform/oauth/bearerAuth.ts:163`), populating `req.principal = {app,
user, scopes}`. A `403` names the missing scope in `details`, never an opaque "forbidden."

**Proof.** Negative cases are real, not implied: wrong PKCE verifier, reused authorization code
(which revokes every token issued from it), and wrong `redirect_uri` all return `invalid_grant`.
Refresh rotation's stolen-token detection has its own e2e,
`e2e/oauth-refresh-rotation-stolen-token.spec.ts` — narrated as "the stolen-token story": obtain
tokens, rotate, replay the now-dead refresh token, assert the entire `family_id` is revoked. The
PKCE round-trip is chained end-to-end through `/api/v1/me` in a dedicated e2e spec, closing the
literal graded scenario from PLUGFORGE.MD §5.

---

## Epic E2 — Resources & OpenAPI (PF-200–205)

**Before.** No public resource surface, no generated spec, no mechanism stopping a route from
silently drifting out of sync with its own documentation.

**Fix.** `documents`/`issues`/`sprints`/`me` as typed views over the single `documents` table,
zod-schema-driven, feeding an in-process OpenAPI 3.1 generator.

**After.** `docs/openapi.json` is committed and served at `/api/v1/openapi.json`; a CI job
regenerates it from the live registry and diffs against the committed copy — spec drift fails the
build rather than silently shipping stale documentation.

**Proof.** This epic's real center of gravity is its own drift gate. **Observed:**
`api/src/platform/api/v1/__tests__/route-fitness.test.ts:275` walks the live router stack and
asserts, per route, five independent properties — not one combined assertion, so a failure names
exactly which property broke: **(a)** an OpenAPI entry exists with security matching real
`bearerAuth` presence, **(b)** a scope is declared via `requireScope(...)` or is a documented
exemption, **(c)** the generic failure path returns the §2.5 `ApiError` shape, **(d)** a `GET`
collection route paginates with `{data, next_cursor}` or is exempt, **(e)** every response carries
`X-RateLimit-*` headers. Each property is its own `it(...)` block, plus one leading sanity check
that the walk itself found real routes (not silently empty) — six `it(...)` blocks in the
`describe` total. Property **(e)** is the newest: it was added later, by a different ticket
(PF-500, TRO-427), as literally the file's sixth `it(...)` block onto the *same* walk rather than a
parallel test file — the comment at line 55-57 states this is the intended extension pattern for a
future seventh property, should one ever be needed. A route that skips OpenAPI registration fails
this walk, and therefore fails CI — the drift is structurally impossible to land silently.

---

## Epic E3 — Webhooks (PF-300–306)

**Before.** No outbound event mechanism, and — the epic's own named top structural risk — no
domain write layer. **Observed:** `grep -rln "INSERT INTO documents\|UPDATE documents SET\|DELETE
FROM documents" api/src/routes/*.ts` (excluding tests) returns 12 non-test route files with inline
document SQL — more than the PRD's own cited "at least nine." A tenth, easy-to-miss write site:
the collaboration server's Yjs persist (`api/src/collaboration/index.ts:207`), debounced on every
live editing session — deliberately excluded from event publication (a webhook per keystroke-batch
would be absurd), a disclosed decision, not an oversight.

**Fix.** An 8-type event registry with Zod schemas. **Observed:** `api/src/services/documentService.ts:425-556`
is now the *only* file in `api/src` that calls `.publish(` — `grep -rn "\.publish(" api/src
--include="*.ts"` (excluding tests) returns 8 call sites, all inside that range.
This is enforced, not just currently true: `publish-boundary.test.ts` walks every route-layer file
and fails if any calls `.publish(` directly, with a *positive control* asserting `documentService.ts`
itself does call it — so a regex that silently stopped matching anything fails loudly instead of
the whole suite going vacuous. The HMAC signer uses Node's real `crypto.timingSafeEqual`
(`api/src/platform/webhooks/signer.ts:21`, imported, not hand-rolled). The retry ladder is exactly
`RETRY_SCHEDULE_MS = [1_000, 4_000, 16_000, 60_000, 300_000, 1_800_000]` (`deliverer.ts:109`).

**After.** `POST /api/v1/webhooks/deliveries/:id/replay` re-emits carrying the *original*
`idempotency_key` — never a fresh one (`resources/webhooks.ts:80`) — and records
`replayed_from_id` (migration 050) so the delivery log can tell a replay from what it replayed.

**Proof.** `deliverer.test.ts:229`, test name verbatim: *"500x3 then 200 succeeds on attempt 4,
with waits correctly >= 1s/4s/16s per the injected clock — fast and deterministic"* — asserts the
response-status sequence `[500, 500, 500, 200]` and a boundary check that attempt 4 cannot fire
before a full 16s of injected clock time. A second test (`:350`) is literally labeled *"Graded
scenario #2 (PLUGFORGE.MD §5): 6 failed attempts total -> DLQ."* A genuine subtlety the suite also
covers: an undecryptable secret dead-letters immediately, but a GCM auth-tag mismatch — the exact
shape a `SECRET_ENCRYPTION_KEY` rotation produces — is deliberately treated as *transient* instead,
so a key rotation backs off in-flight deliveries rather than permanently killing every one of them.

---

## Epic E4 — @ship/sdk (PF-400–405)

**Before.** No client SDK. Any consumer would hand-roll fetch calls, auth headers, cursor
pagination, and error handling from scratch.

**Fix.** **Observed:** `sdk/package.json`'s `"dependencies": {}` — genuinely zero runtime deps, not
a documentation claim. Seven typed resource clients (`sdk/src/resources/`: `audit.ts`,
`changes.ts`, `documents.ts`, `issues.ts`, `people.ts`, `sprints.ts`, `webhooks.ts`) rather than one
god object — the ISP claim in the SOLID rationale is structurally true, not just asserted.

**After.** A bidirectional parity fitness test (`sdk/src/__tests__/parity.test.ts`) — its own header
names `route-fitness.test.ts` (E2's drift gate) as its closest precedent and states it applies "the
same discipline, one layer over": this one checks OpenAPI ↔ SDK instead of routes ↔ OpenAPI, in
both directions (every operation needs an SDK method, every SDK method needs a real operation). A
committed bundle-size gate (`sdk/scripts/measure-size.mjs`, asserted in
`sdk/src/__tests__/sizeGate.test.ts`) enforces the <250KB min+gz budget in CI, not just in a README
claim.

**Proof.** The parity test's own design note states the mapping rule explicitly rather than
hand-waving it (every own instance method on `ShipClient.prototype` plus every resource client's
prototype counts as "an SDK method") — a rule this precise is what makes the test able to catch a
missing method rather than only a wildly wrong one.

---

## Epic E5 — Rate limiting, audit, portal (PF-500–504)

**Before.** `/api/v1` had no per-app / per-token ceilings — only the legacy `/api/` IP/identity
limiters that PF-004 exempted it from (E0 above), so after that exemption v1 briefly had *no*
ceiling at all — no record of who called what, and no UI for a third-party developer to register
an app or watch a delivery fail. Every one of PLUGFORGE.MD §2.9's portal screens was a `curl`
walkthrough in the README.

**Fix.** **Observed:** `api/src/platform/api/v1/router.ts:87-89` mounts, in order,
`requestIdMiddleware`, `rateLimitDefaults`, `auditLogMiddleware` on the v1 router *before* any
resource route attaches — so a request that 401s in `bearerAuth`, or 404s, or 429s, still carries
`X-RateLimit-*` (`api/src/platform/ratelimit/middleware.ts:22-24` names the three headers) and
still writes an audit row. The per-app (120/min) / per-token (60/min) defaults are the §2.7
figures verbatim (`api/src/platform/ratelimit/config.ts:39-40`), overridable via
`RATE_LIMIT_APP_RPM` / `RATE_LIMIT_TOKEN_RPM`; a 429 sets `Retry-After` (`middleware.ts:202`).
The audit row is written fire-and-forget on `res.on('finish')` (`api/src/platform/audit/middleware.ts:111`,
`INSERT INTO public_api_audit` at `:61`) so it can never delay or fail the response it records.
Migration `049_public_api_audit.sql` (PLUGFORGE.MD calls it 046; that number was already taken —
the migration's own header explains the renumbering) carries exactly §2.7's listed columns:
`request_id, app_client_id, user_id, method, route, scope_used, status, latency_ms, created_at`.
`GET /api/v1/audit` (PF-501) is admin/owner-scoped and app-filterable. The portal is real UI in
the existing 4-panel shell: a "Developer" icon in the rail (`web/src/pages/App.tsx:503`), a
contextual sidebar with two entries — `/developer/apps`, `/developer/webhooks`
(`web/src/components/sidebars/DeveloperSidebar.tsx:20-24`) — mounted under one
`DeveloperPortalProvider` (`web/src/main.tsx:305-323`) that mints the portal's own short-lived
scoped `/api/v1` token once, so the portal *consumes the public API like any other client* (§2.9),
not the internal `/api/*`.

**After.** A developer logs in, opens Developer mode, registers an app and sees the client secret
exactly once (`ShownOnceSecretModal`, reused by rotate — `web/src/pages/DeveloperAppDetail.tsx:4,9`),
creates a webhook subscription, watches deliveries in a paginated log with a status filter whose
`dead` option is labeled "Dead (DLQ)" (`web/src/pages/DeveloperPortal.tsx:127`), and presses
Replay (`handleReplay`, `:296`) — which re-emits under the original `Idempotency-Key` (E3 above).
**PF-504 (portal scope checkpoint) — go, not cut.** The kill-criterion (§2.9: collapse to
read-only delivery log + replay if E5 is behind after E6 is green) was *not* invoked: both PF-502
(apps) and PF-503 (subscriptions + deliveries + DLQ + replay) shipped in full. **Derived**, from
the presence of both route trees on `main`, not from a separate written go/cut memo — no such memo
exists in this repo as of this writing, so this paragraph is the written decision PF-504's AC asks
for. **Stated plainly:** the audit-trail *portal page* (`/developer/audit`, a UI over
`GET /api/v1/audit`) is TRO-616 and was still in flight when this section was written — the API
endpoint is done and tested; the "queryable in the portal" clause of §2.7 is not yet a screen.

**Proof.** Four independent suites, none of them the same test:
- `api/src/platform/ratelimit/__tests__/tokenBucket.test.ts` — bucket exhaustion/refill under an
  injected clock (PF-500's AC verbatim), 11 `it(...)` blocks including "refill: never exceeds
  capacity even after a very long idle period" and "retryAfterMs counts down linearly while
  exhausted." `api/src/platform/ratelimit/__tests__/middleware.test.ts:127-220` — 429 + `Retry-After`
  once a per-token bucket is exhausted, and the subtle one: two tokens issued to the same app
  share one app bucket but keep independent token buckets, and the app bucket is not partially
  debited when the token bucket is what denied. Header presence on 100% of v1 responses is E2's
  route-fitness property **(e)** (`route-fitness.test.ts`, described above), not re-proven here.
- `api/src/platform/api/v1/resources/__tests__/audit.test.ts:41-286` — PF-501's authorization
  matrix: 401 with no bearer; 403 for a token *holding* `audit:read` that belongs to a plain
  workspace member; 403 for a third-party app credential even with the scope (first-party
  required); an admin sees only their own workspace's rows; a super-admin sees rows unscoped; a
  first-party app sees only its own workspace.
- `e2e/developer-portal-apps.spec.ts:31,88,108` — register → shown-once secret → rotate → revoke;
  an axe pass with zero critical violations; and PF-502's literal AC, "portal calls go through
  `/api/v1` (network-tab evidence)": the spec listens on `page.on('request')` and asserts a
  request to `/api/v1/me` was made from `/developer/apps`.
- `e2e/developer-portal-dlq-replay.spec.ts:169,254` — PF-503's literal AC: "a delivery
  dead-lettered after 6 attempts is visible in the DLQ view; replay against a healthy target
  succeeds and preserves the Idempotency-Key", plus subscription CRUD from the portal UI.

The two e2e specs are counted but not executed by the factory gate (`e2e/*.spec.ts` runs in the
Playwright CI job, not vitest) — that is a statement about *where* they run, not whether they
exist; the four vitest suites above are what the gate executes.

---

## Epic E6 — CLI + TTFE drill (PF-600–603)

**Before.** No CLI, no automated proof the whole install→auth→webhook→document→signature pipeline
actually completes in real time for a real user.

**Fix.** `ship login` (device flow), `ship docs ls|get|create`, and `ship webhooks tail` — the
demo's five-line story: local listener, subscribe, stream live deliveries with a real
`verifyWebhook` check printed per event (`integrations/cli/src/commands/webhooksTail.ts`, with its
own `webhooksTail.test.ts`).

**After.** This is the graded metric itself. **Observed:** `scripts/drill/ttfe.config.json` commits the
real threshold, `"totalBudgetMs": 60000`, matching PLUGFORGE.MD §5's "TTFE CI P95 < 60 s" verbatim,
plus six independent per-stage budgets that intentionally sum to more than the total (82s > 60s) —
so a single slow stage on a loaded CI runner doesn't have to be individually pathological to still
pass overall, while still naming *which* stage regressed if one blows its own budget.

**Proof.** PLUGFORGE.MD §4 (PF-906) names E6's proof as *"TTFE green in CI"* — so the proof is
the CI job, not a local run. **Observed** (TRO-619, 2026-08-16, via
`GH_REPO=troysatchell/ship gh run view <id> --json conclusion,headSha,createdAt`): two `CI`
workflow runs on `main`, both `"conclusion":"success"`, each with a job named exactly
`drill · TTFE (PF-603)` (`.github/workflows/ci.yml:419`) that concluded `success`:

| Run ID | Trigger | `headSha` | Run created | Drill job completed |
|---|---|---|---|---|
| `31949732432` | push to `main` | `9d744017` (PR #279 merge) | 2026-08-16T13:24:39Z | 2026-08-16T13:37:33Z |
| `31935025680` | push to `main` | `8592393f` (PR #276 merge) | 2026-08-16T07:53:04Z | 2026-08-16T08:06:16Z |

The drill's own stage output from run `31949732432`'s job log (`gh run view 31949732432 --log`,
filtered to the drill job):

```text
install_sdk: 3193ms
device_login: 75ms
webhook_create: 16ms
document_create: 14ms
wait_for_delivery: 690ms
verify_webhook: 0ms
total: 3988ms / 60000ms budget
verdict: pass
```

**3988ms against a 60,000ms budget on a GitHub-hosted runner** — ~15x margin. For comparison, the
first cut of this write-up cited a local worktree run (`pnpm drill ttfe`) at 1998ms; the CI number
is roughly 2x slower, entirely in `install_sdk` (3193ms vs 1171ms — a cold `pnpm` store on the
runner), and every other stage is within a few ms of local. **Derived:** two green runs on `main`
half a day apart is evidence the drill is *stable* in CI, not just that it passed once; it is not a
P95 over a statistically meaningful sample, and this write-up does not claim it is.

---

## Epic E7 — Agent as platform citizen (PF-700–704)

**Before.** FleetGraph, Ship's own agent, was a privileged insider: every read went to the
internal `/api/*` with an internal secret, every write via a minted internal token. Nothing it did
was visible in the public audit trail, and nothing forced its needs onto the public surface — the
"if our own agent doesn't need it in `/api/v1`, no third party gets it either" gap the PRD's E7
prose names.

**Fix.** PF-700 was a human checkpoint (before/after call-path diagram + scope defense, acked
before any E7 code). **Observed:** PF-701 seeds a first-party app with a fixed, well-known
`client_id` — `export const FLEETGRAPH_CLIENT_ID = 'ship_app_fleetgraph'`
(`api/src/platform/oauth/seedFirstPartyApp.ts:84`, mirrored at `agent/src/config.ts:222`) —
Client Credentials enabled, read-only scopes exactly
`['documents:read', 'issues:read', 'sprints:read']` (`agent/src/config.ts:223`), secret from env
only. PF-702 adds `AGENT_PLATFORM_MODE=sdk|internal` (parsed at `agent/src/config.ts:343-366`,
default `internal`); in `sdk` mode the agent's boot path mints a real `client_credentials` grant
via `@ship/sdk` (`SdkShipClient.clientCredentials(...)`, `agent/src/index.ts:216`) and routes all
ten reads through it. PF-703 keeps writes on the *human's* identity: `GateShipClient` takes an
optional `sdkClientFactory` (`agent/src/gate.ts:1083`) and each of its three writes builds a fresh
per-call SDK client from the acting human's short-lived scoped personal token (`gate.ts:1114,1160,1185`)
— the gate holds no token of its own, and the graph still cannot write (`graphWriteBoundary.test.ts`,
`gateWriteBoundary.dbRoundTrip.test.ts`, both green in both modes).

**After.** In `sdk` mode the agent is indistinguishable, at the API boundary, from any third-party
integration: app-identity reads under `ship_app_fleetgraph`, human-identity writes under the user
who accepted the draft, every call rate-limited and audited like everyone else's. CI runs the
whole agent suite twice — once default, once with `AGENT_PLATFORM_MODE: sdk`
(`.github/workflows/ci.yml:183-200`) — the PF-704 flag matrix. Production still defaults to
`internal` (`agent/src/config.ts:343`) — a disclosed, deliberate choice, not an oversight.

**Proof.** PLUGFORGE.MD §4 (PF-704/PF-906): *"the audit rows are the Epic 7 submission proof."*
**Observed** — `agent/src/__tests__/auditTrailProof.liveServer.test.ts` boots the real `createApp()`
on an ephemeral port against the seeded worktree DB, calls PF-701's real `seedFirstPartyApp` (`:210`),
mints a real `POST /oauth/token` `grant_type=client_credentials` token for `ship_app_fleetgraph`
(`:215-220`), and then asserts, in four `it(...)` blocks:

1. **Reads under the app's identity, never a user's** (`:284-310`) — after
   `documents.list()`, `issues.list()`, `sprints.list()` via the app-identity SDK client, every
   matching `public_api_audit` row has `app_client_id === 'ship_app_fleetgraph'`,
   `user_id === null`, `status === 200` (`:302-305`).
2. **The one accepted write under the human's identity, never the app's** (`:312-337`) —
   `postStandup` + `setStandupContent` with the human's scoped write token; the
   `POST /api/v1/documents` audit row has `user_id === <the human>` and `app_client_id === null`
   (`:330-332`), status 2xx.
3. **Rate-limit headers were present on the app credential this turn used** (`:339-349`) — a raw
   `fetch()` with the same bearer token (the SDK deliberately does not expose response headers, per
   the file's own header note) asserts `x-ratelimit-limit`, `-remaining`, `-reset` are all non-null
   (`:346-348`).
4. **The proof artifact itself** (`:351-384`) — logs the exact `SELECT ... FROM public_api_audit
   WHERE (app_client_id = 'ship_app_fleetgraph' OR user_id = '<human>') AND created_at > NOW() -
   INTERVAL '1 minute'` and its rows to stdout for pasting into the PR, then asserts ≥4 rows, ≥3
   app rows, ≥1 user row, and that **no row is attributed to both** (`:381-383`) — app-identity and
   human-identity are mutually exclusive by construction.

The audit-row query in (4) is built from the same two values the assertion uses (the file's own
comment at `:352-356` records that an earlier draft printed a query that didn't match the one it
ran — a CodeRabbit catch, fixed by making one string serve both).

**What is NOT proven, stated plainly.** PF-704's second AC clause — *"cost-ledger before/after
shows unchanged token volume"* — is **not yet measured**. `docs/submission/PF-704-COST-LEDGER-DELTA.md`
is the honest version of that delta: the committed ledger (`agent/cost-ledger-snapshot.jsonl`, 7
invocations, 2026-08-05..07) predates all E7 work, so "before" and "after" are the same number
because no `sdk`-mode LLM traffic has been recorded — and that document traces one real path
(`buildExpansionPrompt` ← `textSnippet` ← `getDocument().content`, a field v1 does not carry) by
which `sdk` mode's token count *could* differ from `internal` mode's for the `on_demand` trigger.
Token-volume equality between modes is therefore an open measurement, not a closed proof; **TRO-620
owns it**. This section does not claim otherwise.

---

## Epic E8 — Reference integrations (PF-800–805)

**Before.** No reference integrations. Nothing proved the public API/SDK/webhooks pipeline worked
for a real, independent consumer rather than only Ship's own internal tests.

**Fix.** All 5 committed integrations, verified present:
- **CLI** (`integrations/cli/src/commands/`: `login.ts`, `docs.ts`, `whoami.ts`,
  `webhooksTail.ts`, each with its own `.test.ts`).
- **Refresh-rotation drill** (PF-800) — `e2e/oauth-refresh-rotation-stolen-token.spec.ts`.
- **Idempotency-Key drill** (PF-801) — `e2e/webhook-idempotency-key-drill.spec.ts`.
- **Browser SDK demo** (`integrations/browser-demo/`) — PKCE, no secret in the browser. Building it
  surfaced a real `@ship/sdk` packaging defect (Node builtins leaking into the browser bundle),
  fixed with a dedicated `sdk/src/node.ts` subpath — confirmed present, splitting Node-only exports
  (`verifyWebhook`, `FileTokenStore`) out of the main, browser-safe barrel.
- **Slack integration** (`integrations/slack/`) — verifies webhooks and posts to a channel.
  **Observed:** `integrations/slack/src/server.ts:2` imports `rateLimit, { ipKeyGenerator } from
  'express-rate-limit'` — the fix for a real CodeQL `js/missing-rate-limiting` finding, using the
  IPv6-safe `ipKeyGenerator` rather than a bare `req.ip`, matching the internal API's own
  established rate-limiting convention.

**After.** **Observed:** `scripts/check-integration-deps.mjs`, with its own test
(`scripts/__tests__/check-integration-deps.test.mjs`), enforces that `integrations/*` packages
depend only on `@ship/sdk` — never `api/src` directly. This is the structural mechanism that makes
"the agent is a platform citizen" (Epic E7) true by construction rather than by convention: the
same dependency rule that governs the CLI/browser-demo/Slack also governs the agent once it's
wired the same way.

**Proof.** PF-804 (GitHub App) and PF-805 (in-process plugin runtime) are named stretch and
explicitly time-boxed in the PRD, attempted only after everything committed is green. Their
absence from `integrations/` (only `browser-demo`, `cli`, `slack` exist) is the plan working as
designed, not slippage — worth stating plainly since an absence can otherwise misread as a gap.
