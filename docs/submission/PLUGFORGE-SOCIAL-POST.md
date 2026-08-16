# PlugForge social post — W6 (PF-908 / TRO-444)

> **X thread (8 posts + 8 images, all under 280 chars): `SOCIAL-THREAD-W6.md`** — that is the
> current deliverable; the single-post variants below are kept as fallbacks. Assets for the thread:
> `social-assets/w6/thread/`.

> Drafts for Troy to personalize and post. Attach
> `docs/submission/social-assets/w6/webhooks-tail-verified.png` — a rendered image of **real**
> `ship webhooks tail` output captured 2026-08-16 against commit `b68da413` (not a photo; the
> lines are verbatim CLI stdout, the window chrome is drawn — see
> `PLUGFORGE-DEMO-SCRIPT.md` → "Provenance"). If your own recording produces a legible frame of
> the same moment, prefer that. No internal hostnames or credentials in either variant; the
> `127.0.0.1:NNNNN` in the image is a local ephemeral port.

## X / Twitter — 276 characters (limit 280)

> Five commands, fresh terminal: install @ship/sdk → ship login → ship webhooks tail → ship docs create → a signed webhook lands, prints ✓ verified. Then replay one from the DLQ in the portal. CI reruns the whole path every push: TTFE < 60 s. Ship is a platform now. @GauntletAI

## LinkedIn / longer variant (~170 words)

> This week the Ship project (a fork of the U.S. Treasury's open-source Ship) became a platform,
> and the demo is five lines in a fresh terminal:
>
> 1. `npm install` the `@ship/sdk` tarball
> 2. `ship login` — RFC 8628 device flow, code + URL, no password ever touches the CLI
> 3. `ship webhooks tail` — starts a local listener and registers a subscription pointing at it
> 4. `ship docs create --title "PlugForge demo"`
> 5. …and the tail prints `✓ verified  <timestamp>  document.created` — an HMAC-signed delivery,
>    checked client-side with the SDK's own `verifyWebhook()`, about a quarter of a second later.
>
> Then the developer portal: every delivery attempt is a row, dead-lettered ones after six retries
> sit in a DLQ view, and **Replay** re-sends with the same idempotency key so subscribers' dedupe
> still holds.
>
> And the part I'm proudest of: a CI job (`drill · TTFE (PF-603)`) re-runs that exact
> install-to-first-event story on every push and fails the build if it takes over 60 seconds or
> any stage blows its budget. The demo is the regression test.
>
> Screenshot: the tail terminal at the moment the signed event arrives. @GauntletAI

## What Troy does (3 lines)

1. Post one variant (X or LinkedIn), tagging **@GauntletAI**.
2. Attach `docs/submission/social-assets/w6/webhooks-tail-verified.png` (or your own frame of the ✓ line).
3. Paste the post's URL into **TRO-444** as a comment and move it to Done.
