# PRESEARCH — PlugForge (Week 6)

Ship becomes a platform: a versioned public API, OAuth 2.0, HMAC-signed webhooks, a typed SDK, a
developer portal, and the FleetGraph agent rewired to use all of it as an ordinary citizen.

**Ticket:** PF-904 / TRO-429 (🔔 human checkpoint). **Drafted:** 2026-08-16, against the merged
`main` at the time of writing — after most of E0–E9 has landed, not before it, so this document is
written the way `PRESEARCH.MD`'s Phase 2/3 sections were for Week 5: against the implementation,
naming what was decided up front and what was found out on the way. Week 5's `PRESEARCH.MD` (repo
root) is the structural model; none of its answers are reused here.

**How to read the answers.** Every answer that could be derived from the repo is pre-filled and
carries a `file:line` citation. Per `.claude/CLAUDE.md`'s provenance rule, each is tagged:

- **observed** — read directly from a file in this worktree (the citation is where).
- **derived** — a decision recorded in `PLUGFORGE.MD` / `docs/architecture.md` / a ticket, or an
  inference from an observed fact; the citation says which.
- **not-run** — something this draft did not execute; the reason is stated.

Anything only Troy can answer is left as a visible blockquote that opens with the marker
`[TROY — needs your answer]` followed by a one-line prompt of what to write. There are nine such
blocks; `grep -c '^> \*\*\[TROY' docs/submission/PLUGFORGE-PRESEARCH.md` counts exactly them.
Everything else is done.

---

## Phase 1: Define Your Constraints

### 1.1 — Scale & Load Expectations

#### Realistic API request rate during the demo window, and how it maps to webhook fanout

**derived** — no production traffic exists to measure; the demo is the only "load." The demo path
is the five-line story (`ship login` → subscribe → create → verified event) plus a portal replay and
one CI drill run (`PLUGFORGE.MD:300`, `:304`). The cost analysis' assumption for a full narrated
demo is **~30 event-publishing actions** at an assumed 1.5 matching subscriptions per event → ~45
first-attempt deliveries, and up to ~90 delivery-attempt rows once retries against a deliberately
failing demo target (the DLQ/replay shot) are counted (`docs/submission/PF-905-AI-COST-ANALYSIS.md:215-219`
gives the 45–90 range). Fanout is **not capped per app**: no code-enforced limit on subscriptions
per app was found (`PF-905-AI-COST-ANALYSIS.md:240-244`); migration 047's unique index is per
`(app_id, event_type, target_url)`, so the only structural bound is 8 event types per *target URL*
(`EVENT_TYPES` has 8 entries, `api/src/platform/webhooks/events.ts:111`), and N target URLs give N
deliveries per event. Request-rate ceiling on the public side is set by the per-app/per-token token
buckets — 120 and 60 req/min by default (`api/src/platform/ratelimit/config.ts:41-42`,
`PLUGFORGE.MD:155`) — one request per second per token *is* the token limit, so a demo needs to
stay well under that (a few requests a minute per credential is what the five-line story does).

#### How many OAuth apps and subscriptions seeded for the grader; at what fanout does the in-memory deliverer miss the < 2 s P95

**observed** — two seeded first-party apps: `ship_app_fleetgraph` (`api/src/platform/oauth/seedFirstPartyApp.ts`, PF-701) and
the read-only grader app (`api/src/platform/oauth/seedGraderApp.ts`; live credentials published in
`README.md:395-401`, `client_id ship_app_grader_9ea6a33b`, scopes `documents:read issues:read sprints:read`).
Zero subscriptions are seeded — the drill and the CLI create and clean up their own
(`PLUGFORGE.MD:274-275`). **not-run** — the fanout at which first-attempt P95 crosses 2 s was not
load-tested; the deliverer's poll interval is 1 s (`api/src/platform/webhooks/deliverer.ts:123`) and
the drill's observed `wait_for_delivery` stage is 818–1005 ms across five real runs
(`PF-905-AI-COST-ANALYSIS.md:81-87`), so at demo fanout the target holds; the knee was not measured.

#### Concurrent CLI device-flow sessions during a demo, and `slow_down` handling

**derived** — one (the demo terminal) plus the CI drill's own auto-approved device login
(`PLUGFORGE.MD:275`). `slow_down` is implemented and honored on both sides: server
(`api/src/platform/oauth/device.ts`, PF-106 AC "slow_down honored: interval increases",
`PLUGFORGE.MD:231`) and SDK client (`sdk/src/deviceLogin.ts`, PF-404 "full RFC 8628 client incl.
slow_down", `PLUGFORGE.MD:259`). The `/oauth/*` prefix has its own per-source-IP limiter, 120 req/min
in prod, sized from RFC 8628's 5 s poll interval × ~10 concurrent logins behind one NAT
(`CHANGES.md`, TRO-588 entry) — that is the real concurrency ceiling, and it is well above the demo.

#### Delivery-log row growth at demo event rate, and retention

**derived** — ~0.9–1.0 KB per delivery-attempt row (schema-derived, `PF-905-AI-COST-ANALYSIS.md:195-213`);
under 100 KB for a whole demo session (`:221`). **Retention: none is implemented** — both
`webhook_deliveries` and `public_api_audit` grow without bound today; the cost analysis grepped for
any cleanup job and found only the deliverer's poll loop and lazy session cleanup
(`PF-905-AI-COST-ANALYSIS.md:225-231`). Recommended window: 30 days, grounded in two existing
30-day precedents in this repo (refresh-token TTL, Aurora log retention) (`:264-274`). Immaterial at
demo volume; a follow-up ticket for production.

### 1.2 — Budget & Cost Ceilings

#### Weekly LLM budget for the E7 rewire; how the "no token-volume change" claim is measured

**derived** — the rewire changes transport, not prompts, so token volume should be unchanged
(`PLUGFORGE.MD:283`, PF-704 AC). The measurement is the committed cost ledger before/after
(`agent/src/costTracking.ts` + snapshot, `PLUGFORGE.MD:202`) → `docs/submission/PF-704-COST-LEDGER-DELTA.md`.
The cost analysis left this section as a TODO because that PR was unmerged at the time
(`PF-905-AI-COST-ANALYSIS.md:67-73`); the file now exists in `docs/submission/`, so PF-905 §2.1 can be
back-filled from it. **not-run** here — this draft did not re-run the ledger.

> **[TROY — needs your answer]** *Your actual weekly LLM spend ceiling for this sprint (Anthropic API
> for the agent + Claude Code sessions), and whether the factory's own session cost counts against it.*

#### Daily ceiling on CI minutes given TTFE drill + OAuth Playwright + full regression per PR

**observed** — TTFE drill job wall-clock ≈ 62.8 s per run (five real GitHub Actions runs,
`PF-905-AI-COST-ANALYSIS.md:94-108`), gated behind `needs: verify` so doomed PRs never pay it. OAuth
Playwright specs are **not in CI** — local/on-demand only, so their recurring CI cost is zero
(`:128-135`). Projected total at this sprint's factory cadence: ~340 CI-min/week for the drill alone;
~40–58/week at a normal 10–15 PR/week cadence (`:110-124`). The graded pipeline is GitLab
(`.gitlab-ci.yml`), GitHub is the mirror (`PLUGFORGE.MD:5`).

> **[TROY — needs your answer]** *Your daily CI-minute ceiling (GitLab shared runners + GitHub
> Actions), and whether you'd cut the drill to merge-only if it were exceeded.*

#### SDK install-footprint budget and enforcement

**observed** — zero runtime dependencies (`sdk/package.json` `"dependencies": {}`), native `fetch`;
budget < 250 KB minified+gzipped, enforced by `sdk/scripts/measure-size.mjs` (`DEFAULT_THRESHOLD_KB = 250`,
`:44`) and run in CI as `pnpm --filter @ship/sdk size-check` (`.github/workflows/ci.yml:239`).
Decision recorded at `PLUGFORGE.MD:179`.

#### Runaway-cost ceiling if a subscriber 5xx's forever, and the enforcing mechanism

**observed** — `MAX_ATTEMPTS = 6` (`api/src/platform/webhooks/deliverer.ts:112`); after the sixth
failed attempt the delivery is dead-lettered and nothing further is sent. Retry schedule
1s/4s/16s/1m/5m/30m + jitter (`:109`); the 30 m entry is defined for spec fidelity but unreachable
at six attempts (`:41-49`). So the worst case is six HTTP attempts and six log rows **per
subscription per event** — with N broken subscriptions matching an event, up to 6N attempts and 6N
rows for that event, and there is no global fanout cap (1.1 above). The bound is per event, not per
subscriber over time: there is no per-subscriber circuit breaker that stops *new* events to a dead
endpoint; that would be a follow-up.

> **[TROY — needs your answer]** *A dollar/row ceiling you'd actually act on for the delivery log,
> or "none — bounded by MAX_ATTEMPTS is enough for this deployment."*

### 1.3 — Timeline & Scope Reality

#### Which of E1–E7 are must-ship; which reference integration is the must-ship

**derived** — must-ship is the MVP cut line: PF-001…004, PF-100…107, PF-200, PF-202+203, PF-400,
regression green, PF-900, deploy live with grader app (`PLUGFORGE.MD:327`). Cut order if at risk:
top of E5 (portal) and E8 (Slack) first, never E1/E2 correctness or negative tests (`:328`).
Must-ship integration is the **CLI** (`:63`, decision 2 — "CLI (must-ship) + refresh-rotation
drill + Idempotency-Key drill + Browser SDK demo + Slack"; GitHub App and plugin runtime are
time-boxed stretch). Status at draft time (memory-bank `activeContext.md`, 2026-08-16): E5 portal
fully closed (TRO-436/439/443), CLI incl. `ship webhooks tail` landed (TRO-452), drill in CI
(TRO-455). Reason the OAuth-experience clause resolves to "all of it": PF-100's study brief exists
(`docs/submission/PF-100-OAUTH-STUDY-BRIEF.md`) and E1 shipped behind it.

> **[TROY — needs your answer]** *Confirm this is your list, or name what you'd have cut first if
> the week had gone worse.*

#### Hours per day, honestly, and the day-by-day plan against that number

> **[TROY — needs your answer]** *Real hours/day you personally spent (not agent-hours), and the
> day-by-day shape — which days were defense/MVP/early-sub/final. Nothing here is derivable from the
> repo; git history shows agent throughput, not your hours.*

For reference only, the PRD's own plan: Architectural Defense → MVP (+1 day, hard gate) → Early
Submission → Final Submission, planned for Sunday 11:59 AM CT with everything landing Saturday
night (`PLUGFORGE.MD:6`), E9 defense artifacts starting Day 1 (`:341`).

#### Kill criterion for the developer portal

**derived** — pre-agreed at `PLUGFORGE.MD:185`: if E5 is running behind after CLI + drills are green,
the portal collapses to the read-only delivery-log viewer + replay, and app registration falls back
to a documented admin API call. PF-504 was the explicit go/cut ticket (`:268`). **Outcome:** the
criterion was not invoked — the portal shipped in full (apps, subscriptions, deliveries/DLQ, replay:
`web/src/pages/DeveloperApps.tsx`, `DeveloperAppDetail.tsx`, `DeveloperPortal.tsx`), and the
architect ordered the build delivery-log-first precisely so the kill criterion would have been cheap
to take (`web/src/pages/DeveloperPortal.tsx:11-15`).

### 1.4 — Security & Data Sensitivity

#### Where `client_secret` lives at rest, hashed how, recovery process

**observed** — SHA-256 hash only, `oauth_apps.client_secret_hash`, the same pattern as
`api_tokens` (`PLUGFORGE.MD:103`; `api/src/db/migrations/042_oauth_apps.sql`;
`api/src/platform/oauth/credentials.ts`). Not salted — these are high-entropy random secrets, not
passwords, so a rainbow table is not the threat model; CodeQL's `js/insufficient-password-hash`
alerts on this pattern were reviewed and dismissed as false positives twice for exactly that reason
(memory-bank `activeContext.md`, TRO-587/TRO-492). **Recovery:** none — the raw secret is returned
exactly once on creation and on rotation, and a lost secret means rotating (`PLUGFORGE.MD:227`,
PF-102; `README.md:344-345` says the same for the grader secret: "not recoverable from the database
or re-printed"). Rotation invalidates the old secret immediately, no grace period (`:227`).

#### Access-token validity, refresh rotation, stolen-refresh-token detection

**observed** — access 1 h (`api/src/platform/oauth/token.ts:181`), refresh 30 d
(`:189`, tracked on its own `refresh_token_expires_at` column, migration 045). Refresh tokens are
one-time-use; rotation issues a child in the same `family_id`; **reuse of a rotated token revokes
the whole family** (`PLUGFORGE.MD:114`, `:230` PF-105). Proven end-to-end by the narrated
"stolen-token story" e2e (PF-800, `e2e/oauth-refresh-rotation-stolen-token.spec.ts`).

#### What goes in webhook payloads vs. what is fetched on demand

**observed** — IDs and a small typed envelope, **not document content**. `document.created`
carries `{ id, document_type, title, created_by }` (`api/src/platform/webhooks/events.ts:141-146`);
`document.updated` adds the list of changed field names, not values (`:148-153`). Subscribers fetch
the body via `GET /api/v1/documents/:id` with a scoped token. **Defense:** a webhook goes to a URL
the *app owner* chose, signed with a secret the *app owner* holds; document bodies are governed by
the *user's* visibility and the *token's* scope. Putting content in the payload would leak through
whichever of those two the subscriber never had. The cost is one extra read per event, which the
per-app bucket (120/min) absorbs at demo volume. Title is included because it is what makes a Slack
message readable (`integrations/slack`, PF-803) and it is already the least-sensitive field on the
row.

#### Protecting the shown-once secret from screenshot, log line, back-button

**observed / derived** — shown exactly once in a modal with copy-to-clipboard and a warn-before-close,
never re-fetchable (`PLUGFORGE.MD:185`, `:266` PF-502; `web/src/pages/DeveloperApps.tsx`). Server
side, no route other than create/rotate ever returns the raw value — the same rule holds for
webhook `whsec_` secrets, where `GET`/list never even selects the ciphertext column
(`docs/architecture.md:362-367`), and PF-102's AC is "raw secret absent from logs and from any
subsequent response" (`PLUGFORGE.MD:227`). Back-button: the secret lives in React state for the
modal's lifetime, not in the URL or in a query cache that survives navigation — **derived** from
the component pattern, not verified by a browser back-button test (**not-run**). Screenshot is out
of the platform's control; the mitigation is that rotation is one click and instant.

### 1.5 — Team Skill Inventory

#### OAuth 2.0 implemented end-to-end before, or only consumed?

**derived** — the PRD records the honest starting point: "Troy is not yet familiar with OAuth
internals → 🔔 PF-100 blocks E1" (`PLUGFORGE.MD:66`). The study brief that closed that gap is
`docs/submission/PF-100-OAUTH-STUDY-BRIEF.md` (RFC 6749 roles, PKCE, device flow, rotation, the
concept→Ship table, likely interview questions).

> **[TROY — needs your answer]** *Consumed-only or implemented before this week; which morning you
> actually spent on the PF-100 brief / RFCs 6749 + 7636 + 8628; and how you'd rate your comfort
> now (e.g. "can explain PKCE and family revocation cold; still shaky on X").*

#### Comfort with Zod and zod-to-openapi; fallback if generation breaks late

**observed** — the repo already used `@asteasolutions/zod-to-openapi` for the internal API before
Week 6 (`api/src/openapi/registry.ts`, `PLUGFORGE.MD:51`), so the pattern was known ground; the v1
registry reuses it (`api/src/platform/openapi/registry.ts`). **Fallback:** the spec is *also*
committed as a static file, `docs/openapi.json` (PF-204), with `pnpm openapi:check` diffing it
against the in-process generator in both CI pipelines (`.gitlab-ci.yml:83`, `.github/workflows/ci.yml:98`;
~1.2 s, `PF-905-AI-COST-ANALYSIS.md:164-178`). That is a *repository/CI* fallback, not a runtime one:
if the generator broke late, the committed file would still be a valid spec for the docs and for the
SDK parity test, but the deployed API would not serve `GET /api/v1/openapi.json` at all — the
generator runs at boot and a failure **fails the boot** rather than serving a stale spec
(`docs/architecture.md:339-348`). So the real late-week fallback is "revert the route that broke
generation," caught by PF-203's fitness walk in CI before it reaches a boot.

> **[TROY — needs your answer]** *Your own comfort level with Zod / zod-to-openapi in one line.*

#### Designed an SDK before? Been on the consuming side of a bad one? Which guides you more?

**derived** — the design choices that were made are the ones a *consumer* would ask for: zero
deps, typed error `kind` you can switch on exhaustively, async iterators so you never see a cursor,
cheap constructor with no I/O, `verifyWebhook` as one call (`PLUGFORGE.MD:176-180`). That reads as
consumer-side scar tissue driving the design.

> **[TROY — needs your answer]** *Have you designed an SDK before, which bad SDK you have consumed,
> and which experience drove your calls this week.*

---

## Phase 2: Architecture Discovery

### 2.1 — OAuth Flow Choices

#### Refresh tokens from day one, or long-lived access tokens first?

**observed** — from day one. Access 1 h / refresh 30 d with rotation shipped in E1 (PF-105) and
the migrations that carry it are 043 + 045 (`api/src/db/migrations/`). Rationale: refresh rotation
*is* the E8 drill's engine (`PLUGFORGE.MD:230`) and family invalidation is a named interview topic;
retrofitting it would have meant re-cutting the token table under a live SDK. Migration cost of
waiting would have been a schema change plus an SDK `ITokenStore` contract change — the SDK's store
already persists refresh tokens (`sdk/src/tokenStore.ts:28`).

#### Scope upgrades — re-consent or incremental consent?

**derived** — re-consent. Scopes are recorded per token row (`oauth_tokens.scopes text[]`,
`PLUGFORGE.MD:105`) and per authorization code; there is no "merge with previously granted" logic in
`api/src/platform/oauth/authorize.ts` (grep for incremental/merge — none). A client that needs
`documents:write` after holding `documents:read` runs `/oauth/authorize` again with the wider scope
set and the user consents to that set. Simplest correct behaviour; incremental consent is not in the
IETF-minimal scope (`PLUGFORGE.MD:66`).

#### Where the consent screen lives; clickjacking protection

**observed** — a dedicated minimal route in the web app (Vite/React), session-authed, not
Express-server-rendered (`api/src/platform/oauth/__tests__/authorize.test.ts:18-22`; `PLUGFORGE.MD:228`).
Clickjacking: the PRD specifies `frame-ancestors 'none'` (`:228`). **What is actually observed:**
`api/src/app.ts:330-345` configures helmet's CSP with `frameSrc: ["'none'"]` but does not set
`frame-ancestors` explicitly; helmet's `useDefaults` behaviour merges in `frame-ancestors 'self'`
and its frameguard sends `X-Frame-Options: SAMEORIGIN` — **derived** from helmet's documented
defaults, **not verified** by a live header dump in this draft. That is `'self'`, not `'none'`: same-
origin framing is still permitted. The unit test file explicitly declines to cover AC-4 for this
reason (`authorize.test.ts:18-22`). Flagging as a small gap to close or defend, not a bypass — an
attacker on another origin still cannot frame the consent page.

#### Device Authorization Grant verification UX

**observed** — both. The verification page (`web/src/pages/OAuthDeviceVerify.tsx`) renders a form
to paste the `user_code`, and pre-fills it from `?user_code=` when the CLI's printed URL carries it
(`:42-43`). Codes are human-typable `XXXX-XXXX` (`PLUGFORGE.MD:106`), and after TRO-589 the
`user_code` is stored hashed (memory-bank `activeContext.md`).

### 2.2 — Public API Shape

#### One error shape everywhere, or richer details on some routes?

**observed** — one shape, everywhere: `{ code, message, details?, request_id }` with six codes
(`PLUGFORGE.MD:126-135`), enforced by error middleware at the public layer and asserted for every
route by the PF-203 fitness walk (`:239`). Richness lives *inside* `details` — e.g. `details.reason`
distinguishes invalid/missing/expired on 401 (`:135`), `details.missing_scope` names the missing
scope on 403 (`:118`; live example `README.md:381`) — so the envelope never varies. Documented in the
OpenAPI spec (`docs/openapi.json`).

#### Field-level filtering / sparse fieldsets

**observed** — skipped. No `?fields=` or `Prefer:` handling exists under `api/src/platform/api/v1/`
(grep, none). **Defense:** the typed resources already project a fixed shape (issues lift
state/priority/assignee out of `properties` JSONB, `PLUGFORGE.MD:122`); document bodies are TipTap
JSON and the only expensive field. YAGNI for one week; would be an additive query parameter later
and therefore not a breaking change under the versioning policy below.

#### Versioning policy past `/api/v1/`

**derived** — additive-only within `/v1`; breaking changes mean `/v2`. That is what the committed
static spec + drift check enforce mechanically today: any change to `docs/openapi.json` fails CI
until deliberately regenerated (`PLUGFORGE.MD:240`), and PF-405's parity test forces the SDK to
follow. Deprecation/sunset headers are **not implemented**. In the docs by Sunday: the
stable-vs-pre-1.0 marks on the SDK surface (`docs/architecture.md:258-266`) — that is this project's
API-shape commitment; npm publishing and semver are out of scope (`PLUGFORGE.MD:347`).

#### Cursor pagination on every list, or do small static lists skip it?

**observed** — every *resource* list endpoint returns `{ data, next_cursor }` with opaque keyset
cursors (`PLUGFORGE.MD:137`), and the fitness test asserts "(d) paginates if a list" (`:239`).
The line: enumerations that are data-as-code (the scope registry, the event registry) are not
resources — they are enumerable from the OpenAPI spec itself and the portal reads them from the
registry, not a paginated endpoint (`PLUGFORGE.MD:245` "registry enumerable (portal + docs
consume it)"). The fitness test knows the difference because it walks the mounted v1 router: a
route that returns an array without `next_cursor` fails it; a constant that never became a route
is never walked.

### 2.3 — Webhook Reliability

#### What exactly is signed, and why

**observed** — `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>` over `${t}.${rawBody}`,
default tolerance 300 s, constant-time compare (`PLUGFORGE.MD:149`; `api/src/platform/webhooks/signer.ts`;
`sdk/src/verifyWebhook.ts`). The timestamp is bound into the signed string so a captured request
cannot be replayed after the tolerance window; the `v1=` tag lets a `v2` scheme coexist during a
future rotation. This is Stripe's scheme deliberately (`docs/architecture.md:174-179`).

#### Retry schedule and how it's tested without sleeping

**observed** — 1s/4s/16s/1m/5m/30m + full jitter, `RETRY_SCHEDULE_MS` (`deliverer.ts:109`), six
attempts max (`:112`). The clock is injected: `api/src/platform/webhooks/clock.ts` defines it, the
deliverer takes it in its constructor, and `deliverer.test.ts` advances it — no `setTimeout` waits
anywhere in test code (`PLUGFORGE.MD:150`, `:249`). The jitter source is injectable too
(`deliverer.ts:329`).

#### Permanent vs. transient — is 4xx always permanent?

**observed** — yes, in this implementation: 5xx and timeout → retry; **any non-2xx/non-5xx
(including 429 and 410) → dead-letter immediately** (`deliverer.ts:707`, `:852`). Nuance that was
*not* taken: treating 429 as transient. Recorded here as a known simplification — a subscriber that
rate-limits us gets dead-lettered and must use replay. Also observed: an "unreachable forever"
outcome (DNS/connection refused class) is dead-lettered like a 4xx rather than retried
(`:678`).

#### How `Idempotency-Key` flows through replay, and the documented subscriber contract

**observed** — first-attempt deliveries mint a UUID key; `POST /api/v1/webhooks/deliveries/:id/replay`
re-sends the *same* key verbatim from the original row (`docs/architecture.md:180-183`, `:196-202`).
The subscriber-side contract is written out in full — check-then-store on the key, always 2xx on
duplicates, 4xx on a missing key, make the claim atomic (unique constraint + `INSERT … ON CONFLICT`)
— at `docs/architecture.md:188-236`, with a copyable reference subscriber at
`docs/submission/demo-webhook-listener.mjs`, proven by the PF-801 drill.

### 2.4 — SDK Design

#### Generated from OpenAPI, or hand-written and parity-tested?

**observed** — hand-written, parity-tested: PF-405's fitness test walks every OpenAPI operation and
asserts a typed SDK method exists, and no orphan SDK methods (`PLUGFORGE.MD:181`, `:260`).
**Trade-off, as the PRD records it:** type quality and hand-tuned ergonomics (async iterators, a
single `verifyWebhook`) over generated drift-safety; drift is caught in CI instead of prevented by
construction. The auth helpers are the part marked pre-1.0 for exactly this reason
(`docs/architecture.md:266`).

#### Error model in the SDK

**observed** — a hybrid that is more TypeScript-native than either pure option: the SDK *throws*
`ShipSdkError` (a real `Error` subclass, so stack traces and `instanceof` work) whose `kind` field
is the discriminated union `'auth' | 'forbidden' | 'not_found' | 'validation' | 'rate_limit' |
'server' | 'network'` (`sdk/src/errors.ts:81-121`; `PLUGFORGE.MD:176`). Consumers `catch`, narrow on
`kind`, and switch exhaustively; `'network'` carries no server `ApiErrorCode` (`errors.ts:142`).
Result-style returns were not chosen — they fight `await` ergonomics.

#### Pagination — raw cursors, async iterators, or both?

**observed** — both. `list()` returns one raw `{ data, next_cursor }` page; `iterate()` is an
async iterator over it and consumers never see the cursor (`sdk/src/resources/documents.ts:11-12`,
`:84`; `PLUGFORGE.MD:177`, PF-402 "early-break doesn't overfetch" `:257`). Both because the portal
needs a "load more" page boundary (`web/src/pages/DeveloperPortal.tsx:256-285`) while the CLI and
the agent want to stream.

#### `ITokenStore` contract; refresh under concurrent calls

**observed** — `get/set/clear` of a `TokenSet` that includes the refresh token (optional, since
Client Credentials has none) (`sdk/src/tokenStore.ts:26-48`); `MemoryTokenStore`,
`FileTokenStore` (CLI writes `~/.ship/credentials.json` at mode 0600,
`integrations/cli/src/commands/login.test.ts:82`), and localStorage in the browser demo. Refresh
under concurrency is a **single-flight mutex** on 401 (`sdk/src/client.ts:8-9`;
`PLUGFORGE.MD:178`).

### 2.5 — Developer Portal & Self-Service

#### Reuse the public API, or a privileged internal endpoint?

**observed** — dog food. On entry the portal mints a short-lived scoped personal token via the
`api_tokens` mechanism (session-authed) and every portal call goes to `/api/v1` with it
(`PLUGFORGE.MD:185`; PF-502's AC includes network-tab evidence, `:266`;
`web/src/contexts/DeveloperPortalContext.tsx`). The one internal escape hatch is app *seeding*
(grader/first-party apps by `db:seed`, `README.md:319-323`) — that is boot provisioning, not a
portal operation.

#### `client_secret` rotation — immediate invalidation or grace period?

**observed** — immediate, no grace period, documented as a deliberate choice (`PLUGFORGE.MD:227`;
`docs/architecture.md:309-315` applies the same rule to webhook secrets). Stripe keeps the old
secret alive for a configurable window so a subscriber can roll without a gap; that dual-secret
window is named as an explicit non-goal for Week 6 (`docs/architecture.md:314-315`). Rationale: one
valid secret at a time is simpler to reason about in a live interview and removes the "which one
signed this?" branch from the verifier.

#### Delivery-log view at thousands of rows

**observed** — server-side keyset pagination (limit 20 + `next_cursor`, "load more") with a status
filter (all/pending/success/failed/dead) (`web/src/pages/DeveloperPortal.tsx:122-127`, `:256-285`).
That is the build-cheap choice; it is also the rebuild-cheap one, because the API contract already
supports it and a virtualized list or time-bucket filter would sit on the same endpoint.

#### Payloads in the portal — full, redacted, or click-to-reveal?

**observed** — none of the three: the delivery-log API deliberately **never selects the `payload`
column** — the list view returns `response_excerpt` (capped at 2000 chars, `deliverer.ts:116`) and
metadata only (`api/src/platform/api/v1/resources/webhooks.ts:73-75`;
`web/src/pages/DeveloperPortal.tsx:79-93` has no payload field). Since payloads are ID+title
envelopes anyway (1.4 above), the leakage surface being defended is small; the excerpt is what an
operator needs to debug a 4xx.

### 2.6 — Agent-as-Citizen Rewire

#### Which OAuth flow does the agent use?

**observed / derived** — hybrid (`PLUGFORGE.MD:65`, decision 4): **Client Credentials** (RFC 6749
§4.4) as `ship_app_fleetgraph` for its 10 reads — first-party machine-to-machine, no human in the
loop, so a browser or device grant would be theatre — and the **acting human's short-lived scoped
personal token** for its 3 gated writes (`:282`, PF-703). Minting per-user OAuth tokens for the
writes was rejected as needless flow machinery for a first-party surface (`:282`). Both go through
`@ship/sdk` (`docs/architecture.md:278-286`).

#### How the agent's app is seeded

**observed** — idempotent boot seed (`api/src/platform/oauth/seedFirstPartyApp.ts`, PF-701),
secret from env, never committed; guaranteed in deployed environments by the Terraform env var
block plus a boot check (`PLUGFORGE.MD:280`; `terraform/render/web_service.tf`).

#### Which scopes, and the defense for each

**observed** — `documents:read`, `issues:read`, `sprints:read` only (`docs/architecture.md:279-280`).
Defense: every one of the agent's 10 reads (`agent/src/shipClient.ts:360-455`) maps onto those
three resources plus the read-only extensions PF-205 added for it (`PLUGFORGE.MD:241`); the agent's
own graph structurally cannot write (`graphWriteBoundary.test.ts`), so the app identity never
needs a write scope. Writes stay a recommendation-then-human-accepts pattern, executed under the
human's identity and attributed to the human in `public_api_audit` (`:282`, `:288-293`).

#### CI proof that Part 2's tests pass with the flag on and off

**observed** — the agent suite runs twice in both pipelines: default (`internal`) and
`AGENT_PLATFORM_MODE=sdk` (`.gitlab-ci.yml:126-140`, `.github/workflows/ci.yml:195-199`), plus
per-read-method parity tests (PF-702, `PLUGFORGE.MD:281`) and the e2e audit-trail proof (PF-704,
`:283`). Default remains `internal` until the matrix is green (`docs/architecture.md:283`).

---

## Phase 3: Post-Stack Refinement

### 3.1 — Security & Failure Modes

#### What happens when an OAuth app's owner is deleted?

**observed** — orphaned with a null owner: `oauth_apps.owner_user_id … ON DELETE SET NULL`
(`api/src/db/migrations/042_oauth_apps.sql:43`, index rationale `:60-63`). Tokens for the app keep
working — the app is a workspace-scoped resource (`workspace_id … ON DELETE CASCADE`, `:33`), not a
user-scoped one. Recovery story: an admin re-assigns or revokes via the registration endpoints
(PF-102). Chosen over cascade because deleting a person should not silently break an integration
the whole workspace depends on.

#### Deliverer crash mid-batch — at-least-once, at-most-once, or exactly-once?

**observed** — **at-least-once, subscribers must dedupe on `Idempotency-Key`.** Every attempt is
persisted before the deliverer moves on; on boot `InMemoryWebhookDeliverer.rehydrate()` re-enqueues
every `pending` row at its persisted `next_attempt_at`, and a simulated-crash test proves a fresh
instance completes the delivery (`docs/architecture.md:317-337`; `deliverer.ts`, PF-304/TRO-438).
What can still be lost or doubled: an attempt scheduled but not yet persisted, and an in-flight HTTP
call whose response was never recorded — hence at-least-once, hence the dedupe contract in 2.3.

#### Detecting and responding to a leaked `client_secret`

**derived** — manual rotation by the owner (portal rotate button, PF-502) or by an admin through
the registration endpoints (PF-102); rotation is instant with no grace period (`PLUGFORGE.MD:227`).
Automatic rotation is not built. **The audit signal** is `public_api_audit` (`:157`): every v1 call
is logged with `app_client_id`, `user_id`, route, scope, status, latency (migration 049), so a leak
shows up as calls under that `client_id` from an unexpected pattern — the same query that is E7's
submission proof (`docs/architecture.md:288-293`). No alerting exists on it today; the portal's
audit view is the read path (PF-501, `:265`).

#### CSRF protection on the portal's app-form and rotate-secret endpoints

**observed** — two layers. The portal talks to `/api/v1` with a **bearer token** it minted, and
bearer tokens are not auto-attached by browsers, so the v1 router shares no cookie/CSRF middleware
with internal routes by design (`PLUGFORGE.MD:92`). The one session-authed hop — minting that
portal token via `api_tokens`, and the consent/device-verify pages themselves — sits behind the
existing `csrf-sync` protection that applies to session auth and is skipped only for Bearer
requests (`api/src/app.ts:65-79`). Public CORS on `/api/v1` and `/oauth` token/device is
`credentials: false` (`PLUGFORGE.MD:93`), so no cookie ever rides a cross-origin call.

### 3.2 — Testing Strategy

#### How the TTFE drill is written

**observed** — containerized Ship (testcontainers Postgres, per the repo pattern) from a clean
working dir → install SDK → device login (auto-approved via API) → `webhooks.create` →
`documents.create` → wait for the signed POST → `verifyWebhook`, each stage timed and asserted
against `scripts/drill/ttfe.config.json` (`totalBudgetMs: 60000`, per-stage ceilings)
(`PLUGFORGE.MD:275`; `scripts/drill/ttfe.ts`). It is not a full `pnpm install` in a fresh
container: the SDK stage builds/installs from the workspace (observed `install_sdk` 1.0–3.9 s,
`PF-905-AI-COST-ANALYSIS.md:81-87`). That proves the *platform* path is fast and stable in CI at
~63 s of job wall-clock (`:94-108`); the "stranger on a clean machine in 30 minutes" half is a
different proof — the README steps run on a clean machine (PF-907, `PLUGFORGE.MD:303`).

#### Keeping OAuth Playwright tests stable — stub Keycloak or run a real auth server?

**observed** — neither: Ship *is* the auth server (hand-rolled, decision 5, `PLUGFORGE.MD:66`), so
the OAuth e2e specs run against a real Ship instance on an isolated testcontainers Postgres —
nothing external to stub. Cost observed locally: 378 ms–5.4 s per test once up; the volatile part
is per-worker Postgres container cold start, which exceeded 60 s under 18 concurrent factory
containers (`PF-905-AI-COST-ANALYSIS.md:137-160`). They are **not wired into CI**
(`:128-135`); the graded gate-executed proof for PKCE lives in api-level tests + the fitness suite,
and the browser round-trip specs stay on-demand.

#### Testing the deliverer's retry schedule without sleeping

**observed** — deterministic injected clock (`api/src/platform/webhooks/clock.ts`), advanced by
the test; the graded "500×3 then 200 → succeeds on attempt 4 with waits ≥ 1s/4s/16s" and
"6 failures → DLQ" scenarios both run as fast deterministic tests
(`PLUGFORGE.MD:249`, `:317-318`). Same discipline everywhere: "flake = P0 bug" (`:338`).

### 3.3 — Tooling & CI

#### Which lint rules catch boundary violations early

**observed** — both. `no-restricted-imports` blocks `**/routes/**` from `api/src/platform/api/v1/**`
(`eslint.config.mjs:111-119`), and workspace dependency rules + import lint keep
`integrations/*` on `@ship/sdk` only (`PLUGFORGE.MD:220`, PF-003; test at
`api/src/platform/__tests__/boundary-lint.test.ts`). The agent's `@ship/sdk` dependency is the
documented exception — it is a platform client (`:281`).

#### How the OpenAPI fitness test is wired into CI

**observed** — fail the build on drift: `pnpm openapi:check` diffs `docs/openapi.json` against the
in-process registry in both pipelines (`.gitlab-ci.yml:77-83`, `.github/workflows/ci.yml:98`), and
the PF-203 route-enumeration test runs with the unit suite. Additive changes are not exempt —
any change fails until `pnpm generate:openapi` is run and the regenerated file committed, which is
the point: the diff *is* the review artifact.

#### Enforcing the +10% performance regression budget

**derived / not-run** — the budget (`PLUGFORGE.MD:321`: P95 latency, bundle size, per-route query
counts ≤ +10% vs. the Part 1 baselines in `audit/`) is enforced by **compare-mode runs of the audit
skills against the `audit-baseline` tag**, not by a perf job on every PR — `scripts/factory/gate.sh`'s
own header says it does not measure improvement and points at that expensive tier. The one budget
that is a CI-failing check today is SDK size (`ci.yml:239`). This draft did not run a compare-mode
perf audit; whether the +10% holds on `main` right now is **not verified here**.

### 3.4 — Deployment & Hosting

#### Where the deployed instance lives; grader access without exposing tenant data

**observed** — Render, `https://ship-rr6m.onrender.com` (`README.md:400`), provisioned by
`terraform/render/` (decision 1, `PLUGFORGE.MD:62`; IAM adaptation memo
`docs/IAM-ADAPTATION-RENDER.md`, PF-902). Grader access is a pre-registered read-only OAuth app
(`ship_app_grader_9ea6a33b`, three read scopes, credentials published in `README.md:395-416`) against
synthetic seed data only — the credential is *provably* read-only (403 with `missing_scope` on any
write, `README.md:377-381`), so nothing real is reachable. Deploy caveat carried from the landmine
table: Render `auto_deploy` is broken (TRO-361), deploys are verified manually via the Render API
(`PLUGFORGE.MD:41`).

#### OpenAPI spec — live only, or also a static doc at a stable URL?

**observed** — both: served live at `GET /api/v1/openapi.json` (no auth,
`api/src/platform/api/v1/router.ts:103`; `README.md:383-384`) and committed as `docs/openapi.json`
(PF-204). No hosted Redoc/Stoplight page — the repo file is the stable static URL, and it is
guaranteed identical to the live one by the drift check.

#### One-command CLI setup for a grader

**observed** — it is not one command today; it is a short sequence. The SDK/CLI are workspace
packages, not npm-published (`PLUGFORGE.MD:347`), so a grader runs the repo's cold start
(`./start.sh`, `README.md:37-56`), then `pnpm --filter @ship/cli build`, then `ship login` against
the deployed `SHIP_API_URL`; `integrations/cli/package.json` exposes the `ship` bin. The genuinely
one-block path that needs no CLI at all — mint a Client Credentials token and `curl` `/api/v1/me` —
is `README.md:351-374`, and that is what the README leads with. **not-run** — this draft did not
execute the clean-machine run; PF-907's AC is that someone does, and this answer should be tightened
to a single tested command if one lands.

---

## Constraints carried forward

**Everything the grader can reach is read-only synthetic data.** The published grader credential
holds three read scopes and nothing else; the enforcement is the scope check, not the label.

**Retention does not exist yet.** `webhook_deliveries` and `public_api_audit` grow without bound;
30 days is the recommended window, grounded in two existing 30-day precedents in this repo. Fine
for a demo, a ticket for production.

**Every 4xx dead-letters, including 429.** Replay is the recovery. A subscriber that rate-limits Ship
will find its deliveries in the DLQ, not retried.

**Rotation has no grace period** — for app secrets and for webhook signing secrets alike. Simpler
to defend; costs the subscriber a coordinated switch.

**Do not point the test suite at a shared database.** `pnpm test` truncates whatever
`DATABASE_URL` names. Week 4's finding, still true (`PLUGFORGE.MD:18`).

---

## Reference artifact — saved AI conversation

The brief's Appendix says: *"Save your AI conversation as a reference document and attach it to
your final submission."* PF-904's acceptance criterion names which conversations qualify: **the
PRD-research/review conversations** — the sessions in which `PLUGFORGE.MD` was researched against
this repo, the landmine table was verified, and the decisions in §1.4 were made with Troy on
2026-08-10 (`PLUGFORGE.MD:300`: "the saved AI conversation exported and attached as a reference
artifact (brief mandate — the PRD-research/review conversations qualify)"). Any Claude Code or
claude.ai session that produced or reviewed the PRD is a valid artifact; the conversation that
produced *this* document is a valid supplementary one.

**No conversation is embedded or fabricated here.** Troy exports the real one. Steps:

1. **From Claude Code (terminal):** open the session you want to attach and run `/export` — it
   writes the full transcript as Markdown to a path it prints. Alternatively, the raw JSONL log for
   every session is under `~/.claude/projects/<escaped-repo-path>/` (this repo's directory is
   `-Users-troy-repos-GAUNTLET-Ship`); copy the relevant `<session-id>.jsonl` if you prefer the
   raw form. Use `claude --resume` to find the session by its first prompt if you don't have the
   id.
2. **From claude.ai (web):** open the conversation → the `…` / share menu → **Export** (or
   Settings → Privacy → **Export data** for a full-account archive; the conversation is in the
   resulting `conversations.json`).
3. Save it in this directory as
   `docs/submission/presearch-conversation-<YYYY-MM-DD>.md` (or `.txt` / `.json` for the raw
   forms). Before committing, redact **every** secret in place — API keys, the Render API key,
   any `client_secret`/`whsec_` value, session cookies, personal data — including the grader
   credential even though `README.md` publishes it deliberately (redacting it costs nothing and
   keeps the artifact policy simple). If any credential that is *not* deliberately public shows up
   in the export, rotate it before the artifact is committed, not after.
4. Replace the placeholder link below and commit on this branch (or a follow-up docs branch).

**Attached conversation:** `docs/submission/presearch-conversation-<date>.md` — *placeholder;
not yet exported.*

> **[TROY — needs your answer]** *Export the PRD-research/review session(s) per the steps above,
> drop the file in `docs/submission/`, and replace the placeholder link. Optionally also attach the
> session that produced this draft.*
