#!/usr/bin/env python3
"""Regression tests for acceptance-check.py's own pass/fail logic.

This gate decides whether the requirements matrix silently dropped,
duplicated, or misdescribed a requirement; a false PASS here means a real
defect reaches REPORT.md/gaps.md/pm-triage.md undetected. Three rounds of
CodeRabbit review on PR #154 found false-pass paths in this exact script —
each round fixed the specific holes found, and each round still left more,
because "check harder" doesn't bound the search. This file takes the
inverted approach instead: enumerate every kind of matrix that SHOULD fail
the gate, and assert each one does. `FindFirstViolationTests` has one test
per entry in that enumeration (see its class docstring for the full list);
a future hole shows up here as a missing test case to add, not as a fourth
review round.

Run: python3 audit/requirements/pipeline/test_acceptance_check.py
 or: python3 -m unittest audit/requirements/pipeline/test_acceptance_check -v

Loads acceptance-check.py via importlib rather than a normal import because
its filename has a hyphen, which is not legal in a Python module name.
"""
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parent / "acceptance-check.py"
_spec = importlib.util.spec_from_file_location("acceptance_check", MODULE_PATH)
acceptance_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(acceptance_check)


def make_matrix(*rows):
    return {"requirements": list(rows)}


class ParseGapIdsTests(unittest.TestCase):
    def test_prefix_collision_w4_r1_vs_w4_r10(self):
        # The exact bug CodeRabbit found: `"W4-R1" in gaps_text` is True
        # whenever the text contains a longer ID sharing the prefix, like a
        # "### W4-R10" heading. parse_gap_ids must not make that mistake.
        gaps_text = "# gaps\n\n### W4-R10 — PARTIAL\n- some text\n"
        ids = acceptance_check.parse_gap_ids(gaps_text)
        self.assertIn("W4-R10", ids)
        self.assertNotIn("W4-R1", ids)

    def test_matches_its_own_heading(self):
        gaps_text = "### W4-R1 — MISSING\n- some text\n"
        self.assertIn("W4-R1", acceptance_check.parse_gap_ids(gaps_text))

    def test_prose_mention_does_not_count_as_a_writeup(self):
        gaps_text = "### W4-R10 — PARTIAL\n- see also W4-R1 for related context\n"
        ids = acceptance_check.parse_gap_ids(gaps_text)
        self.assertNotIn("W4-R1", ids)


class HasContentTests(unittest.TestCase):
    def test_whitespace_only_is_not_content(self):
        self.assertFalse(acceptance_check.has_content("   \n\t "))

    def test_none_is_not_content(self):
        self.assertFalse(acceptance_check.has_content(None))

    def test_real_text_is_content(self):
        self.assertTrue(acceptance_check.has_content("actual evidence"))


class FindFirstViolationTests(unittest.TestCase):
    """One test per kind of matrix that SHOULD fail the gate — the inverted
    enumeration, not the failures someone happened to imagine while writing
    the checker. Coverage as of the third CodeRabbit review round:

    1. missing row                    -> test_missing_active_requirement_still_caught
    2. duplicate row                  -> test_duplicate_row_fails
    3. unknown row (ID not active)    -> test_unknown_id_in_matrix_fails
    4. bad verdict                    -> test_unknown_verdict_fails_and_names_the_bad_value
    5. empty evidence (blank excerpt) -> test_whitespace_only_result_excerpt_fails
    6. VERIFIED without verification  -> test_verified_with_no_verification_object_fails
    7. MISSING absent from gaps.md    -> test_missing_row_matched_by_substring_now_fails
    8. ASSUMED without assumption     -> test_whitespace_only_assumption_fails,
                                          test_assumed_with_missing_assumption_key_fails
    9. PARTIAL without suggested_scope -> test_partial_without_suggested_scope_fails
    9b. MISSING without suggested_scope -> test_missing_without_suggested_scope_fails
        (same check as 9, applies to both verdicts per report-format.md;
        tested separately since only PARTIAL was covered before this round)

    Every one of 1-5, 7, 8's whitespace variant, and 9 already existed
    before this class docstring was written; 2, 3, 6, 8's missing-key
    variant, and 9b were added alongside it.
    """

    def test_missing_row_matched_by_substring_now_fails(self):
        # Regression for the reported bug: W4-R1 is MISSING, but gaps.md
        # only has a "### W4-R10" heading (which the old `"W4-R1" in
        # gaps_text` check treated as covering W4-R1 too).
        matrix = make_matrix({"id": "W4-R1", "verdict": "MISSING", "suggested_scope": "do x"})
        gap_ids = acceptance_check.parse_gap_ids("### W4-R10 — PARTIAL\n- x\n")
        violation = acceptance_check.find_first_violation(matrix, ["W4-R1"], gap_ids)
        self.assertIsNotNone(violation)
        self.assertIn("W4-R1", violation)
        self.assertIn("gaps.md", violation)

    def test_missing_row_with_its_own_heading_passes(self):
        matrix = make_matrix({"id": "W4-R1", "verdict": "MISSING", "suggested_scope": "do x"})
        gap_ids = acceptance_check.parse_gap_ids("### W4-R1 — MISSING\n- x\n")
        self.assertIsNone(acceptance_check.find_first_violation(matrix, ["W4-R1"], gap_ids))

    def test_duplicate_row_fails(self):
        # Regression for round 3: every active ID present (just one, here),
        # plus a second row with the same ID. `{r["id"] for r in ...}`
        # collapses this to one set member, so the old check never noticed.
        matrix = make_matrix(
            {"id": "W4-R1", "verdict": "N/A"},
            {"id": "W4-R1", "verdict": "N/A"},
        )
        violation = acceptance_check.find_first_violation(matrix, ["W4-R1"], set())
        self.assertIsNotNone(violation)
        self.assertIn("more than once", violation)
        self.assertIn("W4-R1", violation)

    def test_unknown_id_in_matrix_fails(self):
        # Regression for round 3: every active ID present, plus an extra
        # row whose ID was never in active_ids at all (invented, mistyped,
        # or a retired ID merge-matrix.py should have excluded).
        matrix = make_matrix(
            {"id": "W4-R1", "verdict": "N/A"},
            {"id": "W4-R99", "verdict": "N/A"},
        )
        violation = acceptance_check.find_first_violation(matrix, ["W4-R1"], set())
        self.assertIsNotNone(violation)
        self.assertIn("not active", violation)
        self.assertIn("W4-R99", violation)

    def test_unknown_verdict_fails_and_names_the_bad_value(self):
        matrix = make_matrix({"id": "W4-R2", "verdict": "VERIFED"})  # typo for VERIFIED
        violation = acceptance_check.find_first_violation(matrix, ["W4-R2"], set())
        self.assertIsNotNone(violation)
        self.assertIn("W4-R2", violation)
        self.assertIn("VERIFED", violation)

    def test_every_valid_verdict_passes_the_allowlist_check(self):
        for verdict in acceptance_check.VALID_VERDICTS:
            row = {"id": "W4-R3", "verdict": verdict}
            gap_ids = set()
            if verdict == "ASSUMED":
                row["assumption"] = "stated assumption"
            if verdict == "VERIFIED":
                row["verification"] = {"result_excerpt": "ok"}
            if verdict in ("MISSING", "PARTIAL"):
                row["suggested_scope"] = "do the thing"
            if verdict == "MISSING":
                gap_ids = {"W4-R3"}
            matrix = make_matrix(row)
            violation = acceptance_check.find_first_violation(matrix, ["W4-R3"], gap_ids)
            self.assertIsNone(violation, f"{verdict}: unexpected violation {violation!r}")

    def test_whitespace_only_result_excerpt_fails(self):
        matrix = make_matrix({
            "id": "W4-R4",
            "verdict": "VERIFIED",
            "verification": {"result_excerpt": "   \n  "},
        })
        violation = acceptance_check.find_first_violation(matrix, ["W4-R4"], set())
        self.assertIsNotNone(violation)
        self.assertIn("VERIFIED without evidence", violation)

    def test_verified_with_no_verification_object_fails(self):
        # Distinct from the whitespace-excerpt case above: the "verification"
        # key is absent entirely (r.get("verification") is None), not merely
        # present-but-blank.
        matrix = make_matrix({"id": "W4-R4b", "verdict": "VERIFIED"})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R4b"], set())
        self.assertIsNotNone(violation)
        self.assertIn("VERIFIED without evidence", violation)

    def test_whitespace_only_assumption_fails(self):
        matrix = make_matrix({"id": "W4-R5", "verdict": "ASSUMED", "assumption": "   "})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R5"], set())
        self.assertIsNotNone(violation)
        self.assertIn("ASSUMED without stated assumption", violation)

    def test_assumed_with_missing_assumption_key_fails(self):
        # Distinct from the whitespace-value case above: the "assumption"
        # key is absent entirely, not present-but-blank.
        matrix = make_matrix({"id": "W4-R5b", "verdict": "ASSUMED"})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R5b"], set())
        self.assertIsNotNone(violation)
        self.assertIn("ASSUMED without stated assumption", violation)

    def test_partial_without_suggested_scope_fails(self):
        # report-format.md: "suggested_scope is non-null for every MISSING
        # and PARTIAL row ... an unset value silently drops a required
        # field from the PM handoff." Not part of either CodeRabbit finding
        # but the same false-pass class, found on re-reading the script.
        matrix = make_matrix({"id": "W4-R6", "verdict": "PARTIAL", "suggested_scope": None})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R6"], set())
        self.assertIsNotNone(violation)
        self.assertIn("PARTIAL without suggested_scope", violation)

    def test_missing_without_suggested_scope_fails(self):
        # Same check as the PARTIAL case above, exercised for the other
        # verdict report-format.md's field rule names. gap_ids includes the
        # row's own ID so the gaps.md-heading check passes first and doesn't
        # mask the suggested_scope check being tested here.
        matrix = make_matrix({"id": "W4-R6b", "verdict": "MISSING", "suggested_scope": None})
        gap_ids = {"W4-R6b"}
        violation = acceptance_check.find_first_violation(matrix, ["W4-R6b"], gap_ids)
        self.assertIsNotNone(violation)
        self.assertIn("MISSING without suggested_scope", violation)

    def test_missing_active_requirement_still_caught(self):
        matrix = make_matrix({"id": "W4-R7", "verdict": "N/A"})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R7", "W4-R8"], set())
        self.assertIsNotNone(violation)
        self.assertIn("W4-R8", violation)


if __name__ == "__main__":
    unittest.main()
