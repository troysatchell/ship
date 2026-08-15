# PlugForge Demo Script — DRAFT (rehearsal, not the final PF-904/PF-908 recording)

*Grounded against `main` @ `7273716` (2026-08-14, reconfirmed unchanged as of this revision). Every
command below hits a route that is merged and unit/e2e-tested today — none of it is aspirational
PRD text. Re-verify against a fresh `git log main` before recording — this is a snapshot, not a
living doc.*

**This is not the PF-908 final video script.** PF-904 is a 🔔 HUMAN CHECKPOINT — the real recording
needs your own pre-search answers and go-ahead first (PLUGFORGE.MD §0.1). Use this to rehearse.

---

## 5-MINUTE CORE DEMO — use this one

Three pillars, nothing else: **OAuth is real** → **the public API works and is scope-checked** →
**webhooks are signed and verifiable**. That's the actual platform story ("Ship becomes a
platform"), and all three are merged on `main` today. No CLI (PF-600 is failing CI), no browser
demo (PR #226 is green but unmerged — an extra service is extra live-demo risk for 5 minutes), no
resilience/retry/replay/stolen-token detail — those are real and gated but they're depth, not the
core pitch, and none of the retry story can run live anyway (the schedule is minutes long). All of
that is preserved below as the extended/reference script for the actual PF-908 submission video,
which isn't time-boxed to 5 minutes.

### Pre-stage all of this BEFORE you hit record — none of it counts against the 5 minutes

**One-time environment fix (already done as of this revision, but if `pnpm dev` gets restarted on
a machine that doesn't have it): `api/.env.local` needs `SECRET_ENCRYPTION_KEY` set** —
`POST /api/v1/webhooks` 500s without it (`encryptSecret()` throws; it's what encrypts the
`whsec_...` secret at rest, §2.2). Generate one and restart `pnpm dev` (dotenv only loads at
process start, so an edit alone won't take effect):
```bash
echo "SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> api/.env.local   # then restart pnpm dev
```

One block, paste it whole, every new terminal — ports FLOAT (`scripts/dev.sh` picks whatever's
free; other sessions on this machine have their own Ship instances up, so this deliberately does
NOT auto-scan and grab whichever port answers first). Read the actual values from your `pnpm dev`
output (`api dev: API server running on http://localhost:NNNN` and `web dev: Local: http://localhost:NNNN/`)
and set them here — every step below checks its own HTTP status so a failure prints a clear line
instead of a python traceback three steps later:

```bash
export API_URL=http://localhost:3001
export WEB_URL=http://localhost:5174
rm -f /tmp/ship-cookies /tmp/ship-app.json

# 1. CSRF token FIRST — /api/auth/login is itself CSRF-protected (app.ts's conditionalCsrf only
#    skips CSRF for Bearer-token requests; login has no Bearer token yet), so fetching this after
#    login is backwards and login will silently 403.
CSRF=$(curl -c /tmp/ship-cookies -s $API_URL/api/csrf-token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
[ -z "$CSRF" ] && echo "FAILED: no CSRF token — is \$API_URL ($API_URL) actually Ship's API?"

# 2. Login, using that token
LOGIN_STATUS=$(curl -b /tmp/ship-cookies -c /tmp/ship-cookies -s -o /tmp/ship-login.json -w '%{http_code}' \
  -X POST $API_URL/api/auth/login -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"email":"dev@ship.local","password":"admin123"}')
echo "login: $LOGIN_STATUS"; [ "$LOGIN_STATUS" != "200" ] && cat /tmp/ship-login.json

# 3. Register the demo OAuth app (there's no portal yet — PF-502 isn't built — so this is the
#    README's documented admin-API fallback). Same CSRF token still works — it's tied to the
#    session cookie, not rotated by login. redirect_uris is required by the schema but never
#    dereferenced by the device-grant flow this demo uses (that's PKCE's field) — the literal
#    localhost:5173 below doesn't need to match $WEB_URL for this to work.
APP_STATUS=$(curl -b /tmp/ship-cookies -s -o /tmp/ship-app.json -w '%{http_code}' \
  -X POST $API_URL/api/oauth-apps -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"PlugForge Demo","client_type":"confidential","redirect_uris":["http://localhost:5173/oauth/callback"],"requested_scopes":["documents:read","documents:write","webhooks:manage"]}')
echo "app registration: $APP_STATUS"; cat /tmp/ship-app.json; echo

CLIENT_ID=$(python3 -c 'import json;print(json.load(open("/tmp/ship-app.json"))["data"]["client_id"])')
APP_ID=$(python3 -c 'import json;print(json.load(open("/tmp/ship-app.json"))["data"]["id"])')
echo "CLIENT_ID=$CLIENT_ID  APP_ID=$APP_ID"
```

- Open a browser tab, log into the web app as `dev@ship.local` / `admin123`, leave it sitting idle
  — this is the tab you'll alt-tab to for the one live approve-click.
- Do a **full dry run** of the script below once, off-camera, so `main`'s current state (and your
  typing) are proven end-to-end before the take. Device codes expire in ~10 min, so don't pre-run
  the device-code step itself — everything else can be pre-verified.
- Have two terminals side by side: left = the webhook listener, right = everything else.

### Live, ~4:30 target (30s buffer)

**0:00–0:15 — Framing.** *"Ship is adding a public platform layer this week — OAuth 2.0, a
versioned API, and signed webhooks — so a third party can build against it the same way they'd
build against Stripe or GitHub."*

**0:15–1:15 — OAuth, for real.**

```bash
DEVICE_RESP=$(curl -s -X POST $API_URL/oauth/device/code \
  -d "client_id=$CLIENT_ID" -d 'scope=documents:read documents:write webhooks:manage')
echo "$DEVICE_RESP" | python3 -m json.tool
DEVICE_CODE=$(echo "$DEVICE_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["device_code"])')
USER_CODE=$(echo "$DEVICE_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["user_code"])')
VERIFY_URL=$(echo "$DEVICE_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verification_uri_complete"])')
echo ""
echo ">>> OPEN THIS URL (in the tab already logged in as dev@ship.local), click Approve:"
echo ">>> $VERIFY_URL"
```
SHOW the pretty-printed response and the `>>>` URL line on screen — that's the actual `user_code`
a human reads off a device screen. Alt-tab, open the URL, one click Approve, alt-tab back.

```bash
# Polls automatically — no need to time a single manual retry against your own click.
TOKEN=""
for i in $(seq 1 24); do
  RESP=$(curl -s -X POST $API_URL/oauth/token \
    -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
    -d "device_code=$DEVICE_CODE" -d "client_id=$CLIENT_ID")
  TOKEN=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
  [ -n "$TOKEN" ] && break
  sleep 5
done
echo "TOKEN=$TOKEN"
curl -s $API_URL/api/v1/me -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```
This block just sits there printing nothing until you click Approve, then resolves within ~5s —
that's fine, keep talking over it. SAY: *"That's the real RFC 8628 device grant — `{ user, app,
scopes }` back, exactly the scopes I asked for, nothing more."*

**1:15–1:45 — The public API is real, not a mock.**
```bash
curl -s $API_URL/api/v1/documents -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```
SAY: *"Every route here is spec'd — `/api/v1/openapi.json` — and a CI fitness test fails the build
if a route skips registration, a scope, or the standard error shape. It's a drift gate, not
documentation you have to remember to update."*

**1:45–3:30 — Webhooks: subscribe → write → signed delivery, live.**
```bash
curl -s -X POST $API_URL/api/v1/webhooks -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"event_type\":\"document.created\",\"target_url\":\"http://localhost:8787/\"}"
```
SHOW the `whsec_...` secret in the response. SAY: *"Shown exactly once, Stripe-style — Ship stores
it encrypted, not hashed, because the server has to compute the HMAC, not just check it. That
deviation from the brief's literal wording is written up in `docs/architecture.md`."*

In the left terminal:
```bash
SECRET=<paste whsec_...> PORT=8787 node docs/submission/demo-webhook-listener.mjs
```
Back in the right terminal:
```bash
curl -s -X POST $API_URL/api/v1/documents -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"PlugForge demo doc","document_type":"wiki"}'
```
SHOW the left terminal print `✓ verified  document.created  ...` within ~1–2 seconds. SAY: *"That's
`Ship-Signature: t=...,v1=...`, verified with one call to `verifyWebhook()` from `@ship/sdk` — the
exact function a real third-party integration would call. Under a millisecond, no network round
trip needed to trust it."*

**3:30–4:20 — Close, zoomed out.** *"That's the platform core: real OAuth, a versioned public API
with a drift-checked spec, and cryptographically verifiable webhooks — deployed today at
`ship-rr6m.onrender.com`, described entirely in Terraform. Every call through this layer writes an
audit row — app, user, scope, latency — which is what lets us prove, when our own AI agent gets
rewired onto this same path, that it's no longer a privileged insider."*

**4:20–5:00 — buffer.**

If something misbehaves live: skip straight to the webhooks act (it's the single highest-signal
beat) and narrate the OAuth step from the pre-recorded dry run instead of re-attempting it on
camera — a stalled device-code poll eats the clock fastest.

---

## Extended / reference script (for the eventual PF-908 submission video, not the 5-min slot)

The acts below add resilience (deterministic retry/DLQ), the browser SDK PKCE demo, and the
stolen-refresh-token story. None of it fits in 5 minutes; keep it for when PF-600–603 land and the
target isn't a hard time box.

## Setup (before recording)

```bash
pnpm dev                 # ports float — set $API_URL/$WEB_URL per the pre-stage block above
pnpm --filter @ship/sdk build   # dist/ needed by the demo-webhook-listener.mjs stand-in below
```

One-time: log in as the dev seed user and register a full-scope OAuth app (there's no portal yet —
PF-502 isn't built — so this is the README's documented admin-API fallback, same one the MVP cut
line's kill-criterion anticipates). Do this **once**, save the output, reuse across takes:

```bash
# 1. Session cookie
curl -c /tmp/ship-cookies -s -X POST $API_URL/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"dev@ship.local","password":"admin123"}' | head -c 300

# 2. CSRF token (cookie-scoped)
CSRF=$(curl -b /tmp/ship-cookies -s $API_URL/api/csrf-token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# 3. Register the demo app — confidential client, all three read scopes + write + webhooks:manage
curl -b /tmp/ship-cookies -s -X POST $API_URL/api/oauth-apps \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{
    "name": "PlugForge Demo",
    "client_type": "confidential",
    "redirect_uris": ["http://localhost:5173/oauth/callback"],
    "requested_scopes": ["documents:read","documents:write","issues:read","sprints:read","webhooks:manage"]
  }' | tee /tmp/ship-app.json
```

Save `client_id`, `client_secret` (shown once), and `app.id` (a UUID — this is what the webhooks
subscription body needs as `app_id`, not the `client_id`) from `/tmp/ship-app.json`.

---

## Act 1 — OAuth device flow, the "five-line story" (0:00–1:00)

PF-600's `ship login` exists but its PR (#227) is failing CI typecheck right now, so the demo runs
the protocol directly instead of through the broken CLI wrapper — arguably more convincing for an
architecture defense anyway, since it shows the actual RFC 8628 exchange, not a black box.

```bash
CLIENT_ID=$(python3 -c 'import json;print(json.load(open("/tmp/ship-app.json"))["app"]["client_id"])')

curl -s -X POST $API_URL/oauth/device/code \
  -d "client_id=$CLIENT_ID" -d 'scope=documents:read documents:write webhooks:manage'
```

- **SAY:** "That's the whole device grant handshake — a `device_code` the CLI holds and a
  `user_code` the human types."
- **SHOW:** the JSON response: `user_code`, `verification_uri_complete`, `interval`.
- Open `verification_uri_complete` in a browser, logged in as `dev@ship.local` → approve.
- Poll (this is what `ship login` does under the hood):

```bash
curl -s -X POST $API_URL/oauth/token \
  -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  -d "device_code=$DEVICE_CODE" -d "client_id=$CLIENT_ID"
```

- **SAY:** "Before approval this returns `authorization_pending`. After — an access token, a
  30-day rotating refresh token, and exactly the scopes I asked for."
- **SHOW:** the token response, then prove it works:

```bash
TOKEN=<access_token from above>
curl -s $API_URL/api/v1/me -H "authorization: Bearer $TOKEN"
```

`{ user, app, scopes }` — **SAY:** "That's `PF-107`'s bearer middleware — same route accepts an
OAuth token or a scoped personal token, and both classes carry through to every audit row."

## Act 2 — Public API surface + spec parity (1:00–1:45)

```bash
curl -s $API_URL/api/v1/documents -H "authorization: Bearer $TOKEN" | python3 -m json.tool
curl -s $API_URL/api/v1/openapi.json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d["paths"]),"routes,",d["info"]["version"])'
```

- **SAY:** "Every one of those routes is walked by a fitness test at CI time — a route that skips
  OpenAPI registration, a scope declaration, or the `ApiError` shape fails the build. That's
  `PF-203`, and it's the drift gate, not a style nit."
- **SHOW:** `docs/openapi.json` committed in the repo + `.github/workflows/ci.yml`'s drift-diff step
  (PF-204) — "the spec you're reading is provably the spec being served."
- Trigger a 403 to show the scope-naming contract: strip `webhooks:manage` from a token, call the
  webhooks endpoint, **SHOW** the response names the missing scope in `details`, never "forbidden."

## Act 3 — Webhooks: subscribe → write → signed delivery (1:45–3:00)

Start the listener (stand-in for PF-602's `ship webhooks tail`, which doesn't exist yet — see the
gap list):

```bash
SECRET=<filled in after step below> PORT=8787 node docs/submission/demo-webhook-listener.mjs
```

In a second terminal:

```bash
APP_ID=$(python3 -c 'import json;print(json.load(open("/tmp/ship-app.json"))["app"]["id"])')

curl -s -X POST $API_URL/api/v1/webhooks -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"event_type\":\"document.created\",\"target_url\":\"http://localhost:8787/\"}"
```

- **SAY:** "The `whsec_...` secret comes back exactly once — same UX as Stripe. Ship stores it
  encrypted, not the plaintext, and can't show it again — that's a deliberate, documented
  deviation from the brief's literal 'hashed secret' wording, because the server has to *compute*
  an HMAC, which a one-way hash makes impossible. It's in `docs/architecture.md`."
- Copy the `whsec_...` value into the listener's `SECRET` env var (restart it), then:

```bash
curl -s -X POST $API_URL/api/v1/documents -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"PlugForge demo doc","document_type":"wiki"}'
```

- **SHOW:** the listener terminal prints `✓ verified  document.created  ...` within ~2 seconds.
- **SAY:** "That's `Ship-Signature: t=...,v1=...` over `${t}.${rawBody}`, verified with the exact
  same one-call `verifyWebhook()` a real third-party subscriber would import from `@ship/sdk` —
  under a millisecond, constant-time compare."
- Tamper demo (optional, 15s): replay the same curl body to the listener's port with a bit flipped
  in the signature header — **SHOW** `✗ rejected`.

```bash
curl -s $API_URL/api/v1/webhooks/deliveries -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

- **SAY:** "Every attempt is logged — status, latency, attempt number — independent of whether the
  listener was even running to receive it."

## Act 4 — Resilience story (3:00–3:30, narrate over test output, don't wait on real retries)

The full retry schedule (1s/4s/16s/1m/5m/30m) is ~36 minutes wall-clock — don't run it live. Show
the **deterministic** proof instead:

```bash
cd api && npx vitest run src/platform/webhooks/__tests__/deliverer.test.ts
```

(NOT `pnpm --filter @ship/api test -- deliverer` — that `--` form does not scope to the path at
all, it runs the FULL api suite; `lessons.md`'s 2026-08-12 entry has the mechanism. Corrected here,
2026-08-14, found while writing up PF-801 below.)

- **SAY:** "This is the graded scenario — three `500`s then a `200`, retries land at 1, 4, and 16
  seconds, succeeds on attempt 4. It's proven with an injected clock, not real `setTimeout` waits —
  zero flake risk in CI. Six failures dead-letters into the DLQ; that's the same test file."
- **PF-306 (replay) and PF-801 (idempotency-key dedupe) are BOTH merged to `main` as of this
  revision** (corrected 2026-08-14 — an earlier draft of this line said PF-306 wasn't merged yet;
  it has been since `feat/pf-306-replay-endpoint` landed). Two SEPARATE beats — deliberately not
  conflated (an earlier draft of this section did, incorrectly: a replay always re-sends to the
  subscription's own `target_url`, so replaying against a subscription whose target is genuinely
  unreachable cannot "succeed against the listener" at all):
  1. **DLQ resilience** (what the retry schedule guards against): point a subscription at an
     unreachable URL, let real attempts exhaust into the DLQ (or narrate this over
     `deliverer.test.ts`'s deterministic-clock proof above instead of waiting on real retries) —
     `status: 'dead'` in `GET /api/v1/webhooks/deliveries`.
  2. **Dedupe** (this ticket, PF-801): reuse Act 3's subscription — the one already pointed at the
     LIVE listener, which already received one successful delivery — and replay THAT delivery:
     `POST /api/v1/webhooks/deliveries/:id/replay`. The listener script above now prints
     `DUPLICATE ... recognized, not reprocessed` for it, because the replay carries the exact same
     `Idempotency-Key` the original successful delivery did. That dedupe behavior is the reference
     implementation `createReferenceSubscriber()` (same file,
     `docs/submission/demo-webhook-listener.mjs`) exports — see `docs/architecture.md`'s "Subscriber
     dedupe contract" section for the write-up, and `e2e/webhook-idempotency-key-drill.spec.ts` for
     the recorded, deterministic proof of exactly this deliver → replay → dedupe sequence end to
     end.

## Act 5 — Browser SDK, PKCE, no secret in the browser (3:30–4:15)

This one's fully ready — PR #226 (`feat/pf-802-browser-sdk-demo`) is green on all checks, just not
merged to `main` yet. Merge it before recording, or demo straight off the branch.

```bash
pnpm --filter @ship/browser-demo seed-oauth-app   # prints its own VITE_SHIP_CLIENT_ID
VITE_SHIP_CLIENT_ID=<from above> VITE_SHIP_API_BASE_URL=$API_URL \
  pnpm --filter @ship/browser-demo dev
```

- **SHOW:** click "Connect to Ship" → real browser redirect to `/oauth/authorize` → consent
  screen → redirected back, documents list populated via `client.documents.iterate()`.
- **SAY:** "No client secret ever ships to this page — it can't, it's a public client. This is the
  same `authorizationCodeFlow()` PKCE helper any third-party integrator gets from `@ship/sdk`, zero
  runtime dependencies, under 250 KB gzipped, CI-enforced."
- **SHOW:** browser devtools Network tab — the token exchange, no secret anywhere in a request the
  page sent.

## Act 6 — The stolen-token story, if PF-800 has merged (4:15–4:35, optional)

```bash
pnpm --filter @ship/api test -- refresh-rotation-stolen-token
```

- **SAY:** "Rotate a refresh token once — normal use. Replay the *old*, now-retired one — that's
  what a stolen token looks like. The response is `invalid_grant` with a reuse-specific message,
  the live access token from one call earlier stops authenticating immediately, and every token in
  that family gets `revoked_at` — including the legitimate client's own newest, never-leaked
  token. Recovery requires a fresh login, not just not-getting-caught."

## Close (4:35–5:00)

- **SAY:** "Deployed at `ship-rr6m.onrender.com`, described entirely by `terraform/render/` — the
  grader's read-only OAuth credential is a Terraform-managed env var, not a console click."
- **SHOW:** `terraform/render/plan/post-import-plan-no-changes.txt` (re-run `terraform plan` fresh
  before citing it — confirm it still reports no drift against the current platform env vars,
  don't assume the committed file is current).
- **SAY:** "Every one of these routes writes a `public_api_audit` row — app, user, scope used,
  latency. That's what proves Epic 7's agent rewire later: `grep` the audit trail for the agent's
  `client_id` and every read and write is right there."

---

## What's NOT ready yet

Don't script around these — they're gaps, not demo material, as of 2026-08-14:

| PRD ticket | Status | Why it matters to the demo |
|---|---|---|
| PF-600 `ship login` | PR #227 open, **failing** `typecheck · build · unit tests` | The literal CLI entry point the PRD's five-line story assumes |
| PF-601 `ship docs ls/get/create` | Worktree exists, no commands written yet | CLI resource commands |
| PF-602 `ship webhooks tail` | **Not started** — no branch/worktree found | The PRD calls this "the demo-video money shot" (§4, E6). `demo-webhook-listener.mjs` above is a stand-in, not a substitute — it doesn't register/clean up its own subscription the way PF-602's AC requires |
| PF-603 TTFE drill in CI | **Not started** | The literal graded metric ("the grade is the Time-to-First-Event drill, not endpoint count," PRD header). Nothing here proves the <60s CI / <30min clean-machine numbers — that requires this ticket to exist |
| PF-306 replay endpoint | Built on `feat/pf-306-replay-endpoint`, not on `main` | DLQ→replay is a graded scenario (§5 of the PRD) |
| PF-501 portal audit trail | PR #225 open, checks incomplete | `GET /api/v1/audit` for the portal |
| PF-502/503 developer portal | **Not started** | All portal UI Acts above are curl-based because there's no UI yet; the kill-criterion (§2.9) may apply if E6 stays ahead in priority |
| PF-802 browser demo | PR #226, all green, unmerged | Merge before recording — Act 5 depends on it |
| PF-800 refresh-rotation drill | On `feat/pf-800-refresh-rotation-drill`, appears complete per `CHANGES.md`, confirm merged before Act 6 | Optional act |

**Before the real PF-908 recording:** land PF-600 (fix the failing typecheck), PF-601, PF-602, and
PF-603 — in that order, matching `memory-bank/activeContext.md`'s next-actions priority — then
redo Acts 1 and 3 through the actual CLI instead of raw curl / the stand-in listener, and add a
seventh act showing the TTFE drill going green in CI. That's the difference between this rehearsal
script and the final submission video.
