# PlugForge Demo Script — FINAL (PF-908 / TRO-444), 3–5 minutes

*Grounded against `main` @ `6b60377b` (2026-08-16, re-verified after the W6 gap-closure wave — PR
#300 — landed). Every command, flag, output line, button label, and CI job name below was read from
source at that commit or observed by running it (Act 1 in a worktree, Act 3 in CI) — the
"Provenance" section at the end says which is which. This is a snapshot: re-check `git log main`
before recording. `pnpm --filter @ship/cli test` includes a drift guard
(`demoScript.drift.test.ts`) that fails if the CLI, the drill, CI, or the portal stops printing any line Acts 1–3 quote.*

**What changed in this revision (vs. the `b68da413` version):** Act 3's expected output now shows
the drill as it actually prints on `main` today — two extra stages (`tamper_reject`,
`delivery_p95`), the `delivery_p95_ms` and `first_delivery_bound` lines (TRO-615), and the
`[mode]` line plus the second CI job `drill · TTFE image-mode (TRO-621)` that runs the same drill
against the container image. The numbers are copied from a real green CI run, not illustrative.
Act 2 gains one optional beat on the new **Audit** page (`/developer/audit`, TRO-616). Acts 1
and 2 otherwise re-verified unchanged.

**Who does what.** This ticket is a 🔔 human checkpoint. Troy records the video and posts. The
agent side (this script, the shot list, the pre-stage recipes, the real captured terminal frame at
`social-assets/w6/webhooks-tail-verified.{txt,png}`, and the post drafts in
`PLUGFORGE-SOCIAL-POST.md`) is done. Nothing here needs code changes to run.

---

## The story in one breath

> Open a fresh terminal → install `@ship/sdk` → `ship login` → `ship docs create` →
> `ship webhooks tail` prints a **verified, signed** delivery in real time. Then switch to the
> developer portal and replay one delivery from the DLQ. Then show CI proving the whole
> install-to-first-event path stays under 60 s — and that a tampered signature is rejected and
> first-attempt delivery P95 stays under 2 s — on every push.

Three acts, three surfaces: **terminal (Act 1) → portal (Act 2) → CI (Act 3)**. Target 4:00, hard
ceiling 5:00. Act 1 is the demo; Acts 2 and 3 are the "and it's operable / and it's guarded"
proof.

---

## Pre-stage checklist — do ALL of this before you hit record

Nothing in this section counts against the clock.

### P0. Ports and env

Ports float. Read them from your `pnpm dev` output (`API server running on http://localhost:NNNN`,
`Local: http://localhost:NNNN/`) — or, in a factory worktree, from `.factory-env` (`API_PORT`,
`WEB_PORT`; there is no `.ports` file in this checkout — the ticket brief's mention of one did not
match what is on disk).

```bash
export SHIP_API_BASE_URL=http://localhost:3000     # ← your API port
export WEB_URL=http://localhost:5173               # ← your web port
```

**`SECRET_ENCRYPTION_KEY` must be set for the API process** — `POST /api/v1/webhooks` 500s
without it (`encryptSecret()` throws; it encrypts the `whsec_…` secret at rest). `pnpm dev` reads
`api/.env.local`; dotenv loads at process start, so add it and *restart* the API:

```bash
grep -q SECRET_ENCRYPTION_KEY api/.env.local || echo "SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> api/.env.local
```

`CORS_ORIGIN` (what the API prints as the device-verify URL base) must be your real `$WEB_URL` —
`pnpm dev` sets this correctly; the captured transcript in `social-assets/w6/` shows
`http://127.0.0.1:1/oauth-device-verify` only because the capture ran with a dummy origin (see
Provenance).

### P1. Build the SDK and the CLI once; make `ship` resolvable

`@ship/sdk` and `@ship/cli` are `private: true` workspace packages — **neither is on the npm
registry**. "Install `@ship/sdk` in a fresh terminal" is real, but it is a *tarball* install
(exactly what the TTFE drill does in CI, `scripts/drill/ttfe.ts` → `installSdkInCleanDir()`):

```bash
pnpm build:shared && pnpm build:sdk && pnpm --filter @ship/cli build
(cd sdk && npm pack --pack-destination /tmp)            # → /tmp/ship-sdk-0.0.0.tgz
alias ship="node $PWD/integrations/cli/dist/bin.js"      # `ship` in every terminal you open on camera
```

(If you prefer a real binary on PATH: `cd integrations/cli && npm link` — not tested for this
script; the alias is what was run.)

### P2. A `client_id` for the CLI

`ship login` needs an OAuth app's `client_id` (`SHIP_CLI_CLIENT_ID` or `--client-id`; there is
no pre-seeded CLI app — `integrations/cli/src/config.ts` says so). Two ways:

**Via the admin API (uses the seeded `dev@ship.local` / `admin123`, requires CSRF first):**
```bash
rm -f /tmp/ship-cookies
CSRF=$(curl -c /tmp/ship-cookies -s $SHIP_API_BASE_URL/api/csrf-token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -b /tmp/ship-cookies -c /tmp/ship-cookies -s -o /dev/null -w 'login %{http_code}\n' -X POST $SHIP_API_BASE_URL/api/auth/login \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"email":"dev@ship.local","password":"admin123"}'
curl -b /tmp/ship-cookies -s -X POST $SHIP_API_BASE_URL/api/oauth-apps -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"name":"PlugForge Demo CLI","client_type":"public","redirect_uris":["http://localhost:5173/oauth/callback"],"requested_scopes":["documents:read","documents:write","webhooks:manage"]}' \
  | tee /tmp/ship-app.json
export SHIP_CLI_CLIENT_ID=$(python3 -c 'import json;print(json.load(open("/tmp/ship-app.json"))["data"]["client_id"])')
```

**Via SQL (what the capture and the drill do; `workspace_id` = dev@ship.local's workspace):**
```sql
INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
VALUES ((SELECT last_workspace_id FROM users WHERE email='dev@ship.local'),
        'PlugForge Demo CLI', 'ship_cli_demo', 'public', '{}',
        ARRAY['documents:read','documents:write','webhooks:manage']);
-- then: export SHIP_CLI_CLIENT_ID=ship_cli_demo
```

### P3. Browser tab, logged in

Log into `$WEB_URL` as `dev@ship.local` / `admin123` and leave the tab idle. This is the tab you
alt-tab to for the one on-camera "Approve" click (`/oauth-device-verify`) and for Act 2.

### P4. Force one dead-lettered delivery for the Replay shot

The real retry schedule (16 s, 1 m, 5 m …, six attempts) is minutes long — never wait for it on
camera. Do what `e2e/developer-portal-dlq-replay.spec.ts` does: seed the six-row chain by SQL.
You need one *active* subscription in dev@ship.local's workspace whose target is healthy at replay
time (`replay` refuses inactive subscriptions: `webhooks.ts` joins on `ws.active`).

1. Create the subscription (this stays *active*; `ship webhooks tail` deletes its own on Ctrl+C,
   so it cannot be reused). Easiest: portal → **Subscriptions** tab → **Create subscription**,
   event `document.created`, target `http://127.0.0.1:8787/`. Copy the subscription id and the
   `whsec_…` secret (shown once).
2. Start a healthy target with THAT secret and keep it running, off-screen, until after the
   Replay click. The reference subscriber answers **401 on a bad signature** and 200 only on
   ✓ verified — so a placeholder secret would make the replay land as *Failed*:
   ```bash
   SECRET=whsec_<from step 1> PORT=8787 node docs/submission/demo-webhook-listener.mjs
   ```
3. Seed the dead chain (one INSERT via psql — the e2e spec's 6-iteration loop, unrolled with `generate_series`; `\set` is a psql meta-command, substitute the id literally elsewhere):
   ```sql
   \set sub '<subscription-id>'
   INSERT INTO webhook_deliveries
     (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status, response_status, response_excerpt, latency_ms, next_attempt_at)
   SELECT :'sub', '11111111-1111-1111-1111-111111111111', 'document.created',
          '{"type":"document.created","data":{"id":"demo"}}'::jsonb,
          '22222222-2222-2222-2222-222222222222', n,
          CASE WHEN n = 6 THEN 'dead' ELSE 'failed' END, 500, 'Internal Server Error', 12, NULL
   FROM generate_series(1, 6) AS n;
   ```
   (Attempts 1–5 `failed`, attempt 6 `dead` with no `next_attempt_at` — the exact row shape
   `deliverer.ts` writes; one logical delivery = six rows sharing `idempotency_key`.)
4. Open `$WEB_URL/developer/webhooks`, filter **Dead (DLQ)** — the row is there. Do NOT click
   Replay yet.

### P5. Dry run

Run Act 1 once, off camera, end to end. Device codes expire in ~10 min, so don't pre-run
`ship login` itself — everything else can be pre-verified. Two terminals side by side for Act 1:
**left = `ship webhooks tail`, right = everything else.** Font ≥ 16 pt; the ✓ line must be
readable in a 1280-wide export.

---

## Act 1 — the five-line story (0:00 → 2:00) — terminal

**0:00–0:15 Framing.** *"Ship is a document/issue tool with a new platform layer — OAuth 2.0,
versioned API, signed webhooks. Here's the whole developer experience in five commands, from a
fresh terminal."*

**0:15–0:35 Install** (right terminal, `cd $(mktemp -d)`):
```bash
npm init -y >/dev/null && npm install /tmp/ship-sdk-0.0.0.tgz
```
SAY: *"That's the same tarball install the CI drill times every push."*

**0:35–1:05 Login** (right):
```bash
ship login
```
Expected output (real strings from `integrations/cli/src/commands/login.ts`):
```
To authorize this CLI, open: http://localhost:5173/oauth-device-verify
And enter the code: RZUB-W6R6
Waiting for authorization...
```
Alt-tab to the browser tab, open the URL, enter the code, click Approve, alt-tab back. Within one
poll interval it prints:
```
Logged in as Dev User <dev@ship.local> via app "PlugForge Demo CLI" (ship_cli_demo) — scopes: documents:read, documents:write, webhooks:manage.
Credentials saved to /Users/troy/.ship/credentials.json.
```
SAY: *"RFC 8628 device grant — the CLI never sees a password; scopes are exactly what it asked
for."* Optional 3-second beat: `ship whoami` (prints the same identity line, no trailing period).

**1:05–1:20 Tail** (LEFT terminal — this is the money shot, keep it visible from now on):
```bash
ship webhooks tail
```
Expected (real strings from `webhooksTail.ts`; ports and ids will differ):
```
Listening on http://127.0.0.1:58153/ for "document.created" deliveries.
Registered subscription 80ccc745-4d3a-4854-a31f-725285b84704 (target_url: http://127.0.0.1:58153/).
Waiting for deliveries. Press Ctrl+C to stop and clean up.
```
SAY: *"It started a local listener, registered a subscription pointing at it, and holds the
signing secret."*

**1:20–1:40 Create** (right):
```bash
ship docs create --title "PlugForge demo"
```
Expected:
```
Created document.
id: c60c1d80-618e-4c07-9c74-ddaa0e82cad0
title: PlugForge demo
document_type: wiki
created_at: 2026-08-16T14:36:24.130Z
updated_at: 2026-08-16T14:36:24.130Z
properties: {}
```
…and, in the LEFT terminal, within about a quarter of a second (266 ms in the capture):
```
✓ verified  2026-08-16T14:36:24.396Z  document.created
```
PAUSE on that line for two full seconds. SAY: *"That's a real HMAC-signed delivery, verified
client-side with `verifyWebhook()` from the SDK — same function any integrator would call. If the
signature or timestamp were wrong you'd see `✗ rejected` instead."*

**1:40–2:00 Clean exit** — Ctrl+C in the left terminal:
```
Cleaning up...
```
SAY: *"…and it deactivates the subscription on the way out. Five commands: install, login, tail,
create, done."* (Optionally `ship docs ls` — one tab-separated `id  type  title` line per doc.)

**Fallbacks, Act 1.**
- `ship login` fails with *"No OAuth client id configured"* → `SHIP_CLI_CLIENT_ID` isn't
  exported in that terminal (P2).
- `ship webhooks tail` errors on subscription create (500) → `SECRET_ENCRYPTION_KEY` missing
  in the API process (P0); restart the API.
- No ✓ line within ~5 s → the API cannot reach `127.0.0.1:<port>` (it must be the same host —
  local/containerized only, by design; for a remote API the command prints a `Note: … does not
  look like a local address …` hint and needs `--target-url <tunnel> --port <p>`).
- Total failure of the CLI on the day → fall back to the curl-based rehearsal in the Appendix
  (same story, more typing) or show `social-assets/w6/webhooks-tail-verified.png` and say it is
  a rendered capture from `b68da413`.

---

## Act 2 — the developer portal (2:00 → 3:15) — browser

Navigate to `$WEB_URL/developer/webhooks` (labels below are the real ones from
`web/src/pages/DeveloperPortal.tsx`).

**2:00–2:20 Delivery log.** Page header **Webhooks**; tabs **Deliveries & DLQ** / **Subscriptions**
(default: deliveries). Section **Delivery log** — *"One row per delivery attempt. Filter by status
to find dead-lettered deliveries (the DLQ) and replay them."* Columns: Status · Event · Attempt ·
Response · Idempotency key · Replayed from · Created · Actions. Point at the **Success** row from
Act 1's `document.created`. SAY: *"Every attempt is a row — you can see status codes and latency
per attempt, not just per event."*

**2:20–2:40 DLQ view.** Use the **Filter by status** select (`#delivery-status-filter`) → choose
**Dead (DLQ)**. The seeded row from P4 shows: badge **Dead (DLQ)**, attempt **6**, response
**500**. SAY: *"Six attempts on the retry schedule, then it's parked here instead of retried
forever."*

**2:40–3:05 Replay.** Click **Replay** in the row's Actions column (button label `Replay` →
`Replaying...` while in flight; `aria-label="Replay delivery <short-id>"`). A toast **Replay
succeeded** appears and a NEW row is prepended: **Success**, same **Idempotency key**, and its
**Replayed from** column shows the dead row's short id. Switch the filter back to **All statuses**
if you want both rows on screen. SAY: *"Same idempotency key on the replay — the subscriber's
dedupe still works; it's a real HTTP round-trip to the target, not a status flip."* (If your
off-screen listener has the real secret it prints its own ✓ line — a nice second beat.)

**3:05–3:15 Subscriptions tab** (optional): the table with the CLI's now-inactive subscription
greyed out (`opacity-50`) is a quiet proof of the tail's cleanup.

**Alternative 3:05–3:15 beat — Audit page** (optional, pick this OR the Subscriptions tab, not
both): sidebar entry **Audit** → `$WEB_URL/developer/audit`. Header **Audit**, section
**Public API audit log** — *"One row per `/api/v1` call, newest first."* Columns: Time · Method · Route ·
Status · Latency · App · User · Scope · Request ID; a **Filter by app** select (lists app *names*,
default **All apps**; the App column itself prints the `client_id`, e.g. `ship_cli_demo`). Every
`/api/v1` call Act 1 just made (`GET /me`, `POST /webhooks`, `POST /documents`, …) is a row.
SAY: *"Every call through the platform layer writes an audit row — app, user, scope, latency.
This is how we later prove our own AI agent, rewired onto this same path, is no longer a
privileged insider."* The page is admin/owner-gated — fine for `dev@ship.local`, who the seed
makes both super-admin and workspace admin. (Empty state, if you somehow have no calls:
*"No API calls recorded yet."*)

**Fallbacks, Act 2.**
- No dead row → P4 wasn't run against a subscription in *this* workspace (the list is
  workspace-scoped through `oauth_apps`).
- Toast says *"Replay recorded (status: Failed)"* → the target listener from P4 step 1 is not
  running; start it and click again (a fresh replay row is created each time).
- Portal shows *"Setting up developer session..."* forever → the session-minted portal token
  failed; reload once, else re-login.

---

## Act 3 — the CI drill (3:15 → 4:00) — GitHub Actions

Open the latest green run on `main` → job **`drill · TTFE (PF-603)`** (`.github/workflows/ci.yml`,
job id `drill-ttfe`; a fresh `postgres:15-alpine` service, `pnpm drill ttfe`). Expand the step
**Run the TTFE drill**. This is what it printed on the green run for the W6 gap-wave tip (run
`31955603688`, job `95187181592`, commit `2be3d1ef` = the PR #300 tip merged as `5eab5069`;
`scripts/drill/` and the CI job are byte-identical at `6b60377b`) — copied verbatim, only the
port and timings will differ on your run:

```
=== TRO-455 / PF-603: TTFE drill ===
[mode] api: tsx child

[setup] reusing ambient DATABASE_URL (CI service container / .factory-env) — no Docker touched
[setup] api ready at http://127.0.0.1:33637 (api: tsx child; 6363ms — untimed, not part of totalBudgetMs)

[delivery_p95] 20 deliveries; 20 correlated by payload data.id, 0 by arrival order
[mode] api: tsx child
  install_sdk: 3584ms
  device_login: 70ms
  webhook_create: 18ms
  document_create: 13ms
  wait_for_delivery: 301ms
  verify_webhook: 0ms
  tamper_reject: 1ms
  delivery_p95: 1052ms
  total: 5039ms / 60000ms budget
  delivery_p95_ms: 975ms over 20 deliveries (target < 2000ms)
verdict: pass
first_delivery_bound: wait_for_delivery 301ms <= 2000ms — ok
```
SAY: *"This job re-runs the exact five-line story on every push, from a clean `npm install` of the
SDK tarball through a real signed delivery — and fails the build if time-to-first-event goes over
60 s or any stage over its own budget (`scripts/drill/ttfe.config.json`, committed). Then it keeps
going: it flips one byte of the signed body and asserts `verifyWebhook()` rejects it, and it
bursts twenty documents and asserts first-attempt delivery latency P95 stays under two seconds —
the brief's own graded rows. It's the demo, as a regression gate."* Optionally point at the
over-budget form: a stage line gains ` OVER BUDGET (> 15000ms)`, the P95 line gains
` OVER BUDGET (>= 2000ms)`, and the verdict reads `verdict: fail`.

**Second job, 10-second beat (optional but cheap):** same run, job
**`drill · TTFE image-mode (TRO-621)`** (job id `drill-ttfe-image`, step
**Run the TTFE drill against the container image**). Same drill, but the API is the container image
(`[mode] api: image ship-api:ci`), Postgres is a testcontainers `postgres:15` with `ssl=on`. From
the same run (job `95187329714`): `install_sdk: 3215ms · device_login: 47ms · webhook_create: 10ms
· document_create: 10ms · wait_for_delivery: 592ms · verify_webhook: 0ms · tamper_reject: 0ms ·
delivery_p95: 1027ms · total: 4901ms / 60000ms budget · delivery_p95_ms: 974ms over 20
deliveries (target < 2000ms) · verdict: pass · first_delivery_bound: wait_for_delivery 592ms <=
2000ms — ok`. SAY: *"…and once more against the actual container we ship, not a dev process."*

**Fallback, Act 3.** If GitHub is slow/offline: run it locally, `pnpm drill ttfe` (with
`DATABASE_URL` set to a scratch DB it can migrate; ~15–30 s including setup — CI's setup was
6.4 s + a 5.0 s drill), and show the same table in the terminal. It prints the identical block,
`[mode] api: tsx child`.

---

## Close (4:00 → 4:20)

*"Five commands, one screenshot, one CI job. Ship as a platform: OAuth device flow, versioned API,
signed webhooks with a DLQ you can replay from, an audit row for every call — and a drill in CI
that re-runs the whole thing, tamper check and latency P95 included, on every push, so it stays
that way."*

---

## Shot list

| # | Time | Frame | Must be legible |
|---|------|-------|-----------------|
| 1 | 0:15 | Right terminal, `npm install …sdk-0.0.0.tgz` finishing | package name |
| 2 | 0:35 | `ship login` — the `And enter the code:` line | the code |
| 3 | 0:45 | Browser `/oauth-device-verify` → Approve | Approve button |
| 4 | 1:05 | Left terminal, `ship webhooks tail` waiting | "Waiting for deliveries" |
| 5 | 1:25 | **Both terminals**: `Created document.` (right) + `✓ verified … document.created` (left) — HOLD 2 s | the ✓ line (this is the social screenshot) |
| 6 | 1:45 | Left terminal `Cleaning up...` after Ctrl+C | — |
| 7 | 2:05 | Portal → Delivery log with the Success row | Status badge |
| 8 | 2:25 | Filter = Dead (DLQ), the seeded row | Attempt 6 / 500 |
| 9 | 2:45 | Click Replay → toast "Replay succeeded" + new Success row, "Replayed from" filled | both rows |
| 10 | 3:20 | Actions run → `drill · TTFE (PF-603)` job, per-stage table through `first_delivery_bound … — ok` | `total:` line, `tamper_reject:` line, `delivery_p95_ms:` line, `verdict: pass` |
| 11 | 3:50 | (optional) `drill · TTFE image-mode (TRO-621)` job, `[mode] api: image ship-api:ci` + `verdict: pass` | the `[mode]` line |

Still image for the post: `docs/submission/social-assets/w6/webhooks-tail-verified.png` (frame 5,
left pane). Prefer a real screenshot from your own take if the font is legible; otherwise the PNG
is a faithful render of real output (see Provenance).

---

## Provenance of the captures (observed vs. derived)

- **Observed (run 2026-08-16 in worktree `Ship-wt-tro_444`, commit `b68da413`):** the full
  Act 1 flow — real API process (`pnpm --filter @ship/api exec tsx src/index.ts`, `PORT=3376`,
  fresh `SECRET_ENCRYPTION_KEY`), real `@ship/cli` build (`integrations/cli/dist/bin.js`), real
  `ship login` (device code auto-approved by `POST /oauth/device/verify` with a seeded session
  cookie — the drill's own technique, standing in for the browser click), `ship whoami`,
  `ship webhooks tail`, `ship docs create --title "PlugForge demo"`. Verbatim stdout is in
  `social-assets/w6/five-line-story-transcript.txt` (one hand edit, marked: the credentials path)
  and, tail pane only, `social-assets/w6/webhooks-tail-verified.txt`. The principal was seeded and
  deleted with the same SQL `scripts/drill/ttfe.ts` uses; the API was run with
  `CORS_ORIGIN=http://127.0.0.1:1`, which is why the transcript's verify URL is that dummy origin.
- **`webhooks-tail-verified.png` is a rendered image of that captured text** (dark HTML page,
  monospace, screenshotted with the repo's Playwright), **not a photograph or a real terminal
  screenshot.** The lines are real; the window chrome is not.
- **Observed (CI, 2026-08-16):** the whole of Act 3's quoted output — both drill blocks — is
  copied verbatim from GitHub Actions run `31955603688` (jobs `95187181592` `drill · TTFE
  (PF-603)` and `95187329714` `drill · TTFE image-mode (TRO-621)`, both `success`) on commit
  `2be3d1ef`, the PR #300 tip that merged to `main` as `5eab5069`. `git diff 2be3d1ef 6b60377b --
  scripts/drill .github/workflows/ci.yml` touches only an unrelated CodeQL `config-file` line
  (TRO-590), so the drill this script quotes is the drill on `main` today. Read via `gh run view
  --job <id> --log`; only the timestamps/job-name prefix were stripped. Note that `main`'s own
  runs after `5eab5069` were mostly `cancelled` by newer pushes (concurrency group), so "latest
  green run on `main`" may resolve to an older commit than the tip when you open Actions —
  pick any green run at or after `5eab5069`, or a green PR run.
- **Derived (read from source at `6b60377b`, not run in this session):** portal labels/testids
  (`DeveloperPortal.tsx`, `DeveloperAudit.tsx`, `DeveloperSidebar.tsx`), the CI job names/steps
  (`ci.yml`), the drill table shape (`thresholds.ts`, `ttfe.ts`), the audit page's admin/owner
  gate (`resources/audit.ts` header) and dev@ship.local's roles (`seed.ts`). The P4 SQL is the
  e2e spec's insert with `generate_series` in place of its loop; not executed here. The
  `npm link` route in P1 was not tested. The 266 ms create→verified gap is the difference between
  the two ISO timestamps in the transcript. The Act 2 audit-page beat has not been walked in a
  browser for this revision — its labels are from source and its unit test
  (`DeveloperAudit.test.tsx`), not from a screenshot.
- **Not part of the demo:** the Render deployment (`ship-rr6m.onrender.com`). Its `/health`
  answered 200 and `/api/v1/openapi.json` served 21 paths when checked for this revision, but
  which commit it runs was not verified — auto-deploy is broken (TRO-361) and a manual deploy of
  `main` was still pending in `memory-bank/activeContext.md`. Everything above runs locally; do
  not point the CLI at Render on camera unless someone has redeployed and re-checked first.

---

## Appendix — curl-only fallback (from the W5 rehearsal script)

Kept only as an emergency path if the CLI is unusable on the day; it tells the same story with
raw HTTP. Requires `$SHIP_API_BASE_URL`, `$SHIP_CLI_CLIENT_ID`, and `$APP_ID` (from P2's
`/tmp/ship-app.json` → `data.id`).

```bash
# device grant
R=$(curl -s -X POST $SHIP_API_BASE_URL/oauth/device/code -d "client_id=$SHIP_CLI_CLIENT_ID" -d 'scope=documents:read documents:write webhooks:manage')
echo "$R" | python3 -m json.tool          # open verification_uri_complete in the logged-in tab, Approve
DC=$(echo "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["device_code"])')
for i in $(seq 1 24); do TOKEN=$(curl -s -X POST $SHIP_API_BASE_URL/oauth/token -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code' -d "device_code=$DC" -d "client_id=$SHIP_CLI_CLIENT_ID" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))'); [ -n "$TOKEN" ] && break; sleep 5; done
curl -s $SHIP_API_BASE_URL/api/v1/me -H "authorization: Bearer $TOKEN" | python3 -m json.tool
# subscribe → listener → create
curl -s -X POST $SHIP_API_BASE_URL/api/v1/webhooks -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"event_type\":\"document.created\",\"target_url\":\"http://127.0.0.1:8787/\"}"   # copy whsec_…
SECRET=whsec_... PORT=8787 node docs/submission/demo-webhook-listener.mjs      # left terminal → prints ✓ verified (fresh)
curl -s -X POST $SHIP_API_BASE_URL/api/v1/documents -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"PlugForge demo"}'
```
