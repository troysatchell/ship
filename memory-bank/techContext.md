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
