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
| `merge-matrix.py` | Merges the cluster files plus the verification results into `../matrix.baseline.json`. |
| `write-report.py` | Renders `../REPORT.md` and `../gaps.md` from the matrix plus `../inventory.md`. |
| `acceptance-check.py` | The plan's acceptance gate, verbatim. Must print `OK — 54 rows, verdicts sound`. |

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
