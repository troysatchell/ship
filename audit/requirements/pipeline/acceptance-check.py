#!/usr/bin/env python3
"""Acceptance gate for the W4 requirements-sweep pipeline.

Checks that:
- Every active (non-retired) requirement in inventory.md has a row in
  matrix.baseline.json. "Active" excludes only IDs whose section explicitly
  states retired status — never inferred from a count.
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

Three properties this script is deliberately built around, the last two
because this is the gate deciding whether the requirements matrix silently
dropped a requirement, and a gate with a false-pass path is worse than no
gate — it produces confidence instead of a warning:

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
    matrix_ids = {r["id"] for r in matrix["requirements"]}

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
