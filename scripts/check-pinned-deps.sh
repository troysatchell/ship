#!/usr/bin/env bash
#
# check-pinned-deps.sh
#
# W4-R38: "Dependency versions must be pinned in package.json and lockfiles
# committed." Fails if any dependencies/devDependencies entry in a workspace
# manifest uses a caret (^) or tilde (~) range instead of an exact version.
#
# Scope: root package.json + every package listed in pnpm-workspace.yaml
# (api, web, shared, agent). research/configs/package.json is a standalone
# reference/starter template with its own pnpm-workspace.yaml — it is not a
# member of this repo's workspace and is deliberately excluded.
#
# `workspace:*` references and `pnpm.overrides`-controlled ranges are not
# affected by this check: overrides are excluded by name (they still declare
# ranges intentionally, e.g. `">=X.Y.Z"`), and `workspace:*` never matches
# `^`/`~`.
#
# Usage:
#   ./scripts/check-pinned-deps.sh
#
# Exit codes:
#   0 - every dependency entry is pinned exactly (or workspace:*)
#   1 - one or more caret/tilde ranges found

set -e

MANIFESTS=(
  "package.json"
  "api/package.json"
  "web/package.json"
  "shared/package.json"
  "agent/package.json"
)

found=0

for f in "${MANIFESTS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "check-pinned-deps: manifest not found: $f" >&2
    exit 1
  fi

  # Dependency lines look like:  "name": "^1.2.3"  or  "name": "~1.2.3"
  # Restrict to the dependencies/devDependencies value position by matching
  # `": "` followed immediately by a caret or tilde.
  matches=$(grep -nE '": "[\^~]' "$f" || true)
  if [ -n "$matches" ]; then
    echo "check-pinned-deps: unpinned (caret/tilde) range(s) in $f:"
    echo "$matches" | sed 's/^/  /'
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo ""
  echo "One or more dependency ranges are not pinned to an exact version."
  echo "W4-R38 requires every dependencies/devDependencies entry to be an exact"
  echo "version (workspace:* and pnpm.overrides entries are exempt)."
  exit 1
fi

echo "check-pinned-deps: all dependency entries are pinned exactly."
exit 0
