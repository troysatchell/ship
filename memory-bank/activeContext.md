# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-28 (Tue)

## Where we are

**Audit gate MET** (due Tue Jul 28 11:59 PM; report finished Jul 27). `audit/AUDIT_REPORT.md` — 68 findings, 4 Critical, 8 categories — is now committed, pushed, and fully decomposed into Linear tickets. Baseline phase is closed; nothing else is owed on the audit deliverable.

Sprint day 2. Next gate: **implementation, Fri Jul 31**.

## Current focus

1. **Improvement phase (compare loops)** — recommended first sprint, per `AUDIT_REPORT.md` improvement plan: **DB-1** (deploy safety, unblocks everything) → **ERR-1 + ERR-2** (one collab-server change) → **API-1** (unblocks all perf measurement) → **DB-2** + **DB-4/API-4**. Retires all 4 Criticals + 3 Highs, touching only the migrate runner, the collab server, one middleware gate, and two queries.
2. **Deployment for submission** — see open question below. Doubles as the Category 8 improvement deliverable.
3. **Final polish + presentation** — Sun Aug 2 11:59 AM.

## Work tracking moved to Linear

All 68 findings live at project **ShipShape Audit Remediation** (team `TRO`) — 8 category "epic" parents, each finding a sub-issue:

`TRO-164` ERR · `TRO-165` DB · `TRO-166` API · `TRO-167` TS · `TRO-168` BUN · `TRO-169` TEST · `TRO-170` A11Y · `TRO-171` TF
Sub-issues `TRO-172`–`TRO-239`. Cross-cutting root causes are wired as Linear relations; true dependencies as `blocks` (API-1→API-2/3, TF-3→TF-4, TF-2→TF-1).

Finding IDs (`DB-2`, `BUN-1`…) remain stable and are the join key between report, tickets, and compare-mode runs.

## Scope surfaced 2026-07-28 from the assignment PDF — NOT yet ticketed

Re-read of `GFA_Week_4_ShipShape_Updated.pdf` found graded requirements the 68 audit tickets do not cover. These are additional workstreams, not findings:

- **CI pipeline (rule 4)** — GitHub Actions on every PR/commit: build, lint, type-check, test, coverage, `pnpm audit`, security scan; all green before merge; **source-code inventory** (packages/versions/licenses) produced in CI. Ties to TEST-1 (`TRO-223`) and TS-6 (`TRO-211`), which found *no CI and no lint at all*.
- **Regression tests (rule 3)** — every audit bug needs a test that would have caught it. Stable fakes only.
- **Build/release/run separation (rule 5)** — build once, promote; artifact tagged with git SHA; lifecycle documented.
- **One-command local start (rule 6)** — `./start.sh` or Makefile, clean checkout, no manual steps.
- **Retries / timeouts / circuit breakers (rule 7)** — on DB, WebSocket, and external API calls; document the failure mode each protects against.
- **`CHANGES.md` (rule 8)** — what was added, how to run it, how to roll it back.
- **Non-code deliverables** — improvement documentation (per category), discovery write-up (3 things + file:line), demo video (3–5 min), AI cost analysis, social post tagging @GauntletAI, orientation notes.

## Deployment — SETTLED: Render

The PDF settles it (Category 8): deployment is via **Render**, official first-party provider `render-oss/render`, **no AWS account or credentials needed**. Railway is out. The Render service must be **created by Terraform**, not the dashboard — the fork has to be deployable from a clean machine using only `terraform apply`.

Topology is forced to a **single Render web service** serving both API and SPA, because the code assumes same-origin: session cookie is `sameSite: 'strict'` (`auth.ts:217`, `routes/auth.ts:188`), the collab WS URL is built from `window.location.host` (`Editor.tsx:334`), and `VITE_API_URL` defaults to `''` (`Editor.tsx:330`). A static-site + separate-API split breaks login and collaboration. **The API does not currently serve `web/dist`** — that's a required code change (~10 lines; port the extension test from `terraform/cloudfront-functions/spa-routing.js`).

**Render credentials — in hand (2026-07-28).** `RENDER_API_KEY` lives in the gitignored repo-root `.env` (`.gitignore:12`); load it into Terraform's process env, not Vite's. Owner ID is **`tea-d9kevetg1s2s73807n5g`** ("My Workspace", type `team`) — retrieved via `GET https://api.render.com/v1/owners`. The owner ID is **not** secret and can be committed in tfvars; only the key must stay out of git.

⚠️ Before any key goes near tfvars: `.gitignore:74-75` only covers `terraform/terraform.tfvars` and `terraform/environments/*/terraform.tfvars` — a new `terraform/render/terraform.tfvars` would **not** be ignored.

## Open questions

- **Uncaught server boot crash** (`Error: Unexpected end of array`, lib0 Yjs decode, loading a doc's `yjs_state`) — captured inside `TRO-188` as a flagged hypothesis. If it reproduces cleanly it is a 5th Critical. Not yet pinned to a call site.
- Whether the un-ticketed workstreams above should become Linear tickets alongside the 68 findings.

## Watch-outs / environment truths (verified)

- **AWS prod is not publicly reachable** (checked 2026-07-28): `ship.awsdev.treasury.gov` → **403**, EB health endpoint → no response. Reviewers cannot see a running app there — an argument for the new deploy regardless of provider.
- No local Postgres — audit ran on Docker **postgres:15-alpine :5433** (compose declares 16). Version skew is stamped in every artifact; matters for EXPLAIN comparisons.
- Migrations 011–042 must still be force-applied individually on a clean DB until **DB-1** is fixed.
- App runs web :5173 / api :3001 (:3000 taken by an unrelated container). Read repo-root `.ports`, never assume.
- **a11y compare runs** need re-auth: `audit/a11y/run-lighthouse.sh` + `axe-scan.mjs` read `SESSION_ID`/`WIKI_DOC_ID` from env (live token was scrubbed). Lighthouse via `npx lighthouse@11` + Playwright Chromium at `CHROME_PATH`.
- **API-3 caveat:** gzip won't show on loopback — measure over a bandwidth-shaped link or by payload size.
- **Terraform:** pinned `1.6.0` can't `init` (expired signing key, TF-3) — use ≥1.8. Two divergent root structures (TF-2) must be resolved before any `apply`; prod Aurora + uploads bucket are unguarded (TF-1).
