# X thread — PlugForge (Week 6)

> **DRAFT for Troy.** Agent-written; every number is sourced in the table at the bottom and every
> image is either a real capture from your own local Ship (`main` @ `cf9b4e4b`, 2026-08-16) or a
> designed card built around one. Ship is a fork of the U.S. Treasury's public open-source project
> (`github.com/US-Department-of-the-Treasury/ship`). No internal hostnames, account IDs, or
> credentials appear in the thread or the images (the `client_id` visible in one terminal capture is
> a throwaway local OAuth app; the ports are local ephemeral ports).
>
> Assets live in `docs/submission/social-assets/w6/thread/`. The image for each post is named inline.
> Copy each block verbatim — the character counts below are X-weighted (emoji/arrows/✓ count 2).

## The thread (8 posts, all under 280 chars)

**1/8** — 270 chars · 🖼 `01-hero.png`

> week 6: I turned Ship into a platform
> 
> five commands in a fresh terminal → a signed webhook lands and verifies in 307 ms
> 
> OAuth device flow, versioned API, HMAC-signed webhooks, a DLQ you can replay from, and a CI job that reruns all of it on every push
> 
> 🧵 @gauntletai

**2/8** — 254 chars · 🖼 `02-login.png`

> 1. npm install the @ship/sdk tarball
> 2. ship login
> 
> RFC 8628 device flow: the CLI prints a code + URL, you approve in the browser, it polls to a token
> 
> no password ever touches the terminal, and the token carries exactly the scopes it asked for — no more

**3/8** — 251 chars · 🖼 `03-verified.png`

> 3. ship webhooks tail — starts a local listener, registers a subscription pointing at it, holds the signing secret
> 4. ship docs create --title "PlugForge demo"
> 
> created 16:58:57.983Z
> ✓ verified 16:58:58.290Z
> 
> 307 ms. that green line is the whole demo

**4/8** — 257 chars · 🖼 `04-signature.png`

> "verified" isn't decoration
> 
> every delivery carries Ship-Signature: t=…,v1=… — an HMAC-SHA256 over timestamp.rawBody
> 
> the subscriber calls verifyWebhook() from @ship/sdk: 300 s replay window, constant-time compare. flip one byte of the body → ✗ rejected

**5/8** — 266 chars · 🖼 `05-portal.png`

> then the developer portal. every delivery attempt is a row: status, latency, attempt, idempotency key
> 
> six failed retries → parked in a DLQ, not retried forever
> 
> click Replay → a real HTTP round-trip to your target, same idempotency key, so your dedupe still holds

**6/8** — 244 chars · 🖼 `06-audit.png`

> every call through /api/v1 writes an audit row — app, user, scope, latency, request id — queryable in the portal
> 
> that's the receipt I'll need next: proving our own AI agent, rewired onto this same public path, is no longer a privileged insider

**7/8** — 278 chars · 🖼 `07-ci.png`

> the part I'm proudest of: CI reruns the five-line story on every push, from a clean npm install of the SDK tarball
> 
> install to first verified event: 5.0 s (budget 60)
> tamper: rejected
> delivery P95: 975 ms (< 2 s)
> and again vs the container image
> 
> the demo is the regression test

**8/8** — 207 chars · 🖼 `08-close.png`

> stack: Express + Postgres, React, TipTap/Yjs. @ship/sdk is 4.97 kB gzipped, zero runtime deps, size-gated in CI. all open source — a fork of the US Treasury's Ship
> 
> built with Claude Code. thanks @gauntletai


## Assets

| File | Post | Real capture? |
|---|---|---|
| `01-hero.png` | 1 | designed card; the terminal pane is verbatim `ship webhooks tail` stdout |
| `02-login.png` | 2 | designed card; terminal = verbatim `ship login` stdout, browser = **real** Playwright frame of `/oauth-device-verify` from the same run (`raw/device-verify.png`) |
| `03-verified.png` | 3 | designed card; both panes verbatim stdout, same run |
| `04-signature.png` | 4 | designed (header shape + steps from `sdk/src/verifyWebhook.ts`) |
| `05-portal.png` | 5 | **real** portal screenshot (`raw/portal-replay.png`) inside a drawn browser frame |
| `06-audit.png` | 6 | **real** portal screenshot (`raw/portal-audit.png`) inside a drawn browser frame |
| `07-ci.png` | 7 | designed; every number copied from GitHub Actions run `31955603688` |
| `08-close.png` | 8 | designed |

"Designed" cards are HTML (`cards.html`) rendered by Playwright at 2× (`render.mjs`) — the
terminal windows are drawn, the text inside them is real stdout (see `raw/*.txt`).

## Sources for every number

| Post | Claim | Source |
|---|---|---|
| 1, 3 | 307 ms created → verified | `raw/create.txt` `created_at: 2026-08-16T16:58:57.983Z` vs `raw/tail.txt` `✓ verified 2026-08-16T16:58:58.290Z` — one real run against local `main` @ `cf9b4e4b` |
| 2 | RFC 8628 device flow, code + URL, polls to token, scopes exact | `raw/login.txt` (verbatim); `api/src/routes/oauth-device.ts`; `integrations/cli/src/commands/login.ts` |
| 3 | tail registers its own subscription, cleans up on Ctrl+C | `raw/tail.txt`; `integrations/cli/src/commands/webhooksTail.ts` |
| 4 | `Ship-Signature: t=…,v1=…`, HMAC-SHA256 over `${t}.${rawBody}`, 300 s tolerance, `timingSafeEqual` | `sdk/src/verifyWebhook.ts` header + `DEFAULT_WEBHOOK_TOLERANCE_SECONDS`; delivery headers in `api/src/platform/webhooks/deliverer.ts` |
| 4, 7 | tamper → rejected | `scripts/drill/ttfe.ts` stage 7 `tamper_reject` (one flipped byte, asserts `verifyWebhook()` false); CI run 31955603688 `tamper_reject: 1ms` |
| 5 | one row per attempt; 6 attempts then DLQ; Replay = real HTTP round-trip, same idempotency key | `api/src/platform/webhooks/deliverer.ts` (`MAX_ATTEMPTS = 6`, schedule 1s/4s/16s/1m/5m + jitter); `e2e/developer-portal-dlq-replay.spec.ts`; `web/src/pages/DeveloperPortal.tsx` |
| 6 | audit row per `/api/v1` call — app, user, scope, latency, request id | `api/src/platform/api/v1/resources/audit.ts`; `web/src/pages/DeveloperAudit.tsx` (TRO-616) |
| 7 | 5.0 s total / 60 s budget; P95 975 ms over 20; image-mode 4.9 s | GitHub Actions run `31955603688`, jobs `95187181592` (`drill · TTFE (PF-603)`: `total: 5039ms / 60000ms budget`, `delivery_p95_ms: 975ms over 20 deliveries (target < 2000ms)`, `verdict: pass`) and `95187329714` (`drill · TTFE image-mode (TRO-621)`: `total: 4901ms`, P95 `974ms`) — commit `2be3d1ef`, the PR #300 tip; `scripts/drill` unchanged since |
| 8 | 4.97 kB gzipped, 0 runtime deps, size gate | `node sdk/scripts/measure-size.mjs` → `gzipKb: 4.97, thresholdKb: 250, pass: true` (2026-08-16); `sdk/package.json` `dependencies: {}`; `sdk/src/__tests__/sizeGate.test.ts` |
| 8 | Treasury fork, open source | repo README |

## Before you post

- **Post 6 promises future work** ("proving our own AI agent … is no longer a privileged insider") — Epic 7's rewire proof exists (`docs/submission/PLUGFORGE-EPIC-WRITEUPS.md`, TRO-440/PF-704) but the thread doesn't show it. Fine as a forward-looking line; don't let a reply pull you into claiming it's demoed here.
- **"week 6"** — say the week however you count it; nothing in the images asserts a total.
- The `@ship/sdk` package is **not on npm** — the demo installs a local tarball (the CI drill does the same). If anyone asks, say so.
- The Render deployment's running commit was **not** verified for this thread; every capture is local.

## Regenerating

```bash
# cards (needs network once for Google Fonts)
node docs/submission/social-assets/w6/thread/render.mjs            # all
node docs/submission/social-assets/w6/thread/render.mjs 07-ci      # one
```
Copy lives in `cards.html`; raw captures in `raw/`. Character counts: any X-weighted counter — the
numbers above came from a tiny script (emoji/arrows/✓ = 2, URLs = 23).
