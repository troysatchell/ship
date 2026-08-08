#!/usr/bin/env python3
"""Acceptance gate for the W4 requirements-sweep pipeline.

Checks that:
- Every active (non-retired) requirement in inventory.md has EXACTLY one row
  in matrix.baseline.json: no duplicate IDs, no unknown/retired IDs, none
  missing. "Active" excludes only IDs whose section explicitly states
  retired status — never inferred from a count.
- Every row's verdict is one of the vocabulary report-format.md defines
  (VERIFIED, IMPLEMENTED-UNVERIFIED, PARTIAL, MISSING, N/A, BLOCKED,
  ASSUMED) — never silently ignored because it doesn't match a known string.
- Every VERIFIED row carries non-blank evidence (a result_excerpt).
- Every MISSING row has its own heading section in gaps.md, not merely a
  substring match against gaps.md's raw text.
- Every ASSUMED row states a non-blank assumption.
- Every MISSING/PARTIAL row states a non-blank suggested_scope, per
  report-format.md's field rule ("suggested_scope is non-null for every
  MISSING and PARTIAL row ... an unset value silently drops a required
  field from the PM handoff").

This file has been through three rounds of CodeRabbit review, each finding a
different way it could still print OK on a broken matrix (see the PR #154
review thread and the commits touching this file). The lesson that stuck:
this gate was written by enumerating the failures someone happened to
imagine, which is exactly the method that produces holes one round at a
time. test_acceptance_check.py now takes the inverted approach instead —
enumerate the matrices that SHOULD fail (missing row, duplicate row,
unknown row, bad verdict, blank evidence, etc.) and assert each one does —
so a hole shows up as a missing test case, not as a fourth review round.

Properties this script is deliberately built around, because this is the
gate deciding whether the requirements matrix silently dropped or duplicated
a requirement, and a gate with a false-pass path is worse than no gate — it
produces confidence instead of a warning:

1. Runs from anywhere. Paths are derived from this file's own location
   (`pathlib.Path(__file__)`), not the current working directory, matching
   the sibling scripts (merge-matrix.py, write-report.py) and
   pipeline/README.md, which documents running it from anywhere.
2. Checks don't disappear under `python -O`. `assert` is compiled out by
   that flag, so a gate built on bare `assert` can silently stop gating.
   Every check here is an explicit conditional that calls fail() (raises
   SystemExit) instead.
3. Membership is checked by parsed identity, never by raw substring search.
   A prior version of the MISSING check did `r["id"] in gaps_text`, which
   `"W4-R1" in gaps_text` satisfies for a `### W4-R10` heading, for prose
   mentioning W4-R1 in passing, or for a code fence pasting it — none of
   which is evidence that W4-R1 has its own gap write-up. See
   test_acceptance_check.py for the exact regression case.
4. Identity is checked by count AND by set difference, never by set
   membership alone. `{r["id"] for r in matrix["requirements"]}` silently
   collapses a duplicate row to one set member, and checking only
   `rid in matrix_ids` for each active ID never notices an extra row whose
   ID isn't active at all — both let a broken matrix reach every later
   check looking clean.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MATRIX_PATH = REPO / "audit/requirements/matrix.baseline.json"
INVENTORY_PATH = REPO / "audit/requirements/inventory.md"
GAPS_PATH = REPO / "audit/requirements/gaps.md"

HEADING_RE = re.compile(r"^## (W4-R\d+)\s*$")
GAP_HEADING_RE = re.compile(r"^### (W4-R\d+)(?:\s|$)", re.MULTILINE)

# report-format.md's "## Verdict tiers" table, verbatim. Anything outside
# this set — a typo like "VERIFED", or a value from a different sweep's
# vocabulary — must fail loudly rather than silently match no branch below.
VALID_VERDICTS = {
    "VERIFIED",
    "IMPLEMENTED-UNVERIFIED",
    "PARTIAL",
    "MISSING",
    "N/A",
    "BLOCKED",
    "ASSUMED",
}


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def active_requirement_ids(inventory_text):
    """Requirement IDs from '## W4-R<n>' headings, excluding IDs whose own
    section contains a retired status line (matches both '- **Status:**
    retired' and a plain 'Status: retired' — anything with both substrings
    'Status:' and 'retired' on one line). Mirrors merge-matrix.py's
    active_ids(): the two must agree on what "active" means, or the matrix
    and this gate silently diverge.

    Returns (active_ids, retired_ids) — retired_ids is returned (not just a
    count) so a missing row can be checked by identity, never by count. A
    count-based fallback can pass while the *wrong* rows are missing: N
    requirements absent and N requirements retired does not mean they are
    the same N.
    """
    ids = []
    retired = set()
    current = None
    for line in inventory_text.splitlines():
        match = HEADING_RE.match(line)
        if match:
            current = match.group(1)
            ids.append(current)
        if current and "Status:" in line and "retired" in line:
            retired.add(current)
    return [rid for rid in ids if rid not in retired], retired


def parse_gap_ids(gaps_text):
    """Requirement IDs that have their own '### W4-R<n>' heading section in
    gaps.md. Anchored to the heading, not a raw substring search: checking
    `rid in gaps_text` is satisfied by any longer ID sharing rid's prefix
    (`"W4-R1" in "... ### W4-R10 ..."` is True) or by rid appearing in
    someone else's prose — neither means rid has its own write-up. `\\d+` is
    greedy, so 'W4-R10' matches its own heading in full and never gets
    truncated to a false match on 'W4-R1'.
    """
    return set(GAP_HEADING_RE.findall(gaps_text))


def has_content(value):
    """True for a string with visible, non-whitespace content. Plain `if
    value:` treats a whitespace-only string ('   ') as truthy — this is
    stricter on purpose, since a whitespace-only result_excerpt/assumption/
    suggested_scope is not actually evidence of anything."""
    return isinstance(value, str) and value.strip() != ""


def find_first_violation(matrix, active_ids, gap_ids):
    """Returns the first acceptance-gate violation message, or None if the
    matrix is sound. Pure function (no file I/O), so tests can exercise it
    directly against constructed fixtures without touching the real audit
    artifacts. Fails on the first violation found, same as the original
    assert-per-line script — this is a gate, not a report; the fix and the
    re-run are cheap enough that batching every violation into one message
    isn't worth the extra code path."""
    id_list = [r["id"] for r in matrix["requirements"]]
    matrix_ids = set(id_list)

    # Duplicates first: `{r["id"] for r in matrix["requirements"]}` silently
    # collapses a repeated ID down to one set member, so a matrix with every
    # active ID present PLUS a duplicate row would otherwise pass every check
    # below unchanged — the duplicate is simply invisible to set-based logic.
    # Comparing list length to set length catches it without needing to know
    # which ID repeated in advance.
    if len(id_list) != len(matrix_ids):
        seen = set()
        duplicates = set()
        for rid in id_list:
            if rid in seen:
                duplicates.add(rid)
            seen.add(rid)
        return (
            f"{len(duplicates)} requirement ID(s) appear more than once in "
            f"the matrix: {', '.join(sorted(duplicates))}"
        )

    # Unknown IDs next: merge-matrix.py's own reqs loop (`for rid in ids:`,
    # where `ids` is the active-only list) never emits a row for anything
    # outside active_ids, so any matrix ID absent from active_ids — invented,
    # mistyped, or a retired ID that should have been excluded — is not a
    # legitimate row. Without this check such a row simply sits in the
    # matrix unexamined: it isn't in active_ids so the missing-row check
    # below never looks at it, and nothing else references it either.
    unknown_ids = matrix_ids - set(active_ids)
    if unknown_ids:
        return (
            f"{len(unknown_ids)} requirement ID(s) in the matrix are not "
            f"active (unknown or should-be-excluded-retired): "
            f"{', '.join(sorted(unknown_ids))}"
        )

    missing_active = [rid for rid in active_ids if rid not in matrix_ids]
    if missing_active:
        return (
            f"{len(missing_active)} active requirement(s) missing from the "
            f"matrix: {', '.join(missing_active)}"
        )

    for r in matrix["requirements"]:
        verdict = r.get("verdict")
        if verdict not in VALID_VERDICTS:
            return f"{r['id']}: unrecognized verdict {verdict!r}"

        if verdict == "VERIFIED":
            verification = r.get("verification")
            if not (verification and has_content(verification.get("result_excerpt"))):
                return f"{r['id']}: VERIFIED without evidence"
        if verdict == "MISSING":
            if r["id"] not in gap_ids:
                return f"{r['id']}: MISSING but absent from gaps.md"
        if verdict == "ASSUMED":
            if not has_content(r.get("assumption")):
                return f"{r['id']}: ASSUMED without stated assumption"
        if verdict in ("MISSING", "PARTIAL"):
            if not has_content(r.get("suggested_scope")):
                return f"{r['id']}: {verdict} without suggested_scope"

    return None


def main():
    with open(MATRIX_PATH, encoding="utf-8") as f:
        matrix = json.load(f)
    with open(INVENTORY_PATH, encoding="utf-8") as f:
        inventory_text = f.read()
    with open(GAPS_PATH, encoding="utf-8") as f:
        gaps_text = f.read()

    active_ids, _retired_ids = active_requirement_ids(inventory_text)
    gap_ids = parse_gap_ids(gaps_text)

    violation = find_first_violation(matrix, active_ids, gap_ids)
    if violation:
        fail(violation)

    print(f"OK — {len(matrix['requirements'])} rows, verdicts sound")


if __name__ == "__main__":
    main()
