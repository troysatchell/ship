#!/usr/bin/env python3
"""Acceptance gate for the W4 requirements-sweep pipeline.

Checks that:
- Every active (non-retired) requirement in inventory.md has a row in
  matrix.baseline.json. "Active" excludes only IDs whose section explicitly
  states retired status — never inferred from a count.
- Every VERIFIED row carries evidence (a result_excerpt).
- Every MISSING row is written up in gaps.md.
- Every ASSUMED row states its assumption.

Two properties this script is deliberately built around:

1. Runs from anywhere. Paths are derived from this file's own location
   (`pathlib.Path(__file__)`), not the current working directory, matching
   the sibling scripts (merge-matrix.py, write-report.py) and
   pipeline/README.md, which documents running it from anywhere.
2. Checks don't disappear under `python -O`. `assert` is compiled out by
   that flag, so a gate built on bare `assert` can silently stop gating.
   Every check here is an explicit conditional that calls fail() (raises
   SystemExit) instead.
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


def main():
    with open(MATRIX_PATH, encoding="utf-8") as f:
        matrix = json.load(f)
    with open(INVENTORY_PATH, encoding="utf-8") as f:
        inventory_text = f.read()
    with open(GAPS_PATH, encoding="utf-8") as f:
        gaps = f.read()

    active_ids, _retired_ids = active_requirement_ids(inventory_text)
    matrix_ids = {r["id"] for r in matrix["requirements"]}

    missing_active = [rid for rid in active_ids if rid not in matrix_ids]
    if missing_active:
        fail(
            f"{len(missing_active)} active requirement(s) missing from the "
            f"matrix: {', '.join(missing_active)}"
        )

    for r in matrix["requirements"]:
        if r["verdict"] == "VERIFIED":
            if not (r.get("verification") and r["verification"].get("result_excerpt")):
                fail(f"{r['id']}: VERIFIED without evidence")
        if r["verdict"] == "MISSING":
            if r["id"] not in gaps:
                fail(f"{r['id']}: MISSING but absent from gaps.md")
        if r["verdict"] == "ASSUMED":
            if not r.get("assumption"):
                fail(f"{r['id']}: ASSUMED without stated assumption")

    print(f"OK — {len(matrix['requirements'])} rows, verdicts sound")


if __name__ == "__main__":
    main()
