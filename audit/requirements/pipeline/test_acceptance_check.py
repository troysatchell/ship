#!/usr/bin/env python3
"""Regression tests for acceptance-check.py's own pass/fail logic.

This gate decides whether the requirements matrix silently dropped a
requirement or shipped a malformed row; a false PASS here means a real
defect reaches REPORT.md/gaps.md/pm-triage.md undetected. Two rounds of
CodeRabbit review on PR #154 found false-pass paths in this exact script,
so its own logic gets tested directly rather than trusted by inspection.

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

    def test_whitespace_only_assumption_fails(self):
        matrix = make_matrix({"id": "W4-R5", "verdict": "ASSUMED", "assumption": "   "})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R5"], set())
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

    def test_missing_active_requirement_still_caught(self):
        matrix = make_matrix({"id": "W4-R7", "verdict": "N/A"})
        violation = acceptance_check.find_first_violation(matrix, ["W4-R7", "W4-R8"], set())
        self.assertIsNotNone(violation)
        self.assertIn("W4-R8", violation)


if __name__ == "__main__":
    unittest.main()
