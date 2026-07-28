# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-27 (Mon)

## Where we are

Sprint day 1. **The full baseline audit is COMPLETE — all 8 categories** (7 code/runtime + Terraform/IaC). `audit/AUDIT_REPORT.md` assembled and live dashboard republished. **68 findings — 4 Critical, 22 High, 29 Medium, 13 Low.** Report was due Tue Jul 28 11:59 PM — done a day early.

## The 4 Criticals (the spine of the report)

- **API-1** — global rate limiter caps prod at 100 req/min per IP vs 4–16 req/page-view; 429s never retried → dropped writes. Blocks all perf work until raised. (`api/src/app.ts:81`)
- **DB-1** — `pnpm db:migrate` silently skips 32/42 migrations and exits 0 (the "already exists" catch wraps the whole loop). Data-integrity risk on any non-end-state DB (real prod/shadow). (`api/src/db/migrate.ts:103`)
- **ERR-1** — collab WebSocket unreachable at load → edits accepted under a false "Saved"/"Cached" indicator, never sync, lost on reload. (`api/src/collaboration/index.ts`, `web/src/components/Editor.tsx`)
- **ERR-2** — session revocation/expiry NOT enforced on live collab sockets (auth checked only at WS upgrade). Logged-out user keeps writing. (`api/src/collaboration/index.ts:659`)

Cross-refs baked into the report: ERR-6↔TEST-5 (comment-mark orphan on blur), API-4/API-5↔DB-4 (dashboard standups N+1, also causes ERR-7's 61s 3G page), API-2↔DB-5 (issues list ships unused body), DB-2↔API-6 (per-request session write).

## Current focus

Baseline phase closed. Next up per the sprint plan:
1. **Improvement phase (compare loops)** — target Fri Jul 31. First sprint recommendation (in AUDIT_REPORT.md improvement plan): DB-1, ERR-1+ERR-2 (one collab-server change), API-1, then DB-2 + DB-4/API-4. Retires all 4 Criticals + 3 Highs touching only migrate runner, collab server, one middleware gate, two queries.
2. Fixes follow repo house rules (philosophy reviewer, OpenAPI registration, migrations-only) — see systemPatterns.md.
3. Final polish + presentation — Sun Aug 2.

## Active decisions / how compare mode must run

- Each category skill re-invoked directly in `compare <label>` mode; identical-conditions rule (same seed volume, same PG 15-alpine, same concurrency/viewport). Always re-run full suite after a fix.
- **API-3 caveat:** gzip won't show on loopback — must measure over a bandwidth-shaped link or by payload size.
- **a11y runner scripts** (`audit/a11y/run-lighthouse.sh`, `axe-scan.mjs`) now read `SESSION_ID`/`WIKI_DOC_ID` from env (live token was scrubbed) — re-auth before compare runs. Lighthouse via `npx lighthouse@11` + Playwright Chromium at CHROME_PATH (no system Chrome).

## Watch-outs / environment truths (verified)

- No local Postgres — audit runs on Docker **postgres:15-alpine :5433** (compose declares 16; registry pulls blocked). Version skew stamped in every artifact — matters for EXPLAIN comparisons.
- Migrations 011–042 were force-applied individually (because of DB-1). A clean DB needs that same manual step until DB-1 is fixed.
- App runs on web :5173 / api :3001 (:3000 taken). Read repo-root `.ports`, not assumptions.
- a11y: Ship is `ship.awsdev.treasury.gov` → Section 508 effectively mandated; every axe Critical/Serious is a conformance gap. Lighthouse (95–100) is generous and misses them.
- Unresolved thread worth a clean repro: an **uncaught server boot crash** (`Error: Unexpected end of array`, lib0 Yjs decode) loading a doc's `yjs_state` — noted under ERR-1's impact + a boot-crash note in error-handling/baseline.md. Mechanism not fully pinned; confirm before citing as its own Critical.
- **Terraform (Category 8):** `terraform/` is AWS, not Render. Live `plan` needs AWS creds + the SSM-stored S3 state bucket — not runnable in this env; blast radius is static. Pinned TF `1.6.0` can't `init` (expired signing key, TF-3) — use ≥1.8. Two divergent root structures exist (flat `terraform/*.tf` vs `environments/prod` modules, TF-2). Improvement-phase Terraform target = local-provider config (drift-demo already covers it) + a Render web-service config; both pinned, `apply`-deployable. Terraform 1.9.8 binary is in `$CLAUDE_JOB_DIR/tmp/bin` (temp, not in repo).
