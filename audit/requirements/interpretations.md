# Interpretations

Permanent rulings on requirement ambiguities. Before asking any ambiguity
question, search this file — if a ruling governs the requirement, apply it
silently. Never re-ask a settled question.

Format: `~/.claude/skills/requirements-audit/references/inventory-format.md`.

## I-01
- **Date:** 2026-08-08
- **Governs:** W4-R26
- **Question:** "Navigate to terraform/ and run terraform init followed by terraform plan. Save the full plan output" — does `terraform/` mean the local-provider and Render exercise directories the same W4 passage asks you to author (`terraform/render/`, `audit/terraform/drift-demo/`), or the pre-existing AWS infrastructure root (`terraform/*.tf`)? (Asked as: is the exercise-directory reading the intended one?)
- **Ruling:** Yes — it means the exercise directories. The brief introduces `terraform/` in the same breath as the local-provider and Render configs it asks the student to write, so the saved plan it wants is the plan for those.
- **Consequence:** W4-R26 is satisfied by the full plan output captured under `terraform/render/plan/` and `audit/terraform/drift-demo/`. The AWS root's blocked plan attempt (`audit/terraform/raw/root-plan-attempt.txt` — S3 remote backend plus AWS credentials, neither available for this exercise) does **not** count against W4-R26. The requirement's verdict is therefore settled, not contingent: `ASSUMED` is retired in favour of the verdict the evidence supports on its own. Ruled by Troy, 2026-08-08.
