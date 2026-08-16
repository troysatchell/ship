#!/usr/bin/env bash
#
# verify-terraform-artifact.sh — mechanical assist for PF-900 / TRO-411's
# annotated `terraform plan` submission artifact.
#
# NOT a gate check (scripts/factory/gate.sh never calls this — nothing under
# api/src/**/*.test.ts or web/src/**/*.test.tsx can run terraform or hold
# Render credentials, so this ticket's test-design comment declared it an
# artifact-based deliverable, not a vitest spec). This script is the
# "optional mechanical assist" that same comment proposed: a grep-based
# string-presence check over a COMMITTED, ALREADY-CAPTURED `terraform plan`
# text file, catching a missing env var or resource before a human reviewer
# has to.
#
# What it checks (test-design comment items #2-#4 — see TRO-411):
#   #2 every new Week-6 platform env var appears inside an actual render_*
#      resource's env_vars block in the plan text, not just in prose/comments
#   #3 both service resource addresses + the Postgres resource address appear
#   #4 the provider pin in versions.tf is still an exact "x.y.z" (no ~>/>=)
#
# TRO-488 (PF-900 follow-up, CodeRabbit on PR #174/TRO-411): #2 and #4 used to
# grep the ENTIRE plan file / ENTIRE versions.tf, so a string that merely
# happened to appear somewhere in the file — prose describing an env var, a
# doc-comment example shaped like an env_vars map entry, a stray `version =
# "x.y.z"`-shaped line in an unrelated block — could false-positive a PASS
# without the content actually being inside a real render_web_service
# resource's env_vars map or the real required_providers.render entry. Both
# checks now extract just that block first (brace-balanced, so nested maps
# like env_vars don't truncate early) and grep only within it.
#
# What it CANNOT check (the same comment's items #1 and #5 — explicitly out
# of this script's reach): whether the plan is actually clean against LIVE
# Render state, and whether every value truly originates from committed
# config rather than a console edit. Those need a real `terraform plan -var-
# file=...` run against live credentials and a human/reviewer's own judgment
# — this script passing is not the artifact being complete.
#
# Usage:
#   scripts/factory/verify-terraform-artifact.sh <plan-file>
#
# Exit code: 0 if every check passes, 1 if any check fails (each failure is
# printed, not just the first).

set -uo pipefail

PLAN_FILE="${1:-}"
if [ -z "$PLAN_FILE" ]; then
  echo "usage: $0 <plan-file>" >&2
  exit 2
fi
if [ ! -f "$PLAN_FILE" ]; then
  echo "ERROR: plan file not found: $PLAN_FILE" >&2
  exit 2
fi

WT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository." >&2; exit 2; }
VERSIONS_TF="$WT_ROOT/terraform/render/versions.tf"

# extract_braced_blocks <file> <start-line-regex>
#
# Prints every top-level block whose opening line matches <start-line-regex>
# AND ends that same line with an opening `{` (so a diagnostic/prose line
# that merely *mentions* the same text without opening a block — e.g. plan
# output's own "on agent_service.tf line 47, in resource ..." warning
# annotations — is never mistaken for a block start). Once a block starts,
# brace-balances (counting `{`/`}` per line) until the count returns to zero,
# so nested maps (env_vars, its own per-key sub-maps, etc.) are included in
# full rather than truncating at the first inner `}`. Concatenates ALL
# matching blocks in the file (e.g. both render_web_service.ship AND
# render_web_service.agent), since env vars are split across the two.
extract_braced_blocks() {
  local file="$1" start_re="$2"
  awk -v start_re="$start_re" '
    $0 ~ start_re && /\{[[:space:]]*$/ { in_block = 1; depth = 0 }
    in_block {
      print
      line = $0
      opens = gsub(/\{/, "{", line)
      closes = gsub(/\}/, "}", line)
      depth += opens - closes
      if (depth <= 0) { in_block = 0 }
    }
  ' "$file"
}

FAIL=0

# --- #2: every new Week-6 platform env var, inside a render_* env_vars block ---
#
# Terraform's plan renderer prints env_vars map keys as `+ "KEY" = {` (create)
# or `~ "KEY" = {` (update) — see terraform/render/plan/*.md for real examples
# of this exact shape. Matching `"KEY" = {` (any leading diff marker) is a
# reasonable proxy for "inside an env_vars block, not prose" without a full
# HCL/plan-JSON parse — but only once it's scoped to the actual
# render_web_service resource block(s) first (TRO-488): a flat whole-file
# grep for that same shape would also match a doc-comment example or a
# prose description formatted to look like a map entry, anywhere in the file.
RENDER_WEB_SERVICE_BLOCKS="$(extract_braced_blocks "$PLAN_FILE" 'resource "render_web_service"')"

PLATFORM_ENV_VARS=(
  SECRET_ENCRYPTION_KEY
  FLEETGRAPH_OAUTH_CLIENT_SECRET
  GRADER_OAUTH_CLIENT_SECRET
  OAUTH_ACCESS_TOKEN_TTL_SECONDS
  OAUTH_REFRESH_TOKEN_TTL_SECONDS
  RATE_LIMIT_APP_RPM
  RATE_LIMIT_TOKEN_RPM
  AGENT_PLATFORM_MODE
)
for var in "${PLATFORM_ENV_VARS[@]}"; do
  if [ -z "$RENDER_WEB_SERVICE_BLOCKS" ]; then
    echo "FAIL  env_vars block missing ${var} (no render_web_service resource block found in: $PLAN_FILE)"
    FAIL=1
  elif grep -qE "\"${var}\"[[:space:]]*=[[:space:]]*\{" <<<"$RENDER_WEB_SERVICE_BLOCKS"; then
    echo "PASS  env_vars block declares ${var}"
  else
    echo "FAIL  env_vars block missing ${var} (checked inside render_web_service block(s) of: $PLAN_FILE)"
    FAIL=1
  fi
done

# --- #3: both service resources + Postgres resource, present as addresses ---
RESOURCE_ADDRESSES=(
  "render_web_service.ship"
  "render_web_service.agent"
  "render_postgres.ship"
)
for addr in "${RESOURCE_ADDRESSES[@]}"; do
  if grep -qF "$addr" "$PLAN_FILE"; then
    echo "PASS  resource address present: ${addr}"
  else
    echo "FAIL  resource address missing: ${addr} (checked: $PLAN_FILE)"
    FAIL=1
  fi
done

# --- #4: provider pin is still an exact version, no range operator ---
#
# TRO-488: scoped to the required_providers.render entry itself (the `render
# = { ... }` block nested inside `required_providers { ... }`), not a flat
# grep of the whole file. Previously, ANY line anywhere in versions.tf
# matching `version = "x.y.z"` at line-start would pass — today that's
# harmless because `required_version = ">= 1.9.0"` is the only other
# `*version*` line in the file and the old regex already excluded it by
# name, but the exclusion was doing that work per-string, not by actually
# checking the value came from the render provider's own pin; a future
# second provider block, or a `version = "x.y.z"`-shaped line in an
# unrelated resource/variable, would have silently passed too. Extracting
# the block first removes that entire class of false positive by construction.
if [ -f "$VERSIONS_TF" ]; then
  RENDER_PROVIDER_BLOCK="$(extract_braced_blocks "$VERSIONS_TF" '^[[:space:]]*render[[:space:]]*=')"
  if [ -z "$RENDER_PROVIDER_BLOCK" ]; then
    echo "FAIL  no required_providers.render entry found in versions.tf (checked: $VERSIONS_TF)"
    FAIL=1
  elif grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"[[:space:]]*$' <<<"$RENDER_PROVIDER_BLOCK" \
     && ! grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*"[~>=<]' <<<"$RENDER_PROVIDER_BLOCK"; then
    echo "PASS  render-oss/render provider is exact-pinned in versions.tf"
  else
    echo "FAIL  required_providers.render does not show an exact x.y.z pin (checked: $VERSIONS_TF)"
    FAIL=1
  fi
else
  echo "FAIL  versions.tf not found at $VERSIONS_TF"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify-terraform-artifact: PASS — all mechanical checks passed."
  echo "Reminder: this does NOT establish #1 (plan is clean against live state)"
  echo "or #5 (zero console-only config) — those require a real, credentialed"
  echo "'terraform plan' run and a human/reviewer's own judgment."
else
  echo "verify-terraform-artifact: FAIL — see FAIL lines above."
fi
exit "$FAIL"
