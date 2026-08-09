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

## I-02
- **Date:** 2026-08-09
- **Governs:** W5-R29, W5-R47, W5-R48, W5-R49
- **Question:** Is a measured cost/invocation/spend figure in FLEETGRAPH.MD "documented" when its source ledger (`agent/.cache/cost-ledger.jsonl`) is gitignored — so a grader running the document's own cited command from a fresh clone gets `No invocations recorded yet.` rather than the published numbers? (Asked as: do disclosed-but-unreproducible figures satisfy "measured, not projected"?)
- **Ruling:** **No — and the answer is to fix it, not to downgrade.** A measured figure must be reproducible from the repository itself; disclosure of the limitation is honest but not sufficient. Commit a tracked ledger snapshot and make the document's cited command reproduce from a clean clone. Ruled by Troy, 2026-08-09.
- **Consequence:** These four requirements score `VERIFIED` **only once the committed snapshot lands and the documented command reproduces the published figures without the gitignored ledger**. Until then they are `PARTIAL`. Implemented as TRO-373. Note this ruling raises the bar for *every* future "measured" claim in this project: the measurement must be re-runnable by a third party from git alone, not merely accurate and disclosed.

## I-03
- **Date:** 2026-08-09
- **Governs:** W5-R36
- **Question:** W5-R36's quote is "If a CI run fails, the deployment must be rolled back automatically." The implemented trigger (`.github/workflows/agent-rollback-check.yml`) fires on sustained deployed-service `/ready` unreadiness on a 15-minute cron; nothing in the repo rolls back *because a CI job failed* (CI failure only prevents merge). Does a readiness-based trigger satisfy the literal wording? (Asked as: does readiness-polling count as "CI failure triggers rollback"?)
- **Ruling:** **No.** It addresses the requirement's stated goal ("do not allow a failing build to remain deployed") via a related but structurally different signal, and that difference is not to be papered over. Ruled by Troy, 2026-08-09.
- **Consequence:** W5-R36 stays `PARTIAL` rather than being credited as met. Two independent gaps keep it there: (1) **semantic** — no mechanism is triggered by a CI failure in the literal sense; (2) **evidentiary** — as of 2026-08-09 13:48 UTC the workflow has never executed its real readiness step. Its last scheduled run (12:56 UTC) predates the secrets being provisioned (13:38 UTC) and logged `configured=false`. A future run that fires with both secrets set closes gap (2) but not gap (1).
