# Ship Audit Report
**Commit:** `076a183` (`076a18371da0a09f88b5329bd59611c4bc9536bb`) · **Date:** 2026-07-27 · **Auditor:** Claude + troysatchell

ShipShape 8-category codebase health baseline (7 code/runtime categories + Terraform/IaC review). Measured against a 500-document / 20-user seed on PostgreSQL 15-alpine (Docker), Node v23.2.0, Apple M-series (arm64). Every number traces to a command/tool run recorded in the per-category Methodology; no application source or infrastructure source was modified. Per-category machine-readable data: `audit/<category>/baseline.json`.

## Executive summary

Ship is a functional, thoughtfully-built app — a unified document model, CRDT real-time collaboration, and *existing* accessibility/security test investment. The baseline audit measured all seven categories against a 500-document / 20-user seed and surfaced **62 findings (4 Critical, 21 High, 25 Medium, 12 Low)**. Nothing was left unmeasured.

The four Criticals cluster in two places — **the deploy/migration path** and **the real-time collaboration write path**:

- **DB-1 — `pnpm db:migrate` silently skips 32 of 42 migrations and exits 0.** A non-idempotent migration throws "already exists", the catch treats it as benign, and the loop is abandoned — reporting success. Migrations run automatically on deploy, so any database not already at the end state (real prod/shadow) silently misses 19 schema changes and 42 backfills. Data-integrity risk, hidden because a fresh dev DB looks correct (schema.sql carries the end state).
- **ERR-1 — collaboration WebSocket unreachable at load → edits silently lost, while the indicator reads "Saved"/"Cached".** When the collab socket never completes its initial sync, the editor keeps accepting edits that never persist; after a reload the DB content is empty — with no warning. (Whole-browser-offline *does* recover; this is specific to the collab socket.)
- **ERR-2 — session revocation/expiry is not enforced on live collaboration sockets.** Auth is a connect-time gate only; after deleting/expiring the session server-side, the open editor keeps writing to documents. A logged-out user retains write access.
- **API-1 — the global rate limiter caps production at 100 req/min per IP** while a single page view costs 4–16 requests, and throttled writes (429) are never retried, so they're dropped. Until this is raised, *no* latency optimization is observable in production — the limiter bounds throughput far below anything measured.

Beyond the Criticals, two systemic themes carry the most leverage:

1. **Performance debt that api-perf and db-query independently converge on.** Every authenticated request performs a session-table *write* (DB-2/API-6); the week dashboard fans out one request per active week (DB-4/API-4/API-5, and the cause of the 61s slow-network main page in ERR-7); `/api/issues` ships 380 KB of mostly-unused document body with no pagination or compression (API-2/API-3/DB-5); and the frontend ships as one 2.07 MB entry chunk with zero route splitting (BUN-1/2/3). These reinforce each other and share a handful of fixes.
2. **Infrastructure that provides no regression gate today.** 13 web unit tests fail and nothing runs them (TEST-1); coverage tooling is broken/absent (TEST-7); 68 e2e tests can pass with zero assertions, including the only stored-XSS and audit-log-authz checks (TEST-2); the web tsconfig doesn't extend root, hiding 102 type errors (TS-1); and the entire DB→HTTP path is implicitly `any` (TS-2).

**Verified positives** worth stating: no exploitable XSS via the vectors tested (React escaping holds), clean API input validation (400s with zod detail), healthy keyboard navigation with visible focus rings, and whole-browser-offline edit recovery. **Accessibility caveat:** Lighthouse rates the key pages 95–100, but axe on the same pages plus interactive states finds 2 Critical + 3 Serious rule violations that both Lighthouse and the repo's *critical-only* specs miss — and Ship runs at `ship.awsdev.treasury.gov`, where Section 508 makes those failures a conformance issue, not a nice-to-have.

**Infrastructure-as-code (Category 8, Terraform):** the `terraform/` config is **AWS** (Elastic Beanstalk + Aurora Serverless v2 + VPC + CloudFront/S3 + WAF + SSM), not the Render setup the brief assumes, and a live `plan` is not runnable without AWS credentials + the SSM-stored remote-state bucket — so blast radius was reasoned statically and drift was demonstrated cloud-free with the local provider. The IaC is well-secured (encryption, private subnets, WAF, SSM SecureString) but has two High foot-guns: **TF-1** — the prod database and uploads bucket have no deletion protection (only the Terraform *state* bucket is guarded), and **TF-2** — two divergent root configs manage the same infra (the flat root has WAF + realtime logging the modular `environments/prod` path lacks). Also TF-3: the pinned Terraform `1.6.0` can no longer `init` (expired provider-signing key).

**Environment caveats stamped in every artifact:** measured against PostgreSQL **15**-alpine in Docker (compose declares 16; registry pulls blocked here) — relevant to EXPLAIN-plan comparisons — and migrations 011–042 were applied manually because of DB-1. No application source (`api/`, `web/`, `shared/`) or infrastructure source (`terraform/`) was modified; the tree is dirty only under `audit/`, `memory-bank/`, `.claude/`.

## Cross-category findings ranking

All **68** findings merged and re-ranked by severity, then by category. IDs are stable (assigned at baseline); compare-mode and the sections below reference them. Findings sharing a root cause are cross-referenced rather than deduplicated.

**Totals:** 4 Critical · 22 High · 29 Medium · 13 Low  ·  8 categories

| # | ID | Severity | Category | Finding | Est. impact / cross-ref |
|---|----|----------|----------|---------|-------------------------|
| 1 | API-1 | Critical | API Performance | Global rate limiter caps production traffic at 100 req/min per IP while one page view costs 4-16 requests; 429s are never retried, so throttled writes are dropped | Raising the limit to a per-page-view-realistic value (or keying it per session rather than per IP) removes an artificial ~1.7 req/s prod ceiling an… |
| 2 | DB-1 | Critical | Database Queries | pnpm db:migrate silently skips 32 of 42 migrations and exits 0, reporting success | Migrations run automatically on deploy (api/src/db/migrate.ts, per CLAUDE.md) |
| 3 | ERR-1 | Critical | Error Handling | Collaboration WebSocket unreachable at load → edits silently lost; sync indicator falsely reads "Cached"/"Saved" | Real user-facing data loss whenever the collaboration server/endpoint is unreachable at editor load (collab crash, proxy/LB dropping WS upgrades, a… _(see ERR-2)_ |
| 4 | ERR-2 | Critical | Error Handling | Session revocation/expiry not enforced on live collaboration sockets — a logged-out user keeps writing to documents | Security exposure: logout/session-revocation does not stop an open editor from mutating documents; an attacker (or a shared/hijacked machine) retai… _(see ERR-1)_ |
| 5 | A11Y-1 | High | Accessibility | Workspace-documents sidebar uses role="tree" but its children are plain <li> nav links, not treeitems (axe Critical + Serious) | The primary navigation tree — on every page — is announced incorrectly by screen readers (item count/role wrong), a Section-508 blocker on a federa… |
| 6 | A11Y-2 | High | Accessibility | TipTap editor wrapper sets aria-expanded on a plain <div> with no supporting role (axe Critical) | Confusing/invalid ARIA on the core editing surface used for every document type (508 contradiction) |
| 7 | A11Y-3 | High | Accessibility | Dashboard (/my-week) fails color contrast on 25 elements — muted 50%-opacity text and translucent badges (axe Serious; the only Lighthouse-failing page) | Low-vision users can't read dashboard timestamps/labels; 508 contradiction on the landing page |
| 8 | API-2 | High | API Performance | GET /api/issues returns 380 KB with no pagination, 72% of which is a content field the list UI never reads | Dropping content from the list projection shrinks the payload ~2.6x and should cut P95 at c=25 from 94.5 ms to roughly 35-40 ms (~55-60%), clearing… _(see DB-5)_ |
| 9 | API-3 | High | API Performance | No response compression anywhere in the API; the largest payload ships 15.4x larger than it needs to | On a 10 Mbps agency link the /api/issues body alone is ~304 ms of transfer; gzip reduces that to ~20 ms |
| 10 | BUN-1 | High | Bundle Size | Whole application ships in one 2.07 MB entry chunk — zero route-level code splitting | This is the structural cause of the other findings: an unauthenticated visitor on /login downloads the admin dashboard, org chart, reviews queue an… |
| 11 | BUN-2 | High | Bundle Size | TipTap + ProseMirror + Yjs editor/collaboration stack is 35.5% of the entry chunk and loads on every page | Wrapping Editor/UnifiedEditor in React.lazy + Suspense removes up to 208.7 kB gzip from the initial load — 34.7% of the 600.75 kB initial payload, … |
| 12 | BUN-3 | High | Bundle Size | lowlight `common` pulls 37 highlight.js language grammars into the entry chunk — the largest single npm dependency by gzip | Replacing `common` with an explicit 6-8 language registration is a one-line change worth an estimated 45-55 kB gzip |
| 13 | DB-2 | High | Database Queries | Every authenticated request issues a session-table WRITE plus 2 reads; 52-94% of all per-flow queries are auth boilerplate | Gating the write on the same 60s threshold already used for the cookie removes ~1 write per request: 'List issues' 17 -> 12 queries (-29%), 'Load s… _(see API-6)_ |
| 14 | DB-3 | High | Database Queries | 61% of all database time is query planning, not execution — every statement is re-parsed and re-planned | Naming the handful of hot statements (pool.query({name, text, values})) lets Postgres cache and reuse the plan after five executions, which would r… |
| 15 | DB-4 | High | Database Queries | Week dashboard N+1: one /api/weeks/:id/standups request per active week, 25 of the flow's 42 queries | Replacing the fan-out with a single batched query (standups for all active weeks, ORDER BY created_at DESC LIMIT 10) takes 'Load week dashboard' fr… _(see API-4)_ |
| 16 | ERR-3 | High | Error Handling | Rejected document writes (429/500 PATCH) are silently dropped; the sync indicator shows "Saved" over an unsaved value | Users believe a rename/property change persisted when it did not (High: silent failure on a write) |
| 17 | ERR-4 | High | Error Handling | Editing a document that is deleted elsewhere continues with no notice; post-delete edits are dropped | Lost work + a confusing ghost editor in a normal multi-user flow (High) |
| 18 | TEST-1 | High | Test Quality | 13 web unit tests are failing, and nothing in the repository ever runs them | The repo has no automated regression gate at all |
| 19 | TEST-2 | High | Test Quality | 68 e2e tests (7.9%) can pass without executing a single assertion, including a security and an authorization test | 7.9% of the e2e suite provides no signal |
| 20 | TEST-3 | High | Test Quality | Retries hide a test that fails on first attempt in 100% of runs; 11 tests flaked across 3 identical runs | A real regression in any of these 11 paths would be retried into green |
| 21 | TEST-4 | High | Test Quality | Concurrent multi-client editing / Yjs merge has no test | A Yjs or persistence regression that silently drops one client's edits would ship green |
| 22 | TF-1 | High | Terraform / IaC | Prod data stores have no deletion protection — only the Terraform state bucket is guarded | One careless `apply`/`destroy` from prod data loss |
| 23 | TF-2 | High | Terraform / IaC | Two divergent root configurations manage the same infrastructure, and they have already drifted apart | Ambiguity over which config is authoritative; if both are applied to one account they collide on hard-coded resource names; security controls (WAF,… |
| 24 | TS-1 | High | Type Safety | web/tsconfig.json does not extend the root tsconfig — 102 latent type errors are invisible in the frontend | Restoring inheritance and fixing the 102 errors converts the largest class of frontend runtime crash ('cannot read property of undefined' on array/… |
| 25 | TS-2 | High | Type Safety | The entire database-to-HTTP response path is implicitly `any` — 707 pg queries, none typed | This is the single largest unchecked surface in the codebase and sits directly on the API contract |
| 26 | TS-3 | High | Type Safety | The Yjs <-> TipTap converter — the persistence path for every document's content — is fully untyped | Highest severity-per-line in the codebase: this is the only code that translates the collaborative CRDT state into the durable `content` column |
| 27 | A11Y-4 | Medium | Accessibility | A Radix popover/dropdown opens as a role=dialog with no accessible name (axe Serious) | Screen-reader users hear 'dialog' with no context when the control opens (508 contradiction on a core list page) |
| 28 | A11Y-5 | Medium | Accessibility | /search and /weeks render with no <main> landmark and no level-one heading (axe Moderate) | No landmark/heading structure to navigate two key pages (508) |
| 29 | A11Y-6 | Medium | Accessibility | Document pages skip heading levels (h1 → h3), breaking the screen-reader outline (axe Moderate) | Heading-based navigation lands users on mis-nested sections (Medium; 508) |
| 30 | API-4 | Medium | API Performance | Command palette (cmd+K) re-downloads the entire 294 KB document corpus on every open, bypassing the react-query cache | Cost grows linearly with workspace size — at 10x seed volume each cmd+K press transfers ~2.9 MB _(see DB-4)_ |
| 31 | API-5 | Medium | API Performance | Dashboard issues one request per active week for standups (client-side N+1) | A single GET /api/weeks/standups?week_ids=.. _(see DB-4)_ |
| 32 | API-6 | Medium | API Performance | Every authenticated request — including every GET — performs a session UPDATE, making all reads writers | Throttling the last_activity write to the same ~60 s threshold already used for the cookie removes one write per request, roughly a third of the qu… _(see DB-2)_ |
| 33 | BUN-4 | Medium | Bundle Size | emoji-picker-react (186 kB raw / 39 kB gzip) is in the entry chunk to serve a single sidebar popover | React.lazy on the EmojiPickerPopover body removes 39.1 kB gzip from the initial payload (6.5% of 600.75 kB) for near-zero risk — the picker is behi… |
| 34 | BUN-5 | Medium | Bundle Size | USWDS icon glob emits 245 chunks of which 209 are never referenced, and ships a 245-entry loader map in the entry chunk | Narrowing the glob to the icons actually used (or generating the loader map from the same source that generates types.ts, via `pnpm generate:icon-t… |
| 35 | BUN-6 | Medium | Bundle Size | No build/chunking configuration at all — no vendor chunk, so every app-code change invalidates all 588 kB gzip | A manualChunks vendor split does not reduce total bytes but converts ~250-300 kB gzip of stable dependency code into a long-lived cache entry: retu… |
| 36 | DB-5 | Medium | Database Queries | /api/issues list query SELECTs the full document body for all 254 issues; the list UI never reads it | Dropping d.content from the list projection cuts the sort node's row width by roughly 70% and removes 158 kB of body text from the query result at … _(see API-2)_ |
| 37 | DB-6 | Medium | Database Queries | /api/weeks sprint aggregate runs 8 correlated subplans per row, two of which seq-scan document_associations once per row | Execution is only 1.192 ms at 500 documents / 813 associations because everything is in shared buffers, but the plan is quadratic in shape: cost sc… |
| 38 | DB-7 | Medium | Database Queries | No index on documents.ticket_number — issue deep-link lookup seq-scans the whole documents table | A partial index — CREATE INDEX ON documents (workspace_id, ticket_number) WHERE document_type = 'issue' — turns 500 rows examined into 1 and 66 buf… |
| 39 | DB-8 | Medium | Database Queries | Planner underestimates the document_associations = ANY(...) batch by 28x and chooses a sequential scan | Harmless at 813 association rows (1.168 ms, everything cached) |
| 40 | DB-9 | Medium | Database Queries | Flows fire byte-identical API requests two and three times, duplicating their entire query cost | Deduplicating these removes 3 redundant endpoint executions from the sprint board — roughly 11 of 51 queries (-22%, clearing the target on its own)… |
| 41 | ERR-5 | Medium | Error Handling | Invalid path/query params return 500 Internal Server Error instead of 400/404 | Wrong status codes (a client can't distinguish 'bad request' from 'server broken'), avoidable error-log noise, and a slightly worse not-found UX |
| 42 | ERR-6 | Medium | Error Handling | Comment mark orphaned into persisted content when the comment popover is dismissed by blur (not Escape) | Data-integrity drift: documents accumulate highlighted spans pointing at non-existent comments (Medium) _(see TEST-5)_ |
| 43 | ERR-7 | Medium | Error Handling | No loading affordance under slow network; sync indicator never shows an in-flight/unsaved state | On a slow link the app looks hung for many seconds with no signal, and users get no confirmation that typing is being saved (Medium) _(see DB-4)_ |
| 44 | TEST-5 | Medium | Test Quality | Canceling an inline comment leaves an orphaned comment-highlight mark in the saved document (real app bug candidate) | Document-content pollution on a plausible user action (start a comment, change your mind) _(see ERR-6)_ |
| 45 | TEST-6 | Medium | Test Quality | Allocation grid returns planId: null immediately after the plan is created (read-after-write race candidate) | A user creating a weekly plan may see their own plan missing from the allocation grid on the next render |
| 46 | TEST-7 | Medium | Test Quality | Coverage measurement is broken in api and entirely absent in web and shared | No coverage-based decision is possible and no coverage movement can be proven in compare mode |
| 47 | TEST-8 | Medium | Test Quality | Two shipped routes have zero test coverage of any kind | The landing page and the org chart can break with no test noticing |
| 48 | TEST-9 | Medium | Test Quality | `pnpm test` TRUNCATEs whatever database DATABASE_URL points at | The sequence documented in .claude/CLAUDE.md (`pnpm dev`, then `pnpm test`) silently wipes the developer's dev database |
| 49 | TF-3 | Medium | Terraform / IaC | Repo pins Terraform 1.6.0, which can no longer bootstrap — its provider-signature key has expired | A clean-machine `terraform init` at the pinned version is impossible — onboarding/CI following `.terraform-version` breaks |
| 50 | TF-4 | Medium | Terraform / IaC | The flat root module has no committed provider lock file — provider versions float | Two operators (or CI vs laptop) running the flat root can silently get different provider builds, so plans are non-reproducible and a compromised p… |
| 51 | TF-5 | Medium | Terraform / IaC | uploads S3 lifecycle rule has no filter/prefix — a provider validation warning that becomes a future error | The uploads-bucket lifecycle policy may not apply as intended, and the config will hard-fail on a future aws-provider major |
| 52 | TS-4 | Medium | Type Safety | 236 non-null assertions on request auth context, all traceable to one optional declaration | Fixing one type declaration (an `AuthenticatedRequest` interface, or a typed middleware handler wrapper) retires 236 of the 321 corrected non-null … |
| 53 | TS-5 | Medium | Type Safety | The shared/ type contract is bypassed — 46 exported types, adopted by 13 of 198 web files, with ~40 duplicate local model declarations | Consolidating on shared/ is the only way TS-2's typed row interfaces actually reach the frontend; done together, a backend field rename becomes a f… |
| 54 | TS-6 | Medium | Type Safety | No ESLint anywhere in the repo — `pnpm lint` is a silent no-op, so nothing prevents these counts from growing | Does not reduce the current count, but it is the ratchet: without it, any 25% reduction achieved will regress |
| 55 | TS-7 | Medium | Type Safety | `as any` used to silence type mismatches on a destructive bulk mutation and on a SQL parameter | Small count (3 sites) but disproportionate risk placement: it is on a bulk-archive path that mutates many records at once, and its Undo |
| 56 | A11Y-7 | Low | Accessibility | Login page: form content not contained in a landmark and no main landmark (axe Moderate) — missed by the repo's critical-only specs | Minor orientation loss on the unauthenticated entry page (Low) |
| 57 | A11Y-8 | Low | Accessibility | Issues table selection column has an empty table header (axe Minor) | Minor screen-reader ambiguity on the issues table header row (Low) |
| 58 | BUN-7 | Low | Bundle Size | Unused dependency @tanstack/query-sync-storage-persister declared but never imported | 0 shipped bytes today — this is dependency hygiene and supply-chain surface, not payload |
| 59 | BUN-8 | Low | Bundle Size | Two Radix packages resolve to duplicate versions and both copies ship in the entry chunk | ~2.1 kB raw / <1 kB gzip |
| 60 | BUN-9 | Low | Bundle Size | Initial render blocks on a third-party Google Fonts stylesheet outside the bundle | Self-hosting Inter as a woff2 subset removes a cross-origin round trip from first paint and removes a third-party runtime dependency from an applic… |
| 61 | DB-10 | Low | Database Queries | No index on documents.updated_at despite ORDER BY updated_at DESC in seven route modules | None measurable today — quicksort on 254 rows costs microseconds |
| 62 | ERR-8 | Low | Error Handling | Unbounded `limit` query param — negative and huge values both return the full unpaginated payload | Input-validation gap that compounds the already-unpaginated list endpoints (Low here; the payload-size problem is owned by api-perf) |
| 63 | ERR-9 | Low | Error Handling | BacklinksPanel logs a console.error storm on every failed fetch (offline, deleted, expired, revoked) | Console noise that masks genuine errors during exactly the failure scenarios you most want to debug (Low) |
| 64 | TEST-10 | Low | Test Quality | E2E worker auto-sizing collapses to 1 worker on macOS | A developer running `pnpm test:e2e` on a Mac gets a single-worker run, roughly 4x the measured 9 minutes — a strong disincentive to run the suite l… |
| 65 | TEST-11 | Low | Test Quality | Stale test-count comment and heavy fixed-sleep usage | Hygiene, but the waitForTimeout density is the mechanism behind TEST-3 — every fixed sleep is a flake waiting for a slower machine. |
| 66 | TF-6 | Low | Terraform / IaC | Secret generators have no keepers — regeneration silently rotates the DB password and logs out all users (blast-radius note) | Regenerating session_secret invalidates every active session (all users logged out); regenerating db_password rotates the Aurora master password in… |
| 67 | TS-8 | Low | Type Safety | 68% of flagged sites are in test files, where `as any` mocks decouple tests from the shapes they claim to verify | Low blast radius on its own — but it means a route can change its response shape and its own unit test still compiles and passes, so these tests pr… |
| 68 | TS-9 | Low | Type Safety | web build and script files are never type-checked | Hygiene |

## Improvement plan

Each category defines its own improvement target and the compare-mode evidence that will prove it. Attack order is chosen so the highest-severity, lowest-risk, cross-cutting fixes land first. Every fix re-runs the full test suite (per the identical-conditions rule) before its delta is accepted.

**Cross-cutting root causes** (fix once, credit multiple findings):
- **Per-request session write** — DB-2 ⇄ API-6 (same `UPDATE sessions SET last_activity` on every request). One gate clears both.
- **Week-dashboard N+1** — DB-4 ⇄ API-4 ⇄ API-5, and the cause of ERR-7's 61s slow-network main page. One batched query clears all.
- **Issues list payload** — API-2 ⇄ DB-5 (list SELECTs the full document body it never renders). One projection change clears both.
- **Comment-mark orphan** — ERR-6 ⇄ TEST-5 (same blur-dismiss bug; TEST-5 is the failing repro test).
- **Collaboration server** — ERR-1 ⇄ ERR-2 (both live in `api/src/collaboration/index.ts`; the session re-validation fix for ERR-2 and the sync-truth fix for ERR-1 ship together).

| Category | Improvement target | Attack these IDs | Evidence to produce |
|---|---|---|---|
| error-handling | 3 gaps fixed, ≥1 real data-loss/confusion | **ERR-1** (data loss), **ERR-2** (auth), ERR-3 | before/after repro per ID + screenshots; full e2e green |
| db-query | ≥20% query-count or query-time reduction on a flow | **DB-2** (−22–29%), **DB-4** (−48%), DB-3 (prepared) | before/after query logs + EXPLAIN ANALYZE, identical seed |
| api-perf | ≥20% P95 on a key endpoint | **API-2** (~55–60% on /issues), API-3 (bandwidth-shaped), API-1 (unblocks all) | autocannon before/after at same concurrency; note API-3 must be measured over a shaped link, not loopback |
| bundle | measurable entry-chunk reduction | **BUN-1** (route splitting), BUN-2/BUN-3 (lazy editor + lowlight) | before/after analyzer output + gzip sizes |
| type-safety | reduce violations without breaking behavior | **TS-1** (extend root tsconfig, fix 102), TS-2 (type the DB path) | before/after counts via the recorded grep patterns; type-check green |
| test-quality | new meaningful tests + fixed flakes | **TEST-1** (run web tests + CI), TEST-2 (fix assertion-less tests), TEST-3 (flake) | test run showing the 13 failures caught + the empty tests now asserting |
| a11y | +10 Lighthouse on lowest page OR all Crit/Serious on top-3 pages | **A11Y-3** (/my-week contrast → +10 pts), **A11Y-1** (tree semantics), A11Y-2 (editor aria) | before/after Lighthouse (A11Y-3) + before/after axe rule counts; repo a11y specs + e2e green |
| terraform | local-provider config (≥2 resources, pinned) + Render web-service config, both `plan`-confirmed & deployable via `terraform apply` | **TF-1** (add deletion_protection/prevent_destroy), **TF-2** (converge to one structure), TF-3/TF-4 (bump pin, commit lock) | `terraform plan` matching intent for both new configs; `audit/terraform/drift-demo/` already covers the local half |

**Recommended first sprint** (max severity-reduction for the risk): DB-1 (deploy safety — unblocks everything else being deployable), ERR-1+ERR-2 (data loss + auth in one collaboration-server change), API-1 (unblocks all perf work), then the shared-root perf fixes DB-2 and DB-4/API-4. That sequence retires all 4 Criticals and 3 Highs while touching only the migration runner, the collaboration server, one middleware gate, and two queries.

---

## Category baselines

_Each section is the category's `baseline.md` verbatim (headings demoted one level where a source file used H1, so the report keeps one document title)._

---

## Type Safety — Baseline

**Repo:** `/Users/troy/repos/GAUNTLET/Ship` · **Commit:** `076a183` (tree dirty: `.claude/`, `.gitignore`, `audit/`, `memory-bank/` only — no application source modified) · **Date:** 2026-07-27T16:53:39Z
**Environment:** Apple Mac16,7 — 14 cores, 24 GB RAM (arm64) · Darwin 25.5.0 arm64 / macOS 26.5.1 · Node v23.2.0 · pnpm 10.27.0 · TypeScript 5.9.3
**Data volume:** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users

---

### Methodology

Static analysis only. No application source, config, or dependency was modified.

**1. Violation counts** — the bundled script, run once against all three packages from the repo root:

```bash
~/.claude/skills/type-safety-audit/scripts/count.sh \
  /Users/troy/repos/GAUNTLET/Ship/web \
  /Users/troy/repos/GAUNTLET/Ship/api \
  /Users/troy/repos/GAUNTLET/Ship/shared
```

Base grep invocation used by the script (recorded verbatim — compare mode must use the identical patterns):

```
grep -rEn --include=*.ts --include=*.tsx \
     --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage
```

| Metric key | Pattern |
|---|---|
| `explicit_any` | `:\s*any\b\|<any>\|\bany\[\]\|Array<any>` |
| `as_assertions` | `\bas\s+[A-Za-z_{]` |
| `as_any` | `\bas\s+any\b` |
| `non_null_assertions` | `[a-zA-Z0-9_\)\]]!(\.\|\[\|\)\|,\|;\|\s*$)` |
| `ts_ignore` | `@ts-(ignore\|expect-error)` |
| top-files ranking | `:\s*any\b\|<any>\|\bany\[\]\|\bas\s+any\b\|@ts-(ignore\|expect-error)` |

> **Grep-binary note (matters for reproducibility).** The script has a `bash` shebang, so it resolves `grep` to `/usr/bin/grep` (BSD grep, macOS 26) rather than this shell's interactive `ugrep` shim. All tracked numbers below are the BSD-grep numbers. Reproduce with `bash ~/.claude/skills/type-safety-audit/scripts/count.sh …`, never by pasting the greps into an interactive zsh — ugrep parses the bracket expressions differently and returns materially different counts.

**2. Strict mode** — every tsconfig in the tree was read (`tsconfig.json`, `web/`, `api/`, `shared/`; `research/configs/*` is a non-built reference copy). `pnpm type-check` (= `tsc --noEmit` per package) was run to establish the current error count. Because `strict` is already on everywhere, the equivalent "true debt" probe is the *inherited* strict flags web opts out of; measured with CLI overrides so no file was edited:

```bash
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch
```

**3. Supporting counts** (each from a command, per the determinism rule), all with the same base grep:

| Number | Command |
|---|---|
| 707 untyped pg queries / 0 typed | `'(pool\|client\|db)\.query'` vs `'(pool\|client\|db)\.query<'` over `api/src`, minus test files |
| 767 `.rows` accesses | `'\.rows\b'` over `api/src`, minus test files |
| 7 untyped row mappers | `'\((row\|r): any'` over `api/src`, minus test files |
| 236 `req.userId!` / `req.workspaceId!` | `'req\.(userId\|workspaceId)!'` over `api/src` |
| 13/198 and 13/109 shared-type importers | `grep -rl "from '@ship/shared'"` over `web/src`, `api/src` |
| ~40 duplicate model declarations | `'^(export )?(interface\|type) (Project\|Issue\|WikiDocument\|UnifiedDocument\|Sprint\|Week\|Program\|Person\|ApiResponse)\b'` |
| ESLint absent | `find` for `.eslintrc*` / `eslint.config.*` outside node_modules → 0 hits |

**Correction factors** (spot-checks; the raw script number remains the tracked metric):

- `non_null_assertions` **under-counts by ~6.8x**. In `[a-zA-Z0-9_\)\]]!…`, BSD grep treats the backslashes inside the bracket expression as literal `\`, so the class closes early and the pattern effectively requires a `]` immediately before `!`. Tracked total 47; the corrected pattern `[a-zA-Z0-9_)]]?!(\.|\[|\)|,|;|\s*$)` yields **321** (web 33, api 288), of which only 2 are comment false positives and 4 are in test files. Both numbers are recorded in `baseline.json` (`nonNullTotal`, `nonNullCorrected`); the tracked pattern is kept unchanged so compare mode stays comparable.
- `as_assertions` **over-counts by roughly 15–20%**. Of the 1385 raw hits, ≥154 are not assertions at all: 61 are on `import`/`export … as …` lines (web 35, api 26) and 93 are inside comments or prose (web 34, api 58, shared 1 — e.g. `// Format time as M:SS`, `Same as last week`). A further 73 are `as const` (web 59, api 12, shared 2), which is a safety *improvement*, not a violation. Genuinely risky assertions are the 158 `as any` plus the residue.

---

### Deliverable table

| Metric | Baseline |
|---|---|
| Total `any` types | **102** |
| Total type assertions (`as`) | **1385** (of which 158 are `as any`; ~154 raw hits are imports/comments and 73 are `as const` — see corrections) |
| Total non-null assertions (`!`) | **47** tracked · **321** corrected |
| Total `@ts-ignore` / `@ts-expect-error` | **1** (a single justified `@ts-expect-error` at `web/src/components/icons/uswds/Icon.test.tsx:63`) |
| Strict mode enabled? | **web: yes · api: yes · shared: yes** — but web does **not** extend the root tsconfig, so it silently loses `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` |
| Strict-mode error count (if disabled) | **0** at current configs (`pnpm type-check` is green). With web's three missing inherited flags restored: **102 errors** — 94 `noUncheckedIndexedAccess`, 8 `noImplicitReturns` (TS7030), 0 `noFallthroughCasesInSwitch` |
| Top 5 violation-dense files (raw script ranking) | `api/src/__tests__/transformIssueLinks.test.ts` 37 · `api/src/services/accountability.test.ts` 32 · `api/src/__tests__/auth.test.ts` 24 · `api/src/__tests__/activity.test.ts` 21 · `api/src/routes/issues-history.test.ts` 20 |
| **Total tracked violations** | **1535** (102 `any` + 1385 `as` + 47 `!` + 1 ts-ignore; `as any` not double-counted) |

#### Per package

| Package | `any` | `as` | `as any` | `!` (tracked / corrected) | ts-ignore | strict | extra root flags | tsc errors |
|---|---|---|---|---|---|---|---|---|
| `web` (frontend, 198 src files) | 24 | 433 | 7 | 5 / 33 | 1 | ✅ | ❌ **not inherited** | 0 → **102** with flags |
| `api` (backend, 109 src files) | 78 | 947 | 151 | 42 / 288 | 0 | ✅ | ✅ | 0 |
| `shared` (8 src files, 46 exported types) | 0 | 5 | 0 | 0 / 0 | 0 | ✅ | ✅ | 0 |
| **Total** | **102** | **1385** | **158** | **47 / 321** | **1** | | | **0 / 102** |

#### Where the violations actually live

The raw density ranking is dominated by tests and is misleading about risk. Splitting it:

| | Sites | Share |
|---|---|---|
| Test files (`*.test.*`, `__tests__/`) | 176 | 68% |
| Production code | 84 | 32% |

**Production-only density ranking** — this is the list worth reading:

| Rank | File | Sites | Lines | What flows through it |
|---|---|---|---|---|
| 1 | `api/src/routes/projects.ts` | 13 | 1735 | SQL rows → project/sprint JSON contract; issue rollup counts |
| 2 | `api/src/utils/yjsConverter.ts` | 12 | 245 | CRDT state ↔ persisted document `content` |
| 3 | `api/src/routes/weeks.ts` | 10 | 3156 | SQL rows → sprint/week/standup JSON contract |
| 4 | `web/src/components/editor/FileAttachment.tsx` | 7 | 357 | TipTap node/editor commands, upload |
| 4= | `api/src/types/y-protocols.d.ts` | 7 | 39 | Yjs awareness/sync protocol shims |
| 6 | `web/src/components/editor/SlashCommands.tsx` | 6 | 714 | TipTap editor + suggestion plugin props |
| 6= | `web/src/components/editor/AIScoringDisplay.tsx` | 6 | 287 | ProseMirror doc traversal |

Two clusters explain almost all production `any`: **(a) the raw-`pg` boundary** — seven `extract*FromRow(row: any)` mappers plus `(i: any)` filter callbacks, i.e. TS-2, and **(b) the TipTap/Yjs boundary** — `yjsConverter.ts`, `y-protocols.d.ts`, and the three editor components, i.e. TS-3. Cluster (b) is a *defensible* external-library boundary that was never modelled; cluster (a) is internal data the codebase fully controls and has no excuse.

---

### Findings

#### TS-1 · High — `web/tsconfig.json` does not extend the root tsconfig; 102 latent type errors are invisible in the frontend

`web/tsconfig.json` has no `extends` key. `api/tsconfig.json:2` and `shared/tsconfig.json:2` both extend `../tsconfig.json`, which sets `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`. web re-declares `strict: true` standalone and therefore runs without the other three. `pnpm type-check` is green today; restoring the three flags via CLI override produces **102 errors** — 41 TS2532 "Object is possibly 'undefined'", 29 TS18048, 12 TS2322, 11 TS2345, 1 TS18047, 8 TS7030. Densest: `CommandPalette.tsx` (13), `lib/cn.ts` (12), `hooks/useSelection.ts` (12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12).

The strongest evidence that this is drift rather than intent: the repo's own reference config at `research/configs/web/tsconfig.json` **does** `extends: "../tsconfig.json"`. The shipped config diverged from the pattern the other two packages still follow.

*Impact:* these 94 index/lookup errors are precisely the "cannot read property of undefined" crash class, in the package that renders the UI. Fixing them also mechanically retires most of web's 33 corrected non-null assertions, because `noUncheckedIndexedAccess` forces real narrowing where `!` is currently papering over the same lookups.

#### TS-2 · High — the entire database-to-HTTP response path is implicitly `any`

`@types/pg` declares `query<R extends QueryResultRow = any, I = any[]>(…)`. In `api/src` production code there are **707** `pool/client/db.query(` call sites and **zero** supply the generic — so all **767** `.rows` accesses are `any`. The only translation layer between those rows and the JSON contract the frontend consumes is seven hand-written mappers, every one declared `(row: any)`:

`projects.ts:18` `extractProjectFromRow` · `projects.ts:1102` and `weeks.ts:186` `extractSprintFromRow` · `issues.ts:82` `extractIssueFromRow` · `programs.ts:12` `extractProgramFromRow` · `feedback.ts:27` `extractFeedbackFromRow` · `weeks.ts:1793` `formatStandupResponse`

Consumers stay untyped downstream — `projects.ts:959-961` and `:983-985` compute rollups with `issuesResult.rows.filter((i: any) => i.state === 'done')`.

*Why this is the headline:* most of this debt is **not** in the 102 `any` count. Only the mapper signatures and a handful of callbacks are annotated; the other ~760 property accesses are unannotated implicit `any` that `strict` cannot catch, because pg's generic defaults to `any` rather than `unknown`. A column rename or a `properties->>'…'` key typo yields `undefined` in a live API response with no compile-time signal anywhere in the chain.

#### TS-3 · High — the Yjs ↔ TipTap converter, on the document persistence path, is fully untyped

`api/src/utils/yjsConverter.ts` carries 12 `any` in 245 lines — the highest any-per-line density of any production file. Every exported signature is untyped: `yjsToJson(fragment): any`, `jsonToYjs(doc, fragment, content: any)`, `loadContentFromYjsState(yjsState): any | null`, plus the internal `extractTextWithMarks(el, inheritedMarks: any[]): any[]` and `yjsElementToJson(el): any[]`. `api/src/types/y-protocols.d.ts` adds 7 more on the awareness/sync surface underneath.

The callers are the core data path, not a side road:
- `api/src/collaboration/index.ts:118` — inside `persistDocument()`, `yjsToJson(fragment)` produces the value written to `documents.content` and fed to the hypothesis / success-criteria / vision / goals extractors.
- `api/src/routes/documents.ts:405` — `loadContentFromYjsState(doc.yjs_state)` produces the content served over REST.

*Impact:* this is the only code translating collaborative CRDT state into the durable `content` column. Given Ship's "everything is a document" model, a shape regression here silently corrupts or drops user-authored content — the product's core artifact — and nothing would fail to compile. Twelve `any`s stand between the CRDT and the database.

#### TS-4 · Medium — 236 non-null assertions on request auth context, from one optional declaration

`api/src/middleware/auth.ts:11-12` augments Express's `Request` with `userId?: string` and `workspaceId?: string`. Because they are optional, every authenticated handler re-asserts: **236** occurrences of `req.userId!` / `req.workspaceId!` across `api/src` — 82% of api's 288 corrected non-null assertions. Representative sites: `routes/projects.ts:318-319`, `routes/comments.ts:22,60-61,143-144,230-231`, `routes/workspaces.ts:214,389,490,591,673,861`.

*Impact:* one type declaration produces 15% of all tracked violations, and an `AuthenticatedRequest` type (or a typed handler wrapper applied after `requireAuth`) retires all 236 in a single edit. The correctness argument is stronger than the count: today a route registered *without* `requireAuth` type-checks identically to one with it, so a middleware-ordering mistake sends `undefined` into SQL as a user or workspace id rather than failing to compile. That is authorization scoping, not hygiene.

#### TS-5 · Medium — the `shared/` contract is bypassed; ~40 duplicate model declarations

`shared/src` exports 46 types and is itself pristine (0 `any`, 5 `as`). It is barely used: **13 of 198** web files and **13 of 109** api files import from `@ship/shared`. Meanwhile web/src declares the domain model ~40 times locally — `Project` ×5, `Sprint` ×6, `Program` ×6, `Person` ×5, `Issue` ×4, `WikiDocument` ×4, `Week` ×3 — across hooks, sidebars, comboboxes and pages. `web/src/lib/api.ts:5` even redeclares `interface ApiResponse<T>` although `shared/src/types/api.ts:2` exports `ApiResponse<T = unknown>` with a proper `ApiError`.

*Root cause and consequence:* the API responses these shapes describe are themselves untyped (TS-2), so there was never an authoritative type to import. Each component is validated against its own private guess at the contract, making cross-boundary drift structurally undetectable. Consolidating on `shared/` is what makes TS-2's typed row interfaces actually reach the frontend — done together, a backend field rename becomes a frontend compile error.

#### TS-6 · Medium — no ESLint anywhere; `pnpm lint` is a silent no-op

No `.eslintrc*` or `eslint.config.*` exists outside `node_modules`. None of `web`, `api`, `shared` defines a `lint` script, so root `package.json:25`'s `"lint": "pnpm --recursive run lint"` matches nothing and exits 0 — reporting success in CI while checking nothing. There is no `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `no-unsafe-assignment`, or `ban-ts-comment` rule in force.

*Impact:* `tsc --noEmit` is the only static gate, and it cannot flag `any` — `any` is legal TypeScript. The entire violation class measured here is invisible to the only check that runs. This finding reduces nothing on its own; it is the ratchet that keeps any reduction from regressing.

#### TS-7 · Medium — `as any` silencing mismatches on a destructive bulk mutation and a SQL parameter

- `web/src/pages/Projects.tsx:220` — `await updateProject(id, { archived_at: new Date().toISOString() } as any)` inside `handleBulkArchive`; `:233` the same in the Undo handler. `updateProject` is `(id: string, updates: Partial<Project>) => Promise<Project | null>` (`contexts/ProjectsContext.tsx:21`) and `archived_at: string | null` **is** a member of `Project` (`hooks/useProjectsQuery.ts`) — so both assertions are unnecessary today and purely defeat the check on a path that mutates many records at once.
- `api/src/routes/issues.ts:155` — `params.push(states as any)` pushes a `string[]` into a scalar-typed SQL parameter array for an `= ANY($n)` clause; the assertion hides a genuine element-type gap.

These three, plus `FileAttachment.tsx:139` (`} as any` on a TipTap `addCommands` return), are the entire production `as any` population: **154 of 158** `as any` occurrences are in test files (api 150 of 151, web 4 of 7).

*Impact:* small count, disproportionate placement. Because the Projects.tsx assertions are redundant *now*, they will silently absorb a real mismatch the first time the Project model changes — the exact failure mode that makes `as any` dangerous. Deleting them is zero-risk.

#### TS-8 · Low — 68% of flagged sites are in tests, where `as any` mocks decouple tests from the shapes they verify

176 of 260 sites matching the density pattern are in `*.test.*` / `__tests__` files, and they occupy the entire raw top-6: `transformIssueLinks.test.ts` (37), `accountability.test.ts` (32), `auth.test.ts` (24), `activity.test.ts` (21), `issues-history.test.ts` (20), `projects.test.ts` (17). Typical shapes: `vi.mocked(pool.query).mock.calls[0]![1] as any[]` and `expect((editor.commands as any).setFileAttachment)`.

*Impact:* low blast radius, but it means a route can change its response shape and its own unit test still compiles and passes — these tests protect less than their count implies. Mechanically this is the largest single reduction available (~10% of all tracked violations), and it is the one most at risk of being "fixed" superficially.

#### TS-9 · Low — web build and script files are never type-checked

`web/tsconfig.json` includes `src` only, and `web/tsconfig.node.json` — the Vite companion config that would cover build tooling — does not exist. So neither `pnpm type-check` nor the `tsc && vite build` step covers `web/vite.config.ts` or `web/scripts/generate-icon-types.ts`. The latter generates the icon-name union type the rest of web depends on, making it the least-checked file in the package.

---

### Recommended improvement plan

**Improvement target: eliminate 25% of the 1535 tracked violations ≈ 384 sites**, with real types — `any` → `unknown` without narrowing does not count.

| # | Action | Finding | Violations retired | Effort | Real-safety value |
|---|---|---|---|---|---|
| 1 | Add `"extends": "../tsconfig.json"` to `web/tsconfig.json` (keeping web's `jsx`/`moduleResolution`/`paths` overrides) and fix the 102 errors it surfaces | TS-1 | ~130 (28 web `!`+`any` sites, plus 102 previously-uncounted latent errors) | M | **Highest** — converts the main frontend crash class into compile errors |
| 2 | Introduce an `AuthenticatedRequest` type (or typed handler wrapper) so `userId`/`workspaceId` are required after `requireAuth` | TS-4 | **236** | S | High — closes an authz-scoping hole; best ratio in the plan |
| 3 | Declare row interfaces per query and type the 7 `extract*FromRow` mappers; use `pool.query<RowType>(…)` on the hot routes | TS-2 | ~45 explicit + 767 accesses brought under the compiler | L | **Highest** — the API contract stops being a guess |
| 4 | Model the TipTap JSON node type and apply it across `yjsConverter.ts` (+ `y-protocols.d.ts`) | TS-3 | ~19 | S–M | High — protects durable document content |
| 5 | Replace test `as any` with typed mock factories (`Partial<X>`-based builders for the pg pool and TipTap editor) | TS-8 | ~155 | M | Low direct, but restores regression protection |
| 6 | Delete the two redundant `as any` in `Projects.tsx`; type `params` in `issues.ts` as `(string \| string[] \| number)[]` | TS-7 | 3 | XS | Medium — removes a live trap on a bulk-destructive path |
| 7 | Consolidate the ~40 duplicate model declarations onto `@ship/shared` (start with `ApiResponse`, `Project`, `Issue`, `Sprint`) | TS-5 | ~10 direct | L | High — only way steps 3 and 4 reach the UI |
| 8 | Add ESLint + typescript-eslint with `no-explicit-any`, `no-non-null-assertion`, `no-unsafe-assignment`, `ban-ts-comment` as **errors**, plus a `lint` script in each package so root `pnpm lint` stops being a no-op | TS-6 | 0 | S | **The ratchet** — without it everything above regresses |
| 9 | Add `web/tsconfig.node.json` covering `vite.config.ts` and `web/scripts/` | TS-9 | 0 | XS | Low |

**Sequencing.** Steps 1 + 2 + 4 + 6 alone clear roughly **388 violations (~25%)** for modest effort and are all genuine typing work, so they hit the target without step 5's bulk mechanical churn. Do step 8 *first* so the reduction is defended, then 1 → 2 → 4 → 6, then 3 → 7 as the structural fix (largest payoff, largest effort), leaving 5 as optional headroom.

**Compare-mode requirements.** Re-run the identical `count.sh` invocation and the identical `tsc` override command at the fix commit, then run `pnpm type-check` and `pnpm test` (note: root `pnpm test` runs **@ship/api only** — web unit tests need `pnpm --filter @ship/web test`) to prove behavior is preserved. Sample at least 5 fixed sites showing before/after types.


---

## Bundle Size — Baseline

**Category** `bundle` · **Finding prefix** `BUN` · **Mode** baseline · **Date** 2026-07-27
**Commit** `076a18371da0a09f88b5329bd59611c4bc9536bb` (dirty: yes — only `.claude/`, `.gitignore`, `audit/`, `memory-bank/`; no application source under `api/`, `web/`, `shared/` is modified, so the measurements reflect the commit)

| | |
|---|---|
| Hardware | Apple Mac16,7 — 14 cores, 24 GB RAM (arm64) |
| OS | Darwin 25.5.0 arm64 / macOS 26.5.1 |
| Node | v23.2.0 |
| Package manager | pnpm 10.27.0 |
| Vite | 6.4.1 (declared `^6.0.5`) |
| Data volume | 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users |
| Concurrency | n/a — static analysis of build output, no runtime load |

Data volume is stamped for cross-category comparability; it does not influence a static bundle measurement.

---

### Methodology

Everything below is reproducible from the repo root. **All sizes use kB = 1000 bytes** (matching Vite's own reporting) and **gzip = `zlib.gzipSync(buf, { level: 9 })`**. Vite's build log reports gzip at zlib's default level, which is why its entry-chunk figure (589.50 kB) is ~1.5 kB larger than the level-9 figure used here (587.93 kB). Compare mode must use level 9 to stay comparable.

#### 1. Build under measurement

`pnpm build` (→ `web/package.json` `build`: `tsc && VITE_API_URL= vite build`) had already been run against this commit before the audit began; `web/dist` was left untouched and **every number in this report is measured from `web/dist`**. Dev servers (API :3001, web :5173) were running throughout and were neither used nor restarted.

#### 2. Total size, chunk map, initial-load set

Node script over `web/dist/assets`, reading each `*.js`/`*.css` file and gzipping it in-process:

```js
for (const f of readdirSync('web/dist/assets')) {
  if (!/\.(js|css)$/.test(f)) continue;
  const buf = readFileSync(join(dir, f));
  rows.push({ file: f, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });
}
```

The **initial-load set** was read directly out of the built `web/dist/index.html`: it contains exactly one `<script type="module" crossorigin src="/assets/index-C2vAyoQ1.js">` and one `<link rel="stylesheet" href="/assets/index-DJeYp5na.css">`, and **no `modulepreload` tags at all**. Initial load is therefore exactly those two files.

Chunks were classified by filename stem: `index` → entry; `Project*|Program*|Week*|Standup*` → lazy document-tab chunks; everything else lowercase-alphanumeric → USWDS icon chunks (`statusColors` is the one app module that falls outside both buckets).

#### 3. Treemap / dependency attribution

`rollup-plugin-visualizer@7.0.1` was installed as a devDependency of `@ship/web`. **The registry is blocked in this environment, but `pnpm add -D rollup-plugin-visualizer --filter @ship/web` succeeded from the local pnpm store** (`resolved 1011, downloaded 0`), so no fallback was needed. After analysis the manifests were reverted (`git checkout -- web/package.json pnpm-lock.yaml`) so the audited tree matches the commit exactly; the package stays resolvable in `web/node_modules` for compare mode.

`web/vite.config.ts` was **not** modified. Instead `audit/bundle/vite.analyze.config.ts` (committed alongside this report) mirrors its build-relevant options — `@vitejs/plugin-react`, `vite-plugin-svgr` with byte-identical `svgrOptions`, and the `@` → `web/src` alias — and adds two visualizer instances (treemap HTML + `raw-data` JSON). It imports the plugin by deep ESM path because the config lives outside `web/` and Vite bundles configs to CJS.

```bash
# run from web/ so Tailwind's content globs resolve against the same CWD as the real build
cd web && AUDIT_STATS_DIR=../audit/bundle VITE_API_URL= \
  ./node_modules/.bin/vite build \
    --config ../audit/bundle/vite.analyze.config.ts \
    --outDir <scratch>/dist-analyze --emptyOutDir
```

**Fidelity check (this is what makes the attribution trustworthy):** the analyzer build emitted the same 262 chunk names as `web/dist` and **0 size differences across all 262 files**. Output saved as `audit/bundle/stats.html` (treemap) and `audit/bundle/stats.json` (raw data).

> The first analyzer run was executed from the repo root and produced a 20,038-byte CSS file instead of 66,512 — Tailwind's `content` globs resolve against `process.cwd()`, not the config file. JS was unaffected. Re-running with `cwd=web` gave byte-for-byte parity. **Compare mode must run from `web/`.**

**Attribution maths.** `rollup-plugin-visualizer` reports `renderedLength` *before* Vite's esbuild minify pass (4,797.8 kB across all chunks vs 2,250.5 kB actually emitted), so raw visualizer numbers overstate shipped bytes by ~2.1×. Every per-dependency figure in this report is therefore **scaled per chunk**:

```
estShippedRaw(module)  = renderedLength(module) × (actualChunkRawBytes  / Σ renderedLength in chunk)
estShippedGzip(module) = gzipLength(module)     × (actualChunkGzipBytes / Σ gzipLength     in chunk)
```

These are proportional estimates, not exact per-module byte counts (minification and compression are not linear per module), but they are deterministic and reproduce exactly from `stats.json` + `web/dist`. Package names come from the pnpm path pattern `node_modules/(\.pnpm/[^/]+/node_modules/)?((@[^/]+/)?[^/]+)/`; app modules bucket by their `src/<dir>` segment.

#### 4. Unused dependencies

For each entry in `web/package.json` `dependencies`, count import sites:

```bash
grep -rE "from '(<pkg>)(/|')|import '(<pkg>)(/|')|require\('(<pkg>)'" web/src \
  --include="*.ts" --include="*.tsx" --include="*.css" | wc -l
```

Two packages scored 0 and were then verified individually rather than flagged blind:
- `@uswds/uswds` — **not unused**: consumed via the `import.meta.glob` path string at `web/src/components/icons/uswds/Icon.tsx:24`, which the grep pattern cannot see.
- `@tanstack/query-sync-storage-persister` — **genuinely unused**: 0 import sites *and* 0 modules present in any emitted chunk per `stats.json`.

#### 5. Splitting assessment

```bash
grep -rn "lazy(" web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
grep -rnE "\bimport\(" web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
grep -rnE "<Icon[[:space:]]+name=\{" web/src --include="*.tsx"   # → 0 matches
```

Icon liveness: every emitted icon chunk stem was matched against quoted lowercase literals across `web/src`, excluding the generated `types.ts` `IconName` union, `Icon.tsx` itself, `__mocks__/` and `*.test.tsx`. Because `<Icon name={…}>` has zero occurrences, all icon names are inline literals and this scan is exhaustive rather than heuristic.

#### 6. Duplicate versions

Module ids in `stats.json` were parsed for `.pnpm/<name>@<version>` segments and grouped by package name (124 packages present in the bundle).

---

### Deliverable table

| Metric | Baseline |
|---|---|
| **Total production bundle (raw / gzip)** | **2,316.96 kB / 699.75 kB** (261 JS + 1 CSS) |
| **Initial-load bundle (raw / gzip)** | **2,140.21 kB / 600.75 kB** — 92.4% of total raw, 85.9% of total gzip |
| **Largest chunk** | `assets/index-C2vAyoQ1.js` — 2,073.70 kB raw / 587.93 kB gzip |
| **Number of chunks** | 262 (1 entry JS, 1 entry CSS, 245 icon chunks, 14 document-tab chunks, 1 `statusColors`) |
| **Top 3 largest dependencies** (in the entry chunk, est. shipped) | 1. `highlight.js` 176.3 kB raw / 64.0 kB gzip (10.9% of entry gzip) · 2. `emoji-picker-react` 186.4 kB raw / 39.1 kB gzip (6.6%) · 3. `prosemirror-view` 110.2 kB raw / 30.9 kB gzip (5.3%) |
| **Unused dependencies** | `@tanstack/query-sync-storage-persister` (0 imports, 0 bundled modules). `@tanstack/react-query-devtools` is a runtime dep that ships a ~0-byte production stub — misclassified, not wasteful. |
| **Code splitting in use?** | Yes, but never at a route boundary: 13 `React.lazy` document tabs (`web/src/lib/document-tabs.tsx:52-66`), 2 dynamic imports (`web/src/components/editor/SlashCommands.tsx:377,445`), 245 lazy icon chunks (`Icon.tsx:23-26`). **0 lazy routes** — all 25 pages statically imported at `web/src/main.tsx:19-43`. |

#### Where the 587.93 kB entry chunk actually goes

| Family | est. raw | est. gzip | % of entry gzip |
|---|---:|---:|---:|
| TipTap + ProseMirror + Yjs + lib0 + y-* + linkifyjs | 726.5 kB | 208.7 kB | 35.5% |
| Application source (`web/src`) | 556.8 kB | 142.5 kB | 24.2% |
| highlight.js + lowlight | 181.8 kB | 65.8 kB | 11.2% |
| Radix + cmdk + Popper + Tippy + Floating UI | 139.8 kB | 47.8 kB | 8.1% |
| emoji-picker-react | 186.4 kB | 39.1 kB | 6.6% |
| react + react-dom + react-router | 105.2 kB | 36.7 kB | 6.2% |
| @dnd-kit | 58.8 kB | 15.1 kB | 2.6% |
| @tanstack query | 40.4 kB | 13.0 kB | 2.2% |
| diff-match-patch | 37.6 kB | 9.8 kB | 1.7% |
| everything else | 40.5 kB | 9.6 kB | 1.6% |

#### Lazy chunks (260 chunks, 176.75 kB raw / 99.0 kB gzip — 14.1% of total gzip)

| Group | Count | Raw | Note |
|---|---:|---:|---|
| USWDS icon chunks | 245 | 104.6 kB | **209 of them are never referenced by app source** (91.3 kB raw of dead deploy output) |
| Document-tab chunks | 14 | 71.8 kB | The only deliberate splitting in the app |
| `statusColors` | 1 | ~0.4 kB | Shared by lazy tabs |

---

### Findings

#### BUN-1 · High · Whole application ships in one 2.07 MB entry chunk — zero route-level code splitting
**Location:** `web/src/main.tsx:19-43` (25 static page imports), routes at `web/src/main.tsx:214-247`

`web/dist/index.html` references exactly one module script (2,073.70 kB raw / 587.93 kB gzip) and one stylesheet (66.51 kB / 12.83 kB), with **no `modulepreload` tags**. That pair is 92.4% of emitted raw bytes and 85.9% of gzip bytes. All 25 page components — including `AdminDashboardPage`, `AdminWorkspaceDetailPage`, `OrgChartPage`, `ReviewsPage`, `WorkspaceSettingsPage`, `PublicFeedbackPage`, `SetupPage`, `InviteAcceptPage` — are statically imported. Treemap attribution places 198.9 kB raw / 44.2 kB gzip of `/src/pages/*` inside the entry chunk, on top of the components those pages exclusively pull in. Lazy loading exists only for document tabs, two slash-command helpers, and icons — never at a route boundary. Vite prints its `>500 kB` warning on every build.

**Hypothesis:** `web/vite.config.ts` has no `build` block whatsoever (no `rollupOptions`, no `manualChunks`, no `chunkSizeWarningLimit`), and `main.tsx` was written with eager imports. Splitting arrived later and only for document tabs, so the pattern never propagated up to routes. Nothing in CI fails on bundle size, so the warning has been absorbed as build noise.

**Estimated impact:** This is the structural cause of BUN-2/3/4. An unauthenticated visitor on `/login` downloads the admin dashboard, org chart, reviews queue and the whole editor stack before the login form paints. Route-level `React.lazy` moves ~44 kB gzip of page modules plus their exclusive subtrees out of the entry chunk and is the prerequisite for the 20% initial-load target.

#### BUN-2 · High · TipTap + ProseMirror + Yjs editor stack is 35.5% of the entry chunk and loads on every page
**Location:** `web/src/components/Editor.tsx`, imported eagerly by `web/src/components/UnifiedEditor.tsx:3` and `web/src/pages/PersonEditor.tsx:3`

`@tiptap/*` + `prosemirror-*` + `yjs` + `lib0` + `y-prosemirror`/`y-websocket`/`y-protocols` + `linkifyjs` total **726.5 kB raw / 208.7 kB gzip est = 35.5% of the entry chunk**. Largest members: `prosemirror-view` 110.2 kB raw / 30.9 kB gzip, `yjs` 123.6 / 30.0, `@tiptap/core` 84.5 / 19.9, `lib0` 49.7 / 18.4, `prosemirror-model` 56.5 / 15.5. No dynamic-import boundary exists anywhere in Editor.tsx's import chain.

**Hypothesis:** The Editor is the centrepiece of the "everything is a document" model, so it was imported directly rather than behind Suspense. With only one chunk (BUN-1) there was no seam at which to defer it.

**Estimated impact:** `React.lazy` + `Suspense` around `Editor`/`UnifiedEditor` removes up to **208.7 kB gzip — 34.7% of the 600.75 kB initial payload**, on its own more than the 20% target. Users who never open an editor (login, dashboards, issue lists, admin) stop paying for it entirely.

#### BUN-3 · High · `createLowlight(common)` pulls 37 highlight.js grammars into the entry chunk
**Location:** `web/src/components/Editor.tsx:12` and `Editor.tsx:46`, consumed at `Editor.tsx:549`

`highlight.js` contributes 39 modules — 387.0 kB pre-minification → **176.3 kB raw / 64.0 kB gzip est, 10.9% of the entry chunk and the largest npm package in it**. `createLowlight(common)` was resolved against the installed lowlight and registers 37 grammars: arduino, bash, c, cpp, csharp, css, diff, go, graphql, ini, java, javascript, json, kotlin, less, lua, makefile, markdown, objectivec, perl, php, php-template, plaintext, python, python-repl, r, ruby, rust, scss, shell, sql, swift, typescript, vbnet, wasm, xml, yaml. `@tiptap/extension-code-block-lowlight` adds 37.3 kB raw / 12.6 kB gzip; family total 181.8 kB raw / 65.8 kB gzip (11.2%).

**Hypothesis:** `common` is lowlight's convenience export and the path of least resistance; nobody measured what 37 grammars cost. Arduino, VBNet, Objective-C, R, Lua, Perl and WASM are unlikely in a project-management wiki but are indistinguishable from the ones that matter once `common` is imported.

**Estimated impact:** Registering an explicit 6-8 languages is a one-line change worth an estimated **45-55 kB gzip**. Dynamically importing the lowlight instance when a code block first renders removes the full **65.8 kB gzip (11.0% of initial payload)** for one async boundary.

#### BUN-4 · Medium · emoji-picker-react ships in the entry chunk for a single sidebar popover
**Location:** `web/src/components/EmojiPicker.tsx:2`; sole consumer `web/src/components/sidebars/ProjectSidebar.tsx:2,295`

A single 409.2 kB pre-minification module → **186.4 kB raw / 39.1 kB gzip est, 6.6% of the entry chunk** and its 2nd-largest npm dependency. Exactly one consumer outside the wrapper: the project-icon `PropertyRow`. The import is fully static, so it downloads on every page load including `/login`.

**Hypothesis:** `EmojiPicker.tsx` is a plain re-export wrapper, and with no splitting infrastructure (BUN-1) there was no obvious place to defer it. The cost is invisible without a treemap.

**Estimated impact:** `React.lazy` on the popover body removes **39.1 kB gzip (6.5% of initial payload)** at near-zero risk — the picker is behind a click in a properties sidebar, so a Suspense fallback is imperceptible. Best effort-to-yield ratio of any finding here. (Rated Medium rather than High only because it sits below the 100 kB-gzip bar in the category severity guidance; by share of payload it is worth fixing first.)

#### BUN-5 · Medium · Icon glob emits 245 chunks, 209 never referenced, plus a 245-entry loader map in the entry chunk
**Location:** `web/src/components/icons/uswds/Icon.tsx:23-26`

245 per-icon chunks are emitted (104.6 kB raw / 74.3 kB gzip aggregate — tiny files gzip badly). Cross-referencing every icon chunk stem against string literals in `web/src` (excluding the generated `types.ts` union, `Icon.tsx`, mocks and tests): **36 referenced, 209 not** (91.3 kB raw / 64.2 kB gzip deployed but never requested). `<Icon name={…}>` has **zero** occurrences, so every icon name is an inline literal and the scan is exhaustive. Separately the generated glob map inside `Icon.tsx` is 42.7 kB pre-minification (3.6 kB gzip) and sits in the **entry** chunk.

**Hypothesis:** The whole-directory `import.meta.glob` was chosen so any icon name would "just work". Because every icon is also enumerated in the generated `types.ts` union, tree-shaking cannot narrow the glob and the build gets no signal about which 36 icons are real.

**Estimated impact:** Narrowing the glob to icons actually used — ideally generated by the same script that writes `types.ts` (`pnpm generate:icon-types`) — removes ~3 kB gzip from the entry chunk and 209 dead files from every S3/CloudFront deploy. Secondary benefit: each used icon is currently a separate lazy HTTP request on first paint, a per-icon network waterfall that a small eager map eliminates.

#### BUN-6 · Medium · No build/chunking configuration — no vendor chunk, so every app change invalidates all 588 kB gzip
**Location:** `web/vite.config.ts:46-94` (returned config has no `build` key)

The config declares only `plugins`, `resolve.alias`, `server` and `preview`. Result: one chunk holds all application code **and** all third-party code — React, react-dom, react-router, TanStack Query, TipTap/ProseMirror/Yjs, highlight.js, emoji-picker-react, Radix, dnd-kit, Tippy, Popper. Stable vendor code (105.2 kB raw / 36.7 kB gzip for react+react-dom+router alone; 726.5 kB raw for the editor stack) shares a content hash with volatile app source (556.8 kB raw / 142.5 kB gzip).

**Hypothesis:** The default Vite config was never revisited as the app grew past a handful of pages; the chunk-size warning is advisory and does not fail CI.

**Estimated impact:** A `manualChunks` vendor split does not reduce total bytes but converts ~250-300 kB gzip of stable dependency code into a long-lived cache entry: returning users after a routine deploy would download tens of kB instead of 588 kB. **Compare mode should track "bytes changed per deploy" separately**, because this fix improves that without moving `initialGzipKb`.

#### BUN-7 · Low · Unused dependency `@tanstack/query-sync-storage-persister`
**Location:** `web/package.json:25`

Zero import sites and zero modules in any emitted chunk. `web/src/lib/queryClient.ts:1-3` implements persistence itself with `idb-keyval` plus the `PersistedClient`/`Persister` **types** from `@tanstack/react-query-persist-client`. Related: `@tanstack/react-query-devtools` (`web/package.json:27`) is a runtime `dependency` statically imported at `main.tsx:6` and rendered at `main.tsx:265` — verified harmless, its production build tree-shakes to a ~0-byte no-op stub.

**Hypothesis:** Leftover from an earlier localStorage-based persistence approach replaced by the IndexedDB persister with corruption detection.

**Estimated impact:** 0 shipped bytes — hygiene and supply-chain surface, not payload. Move react-query-devtools to `devDependencies` for the same reason.

#### BUN-8 · Low · Duplicate Radix versions, both copies in the entry chunk
**Location:** `pnpm-lock.yaml` (transitive peers of `@radix-ui/react-dialog`/`react-popover`/`react-tooltip`); both copies land in `assets/index-C2vAyoQ1.js`

`@radix-ui/react-slot` resolves to both 1.2.3 and 1.2.4, `@radix-ui/react-primitive` to both 2.1.3 and 2.1.4 — all four copies bundled. Measured cost: slot 1.9 + 1.8 kB raw, primitive 0.4 + 0.3 kB raw; redundant copies ≈ **2.1 kB raw**. No other package among the 124 in the bundle has more than one version.

**Hypothesis:** The three Radix packages are pinned at different caret ranges and resolved their shared internals at different times, so pnpm kept two trees.

**Estimated impact:** ~2.1 kB raw / <1 kB gzip. Negligible but recorded so compare mode can confirm it does not grow; fix opportunistically with a pnpm resolution or by refreshing the Radix packages together.

#### BUN-9 · Low · Initial render blocks on a third-party Google Fonts stylesheet
**Location:** `web/index.html:65-67`

Two preconnects to `fonts.googleapis.com`/`fonts.gstatic.com` plus a render-blocking `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter…">`, ahead of the entry script in `<head>`. Not counted in any bundle metric above (it is not an emitted asset) but it is on the same initial-load critical path.

**Hypothesis:** Vite/Tailwind starter boilerplate that survived into a production app which is otherwise fully self-hosted (own icons, own CSS, own PWA manifest).

**Estimated impact:** Self-hosting an Inter woff2 subset removes a cross-origin round trip from first paint and drops a third-party runtime dependency from an app deployed at `ship.awsdev.treasury.gov`. No effect on the size target; flagged because it shares the critical path.

---

### Recommended improvement plan

**Target chosen: the initial-load variant — cut the initial-load bundle by 20%** (600.75 kB gzip → ≤ 480.60 kB gzip). It is the right variant because 85.9% of all shipped gzip is in a single entry chunk, and because total-bundle reduction understates the win: moving bytes into lazy chunks improves the user-visible metric without deleting a single feature.

The 15% total-bundle variant is *not* the target and should not be used to judge the fix: correctly lazy-loading the editor would leave `totalGzipKb` almost unchanged while halving what a visitor downloads.

Ordered by yield-per-unit-of-risk. Estimates are additive only where the code paths are disjoint; steps 2 and 3 overlap (lowlight is reached through the editor), so take the union, not the sum.

| # | Change | Finding | Est. initial-load gzip removed | Risk |
|---|---|---|---:|---|
| 1 | `React.lazy` the emoji picker body in `EmojiPicker.tsx` | BUN-4 | 39.1 kB (6.5%) | Very low — behind a click |
| 2 | Replace `createLowlight(common)` with an explicit language list, or dynamic-import lowlight on first code block | BUN-3 | 45-65.8 kB (7.5-11.0%) | Low — degrades to unhighlighted code at worst |
| 3 | `React.lazy` + `Suspense` around `Editor`/`UnifiedEditor` | BUN-2 | up to 208.7 kB (34.7%) | Medium — must not break Yjs/WebSocket mount timing or the "Untitled" placeholder contract |
| 4 | Route-level `React.lazy` for all non-critical routes in `main.tsx` (admin, org chart, reviews, settings, setup, invite, public feedback first) | BUN-1 | ~44 kB of page modules + exclusive subtrees | Medium — needs a Suspense fallback that does not flash the 4-panel layout |
| 5 | `build.rollupOptions.output.manualChunks` vendor split | BUN-6 | 0 kB initial, but ~250-300 kB gzip becomes cacheable across deploys | Low |
| 6 | Narrow the icon glob; drop `@tanstack/query-sync-storage-persister`; move devtools to `devDependencies`; dedupe Radix | BUN-5, 7, 8 | ~3 kB entry + 209 dead files off the CDN | Very low |

**Steps 1-3 alone are projected to take the initial load from 600.75 kB gzip to roughly 290-310 kB — a 48-52% reduction, comfortably past the 20% target.** Step 1 is a single afternoon's work and already covers a third of it.

#### Compare-mode protocol (must match exactly)

1. Build with `pnpm build` from the repo root; measure `web/dist` only.
2. Reinstall the analyzer if needed (`pnpm add -D rollup-plugin-visualizer --filter @ship/web`, resolves from the local pnpm store) and re-run **from `web/`** with `audit/bundle/vite.analyze.config.ts` — running from the repo root silently under-generates the Tailwind CSS.
3. Verify chunk-name and byte parity between the analyzer build and `web/dist` before trusting any attribution.
4. Gzip at level 9. kB = 1000 bytes.
5. Re-run the identical grep patterns in §4 and §5 above for unused-dependency and splitting counts.
6. **Prove functionality is preserved:** `pnpm test` (api vitest) **and** `pnpm --filter @ship/web test` (the root `test` script does not cover web) **and** the Playwright suite via `/e2e-test-runner` — never `pnpm test:e2e` directly. Lazy-loading that breaks a route, or removing a language grammar that a seeded document depends on, is a regression and not a win.


---

## API Response Time — Baseline

**Category** `api-perf` · **Mode** `baseline` · **Date** 2026-07-27
**Commit** `076a183` (dirty: only `.claude/`, `.gitignore`, `audit/`, `memory-bank/` — no application source)
**Data volume** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users — re-verified unchanged after the run.

---

### Methodology

**Environment.** Apple Mac16,7, 14 cores / 24 GB (arm64); Darwin 25.5.0 / macOS 26.5.1; Node v23.2.0. API at `http://localhost:3001` (`:3000` is occupied by an unrelated container), web at `:5173`. PostgreSQL 15-alpine in Docker (`ship-audit-pg`, `:5433`), pg `Pool` max 10.

**Server mode: development.** `NODE_ENV` is unset on the running API process (pid 16460, `tsx watch src/index.ts`). This matters twice over: it puts `apiLimiter` on its 1000 req/min dev branch instead of the production 100 (`api/src/app.ts:83`), and it means no production build optimisations were active. The server could not be restarted into production mode without disturbing the shared audit environment, so absolute latencies are mildly pessimistic for JS execution; the payload and query costs that dominate these numbers are unaffected.

**Query logging deliberately OFF.** Verified before measuring (`SHOW log_statement` → `none`, `SHOW log_min_duration_statement` → `-1`). Enabling it is `db-query-audit`'s job and runs *after* this audit, so it cannot skew these timings.

**Endpoint selection (config `keyEndpoints` were provisional — these are the confirmed set).** Headless Chromium (repo Playwright 1.57.0) logged in as `dev@ship.local`, ran every `userFlows` entry plus login/dashboard/docs, recording all `/api/*` requests: **63 requests across 8 flows, 49 unique**. Raw trace: `raw/frontend-trace.json`, script `raw/frontend-trace.mjs`. The six endpoints below were picked by frequency × user-visibility and written back into `audit/shipshape.config.yaml`.

Two provisional entries were removed as unreachable: `/api/search?q=...` (the `/api/search` router's only frontend consumer is `/api/search/mentions` for editor @-autocomplete; UI document search filters client-side over the full `/api/documents` payload) and `/api/dashboard` (not a route — the real ones are `/api/dashboard/my-week` and `/api/dashboard/my-focus`, both 1.2–2.9 KB).

**Auth.** `GET /api/csrf-token` → `{"token": ...}`, then `POST /api/auth/login` with `x-csrf-token` on the same cookie jar (`dev@ship.local` / `admin123`). Authenticated **once**; the resulting `session_id` + `connect.sid` cookie pair was reused as a `Cookie:` header for all 16,200 benchmark requests. Every endpoint was verified to return HTTP 200 with a real body before benchmarking.

**Load tool.** autocannon **8.0.0**, driven programmatically (`raw/bench-runner.mjs`) so that per-response latencies could be collected from the instance `response` event. autocannon's own report has no P95 (it emits p90 and p97_5), so **P50/P95/P99 are computed exactly from every measured response**, not interpolated.

**The rate limiter forced a non-standard run shape — read this before comparing.** The skill's default is ≥30 s per endpoint × concurrency. That is impossible against this app: `app.use('/api/', apiLimiter)` caps all `/api/` traffic at 1000 req/min per IP in dev. The first attempt (30 s at concurrency 10) returned **511,872 responses, every one of them HTTP 429, zero 2xx** — benchmarking that would have measured the limiter, not the API. Raising the limit would mean editing application source, which baseline mode forbids. So each combination is instead a **rate-limit-window-synchronised burst**:

1. Poll `/api/weeks` until `RateLimit-Remaining` ≥ 940 (a fresh 60 s window), sleeping on `RateLimit-Reset`.
2. Fire a fixed burst of **900 requests at the target concurrency** (one discarded 80-request warmup per endpoint, sharing the c=10 window; budget per window = 1 probe + 80 + 900 = 981 < 1000).
3. Assert the burst was **100% 2xx** with zero errors, or discard and retry in the next window.

All 18 combinations passed on the first clean window: **16,200 requests, 16,200 × HTTP 200, 0 errors, 0 non-2xx.** Trade-off to carry into compare mode: each sample is 900 requests over ~1–3 s rather than 30 s, so sustained-load effects (GC pressure, connection churn) are under-sampled, and P99 rests on 9 observations. P50/P95 are solid. **Compare mode must reproduce this exact shape** — same 900-request bursts, same window synchronisation, same order.

**Throughput caveat.** autocannon samples at 1 s granularity, so its own `req/s` is floored at ~891 for bursts that finish in under a second. The req/s column below is therefore derived by Little's Law (`concurrency ÷ mean latency`) from the measured mean, which is exact for all rows.

**Reproduce:**
```bash
# 1. verify data volume
docker exec ship-audit-pg psql -U ship -d ship_dev -c \
  "SELECT document_type, count(*) FROM documents GROUP BY 1 ORDER BY 2 DESC;"
# 2. confirm query logging is off
docker exec ship-audit-pg psql -U ship -d ship_dev -c \
  "SHOW log_statement; SHOW log_min_duration_statement;"
# 3. authenticate once into a cookie jar, then
node audit/api-perf/raw/bench-runner.mjs      # writes raw/*.json + raw/_all.json
```

---

### Deliverable table

6 endpoints × 3 concurrency levels. **P95 at concurrency 25 is the headline column.** Latency in ms; req/s derived (Little's Law); zero errors and zero non-2xx everywhere.

| Endpoint | Conc. | P50 | **P95** | P99 | req/s | errors |
|---|---|---|---|---|---|---|
| `GET /api/documents?type=wiki` | 10 | 5.50 | **8.45** | 13.43 | 1862 | 0 |
| `GET /api/documents?type=wiki` | 25 | 12.79 | **17.33** | 39.16 | 1897 | 0 |
| `GET /api/documents?type=wiki` | 50 | 27.35 | **44.93** | 63.08 | 1715 | 0 |
| `GET /api/issues` | 10 | 28.76 | **38.78** | 43.20 | 353 | 0 |
| `GET /api/issues` | 25 | 74.19 | **94.47** | 121.73 | 331 | 0 |
| `GET /api/issues` | 50 | 150.14 | **182.00** | 208.36 | 329 | 0 |
| `GET /api/documents` | 10 | 24.20 | **34.01** | 40.01 | 413 | 0 |
| `GET /api/documents` | 25 | 59.58 | **75.75** | 99.33 | 415 | 0 |
| `GET /api/documents` | 50 | 123.40 | **146.54** | 162.06 | 406 | 0 |
| `GET /api/documents/:id` | 10 | 2.60 | **4.84** | 11.79 | 4049 | 0 |
| `GET /api/documents/:id` | 25 | 6.28 | **9.16** | 32.89 | 3765 | 0 |
| `GET /api/documents/:id` | 50 | 14.28 | **46.16** | 52.05 | 3034 | 0 |
| `GET /api/team/assignments` | 10 | 7.02 | **11.05** | 20.99 | 1420 | 0 |
| `GET /api/team/assignments` | 25 | 17.31 | **22.89** | 46.27 | 1393 | 0 |
| `GET /api/team/assignments` | 50 | 33.90 | **57.28** | 72.54 | 1396 | 0 |
| `GET /api/weeks` | 10 | 4.29 | **7.06** | 19.07 | 2336 | 0 |
| `GET /api/weeks` | 25 | 10.21 | **14.18** | 46.41 | 2285 | 0 |
| `GET /api/weeks` | 50 | 21.76 | **41.80** | 54.77 | 2131 | 0 |

#### Payload sizes (measured; `gzip -9` of the identical body)

| Endpoint | Raw | gzip | Ratio |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | 24,627 B | **15.4x** |
| `GET /api/documents` | 293,891 B | 27,749 B | 10.5x |
| `GET /api/documents?type=wiki` | 37,868 B | 4,559 B | 8.3x |
| `GET /api/team/assignments` | 22,655 B | 1,750 B | 12.9x |
| `GET /api/weeks` | 4,351 B | 918 B | 4.7x |
| `GET /api/documents/:id` | 1,041 B | — | — |

No response carries `Content-Encoding`; every one of these ships at its raw size.

#### Reading the numbers

**Nothing is slow yet at this data volume.** The worst headline figure is `GET /api/issues` at P95 94.5 ms (c=25) — an order of magnitude under the 1 s threshold that would make latency itself a High finding. Ship's API is comfortably fast against 500 documents.

**Latency scales linearly with concurrency, everywhere.** P50 ratios from c=10 to c=50 (a 5x increase) are 4.83x, 4.98x, 5.08x, 5.10x, 5.22x, 5.50x. Nothing grows superlinearly, so there is no lock convoy or contention pathology to chase — the single Node process (no clustering in `api/src/index.ts`) is simply throughput-saturated, and latency is queueing.

**Payload size, not query cost, separates the endpoints.** The two 300–380 KB endpoints plateau at ~330–415 req/s while the small ones sustain 1,400–4,000 req/s. `GET /api/issues` batches its associations correctly (`getBelongsToAssociationsBatch`, one `ANY($1)` query — no N+1) and touches only 254 rows, so the ~3x throughput penalty is serialization and socket writes, not the database.

**So the real findings are structural, not latency.** They are about what happens as data grows, what the wire costs a remote user, and — first — a limiter that makes all of this academic in production.

---

### Findings

#### API-1 · Critical · Rate limiter caps production at 100 req/min per IP while one page view costs 4–16 requests; 429s are never retried, so throttled writes are dropped

**Location** `api/src/app.ts:81-88` (`apiLimiter`), `:137`; `web/src/lib/queryClient.ts:141-149` (query retry), `:152-159` (mutation retry)

**Evidence.** 30 s at concurrency 10 against `/api/documents?type=wiki` returned **511,872 responses, 100% HTTP 429, zero 2xx** (`statusCodeStats: {"429":{"count":511872}}`). The limiter — not the application — is the binding throughput constraint, and this audit's entire benchmark had to be rebuilt around it. The browser trace measured **63 `/api` requests across 8 flows** (49 unique): login 16, dashboard 12, document view 10, sprint board 10. Production evaluates `max: 100` per 60 s per IP (`app.ts:83`, with `isTestEnv` and `isDevEnv` both false). Client-side, `grep -rn "429" web/src` returns **zero matches**, and both retry predicates return `false` for every status in `[400,500)`.

**Hypothesis.** The ceiling was sized as if one page view were one request, but this SPA issues 4–16 XHRs per navigation — so a single user exhausts the window after roughly **6–10 navigations per minute**. In the deployed topology (CloudFront → Elastic Beanstalk; `trust proxy 1` at `app.ts:93`) every user behind one agency NAT egress collapses into a single rate-limit key, so a team shares one 100 req/min budget collectively. Because react-query treats 429 as a non-retryable 4xx **for mutations as well as queries**, a throttled `PATCH` of document metadata (title, state, priority, assignee) fails permanently with only a toast. Yjs editor body text survives — `/collaboration` WebSocket traffic is not behind the `/api/` limiter — but metadata writes are not so lucky.

**Estimated impact.** Raising the limit to a per-page-view-realistic value, or keying it per session rather than per IP, removes an artificial ~1.7 req/s production ceiling and stops silent write loss. Until then **no latency optimisation is observable in production**, because the limiter bounds throughput far below anything measured here (299–4,049 req/s). *Cross-reference: the dropped-write path should be reproduced end-to-end by `error-handling-audit` (ERR).*

#### API-2 · High · `GET /api/issues` returns 380 KB with no pagination, 72% of it a `content` field the list UI never reads

**Location** `api/src/routes/issues.ts:126` (`SELECT d.content`), `:99` (`content: row.content`), `:215-224` (`ORDER BY` with no `LIMIT`/`OFFSET`)

**Evidence.** Measured payload **379,907 bytes** for 254 issues — the slowest endpoint at every level (P95 38.8 / 94.5 / 182.0 ms; P99 208.4 ms at c=50), and the only one whose throughput floor sits at ~330 req/s. `grep -n "LIMIT\|OFFSET" api/src/routes/issues.ts` returns no matches. In Postgres, `content` is **138 kB of the 191 kB (72.3%)** of live issue text. The list UI never dereferences it: grep for `.content` across `web/src/components/IssuesList.tsx` and `web/src/pages/Issues.tsx` yields only unrelated prop names and comments.

**Hypothesis.** Serialization-bound, not query-bound. The handler batches associations correctly (`api/src/utils/document-crud.ts:148-180`, one `ANY($1)` query — no N+1) over just 254 rows, so the ~330 req/s ceiling and the clean linear latency curve point at `JSON.stringify` plus socket writes of 381 KB per response on a single Node process.

**Estimated impact.** Dropping `content` from the list projection shrinks the payload ~2.6x and should cut **P95 at c=25 from 94.5 ms to roughly 35–40 ms (~55–60%)** — clearing the ≥20% target on this endpoint alone. Adding `LIMIT`/`OFFSET` additionally caps growth, currently linear: at 10x seed volume this response is ~3.8 MB.

#### API-3 · High · No response compression anywhere; the largest payload ships 15.4x larger than it needs to

**Location** `api/src/app.ts` (no `compression` middleware registered); `api/package.json` (`compression` is not a dependency)

**Evidence.** `curl -H 'Accept-Encoding: gzip, deflate, br'` against `/api/issues` returns `Content-Length: 379907` and **no `Content-Encoding` header** — the body is sent uncompressed even when the client advertises support. `gzip -9` of the identical body is 24,627 bytes (**15.4x**). See the payload table above for the other four.

**Hypothesis.** The middleware was never added. The gap is invisible locally and in this benchmark because loopback transfer is effectively free, so it never surfaces in a localhost latency number — it costs only real users on a WAN link.

**Estimated impact.** On a 10 Mbps agency link the `/api/issues` body alone is ~304 ms of transfer, dropping to ~20 ms with gzip. **Important for compare mode:** enabling gzip will *not* reduce P95 over loopback and may raise it slightly (compression CPU added, transfer time already ~0). Validate this fix by payload size or over a bandwidth-shaped link, never by re-running this localhost benchmark. Also confirm whether CloudFront edge compression already masks part of it in the deployed stack.

#### API-4 · Medium · Command palette (cmd+K) re-downloads the entire 294 KB corpus on every open, bypassing the cache

**Location** `web/src/components/CommandPalette.tsx:143-166`

**Evidence.** The `useEffect` is keyed on `[open]` and calls plain `apiGet('/api/documents')` into local `useState`, bypassing the `queryClient` (`staleTime` 5 min, `gcTime` 24 h) entirely — every open is a cold fetch. Measured payload **293,891 bytes for all 500 documents**; the browser trace confirms exactly one such request on opening the palette. P95 34.0 / 75.7 / 146.5 ms. `GET /api/documents` has no `LIMIT`/`OFFSET` (`api/src/routes/documents.ts:94-154`).

**Hypothesis.** Search is client-side filtering over the full corpus (`groupedDocuments` useMemo at `:169`) rather than a server-side query. A `/api/search` router exists, but its only frontend consumer is `/api/search/mentions` for editor @-autocomplete (`web/src/components/editor/MentionExtension.ts:23`), so no server-side document search is reachable from the UI.

**Estimated impact.** Cost grows linearly with workspace size — at 10x seed volume each cmd+K press transfers ~2.9 MB. Routing the palette through the existing search router plus react-query caching removes a 294 KB fetch from an interactive keystroke path and returns 1 of the 100 req/min production budget per open.

#### API-5 · Medium · Dashboard issues one request per active week for standups (client-side N+1)

**Location** `web/src/pages/Dashboard.tsx:69-83`

**Evidence.** `Promise.all` over `activeWeeks` issuing `GET /api/weeks/${sprint.id}/standups` per week. The dashboard trace shows 12 API requests, **5 of them this fan-out**, each returning exactly 2 bytes (`[]`) — 10 bytes of useful payload spread over 5 round trips. The parent `GET /api/weeks` is itself cheap (4,351 B, P95 14.2 ms at c=25). Request count grows with the number of active weeks.

**Hypothesis.** No batch endpoint for standups-by-week exists, so the client loops. Each iteration re-enters `authMiddleware`, paying the full per-request auth cost (API-6) for a 2-byte result.

**Estimated impact.** A single `GET /api/weeks/standups?week_ids=...` collapses 5 round trips into 1, cutting the dashboard from 12 to 8 requests (−33%) and reclaiming budget against API-1. *Cross-reference: the server-side query-count counterpart belongs to `db-query-audit` (DB).*

#### API-6 · Medium · Every authenticated request — including every GET — performs a session write

**Location** `api/src/middleware/auth.ts:203-206` (`UPDATE sessions SET last_activity`), `:126-133` (session SELECT); `api/src/middleware/visibility.ts:6-24` (per-handler `isWorkspaceAdmin`)

**Evidence.** Every authenticated request runs `SELECT` session `JOIN` users, then **unconditionally** `UPDATE sessions SET last_activity = $1 WHERE id = $2`, and each handler then runs its own `isWorkspaceAdmin`/`getVisibilityContext` SELECT — at least 3 queries before any endpoint work. Measured floor: `GET /api/documents/:id` returns only 2,195 bytes from one indexed primary-key lookup, yet still costs P50 2.6 ms / P95 4.8 ms at c=10 and P50 14.3 ms / P95 46.2 ms at c=50. Latency scales linearly on all six endpoints (4.83x–5.50x for 5x concurrency), so this is saturation, **not** lock convoy — the shared-row write is not yet the binding constraint at this volume.

**Hypothesis.** Sliding-session bookkeeping is inline and unthrottled, even though the cookie refresh immediately below it (`auth.ts:209-212`) is already throttled to 60 s. The pg pool is capped at `max: 10` in dev / 20 in production (`api/src/db/client.ts:20`), so at concurrency 50 requests queue for connections while each holds one to perform a write that changes nothing meaningful 99% of the time.

**Estimated impact.** Throttling the `last_activity` write to the same ~60 s threshold already used for the cookie removes one write per request, roughly a third of the query count on cheap endpoints, and stops every GET from generating WAL. It is also a prerequisite for ever serving reads from a replica. *Cross-reference: per-flow query counts belong to `db-query-audit` (DB).*

---

### Recommended improvement plan

Target for a future `compare` run: **≥20% P95 reduction on at least 2 endpoints**, under identical conditions, root cause documented per bottleneck.

| # | Change | Endpoint(s) moved | Predicted P95 @ c=25 | Measurable on loopback? |
|---|---|---|---|---|
| 1 | Drop `content` from the `/api/issues` list projection (`issues.ts:126`, `:99`) | `GET /api/issues` | 94.5 ms → ~35–40 ms (**~55–60%**) | **Yes** |
| 2 | Paginate `/api/documents` (`LIMIT`/`OFFSET` + total count) and stop the palette fetching the whole corpus | `GET /api/documents` | 75.7 ms → ~20–25 ms (**~65%**) | **Yes** |
| 3 | Throttle the `last_activity` write to 60 s (API-6) | all six, cheap ones most | ~10–20% on `/api/documents/:id`, `/api/weeks` | Partially |
| 4 | Add `compression` middleware (API-3) | all | no loopback change — 15.4x wire reduction | **No** — verify by payload size |
| 5 | Re-scale or re-key `apiLimiter` (API-1) | none directly | unblocks every other gain in production | No — correctness fix |

**Sequencing.** Items 1 and 2 alone clear the improvement target and are pure deletions of unused data — lowest risk, highest measured return. Item 5 is the one to ship first regardless of what the latency numbers say: it is a Critical correctness issue (dropped writes), and while it stands, none of items 1–4 can help a production user who is being throttled before the request is ever served.

**For whoever runs compare mode.** Re-verify the 500/20 row counts; reuse `raw/bench-runner.mjs` unchanged (900-request window-synchronised bursts, autocannon 8.0.0, concurrency 10/25/50, same endpoint order); confirm every burst is 100% 2xx; keep PostgreSQL query logging off; and expect item 4 to show *no* improvement here by design.


---

## Database Query Efficiency — Baseline

**Category:** `db-query` · **Commit:** `076a183` (dirty: audit/, memory-bank/, .claude/, .gitignore only — no application source) · **Date:** 2026-07-27

**Environment:** Apple Mac16,7, 14 cores / 24 GB RAM (arm64) · Darwin 25.5.0 / macOS 26.5.1 · Node v23.2.0 · PostgreSQL **15.13**-alpine in Docker on `:5433`
**Data volume:** 500 documents (254 issue / 91 wiki / 35 sprint / 32 weekly_plan / 27 weekly_retro / 20 person / 15 weekly_review / 15 project / 6 standup / 5 program), 20 users, 813 document_associations — verified immediately before and after the run.

> **Version-skew caveat.** `docker-compose.local.yml` declares `postgres:16`, but Docker Hub pulls are blocked in this environment and only `postgres:15-alpine` was cached. Every EXPLAIN plan and planner cost estimate below reflects **PG15**. A compare run must use the same major version or the plans are not comparable.

---

### Methodology

Every number below comes from one of four commands. Nothing is eyeballed.

**1. Statement logging (scaffolding — reverted at end of run)**

```bash
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_statement='all';"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_min_duration_statement=0;"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "ALTER SYSTEM SET log_line_prefix='%m [%p] ';"
docker exec ship-audit-pg psql -U ship -d ship_dev -c "SELECT pg_reload_conf();"
# ... measure ...
# reverted with ALTER SYSTEM RESET on all three + pg_reload_conf()
# verified back to log_statement=none, log_min_duration_statement=-1
```

**2. Per-flow capture.** `audit/db-query/raw/flow-capture.mjs` drives headless Chromium (repo Playwright 1.57.0), logged in as `dev@ship.local`, and brackets each flow with a marker statement (`SELECT 'DBAUDIT_MARK START <flow> iter<n>'`) emitted on its own `pg` connection so the log can be sliced exactly. Each flow runs **twice**; the page is parked on `about:blank` for 2.5 s between flows so no stray requests bleed across a slice.

```bash
DOC_ID=d8a6222f-ebfd-4273-912e-95daf1c518f5 node audit/db-query/raw/flow-capture.mjs \
  > audit/db-query/raw/flow-requests.json
docker logs ship-audit-pg --since "$(cat audit/db-query/raw/capture-start.txt)" \
  > audit/db-query/raw/pg-statements.log
node audit/db-query/raw/parse-log.mjs audit/db-query/raw/pg-statements.log
```

`parse-log.mjs` folds multi-line log entries, counts `statement:` and `execute <unnamed>:` entries as queries (never the `parse`/`bind` protocol lines), pairs each with the following bare `duration:` line on the same PID, excludes the marker connection's own PIDs, and groups by statement template for N+1 detection. Templates are already normalised because the app uses parameterised SQL (`$1`, `$2`) throughout.

**3. Endpoint isolation.** The six now-CONFIRMED `keyEndpoints` were probed serially with a session-cookie `curl` jar, 3 iterations each, bracketed by the same markers — because the frontend's client cache means some endpoints never re-fire during a flow.

**4. EXPLAIN ANALYZE.** `audit/db-query/raw/explain.sql`, run via `docker exec ... psql -f`, using the exact parameter values Postgres logged (workspace `e8d25b0f…`, user `2a56903a…`, `isSuperAdmin = TRUE`). Full plans in `audit/db-query/raw/explain-plans.txt`.

**Raw artifacts:** `raw/pg-statements.log` (964 KB, 11 369 lines), `raw/flow-queries.json` (per-flow slices), `raw/flow-requests.json` (HTTP trace), `raw/top-statements.json`, `raw/explain-plans.txt`, plus the three harnesses.

**A note on the two iterations.** Iteration 1 is a cold client cache, iteration 2 warm. Unusually, iteration 2 is sometimes *lower* — the frontend's cache survives a full page reload, so warm loads skip some endpoints entirely. Per the skill's convention the steady-state (iter 2) figure is the headline, but the cold figure is the one a first-time visitor actually pays, so both are reported.

---

### Deliverable table — per user flow

| User flow | Total queries (steady / cold) | Slowest query (ms) | Slowest statement | Auth boilerplate | N+1 detected? |
|---|---|---|---|---|---|
| Load main page | 26 / 26 | 1.471 | `UPDATE sessions SET last_activity` | 18 (69%) | No |
| View a document | 45 / 44 | 1.994 | `UPDATE sessions SET last_activity` | 27 (60%) | No — but 3x duplicate `/backlinks` (DB-9) |
| List issues | 17 / 17 | 1.183 | `UPDATE sessions SET last_activity` | 16 (**94%**) | No |
| Load sprint board | 51 / 65 | **4.764** | `UPDATE sessions SET last_activity` | 34 (67%) | No — but 2x duplicates on 3 endpoints (DB-9) |
| Load week dashboard | 42 / 58 | 4.133 | `UPDATE sessions SET last_activity` | 31 (74%) | **YES** — 5 weeks x 5 queries (DB-4) |
| Search content | 44 / 30 | 3.193 | `SELECT … FROM documents WHERE workspace_id …` | 23 (52%) | No |

The single most important column is the last-but-one. **In five of six flows the slowest statement is not a query at all — it is the auth middleware's session write**, and between 52% and 94% of every flow's queries are session/membership boilerplate rather than application data.

`Load week dashboard` is not in `config.userFlows`; it was added to capture at the SQL layer the `/api/weeks` → per-week standups fan-out that api-perf flagged as suspected N+1 (**API-4**). It is now confirmed.

### Deliverable table — per confirmed keyEndpoint (isolated, steady state)

| Endpoint | Queries | of which auth | Slowest (ms) | Response bytes |
|---|---|---|---|---|
| `GET /api/issues` | 5 | 3 | 2.782 | 379 907 |
| `GET /api/documents` | 4 | 3 | 1.324 | 293 953 |
| `GET /api/documents?type=wiki` | 4 | 3 | 0.268 | 37 930 |
| `GET /api/documents/:id` | 4 | 3 | 0.077 | 4 091 |
| `GET /api/team/assignments` | 6 | 3 | 0.655 | 22 655 |
| `GET /api/weeks` | 5 | 3 | 0.713 | 4 351 |

Payload sizes reproduce api-perf's trace byte-for-byte, confirming both audits measured the same dataset. Note that **no endpoint runs more than 3 data queries** — the query layer batches associations correctly with `= ANY($1)`. The inefficiency is not in how many data queries the app runs; it is in the fixed 3-query auth toll, in planning overhead, and in how much each query drags back.

### Top-5 slowest statements

| # | Statement | Max ms observed | n in capture | Plan red flag |
|---|---|---|---|---|
| 1 | `UPDATE sessions SET last_activity = $1 WHERE id = $2` | **4.764** | 121 | Isolated exec is only 0.178 ms — the in-flight cost is row-lock + WAL contention. `Buffers: shared hit=11 dirtied=1` **on every read request** |
| 2 | `SELECT … FROM documents WHERE workspace_id … ORDER BY position, created_at` (`/api/documents`) | 3.193 | 5 | Seq Scan 500 rows; top-of-plan quicksort, 190 kB |
| 3 | `SELECT d.id … d.content … FROM documents d LEFT JOIN users … LEFT JOIN documents person_doc …` (`/api/issues`) | 2.782 | 3 | **Planning 1.543 ms vs Execution 0.494 ms (3.1x)**; Seq Scan 500 rows → 254; `width=1023` because of `d.content` |
| 4 | `SELECT da.document_id … WHERE da.document_id = ANY($1)` (issue associations) | 1.206 | 3 | **rows=25 estimated vs 707 actual (28x under)**; index `idx_document_associations_document_id` unused |
| 5 | `SELECT d.id … (8 correlated subqueries) … WHERE d.document_type = 'sprint'` (`/api/weeks`) | 0.944 | 4 | 8 SubPlans x loops=5; SubPlans 7 & 8 **Seq Scan document_associations, Rows Removed by Filter: 803, loops=5**; 1182 buffers for 5 rows |

**Aggregate planning tax across the whole capture:** 622 parse entries (91.5 ms) + 622 bind entries (169.5 ms) = 261.0 ms, against 684 execute entries totalling 167.2 ms. **61.0% of all database time was spent planning queries, not running them.** Every entry is logged as `parse <unnamed>` / `bind <unnamed>` — no plan is ever reused.

### Missing-index candidates

| Column set | Evidence | Verdict |
|---|---|---|
| `documents (workspace_id, ticket_number) WHERE document_type='issue'` | `issues.ts:371`; EXPLAIN → `Seq Scan … Rows Removed by Filter: 499`, 66 buffers to return 1 row | **Add** (DB-7) |
| `documents (workspace_id, updated_at DESC)` | `ORDER BY … updated_at DESC` in 7 route modules; both list plans end in an unsupported quicksort | Add with pagination (DB-10) |
| `document_associations (document_id)` — exists but unused | `= ANY($1)` defeats the estimate (28x under), planner picks Seq Scan | Rewrite query, not add index (DB-8) |
| `documents (workspace_id, document_type) WHERE archived_at IS NULL AND deleted_at IS NULL` | `idx_documents_active` **already exists** and matches the hot predicate exactly; planner correctly prefers Seq Scan at 66 pages | No action — re-check above ~10k rows |
| `documents.created_by` | Repo-mapping lead said "missing"; in fact covered by `idx_documents_visibility_created_by (visibility, created_by)`, which is how the visibility filter uses it | **Lead corrected — no action** |
| GIN on `documents.properties` | `idx_documents_properties` exists; hot paths use `properties->>'x'` scalar extraction, which GIN cannot serve | Not a gap, but see DB-3 — no expression statistics means bad estimates |

`documents` carries **13 indexes** on a 920 kB / 500-row table. That is itself a cost: every plan must consider all of them, which is a direct contributor to DB-3.

---

### Findings

Ranked by measured impact. One Critical outranks the rest combined.

#### DB-1 — Critical — `pnpm db:migrate` silently skips 32 of 42 migrations and exits 0
`api/src/db/migrate.ts:103-111` · trigger: `migrations/010_oauth_state.sql:8` vs `schema.sql:90`

Handed over from the prerequisite gate and **independently reproduced here** on a throwaway database (`ship_migrate_repro`, created and dropped inside the audit container; the audited DB was re-verified at 500/20/813 afterwards):

```
Running migration: 010_oauth_state.sql
Database schema already exists, continuing...
EXIT CODE: 0
→ schema_migrations: 10 rows (001-009 + 007b), against 42 migration files
```

Running it a second time produced identical output and still 10 rows — it does not self-heal. `schema.sql:90` creates `oauth_state` with `IF NOT EXISTS`; `010_oauth_state.sql:8` then creates it *without*, throws `relation "oauth_state" already exists`, and the catch at `migrate.ts:106` matches **any** message containing `already exists`, logs "Database schema already exists, continuing…", and returns normally — abandoning the loop at `migrate.ts:69-95`.

The reason this has gone unnoticed is worth stating precisely, because it also bounds the blast radius. On a *fresh* database the result looks perfect: a column-level diff of the deploy-path DB against a fully-migrated DB found **163 identical columns and zero differences**, because `schema.sql` already carries the end-state schema. But `schema.sql` contains 17 `CREATE TABLE`, 59 `CREATE INDEX`, one function and one trigger — and **zero `ALTER TABLE` and zero DML**. The 31 unexecuted files contain **19 `ALTER TABLE` and 42 DML statements**. Those are the *only* mechanism by which an already-existing database is ever changed.

Migrations run automatically on deploy (per CLAUDE.md). So against real prod or shadow — the one case that isn't already at the end state — the deploy prints success, exits 0, and silently skips every schema alteration and every data backfill, including 027/029 (drop legacy association columns), 033 (sprint→week rename) and 014b/028/034 (backfills). This is a live data-integrity risk and it means the migration sequence is effectively untested. It is also a prerequisite for trusting the rest of this report: it determines whether the schema measured here is the schema production actually has.

#### DB-2 — High — every request writes to `sessions`; 52-94% of per-flow queries are auth boilerplate
`api/src/middleware/auth.ts:205-208`, `auth.ts:126-133`, `api/src/middleware/visibility.ts:7-11`

Every authenticated request runs three queries before touching application data: a session+user `SELECT`, a `SELECT role FROM workspace_memberships`, and an unconditional `UPDATE sessions SET last_activity`. That is 3 of the 4-6 queries on every isolated keyEndpoint, 16 of 17 queries on `List issues` (94%), and 34 of 51 on `Load sprint board`.

The `UPDATE` is the sharp edge. It ran 121 times during the capture and is the **slowest statement in five of the six flows** (peak 4.764 ms), even though EXPLAIN puts its isolated execution at 0.178 ms — the gap is row-lock and WAL contention, since a single page load fires 5-13 requests that all `UPDATE` the same one session row. Every read request dirties a buffer.

The fix is already written, three lines below the bug. `auth.ts:210-221` throttles the *cookie* refresh to once per 60 s with the comment "throttled to avoid overhead"; the same threshold was simply never applied to the database write.

#### DB-3 — High — 61% of all database time is planning, not execution
`api/src/db/client.ts` + all inline `pool.query(text, values)` call sites

Across the full capture: parse 91.5 ms + bind 169.5 ms = **261.0 ms**, versus execute **167.2 ms**. Every log entry is `parse <unnamed>` / `bind <unnamed>` — Postgres's marker for a plan it will throw away immediately. Confirmed independently on `/api/issues`, three consecutive steady-state runs:

```
Planning Time: 2.160 ms   Execution Time: 0.594 ms
Planning Time: 1.582 ms   Execution Time: 0.495 ms
Planning Time: 1.543 ms   Execution Time: 0.494 ms
```

The planner costs **3.1x the executor** and touches 674 buffers to execution's 78. node-postgres sends every query unnamed, so nothing is ever cached. The `documents` table amplifies it: 13 indexes to consider on every plan, plus JSONB expression predicates (`properties->>'priority'`, `properties->>'assignee_id'`) for which no expression statistics exist.

#### DB-4 — High — week dashboard N+1: one request per active week, 25 of the flow's 42 queries
`web/src/pages/Dashboard.tsx:69-85` (client fan-out) · handler `api/src/routes/weeks.ts:1833-1887`

`GET /api/weeks` returns 5 active weeks; `Dashboard.tsx:69` then maps them to one `fetch('/api/weeks/${sprint.id}/standups')` each inside a `Promise.all`. At the SQL layer that is 5x the sprint access check, 5x the standups `SELECT`, and 5x the DB-2 auth trio — **25 of the flow's 42 steady-state queries (60%)**.

The server handler is blameless: it already batches issue-link lookups (`batchLookupIssues`, `weeks.ts:1872`). The N+1 is entirely client-side, and the waste compounds — the per-week query at `weeks.ts:1856` has no `LIMIT` and returns each standup's full `content`, yet `Dashboard.tsx:92` immediately discards everything but the 10 most recent across all weeks. Cost grows linearly with active weeks: 5 today, +5 queries and +1 round trip for each new one.

This is the SQL-layer confirmation of api-perf's **API-4**, which flagged the same fan-out from the HTTP side. Cross-reference, not a duplicate.

#### DB-5 — Medium — `/api/issues` fetches every issue's full document body for a list view
`api/src/routes/issues.ts:126`

For the 254 live issue documents, `sum(pg_column_size(content))` = **158 kB — 64.5% of the total row bytes**. EXPLAIN shows the consequence in the plan: `width=1023` per row, against `width=300` for the `/api/documents` projection that omits `content`. All of it is forced through the sort node, serialised, and shipped; the list UI never renders it.

This is the SQL-layer confirmation of api-perf's **API-2** (380 KB unpaginated, 72.3% content), with on-disk byte figures. Cross-reference, not a duplicate. The list and detail views share a single SELECT projection; only the detail view needs the body.

#### DB-6 — Medium — `/api/weeks` aggregate: 8 correlated subplans per row, two seq-scanning per row
`api/src/routes/weeks.ts` · plan Q4 in `raw/explain-plans.txt`

Returns 5 rows, touches **1182 shared buffers** — 236 per row. Eight SubPlans each run with `loops=5`. SubPlans 7 and 8 (`retro_outcome`, `retro_id`) each do `Seq Scan on document_associations` with `Rows Removed by Filter: 803, loops=5` — reading all 813 association rows five times apiece, despite `idx_document_associations_related_type` being available and correctly chosen by SubPlans 2/3/4/6 for the identical predicate. SubPlans 7 and 8 differ only in which column they return from the same row, so that scan happens twice over.

An N+1 folded into one SQL statement. Execution is 1.192 ms today only because the table is 416 kB and fully cached; the plan shape is sprints x associations.

#### DB-7 — Medium — no index on `documents.ticket_number`
`api/src/routes/issues.ts:371`

```
Seq Scan on documents d
  Filter: ((ticket_number = 42) AND (workspace_id = …) AND (document_type = 'issue'))
  Rows Removed by Filter: 499
  Buffers: shared hit=66
```

500 rows examined to return 1, on the issue-permalink path. Cost grows with *total* document count, not issue count. Confirms the repo-mapping lead for `ticket_number`; the same lead's `created_by` claim is corrected above.

#### DB-8 — Medium — planner underestimates the association batch by 28x
`api/src/routes/issues.ts` association batch · plan Q3

`rows=25` estimated, `rows=707` actual, `Rows Removed by Filter: 106`, `idx_document_associations_document_id` unused. Postgres cannot see the cardinality of a parameterised array at plan time and guesses a fixed low selectivity. The batch itself is *correct design* — it is exactly what keeps `/api/issues` at 5 queries instead of 255 — but it is planned on a bad estimate that will keep selecting seq scans and nested loops as the table grows.

#### DB-9 — Medium — flows fire byte-identical requests two and three times
Sprint board and document view

Steady-state, from `raw/flow-requests.json`:

| Flow | Duplicated request | Times | Bytes each |
|---|---|---|---|
| Load sprint board | `GET /api/team/assignments` | 2x | 22 655 |
| Load sprint board | `GET /api/team/grid` | 2x | 5 948 |
| Load sprint board | `GET /api/team/projects` | 2x | 3 403 |
| View a document | `GET /api/documents/:id/backlinks` | 3x | 2 |

Each duplicate re-runs the endpoint's full query set *including* the DB-2 auth trio — which is how the sprint board reaches 51 queries. api-perf's independent trace shows the same doubling, so it reproduces across harnesses.

#### DB-10 — Low — no index on `documents.updated_at`
`ORDER BY … updated_at DESC` in `issues|documents|weeks|projects|programs|dashboard|search.ts`

Both list plans end in an unsupported top-of-plan quicksort (270 kB / 190 kB). Invisible at 500 rows. It matters when a sort spills to disk, or when these lists get the pagination api-perf recommended — at which point `(workspace_id, updated_at DESC)` is what makes `LIMIT` cheap.

---

### Recommended improvement plan

**Improvement target for this category:** ≥20% query-count reduction on at least one flow, **or** ≥50% improvement on the slowest query, with before/after EXPLAIN ANALYZE as evidence.

**Fix first, outside the target — DB-1.** It is Critical, it is a one-line correctness fix, and it decides whether the schema this audit measured matches production. Narrow the `already exists` catch to the `schema.sql` call at `migrate.ts:41` only, and let the migration loop fail loudly; then make `010_oauth_state.sql` idempotent (`CREATE TABLE IF NOT EXISTS`) and repair `025`, `035`, and `033` (which fails on `"sprint_plan" is not an existing enum label`). Evidence of the fix is `schema_migrations` reaching 42 rows on a fresh database, and a non-zero exit when a migration genuinely fails.

Then, in order of measured yield per unit of effort:

| Rank | Fix | Finding | Projected result | Clears target? |
|---|---|---|---|---|
| 1 | Batch the standups fan-out into one query for all active weeks, with `LIMIT 10` | DB-4 | Week dashboard **42 → ~22 queries (-48%)**, and constant rather than linear in active weeks | **Yes**, 2.4x the 20% bar |
| 2 | Gate the `last_activity` write on the 60 s threshold already used for the cookie | DB-2 | List issues **17 → 12 (-29%)**, sprint board **51 → 40 (-22%)**, week dashboard **42 → 32 (-24%)**; removes the slowest statement in 5 of 6 flows | **Yes**, on three flows |
| 3 | Name the hot prepared statements so Postgres caches their plans | DB-3 | `/api/issues` DB time **2.04 ms → ~0.49 ms (-76%)**; removes most of the 261 ms capture-wide planning tax | **Yes**, via the ≥50%-slowest-query route |
| 4 | Deduplicate the repeated client fetches | DB-9 | Sprint board **51 → ~40 (-22%)**, 32 KB less duplicated payload | **Yes** |
| 5 | Drop `d.content` from the `/api/issues` list projection | DB-5 | ~70% narrower sort rows, 158 kB less body text per request; pairs with api-perf **API-2** | Payload evidence, not query-count |
| 6 | Add `documents (workspace_id, ticket_number) WHERE document_type='issue'` | DB-7 | Permalink lookup: 500 rows examined → 1, 66 buffers → ~3 | Seq Scan → Index Scan |
| 7 | Collapse the 6 count-subqueries in `/api/weeks` into one grouped join; merge SubPlans 7/8 | DB-6 | ~1182 → low-hundreds buffers; removes 10 full scans of `document_associations` | Structural |
| 8 | Rewrite `= ANY($1)` as `JOIN unnest($1)`; add `(workspace_id, updated_at DESC)` with pagination | DB-8, DB-10 | Fixes the 28x misestimate; makes future `LIMIT` cheap | Preventative |

**Recommended first compare run: DB-4 + DB-2 together.** They are independent, they touch different layers (one React effect, one middleware line), and they compound on the same flow — `Load week dashboard` should fall from **42 to roughly 17 queries (-60%)**. Re-run `flow-capture.mjs` and `parse-log.mjs` unchanged against the same 500/20/813 dataset on PG15, and the delta table drops out of the same harness.

**Two cautions for whoever runs compare mode.** First, PG15 vs PG16 — matching the major version is not optional if the evidence is EXPLAIN plans. Second, and this is a genuine hazard rather than a nitpick: **do not run `pnpm test`** to validate these fixes as the conventions' identical-conditions rule would normally require. Finding **TEST-9** established that the api suite `TRUNCATE`s whatever `DATABASE_URL` points at, and it points at the seeded audit database. Validate against a separate throwaway database, or the baseline this report rests on is destroyed.


---

## Test Coverage & Quality — Baseline

**Category:** `test-quality` · **Finding prefix:** `TEST` · **Mode:** baseline
**Repo:** `/Users/troy/repos/GAUNTLET/Ship` · **Commit:** `076a18371da0a09f88b5329bd59611c4bc9536bb` (dirty: audit/, memory-bank/, .claude/, .gitignore only — no application source modified)
**Date:** 2026-07-27

---

### Methodology

Environment stamped from `audit/shipshape.config.yaml` `environment:` block. Every number below comes from a recorded command; raw outputs are in `audit/test-quality/runs/`.

**Unit / integration suites**

```bash
# api (28 files) — NOTE: run against an ISOLATED database, see scaffolding
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_unit_audit \
  ./node_modules/.bin/vitest run --root api --reporter=json --outputFile.json=<f>
# repeated 3x clean + 3x under NODE_V8_COVERAGE + 1 initial = 7 runs total

# web (16 files) — NOT run by root `pnpm test`
pnpm --filter @ship/web exec vitest run --reporter=json --outputFile.json=<f>   # x2
```

**E2E suite** — 3 identical runs, workers pinned for determinism (the config's auto-sizing is
non-deterministic; see TEST-9):

```bash
PLAYWRIGHT_WORKERS=4 PLAYWRIGHT_JSON_OUTPUT_NAME=<f> \
  ./node_modules/.bin/playwright test --reporter=json,./e2e/progress-reporter.ts
```

First-attempt outcomes are read from `results[0].status` of the Playwright JSON report
(`scratchpad/pwparse.mjs`), because `retries: 1` locally / `2` in CI rewrites the headline
pass count. Test-level failure text extracted from the same JSON (`errdump.mjs`), not from
`test-results/errors/`, because that directory is never cleared between runs.

**Code coverage** — `pnpm --filter @ship/api test:coverage` fails (`MISSING DEPENDENCY
'@vitest/coverage-v8'`, log: `runs/api-coverage-attempt.log`). The npm registry is blocked in
this environment, so the provider could not be installed (baseline mode would not install it
anyway). Substitute measurement: raw V8 coverage via `NODE_V8_COVERAGE=<dir> vitest run`,
reduced by `scratchpad/v8cov.mjs` (function coverage = share of V8 function records with
`ranges[0].count > 0`, excluding the module top-level record). Offsets refer to
vitest-transformed sources, so byte coverage is an inflated upper bound; **function coverage is
the number to cite**. Web could not be measured at all — the jsdom environment emits no V8
coverage records for `web/src/*` under either the threads or forks pool.

**Static counts** (identical greps must be reused in compare mode):

```bash
grep -rn "waitForTimeout" e2e --include='*.spec.ts' | wc -l          # 619
grep -rn "if (await " e2e --include='*.spec.ts' | wc -l              # 98
node scratchpad/vacuous.mjs e2e     # brace-scanner: tests whose every expect() is conditional
./node_modules/.bin/playwright test --list --reporter=json           # 869 specs / 71 files
```

**Sampling rule for the assertion spot-check** (reproducible): all 869 spec titles dumped in
`playwright test --list` order, then `awk 'NR%87==1'` → 10 tests.

---

### Deliverable table

| Metric | Baseline |
|---|---|
| Total tests (unit / e2e) | **602 unit** (451 api + 151 web) / **869 e2e** (71 spec files) |
| Pass / Fail / Flaky — unit | 589 pass / **13 fail** (all web) / 1 flaky (`weeks.test.ts`, 1 fail in 7 runs) |
| Pass / Fail / Flaky — e2e | 3-run union: **858 clean in all 3 runs** / 0 always-fail / **11 flaky**; 1 of those failed both attempts in 2 of 3 runs |
| Suite runtime (unit / e2e) | api 12.0 s, web 1.7 s / e2e **541 s / 568 s / 543 s** wall (4 workers, ~9 min per run) |
| Retries configured? | **Yes — `retries: 2` in CI, `1` locally** (`playwright.config.ts:60`). Retries erased 7 / 5 / 2 first-attempt failures across the three runs. |
| Critical flows with zero coverage | Concurrent multi-client editing / Yjs merge; `/dashboard`; `/team/org-chart`; global search UI (API-only); single-document delete |
| Code coverage % per package | api **51.4 % function** (398/774; 7 of 79 modules never loaded) — *approximated, tooling broken*; web **unmeasurable** (no coverage config, no provider); shared **0 %** (no tests, no test script) |
| Tests that can pass with zero assertions | **68 of 866** static e2e blocks (7.9 %) — 3 with no `expect()` at all, 65 whose every `expect()` is inside a conditional |
| CI enforcement | **None.** No `.github/workflows/`, no GitLab/Jenkins/CodeBuild config anywhere in the repo. |

---

### Flow-coverage matrix

"Covered" = a regression in that flow would fail a test. "Smoke" = the page/route loads and
something is visible, but behaviour is not asserted.

| Flow | Entry point | Status | Evidence |
|---|---|---|---|
| Load main page | `/` → redirects to `/my-week` (`web/src/main.tsx:214`) | **Smoke** | `/` is visited by 4 tests (auth redirect, accountability banner ×2, spike-isolated). `/my-week` appears in exactly one spec file (`e2e/my-week-stale-data.spec.ts`). Nothing asserts the landing page's own content. |
| View a document | `/documents/:id/*` | **Covered** | `documents.spec.ts`, `document-workflows.spec.ts`, `data-integrity.spec.ts` (persistence of formatting, nested structure, images, mentions) |
| List issues | `/issues` | **Covered** | `issues.spec.ts` (14), `bulk-selection.spec.ts` (85), `issues-bulk-operations.spec.ts`; 152 direct navigations |
| Load sprint / week board | `/team/allocation`, program week UX | **Covered but hollow** | `program-mode-week-ux.spec.ts` has 66 tests — **33 of them assert only inside conditionals** (TEST-2) |
| Search content | Command palette (⌘K) — there is no `/search` route | **Partial (API only)** | `search-api.spec.ts` has 4 API tests. UI search is touched only for a11y dialog role, focus trap, tooltip, and one private-doc visibility case. No test asserts a query returns the right documents or that selecting a result navigates. |
| Auth: login / logout / session | `/login`, session timeout | **Covered** | `auth.spec.ts` (7), `session-timeout.spec.ts` (58), `authorization.spec.ts` (17) |
| Permissions & visibility | private docs, workspace roles | **Covered, with holes** | `private-documents.spec.ts` (20), `security.spec.ts` (18), `authorization.spec.ts` (17) — but `security.spec.ts:217` (XSS) and `authorization.spec.ts:299` (audit-log access) can both pass with zero assertions |
| Create / edit documents & issues | list pages + editor | **Covered** | create + rename asserted in `documents.spec.ts`, `issues.spec.ts` |
| Delete / archive | bulk bar, doc tree | **Partial** | Bulk archive/delete/undo for issues is well covered (`bulk-selection.spec.ts`). Single-document delete from the doc tree has only a *tooltip* test (`tooltips.spec.ts:57`), which is itself vacuous. |
| **Real-time collaboration / Yjs merge** | `/collaboration/{docType}:{docId}` | **Uncovered** | 11 tests mention collaboration/WebSocket, but only `mentions.spec.ts:374` opens a second client — via `browser.newPage()` (same context, sequential), with every assertion inside `if (await option.isVisible())`, and it flaked in run 2. Only `security.spec.ts` and `private-documents.spec.ts` use `browser.newContext()`, neither for editing. **No test performs concurrent edits from two clients and asserts the merged result.** |
| Offline queue / IndexedDB | image upload, edits | **Partial** | `images.spec.ts` (queue when offline, clear IDB after upload), `race-conditions.spec.ts` (offline edits sync, slow network) |
| Dashboard page | `/dashboard` (`DashboardPage`) | **Zero** | 0 occurrences of `/dashboard` or `DashboardPage` in any of the 71 spec files. (A web unit test `web/src/pages/Dashboard.test.tsx` exists — and is one of the 13 the root `pnpm test` never runs.) |
| Org chart | `/team/org-chart` (`OrgChartPage`) | **Zero** | 0 occurrences of `org-chart` / `orgchart` in `e2e/`; no unit test either |
| Projects list | `/projects` (`ProjectsPage`) | **Smoke** | exactly one navigation, `document-workflows.spec.ts:162` |

---

### E2E flakiness — 3 identical runs, first-attempt outcomes

All three runs: 869 tests, 4 workers, same commit, same machine, dev servers left running throughout.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Wall clock | 541 s | 568 s | 543 s |
| Playwright-reported duration | 539.9 s | 567.4 s | 542.8 s |
| **As the runner reports it** (post-retry) | 861 pass / 1 fail / 7 flaky | 864 pass / 0 fail / 5 flaky | 866 pass / 1 fail / 2 flaky |
| **First-attempt failures** | **8** | **5** | **3** |
| Failures erased by the retry | 7 | 5 | 2 |

**11 distinct tests** produced a non-clean outcome in at least one run; **858 of 869 were clean in
all three**. `P` = passed first attempt, `F` = failed, `T` = timed out (`runs/e2e-flake-union.txt`):

| R1 R2 R3 | Final verdict per run | Test | Smell |
|---|---|---|---|
| `T T F` | flaky / flaky / flaky | `my-week-stale-data.spec.ts` › retro edits are visible on /my-week after navigating back | **Failed the first attempt in 100 % of runs and was hidden every time.** Times out waiting for a "create retro for this week" button — order/shared-state dependence on whether another test in the worker already created that week's retro. |
| `F P F` | **FAIL** / pass / **FAIL** | `inline-comments.spec.ts:118` › canceling a comment removes the highlight | Failed *both* attempts in 2 of 3 runs. Real app bug candidate → **TEST-5** |
| `P F F` | pass / flaky / flaky | `mentions.spec.ts:374` › should sync mentions between collaborators | The only cross-client test in the suite; timing (`waitForTimeout(2000/3000)`) plus a mention popup that may not open |
| `F F P` | flaky / flaky / pass | `weekly-accountability.spec.ts:469` › Allocation grid shows person with assigned issues and plan/retro status | Real race candidate — grid returns `planId: null` right after the plan is created → **TEST-6** |
| `P F P` | pass / flaky / pass | `bulk-selection.spec.ts` › shift+down then shift+up contracts selection | Keyboard timing |
| `P T P` | pass / flaky / pass | `my-week-stale-data.spec.ts` › plan edits are visible on /my-week after navigating back | Same shape as the retro variant |
| `F P P` | flaky / pass / pass | `performance.spec.ts:410` › many images do not crash the editor | `waitForEvent('filechooser')` timed out at 45 s — slash-command timing |
| `F P P` | flaky / pass / pass | `programs.spec.ts:212` › program cards show emoji or initial badges | Element not found in a 2 000 ms window — timeout too tight for a cold render |
| `F P P` | flaky / pass / pass | `project-weeks.spec.ts` › project link in Properties sidebar navigates back to project | Element not found in 5 000 ms after API-side setup — read-after-write timing |
| `F P P` | flaky / pass / pass | `status-overview-heatmap.spec.ts` › displays split cells for plan/retro status | Needs a weekly plan to exist — shared-state dependence |
| `F P P` | flaky / pass / pass | `team-mode.spec.ts` › clicking collapsed header expands the group | Needs an "Unassigned N" group to exist — shared-state dependence |

Dominant smells, in order: **shared state between tests inside a worker's database** (5),
**fixed short timeouts / `waitForTimeout`** (4), **real app races** (2, cross-filed).

---

### Assertion-quality spot-check (10 tests, `awk 'NR%87==1'` sample)

| # | Test | Verdict |
|---|---|---|
| 1 | `accessibility-remediation.spec.ts` › status indicators have icons not just colors | **Meaningful** — asserts count > 0 and one `svg` per indicator |
| 2 | `admin-workspace-members.spec.ts:87` › can change member role | **Vacuous** — the only `expect` is inside `if (await roleSelect.isVisible())` |
| 3 | `bulk-selection.spec.ts:784` › k key moves focus to previous item | **Meaningful** — asserts the focus ring moves *and* leaves the old row |
| 4 | `data-integrity.spec.ts:324` › mentions survive document reload | **Conditional** — whole body guarded by `if (await firstOption.isVisible())` |
| 5 | `features-real.spec.ts:185` › uploaded image persists after page reload | **Conditional** — `waitForEvent('filechooser').catch(() => [null])` then `if (fileChooser)`; a broken file picker makes this a green no-op |
| 6 | `issue-estimates.spec.ts:67` › shows hours label/hint next to estimate field | **Smoke** — `getByText('hours')` visibility only |
| 7 | `private-documents.spec.ts:523` › mention of private doc shows placeholder for non-creator | **Meaningful** (asserts `status === 404`) but the title describes UI the test never looks at |
| 8 | `project-weeks.spec.ts:104` › shows allocated team members in the grid | **Meaningful** — seeds allocations via API, asserts the person renders |
| 9 | `session-timeout.spec.ts:465` › shows "session expired" message after timeout | **Smoke** — navigates straight to `/login?expired=true`; the timeout itself is never exercised |
| 10 | `team-mode.spec.ts:149` › can click cell to open program selector | **Conditional** — branches on `hasEmptyCell`, data-dependent |

**Ratio: 4 / 10 assert a meaningful outcome; 2 / 10 are visibility-only smoke; 4 / 10 can execute
zero assertions depending on page state.**

By contrast the **api unit suite is clean**: 1 100 `expect()` calls, **0** conditional guards,
and 356 body/state assertions vs 263 status-only.

---

### Findings

#### TEST-1 — High — 13 web unit tests are failing, and nothing in the repository ever runs them

**Location:** `package.json:27`; `web/src/lib/document-tabs.test.ts`,
`web/src/components/editor/DetailsExtension.test.ts`, `web/src/hooks/useSessionTimeout.test.ts`

**Evidence:** `pnpm --filter @ship/web exec vitest run` → **13 failed / 138 passed / 151 total**,
3 of 16 files, reproduced identically on two runs (`runs/web-unit-failures.log`,
`runs/web-unit-run1.json`). Meanwhile the root script is
`"test": "pnpm --filter @ship/api test"` — it runs only `@ship/api` and reports **451/451 green**.
There is no CI: `.github/` contains only `instructions/`, there is no `workflows/` directory, and
no `.gitlab-ci.yml` / `Jenkinsfile` / `buildspec.yml` anywhere in the tree. `.husky/pre-commit`
runs `check-empty-tests.sh`, `check-api-coverage.sh` and `comply opensource` — **it never executes
a test suite.**

**Hypothesis:** the sprint→week rename landed in `web/src` (source now emits tab id `weeks` with
label `Weeks (n)`, `document-tabs.tsx:115-116`) while `document-tabs.test.ts:25,34,97,114,160`
still asserts `'sprints'`; `DetailsExtension.ts:48` changed `content` to
`'detailsSummary detailsContent'` while `DetailsExtension.test.ts:16` still asserts `'block+'` and
constructs an `Editor` without the sibling nodes, so ProseMirror throws. Both drifts are exactly
what a CI run would have caught on the commit that introduced them. Nothing did.

**Estimated impact:** the repository currently has **no automated regression gate at all**. Making
the root `test` script recursive and adding a CI workflow converts 13 silent failures into visible
ones on day one, and is the precondition for every other improvement in this category.

---

#### TEST-2 — High — 68 e2e tests (7.9 %) can pass without executing a single assertion, including a security and an authorization test

**Location:** `e2e/program-mode-week-ux.spec.ts` (33 of its 66 tests), `e2e/security.spec.ts:217`,
`e2e/authorization.spec.ts:299`, `e2e/context-menus.spec.ts` (6),
`e2e/accessibility-remediation.spec.ts` (6), `e2e/features-real.spec.ts` (5); full list in
`runs/e2e-vacuous-tests.txt`

**Evidence:** brace-scanner over 866 static test blocks (`runs/vacuous.mjs`): **3 tests contain no
`expect()` at all**, **65 more have every `expect()` nested inside a conditional**. Supporting
counts: 98 `if (await …)` guards and 35 `count`/`length` comparisons across `e2e/`.

Two worked examples:

- `security.spec.ts:217` *XSS via data: URI in links* — types a markdown link with a
  `data:text/html` payload, then loops over rendered `<a>` elements and asserts only
  `if (href?.startsWith('data:'))`. It never asserts a link was created, so **zero `<a>` elements
  produces a green test**. It cannot distinguish "the app sanitised the URI" from "the app
  rendered nothing".
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs (admin only)* —
  the `expect(response.status()).toBe(403)` sits inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` silently skips the entire
  authorization check.

**Hypothesis:** the guards were added to stop tests failing on missing seed data — the same failure
mode `.claude/CLAUDE.md` already forbids for `test.skip()` ("use assertions with clear messages
instead"). The rule was written for `test.skip()` and never extended to `if`-guards, so the
practice migrated rather than stopped. `bulk-selection.spec.ts:793` shows the correct pattern in
the same repo: `expect(rowCount, 'Seed data should provide at least 2 issues…').toBeGreaterThanOrEqual(2)`.

**Estimated impact:** 7.9 % of the e2e suite provides no signal. Two of those tests are the only
automated checks for a stored-XSS vector and for member-level audit-log access.

---

#### TEST-3 — High — retries hide a test that fails on first attempt in 100 % of runs; 11 tests flaked across 3 identical runs

**Location:** `playwright.config.ts:60` (`retries: process.env.CI ? 2 : 1`); flake list in
`runs/e2e-flake-union.txt`

**Evidence:** three identical 869-test runs (see the flakiness table above). Counting only the
first attempt of each test, **8 / 5 / 3** tests failed. After retries the runner reported
**1 / 0 / 1** failures — retries erased **7 / 5 / 2** failures respectively.
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`
**failed or timed out on the first attempt in all three runs** and was reported as passing all
three times. Root-cause smells are dominated by shared state inside a worker's database (5 tests
depend on data another test may or may not have created) and fixed short timeouts (4).

**Hypothesis:** `retries: 1` locally was introduced "for flaky WebSocket/timing tests" (the config
comment says so). It works — the suite looks green — which removes the pressure to fix the
underlying order-dependence, so the flake set grows. The suite has 619 `waitForTimeout` calls
across 49 of 71 spec files; that is the accumulated cost of treating flakes as timing problems.

**Estimated impact:** a real regression in any of these 11 paths would be retried into green. The
improvement target (3 flakes fixed with root cause) is directly available here.

---

#### TEST-4 — High — concurrent multi-client editing / Yjs merge has no test

**Location:** `e2e/mentions.spec.ts:374` is the only cross-client test; `api/src/collaboration/index.ts`

**Evidence:** 11 tests mention collaboration / WebSocket / real-time (all listed in
`runs/e2e-flake-union.txt` methodology), but they cover connection establishment, a status
indicator, and reconnection. `browser.newContext()` appears in only 2 of 71 spec files
(`security.spec.ts`, `private-documents.spec.ts`), neither for editing.
`mentions.spec.ts:374` is the sole two-client test: it uses `browser.newPage()` (same browser,
sequential not concurrent), every assertion sits inside `if (await option.isVisible())`, it relies
on `waitForTimeout(2000)` + `waitForTimeout(3000)` for sync, and it first-attempt-failed in 2 of 3
runs. **No test performs concurrent edits from two clients and asserts the merged result.**
Independently, `api/src/collaboration/index.ts` sits at **25.0 % function coverage** (7 of 28
functions) in the api unit suite.

**Hypothesis:** cross-client tests are expensive and slow, so coverage stopped at "the socket
connects". The CRDT merge behaviour — the whole justification for the Yjs architecture in
`docs/unified-document-model.md` — is verified by nothing.

**Estimated impact:** a Yjs or persistence regression that silently drops one client's edits would
ship green. This is the highest-value place to spend the "3 meaningful new tests" target.

---

#### TEST-5 — Medium (escalate: real app bug candidate) — canceling an inline comment leaves an orphaned `comment-highlight` mark in the document

**Location:** `e2e/inline-comments.spec.ts:118-132`; `web/src/components/editor/CommentDisplay.tsx:181,185-188,315-318`;
`web/src/components/Editor.tsx:668-671`; `web/src/components/editor/CommentMark.ts:69`

**Evidence:** the only test that failed **both** attempts, and it did so in runs 1 and 3 (passed in
run 2). The failure output shows the locator resolving 14 consecutive times over a 10 s window to
`<span class="comment-highlight" data-comment-id="1140cc9f-f225-46a8-b3b3-2327ad18741f">comment that gets canceled</span>`
after `Escape` was pressed (`runs/e2e-run1-failures.txt`, `runs/e2e-run3-failures.txt`).

**Hypothesis:** the Escape handler is bound to a `.comment-pending-field` `<input>` rendered inside
a `Decoration.widget` and auto-focused in a `requestAnimationFrame`
(`CommentDisplay.tsx:185-188`); when focus has not landed yet, the keypress never reaches
`onCancelComment` → `editor.commands.unsetComment(commentId)`. `comment-highlight` is a **TipTap
Mark, i.e. document content** (`CommentMark.ts:69`), not a decoration — so the leftover span is
persisted to `documents.content` and synced through Yjs, pointing at a comment that was never
created.

**Estimated impact:** document-content pollution on a plausible user action (start a comment,
change your mind). Cross-file to `error-handling` for confirmation of the focus race.

---

#### TEST-6 — Medium (escalate: real race candidate) — allocation grid returns `planId: null` immediately after the plan is created

**Location:** `e2e/weekly-accountability.spec.ts:469`;
`GET /api/weekly-plans/project-allocation-grid/:projectId`

**Evidence:** first-attempt failure in runs 1 and 2. `expect(week1Data.planId).toBe(plan.id)`
received `null` on a `GET` issued immediately after a successful weekly-plan `POST` in the same
test, against the worker's own isolated Postgres container.

**Hypothesis:** the grid endpoint joins plans to allocations on a key the just-created plan does
not yet satisfy (week assignment written in a separate statement), so a read that immediately
follows the write sees the allocation but not the plan.

**Estimated impact:** a user creating a weekly plan may see their own plan missing from the
allocation grid on the next render. Cross-file to `db-query` / `api-perf`.

---

#### TEST-7 — Medium — coverage measurement is broken in api and entirely absent in web

**Location:** `api/vitest.config.ts:12-16`, `api/package.json:16`, `web/vitest.config.ts`,
`pnpm-lock.yaml`

**Evidence:** `pnpm --filter @ship/api test:coverage` exits 1 with
`MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`
(`runs/api-coverage-attempt.log`). The package appears **0 times in `pnpm-lock.yaml`** and is not
in any `node_modules/@vitest` directory — `api/vitest.config.ts` declares `provider: 'v8'` for a
provider that was never installed. `web/vitest.config.ts` has no `coverage` block at all and
`web/package.json` has no `test:coverage` script. `shared/` has **no test script and zero test
files** (0 of 8 source files).

Substitute measurement (raw `NODE_V8_COVERAGE`, `runs/api-v8-coverage.txt`) — **api function
coverage 51.4 % (398 / 774)**, 7 of 79 modules never loaded. Weakest modules:

| Module | Function coverage |
|---|---|
| `api/src/services/ai-analysis.ts` | 7.1 % (1/14) |
| `api/src/services/secrets-manager.ts` | 8.3 % (1/12) |
| `api/src/services/oauth-state.ts` | 11.1 % (1/9) |
| `api/src/routes/programs.ts` | 15.4 % (2/13) |
| `api/src/routes/caia-auth.ts` | 16.7 % (2/12) |
| `api/src/routes/admin-credentials.ts` | 18.2 % (2/11) |
| `api/src/routes/weekly-plans.ts` | 21.4 % (3/14) |
| `api/src/collaboration/index.ts` | 25.0 % (7/28) |
| `api/src/utils/document-crud.ts` | 29.3 % (12/41) |

**Estimated impact:** nobody can see coverage move, so no coverage-based decision is possible. The
registry is blocked in this environment, so this was reported rather than fixed (baseline mode
would not install dependencies regardless).

---

#### TEST-8 — Medium — two shipped routes have zero coverage of any kind

**Location:** `web/src/main.tsx:215` (`/dashboard` → `DashboardPage`), `:240` (`/team/org-chart` →
`OrgChartPage`), `:222` (`/projects`), `:216` (`/my-week`, the target of the `/` redirect at `:214`)

**Evidence:** grep across all 71 spec files — `/dashboard` and `DashboardPage`: **0 occurrences**;
`org-chart` / `orgchart`: **0 occurrences** (and no unit test either). `/projects` is navigated to
**once**, in `document-workflows.spec.ts:162`. `/my-week` — the destination of the `/` redirect,
i.e. the app's landing page — appears in exactly **one** spec file
(`e2e/my-week-stale-data.spec.ts`), whose two tests are both on the flake list.

**Hypothesis:** e2e coverage grew feature-by-feature around `/docs` (162 navigations) and `/issues`
(152); routes added later or reached only via redirect were never picked up.

**Estimated impact:** the landing page and the org chart can break without any test noticing.
`/dashboard` does have `web/src/pages/Dashboard.test.tsx` — one of the 13 tests the root `pnpm test`
never runs (TEST-1).

---

#### TEST-9 — Medium — `pnpm test` TRUNCATEs whatever database `DATABASE_URL` points at

**Location:** `api/src/test/setup.ts:14-20`, `api/src/db/client.ts:10`

**Evidence:** `setup.ts` runs, in the `beforeAll` of **every one of the 28 api test files**,
`TRUNCATE TABLE workspace_invites, sessions, files, document_links, document_history, comments,
document_associations, document_snapshots, sprint_iterations, issue_iterations, documents,
audit_logs, workspace_memberships, users, workspaces CASCADE`. `client.ts:10` builds the pool from
`api/.env.local` — the same file `scripts/dev.sh` writes pointing at the developer's dev database.
There is no `.env.test` and no test-specific override. Confirmed operationally: this audit had to
create a separate `ship_unit_audit` database (schema-only `pg_dump` of `ship_dev`) before running
the api suite, because running it as documented would have destroyed the 500-document seeded
dataset the other audit categories depend on.

**Hypothesis:** the api suite predates the e2e testcontainers isolation and was never migrated to
it; `fileParallelism: false` in `api/vitest.config.ts` is the workaround for the resulting
cross-file interference.

**Estimated impact:** the sequence documented in `.claude/CLAUDE.md` (`pnpm dev`, then `pnpm test`)
silently wipes the developer's dev database. It also makes the api suite order-dependent, which is
the likeliest explanation for the one api-unit flake observed
(`weeks.test.ts › should accept all valid ratings (1-5)` returned 404 in 1 of 7 runs).

---

#### TEST-10 — Low — e2e worker auto-sizing collapses to 1 worker on macOS

**Location:** `playwright.config.ts:26-56`

**Evidence:** the worker count is derived from `os.freemem()`. Measured on this machine:
`os.totalmem()` 24.0 GB, `os.freemem()` **0.3 GB** (macOS reports almost all RAM as
used/cached/compressed), 14 CPUs → `memoryBasedLimit = floor((0.3 − 2) / 0.5) = −4` →
`Math.max(1, min(−4, 14))` = **1 worker**. Every measurement in this report pins
`PLAYWRIGHT_WORKERS=4`, which is both the CI value and what makes the three runs comparable.

**Estimated impact:** a developer running `pnpm test:e2e` on a Mac gets a single-worker run —
roughly 4× the measured 9 minutes — which is a strong disincentive to run the suite locally at all.

---

#### TEST-11 — Low — stale test-count comment and heavy sleep usage

**Location:** `playwright.config.ts:63`; 49 of 71 spec files

**Evidence:** the config comment advertises `[1/641]`; `playwright test --list` reports **869**
specs across 71 files. `grep -rn "waitForTimeout" e2e --include='*.spec.ts' | wc -l` → **619**
occurrences in 49 files, led by `tables.spec.ts` (52), `file-attachments.spec.ts` (37),
`features-real.spec.ts` (36), `backlinks.spec.ts` (34), `drag-handle.spec.ts` (33),
`data-integrity.spec.ts` (33).

**Estimated impact:** hygiene, but the `waitForTimeout` density is the mechanism behind TEST-3 —
every fixed sleep is a flake waiting for a slower machine.

---

### Recommended improvement plan

Improvement target for this category: **3 meaningful tests for previously-untested critical
paths, OR 3 flaky tests fixed with root-cause analysis.** Both are available; in priority order:

1. **Make the existing suite visible before adding to it (TEST-1).** Change root `test` to
   `pnpm --recursive run test` and add a CI workflow that runs unit + e2e. This alone surfaces
   13 already-broken tests. Expect the change to go red immediately — that is the point.
2. **Fix the 13 web unit failures (TEST-1).** `document-tabs.test.ts` (9) is stale against the
   sprint→week rename; `DetailsExtension.test.ts` (3) asserts a content expression the
   extension no longer uses and builds an editor without the `detailsSummary` node;
   `useSessionTimeout.test.ts` (1) mocks `fetch` without the CSRF pre-flight that
   `fetchWithCsrf` performs, so `apiPost` throws into the force-logout `catch`.
3. **Fix 3 flakes with root causes (TEST-3).** The three that recur are all the same shape:
   `my-week-stale-data` (waits for a "create retro" button that another test's data may have
   already consumed), `weekly-accountability` (reads the allocation grid immediately after
   creating a plan — see TEST-6, likely a real read-after-write race), and `inline-comments`
   (see TEST-5). Fix the app-side causes rather than lengthening timeouts; 619 `waitForTimeout`
   calls is already the accumulated cost of the opposite approach.
4. **Add 3 meaningful tests for the uncovered critical paths (TEST-4, TEST-8):** (a) two
   `browser.newContext()` clients editing the same document concurrently, asserting both
   converge on merged content after reconnect; (b) `/dashboard` rendering seeded data;
   (c) command-palette search returning an expected document and navigating to it. Each must be
   proven meaningful by breaking the guarded behaviour and watching the test fail.
5. **De-vacuum the top offenders (TEST-2).** `program-mode-week-ux.spec.ts` alone holds 33 of
   the 65 conditional-only tests. Replace `if (await x.isVisible())` with a seeded precondition
   plus an unconditional assertion, exactly as `.claude/CLAUDE.md` already mandates for
   `test.skip()`. Start with `security.spec.ts:217` and `authorization.spec.ts:299`.
6. **Restore coverage measurement (TEST-7)** — install `@vitest/coverage-v8`, add a `coverage`
   block and a `test:coverage` script to `web/vitest.config.ts` / `web/package.json`. Until
   then the 51.4 % api function coverage here is the only number anyone has.


---

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


---

## Accessibility Compliance — Baseline

**Commit:** `076a183` (dirty: audit/memory-bank/.claude only) · **Date:** 2026-07-27 · **App:** web `http://localhost:5173` (authenticated as `dev@ship.local`) · **Data:** 500 documents / 20 users.

> **Compliance context:** Ship is deployed at `ship.awsdev.treasury.gov` — a federal (U.S. Treasury) application, so **Section 508 / WCAG 2.1 AA conformance is effectively mandated**. Under that bar, every **Critical** and **Serious** axe violation below is a conformance failure, not a nice-to-have. The repo is already pursuing this (dedicated `e2e/accessibility.spec.ts`, `accessibility-remediation.spec.ts`, `status-colors-accessibility.spec.ts`).

### Methodology

Three measurement layers, all against the live seeded app on an authenticated session:

1. **Existing infra (recorded, not re-run):** the repo ships 3 axe/keyboard specs. They scan `/login`, the app shell, `/docs`, `/programs`, `/issues`, `/team`, `/documents`, plus keyboard/skip-link/aria-live checks — but every axe assertion filters to **`impact === 'critical'`** (`expect(critical).toEqual([])`). Serious/Moderate/Minor violations pass those specs by construction. They run under the e2e testcontainer+vite-preview harness (a different DB/build), so this baseline did not execute them; the independent scan below runs the truthful superset and is what compare-mode will diff.
2. **Lighthouse 11.7.1** (`npx lighthouse --only-categories=accessibility --preset=desktop`, authenticated via `--extra-headers` Cookie, driven against Playwright's Chromium 147). Score per key page. Reports in `audit/a11y/lighthouse/*.report.html|json`.
3. **axe-core 4.11.0** via `@axe-core/playwright` (tags `wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`) across **every key page AND interactive states** (editor focused, menu/expanded, login), plus keyboard-navigation and accessibility-tree probes. Runner: `audit/a11y/axe-scan.mjs`; raw per-state output in `audit/a11y/axe/`.

**State note:** the seeded dev user has an overdue action item, so an **"Action Items" `role=dialog` auto-opens on every navigation and traps focus**. It is correctly labelled and **Escape closes it** (`escapeClosed: true`), so it is not itself a finding — but page and keyboard scans dismiss it first so they measure the underlying page, not the modal. (An earlier pass that left it open produced a false "focus trap, only 3 tab stops" reading — corrected here.) The "command palette open" state did not reliably isolate the palette overlay and is excluded from findings; its violations are already covered by the document-view/editor states.

### Deliverable table

| Metric | Baseline |
|---|---|
| Lighthouse a11y score per page | **/my-week 95** · /documents/:id 100 · /issues 100 · /weeks 100 · /search 100 |
| Total Critical / Serious (axe) | **2 Critical rules** (`aria-required-children`, `aria-allowed-attr`) · **3 Serious rules** (`color-contrast`, `listitem`, `aria-dialog-name`) |
| Total Moderate / Minor (axe) | **4 Moderate** (`landmark-one-main`, `page-has-heading-one`, `heading-order`, `region`) · **1 Minor** (`empty-table-header`) |
| Keyboard navigation per page | **/issues: Full** (45 tab stops, no trap, focus ring on 45/45) · **/my-week: Full** (20/20 stops, focus ring 42/44). Action-Items modal traps focus correctly & Escape-dismisses. |
| Color contrast failures | **25 nodes on /my-week** — `text-[11px] text-muted/50` timestamps + `bg-accent/20` badges below 4.5:1 (worst and only contrast offender) |
| Missing ARIA labels/roles | `role="tree"` sidebar with non-treeitem `<li>` children (every page); `aria-expanded` on a non-widget editor `<div>`; unnamed Radix dialog (/issues); 1 unlabeled input + 28 unlabeled `<svg>` on document view |

**Per-state axe counts (C/S/M/m):** dashboard `0/1/0/0` · issues `0/0/0/1` · weeks `0/0/2/0` · search `0/0/2/0` · document view `1/1/1/0` · editor focused `2/1/1/0` · issues menu open `0/1/0/1` · login (unauth) `0/0/2/0`.

### The headline: Lighthouse ≠ conformance

Lighthouse rates 4 of 5 key pages a perfect 100 and the 5th a 95, which would read as "essentially compliant." axe on the same pages **plus interactive states** finds **2 Critical + 3 Serious** rule violations — because Lighthouse scans a single static viewport and doesn't mount the focused editor or open menus, and the repo's own specs only fail on `critical` impact. The claim "WCAG AA" is not supported by the generous score; the axe evidence is the truth.

### Findings (ranked)

1. **A11Y-1 · High — Sidebar `role="tree"` contains plain `<li>` nav links, not treeitems.** `<ul role="tree" aria-label="Workspace documents" aria-live="polite">` has `li[tabindex]`/filter-link children (`/docs?filter=workspace`) → axe **Critical** `aria-required-children` + **Serious** `listitem`. On **every authenticated page**. Fix: real treeitem semantics or drop `role="tree"`.
2. **A11Y-2 · High — `aria-expanded` on a non-widget editor `<div>`.** `.tiptap-wrapper > div … aria-expanded="false"` → axe **Critical** `aria-allowed-attr`, on the core editing surface for all document types.
3. **A11Y-3 · High — /my-week fails contrast on 25 elements** (`text-muted/50` 11px, `bg-accent/20` badges) → axe **Serious** + the only Lighthouse-failing page (95). The improvement-target page.
4. **A11Y-4 · Medium — Radix popover opens as an unnamed `role=dialog`** on /issues → axe **Serious** `aria-dialog-name`.
5. **A11Y-5 · Medium — /search and /weeks have no `<main>` landmark and no h1** → axe **Moderate** ×2 (near-empty renders, corroborated by error-handling probe1b).
6. **A11Y-6 · Medium — document pages skip heading levels (h1 → h3)** → axe **Moderate** `heading-order`.
7. **A11Y-7 · Low — login form content not in a landmark / no main** → axe **Moderate** `region`+`landmark-one-main`; **passes the repo's critical-only spec** — exactly what those specs miss.
8. **A11Y-8 · Low — issues table selection column has an empty `<th>`** → axe **Minor** `empty-table-header`.

### Recommended improvement plan

Improvement target: **+10 Lighthouse pts on the lowest page OR all Critical/Serious axe violations fixed on the 3 most important pages.** Recommended attack:

1. **A11Y-3 (contrast)** — raise the `text-muted/50` and `bg-accent/20` tokens to meet 4.5:1. Directly buys the **+10 Lighthouse pts on /my-week** (95 → 100 expected) with before/after Lighthouse reports as proof.
2. **A11Y-1 (tree semantics)** — clears both Critical `aria-required-children` and Serious `listitem` in one fix, on every page; re-run axe on document view + issues to show 0 Critical.
3. **A11Y-2 (editor `aria-expanded`)** — clears the second Critical on the editor surface.

Evidence per fix: before/after Lighthouse (A11Y-3) or before/after axe rule counts (A11Y-1/2), then re-run the repo's 3 a11y specs + the full e2e suite (ARIA changes can break selectors/behavior).

---

## Terraform Plan Review — Baseline

**Commit:** `076a183` · **Date:** 2026-07-27 · **Config:** `terraform/` (AWS: Elastic Beanstalk + Aurora Serverless v2 + VPC + CloudFront/S3 + WAF + SSM). **Terraform:** pinned `1.6.0` (unusable — see TF-3), analysis run on `1.9.8`.

> **Scope reality vs. the brief.** The brief frames this as a Render deployment planned locally. This repo's `terraform/` is **AWS**, not Render, and there is no Render provider anywhere in it. A *live* `terraform plan` is **not runnable** here: the config uses an **S3 remote backend** whose bucket name is stored in SSM (not committed) and the AWS provider needs real credentials — the exercise supplies neither. So the plan/blast-radius analysis below is **static** (reading + `terraform validate`), and the drift demonstration uses the cloud-free **local provider** as the brief specifies. Render is addressed under the improvement target.

### Methodology (reproducible)

```bash
# pinned version fails — record it, then use a current Terraform (required_version is ">= 1.6.0")
terraform 1.6.0: terraform init -backend=false   # → Error: openpgp: key expired (TF-3)
# with 1.9.8, from terraform/ and terraform/environments/prod/:
terraform init -backend=false        # downloads aws 5.100.0 + random 3.9.0, no backend/creds
terraform validate                   # both root and prod: valid, 1 warning (TF-5)
terraform plan                       # → Error: Backend initialization required (s3) — no live plan without creds
# inventory:
grep -rE '^\s*resource\s+"' terraform/*.tf | wc -l          # 74 root resource blocks
grep -rE 'deletion_protection|prevent_destroy|force_destroy|skip_final_snapshot|lifecycle' terraform  # safety attrs
# drift demo (cloud-free) under audit/terraform/drift-demo/, hashicorp/local 2.5.2 pinned
```

Raw outputs: `audit/terraform/raw/{root-init,root-validate,root-plan-attempt,prod-init,prod-validate}.txt` and the drift plans `drift-{1-apply,2-clean-plan,3-drift-plan}.txt`. After running, the `.terraform` cache and the root lock file `init` created were removed so `terraform/` is byte-for-byte unchanged (`git status terraform/` empty).

### Deliverable table

| Metric | Baseline |
|---|---|
| Resource blocks (flat root `terraform/*.tf`) | **74** (actual instances higher — 20 `count`/`for_each` uses across VPC subnets, NAT, route assoc, etc.) |
| Resource blocks (`modules/*`, used by `environments/*`) | 66 |
| Providers | `hashicorp/aws ~> 5.0` (→5.100.0), `hashicorp/random ~> 3.6` (→3.9.0); **unpinned in the flat root** (TF-4) |
| `terraform validate` | root ✅ + prod ✅, each with **1 warning** (uploads lifecycle, TF-5) |
| Live `terraform plan` | **Not runnable** — S3 backend (state bucket in SSM) + AWS credentials required |
| Resources with destroy protection | **1** — only the Terraform **state** bucket (`prevent_destroy`); the Aurora DB and uploads bucket have none (TF-1) |
| Drift detection (local provider) | ✅ demonstrated — clean plan `No changes`, post-tamper plan recreates to declared content |

### Annotated inventory + blast radius

Blast radius is "what happens if this resource is **replaced or destroyed**" (a first/greenfield `apply` just creates everything with no downtime). Ordered worst-first.

**🔴 Tier 1 — data loss / long downtime on replace or destroy (guard these):**
| Resource | What it is | Blast radius / risk |
|---|---|---|
| `aws_rds_cluster.aurora` (`database.tf:34`) | Aurora PostgreSQL 16 Serverless v2 cluster — the production database. | **Highest.** Replacement triggers: `cluster_identifier`, `engine_mode`, `database_name`, `master_username`, `db_subnet_group_name`, encryption. **No `deletion_protection`, no `prevent_destroy`** (TF-1). Destroy → prod takes a final snapshot (recoverable, downtime); **non-prod skips the snapshot → permanent loss**. |
| `aws_rds_cluster_instance.aurora` (`database.tf:68`) | The serverless DB instance in the cluster. | `instance_class`/`engine_version` changes can force replacement/reboot → DB unavailable during the swap. |
| `aws_s3_bucket.uploads` (`s3-cloudfront.tf:374`) | Bucket holding **user-uploaded files** (served via presigned URLs). | Bucket-name change (project/env/account) forces replace → new empty bucket, **old files orphaned**; no `prevent_destroy`. `force_destroy` is unset (good — a destroy of a non-empty bucket fails rather than nuking files). |

**🟠 Tier 2 — service downtime on replace (usually in-place, but replaceable):**
| Resource | What it is | Blast radius / risk |
|---|---|---|
| `aws_elastic_beanstalk_environment.api` (`elastic-beanstalk.tf:97`) | The API's EB environment (Docker on AL2023). | `name`/`solution_stack_name` change → **new environment = API downtime + DNS cutover**. Mitigated by `lifecycle { ignore_changes = [version_label] }` so deploys don't churn it. |
| `aws_vpc.main` + `aws_subnet.*` + `aws_nat_gateway` (`vpc.tf`) | The network everything lives in. | A `vpc_cidr`/subnet CIDR change forces a **replacement cascade** — every dependent resource (DB, EB, SGs) rebuilds. |
| `aws_cloudfront_distribution.frontend` (`s3-cloudfront.tf:108`) | CDN in front of the SPA. | Most edits are **in-place** (5–15 min propagation, no hard outage); replacement is rare. Frontend S3 bucket (`:46`) same profile as uploads but content is redeployable. |
| `aws_acm_certificate.app` (`s3-cloudfront.tf:316`) | TLS cert for the app domain. | Has `lifecycle { create_before_destroy = true }` → **safe rotation** (new cert before old is removed). |

**🟡 Tier 3 — in-place updates, low blast radius:** security groups + rules (`security-groups.tf` — rule edits apply in place), `aws_ssm_parameter.*` (12 params — value change is in-place; **name change replaces**), `aws_rds_cluster_parameter_group` (some params need a reboot), `aws_wafv2_web_acl`/ip_set/regex_set (`waf.tf` — rule updates in place), `aws_kinesis_stream` + realtime log config (`cloudfront-logging.tf`), CloudFront cache/origin-request policies, `aws_cloudfront_function.spa_routing`.

**🟢 Tier 4 — safe no-op / cheap:** all IAM (roles, policies, attachments, instance profile), `aws_cloudwatch_log_group.*`, `aws_flow_log`, route tables + associations, `aws_db_subnet_group`, S3 sub-configs (versioning/SSE/public-access-block), tags. These modify in place or recreate with no user-facing impact.

**App-level blast radius (not infra downtime):** `random_password.session_secret` → regenerating logs out **every** user; `random_password.db_password` → rotates the Aurora master password in place (TF-6).

**Worst-case if `apply` ran right now:** on the *existing* prod stack the dangerous path is any edit that forces **Aurora** or the **uploads bucket** to replace (Tier 1) — unprotected, so Terraform would proceed and cause data loss/downtime. On a *greenfield* account, `apply` simply creates all ~74 resources in dependency order with no downtime (nothing exists to disrupt).

### Drift detection demonstration (cloud-free, `hashicorp/local`)

Config: `audit/terraform/drift-demo/main.tf` manages two local resources (`local_file.app_config`, `local_file.env_file`), provider pinned `local = 2.5.2`.

1. **Baseline** — `apply` then `plan`:
   ```
   Apply complete! Resources: 2 added, 0 changed, 0 destroyed.
   No changes. Your infrastructure matches the configuration.
   ```
2. **Simulated drift** — edited both files *outside* Terraform (`app.config.json` → `"service":"HAND-EDITED-not-via-terraform"`, `replicas:99`; appended `BACKDOOR=1` to `app.env`).
3. **Re-plan detects it** (`audit/terraform/raw/drift-3-drift-plan.txt`):
   ```
   Terraform will perform the following actions:
     # local_file.app_config will be created   (content reset to log_level=info, replicas=2)
     # local_file.env_file   will be created   (content reset, BACKDOOR=1 removed)
   Plan: 2 to add, 0 to change, 0 to destroy.
   ```
   Terraform's refresh saw the on-disk content no longer matches state and planned to **recreate both files back to the declared content** — i.e. an `apply` would *erase* the manual edits (including the rogue `BACKDOOR=1` line). `local_file` reports content drift as recreate (`+ create`) rather than in-place update; the signal is the plan going from `No changes` → non-empty. **Before/after plan output is the pair `drift-2-clean-plan.txt` → `drift-3-drift-plan.txt`.**

*(Render-side drift — changing a setting in the Render dashboard, then `terraform plan` showing the inconsistency — is not reproducible here because no Render provider/config exists in the repo; it belongs to the improvement target below.)*

### Findings (ranked)

1. **TF-1 · High — Prod data stores have no deletion protection.** Aurora cluster + uploads/frontend buckets set neither `deletion_protection` nor `prevent_destroy`; the *only* guarded resource is the Terraform state bucket. One careless `apply`/`destroy` from prod data loss. (`database.tf:34`, `s3-cloudfront.tf:374`)
2. **TF-2 · High — Two divergent root configs for the same infra.** Flat `terraform/*.tf` (has WAF + realtime logging) vs modular `environments/prod` + `modules/*` (does **not**) — separate state, colliding resource names, already drifted on security controls.
3. **TF-3 · Medium — Pinned Terraform 1.6.0 can't `init`** (expired provider-signing key); a clean-machine bootstrap at the repo's own pin fails. Bump `.terraform-version` (allowed by `required_version >= 1.6.0`).
4. **TF-4 · Medium — Flat root has no committed `.terraform.lock.hcl`;** providers float (`~> 5.0` → 5.100.0). The modular paths are properly locked.
5. **TF-5 · Medium — uploads S3 lifecycle rule lacks `filter`/`prefix`** → `validate` warning today, provider error tomorrow.
6. **TF-6 · Low — Secret generators have no `keepers`;** regenerating `session_secret` logs out all users, `db_password` rotates the DB master password (blast-radius note, not a defect).

**Positives worth recording:** `storage_encrypted = true` on Aurora; S3 SSE + public-access-block + versioning on every bucket; VPC flow logs; WAFv2 on CloudFront; DB and app in private subnets; secrets as SSM `SecureString`; ACM cert `create_before_destroy`; state bucket hardened (prevent_destroy + versioning + encryption); backend `encrypt = true`; EB `ignore_changes = [version_label]` so deploys don't fight Terraform.

### Improvement target (plan — not built in this baseline phase)

The user scoped this step to documentation only, so the improvement configs are **not** written here. When the improvement phase runs, the target is:

1. **Local-provider config, ≥2 local resources, pinned provider** — `audit/terraform/drift-demo/main.tf` already satisfies this (2 `local_file` resources, `local = 2.5.2`, `terraform plan` matches intent). Promote/rename it as the deliverable.
2. **Render-provider config** declaring a Render web service that deploys the ShipShape fork, provider pinned (`render-oss/render`), deployable from a clean machine via `terraform apply` — this **replaces** the current `scripts/deploy.sh` (Elastic Beanstalk) manual flow. New work; needs a Render API key.
3. Both configs: **pinned provider versions**, `terraform plan` confirmed against intent, committed lock files (closing TF-4 for the new configs by construction).
