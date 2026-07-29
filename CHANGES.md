# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-197 (BUN-1) + TRO-198 (BUN-2) + TRO-199 (BUN-3) + TRO-200 (BUN-4) + TRO-202 (BUN-6) — the app stops shipping as one 2 MB file

Five findings, one root cause: `web/dist/index.html` referenced exactly **one** module script —
2,074.98 kB raw / 588.62 kB gzip — because nothing in the app split at a route boundary. Everything
else followed from that. There was no seam at which to defer the editor (BUN-2), the syntax
grammars (BUN-3) or the emoji picker (BUN-4), and no vendor chunk to cache (BUN-6). They ship as one
branch because fixing any one of them alone moves almost nothing.

**What a user actually downloads now**, by route. This is the static-import closure of the entry
chunk plus that route's chunk — not the `index.html` figure, which code splitting improves by
construction and therefore flatters any change of this kind:

| Route | Before | After | Change |
|---|---:|---:|---:|
| `/login` (unauthenticated first paint) | 601.45 kB gzip | **117.29 kB** | −484.16 (−80.5%) |
| `/docs` (4-panel layout + list) | 601.45 kB gzip | **181.90 kB** | −419.55 (−69.8%) |
| `/documents/:id` (layout + editor) | 601.45 kB gzip | **211.34 kB** | −390.11 (−64.9%) |

The audit's target was 600.75 → ≤ 480.60 kB gzip. Every route clears it. Total emitted bytes are
essentially unchanged (1,762.09 → 1,770.55 kB gzip, +0.5%) — as the audit predicted, this moves
bytes rather than deleting them, and total-bundle size is the wrong yardstick for it.

**Conditions** (all figures): Node v23.2.0, pnpm 10.27.0, `cd web && pnpm build`, gzip level 9,
kB = 1000 bytes, baseline commit `93651cc`. Run `node audit/bundle/measure.mjs web/dist` to
reproduce. **Build from `web/`, not the repo root** — Tailwind's `content` globs resolve against the
CWD, and building from the root silently under-generates the CSS.

**TRO-197 / BUN-1 — route-level code splitting** (`web/src/main.tsx`, `web/src/pages/App.tsx`,
`web/src/components/RouteFallback.tsx`). All 23 page components were statically imported, so a
visitor on `/login` downloaded the admin dashboard, the org chart, the reviews queue and the whole
TipTap/Yjs stack before the login form could paint. Every page is now `React.lazy`; most use named
exports, hence `.then(m => ({ default: m.X }))`. **`LoginPage` deliberately stays static** — it is
the first paint for an unauthenticated visitor, and deferring it would trade one oversized download
for two round trips before the form appears.

Two Suspense boundaries, and the placement is the whole risk: the outer one (in `main.tsx`) covers
the standalone routes and `AppLayout` itself; the inner one sits **inside `<main>` in
`pages/App.tsx`**, so the Icon Rail, Contextual Sidebar and Properties Sidebar stay mounted while a
page chunk loads. A single boundary above `AppLayout` would tear the 4-panel layout down and rebuild
it on every navigation — the flash the audit warned about. Measured on its own: /login −489.11,
/docs −424.58, /documents/:id −71.50 kB gzip.

**TRO-198 / BUN-2 — the editor loads when an editor is shown** (`web/src/components/LazyEditor.tsx`;
consumers `UnifiedEditor.tsx`, `pages/PersonEditor.tsx`). `@tiptap/*` + `prosemirror-*` + `yjs` +
`lib0` + `y-*` + `linkifyjs` are 726.5 kB raw / 208.7 kB gzip and were pulled statically by every
route that *could* show an editor — including project, program and week documents, which render a
tab component and never mount one. `LazyEditor` is **not a second editor**: it is the same shared
`components/Editor` behind a dynamic import, with the prop type derived from it so the contract
cannot drift.

Safe because `Editor` creates its own `Y.Doc`, `WebsocketProvider` and `IndexeddbPersistence` inside
its own effects and neither consumer holds a ref to it — deferring the mount defers the whole
collaboration setup as a unit rather than interleaving it. `initialTitle` is forwarded verbatim, so
the `"Untitled"` placeholder contract is untouched. Measured on its own: **/documents/:id −230.11 kB
gzip**, the largest single win here.

**TRO-199 / BUN-3 — 37 syntax grammars down to 12** (`web/src/components/editor/lowlight.ts`,
`Editor.tsx:12`). `createLowlight(common)` registered arduino, vbnet, objectivec, r, lua, perl,
wasm and 30 others. Kept: **bash, css, diff, javascript, json, markdown, python, shell, sql,
typescript, xml (covers html), yaml**. Verified no seeded document is affected: zero of the 523
documents in the seeded database contain a `codeBlock` node (in `content` or in `yjs_state`), and
neither `api/src/db/seed.ts` nor `welcomeDocument.ts` emits one; the only language named anywhere in
the repo is `javascript`, in `e2e/syntax-highlighting.spec.ts`. A language *not* in the list renders
as plain monospace rather than throwing — `@tiptap/extension-code-block-lowlight` guards on
`lowlight.registered()` — and that third-party behaviour is pinned by a test rather than assumed.
Measured on its own: the grammar chunk drops 52.22 → 22.56 kB gzip (−29.66), and total emitted bytes
fall 29.56 kB. It no longer touches any route's initial payload, because BUN-2 already moved it off.

**TRO-200 / BUN-4 — the emoji picker loads on click** (`web/src/components/EmojiPickerBody.tsx`,
`EmojiPicker.tsx`). `emoji-picker-react` shipped on every page load, `/login` included, for one
consumer: the project-icon `PropertyRow` in `ProjectSidebar`. The package import now lives in its
own module — that, not the `React.lazy` call, is what creates the boundary; naming the package at
value level in `EmojiPicker.tsx` (for its `Theme` enum, say) would pull it all back while the code
still looked correct. The fallback is sized 300×350 so the popover does not resize under the cursor.
Measured on its own: **/documents/:id −63.37 kB gzip**, for a component behind a click.

**TRO-202 / BUN-6 — a vendor split, judged on bytes changed per deploy** (`web/vite.config.ts`).
The config had no `build` key at all, so stable dependency code shared a content hash with volatile
app source. **This does not reduce the initial payload — it costs about 5 kB gzip per route** — and
scoring it on `initialGzipKb` would read as a no-op or a regression. The right measurement is what a
returning user with a warm cache re-downloads after a routine deploy. Editing one string in
`web/src/pages/Login.tsx` and rebuilding:

| Route | Before | BUN-1..4 only | After (with BUN-6) |
|---|---:|---:|---:|
| `/login` | 588.63 kB gzip (97.9% of route) | 99.89 kB (88.9%) | **31.68 kB (27.0%)** |
| `/docs` | 588.63 kB gzip (97.9%) | 164.18 kB (92.8%) | **67.26 kB (37.0%)** |
| `/documents/:id` | 588.63 kB gzip (97.9%) | 193.18 kB (93.7%) | **96.32 kB (45.6%)** |

BUN-6's own contribution is the last column against the middle one: −68.21 kB on `/login`, −96.92 on
`/docs`, −96.86 on `/documents/:id` per deploy, for +4.95 to +5.06 kB on a first visit.

Two rules are encoded in the config and both were found by measuring, not by reasoning. **Never
merge a lazily-reachable package into an eagerly-reachable chunk** — a manual chunk loads as soon as
anything in it is statically reachable, so a catch-all `vendor` would have silently undone BUN-2 and
BUN-4 while the split still existed on disk. And **Rollup's CommonJS interop helpers must be pinned**:
left unassigned they landed in `vendor-highlight`, which every chunk then imported, dragging 22.6 kB
gzip of syntax grammars back into first paint. A `vendor-ui` group for Radix/cmdk/dnd-kit was tried
and **rejected on measurement** — it cost 15.0 kB gzip on `/docs` and `/documents/:id`, because a
route needing one primitive then downloads all of them.

**New dependency:** `highlight.js` is now an explicit dependency of `@ship/web`. It was already in
the tree via `lowlight`, but importing individual grammars from it without declaring it would be a
phantom dependency. No new package entered the lockfile's resolution set.

**Regression tests** (all in `web/src/**`, so `scripts/factory/gate.sh` actually executes them — an
`e2e/` spec satisfies the gate's "test added" check while never running):

- `web/src/main.routes.test.ts` — no page may be statically imported except `Login`; every lazy
  loader names a real export; the child-route Suspense boundary stays inside `<main>`. **Red before
  the fix** (4 assertion failures against `HEAD`'s `main.tsx`/`App.tsx`).
- `web/src/components/editor/lowlight.test.ts` — the grammar list is exactly the curated 12, kept
  languages still produce highlight nodes, dropped ones are absent and degrade rather than throw.
  **Red before the fix** (9 assertion failures against `createLowlight(common)`).
- `web/src/components/EmojiPicker.test.tsx` — picker opens on click, closes on Escape, clears
  through `onChange`, and the package import stays out of `EmojiPicker.tsx`. The last assertion was
  **red before the fix**; the interaction tests are regression guards and passed both ways, which is
  their purpose.
- `web/src/components/LazyEditor.test.tsx` — the editor still mounts, `"Untitled"` is forwarded
  verbatim, `documentId`/`roomPrefix` reach the editor unchanged, and the fallback is the panel
  variant. Regression guards.
- `web/src/components/RouteFallback.test.tsx` — the surrounding 4-panel chrome stays mounted while a
  lazy child resolves. Regression guard for the layout-flash risk.

**Rollback.** Per finding, in decreasing order of risk: revert `LazyEditor.tsx` and repoint
`UnifiedEditor.tsx`/`PersonEditor.tsx` at `@/components/Editor` (BUN-2); delete the `build` key in
`web/vite.config.ts` (BUN-6); restore `createLowlight(common)` in `Editor.tsx` and delete
`components/editor/lowlight.ts` (BUN-3); restore the static `emoji-picker-react` import in
`EmojiPicker.tsx` (BUN-4); replace the `React.lazy` declarations in `main.tsx` with static imports
and drop both Suspense boundaries (BUN-1). BUN-1 must be reverted last — the others depend on the
seam it creates.

**Still open, deliberately.** Vite still prints its >500 kB warning: `vendor-editor` is 577.5 kB raw.
The warning limit was *not* raised — silencing it would remove the only signal in the build about
this class of problem. BUN-5 (245 icon chunks, 209 unreferenced), BUN-7, BUN-8 and BUN-9 are
untouched and remain open.

---

## TRO-188 (ERR-1) + TRO-189 (ERR-2) — the editor stops lying about "Saved", and a revoked session stops writing

Both findings live in the collaboration path and ship as one change: TRO-189 makes the server hang
up on sockets whose session is gone, and TRO-188 makes the editor say so instead of showing
"Saved" over work that is not saved. Fixing one without the other would have produced a *silently*
disconnected editor — a worse version of ERR-1.

**What changed — TRO-189 / ERR-2 (security: logged-out user kept write access).**

The collaboration socket was authenticated exactly once, during the HTTP upgrade
(`api/src/collaboration/index.ts`, `server.on('upgrade')`), and never re-checked. Deleting or
expiring the session left the socket writing to `documents` indefinitely while REST correctly 401'd
(audit `probe7c`, `probe6.4`).

- Each connection now records the `sessionId` that authorized it (`DocConnection` / `EventConnection`).
- `revalidateLiveSessions()` re-checks every session backing a live socket on an interval
  (`DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000`), in **one batched query** for all distinct
  sessions, applying the same two windows as the REST middleware (`SESSION_TIMEOUT_MS`,
  `ABSOLUTE_SESSION_TIMEOUT_MS`). Invalid → the socket is closed with code **4401**.
- It **fails open** on a database error: a transient outage must not disconnect every open editor.
- `closeSocketsForSession()` is called directly from `POST /api/auth/logout` and from the
  session-fixation rotation on login, so logout takes effect at once rather than up to 30s later.
- Connections are marked `revoked` *before* `ws.close()`, and inbound frames from a revoked
  connection are dropped — `close()` only starts the closing handshake, so without this an edit
  already in flight could still be persisted.

Behaviour change to be aware of: a session that has passed the 15-minute inactivity window now
loses its collaboration socket, where before only REST rejected it. Collaboration traffic
deliberately does **not** refresh `last_activity` — doing so would let an open tab keep a session
alive forever, which is a larger hole than the one being closed.

**What changed — TRO-188 / ERR-1 (data loss under a "Saved" label).**

`Editor.tsx` treated the WebSocket `status: connected` event as proof of persistence. It is not:
audit `probe2d-ws-unavailable.json` records **three** `connected` events and **zero** `sync` events,
with the indicator reading "Saved" for 60 s while `inDb=false`, ending in a document whose content
was `""`. `probe2-ws-drop` and `probe2e` show the same lie under the "Cached" label.

- The header indicator moved out of `Editor.tsx` into `web/src/components/editor/SyncStatusIndicator.tsx`
  with the derivation as a pure function (`deriveSyncIndicator`).
- "Saved" now requires `isSynced` — the y-websocket `sync` event, the only evidence the document
  reached the server. `status: connected` no longer sets it, and `sync(false)`/`disconnected`
  clears it.
- The unsynced state renders as **"Not saved"**, red, with a title that names the consequence
  ("changes … will be lost if you reload"). The reassuring "Cached" label is gone.
- A neutral "Connecting" state covers the first connection attempt only, so a normal page load does
  not flash a warning.
- Close code 4401 (TRO-189) stops the reconnect loop and drives the indicator to "Not saved",
  which is how a revoked session becomes visible to the user.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api  exec vitest run src/collaboration/__tests__/session-revocation.test.ts
pnpm --filter @ship/web  exec vitest run src/components/editor/SyncStatusIndicator.test.tsx
scripts/factory/gate.sh
```

The api test drives the real collaboration server over a real WebSocket and asserts on the
`documents` table, not on a mock. It runs with a 200 ms revalidation interval via
`setupCollaboration(server, { sessionRevalidationIntervalMs })`.

**Rollback.** Revert the commits on `fix/err-1-err-2-collab-socket`. Independently:
for TRO-189 alone, delete the `revalidateLiveSessions`/`closeSocketsForSession` block in
`api/src/collaboration/index.ts` and its two call sites in `api/src/routes/auth.ts` — nothing else
depends on them, and `setupCollaboration`'s second argument is optional. For TRO-188 alone, pass a
permanently-true `isSynced` to `SyncStatusIndicator`, which restores the old "connected means
Saved" behaviour.

---

## TRO-172 — [API-1] Rate limiter no longer caps production at 100 req/min per IP

**What changed.** Two halves, server and client.

*Server* — `api/src/middleware/rate-limit.ts` (new) replaces the single `apiLimiter` that lived in
`api/src/app.ts`. `/api/` is now guarded by two chained limiters over the same 60 s window:

| Limiter | Key | Production limit | Purpose |
|---|---|---|---|
| `perSourceIpLimiter` | source IP | 6,000 / min (100 req/s) | anti-flood floor; makes the identity key unspoofable in aggregate |
| `perIdentityLimiter` | `session_id` cookie → `Bearer` token → source IP | 600 / min (10 req/s) | the budget users actually feel |

The old configuration was **100 / min keyed on IP**. Both numbers in it were wrong:

- *Unit.* The ceiling was sized as if one page view were one request. The audit's browser trace
  measured 63 `/api` requests across 8 flows (login 16, dashboard 12, document view 10, sprint
  board 10), so a user exhausted the window after ~6–10 navigations per minute.
- *Key.* With CloudFront → Elastic Beanstalk and `trust proxy 1`, every user behind one agency NAT
  egress resolved to the same IP, so a whole team shared one 100 req/min budget.

600 is justified against the measurement: the worst single-user burst is 16 XHRs × 20 navigations
per minute = 320 req/min, so 600 leaves ~1.9× headroom and still caps one session at 10 req/s.
6,000 accommodates ~187 simultaneously-active users behind one NAT egress at the measured average
of ~32 req/min per active user, while staying far below the 299–4,049 req/s this API was measured
to serve — a single-source flood is still capped. Test (10,000) and dev (1,000) budgets are
unchanged. Session ids and tokens are SHA-256 fingerprinted before use as bucket keys.

*Client* — `web/src/lib/queryClient.ts` now retries HTTP 429 for **queries and mutations** with a
2 s / 8 s / 20 s / 45 s backoff plus additive jitter. The schedule sums to ≥75 s so at least one
attempt lands after the server's 60 s window rolls over; React Query's default 1/2/4 s backoff
would exhaust itself inside the same window. Every other 4xx is still treated as permanent. If the
retries are exhausted the write is genuinely lost, so `MutationErrorToast` now raises a **sticky**
toast (`web/src/components/ui/Toast.tsx` gained `duration: 0` = no auto-dismiss) naming rate
limiting as the cause instead of a generic three-second message.

**Measured, NODE_ENV=production, concurrency 10, `GET /api/documents?type=wiki`, in-process listener:**

| Scenario | Before | After |
|---|---|---|
| 1,000 requests, no session cookie | 100 served / 900 throttled (90%) | 600 served / 400 throttled (40%) |
| 2,000 requests, 20 distinct sessions behind one IP | 100 served / 1,900 throttled (95%) | **2,000 served / 0 throttled** |

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts
pnpm --filter @ship/web test src/lib/queryClient.test.ts src/components/MutationErrorToast.test.tsx
```

**Rollback.** Revert the commits, or by hand: delete `api/src/middleware/rate-limit.ts` and restore
the single `apiLimiter` (`windowMs: 60_000`, `max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100`) plus
`app.use('/api/', apiLimiter)` in `api/src/app.ts`; restore the two inline `retry` predicates in
`web/src/lib/queryClient.ts` and drop `retryDelay`. The `Toast` `duration: 0` support and the
sticky-toast branch in `MutationErrorToast` are additive and safe to leave.

---

## Factory visibility — status command, published board, cost analysis (no ticket: tooling)

**What changed.** Three additions, all reading from sources of truth rather than a status file:

- `scripts/factory/lib/state.mjs` — reconstructs factory state from git worktrees, `.factory-env`,
  `.factory/gate-result.json`, `gh pr list`, `scorecard.jsonl`, and Claude Code session
  transcripts. No state file is written, because one that drifts reads as authoritative while
  being wrong.
- `scripts/factory/status.mjs` — one-screen terminal view. `--json` feeds the board.
- `scripts/factory/board.mjs` — renders a self-contained HTML control panel (cream ground,
  British racing green, severity carried by stripe + wash + text colour, all contrast-measured
  against WCAG AA rather than estimated). Single-theme by choice: both `data-theme` values are
  pinned to the cream tokens so the viewer's toggle cannot flip it.
- `scripts/factory/serve.mjs` — local server that rebuilds the board from live state on every
  request. This is the surface for *operating* the factory: free to refresh, no agent needed.
  The published Artifact can only be updated by an agent calling a tool, so it is for *sharing*
  a milestone, not for watching a run.
- `scripts/factory/cost-report.mjs` — the graded "AI cost analysis" deliverable
  (`projectbrief.md:63`), derived retroactively from transcripts that already record per-message
  token usage.

**Decision: not LangGraph.** The workers are Claude Code sub-agents with their own tool loops in
git worktrees, so a graph framework would orchestrate opaque subprocesses — the interesting
internals are exactly what it cannot see. The durable state (branch, gate result, PR, Linear
ticket) already exists; a checkpointer would duplicate it and then disagree with it.

**How to run it.**

```bash
node scripts/factory/status.mjs
node scripts/factory/board.mjs > audit/factory/board.html   # then republish to the same URL
node scripts/factory/cost-report.mjs > audit/factory/COST_ANALYSIS.md
```

**Rollback.** Remove `scripts/factory/{status,board,cost-report}.mjs`, `scripts/factory/lib/state.mjs`,
and `audit/factory/{board.html,COST_ANALYSIS.md}`. Nothing else depends on them.

---

## TRO-244 — CI pipeline with source-code inventory

**What changed.** Added `.github/workflows/ci.yml`: typecheck, build, and unit tests for both
packages on every PR and every push to `main`, plus a source-code inventory job that emits a
per-SHA manifest (files and lines per package, dependency tree, licenses) as a retained artifact.

Web unit tests run with `continue-on-error` because 13 are known-failing (TEST-1 / TRO-223). The
real gate is the step after them, which compares failure *identities* against
`audit/factory/quarantine.json` and fails only on **new** breakage.

`pnpm lint` is deliberately **not** wired in: finding TS-6 (TRO-211) established there is no
ESLint config anywhere, so the script exits 0 having checked nothing. Adding it would make CI
advertise a quality gate that does not exist.

**How to run it.** Automatic on PR and push to `main`; `workflow_dispatch` for a manual run.
Locally, the same checks are `scripts/factory/gate.sh`.

**Rollback.** Delete `.github/workflows/ci.yml`. Nothing else depends on it.

---

## Factory harness — ticket remediation infrastructure (no ticket: tooling)

> Exempt from this file's ticket-ID join-key rule. This is sprint tooling, not a fix for an audit
> finding, so it has no entry in `AUDIT_REPORT.md` and no Linear ticket to join to. Every *code*
> change below this line does carry its ID.


**What changed.** Added the machinery that drives audit findings to merged fixes:

- `scripts/factory/worktree.sh` — provisions an isolated worktree, a dedicated database, and
  per-ticket ports. Necessary because `api/src/test/setup.ts` TRUNCATEs 16 tables in the
  `beforeAll` of every api test file; agents sharing a database corrupt each other's runs.
- `scripts/factory/gate.sh` — the per-ticket eval: typecheck, build, unit tests vs the quarantine
  baseline, tests-not-weakened, regression-test-present, `CHANGES.md` entry, scope, CodeRabbit
  capture. Writes `.factory/gate-result.json`.
- `scripts/factory/lib/testdiff.mjs` — compares failure identities, not counts. Verified against a
  forged run where one test broke and one was fixed: totals unchanged at 13, gate correctly failed.
- `audit/factory/quarantine.json` — the 13 known-failing web tests, so agent regressions are
  distinguishable from pre-existing red.
- `.coderabbit.yaml` — review configuration with path instructions tied to Ship's conventions.
- `.claude/skills/ship-factory/` — orchestration, agent contract, eval tiers, escalation gates.

**How to run it.**

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
cd ../Ship-wt-tro_178 && source .factory-env
scripts/factory/gate.sh          # --fast for the inner loop
```

**Rollback.** Remove `scripts/factory/`, `audit/factory/`, `.coderabbit.yaml`, and
`.claude/skills/ship-factory/`. Clean up worktrees with `git worktree remove`, and drop the
per-ticket databases (`ship_wt_*`) from the `ship-audit-pg` container.

---

## TRO-243 — Secrets loading hard-failed on any host that is not AWS

**What changed.** `loadProductionSecrets()` fetched from AWS SSM with no error handling under
`NODE_ENV=production` and overwrote `DATABASE_URL`. Off AWS it threw and killed the process before
the database was ever contacted. It now falls back to environment secrets when they are present
and rethrows when they are not. AWS behaviour is unchanged.

**How to run it.** Set `DATABASE_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` in the environment and
start with `NODE_ENV=production`.

**Rollback.** Revert the merge of `fix/ssm-fallback` (`5b72a79`).

---

## TRO-242 — Build the image from source and serve the SPA from the API

**What changed.** Multi-stage `Dockerfile` so the image builds from a clean checkout — the
previous one copied `shared/dist/` and `api/dist/`, both gitignored and untracked, so it only
worked in the build-locally-then-ship AWS flow. Express now serves `web/dist` after all `/api`
routes. Same-origin is required by `sameSite: 'strict'` session cookies and by the collaboration
WebSocket URL being derived from `window.location.host`.

**How to run it.** `docker build -t ship . && docker run -p 3000:3000 ship`, or deploy to Render,
which builds from the repository.

**Rollback.** Revert the merge of `feat/render-deploy` (`bace770`).
