#!/usr/bin/env bash
#
# worktree.sh — provision an isolated worktree for one factory ticket.
#
# WHY THIS EXISTS, and why scripts/worktree-init.sh is not enough:
#
#   api/src/test/setup.ts runs `TRUNCATE ... CASCADE` over 16 tables in the
#   beforeAll of EVERY test file, against whatever DATABASE_URL resolves to.
#   Two factory agents sharing one database will silently destroy each other's
#   fixtures mid-run and produce failures that look like code defects. Every
#   ticket therefore gets its own database, not just its own branch.
#
#   worktree-init.sh additionally assumes a local postgres on :5432 reachable
#   via `createdb`/`psql`. Neither binary is on PATH on this machine; it degrades
#   to a warning and then seeding fails. This script targets the Docker postgres
#   the audit already standardized on.
#
# Usage:  scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
#
set -euo pipefail

TICKET="${1:?usage: worktree.sh <TICKET-ID> <branch-name> [base-ref]}"
BRANCH="${2:?usage: worktree.sh <TICKET-ID> <branch-name> [base-ref]}"
BASE_REF="${3:-main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Config, overridable from the environment.
PG_CONTAINER="${FACTORY_PG_CONTAINER:-ship-audit-pg}"
PG_HOST="${FACTORY_PG_HOST:-localhost}"
PG_PORT="${FACTORY_PG_PORT:-5433}"
PG_USER="${FACTORY_PG_USER:-ship}"
PG_PASSWORD="${FACTORY_PG_PASSWORD:-ship_dev_password}"

# Validate the ticket ID BEFORE it reaches a database name. TICKET is
# interpolated into psql commands below, and identifiers cannot be bound as
# parameters — so a ticket like `X"; DROP DATABASE ship_dev; --` would execute.
# Reject anything that is not a plain ticket ID rather than trying to escape it.
if ! [[ "$TICKET" =~ ^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$ ]]; then
  echo "ERROR: invalid ticket ID '${TICKET}'." >&2
  echo "       Expected a plain Linear identifier such as TRO-178." >&2
  exit 2
fi

TICKET_SLUG="$(echo "$TICKET" | tr '[:upper:]-' '[:lower:]_')"
DB_NAME="ship_wt_${TICKET_SLUG}"
# Canonicalized: `git worktree list` prints resolved absolute paths, so an
# unnormalized "${REPO_ROOT}/../Ship-wt-x" never matches and the reuse check
# below silently misses — making every retry fail in `git worktree add`.
WT_PATH="$(cd "${REPO_ROOT}/.." && pwd -P)/Ship-wt-${TICKET_SLUG}"

echo "=== factory worktree: ${TICKET} ==="
echo "  branch:    ${BRANCH}  (from ${BASE_REF})"
echo "  worktree:  ${WT_PATH}"
echo "  database:  ${DB_NAME}"
echo

# --- 1. preconditions -------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "ERROR: postgres container '${PG_CONTAINER}' is not running." >&2
  echo "Start it with:" >&2
  echo "  docker run -d --name ${PG_CONTAINER} -e POSTGRES_DB=ship_dev \\" >&2
  echo "    -e POSTGRES_USER=${PG_USER} -e POSTGRES_PASSWORD=${PG_PASSWORD} \\" >&2
  echo "    -p ${PG_PORT}:5432 postgres:15-alpine" >&2
  exit 1
fi

# --- 2. worktree ------------------------------------------------------------
if git worktree list --porcelain | grep -qx "worktree ${WT_PATH}"; then
  echo "worktree already exists, reusing it"
else
  if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git worktree add "$WT_PATH" "$BRANCH"
  else
    git worktree add "$WT_PATH" -b "$BRANCH" "$BASE_REF"
  fi
fi

# --- 3. isolated database ---------------------------------------------------
# Dropped and recreated so a retried ticket starts from a known state rather
# than inheriting a half-migrated database from the previous attempt.
echo "provisioning database ${DB_NAME}..."
# WITH (FORCE) terminates any lingering backend first. Without it a retry after
# a crashed agent — whose pool is still connected — fails with "database is being
# accessed by other users" and aborts provisioning under `set -e`. (pg13+.)
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" \
  -c "CREATE DATABASE ${DB_NAME} OWNER ${PG_USER};" >/dev/null

DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

# --- 4. per-worktree ports --------------------------------------------------
# The hash gives a STABLE starting point across re-provisions; it does not give
# uniqueness. md5 % 900 collides (birthday bound: ~50% odds by 36 concurrent
# tickets), so we probe upward from it and claim the first port that is neither
# listening nor already recorded in a sibling worktree's .factory-env.
HASH="$(echo -n "$TICKET_SLUG" | md5 2>/dev/null | cut -c1-4 || echo -n "$TICKET_SLUG" | md5sum | cut -c1-4)"
PORT_OFFSET=$(( 0x$HASH % 900 + 10 ))

WT_PARENT="$(cd "${REPO_ROOT}/.." && pwd -P)"

port_listening() {   # 0 = something is bound to it
  ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) >/dev/null 2>&1
}

port_claimed() {     # 0 = another worktree already recorded it
  grep -rhsE "^export (API_PORT|WEB_PORT)=$1$" \
    "${WT_PARENT}"/Ship-wt-*/.factory-env 2>/dev/null | grep -q .
}

find_free_port() {   # find_free_port <start>
  local p="$1" tries=0
  while [ $tries -lt 500 ]; do
    if ! port_listening "$p" && ! port_claimed "$p"; then
      echo "$p"; return 0
    fi
    p=$(( p + 1 )); tries=$(( tries + 1 ))
  done
  echo "ERROR: no free port found starting at $1" >&2
  return 1
}

API_PORT="$(find_free_port $(( 3000 + PORT_OFFSET )))"
WEB_PORT="$(find_free_port $(( 5173 + PORT_OFFSET )))"
echo "  ports:     api ${API_PORT} / web ${WEB_PORT}"

cd "$WT_PATH"

cat > api/.env.local <<EOF
# Auto-generated by scripts/factory/worktree.sh for ${TICKET}
# This database is EXCLUSIVE to this worktree. Unit tests TRUNCATE it.
PORT=${API_PORT}
NODE_ENV=development
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=factory-local-${TICKET_SLUG}-not-a-real-secret
LOG_LEVEL=debug
CORS_ORIGIN=http://localhost:${WEB_PORT}
EOF

cat > web/.env.local <<EOF
# Auto-generated by scripts/factory/worktree.sh for ${TICKET}
VITE_API_URL=http://localhost:${API_PORT}
VITE_PORT=${WEB_PORT}
EOF

# The gate and any agent shell in this worktree read this file.
# Every line is `export`ed: the documented workflow is `source .factory-env`,
# and a plain assignment would set the variable in the shell but NOT pass
# DATABASE_URL to `pnpm`, so tests would run against the wrong database.
cat > .factory-env <<EOF
export FACTORY_TICKET=${TICKET}
export FACTORY_BRANCH=${BRANCH}
export FACTORY_BASE_REF=${BASE_REF}
export FACTORY_DB_NAME=${DB_NAME}
export DATABASE_URL=${DATABASE_URL}
export API_PORT=${API_PORT}
export WEB_PORT=${WEB_PORT}
EOF
# .factory-env and .factory/ are ignored via the tracked .gitignore.
# Do NOT write to .git/info/exclude here: in a linked worktree `.git` is a FILE
# holding a gitdir pointer, so that path fails with "Not a directory" and, under
# `set -e`, aborts provisioning before the database is ever migrated.

# --- 5. dependencies + schema ----------------------------------------------
if [ ! -d node_modules ]; then
  echo "installing dependencies (this is the slow part)..."
  pnpm install --silent
fi
if [ ! -d shared/dist ]; then
  echo "building shared..."
  pnpm build:shared >/dev/null
fi

echo "migrating ${DB_NAME}..."
DATABASE_URL="$DATABASE_URL" pnpm db:migrate

# NOTE: we do NOT seed by default. Unit tests truncate everything in beforeAll,
# so seeding before them is wasted work. Tickets that need seeded data (perf and
# db-query compare runs) seed explicitly:  DATABASE_URL=... pnpm db:seed

echo
echo "=== ready ==="
echo "cd ${WT_PATH}"
echo "source .factory-env   # exports DATABASE_URL scoped to this ticket"
