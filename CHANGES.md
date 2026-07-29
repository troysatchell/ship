# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-178 — [DB-1] `pnpm db:migrate` silently skipped 32 of 42 migrations and exited 0

**What was broken.** `api/src/db/migrate.ts:103-111` wrapped *both* the `schema.sql` application
and the migration loop in one `try`, and its handler matched any error message containing the
substring `already exists`. `010_oauth_state.sql:8` created `oauth_state` without `IF NOT EXISTS`
while `schema.sql:90` had already created it, so the migration threw `relation "oauth_state"
already exists` — indistinguishable, to that handler, from a benign `schema.sql` re-run. It logged
`Database schema already exists, continuing...`, returned normally, abandoned the remaining 32
files, and the process exited **0**. A second run behaved identically; it did not self-heal.

The report's hypothesis held exactly, including its list of the other blocking files.

**What changed.**

- `api/src/db/migrationRunner.ts` (new) — the migration logic, extracted from `migrate.ts` so it
  can be exercised by tests. `migrate.ts` is now the CLI wrapper: env, pool, exit code.
- The `already exists` tolerance now lives inside `applySchema` and covers only the `schema.sql`
  call, so a failure in the migration loop can no longer be mistaken for one. It matches Postgres
  SQLSTATE duplicate-object codes (`42P04`, `42P06`, `42P07`, `42701`, `42710`, `42723`) instead of
  a substring — substring matching on `already exists` would also swallow, for example, a failed
  `ALTER ... ADD CONSTRAINT` in a data migration.
- A failing migration is rethrown with its filename in the message, and `migrate.ts` exits 1.
- Migrations `010`, `025`, `033`, `035` are now idempotent against the `schema.sql` end state
  (`IF NOT EXISTS`; a `pg_constraint` lookup for the CHECK constraint; `DROP TRIGGER IF EXISTS`
  before `CREATE TRIGGER`, the pattern `schema.sql:193` already uses; a `pg_enum`-guarded loop for
  the three `ALTER TYPE ... RENAME VALUE` statements). These four files are edited rather than
  superseded by a new migration, because a new migration cannot stop `010` itself from throwing,
  and databases that already recorded these versions never re-read them.
- Regression tests: `api/src/db/__tests__/migrationRunner.test.ts`.

**What the 32 previously-skipped migrations mean for an existing database.** Reported, not executed
against anything but a factory database — this is the part that needs an operator's eyes before the
next production deploy. Measured over `011`–`037` (31 files; `010` is the 32nd):

| | count |
|---|---|
| `ALTER TABLE` | 19 |
| of which `DROP COLUMN` | 3 |
| `CREATE TABLE` | 7 |
| `ALTER TYPE` | 4 |
| `UPDATE` / `INSERT` / `DELETE` statements | 27 / 8 / 3 |

`schema.sql` contains **zero** `ALTER TABLE` and **zero** DML, so on a database that already exists
these 31 files are the only mechanism that would ever have changed it. Notable: `027`/`029` drop
`documents.sprint_id`, `documents.project_id`, `documents.program_id`; `033` renames three
`document_type` enum labels `sprint_* → weekly_*` and rewrites matching `properties` JSON; `014b`,
`028` and `034` are backfills. **The first deploy after this change will apply all 32 at once.**
Take a snapshot first and run `pnpm db:migrate` against a restore of production before running it
against production.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate                          # now exits non-zero on any migration failure
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts
```

Verify with `select count(*) from schema_migrations;` — it should equal the number of `.sql` files
in `api/src/db/migrations/` (42 today), not 10.

**Verified** against PostgreSQL 15-alpine in the `ship-audit-pg` container on `:5433`:

- fresh database → 42 rows in `schema_migrations`, exit 0
- second run on it → clean no-op, still 42, exit 0
- `ship_wt_tro_178`, stuck at 10 rows (the state DB-1 had left it in) → 32 applied, 42 rows, exit 0
- a database seeded with the *pre-*`033` enum labels → renamed to `weekly_*`, 42 rows, exit 0
- `pnpm --filter @ship/api test` against the fully-migrated database → 29 files, 455 tests passed

**Not verified.** No run against production or shadow, and no run against PostgreSQL 16 (production
runs pg16; CI and this work run pg15 — see the pin comment in `.github/workflows/ci.yml`). Proving
the production path needs a restore of a production snapshot.

**Rollback.** `git revert` the four commits on `fix/db-1-migration-runner`, or, to restore only the
old runner behaviour, delete `api/src/db/migrationRunner.ts` and restore `api/src/db/migrate.ts`
from `main`. Rolling back the runner alone leaves migrations `010`/`025`/`033`/`035` idempotent,
which is harmless. Note that rollback does **not** un-apply migrations already recorded in
`schema_migrations`; reversing those requires a database restore.

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
