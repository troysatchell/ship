#!/bin/bash
#
# Guard against a second Terraform root reappearing for AWS infrastructure
# (TRO-235 / TF-2).
#
# Background: this repo used to have TWO root configs both managing prod AWS
# infra — the flat `terraform/*.tf` and the modular `terraform/environments/prod`
# + `terraform/modules/*` — with separate state and drifted security controls
# (see audit/AUDIT_REPORT.md, finding TF-2). TRO-235 converged prod onto the
# flat `terraform/` root and deleted `terraform/environments/prod`. This script
# fails CI if that duplicate quietly reappears, or if any other directory
# starts configuring its own `provider "aws"` root outside the allowed set.
#
# What counts as an "AWS Terraform root": a directory containing a .tf file
# with a `provider "aws"` block. Root modules configure providers; child
# modules (terraform/modules/*) do not — they receive everything via input
# variables — so this check does not need to (and deliberately does not)
# enumerate every directory containing `resource "aws_*"` blocks, which would
# also match shared module code and the cloud-free `audit/terraform/drift-demo`
# fixture (that one uses `provider "local"`, never `aws`, so it is unaffected).
#
# terraform/environments/dev and terraform/environments/shadow are legitimate
# and are NOT part of the TF-2 duplication: they manage genuinely different,
# non-overlapping infrastructure (separate AWS environments), and are the only
# Terraform-backed deploy path for those environments today — scripts/deploy.sh,
# scripts/deploy-web.sh, and scripts/terraform.sh all hard-code "prod uses
# terraform/, dev/shadow use terraform/environments/$ENV". Deleting them was
# out of scope for TF-2 (which is specifically about the prod duplicate) and
# would have silently broken those scripts. terraform/bootstrap is a one-time,
# intentionally separate root that creates the shared state bucket.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALLOWED_ROOTS=(
  "terraform"
  "terraform/bootstrap"
  "terraform/environments/dev"
  "terraform/environments/shadow"
)

fail=0

# Explicit regression guard for the exact historical duplicate this ticket
# removed. Checked unconditionally (even before scanning file contents) so a
# partially-restored directory is still caught.
if [ -d "terraform/environments/prod" ]; then
  echo "ERROR: terraform/environments/prod has reappeared."
  echo "       terraform/ is the single authoritative root for prod AWS infra (TRO-235 / TF-2)."
  fail=1
fi

# Find every directory (repo-wide, excluding VCS/dependency/terraform-cache
# dirs) that declares its own provider "aws" block, i.e. every AWS Terraform
# root that currently exists.
found_roots=()
while IFS= read -r dir; do
  found_roots+=("$dir")
done < <(
  find . \
    -type d \( -name ".git" -o -name "node_modules" -o -name ".terraform" \) -prune -o \
    -type f -name "*.tf" -print \
    | xargs grep -l 'provider[[:space:]]*"aws"' 2>/dev/null \
    | xargs -n1 dirname \
    | sed 's|^\./||' \
    | sort -u
)

for root in "${found_roots[@]}"; do
  allowed=0
  for a in "${ALLOWED_ROOTS[@]}"; do
    if [ "$root" = "$a" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -eq 0 ]; then
    echo "ERROR: found an AWS Terraform root outside the allowed set: $root"
    echo "       Allowed roots: ${ALLOWED_ROOTS[*]}"
    fail=1
  fi
done

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "Only one Terraform root may manage prod AWS infrastructure: terraform/ (flat root)."
  echo "See terraform/README.md and audit/AUDIT_REPORT.md (TF-2) for why."
  exit 1
fi

echo "OK: single authoritative Terraform root confirmed for prod."
echo "    AWS roots found (${#found_roots[@]}): ${found_roots[*]}"
