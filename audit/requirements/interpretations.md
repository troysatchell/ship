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

## I-04
- **Date:** 2026-08-13
- **Governs:** W6-R25
- **Question:** W6-R25's quote covers both the server-side signer ("Stripe-style header... hex-hmac") and SDK-side verification ("SDK rejects any signature older than 5 minutes by default"), but no `@ship/sdk` package exists yet (PF-403/TRO-413 is Backlog) — and a separate requirement, W6-R33, already covers the SDK-side `verifyWebhook()` specifically. Does the fully-implemented, fully-tested signer suite alone satisfy W6-R25, treating the SDK clause as W6-R33's job — or does R25 stay `PARTIAL` until the SDK verifier ships? (Asked as: does the signer suite alone satisfy R25?)
- **Ruling:** Yes — the signer suite alone satisfies W6-R25. Ruled by Troy, 2026-08-13.
- **Consequence:** W6-R25 scores on its own named acceptance evidence (the signer suite: positive, tamper, expired, missing-v1, boundary — 20/20 green) without waiting on the SDK. The SDK-side verification behavior is W6-R33's requirement, not double-counted here; W6-R25's gap and W6-R33's gap are the same underlying fact (no SDK yet) but are tracked once, on W6-R33, not twice.

## I-05
- **Date:** 2026-08-16
- **Governs:** W6-R36
- **Question:** "Every public API call recorded … Queryable in the developer portal." — is the admin-scoped `GET /api/v1/audit` endpoint + SDK `audit.list()` sufficient with no portal UI page? (Asked as: is API+SDK alone enough?)
- **Ruling:** **No** — a portal UI page is required. Ruled by Troy, 2026-08-16.
- **Consequence:** W6-R36 is `PARTIAL` until an Audit page exists under `/developer/*` reading `public_api_audit` rows; the endpoint/SDK half is credited, the portal half is the gap (PM GO item 5 in REPORT-W6-2026-08-16b.md).

## I-06
- **Date:** 2026-08-16
- **Governs:** W6-R31
- **Question:** "Pluggable ITokenStore (in-memory, file, browser localStorage)" — does a localStorage store implemented in `integrations/browser-demo` (an SDK consumer), not exported by `@ship/sdk`, satisfy the clause? (Asked as: does an implementation anywhere in the repo count?)
- **Ruling:** **No** — the SDK must ship it. Troy did not rule this line directly ("I don't know what this means, you can't tell yourself?") but ruled the batch under "take the project requirements at face value"; applied here by the audit session: the clause sits in the brief's SDK section and lists three store kinds the SDK offers, so the SDK provides all three. Recorded as applied-by-audit, 2026-08-16 — Troy may override.
- **Consequence:** W6-R31 is `PARTIAL` until `@ship/sdk` exports a browser-safe `LocalStorageTokenStore` (~20 min; PM GO item 6). All flows and the other two stores are already VERIFIED.

## I-07
- **Date:** 2026-08-16
- **Governs:** W6-R55
- **Question:** "`pnpm drill ttfe` runs the full loop end-to-end against a containerized Ship instance from a clean working directory" — does Postgres-in-a-container + the real Ship API spawned from the checkout satisfy "containerized Ship instance"? (Asked as: is DB-in-container + real API process fine?)
- **Ruling:** **No** — the Ship API must run from a container image. Ruled by Troy, 2026-08-16.
- **Consequence:** W6-R55 is `PARTIAL` until the drill can start Ship from the built image (opt-in image-backed path, GitHub CI only; PM item 7, 2–3 h). The 30 consecutive green CI runs remain real evidence for W6-R49/R50/R56/R57/R59, which do not carry the "containerized" wording.

## I-08
- **Date:** 2026-08-16
- **Governs:** W6-R52
- **Question:** "Webhook delivery latency (P95, first attempt) < 2 s" — does a per-run 2000 ms ceiling on the drill's `wait_for_delivery` stage satisfy the target, or must an aggregated P95 over ≥20 CI runs be computed? (Asked as: is a per-run ceiling acceptable?)
- **Ruling:** **Face value** — a real P95 over a population of runs must be computed and asserted. Ruled by Troy, 2026-08-16 ("take the project requirements at face value").
- **Consequence:** W6-R52 stays `PARTIAL`; the closing scope is a gh-fed/artifact-fed aggregation over the last ≥20 drill-ttfe runs failing at P95 ≥ 2000 ms, run in the drill-ttfe job — not merely tightening the stage ceiling. Observed values (599–690 ms) make the assertion safe to add.
