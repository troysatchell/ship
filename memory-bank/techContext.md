# Tech Context — Stack, Commands, Environment

*Setup facts and quirks needed to work productively. Update when the environment changes.*

## Stack

TypeScript 5.7 (strict on everywhere; web tsconfig standalone — see systemPatterns) · React 18 + Vite 6 + TipTap/Yjs · Express 4 + raw `pg` · PostgreSQL 16 · Playwright 1.57 + vitest 4 · pnpm 10 monorepo.

## Daily commands

```bash
pnpm dev            # scripts/dev.sh: creates DB ship_<worktree>, migrates+seeds fresh DBs,
                    # picks free ports (API 3000+, web 5173+), writes .ports file
pnpm db:seed        # idempotent; see seed volumes note below
pnpm test           # api vitest ONLY (web units: pnpm --filter @ship/web test)
# e2e: use /e2e-test-runner skill — never pnpm test:e2e directly (output explosion)
pnpm build:web      # tsc && vite build → web/dist
```

- Local Postgres (not Docker) is the assumed dev DB. Docker alt: `docker-compose.local.yml`, postgres on host port **5433**, creds ship/ship_dev_password/ship_dev.
- Actual ports live in the repo-root `.ports` file while dev.sh runs; Vite proxies `/api`, `/collaboration`, `/events` to the API.
- Login for seeded env: `dev@ship.local` / `admin123` (super-admin; login endpoint is rate-limited — get one session cookie and reuse it).
- Health: `:3000/health` · Swagger: `:3000/api/docs/`.

## Audit tooling (ours)

- Skills: `~/.claude/skills/` — `shipshape-audit` (orchestrator) + `{type-safety,bundle,api-perf,db-query,test-quality,error-handling,a11y}-audit`, each `baseline` | `compare <label>`.
- Shared contract: `~/.claude/skills/shipshape-audit/references/conventions.md` (artifact schema, severity scale, identical-conditions rule).
- Repo config: `audit/shipshape.config.yaml` (verified commands/URLs/endpoints + orientation leads in `notes:`).
- Artifacts: `audit/<category>/baseline.{json,md}`, `after-<label>.{json,md}`; report: `audit/AUDIT_REPORT.md`.
- Deterministic counts: `~/.claude/skills/type-safety-audit/scripts/count.sh <pkg-dir>`.
- Load tool: autocannon @ concurrency 10/25/50. Query logging: `ALTER SYSTEM SET log_statement='all'` (revert after).
- a11y tooling (verified 2026-07-27, no system Chrome on this box): Lighthouse via `npx lighthouse@11` pointed at Playwright's Chromium through `CHROME_PATH` (…/ms-playwright/chromium-1217/…/Google Chrome for Testing), authenticated with the session cookie in `--extra-headers`. axe via the repo's `@axe-core/playwright` — import `chromium` from `@playwright/test` (NOT `playwright`) and run scripts from the repo root so node resolves the workspace modules. Runners: `audit/a11y/run-lighthouse.sh`, `audit/a11y/axe-scan.mjs` (both read `SESSION_ID`/`WIKI_DOC_ID` from env — re-auth first).

## Seed volumes (RESOLVED — deterministic 500 docs / 20 users)

Built-in `pnpm db:seed` ≈ 257 docs / 11 users — short of the brief's **500+ docs / 100+ issues / 20+ users / 10+ sprints**. `audit/seed-augment.ts` tops it up deterministically. Reproduce the audited dataset (needed for compare mode) in this order:

```bash
pnpm db:migrate && pnpm db:seed && ./api/node_modules/.bin/tsx audit/seed-augment.ts
# NOTE: db:migrate silently stops at 010 (DB-1) — migrations 011–042 must be force-applied
#       individually until DB-1 is fixed. Verify: SELECT document_type, count(*) FROM documents GROUP BY 1;
```

Audited volume: 500 documents (254 issue / 91 wiki / 35 sprint / …) / 20 users / 35 sprints — details in `audit/shipshape.config.yaml` `seed.actual`.

## Git remotes — one push, two destinations (set 2026-07-28)

| Remote | URL | Role |
|---|---|---|
| `origin` (fetch) | `labs.gauntletai.com/troysatchell/Ship` | GitLab, **internal** |
| `origin` (push #1) | `labs.gauntletai.com/troysatchell/Ship` | same |
| `origin` (push #2) | `github.com/troysatchell/ship` | GitHub, **public** |
| `upstream` | `labs.gauntletai.com/byronmackay/ship` | original project this was cloned from |

`git push` reaches both automatically. Pull from `origin`; fetch `upstream` explicitly to sync with the original.

Reproduce the dual-push setup with — note the **first** `--add --push` replaces the implicit default, so both URLs must be added explicitly:

```bash
git remote set-url --add --push origin https://labs.gauntletai.com/troysatchell/Ship.git
git remote set-url --add --push origin https://github.com/troysatchell/ship.git
```

Chosen over CI mirroring: no extra machinery, and a push either reaches both or fails visibly. GitHub visibility is public by deliberate decision (see progress.md 2026-07-28) — flip with `gh repo edit --visibility private` if that ever changes.

## Deployment (current state, 2026-07-28)

- Repo ships via `scripts/deploy.sh prod` (API → Elastic Beanstalk) + `scripts/deploy-frontend.sh prod` (web → S3/CloudFront). Frontend deploy is `aws s3 sync web/dist/` + a CloudFront invalidation; SPA deep links are rewritten to `/index.html` by a CloudFront **function** (`terraform/cloudfront-functions/spa-routing.js`), not `custom_error_response` — deliberately, so API 404s aren't turned into HTML.
- **AWS prod is not publicly reachable** (verified 2026-07-28): `ship.awsdev.treasury.gov` → 403, EB health endpoint → no response.

### Render (submission target — settled by the brief)

| | |
|---|---|
| Service | `ship` · `srv-d9kf2t942hec73aofrt0` |
| Region | **oregon** (a Postgres instance must match this for internal networking) |
| Runtime | **docker** — the Dockerfile governs; Render's build/start command fields are unused |
| Plan / branch | free · `main` · repo `github.com/troysatchell/ship` |
| URL | `https://ship-rr6m.onrender.com` |
| Health check | **unset** — should be `/health` (`api/src/app.ts:165`) |
| Postgres | **none exists yet** — which is why no Internal Database URL appears anywhere |

**Env vars to set** (only three — the docker runtime already bakes `NODE_ENV`, `PORT`, `VITE_APP_ENV` into `Dockerfile:29-31`, and `NODE_VERSION` is a native-Node-runtime concept that does nothing here):

- `DATABASE_URL` — via *Add from Database* → **Internal** URL (external requires TLS; see DB-11)
- `SESSION_SECRET` — generate
- `CORS_ORIGIN` — `https://ship-rr6m.onrender.com` (code default is `localhost:5173`, `index.ts:25`)

**Never set `PORT`** — Render injects it and `index.ts:24` reads it.

**Credentials.** `RENDER_API_KEY` in the gitignored repo-root `.env` — load into Terraform's process env (`set -a; . ./.env; set +a`), not Vite's. Owner ID `tea-d9kevetg1s2s73807n5g`; not secret, safe to commit. Query the API directly with `GET https://api.render.com/v1/owners` and `/v1/postgres` and `/v1/services`.

⚠️ `.gitignore:74-75` covers only `terraform/terraform.tfvars` and `terraform/environments/*/terraform.tfvars`. A new `terraform/render/terraform.tfvars` would **not** be ignored — widen the rule before any key goes near it.

**Status: LIVE and seeded** since 2026-07-28 — https://ship-rr6m.onrender.com (`dev@ship.local` / `admin123`).

| | |
|---|---|
| Database | `ship-db` · `dpg-d9kgth6417fc7386hhh0-a` · free · oregon · **pg 16** |
| Seeded | 11 users · 1 workspace · **257 documents** (104 issue, 35 sprint, 32 weekly_plan, 27 retro, 15 project, 15 review, 11 person, 7 wiki, 6 standup, 5 program) |
| Env vars set | `DATABASE_URL` (internal) · `SESSION_SECRET` · `CORS_ORIGIN` |
| `ipAllowList` | **empty** — external connections refused; the service connects internally |

**To connect from a workstation** (e.g. to re-seed), temporarily add your IP, then remove it:

```bash
curl -X PATCH https://api.render.com/v1/postgres/dpg-d9kgth6417fc7386hhh0-a \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"ipAllowList":[{"cidrBlock":"<your-ip>/32","description":"temporary"}]}'
# …work…  then reset with  -d '{"ipAllowList":[]}'
```

⚠️ Migrating or seeding against Render requires **`NODE_ENV=production`** (that is the branch that enables SSL in `migrate.ts:32` / `seed.ts:44`) **and** `SESSION_SECRET` set, or `app.ts:40` throws. The SSM fallback (`TRO-243`) is what makes production mode work off AWS.

**Free-tier caveats:** the web service sleeps on inactivity, so a cold URL takes time to answer; the free database has a limited lifetime. Both worth upgrading before the URL becomes a graded deliverable on Sunday.

**Not yet Terraform-managed** — the service and database were created by hand and API call. Category 8 requires `terraform apply` from a clean checkout, so they need importing or recreating.
