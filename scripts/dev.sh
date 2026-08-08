#!/bin/bash
# Dev server wrapper that finds available ports for multi-worktree development
#
# Strategy:
# 1. Ensure deps/shared are built, the database exists, is migrated (verified,
#    not just trusted) and seeded — idempotent, so this runs on EVERY start,
#    not only the first one (TRO-247 / RULE-6: a one-command start has to be
#    self-healing, not "correct once").
# 1.5. If Postgres is unreachable at the default address and nobody pinned a
#    database explicitly, bring it up via `docker compose -f
#    docker-compose.local.yml` (W4-R42: one command, no manual setup step of
#    "go start Postgres yourself"). Falls through to ensureDatabase.ts's own
#    actionable error when Docker isn't available — see the block itself
#    below for the full reasoning.
# 2. Scan actual port usage (not files) to find what's in use
# 3. Pick first available port pair (API: 3000+, Web: 5173+)
# 4. Write .ports file for reference (which worktree is where)
# 5. Start dev servers with those ports
#
# DATABASE_URL resolution (supports both a native Postgres install and a
# Docker one — see README "Cold start" for why both exist):
#   1. An explicit `DATABASE_URL` in the environment always wins.
#   2. Otherwise, an existing `api/.env.local` keeps its own value (so a plain
#      re-run never silently switches databases underneath a configured
#      worktree).
#   3. Otherwise, default exactly as before: postgresql://localhost/$DB_NAME,
#      where DB_NAME defaults to a name derived from this directory, or the
#      `DB_NAME` env var if set — unless step 1.5 above redirected it at a
#      freshly-started Docker Postgres instead.
# Postgres itself does not have to be local: `ensureDatabase.ts` connects over
# plain TCP, which is all a Docker Postgres with its port published to the
# host (e.g. `docker-compose.local.yml`, :5433) needs — no `psql`/`createdb`
# dependency either way.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# --- 1. dependencies ---------------------------------------------------------
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$ROOT_DIR" && pnpm install)
fi
if [ ! -d "$ROOT_DIR/shared/dist" ]; then
  echo "Building shared package..."
  (cd "$ROOT_DIR" && pnpm build:shared)
fi

# --- 2. resolve DATABASE_URL --------------------------------------------------
EXISTING_DB_URL=""
if [ -f "$ROOT_DIR/api/.env.local" ]; then
  EXISTING_DB_URL="$(grep '^DATABASE_URL=' "$ROOT_DIR/api/.env.local" | head -1 | cut -d= -f2-)"
fi

if [ -n "${DATABASE_URL:-}" ]; then
  RESOLVED_DATABASE_URL="$DATABASE_URL"
elif [ -n "$EXISTING_DB_URL" ]; then
  RESOLVED_DATABASE_URL="$EXISTING_DB_URL"
else
  WORKTREE_NAME=$(basename "$ROOT_DIR")
  # Convert to valid postgres db name (lowercase, replace non-alphanumeric with _)
  DEFAULT_DB_NAME="ship_$(echo "$WORKTREE_NAME" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]' '_' | sed 's/_*$//')"
  RESOLVED_DATABASE_URL="postgresql://localhost/${DB_NAME:-$DEFAULT_DB_NAME}"
fi

# --- 2.5. bootstrap Postgres via Docker if it's unreachable (RULE-6 / W4-R42) -
# A clean checkout with no Postgres running is exactly the case a
# "one command, no manual setup" start has to cover — today this branch's
# ensureDatabase.ts call below just throws its unreachableMessage() and stops,
# leaving "go start Postgres yourself" as the manual step the requirement
# rules out.
#
# Gated to the truly-default path only: an explicit DATABASE_URL or an
# existing api/.env.local means someone already decided where Postgres lives
# (a remote server, a non-standard local port, ...), and silently redirecting
# that would be a surprise, not a convenience. Only the plain
# `postgresql://localhost/$DB_NAME` default this script picks for itself is
# ours to fix.
#
# Reachability is checked by `api/src/db/postgresReachable.ts` (a plain TCP
# connect, not `psql`/`pg_isready` — this project's own factory environment
# has neither on PATH, `.claude/skills/ship-factory/references/lessons.md`
# #8) — the same pattern as the `ensureDatabase.ts`/`migrate.ts` calls below,
# and unit-tested at `api/src/db/__tests__/postgresReachable.test.ts` (which
# `pnpm --filter @ship/api test` runs, unlike this shell script).
if [ -z "${DATABASE_URL:-}" ] && [ -z "$EXISTING_DB_URL" ]; then
  if (cd "$ROOT_DIR/api" && npx tsx src/db/postgresReachable.ts "$RESOLVED_DATABASE_URL"); then
    DB_REACHABLE=1
  else
    DB_REACHABLE=0
  fi

  if [ "$DB_REACHABLE" -eq 0 ]; then
    if [ -f "$ROOT_DIR/docker-compose.local.yml" ] && command -v docker >/dev/null 2>&1; then
      echo "Postgres unreachable at the default local address — starting it via"
      echo "docker-compose.local.yml's postgres service..."
      # Fixed project name (-p ship), not the directory-derived default docker
      # compose would otherwise pick (which differs per worktree — verified:
      # 'ship' from the main checkout, 'ship-wt-w4_sweepa' etc. from a
      # worktree). Pinning it means every worktree that hits this path brings
      # up or reuses the SAME container, matching how this repo already runs
      # Postgres in practice (one shared container on :5433 — see lessons.md
      # #8) instead of each worktree fighting over docker-compose.local.yml's
      # fixed 5433:5432 host port mapping with its own separate container.
      if (cd "$ROOT_DIR" && docker compose -p ship -f docker-compose.local.yml up -d postgres); then
        echo -n "Waiting for the postgres container to report healthy"
        DB_HEALTHY=0
        for _ in $(seq 1 30); do
          HEALTH="$(docker compose -p ship -f "$ROOT_DIR/docker-compose.local.yml" ps postgres --format '{{.Health}}' 2>/dev/null || true)"
          if [ "$HEALTH" = "healthy" ]; then
            DB_HEALTHY=1
            break
          fi
          echo -n "."
          sleep 2
        done
        echo ""

        if [ "$DB_HEALTHY" -eq 1 ]; then
          echo "Postgres container healthy."
          # docker-compose.local.yml's own postgres service (see the file's
          # header) is ship:ship_dev_password@localhost:5433 — not the bare
          # native-install default (localhost:5432, no auth) we just failed
          # to reach, so point at the container instead of retrying the same
          # address.
          RESOLVED_DATABASE_URL="postgresql://ship:ship_dev_password@localhost:5433/${DB_NAME:-$DEFAULT_DB_NAME}"
        else
          echo "WARNING: postgres container did not report healthy within 60s." >&2
          echo "Continuing with the original DATABASE_URL — ensureDatabase.ts below will" >&2
          echo "report the real error if Postgres is still unreachable." >&2
        fi
      else
        echo "WARNING: 'docker compose -f docker-compose.local.yml up -d postgres' failed" >&2
        echo "(often a host-port collision with a Postgres already running outside this" >&2
        echo "project's compose namespace). Continuing with the original DATABASE_URL —" >&2
        echo "ensureDatabase.ts below will report the real error." >&2
      fi
    fi
    # Else: no docker-compose.local.yml, or no `docker` on PATH. Fall through
    # unchanged — ensureDatabase.ts's own unreachableMessage()
    # (api/src/db/ensureDatabase.ts:53-61) is the correct, actionable error
    # for that case and stays the fallback. This block only ever adds a path
    # to success; it never replaces that message with anything, including a
    # hang.
  fi
fi

# Ensure api/.env.local exists (only when missing — never overwrite a
# worktree's existing configuration).
if [ ! -f "$ROOT_DIR/api/.env.local" ]; then
  echo "Creating api/.env.local..."
  cat > "$ROOT_DIR/api/.env.local" << EOF
DATABASE_URL=$RESOLVED_DATABASE_URL
SESSION_SECRET=dev-secret-change-in-production
EOF
fi

# --- 3. database: exists, migrated (verified), seeded ------------------------
# All four steps are idempotent (ensureDatabase/migrate/seed no-op when
# already done; verifyMigrations is read-only) and run every invocation, so a
# re-run heals a partially-set-up environment instead of assuming yesterday's
# state is still true. `set -e` means any failure here — including
# `ensureDatabase.ts`'s actionable "Postgres unreachable" message, or
# `verifyMigrations.ts` catching a DB-1-shaped gap — stops the script instead
# of starting servers against a database that is not actually ready.
echo "Ensuring database exists..."
(cd "$ROOT_DIR/api" && DATABASE_URL="$RESOLVED_DATABASE_URL" npx tsx src/db/ensureDatabase.ts)

echo "Running migrations..."
(cd "$ROOT_DIR/api" && DATABASE_URL="$RESOLVED_DATABASE_URL" npx tsx src/db/migrate.ts)

echo "Verifying migrations..."
(cd "$ROOT_DIR/api" && DATABASE_URL="$RESOLVED_DATABASE_URL" npx tsx src/db/verifyMigrations.ts)

echo "Seeding database..."
(cd "$ROOT_DIR/api" && DATABASE_URL="$RESOLVED_DATABASE_URL" npx tsx src/db/seed.ts)

# Base ports
API_BASE=3000
WEB_BASE=5173

# Find an available port starting from base
find_available_port() {
  local base=$1
  local port=$base
  local max_attempts=20

  for ((i=0; i<max_attempts; i++)); do
    if ! lsof -i:$port >/dev/null 2>&1; then
      echo $port
      return 0
    fi
    ((port++))
  done

  echo "ERROR: Could not find available port after $max_attempts attempts (starting from $base)" >&2
  return 1
}

# Find available ports
echo "Finding available ports..."
API_PORT=$(find_available_port $API_BASE)
WEB_PORT=$(find_available_port $WEB_BASE)
AGENT_PORT=$(find_available_port 3100)

echo "Using API port: $API_PORT"
echo "Using Web port: $WEB_PORT"
echo "Using Agent port: $AGENT_PORT"

# Write .ports file for reference
cat > "$ROOT_DIR/.ports" << EOF
# Auto-generated by scripts/dev.sh
# This file shows which ports this worktree's dev server is using
# DO NOT EDIT - will be overwritten on next dev start
API=$API_PORT
WEB=$WEB_PORT
AGENT=$AGENT_PORT
STARTED=$(date -Iseconds)
WORKTREE=$(basename "$ROOT_DIR")
EOF

echo "Wrote .ports file"

# Clean up .ports file on exit
cleanup() {
  if [ -f "$ROOT_DIR/.ports" ]; then
    rm -f "$ROOT_DIR/.ports"
    echo "Cleaned up .ports file"
  fi
  # Both dev process groups are started as background jobs below; make sure
  # neither outlives the wrapper.
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null
  [ -n "${AGENT_PID:-}" ] && kill "$AGENT_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Export environment variables and start dev servers.
# PORT is deliberately NOT exported globally: agent/ also reads PORT (via
# dotenv, which never overrides an exported var), so a global export makes
# the agent race the API for the same socket — the API then dies with
# EADDRINUSE on its own port. Each process group gets its own PORT below.
# SHIP_API_BASE_URL / AGENT_API_BASE_URL are exported here because both
# sides' ports can drift under find_available_port, and an exported value
# wins over both packages' env files (api: envFile.ts precedence; agent:
# dotenv default) — so the two services always find each other.
export CORS_ORIGIN="http://localhost:$WEB_PORT"
export VITE_PORT=$WEB_PORT
export VITE_API_URL="http://localhost:$API_PORT"
export SHIP_API_BASE_URL="http://localhost:$API_PORT"
export AGENT_API_BASE_URL="http://localhost:$AGENT_PORT"

echo "Starting dev servers..."
echo "  API:   http://localhost:$API_PORT"
echo "  Web:   http://localhost:$WEB_PORT"
echo "  Agent: http://localhost:$AGENT_PORT"
echo ""

cd "$ROOT_DIR"
PORT=$API_PORT pnpm --parallel --filter '!@ship/agent' --recursive run dev &
APP_PID=$!
PORT=$AGENT_PORT pnpm --filter @ship/agent run dev &
AGENT_PID=$!
wait $APP_PID $AGENT_PID
