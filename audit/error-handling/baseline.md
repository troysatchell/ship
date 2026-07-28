## Runtime Error & Edge Case — Baseline

**Commit:** `076a183` (dirty: only `audit/`, `memory-bank/`, `.claude/` — no app source) · **Date:** 2026-07-27 · **App:** web `http://localhost:5173`, api `http://localhost:3001` (dedicated probe api on `:3009`) · **Data:** 500 documents / 20 users (per `shipshape.config.yaml`).

### Methodology

Repo Playwright 1.57.0 (Chromium) drove the app logged in as `dev@ship.local`. A dedicated api instance ran on `:3009` with its stdout/stderr tailed to `audit/error-handling/raw/api-3009.log` for the whole session; every probe checked **both** the browser console and that server log. Fault injection was done only at the network/DB layer (Playwright/CDP for offline + Fast 3G + WebSocket route interception + forced 429/500/HTML-404 responses; direct Postgres UPDATE/DELETE for session expiry/revocation). No application source, config, or dependency was modified. Raw per-probe evidence is in `audit/error-handling/raw/probe*.json|txt`; screenshots in `audit/error-handling/screenshots/`.

Probes run (skill probe map): **1** normal-usage console noise (8 flows); **2/2c/2d/2e** network-failure recovery during collaboration (client offline, collab-WS drop, collab server down, WS refused-then-restored); **3** malformed input (UI + direct API curl, incl. XSS/RTL/nullbyte/prototype-pollution); **4** concurrency (simultaneous body edits, simultaneous title edits, delete-while-editing); **5** slow network (Fast 3G walk + typing feedback); **6** mixed faults (429/500 writes, HTML 404, session expiry mid-edit); **7** write-retry count + session revocation on a live socket; **8** comment-mark orphaning (Escape vs blur dismiss). Error-boundary / process-handler coverage measured by static grep.

### Deliverable table

| Metric | Baseline |
|---|---|
| Console errors during normal usage | **0 errors / 0 warnings** across 8 flows (only a benign pre-login `401 GET /api/auth/me`) |
| Unhandled promise rejections (server) | **0** rejections observed — but **3 uncaught-exception process crashes** at boot (Yjs decode; see note) and **no** `process.on('unhandledRejection'/'uncaughtException')` handler exists |
| Network disconnect recovery | **Partial** — full browser-offline recovers cleanly; a collaboration-WS-only outage **Fails** with silent data loss (ERR-1) |
| Missing error boundaries | 2 boundaries exist (`pages/App.tsx:541` around `<Outlet>`, `Editor.tsx:980`); **app shell/sidebars render outside** the Outlet boundary, **login/public routes are unguarded**, there is **no router-root boundary** and **no react-router `errorElement`** |
| Silent failures identified | ERR-1 (lost offline/no-sync edits), ERR-2 (writes after logout), ERR-3 (dropped 429/500 writes), ERR-4 (edits to a deleted doc) |
| Client-only validation gaps | Title length (≤255) & `document_type` enum are enforced **server-side** (good); gaps: invalid uuid/enum → **500** (ERR-5), `limit` param unbounded (ERR-8) |

### What works (verified positives)

- **XSS is not exploitable** via the vectors tested: `<script>`, `"><img onerror>`, RTL, emoji, and null-byte titles are accepted by the API and stored, but render as **inert text** everywhere (docs list, doc page, search results): `probe3-ui.json` → `XSS executed = false` on every surface. React escaping holds.
- **API input validation** rejects empty/oversized/mistyped bodies with clean 400s + zod detail (`probe3-api.txt`): empty title → 400, `title=null` → 400, 100k title → 400 (max 255), bogus `document_type` → 400, `properties` as array → 400.
- **Login form validation** is present client- and server-side (`probe3-ui.json`, `probe3-api.txt`): empty submit stays on `/login` with a required-field error and fires **0** network POSTs; bad email → 'Invalid'; SQLi/oversized creds → 401.
- **Whole-browser-offline editing recovers**: `probe2-client-offline.json` — offline edit survives and re-syncs to the DB without a reload (`FINAL offline edit recovered without reload? true`). The failure in ERR-1 is specific to the *collaboration socket* being unreachable while HTTP is up.
- **Concurrent body edits don't lose data**: `probe4-concurrency.json` 4a — both clients' characters end up in the DB (Yjs CRDT); the two contexts had not converged to an identical view within the sample window (`A==B? false`), which is expected mid-convergence, not data loss. Simultaneous title edits (4b) showed no lost-update inconsistency (both clients and the server agreed on the last write).

### Findings (ranked)

1. **ERR-1 · Critical — Collaboration WebSocket unreachable at load → edits silently lost; indicator falsely reads "Cached"/"Saved".** When `/collaboration` is unreachable but HTTP is alive, the editor keeps accepting edits under a reassuring 'Cached' label, never completes the initial Yjs sync, and loses everything on reload. `probe2-ws-drop`: typed text `inDb=false`, still `false` 20s after the socket healed, `recovered w/o reload? false`. `probe2d`: `inDb=false` through a 60s watch, and after a manual reload the final DB content is `""` — permanent loss, with **no** user-visible warning. Repro + fix in `baseline.json`.
2. **ERR-2 · Critical — Session revocation/expiry is not enforced on live collaboration sockets.** The socket is authenticated once at upgrade (`collaboration/index.ts:659`) and never re-checked. `probe7c`: after deleting all session rows, the WS keeps persisting writes (`true`, and again after 60s); `probe6.4`: after forcing every session expired, the editor still writes to the DB even while REST calls 401. A logged-out/revoked user retains document write access. Security exposure.
3. **ERR-3 · High — Rejected writes (429/500 PATCH) are silently dropped; the sync indicator shows "Saved" over an unsaved value.** `probe6.1/6.2`: forced 429/500 on a rename leave the DB unchanged while the indicator says 'Saved' and the field keeps the unsaved text. `probe7a`: 14 silent retries; a transient 'Failed to update document' toast *does* fire but the persistent indicator still reads 'Saved' — a contradiction users resolve the wrong way.
4. **ERR-4 · High — Editing a document deleted elsewhere continues with no notice; post-delete edits are dropped.** `probe4c`: B deletes the doc (204) while A types; A stays 'Saved' over a ghost editor, the post-delete typing never reaches the (now-gone) row, and A gets no notice — only 404 backlinks console errors.
5. **ERR-5 · Medium — Invalid path/query params return 500 instead of 400/404.** `not-a-uuid`, `not-a-number`, `?type=bogus` all reach Postgres and surface as 500 (`probe3-api.txt`; pg cast errors in the server log). Should validate up front.
6. **ERR-6 · Medium — Comment mark orphaned into content on blur-dismiss.** `probe8` blur variant writes a `<commentMark commentId=…>` into persisted content with **0** backing comment rows; the dangling mark survives reload. The Escape variant is clean.
7. **ERR-7 · Medium — No loading affordance under slow network; no in-flight sync feedback.** Fast 3G: `loadingAffordanceInFirst2s=false` on every flow, main page idle **61s**, and the indicator never leaves 'Saved' while typing. (Main-page latency ties to api-perf API-4.)
8. **ERR-8 · Low — `limit` query param unbounded.** `?limit=-1` and `?limit=999999999` both return the full ~300 KB payload.
9. **ERR-9 · Low — BacklinksPanel console.error storm on every failed fetch** (offline/deleted/expired/revoked), burying real errors during the exact edge cases you'd debug.

**Note — uncaught boot crash (feeds ERR-1's impact, needs a clean repro).** The probe api on `:3009` crashed **fatally and uncaught** at least 3 times (`api-3009.log`), each immediately after `[Collaboration] Loading wiki:ad1094f6-… from yjs_state` with `Error: Unexpected end of array` (lib0 decode) and a `Node.js v23.2.0` process exit. That doc id is the one the client-offline probe (probe2) had just edited. Hypothesis (flagged, not yet isolated to a call site): a persisted `yjs_state` blob that fails to decode can crash the loader instead of being caught. If confirmed in a clean run this is **Critical** — a client-persisted value crashing server startup — and it also widens ERR-1's trigger surface. The `EADDRINUSE :::3009` lines in the same log are separate restart-collision noise from the audit's own server churn, not a product bug.

### Recommended improvement plan

Improvement target: **3 error-handling gaps fixed, at least one a real data-loss/confusion scenario.** Attack, in order:

1. **ERR-1 (data loss)** — make the sync indicator tell the truth: a distinct 'Not syncing / changes not saved' state whenever the collaboration socket has not achieved sync, and block the false 'Saved'. Evidence to reproduce the fix: re-run `probe2-ws-drop` + `probe2d` and show the warning appears and either the edit re-syncs on reconnect or the user is told before reload. **This is the mandatory data-loss fix.**
2. **ERR-2 (security)** — re-validate the session periodically on the live collaboration socket and close it on failure. Re-run `probe7c`/`probe6.4`: post-revocation writes must stop.
3. **ERR-3 (silent write failure)** — drive the sync indicator from the actual mutation result and keep the field dirty until a write confirms. Re-run `probe6.1/6.2/7a`.

Each fix ships with baseline→after repro, before/after behavior, and a screenshot/recording, then the full e2e suite must still pass (error-handling fixes love to break happy paths).
