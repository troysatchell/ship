#!/usr/bin/env bash
#
# gate.sh — the factory's cheap-tier eval. Run inside a ticket worktree.
#
# This is the objective "is this ticket done" check. An agent's self-report is a
# claim; this script is the result. It is deliberately mechanical: every gate
# either passes or fails on evidence, and the JSON it writes becomes the PR body's
# evidence block (see .claude/CLAUDE.md — claim provenance).
#
# It does NOT measure improvement. Proving a finding is actually fixed is the
# expensive tier — a compare-mode run of the category audit skill against the
# `audit-baseline` tag. See .claude/skills/ship-factory/references/evals.md.
#
# Usage:
#   scripts/factory/gate.sh                 # full gate
#   scripts/factory/gate.sh --fast          # skip build + CodeRabbit (inner loop)
#   scripts/factory/gate.sh --skip-review   # skip CodeRabbit only
#
set -uo pipefail

FAST=0
SKIP_REVIEW=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1; SKIP_REVIEW=1 ;;
    --skip-review) SKIP_REVIEW=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

WT_ROOT="$(git rev-parse --show-toplevel)"
cd "$WT_ROOT"

# .factory-env carries the ticket id and the worktree's EXCLUSIVE database.
# Without it we would run unit tests against whatever DATABASE_URL happens to be
# set — and api/src/test/setup.ts TRUNCATEs on contact. Refuse rather than guess.
if [ -f .factory-env ]; then
  set -a; . ./.factory-env; set +a
fi
TICKET="${FACTORY_TICKET:-}"
if [ -z "$TICKET" ]; then
  echo "ERROR: no .factory-env / FACTORY_TICKET. Provision with scripts/factory/worktree.sh." >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL unset. api unit tests TRUNCATE their target database;" >&2
  echo "       refusing to run against an unknown one." >&2
  exit 2
fi
case "${DATABASE_URL}" in
  *ship_wt_*|*ship_factory_*|*ship_ci*) ;;
  *) echo "ERROR: DATABASE_URL does not look like a factory-owned database:" >&2
     echo "       ${DATABASE_URL}" >&2
     echo "       Unit tests TRUNCATE 16 tables. Refusing." >&2
     exit 2 ;;
esac

BASE_REF="${FACTORY_BASE_REF:-main}"
OUT_DIR="${WT_ROOT}/.factory"
mkdir -p "$OUT_DIR"

# The quarantine baseline is materialized from BASE_REF, never read from the
# ticket branch. Reading the branch copy would let an agent append its own new
# failures to quarantine.json and pass the gate — exactly the gaming this file
# is supposed to prevent. Legitimately FIXING a quarantined test still works:
# testdiff reports it as "fixed", which is informational, not a failure.
QUARANTINE="${OUT_DIR}/quarantine-base.json"
if git show "${BASE_REF}:audit/factory/quarantine.json" > "$QUARANTINE" 2>/dev/null; then
  :
elif [ -f "${WT_ROOT}/audit/factory/quarantine.json" ]; then
  cp "${WT_ROOT}/audit/factory/quarantine.json" "$QUARANTINE"
  echo "  note: no quarantine baseline on ${BASE_REF}; using working-tree copy"
else
  echo "ERROR: no quarantine baseline on ${BASE_REF} or in the working tree." >&2
  exit 2
fi

RESULTS=()          # "id|status|detail"
OVERALL=pass

record() {           # record <id> <status> <detail>
  RESULTS+=("$1|$2|$3")
  local icon="ok "
  [ "$2" = fail ] && icon="FAIL"
  [ "$2" = skip ] && icon="skip"
  [ "$2" = warn ] && icon="warn"
  printf '  [%s] %-22s %s\n' "$icon" "$1" "$3"
  [ "$2" = fail ] && OVERALL=fail
  return 0
}

echo "=== factory gate: ${TICKET} (base ${BASE_REF}) ==="
echo

# --- G1: type check ---------------------------------------------------------
if pnpm type-check > "$OUT_DIR/typecheck.log" 2>&1; then
  record typecheck pass "all packages clean"
else
  record typecheck fail "see .factory/typecheck.log ($(grep -c 'error TS' "$OUT_DIR/typecheck.log" 2>/dev/null || echo '?') TS errors)"
fi

# --- G2: build --------------------------------------------------------------
if [ "$FAST" = 1 ]; then
  record build skip "--fast"
elif pnpm build > "$OUT_DIR/build.log" 2>&1; then
  record build pass "all packages built"
else
  record build fail "see .factory/build.log"
fi

# --- G3/G4: unit tests vs quarantine baseline -------------------------------
# Compares failure IDENTITIES, not counts: an agent that fixes one test and
# breaks another would keep the totals equal and slip through a count check.
run_tests() { # run_tests <pkg>
  local pkg="$1"
  local json="$OUT_DIR/${pkg}-tests.json"
  local log="$OUT_DIR/${pkg}-tests.log"
  pnpm --filter "@ship/${pkg}" test --reporter=json --outputFile="$json" > "$log" 2>&1
  if [ ! -f "$json" ]; then
    record "tests:${pkg}" fail "runner produced no report — see .factory/${pkg}-tests.log"
    return 1
  fi
  local diffout
  diffout="$(node "${WT_ROOT}/scripts/factory/lib/testdiff.mjs" \
      --package "$pkg" --current "$json" --baseline "$QUARANTINE" \
      --repo-root "$WT_ROOT" 2>&1)"
  local rc=$?
  echo "$diffout" > "$OUT_DIR/${pkg}-testdiff.txt"
  local fixed
  if [ $rc -eq 0 ]; then
    # `grep -c` exits 1 on zero matches, so `|| echo 0` would append a SECOND
    # line and produce "0\n0" — which fails an integer test. Assign on failure
    # instead of piping a fallback.
    fixed=$(grep -c '^  +' "$OUT_DIR/${pkg}-testdiff.txt" 2>/dev/null) || fixed=0
    if [ "${fixed:-0}" -gt 0 ]; then
      record "tests:${pkg}" pass "no new failures; ${fixed} quarantined test(s) now pass"
    else
      record "tests:${pkg}" pass "no new failures vs baseline"
    fi
  else
    record "tests:${pkg}" fail "new failure(s) — see .factory/${pkg}-testdiff.txt"
  fi
}
run_tests api
run_tests web

# --- G5: tests were not weakened -------------------------------------------
# Agents MUST add regression tests, so test files are not frozen outright. What
# is forbidden is making the suite weaker: removing assertions or skipping tests.
WEAKENED=""
DIFF_TESTS="$(git diff "${BASE_REF}"...HEAD --name-only -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null || true)"
if [ -n "$DIFF_TESTS" ]; then
  SKIPS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^\+' | grep -cE '\.(skip|todo|fixme)\(' || true)"
  DELS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^-' | grep -cE '^\-\s*(it|test|expect)\(' || true)"
  [ "${SKIPS:-0}" -gt 0 ] && WEAKENED="${WEAKENED}${SKIPS} newly skipped test(s); "
  [ "${DELS:-0}" -gt 0 ] && WEAKENED="${WEAKENED}${DELS} removed test/assertion line(s); "
fi
if [ -n "$WEAKENED" ]; then
  record tests:not-weakened fail "${WEAKENED}justify in the PR or revert"
else
  record tests:not-weakened pass "no tests skipped or assertions removed"
fi

# --- G6: regression test present (assignment rule 3) ------------------------
# "A test file was touched" is too weak — reformatting or deleting a test would
# satisfy it. Require at least one ADDED test case.
ADDED_CASES=$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
              | grep -cE '^\+[[:space:]]*(it|test)(\.[a-z]+)?\(') || ADDED_CASES=0
if [ "${ADDED_CASES:-0}" -gt 0 ]; then
  record regression-test pass "${ADDED_CASES} test case(s) added in $(echo "$DIFF_TESTS" | grep -c . ) file(s)"
else
  record regression-test fail "rule 3 requires a regression test per audit bug; no new test case added"
fi

# --- G7: CHANGES.md entry (assignment rule 8) -------------------------------
if [ ! -f CHANGES.md ]; then
  record changes-md fail "CHANGES.md missing (rule 8)"
elif grep -q "$TICKET" CHANGES.md; then
  record changes-md pass "entry for ${TICKET} present"
else
  record changes-md fail "no entry mentioning ${TICKET}"
fi

# --- G8: scope discipline ---------------------------------------------------
CHANGED_FILES="$(git diff "${BASE_REF}"...HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')"
if [ "${CHANGED_FILES:-0}" -eq 0 ]; then
  record scope fail "branch has no changes vs ${BASE_REF}"
elif [ "${CHANGED_FILES:-0}" -gt 40 ]; then
  record scope warn "${CHANGED_FILES} files changed — unusually broad for one finding"
else
  record scope pass "${CHANGED_FILES} file(s) changed"
fi

# --- G9: CodeRabbit review --------------------------------------------------
if [ "$SKIP_REVIEW" = 1 ]; then
  record coderabbit skip "disabled for this run"
elif ! command -v coderabbit >/dev/null 2>&1; then
  record coderabbit skip "CLI not installed"
else
  # --agent emits structured findings; the triage step classifies them into
  # fix-now / new-Linear-ticket / dismissed. CodeRabbit findings never fail the
  # gate on their own — a reviewer's opinion is input to triage, not a verdict.
  if coderabbit review --agent --base "${BASE_REF}" > "$OUT_DIR/coderabbit.json" 2>"$OUT_DIR/coderabbit.err"; then
    record coderabbit pass "findings captured — see .factory/coderabbit.json (triage required)"
  else
    record coderabbit warn "review did not complete — see .factory/coderabbit.err"
  fi
fi

# --- verdict ----------------------------------------------------------------
echo
echo "=== ${TICKET}: ${OVERALL} ==="

{
  echo '{'
  echo "  \"ticket\": \"${TICKET}\","
  echo "  \"branch\": \"$(git branch --show-current)\","
  echo "  \"headSha\": \"$(git rev-parse HEAD)\","
  echo "  \"baseRef\": \"${BASE_REF}\","
  echo "  \"baseSha\": \"$(git rev-parse "${BASE_REF}" 2>/dev/null || echo unknown)\","
  echo "  \"ranAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"verdict\": \"${OVERALL}\","
  echo '  "gates": ['
  for i in "${!RESULTS[@]}"; do
    IFS='|' read -r id st detail <<< "${RESULTS[$i]}"
    sep=','; [ "$i" -eq $(( ${#RESULTS[@]} - 1 )) ] && sep=''
    echo "    {\"id\": \"${id}\", \"status\": \"${st}\", \"detail\": \"${detail//\"/\\\"}\"}${sep}"
  done
  echo '  ]'
  echo '}'
} > "$OUT_DIR/gate-result.json"

echo "evidence: .factory/gate-result.json"
[ "$OVERALL" = pass ] && exit 0 || exit 1
