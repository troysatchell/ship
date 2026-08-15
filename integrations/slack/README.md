# Ship Slack Integration

Reference integration (PF-803, `PLUGFORGE.MD` §4): an Express receiver that verifies Ship
webhook deliveries (`verifyWebhook`, from `@ship/sdk/node`) and posts `document.created` /
`issue.assigned` events to a Slack channel via Slack's Web API.

`@ship/sdk` is this package's only *runtime* dependency (`scripts/check-integration-deps.mjs`
enforces this in CI) — `express` and `@slack/web-api` are dev/build-time dependencies, bundled
into one self-contained `dist/server.js` by `pnpm build` (esbuild). `node dist/server.js` needs
nothing installed at deploy time.

## Set up a live demo

You need: a Ship API reachable from the public internet (or a tunnel — `ngrok http 3900` works
for a local demo), and a Slack workspace you can install an app into.

### 1. Create the Slack app and bot token

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Under **OAuth & Permissions**, add the bot token scope `chat:write`.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-...`).
4. Invite the bot to the channel you want events posted to (`/invite @YourAppName` in Slack), and
   note that channel's ID (right-click the channel → **View channel details** → copy the ID at
   the bottom, `C0123...`).

### 2. Register a Ship webhook subscription

Requires a Ship API token or OAuth access token with the `webhooks:manage` scope.

```bash
curl -X POST https://<your-ship-host>/api/v1/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-public-receiver-host>/webhooks/ship",
    "events": ["document.created", "issue.assigned"]
  }'
```

The response includes `secret` (a `whsec_...` value) **exactly once** — copy it now. Ship
encrypts it at rest and never shows it again (`rotateSecret()` mints a new one if you lose it).

### 3. Run the receiver

```bash
pnpm --filter @ship/sdk build   # this demo imports @ship/sdk/node's verifyWebhook

SLACK_BOT_TOKEN=xoxb-... \
SLACK_CHANNEL_ID=C0123... \
SHIP_WEBHOOK_SECRET=whsec_... \
PORT=3900 \
pnpm --filter @ship/slack-integration dev
```

Or build once and run the bundled artifact (`pnpm build` then `pnpm start`, same env vars).

### 4. Trigger an event

Create a document or reassign an issue in Ship. Within a few seconds (the deliverer's own retry
schedule — `api/src/platform/webhooks/deliverer.ts` — applies on top of this), the configured
Slack channel receives a message. **A screenshot of this step is the AC's evidence artifact** —
it needs a real Slack workspace and a real Ship deployment, neither of which exists in this
sandbox (same class of gap as TRO-503's `terraform plan`: the setup path above is complete and
accurate, but capturing the actual screenshot is a step for whoever runs this demo live, not
something built here).

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token from step 1, needs `chat:write`. |
| `SLACK_CHANNEL_ID` | yes | The channel to post to (the bot must be invited first). |
| `SHIP_WEBHOOK_SECRET` | yes | The `whsec_...` secret from step 2's subscription response. |
| `PORT` | no | Defaults to `3900`. |

## Why `express.raw()`, not `express.json()`

`verifyWebhook`'s HMAC is computed over the exact bytes Ship signed. `express.json()` parses the
body into an object before the route handler ever sees it — the raw bytes are gone, and a
re-serialized JSON body is not guaranteed byte-identical to what was actually signed (key order,
whitespace). `src/server.ts` uses `express.raw({ type: 'application/json' })` and verifies against
the untouched `Buffer` first, only `JSON.parse`-ing after the signature checks out.

## Proof

`src/server.test.ts` (`pnpm --filter @ship/slack-integration test`) — the AC's "e2e with a mocked
Slack API": a real Express mock stands in for `https://slack.com/api`, and the real
`@slack/web-api` `WebClient` (pointed at it via `slackApiUrl`) drives the real receiver through
`supertest`. Covers: a verified `document.created` delivery posts correctly; a verified
`issue.assigned` delivery posts correctly; an invalid signature is rejected 401 and Slack is never
called; a verified delivery of an event type this receiver doesn't act on is silently ignored
(200, Slack never called); a Slack API failure surfaces as a 502 so Ship's own deliverer retry
schedule can handle it rather than this receiver inventing its own.

## Rollback

Delete `integrations/slack/`. Nothing outside this package changes.
