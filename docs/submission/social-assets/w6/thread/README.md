# W6 X-thread assets (TRO-444 / PF-908)

Eight 1200×675 cards (rendered at 2×) for the thread in `docs/submission/SOCIAL-THREAD-W6.md` —
copy each post from there, attach the image named above it.

| File | Post | What's real in it |
|---|---|---|
| `01-hero.png` | 1 | terminal pane = verbatim `ship webhooks tail` stdout (`raw/tail.txt`) |
| `02-login.png` | 2 | terminal = verbatim `ship login` stdout (`raw/login.txt`); browser = **real** Playwright frame of `/oauth-device-verify` from the same run (`raw/device-verify.png`) |
| `03-verified.png` | 3 | both panes verbatim stdout (`raw/tail.txt`, `raw/create.txt`); 307 ms = the two ISO timestamps |
| `04-signature.png` | 4 | designed; header shape/steps from `sdk/src/verifyWebhook.ts` |
| `05-portal.png` | 5 | **real** portal screenshot after clicking Replay (`raw/portal-replay.png`; toast crop is from the same frame) |
| `06-audit.png` | 6 | **real** portal screenshot, Audit page filtered to the demo CLI app (`raw/portal-audit.png`) |
| `07-ci.png` | 7 | designed; every number from GitHub Actions run 31955603688 |
| `08-close.png` | 8 | designed; SDK size from `node sdk/scripts/measure-size.mjs` |

**Provenance.** All captures were taken 2026-08-16 against Troy's own local `pnpm dev`
(API `:3001`, web `:5174`, DB `ship_standup`) on `main` @ `cf9b4e4b`, using a throwaway public
OAuth app "PlugForge Demo CLI". The terminal windows are drawn HTML; the text inside them is the
CLI's stdout, unedited except that `raw/login.txt`'s credentials path is shown as the default
(`~/.ship/credentials.json`) instead of the scratch `SHIP_CLI_CREDENTIALS_PATH` used during
capture. Browser frames are unretouched Playwright screenshots (2×), cropped in CSS only. The
"Setting up developer session…" hang and the reference listener's browser-barrel import (both
fixed in PR #307) were hit and worked around during capture; the dead-letter row was seeded by
the same SQL the e2e spec uses (`e2e/developer-portal-dlq-replay.spec.ts`), then replayed for real
against a healthy listener — that replay is what the toast and the "attempt 7 / Replayed from" row
show. Not photos: the PNGs are `cards.html` rendered by `render.mjs`.

**Regenerate** (from repo root; needs network once for Google Fonts):
```bash
node docs/submission/social-assets/w6/thread/render.mjs          # all cards
node docs/submission/social-assets/w6/thread/render.mjs 05-portal
```
Edit copy in `cards.html`. Force-add PNGs (`git add -f`) — the repo ignores `*.png`.
