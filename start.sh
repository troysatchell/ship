#!/bin/bash
# One-command local start from a clean checkout (TRO-247 / assignment rule 6).
#
# From a genuinely clean checkout — no api/.env.local, no existing database,
# no prior state — this reaches a working app with one command:
#
#   ./start.sh
#
# WHY A SEPARATE FILE FROM scripts/dev.sh, NOT A NEW SETUP PATH
#
# scripts/dev.sh already does almost everything a one-command start needs:
# creates the database, runs migrations, seeds, finds free ports, starts both
# servers. This file adds only what it was missing, then hands off to it
# unchanged — see scripts/dev.sh's own header for the database-creation,
# migration-verification and idempotency details, all of which now run on
# every invocation rather than only the first:
#   - Checking for Node/pnpm themselves. dev.sh assumes they already exist;
#     a true "clean checkout" entry point should say so plainly if they don't.
#   - A short pointer to the hazards a new engineer hits right after this
#     script hands off (full detail in README "Cold start").
#
# A Makefile target was considered and rejected: this repo has no Makefile
# today, every existing entry point is a shell script under scripts/, and a
# Makefile would be one more tool to require for no behavior a shell script
# cannot already provide.
#
# DATABASE_URL / DB_NAME environment overrides are honored by scripts/dev.sh
# (see its header) and therefore work here unchanged — e.g. for a throwaway
# database on a one-off verification run:
#   DATABASE_URL=postgresql://ship:pass@localhost:5433/ship_verify ./start.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "" >&2
  echo "ERROR: $*" >&2
  exit 1
}

echo "=== Ship — one-command start ==="
echo ""

# --- preflight: the two tools scripts/dev.sh assumes are already on PATH ----
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= 20: https://nodejs.org/"

NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "node $(node -v) found, but Ship requires Node.js >= 20. Install a newer version: https://nodejs.org/"
fi

command -v pnpm >/dev/null 2>&1 || fail "pnpm not found. Install with: npm install -g pnpm"

echo "Node $(node -v), pnpm $(pnpm -v) — OK"
echo ""
echo "Notes (see README 'Cold start' for detail):"
echo "  - pnpm test TRUNCATES whatever DATABASE_URL points at (TEST-9) — never run"
echo "    it against the database this command just started against."
echo "  - Ports are dynamic; the ones this run picked are printed below and"
echo "    written to .ports."
echo ""

# Everything else — installing deps, building shared, ensuring the database
# exists / is migrated (verified) / is seeded, picking free ports, starting
# both servers, and printing the resolved URLs — lives in scripts/dev.sh, so
# there is exactly one place that logic is written and start.sh cannot drift
# from `pnpm dev`. exec (not a subshell call) so this process IS dev.sh's
# process — a single PID to signal for a clean shutdown.
exec "$ROOT_DIR/scripts/dev.sh"
