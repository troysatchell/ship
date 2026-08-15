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

WT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository." >&2; exit 2; }
cd "$WT_ROOT" || { echo "ERROR: cannot cd to ${WT_ROOT}" >&2; exit 2; }

# .factory-env carries the ticket id and the worktree's EXCLUSIVE database.
# Without it we would run unit tests against whatever DATABASE_URL happens to be
# set — and api/src/test/setup.ts TRUNCATEs on contact. Refuse rather than guess.
#
# An explicitly-exported FACTORY_BASE_REF must survive the source. `.factory-env`
# hardcodes `main`, and `set -a; .` overwrites the caller's value — so
# `FACTORY_BASE_REF=origin/main scripts/factory/gate.sh` silently gated against
# the local ref instead. That matters at factory pace: local `main` is shared
# across worktrees and lagged `origin/main` by three merges in one session
# (TRO-226). Triple-dot diffs still resolve via merge-base, so the failure is
# quiet rather than loud, which is worse.
BASE_REF_OVERRIDE="${FACTORY_BASE_REF:-}"
if [ -f .factory-env ]; then
  set -a; . ./.factory-env; set +a
fi
if [ -n "$BASE_REF_OVERRIDE" ]; then
  FACTORY_BASE_REF="$BASE_REF_OVERRIDE"
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
  # TRO-448: resolve the real package directory via pnpm rather than assuming
  # ${WT_ROOT}/${pkg} — true for top-level packages (api/web/agent/sdk) but
  # false for nested integrations/* packages (cli lives at integrations/cli),
  # which broke the standalone-rerun cd below with "No such file or
  # directory" the first time tests:cli actually failed for real.
  local pkg_dir
  pkg_dir="$(pnpm --filter "@ship/${pkg}" exec pwd 2>/dev/null | tail -1)"
  [ -d "$pkg_dir" ] || pkg_dir="${WT_ROOT}/${pkg}"
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
    # A new failure is a FAIL. But this repo has a documented load-sensitive
    # mechanism (TEST-12 / TRO-277) with at least nine known identities, all of
    # which fail inside a full gate run — which carries typecheck + build, and
    # often runs alongside sibling worktrees — and pass standalone. Every agent
    # in the 2026-07-30 run had to re-run failures by hand to tell load noise
    # from a real regression, which is slow and easy to skip.
    #
    # So do that re-run here and REPORT it. Deliberately NOT downgraded to a
    # warn: "fails in the suite, passes alone" is also the signature of a
    # genuine test-isolation bug, which is precisely what TEST-12 turned out to
    # be. Auto-passing it would hide the class this project keeps finding. The
    # verdict stays fail; the operator gets the diagnosis for free.
    local files standalone_pass=0 standalone_total=0
    files="$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const out = new Set();
        for (const s of j.testResults || [])
          for (const a of s.assertionResults || [])
            if (a.status === "failed") out.add(s.name);
        process.stdout.write([...out].join("\n"));
      } catch { /* no report, nothing to re-run */ }
    ' "$json" 2>/dev/null)"

    if [ -n "$files" ]; then
      : > "$OUT_DIR/${pkg}-standalone.txt"
      while IFS= read -r tf; do
        [ -z "$tf" ] && continue
        standalone_total=$((standalone_total + 1))
        if (cd "$pkg_dir" && npx vitest run "$tf" > /dev/null 2>&1); then
          standalone_pass=$((standalone_pass + 1))
          echo "PASSED standalone: $tf" >> "$OUT_DIR/${pkg}-standalone.txt"
        else
          echo "FAILED standalone: $tf" >> "$OUT_DIR/${pkg}-standalone.txt"
        fi
      done <<< "$files"
    fi

    if [ "$standalone_total" -gt 0 ] && [ "$standalone_pass" -eq "$standalone_total" ]; then
      record "tests:${pkg}" fail "new failure(s), but ALL ${standalone_total} passed standalone — load-sensitive (TRO-277) or a test-isolation bug; see .factory/${pkg}-standalone.txt"
    elif [ "$standalone_total" -gt 0 ]; then
      record "tests:${pkg}" fail "new failure(s) — ${standalone_pass}/${standalone_total} passed standalone; the rest are REAL. See .factory/${pkg}-standalone.txt"
    else
      record "tests:${pkg}" fail "new failure(s) — see .factory/${pkg}-testdiff.txt"
    fi
  fi
}
run_tests api
run_tests web
# TRO-322 (FG-12): the agent package has its own regression suite and, like
# api/web, its own vitest.config.ts the CI merge gate already runs
# (`pnpm --filter @ship/agent test`, ci.yml/.gitlab-ci.yml's `verify` job,
# treated as a hard fail with no quarantine baseline at all — the whole
# point of "every agent behaviour needs a regression test" is that a
# regression there actually blocks). gate.sh's own local eval had no
# equivalent check before this ticket — `run_tests` already tolerates a
# package absent from quarantine.json's `packages` key (testdiff.mjs:74
# defaults to an empty knownFailing set), so this is zero-tolerance by
# construction, matching CI.
run_tests agent
# TRO-405 (PF-400): the new sdk/ workspace package has its own vitest suite
# (unit tests for the ApiError->kind mapping, plus a live-running-server
# integration test — that suite IS "the MVP gate check", PLUGFORGE.MD's own
# words for PF-400's AC). Same reasoning as TRO-322's `run_tests agent`
# addition above: `run_tests` already tolerates a package absent from
# quarantine.json's `packages` key (testdiff.mjs defaults to an empty
# knownFailing set), so this is zero-tolerance by construction — any failure
# here is a real new failure, not a baseline comparison.
run_tests sdk
# TRO-448 (PF-600): the new integrations/cli workspace package has its own
# vitest suite (fully-mocked unit tests for login/whoami/config/errors, plus
# one live-server integration test that spawns the real api/ package as a
# separate process — see that file's own header). Same "new workspace
# package trap" precedent as TRO-322's `run_tests agent` and TRO-405's
# `run_tests sdk` additions above, called out explicitly in this ticket's own
# brief: a test suite that exists on disk but is never invoked here would
# still satisfy G6's static "regression test present" grep while never
# actually running. Zero-tolerance by construction, same reasoning as sdk/
# and agent/ above — cli/ is brand new, so there is no quarantine baseline to
# compare against.
run_tests cli

# --- G4b: integrations/* runtime-dependency boundary (PLUGFORGE.MD §2.1 / PF-003) ---
# `scripts/check-integration-deps.mjs` (TRO-399/PF-003) already existed and was
# already wired into CI (ci.yml/.gitlab-ci.yml's "Integration package
# dependency boundary" step) — but NOT into this script, so a worktree
# provisioned before a boundary violation landed would report `gate.sh: pass`
# while CI would separately fail it. integrations/cli (this ticket, TRO-448)
# is the FIRST real package under integrations/, so this is also the first
# gate.sh run that can actually exercise this check finding a violation
# rather than passing vacuously on an absent directory. Added here rather
# than left CI-only, per this ticket's own instruction to confirm the lint
# actually covers the new package and fix the gap if it doesn't.
if node scripts/check-integration-deps.mjs > "$OUT_DIR/integration-deps.log" 2>&1; then
  record integration-deps pass "integrations/* packages depend only on @ship/sdk"
else
  record integration-deps fail "see .factory/integration-deps.log"
fi

# --- G5: tests were not weakened -------------------------------------------
# Agents MUST add regression tests, so test files are not frozen outright. What
# is forbidden is making the suite weaker: removing assertions or skipping tests.
WEAKENED=""
DIFF_TESTS="$(git diff "${BASE_REF}"...HEAD --name-only -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null || true)"
if [ -n "$DIFF_TESTS" ]; then
  # `.fixme(` is deliberately NOT forbidden: CLAUDE.md and .coderabbit.yaml both
  # require test.fixme() for unimplemented tests (a bare TODO-only test passes
  # silently — finding TEST-2). Forbidding it here would make the repo's rules
  # unsatisfiable. `.skip`/`.todo` on the other hand disable a test that ran.
  SKIPS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^\+' | grep -cE '\.(skip|todo)\(' || true)"
  DELS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^-' | grep -cE '^\-\s*(it|test|expect)\(' || true)"
  # Counting removals ALONE was wrong, and it misfired three times before this
  # was fixed. Correcting a stale assertion, renaming an `it(` title, and
  # renaming a mock handle all rewrite the line — so a deletion and a correction
  # are identical to the grep. TRO-223 went 131 -> 147 assertions and still
  # failed; TRO-179 failed twice on pure renames and reverted both rather than
  # argue, which is the worst outcome: a false positive that suppresses real work.
  #
  # A net comparison distinguishes them. Removing 12 assertions while adding 16
  # is not a weaker suite; removing 12 while adding 2 is.
  ADDS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^\+' | grep -cE '^\+\s*(it|test|expect)\(' || true)"
  [ "${SKIPS:-0}" -gt 0 ] && WEAKENED="${WEAKENED}${SKIPS} newly skipped test(s); "
  # `.skip`/`.todo` stays an unconditional failure — that is unambiguous
  # weakening and no amount of added assertions offsets a disabled test.
  if [ "${DELS:-0}" -gt "${ADDS:-0}" ]; then
    WEAKENED="${WEAKENED}net loss of test lines (-${DELS} / +${ADDS}); "
  fi
fi
if [ -n "$WEAKENED" ]; then
  record tests:not-weakened fail "${WEAKENED}justify in the PR or revert"
elif [ "${DELS:-0}" -gt 0 ]; then
  record tests:not-weakened pass "-${DELS} / +${ADDS} test line(s) — net gain, reviewer should confirm the removals are corrections"
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
# Anchored on non-identifier boundaries: an unanchored match lets TRO-24
# false-pass on an existing "TRO-244" entry written for a different ticket.
elif grep -qE "(^|[^A-Za-z0-9-])${TICKET}([^A-Za-z0-9-]|\$)" CHANGES.md; then
  # "An entry mentions the ticket" is not enough. A merge of this file can leave
  # the entry present-but-spliced: `merge=union` produced branches with 9 entry
  # headings and 8 run blocks, an odd number of ``` fences, and one entry whose
  # command block belonged to a different ticket. Every such branch passed this
  # grep. So also assert the file is structurally intact.
  if [ -f scripts/factory/merge-changes.mjs ] \
     && ! node scripts/factory/merge-changes.mjs --check CHANGES.md >/dev/null 2>&1; then
    record changes-md fail "entry for ${TICKET} present but CHANGES.md is structurally invalid — run: node scripts/factory/merge-changes.mjs --check CHANGES.md"
  else
    record changes-md pass "entry for ${TICKET} present; structure valid"
  fi
else
  record changes-md fail "no entry mentioning ${TICKET}"
fi

# --- G7b: recurring review-finding classes ----------------------------------
# Added after `review-ledger.mjs report` showed the same two mechanical defect
# classes recurring across four and three tickets respectively, every one filed
# by a reviewer AFTER this gate had already passed. A rule stated in the agent
# brief and ignored three times needs a check, not a louder restatement.
# Judgement-dependent classes (concurrency, docs accuracy) stay in the brief.
if [ -f scripts/factory/review-patterns.mjs ]; then
  if RP_OUT="$(node scripts/factory/review-patterns.mjs "$BASE_REF" 2>&1)"; then
    record review-patterns pass "no new any casts or fixed sleeps"
  else
    echo "$RP_OUT" > "$OUT_DIR/review-patterns.txt"
    RP_N="$(grep -cE '^\s{4}\S+:' "$OUT_DIR/review-patterns.txt")" || RP_N=0
    record review-patterns fail "${RP_N} recurring review-finding pattern(s) — see .factory/review-patterns.txt"
  fi
else
  record review-patterns skip "checker not present"
fi

# --- G7c: git stash used during this ticket's work ---------------------------
# The `git stash` ban (lessons.md, TRO-215: refs/stash is shared across every
# worktree off one common .git, so a sibling worktree can pop/drop an agent's
# stash within minutes) has been violated 3 times (TRO-215, TRO-208/TRO-206,
# TRO-319) despite being stated in every agent brief. Per this factory's own
# recurrence policy (see G7b above), that crossed the "a check, not a louder
# restatement" bar. A source-diff checker can't see a clean push+pop — the
# working tree, `git stash list`, and sometimes even `.git/logs/refs/stash`
# end up byte-identical to before. Detection needs a hook firing on the write
# itself: `.husky/reference-transaction` logs every refs/stash write to
# `<git-common-dir>/factory-stash-activity.log`, a location shared by every
# worktree (deliberately — the log has to survive whichever worktree the
# stash command ran in). Ensure the hook is wired every run: `.husky/_` is
# gitignored and regenerated by `pnpm install`/`prepare`, so a hand-installed
# shim does not survive a fresh install — self-heal it here instead of
# trusting it stayed in place.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)"
if [ -n "$GIT_COMMON_DIR" ] && [ -f "${WT_ROOT}/.husky/reference-transaction" ]; then
  mkdir -p "${WT_ROOT}/.husky/_"
  if [ ! -f "${WT_ROOT}/.husky/_/reference-transaction" ]; then
    printf '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n' > "${WT_ROOT}/.husky/_/reference-transaction"
    chmod +x "${WT_ROOT}/.husky/_/reference-transaction"
  fi
  STASH_LOG="${GIT_COMMON_DIR}/factory-stash-activity.log"
  BASELINE_FILE="${OUT_DIR}/stash-baseline-lines"
  if [ ! -f "$BASELINE_FILE" ]; then
    # First gate.sh run for this worktree — this IS the baseline. .factory/
    # is per-worktree (unlike the shared log), so this genuinely captures
    # "activity since this ticket's work began gating", not since the repo
    # was cloned.
    if [ -f "$STASH_LOG" ]; then wc -l < "$STASH_LOG" | tr -d ' ' > "$BASELINE_FILE"; else echo 0 > "$BASELINE_FILE"; fi
  fi
  BASELINE_LINES="$(cat "$BASELINE_FILE")"
  CURRENT_LINES=0
  [ -f "$STASH_LOG" ] && CURRENT_LINES="$(wc -l < "$STASH_LOG" | tr -d ' ')"
  if [ "$CURRENT_LINES" -gt "$BASELINE_LINES" ]; then
    # The log is SHARED across every worktree (deliberately — see above), so a
    # raw line count blames this worktree for a sibling's stash. Observed
    # 2026-08-08: one agent stashed in Ship-wt-tro_366 and all THREE concurrent
    # worktrees' gates failed stash-guard, turning one violation into a
    # wave-wide block. Each line already records `cwd=<worktree>`, so attribute
    # by it. Compare on the last whitespace-delimited field to avoid a prefix
    # match — `cwd=/…/Ship` is a prefix of `cwd=/…/Ship-wt-tro_366`, so the
    # main checkout would otherwise absorb every worktree's activity.
    NEW_ENTRIES="$(tail -n "+$((BASELINE_LINES + 1))" "$STASH_LOG")"
    MINE="$(printf '%s\n' "$NEW_ENTRIES" | awk -v w="cwd=${WT_ROOT}" 'NF && $NF == w')"
    OTHERS="$(printf '%s\n' "$NEW_ENTRIES" | awk -v w="cwd=${WT_ROOT}" 'NF && $NF != w')"
    MINE_N=0; [ -n "$MINE" ] && MINE_N="$(printf '%s\n' "$MINE" | wc -l | tr -d ' ')"
    OTHERS_N=0; [ -n "$OTHERS" ] && OTHERS_N="$(printf '%s\n' "$OTHERS" | wc -l | tr -d ' ')"
    if [ "$MINE_N" -gt 0 ]; then
      record stash-guard fail "git stash was used during this ticket's work — banned (lessons.md, TRO-215): ${MINE_N} new refs/stash write(s) from this worktree, see ${STASH_LOG}"
    else
      # Surfaced rather than silently passed: a sibling stashing is a real risk
      # to THIS worktree's uncommitted work, it is just not this ticket's fault.
      record stash-guard pass "no refs/stash activity from this worktree (${OTHERS_N} write(s) by sibling worktree(s) — not attributed here; see ${STASH_LOG})"
    fi
  else
    record stash-guard pass "no refs/stash activity since this worktree started gating"
  fi
else
  record stash-guard skip "hook not installed (not a Husky repo, or scripts/factory/hooks source missing)"
fi

# --- G8: scope discipline ---------------------------------------------------
# The 40-file threshold below is also recorded in audit/factory/config.yaml's
# gate.scopeLimitFiles — kept in sync by hand; not parsed from there at
# runtime (see the design spec's non-goals).
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
  #
  # TIMEOUT, and why it is not optional: this call has no internal deadline and
  # blocks on I/O indefinitely when several worktrees invoke the CLI at once.
  # Observed 2026-07-30 on TRO-197: 11+ minutes of wall time against 2.6s of CPU,
  # with sibling worktrees running the same command concurrently. Because G9 can
  # only ever record pass/warn/skip, a hang cannot change the verdict — it just
  # stalls the whole gate until an operator kills the subprocess by hand, which
  # is exactly the failure an unattended factory run cannot absorb.
  CR_TIMEOUT="${CR_TIMEOUT:-360}"
  if command -v timeout >/dev/null 2>&1; then
    CR_RUNNER=(timeout --foreground -k 10 "${CR_TIMEOUT}")
  elif command -v gtimeout >/dev/null 2>&1; then
    CR_RUNNER=(gtimeout --foreground -k 10 "${CR_TIMEOUT}")
  else
    # No timeout binary. Still run it, but say so — a silent unbounded call is
    # how this stalled in the first place.
    CR_RUNNER=()
  fi

  # NEVER write the CLI's output straight over coderabbit.json. The free CLI
  # allowance is shared and frequently exhausted, and on failure the CLI still
  # emits a short JSON error stub. Redirecting into the real path therefore
  # DESTROYS a completed review: observed 2026-07-30 on TRO-226, where a 21-line
  # file holding 10 findings was replaced by a 5-line `rate_limit` object. The
  # agent had already transcribed them, so nothing was lost that time — but the
  # gate cannot rely on that. Capture to a temp file and only promote it when the
  # run actually produced findings, or when there is nothing worth keeping.
  CR_TMP="$OUT_DIR/coderabbit.next.json"
  : > "$CR_TMP"
  if [ ${#CR_RUNNER[@]} -eq 0 ]; then
    coderabbit review --agent --base "${BASE_REF}" > "$CR_TMP" 2>"$OUT_DIR/coderabbit.err"
    CR_RC=$?
    CR_UNBOUNDED=1
  else
    "${CR_RUNNER[@]}" coderabbit review --agent --base "${BASE_REF}" \
      > "$CR_TMP" 2>"$OUT_DIR/coderabbit.err"
    CR_RC=$?
    CR_UNBOUNDED=0
  fi

  # `--agent` emits JSONL; a real review contains `"type":"finding"` rows.
  cr_findings() { grep -c '"type"[[:space:]]*:[[:space:]]*"finding"' "$1" 2>/dev/null || true; }
  CR_NEW_N="$(cr_findings "$CR_TMP")"; CR_NEW_N="${CR_NEW_N:-0}"
  CR_OLD_N=0
  [ -f "$OUT_DIR/coderabbit.json" ] && { CR_OLD_N="$(cr_findings "$OUT_DIR/coderabbit.json")"; CR_OLD_N="${CR_OLD_N:-0}"; }

  if [ "$CR_RC" -eq 0 ] && [ "$CR_NEW_N" -gt 0 ]; then
    mv "$CR_TMP" "$OUT_DIR/coderabbit.json"
    if [ "$CR_UNBOUNDED" = 1 ]; then
      record coderabbit pass "${CR_NEW_N} finding(s) captured (no timeout binary — call was unbounded)"
    else
      record coderabbit pass "${CR_NEW_N} finding(s) captured — see .factory/coderabbit.json (triage required)"
    fi
  elif [ "$CR_OLD_N" -gt 0 ]; then
    # A previous run's findings are still sitting there and are worth more than
    # this run's stub. Keep them, and say plainly that G9's file is stale.
    rm -f "$CR_TMP"
    if [ "$CR_RC" -eq 124 ] || [ "$CR_RC" -eq 137 ]; then
      record coderabbit warn "review timed out after ${CR_TIMEOUT}s — KEPT ${CR_OLD_N} finding(s) from an earlier run; triage those or the PR review"
    else
      record coderabbit warn "review did not complete (rc=${CR_RC}) — KEPT ${CR_OLD_N} finding(s) from an earlier run; triage those or the PR review"
    fi
  else
    # Nothing to preserve, so recording the stub is useful diagnostic material.
    mv "$CR_TMP" "$OUT_DIR/coderabbit.json"
    if [ "$CR_RC" -eq 124 ] || [ "$CR_RC" -eq 137 ]; then
      record coderabbit warn "review timed out after ${CR_TIMEOUT}s — PR-level review is authoritative; triage that instead"
    elif [ "$CR_RC" -eq 0 ]; then
      record coderabbit pass "review completed with no findings"
    else
      record coderabbit warn "review did not complete (rc=${CR_RC}) — see .factory/coderabbit.err"
    fi
  fi
fi

# --- G10: defect-gate (AST-based, identity-baselined, activation-pinned) ---
# Ported from LabelHunter's scripts/factory/defect-gates/ — see
# docs/superpowers/specs/2026-08-14-factory-defect-gate-design.md.
# scopeLimitFiles above (G8) also lives in audit/factory/config.yaml; this
# comment is the same cross-reference LabelHunter's own gate.sh uses rather
# than parsing the YAML at runtime.
if pnpm exec tsx scripts/factory/defect-gates/run.ts > "$OUT_DIR/defect-gate.log" 2>&1; then
  record defect-gate pass "no introduced findings"
else
  DG_N="$(grep -cE '^\s{2}(FAIL|report)' "$OUT_DIR/defect-gate.log" 2>/dev/null)" || DG_N=0
  record defect-gate fail "${DG_N} introduced finding(s) — see .factory/defect-gate.json / defect-gate.log"
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
