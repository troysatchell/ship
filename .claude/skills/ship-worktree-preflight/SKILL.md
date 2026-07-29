---
name: ship-worktree-preflight
description: >-
  Verify a git worktree's dev environment before making code changes — Postgres reachable,
  dependencies installed, `@ship/shared` built, database created and migrated. Use at the start of
  every session in a worktree, when the user mentions "worktree" or "preflight", or when a build or
  test fails in a way that smells like a missing environment rather than a code defect.
---

# Ship Worktree Preflight Checklist

Run this at the start of EVERY session on a worktree to ensure the dev environment is ready before making code changes.

## Trigger

- User starts working in a git worktree
- User mentions "worktree" or "preflight"
- Before any development work on a non-main worktree

## Postgres runs in Docker, not locally

**Corrected 2026-07-29.** This checklist previously called `pg_isready`, `brew services restart
postgresql@16`, and `createdb`. **None of those binaries are on PATH on this machine** (verified:
`command -v psql/createdb/pg_isready` → all missing; no brew postgres service). The only Postgres is
the Docker container **`ship-audit-pg`** publishing `5433 → 5432`.

That matters because the old commands failed with "command not found" while the checklist appeared to
complete — the exact silent degradation `scripts/factory/worktree.sh:13-15` warns about, and the same
reason `scripts/worktree-init.sh` cannot be trusted here.

Note that `.claude/CLAUDE.md` still states the user has local PostgreSQL (not Docker). That line is
wrong; this file records the live observation.

Container defaults (from `scripts/factory/worktree.sh:29-33`):
`ship-audit-pg` · `localhost:5433` · user `ship` · password `ship_dev_password`.

## Checklist

Execute these steps in order:

```bash
# 1. Check Postgres is running — inside the container, since psql is not on PATH
docker ps --format '{{.Names}}' | grep -qx ship-audit-pg \
  || echo "ERROR: start it: docker start ship-audit-pg"
docker exec ship-audit-pg pg_isready -U ship

# 2. Install dependencies (worktrees don't share node_modules)
pnpm install

# 3. Build shared package (required for type-checking)
pnpm build:shared

# 4. Create the database if it doesn't exist (dev.sh writes .env.local but NOT the DB)
source api/.env.local 2>/dev/null
DB_NAME="${DATABASE_URL##*/}"
docker exec -i ship-audit-pg psql -U ship -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 \
  || docker exec -i ship-audit-pg createdb -U ship "${DB_NAME}"

# 5. Run migrations — NOTE: exits 0 even when it under-applies (finding DB-1)
pnpm db:migrate

# 6. Verify tests pass — api only; web is a separate suite with 13 known failures
pnpm test
```

**In a factory worktree, skip steps 1 and 4** — `scripts/factory/worktree.sh` already provisioned the
database and wrote `.factory-env`. `source .factory-env` instead of `api/.env.local`.

## Two footguns in step 5 and 6

- **`pnpm db:migrate` exits 0 while under-applying** (finding DB-1 — it abandons around migration
  010). A clean exit is not proof that all migrations ran. Confirm a specific column with
  `docker exec -i ship-audit-pg psql -U ship -d "$DB_NAME" -c '\d documents'` before relying on it.
- **`pnpm test` runs api only** and TRUNCATEs 16 tables in whatever `DATABASE_URL` resolves to.
  Confirm the URL points at this worktree's database first. Web is
  `pnpm --filter @ship/web test`, and it has 13 known failures quarantined in
  `audit/factory/quarantine.json` — those are expected, not your fault.

## Common Issues

| Error | Fix |
|-------|-----|
| `pg_isready: command not found` | Expected — there is no local Postgres. Use the `docker exec` form above. |
| `Cannot find module @ship/shared` | Run `pnpm build:shared` first |
| `database "X" does not exist` | Run the step 4 `createdb` command above |
| `docker: Error response … No such container` | `docker start ship-audit-pg`, or create it: `docker run -d --name ship-audit-pg -e POSTGRES_USER=ship -e POSTGRES_PASSWORD=ship_dev_password -e POSTGRES_DB=ship_dev -p 5433:5432 postgres:15-alpine` |
| 13 web tests failing | Expected (TEST-1 / TRO-223). Compare identities against the quarantine, not counts. |
| vendor/@fpki missing | Create symlink: `mkdir -p vendor/@fpki && ln -sf /path/to/main/repo/vendor/@fpki/auth-client vendor/@fpki/auth-client` |

## Usage

```
/ship-worktree-preflight
```

Or manually run the checklist steps when starting work in a new worktree.
