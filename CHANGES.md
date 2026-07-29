# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-240 — [DB-11] The application's database pool negotiated no TLS while migrate and seed did

**What was broken.** Three pools connect to Ship's database with three different SSL policies.
`api/src/db/migrate.ts:32` and `api/src/db/seed.ts:44` each carried their own copy of
`ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false`.
`api/src/db/client.ts:17-26` — the pool the entire running application uses — had **no `ssl` key at
all**. A fourth pool, `api/src/db/scripts/orphan-diagnostic.ts:34`, had none either.

An absent `ssl` key is not "let pg decide sensibly". `pg`'s `ConnectionParameters` does
`this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`, and
with `PGSSLMODE` unset that resolves to `defaults.ssl`, which is `false`
(`pg/lib/connection-parameters.js:100`, `pg/lib/defaults.js:43`). So the app pool connected in
**plaintext**, unconditionally, in production.

**Why it never surfaced on AWS.** Aurora is in-VPC and the connection is internal, so plaintext
works. The gap only appears against a managed Postgres that requires TLS on a public endpoint —
i.e. every PaaS, including the Render deployment.

**Why the failure signature misdirects.** `Dockerfile:35` is
`node dist/db/migrate.js && node dist/index.js`. `migrate.ts` *did* configure SSL, so it connected,
ran, exited 0, and the `&&` proceeded — then `index.js` started and `client.ts` failed to connect.
The logs read "migration succeeded, database unreachable", which looks like a database problem
rather than a client-config one. `connectionTimeoutMillis: 2000` turned it into a fast crash-loop
instead of a legible TLS error.

**What changed.** The drift was the defect, so the fix is one decision in one place rather than a
fourth copy of the ternary. New `api/src/db/ssl.ts` exports `resolveDatabaseSsl(nodeEnv?)`, and all
four pools under `api/src/db/` now call it:

- `api/src/db/client.ts:23` — **the actual bug**; previously passed nothing.
- `api/src/db/migrate.ts:33`, `api/src/db/seed.ts:45` — inline ternary replaced by the helper.
- `api/src/db/scripts/orphan-diagnostic.ts:37` — previously passed nothing; same defect class.

The returned value is unchanged from what the scripts already did: `{ rejectUnauthorized: false }`
in production, `false` otherwise. A fresh object per call, so no two pools share a mutable TLS
config. `nodeEnv` is a parameter defaulting to `process.env.NODE_ENV` purely so the decision is
testable without env stubbing; production code calls it with no arguments.

**Behaviour outside production is byte-for-byte identical.** Local dev, CI and the factory
databases previously got `false` by pg's default and now get `false` by explicit decision.

**`rejectUnauthorized: false` was carried over deliberately, not endorsed.** It encrypts the
connection but does not verify the server certificate chain — it stops passive eavesdropping, not an
active man-in-the-middle. Managed providers sign with their own CA, absent from Node's trust store,
so verification fails without the provider bundle. A federal deployment probably wants
`rejectUnauthorized: true` plus an explicit `ca`. Tightening it here would be a silent posture
change that no test in this repo can verify, so it is left as a follow-up that needs the CA bundle
decided first. This is called out in the header comment of `api/src/db/ssl.ts`.

**Precedence — the helper is not the only input, and not the strongest.** There is a third SSL
surface besides these pools and the helper: the connection string. Raised by CodeRabbit, then
established by reading pg rather than inferring it from the finding above, and confirmed empirically
against pg 8.16.3 / pg-connection-string 2.9.1.

`pg/lib/connection-parameters.js:56` does
`config = Object.assign({}, config, parse(config.connectionString))` — the parsed URL is the **last**
source, so its `ssl` key overwrites the caller's; the comment on `:54` says so outright.
`pg-connection-string/index.js:76` sets `ssl = {}` whenever `sslmode` is present, and `:133-135` sets
`ssl = false` for `disable`. `connection-parameters.js:81` then uses that value as-is.

Effective order, weakest to strongest: **pg defaults → `PGSSLMODE` → the `ssl` option this helper
returns → `sslmode` in the connection string.**

Measured, passing an explicit `{ rejectUnauthorized: false }` throughout:

| `sslmode` in URL | effective `ssl` | on the wire |
|---|---|---|
| absent | `{ rejectUnauthorized: false }` | encrypted — our option survives |
| `disable` | `false` | **plaintext — our option is discarded** |
| `prefer` / `require` / `verify-ca` / `verify-full` | `{}` | encrypted |
| `no-verify` | `{ rejectUnauthorized: false }` | encrypted |

So `DATABASE_URL=...?sslmode=disable` silently defeated the fix, in exactly the way these strings
arrive — copied from a provider dashboard. The helper would report the right value, every test would
pass, and production would be in the clear.

The `ssl` option can never win that argument, so `resolveDatabaseSsl` **refuses to start** instead:
in production, an `sslmode` that pg resolves to plaintext throws with the parameter named and the
remedy stated. `disable` is the only such value — the other five all encrypt, and are allowed
through untouched. Outside production `sslmode=disable` is still fine, because local Postgres and
the CI container are plaintext-only.

It deliberately does **not** rewrite the URL. Silently editing an operator's explicit instruction is
the same class of mistake as the original bug: the code would report one thing and do another.

Note in passing: `sslmode=require` resolves to `{}`, which leaves Node's `rejectUnauthorized` at
`true` — stricter than this helper, and it will **fail** against a provider using a private CA. That
is a loud connection error rather than a silent downgrade, so it is left alone.

**Deployment precondition — check this before rolling out.** If the production `DATABASE_URL` in SSM
already contains `sslmode=disable`, this turns a currently-working in-VPC deploy into a startup
failure with the message above. The value lives in SSM and could not be inspected from here, so this
is stated as a risk, not a cleared check. If plaintext is genuinely intended for that deployment,
that is a decision for a human to make explicitly.

**Out of scope, deliberately.** `api/scripts/migrate-shadow.ts:32`, `api/scripts/create-test-user.ts:35`
and `api/scripts/check-db-user.ts:10,19` set `ssl: { rejectUnauthorized: false }`
**unconditionally** — a fifth and sixth policy. They are operator scripts outside
`api/tsconfig.json`'s `include: ["src/**/*"]`, always pointed at a remote AWS endpoint. Routing them
through a `NODE_ENV`-conditional helper would silently **downgrade** them to plaintext whenever
`NODE_ENV` is unset, which is how they are normally invoked. Changing them needs its own ticket and
its own verification.

**Evidence.** `pnpm --filter @ship/api test` against
`postgresql://ship:***@localhost:5433/ship_wt_tro_240` (docker `ship-audit-pg`, postgres:15-alpine),
`NODE_ENV` unset in the shell so vitest sets `test`. 31 files, **491 passed, 0 failed**.
`pnpm --filter @ship/web test`: 13 failed / 186 passed — the same 13 identities quarantined as
TEST-1 / TRO-223, in the same three files; nothing in `web/` was touched. `pnpm type-check` clean
across shared, api and web.

The regression test is `api/src/db/__tests__/ssl.test.ts` (22 cases), covering four things:

1. the decision per `NODE_ENV`, including that `production` is matched exactly, so a deploy setting
   `NODE_ENV=Production` cannot silently drop to plaintext;
2. that `client.ts`'s pool actually applies it — re-imported under a stubbed env, since the pool is
   built at module scope. **7 failed / 8 passed** against the unfixed call sites, every failure an
   `AssertionError` on the claimed behaviour, the headline being
   `expected undefined to deeply equal { rejectUnauthorized: false }` — DB-11 stated as a test;
3. the precedence above: two tests **characterise pg itself**, pinning that `sslmode=disable`
   discards the explicit option and that the other five values do not. If a future pg makes the
   option win, those tests fail, which is the signal the throw can be relaxed. Then the guard:
   **2 failed / 6 passed** against the unguarded helper, both `expected [Function] to throw an
   error`. Only two of the eight went red on purpose — the other six assert behaviour that must
   *not* change (dev still permits `sslmode=disable`, encrypting modes still pass, a malformed URL
   is still pg's to report);
4. that **no** pool under `api/src/db/` sets `ssl` to anything other than `resolveDatabaseSsl()`.
   This is what prevents recurrence — a future file adding `new Pool(...)` with its own policy fails
   the suite rather than quietly adding a fifth policy.

Beyond the suite, the **compiled** artifact was exercised directly, since `Dockerfile:35` runs
`dist/`, not the TypeScript: `NODE_ENV=production` with a clean URL yields
`{"rejectUnauthorized":false}`; with `?sslmode=disable` importing `dist/db/client.js` throws the
guard message; `NODE_ENV=development` with `?sslmode=disable` still yields `false`.

**How to run it.**

```bash
source .factory-env                                             # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test src/db/__tests__/ssl.test.ts       # 22 cases, the regression test
pnpm --filter @ship/api test                                    # full api suite: 491/491
pnpm type-check

# the guard, on the compiled artifact (throws; prints the remedy)
pnpm --filter @ship/api build
cd api && NODE_ENV=production DATABASE_URL='postgresql://u:p@h:5432/d?sslmode=disable' \
  node -e "import('./dist/db/client.js').catch(e => console.log(e.message))"
```

**Rollback.** `git revert` the commits on `fix/db-11-pool-ssl`, or by hand: delete
`api/src/db/ssl.ts` and `api/src/db/__tests__/ssl.test.ts`, drop the `ssl:` line and the import from
`client.ts` and `scripts/orphan-diagnostic.ts`, and restore the inline ternary in `migrate.ts` and
`seed.ts`. Reverting reinstates plaintext connections from the application pool. To keep the fix but
drop only the startup guard, delete the `PLAINTEXT_SSL_MODES` check in `resolveDatabaseSsl` — that
restores the state where `sslmode=disable` in `DATABASE_URL` silently wins.

**Not verified — do not read this as a fixed deployment.** No test here proves TLS actually
negotiates. Proving that needs a managed Postgres endpoint that *requires* TLS on a public address;
there is none in this repo's test environment, and the local docker Postgres speaks plaintext only,
so a passing local suite is silent on the real failure mode. What is verified is the decision logic
and its propagation to all four call sites — everything up to the socket. The claim "Render now
starts" remains **untested**; confirming it means deploying and reading the startup logs.

---

## TRO-217 — [A11Y-3] `/my-week` failed colour contrast, the landing page of the app

**What was broken.** `/` redirects to `/my-week`, and it was the only key page Lighthouse failed on
accessibility: **95**, one failing audit, `color-contrast`. axe reported it **Serious** on 18 nodes
(24 in the audit baseline; the count tracks how many future standup rows the current week still
has, so it moves with the weekday).

The finding named two causes. There were **three**, and one of the two named was misattributed:

| Cause | Nodes | Resolved colour | Ratio |
|---|---|---|---|
| `opacity-40` on future standup rows (`MyWeekPage.tsx:339`) | 12 | `#3f3f3f` on `#0d0d0d` | **1.84:1** |
| `text-muted/50` on the 11px plan/retro ordinals | 4 | `#4c4c4c` on `#0d0d0d` | **2.26:1** |
| `text-accent` used as a *foreground* colour | 2 | `#005ea2` on `#0a1d2b` / `#0c1114` | **2.55:1** / 2.82:1 |

The dominant cause — two thirds of the nodes — was `opacity-40`, which the finding never mentioned.
And `bg-accent/20`, which the finding did blame, is not the defect: `accent` (`#005ea2`) is
**2.89:1 as text on the page background before any badge is involved**; the translucent fill only
takes it from 2.89 to 2.55. The fill was fine. Using a fill colour as text was not.

A **fourth** pair, in neither the finding nor either axe run: the "Unsubmitted" badge puts
`text-muted` on a `bg-border` fill at **4.38:1**. It renders only when a plan or retro has content,
is unsubmitted, and is not yet due — a state neither scan happened to hit. It is not a guess: axe
recorded that identical pair on the command palette's `esc` key
(`audit/a11y/axe/command_palette_open.json`).

**What changed.**

- `web/tailwind.config.js` — added `accent-text: #2491ff` (USWDS blue-40v, verified against
  `@uswds/uswds/.../tokens/color/_blue.scss`): **6.08:1** on `background`, 5.37:1 on a
  `bg-accent/20` badge, 5.94:1 on `bg-accent/5`. `accent` itself is **unchanged**, so every
  `bg-accent` fill in the app looks exactly as it did. blue-50v (`#0076d6`) was tried and rejected —
  4.22:1, still failing. Also corrected the `muted` comment, which claimed 5.1:1 where the
  arithmetic gives 5.63:1, and recorded the `bg-border` caveat next to it.
- `web/src/pages/MyWeekPage.tsx` — `opacity-40` removed from future rows in favour of a dimmer
  border; `text-muted/50` → `text-muted` on the two ordinals; `text-accent` → `text-accent-text` on
  the "Current" badge and today's day label; `text-muted` → `text-foreground` on the two
  "Unsubmitted" badges.

**Why the levels differ, since a global token change was the obvious move.**

- `opacity-40` was **page-level** because `MyWeekPage.tsx:339` was its *only* occurrence in
  `web/src`. Nothing else could be affected.
- `text-muted/50` was **page-level** because 10 of its 12 occurrences are on other pages
  (`PlanQualityBanner`, `DashboardVariantC` at `/dashboard`, `WorkspaceSettings`,
  `AdminWorkspaceDetail`, `Programs`, `MergeProgramDialog`, `HypothesisBlockComponent`). They fail
  too — 2.26:1 is a property of the token pair, not of this page — but they are outside A11Y-3 and
  are filed as a follow-up rather than swept in silently.
- `accent-text` was added at **token level** but applied only here. Adding a token cannot regress a
  page that currently passes; mutating `accent` could, because `accent` is a fill under white text
  in 80 places across 45 files. That mutation is a visual-identity decision, not a contrast fix.

**The tradeoff, stated because it is visible.** Future standup rows are no longer ghosted. They now
read as ordinary muted rows, distinguished by a dimmer border, the italic "Upcoming" label and the
absent status dot. This was not avoidable by tuning the opacity value: `text-muted` only clears
4.5:1 above roughly **86%** opacity, at which point nothing looks dimmed at all. Likewise the
ordinals lost their extra-quiet tier — on `#0d0d0d`, AA bottoms out around `#7a7a7a`, a 16-step
band below `muted`, so a perceptibly quieter *compliant* grey does not exist on this background.
Contrast won, as the ticket directed.

**Evidence.** Both ends measured on this branch, same conditions, not inherited from the audit:
`http://localhost:5683`, Chrome for Testing headless, 1440×900, `--preset=desktop`,
`--only-categories=accessibility`, authenticated as `dev@ship.local`, 523 seeded documents,
`ship_wt_tro_217`. Flags identical to `audit/a11y/run-lighthouse.sh` and `audit/a11y/axe-scan.mjs`.

| Measurement on `/my-week` | Before | After |
|---|---|---|
| Lighthouse accessibility | **95** | **100** |
| Lighthouse failing audits | 1 (`color-contrast`, 18 items) | **0** |
| axe `color-contrast` nodes | **18 Serious** | **0** |
| axe all severities | C0 **S1** M0 m0 | C0 S0 M0 m0 |

The audit baseline recorded 24 nodes and the ticket said 25; **18** is what the same page produced
here. The gap is the weekday (four remaining future days instead of six), not a different defect —
the per-node causes and ratios match the baseline artifact exactly.

**Regression test.** `web/src/pages/MyWeekPage.contrast.test.tsx` resolves the effective foreground
and background *colours* out of the rendered DOM and asserts the WCAG ratio, rather than asserting
a class string — so it survives a markup refactor and fails if a palette hex drifts back under
4.5:1. It renders four data states, because three of the page's pairs only exist under specific
data; a single-state check would have declared the page fixed while the 4.38:1 badge sat behind a
common plan state. `web/src/lib/contrast.test.ts` pins the resolver against numbers this project
did not compute — the exact `fgColor`/`bgColor`/`contrastRatio` values axe recorded in
`audit/a11y/axe/`.

Confirmed red first on the unfixed page: 6 failures, every one an `AssertionError` on the ratio
(21 of 39 pairs below 4.5:1 in the first state; named failures at 2.26:1, 1.85:1, 2.82:1, 4.38:1).
No import or locator errors.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 24 new tests; 13 known failures are TEST-1/TRO-223, unchanged
pnpm --filter @ship/web type-check
```

To re-measure against a browser, start the worktree's API and Vite, log in for a fresh
`session_id` (sessions expire in 15 minutes), then run Lighthouse and axe with the flags above.

**Roll back.** `git revert` the commits on `fix/a11y-3-contrast`, or by hand: restore `opacity-40`
on the future-row branch of `rowClass`, put back `text-muted/50` on the two ordinals,
`text-accent` on the "Current" badge and today's day label, `text-muted` on the two "Unsubmitted"
badges, and drop `accent-text` from the palette. The two new spec files fail if any of it comes
back, which is the point.

**Not established.** That a low-vision user can now read the page. Contrast ratios and axe output
are measured; the user-facing benefit is *derived* from them, and no human with low vision has
looked at this build. Also not established: that the repo's three Playwright a11y specs still pass
— they are not run by the factory gate and were not run here. One of them,
`e2e/accessibility-remediation.spec.ts:738` ("no color contrast violations on main pages"), runs
axe right after login, which lands on `/my-week`; it was almost certainly failing before this
change and should now pass, but that is a prediction, not a result.

**Found and not fixed** (filed as follow-ups, all measured):

1. `text-muted` on a `bg-border` fill is **4.38:1** and co-occurs in ~109 places in `web/src`.
   Raising `muted` from `#8a8a8a` to `#929292` (4.86:1 on `#262626`, 6.25:1 on `#0d0d0d`) fixes the
   whole class in one line and cannot lower contrast on any dark surface. Out of scope here because
   it is an app-wide tone change driven by pairs outside this page.
2. `text-accent` is **2.89:1** as small text on the page background wherever it renders — 80
   occurrences in 45 files. Only the two on `/my-week` were observed failing by axe; the rest is
   computed from the token, so treat the count as derived. `accent-text` now exists for them.
3. `bg-surface` is used in three files including `MyWeekPage.tsx`, but `surface` is **not a palette
   token**, so the class generates no CSS and those "cards" are painted with the page background.
   Harmless today; it silently changes the contrast maths for anything inside them if `surface` is
   ever defined.
4. `getContrastTextColor` in `web/src/lib/cn.ts` carries a second copy of the WCAG luminance
   formula now also in `web/src/lib/contrast.ts`. Collapsing them changes a shipped helper's
   behaviour on malformed input, so it was left alone.
5. `pnpm db:migrate` stopped after `010_oauth_state.sql` on a partially-migrated database and still
   reported success, leaving 10 of 42 migrations applied — the swallowed `already exists` catch at
   `api/src/db/migrate.ts:103-110`. This is **DB-1** reproducing; worked around by cloning a
   fully-migrated database rather than by touching the runner.

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

