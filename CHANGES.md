# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-174 — [API-3] No response compression anywhere; the largest list payload shipped 15× larger than needed

**What was broken.** `api/src/app.ts` never registered any compression middleware, and
`compression` was not a dependency of `api/package.json`. Every JSON response went out
uncompressed even when the client explicitly advertised `Accept-Encoding: gzip`. `GET /api/issues`
was the worst case at **379,907 bytes**. On a 10 Mbps agency link that body alone is ~304 ms of
transfer time, paid by every user on every list load. The gap is invisible in local development
and in the api-perf benchmark because loopback transfer is effectively free — it only costs users
on a real WAN link.

**What changed.** `compression` is registered as the first middleware in `createApp()`, ahead of
every route, so all response bodies pass through it: API JSON, the Swagger UI, and the static SPA
on single-origin deployments.

Settings, and why:

- **`threshold: 1024`** — the library default, written out explicitly to document it. Below roughly
  one MTU there is nothing to win; gzip framing plus the CPU makes a small body marginally larger
  and slower. `/health` (15 bytes) is correctly left alone.
- **Compression level: zlib's default (6), not 9.** Measured on the real 379,907-byte body, level 9
  yields 24,091 bytes against level 6's 25,050 — **3.8% smaller for materially more CPU per
  response**, on a path that runs on every list request. Note this means the honest ratio is
  **15.17×**, not the 15.4× the audit projected from `gzip -9`.
- **Filter delegates to `compression.filter`**, which consults `mime-db` and so already declines
  already-compressed types — the images, PDFs and archives served by `/api/files/:id` keep their own
  encoding rather than being wastefully re-compressed. Three additions on top:
  - the conventional `x-no-compression` request opt-out;
  - a `text/event-stream` guard. There is no SSE endpoint in this codebase today (verified by grep
    for `text/event-stream` and `flushHeaders`, 2026-07-29); the guard is there because compression
    buffers, which would silently stall the first SSE endpoint someone adds. Note mime-db would
    happily compress `text/*`, so this guard is doing real work rather than restating the default.
  - an `application/octet-stream` guard. mime-db reports octet-stream as **compressible**, but it is
    the "unknown binary" fallback, and the one route that emits it is `GET /api/files/:id`, which
    echoes a client-declared `mime_type` verbatim (`files.ts:309`) for an upload validated only
    against a filename extension blocklist (`files.ts:80-84` — any mime string is accepted).
    Speculatively gzipping an arbitrary, likely already-compressed user binary on every download
    costs CPU for no benefit.

  The Yjs collaboration WebSocket is unaffected — `ws` handles the upgrade off the HTTP response
  path, so this middleware never sees it.

  Filter behaviour was verified by hand against a real HTTP server using the exact filter from
  `app.ts`, across 22 content types. Compressed: `application/json`, `text/html`,
  `application/javascript`, `text/css`, `text/csv`, `text/plain`, `application/xml`,
  `image/svg+xml`. Passed through: `image/png`, `image/jpeg`, `image/webp`, `application/pdf`,
  `application/zip`, `application/gzip`, `application/x-7z-compressed`, `video/mp4`, the four
  Office formats (docx/xlsx/doc/xls), plus the two guarded types above. **This content-type matrix
  is manual verification, not automated coverage** — the regression test covers the JSON list-payload
  behaviour that the finding is about, not every mime type.

**⚠️ DO NOT "DISPROVE" THIS FIX WITH A LOCALHOST BENCHMARK.** Enabling gzip does **not** reduce P95
over loopback and may raise it slightly. Localhost transfer time is ~0, so the only thing a local
benchmark can measure is the compression CPU that was added. A compare-mode `/api-perf-audit` run
against `audit-baseline` will therefore show this fix as **flat or marginally worse**, and that
result is not evidence against it. This is a bytes-on-the-wire fix: validate it by **payload size**,
or over a **bandwidth-shaped link**. This is standing rule 13 in the factory lessons, and it exists
because of this exact finding.

**Evidence — payload bytes, not loopback timing.** Local Express server (`tsx api/src/index.ts`,
port 3154, `NODE_ENV` unset i.e. development) against PostgreSQL 15 in Docker `ship-audit-pg` on
`:5433`, database `ship_wt_tro_174`, seeded with `pnpm db:seed` followed by `audit/seed-augment.ts`
to the volumes in `audit/shipshape.config.yaml` — 500 documents (254 of them issues) / 20 users.
Bytes counted by `curl -w '%{size_download}'`, which does not decompress when `Accept-Encoding` is
set by hand. The "before" column is the same server answering `Accept-Encoding: identity`; that is
byte-for-byte what the pre-fix code returned regardless of request headers, and it is independently
confirmed by the `x-no-compression` opt-out returning the identical 379,907.

| endpoint | before (identity) | after (gzip, level 6) | reduction |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | **25,050 B** | **15.17× / −93.4%** |
| `GET /api/documents` | 293,822 B | **28,227 B** | 10.41× / −90.4% |
| `GET /api/openapi.json` | — | 18,039 B | compressed |
| `GET /health` (15 B) | 15 B | 15 B | under threshold, untouched |

The 379,907-byte "before" figure reproduces `audit/AUDIT_REPORT.md`'s number **exactly**, which
confirms the dataset here is byte-identical to the one the finding was measured against.

Transfer time at 10 Mbps is **derived arithmetic from those measured byte counts, not an observed
WAN measurement**: 379,907 B → ~304 ms, 25,050 B → ~20 ms, a saving of ~284 ms per issue-list load.

**Interaction with TRO-173/TRO-182 — do not double-count.** That branch removes `content` from the
`/api/issues` list projection, shrinking the same payload. Measured on the identity body from this
branch, the `content` field is **36.5%** of those 379,907 bytes. The two fixes compose, and the
honest attribution is:

| | identity | gzip level 6 | compression's own factor |
|---|---|---|---|
| this branch (`content` present) | 379,907 B | 25,050 B | **15.17×** |
| after TRO-173 (`content` stripped) | 241,338 B | 19,894 B | **12.13×** |

So compression alone is worth 15.17× today and still 12.13× once TRO-173 lands; the *combined*
379,907 → 19,894 is **19.10×** and belongs to both tickets, not to either one. Neither ticket
should claim it alone.

**CloudFront in the deployed stack — does it already do this?** Partly answered from config, and
the answer is "no, and the win is not double-counted" — but the deployed-stack half is **derived
from Terraform, not observed against the live distribution**.

*Observed in the repo:* the `/api/*` cache behaviour does set `compress = true`
(`terraform/s3-cloudfront.tf:154`, `terraform/modules/cloudfront-s3/main.tf:172`), and all three
environments (dev/prod/shadow) use `modules/cloudfront-s3`. But that behaviour attaches
`aws_cloudfront_cache_policy.api_no_cache`, whose
`parameters_in_cache_key_and_forwarded_to_origin` block sets `header_behavior = "none"` and sets
**neither `enable_accept_encoding_gzip` nor `enable_accept_encoding_brotli`** — a repo-wide grep for
`enable_accept_encoding` returns no matches at all.

*Derived from AWS's documented behaviour:* CloudFront automatic compression requires the attached
cache policy to enable Accept-Encoding gzip/Brotli support; with both unset (Terraform default
`false`), `compress = true` is inert. So `/api/*` was very likely **not** being compressed at the
edge, and the 15.17× measured here is a real production win rather than a re-count of something
CloudFront was already doing. The fix is also robust either way: the origin request policy uses
`header_behavior = "allViewerAndWhitelistCloudFront"`, so the viewer's `Accept-Encoding` does reach
Express, and CloudFront relays an origin response that already carries `Content-Encoding: gzip`
without re-compressing it.

*Unverified:* no `curl` was run against `https://ship.awsdev.treasury.gov` to observe an actual
`Content-Encoding` header on a deployed response. The deployed-stack claim above rests on config
plus documented behaviour only.

**Regression test.** `api/src/routes/compression.test.ts` — three cases, in a vitest file the gate
actually executes (an `e2e/*.spec.ts` would satisfy the gate's added-test grep while never running).
It asserts `Content-Encoding: gzip` appears on `/api/issues` when the client advertises gzip, does
**not** appear when the client sends `Accept-Encoding: identity`, and does not appear on a
sub-threshold response. It also asserts the decoded body is intact, because a `Content-Encoding`
header over a corrupted body would otherwise read as a pass.

One deliberate design choice: the negative case additionally asserts the uncompressed
`Content-Length` **exceeds** the 1024-byte threshold, with an actionable failure message. If a
future payload reduction takes `/api/issues` under the threshold, the gzip assertion would start
passing for the wrong reason — nothing to compress rather than compression working. The test fails
loudly instead. The seeded payload is padded via long **titles**, not `content`, precisely so
TRO-173 removing `content` cannot make it vacuous.

Confirmed red first: with the middleware absent the gzip case failed with
`AssertionError: expected undefined to be 'gzip'` at the `content-encoding` assertion — the right
reason, not an import or setup error — while the other two cases passed.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/compression.test.ts

# Reproduce the payload measurement (NOT a latency benchmark — see the warning above).
pnpm --filter @ship/api db:seed && api/node_modules/.bin/tsx audit/seed-augment.ts
PORT=3154 api/node_modules/.bin/tsx api/src/index.ts &
# then, with a valid session cookie for a seeded user:
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: identity' \
  http://localhost:3154/api/issues -w 'identity=%{size_download}\n'
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: gzip' \
  http://localhost:3154/api/issues -w 'gzip=%{size_download}\n'
```

Setting `Accept-Encoding` by hand matters: `curl --compressed` would decompress transparently and
report the identity size for both, hiding the entire effect.

**Rollback.** Delete the `app.use(compression({...}))` block and the `import compression` line from
`api/src/app.ts`; optionally drop `compression` and `@types/compression` from `api/package.json`.
Deleting `api/src/routes/compression.test.ts` reverts the test. No schema, route, or API-contract
change; nothing to migrate.

**Found, not fixed.** The inert `compress = true` on the `/api/*` CloudFront behaviour is a latent
config inconsistency worth its own ticket: enabling `enable_accept_encoding_gzip` on the
`api_no_cache` cache policy would make the edge setting mean what it appears to mean. It is a
Terraform change, out of scope here, and origin-side compression is the more robust fix anyway
because it also covers single-origin deployments and direct-to-Elastic-Beanstalk access, which do
not pass through CloudFront at all.

---

## TRO-215 — [A11Y-1] Navigation sidebars claimed `role="tree"` without a tree keyboard model

**What was broken.** `web/src/pages/App.tsx:637` declared
`<ul role="tree" aria-label="Workspace documents">`, which tells assistive technology "this is a
composite widget, enter interaction mode and navigate with arrow keys." Nothing implemented that
contract: no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`/`aria-posinset`
anywhere in `DocumentTreeItem.tsx` or `App.tsx`. The same pattern appeared in four more places.
Because `role="tree"` also overrides the `<ul>`'s list role, the two bare `<li>` children of that
list — the empty state and the "N more..." overflow link — became roleless orphans, producing axe
**Critical `aria-required-children`** plus **Serious `listitem`**.

**What changed.** Subtraction. `role="tree"`, `role="treeitem"` and `role="group"` are gone from
the document/context/project navigation sidebars, along with `aria-expanded`/`aria-selected` on
the `<li>` elements. The native `<ul>`/`<li>`/`<a>` structure is unchanged and needs no ARIA.

- `web/src/pages/App.tsx` — workspace + private document lists, the local `DocumentTreeItem`, and
  the projects list. `DocumentsTree` is now exported as a unit-test seam.
- `web/src/components/DocumentTreeItem.tsx` — the shared item used by the /docs tree view.
- `web/src/pages/Documents.tsx` — the container for the above; it had to move with the items,
  because a `role="tree"` whose children stop being treeitems is a *new* Critical.
- `web/src/components/ContextTreeNav.tsx`, `web/src/components/sidebars/ProjectContextSidebar.tsx`.

State that used to live on the `<li>` moved to where it is valid ARIA: `aria-expanded` is now on
the expand/collapse `<button>`s, and the active document was already marked with
`aria-current="page"` on its `<a>`.

**One behaviour change, from PR review.** Moving `aria-expanded` onto the buttons exposed that the
person row in `ProjectContextSidebar` was a `<button aria-expanded="false">` even for a person with
**no weeks** — controlling nothing, and with a provably no-op click (`togglePerson` writes
`expandedPeople`, read only by `isExpanded && hasWeeks`). That row is now a plain `<div>`: still
readable, no longer a phantom tab stop. People *with* weeks are unchanged — chevron, week count,
working `aria-expanded`. Reverting restores the focusable no-op button.

**Deliberately kept.** `aria-live="polite"` on the two document lists. It is the WCAG 4.1.3
mechanism for announcing create/delete and is asserted by
`e2e/accessibility-remediation.spec.ts` ("document tree updates are announced"). Whether it is
too verbose on expand/collapse is a screen-reader question, and removing it on a prediction is
the exact error A11Y-1 itself was — see the follow-up note below.

**Out of scope, deliberately.** `web/src/pages/OrgChartPage.tsx` keeps `role="tree"`: it is the
one real tree widget in the codebase (roving `tabIndex` at `:664`, `onKeyDown` at `:462`).

**Evidence.** axe-core 4.11 via `@axe-core/playwright`, Chromium 1223 headless, 1440×900, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, logged in as `dev@ship.local` against a locally
seeded database. Counts are Critical/Serious/Moderate/minor.

| page | before | after |
|---|---|---|
| `/docs` | **C1 S1** M0 m0 — `aria-required-children`, `listitem` | **C0 S0** M0 m0 |
| `/documents/:id` | **C2 S1** M1 m0 | **C1 S0** M1 m0 |
| `/issues` | C0 S0 M0 m1 | C0 S0 M0 m1 |

The Critical remaining on the document view is `aria-allowed-attr` on the editor `<div>` — that is
**A11Y-2**, a separate finding, untouched here.

**Reproduction precondition (worth knowing).** The violation is data-dependent: it only fires when
a sidebar section has **more than `SIDEBAR_ITEM_LIMIT` (10)** root documents, which renders the
bare `<li>` "N more..." overflow link, or **zero**, which renders the bare `<li>` empty state. A
freshly seeded database has 5 and shows **no** violation. The audit environment had more than 10.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 5 new specs, 26 assertions, all green
pnpm type-check
```

**Rollback.** `git revert` the commits on `fix/a11y-1-sidebar-aria`, or by hand: restore the five
`role="tree"`/`role="treeitem"` sites listed above, and restore the person row in
`ProjectContextSidebar.tsx` to a single `<button>` for both the has-weeks and no-weeks cases. The
five new `*.test.tsx` files fail if either comes back, which is the point.

**Still owed — do not mark this fully verified.** Nobody has listened to it. A human found on
2026-07-28 that VoiceOver did not announce the document titles *at all* under the old markup;
this change makes the DOM use native list semantics and axe agrees, but **no screen-reader pass
has been run on the fixed build.** That verification, plus a judgement on the retained
`aria-live`, is outstanding.

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
