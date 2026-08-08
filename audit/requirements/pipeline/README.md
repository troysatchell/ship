# Requirements-sweep generator

`REPORT.md` and `gaps.md` one directory up are **generated**, not hand-written.
Editing them directly is a mistake: the next regeneration silently discards the
edits. This directory holds everything needed to reproduce them.

This exists because the audit asks the repo for reproducible before/after
measurement (W4-R34), and an audit whose own output cannot be regenerated has
no business asking that of anything else. The first version of these artifacts
was produced by scripts living in a session scratch directory, which meant the
baseline stopped being reproducible the moment that session ended.

## What is here

| File | Role |
|---|---|
| `cluster-{a..f}.json` | Raw trace output, one file per requirement cluster, from the Phase 3 fan-out. The evidence of record. |
| `verification-results.json` | The controller's behavioral verification — commands actually run, their captured output, and the verdict overrides they justify. Overrides the cluster verdicts. |
| `tickets-ship.json` | The Phase 2 ticket population: the 123 issues in Linear project "ShipShape Audit Remediation". Orphan detection runs against this set and nothing wider. |
| `tickets-map-{1,2}.json` | Requirement → ticket mappings, split R1–R27 / R28–R54. Merged into the matrix's per-row `tickets`; anything in the population claimed by neither file becomes an orphan. |
| `merge-matrix.py` | Merges the cluster files plus the verification results into `../matrix.baseline.json`. |
| `write-report.py` | Renders `../REPORT.md` and `../gaps.md` from the matrix plus `../inventory.md`. |
| `acceptance-check.py` | The acceptance gate. Must print `OK — 54 rows, verdicts sound`. No longer verbatim from `docs/superpowers/plans/2026-08-08-requirements-audit-skill.md`'s Step 3 snippet: two rounds of CodeRabbit review on PR #154 found false-pass paths in that original logic (a count-based fallback for missing rows that could match on quantity while the wrong IDs were missing, `assert`s compiled out under `python -O`, a MISSING-row check that matched by raw substring instead of gaps.md's actual headings, and an unrecognized-verdict value that matched no branch and sailed through) — all fixed here, none in the plan doc, which is left as a historical record of what was run. |
| `test_acceptance_check.py` | Regression tests for `acceptance-check.py`'s own pass/fail logic (`python3 audit/requirements/pipeline/test_acceptance_check.py`). Pins the false-pass bugs above so they can't silently return. |

## Regenerating

Run from anywhere; the scripts derive the repo root from their own location.

```bash
python3 audit/requirements/pipeline/merge-matrix.py
python3 audit/requirements/pipeline/write-report.py
python3 audit/requirements/pipeline/acceptance-check.py   # must print OK
```

Verified 2026-08-08: re-running this pipeline against the committed inputs
reproduces all 54 verdicts identically. Two fields intentionally do not
reproduce byte-for-byte — `date` and `dirty_paths` are stamped from the run, not
the inputs.

## Changing a verdict

Change the **source**, never the generated file:

- A trace was wrong, or a citation was bad → edit the relevant `cluster-*.json`.
- A command was run and its result changes a verdict → add it to
  `verification-results.json`, which is where behavioral evidence belongs and
  is the only thing permitted to promote a row to `VERIFIED`.
- Ticket coverage is wrong → edit `tickets-map-{1,2}.json`. If the ticket
  *population* is wrong, fix `tickets.project` in `../../requirements.config.yaml`
  and re-pull; do not widen the population to make orphans look tidier. Scoping
  by project rather than by issue-number range is deliberate — this team's Ship
  numbers are interleaved with two other products, and an unscoped sweep
  reported 88 orphans where the truthful answer is 9.
- A requirement was ambiguous and someone ruled on it → record the ruling in
  `../interpretations.md`, then apply it to the cluster entry (set
  `interpretation`, clear `assumption`, set the verdict the evidence now
  supports). Rulings are permanent; a later sweep applies them silently instead
  of re-asking.

Then re-run all three scripts and confirm the acceptance check still passes.

## Scope note

These scripts are this run's tooling, not part of the portable
`requirements-audit` skill. The skill hardcodes nothing repo-specific; anything
about Ship lives in `../../requirements.config.yaml`. A future sweep is free to
generate its artifacts differently, so long as the output still obeys
`~/.claude/skills/requirements-audit/references/report-format.md`.
