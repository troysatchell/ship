# Ship Browser SDK Demo

Reference integration (PF-802, `PLUGFORGE.MD` §4) proving `@ship/sdk` works as a real browser
dependency: a minimal Vite vanilla-TypeScript SPA that signs in via `authorizationCodeFlow()`
PKCE — **no client secret ever ships to the browser** — and lists the signed-in user's documents
via `client.documents.iterate()`, the SDK's async-iterator pagination.

`@ship/sdk` is the only runtime dependency (`package.json`'s `dependencies`). Everything else
(`vite`, `typescript`) is a dev-only build tool.

## Run it

Requires a running Ship API (`pnpm dev:api` from the repo root, or `pnpm dev`) and a seeded
database (`pnpm db:seed`).

```bash
# 1. Build @ship/sdk once (this package imports its compiled dist/, same as any other consumer)
pnpm --filter @ship/sdk build

# 2. Register a public OAuth app for this demo (idempotent — safe to re-run)
pnpm --filter @ship/browser-demo seed-oauth-app
# → prints VITE_SHIP_CLIENT_ID=ship_app_browser_demo_...

# 3. Start the demo, with the client_id from step 2 and the API's base URL
VITE_SHIP_CLIENT_ID=ship_app_browser_demo_... \
VITE_SHIP_API_BASE_URL=http://localhost:3000 \
pnpm --filter @ship/browser-demo dev
```

Open the printed URL (defaults to `http://localhost:5175`), click **Connect to Ship**, sign in
with any Ship account (e.g. the local dev seed user, `dev@ship.local` / `admin123`), approve the
consent screen, and you land back on the demo listing your documents.

Env vars:

| Var | Required | Meaning |
|---|---|---|
| `VITE_SHIP_CLIENT_ID` | yes | The public `oauth_apps.client_id` from `seed-oauth-app` (or your own `POST /api/oauth-apps` registration with `client_type: "public"`). |
| `VITE_SHIP_API_BASE_URL` | yes | Ship API base URL, e.g. `http://localhost:3000`. |
| `VITE_SHIP_REDIRECT_URI` | no | Defaults to the page's own origin (`window.location.origin + '/'`). Must exactly match one of the app's registered `redirect_uris`. |
| `VITE_SHIP_SCOPE` | no | Defaults to `documents:read`. Space-delimited if more than one. |

## Why localStorage, why PKCE, why no secret

- **PKCE, not a client secret** (`src/main.ts` → `@ship/sdk`'s `ShipClient.authorizationCodeFlow`):
  a public browser bundle cannot keep a secret — anyone can read it out of the network tab or the
  built JS. RFC 7636's code-verifier/code-challenge pair replaces the secret with something
  generated fresh per login and never sent until the one exchange that redeems it.
- **`localStorage`, not `sessionStorage`, for the token** (`src/localStorageTokenStore.ts`): the
  SDK's own `authorizationCodeFlow()` already uses `sessionStorage` internally for the *in-flight*
  PKCE verifier, which only needs to survive one redirect round trip. The *access/refresh token
  pair* this app persists after signing in needs to survive a closed tab — that's what
  `localStorage` is for, and it's this demo's own concern, not the SDK's (the SDK deliberately
  ships no browser `ITokenStore` — see `sdk/src/tokenStore.ts`'s header for why).
- **Refresh is automatic**: once connected, every `client.documents.iterate()` call goes through
  `@ship/sdk`'s shared request pipeline, which transparently refreshes an expired access token via
  the stored refresh token before retrying — no code in this demo handles token expiry directly.

## Proof

`e2e/browser-demo-pkce.spec.ts` (repo root, run via `/e2e-test-runner`) drives a real browser
through this exact SPA — click **Connect to Ship**, sign in, approve consent, land back on the
document list — and asserts the PKCE round trip (button click to a rendered document list) is
under 3 seconds (`PLUGFORGE.MD` §4's stated AC), plus a negative case (wrong `client_id` /
unregistered `redirect_uri` never silently succeeds).

## Rollback

Delete `integrations/browser-demo/`, remove `'integrations/*'` from the root
`pnpm-workspace.yaml`, and delete `e2e/browser-demo-pkce.spec.ts`. Nothing outside this package
and that one spec file changes.
