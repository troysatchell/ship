# Active Context — Current Focus

*The most-updated file in the bank. Read this first every session; rewrite it whenever focus shifts. Keep it under a screen — move finished work to progress.md.*

**Last updated:** 2026-07-28 (Tue), end of day 2

## Where we are

**Tuesday audit gate MET and verified row-by-row against the assignment PDF.** All 8 categories carry their required Deliverable table plus ranked findings; several over-deliver (6 API endpoints against a required 5, 6 DB flows against 5). Rule 1 confirmed clean: `git diff 076a183..HEAD -- api/ web/ shared/ terraform/ e2e/` is **empty**, so nothing was fixed during the audit and the measurements reflect the commit they claim.

Working tree clean at `56ae2aa`, pushed to both remotes.

## Current focus

1. **Improvement phase — Fri Jul 31.** Order: **DB-1** (deploy safety) → **ERR-1 + ERR-2** (one collaboration-server change) → **API-1** (unblocks all perf measurement) → **DB-2** + **DB-4/API-4**. Retires all 4 Criticals + 3 Highs.
2. **Render deploy** — partially stood up, currently blocked (see below). Doubles as the Category 8 deliverable.
3. **Final submission — Sun Aug 2, 11:59 AM.** Six non-code deliverables still open; see progress.md.

## ⚠️ Render deploy is blocked — two hard stops before it can work

Service exists: **`ship`** · `srv-d9kf2t942hec73aofrt0` · region **oregon** · runtime **docker** · plan free · branch `main` · repo `github.com/troysatchell/ship` · URL **https://ship-rr6m.onrender.com** · health check **unset**.

- **The Docker build will fail.** `Dockerfile:22-23` does `COPY shared/dist/ ./shared/dist/` and `COPY api/dist/ ./api/dist/`, but both are gitignored (`.gitignore:6`) and untracked. `.dockerignore` documents the assumption ("*NOT api/dist and shared/dist which are needed*") — this image is built for the AWS flow where `scripts/deploy.sh` builds locally first. Render clones from GitHub, so the COPY finds nothing. **Fixing this is assignment rule 5** (build once in CI, promote the artifact).
- **The image is API-only.** No `COPY web/`, no web build — so there is no `web/dist` to serve and no UI, even if the build succeeded.

**Also needed:** no Postgres instance exists yet in the workspace (that's why no Internal URL appears anywhere). Create it in **oregon** — internal networking requires the same region as the service.

**Env vars** (docker runtime, so `NODE_ENV`/`PORT`/`VITE_APP_ENV` are already baked into the Dockerfile and `NODE_VERSION` is irrelevant): only `DATABASE_URL` (Add-from-Database → **Internal**, see DB-11), `SESSION_SECRET`, and `CORS_ORIGIN=https://ship-rr6m.onrender.com`. Set health check path to `/health` (`app.ts:165`). Never set `PORT`.

**Credentials in hand.** `RENDER_API_KEY` in the gitignored repo-root `.env`; load into Terraform's process env, not Vite's. Owner ID **`tea-d9kevetg1s2s73807n5g`** ("My Workspace", team) — not secret, safe in tfvars. ⚠️ `.gitignore:74-75` covers only `terraform/terraform.tfvars` and `terraform/environments/*/terraform.tfvars`; a new `terraform/render/terraform.tfvars` would **not** be ignored.

## Open questions

- **Uncaught boot crash** (`Error: Unexpected end of array`, lib0 Yjs decode on `yjs_state`) — flagged inside `TRO-188`. A 5th Critical if it reproduces cleanly. Not pinned to a call site.
- Whether the six rule-driven workstreams (CI, regression tests, build/release/run, one-command start, retries/timeouts/circuit breakers, `CHANGES.md`) should become Linear tickets alongside the 68 findings.
- Whether the Render service should be imported into Terraform or destroyed and recreated by it — Category 8 requires `terraform apply` from a clean checkout, and it was hand-created.

## Watch-outs / environment truths (verified)

- **AWS prod is unreachable to reviewers** — `ship.awsdev.treasury.gov` → 403, EB health → no response (checked 2026-07-28).
- Migrations 011–042 must still be force-applied individually on a clean DB until **DB-1** is fixed.
- No local Postgres — audit ran on Docker **postgres:15-alpine :5433** (compose declares 16). Version skew matters for EXPLAIN comparisons.
- App runs web :5173 / api :3001 (:3000 taken). Read repo-root `.ports`.
- **a11y compare runs need re-auth** — `run-lighthouse.sh` / `axe-scan.mjs` read `SESSION_ID`/`WIKI_DOC_ID` from env (token scrubbed).
- **API-3 caveat:** gzip won't show on loopback — measure by payload size or a shaped link.
- **Terraform:** pinned `1.6.0` can't `init` (TF-3) — use ≥1.8. Resolve TF-2 before any `apply`; Aurora and uploads are unguarded (TF-1).
- Pre-commit warns that the `comply` CLI is missing and proceeds. Never `--no-verify`.
