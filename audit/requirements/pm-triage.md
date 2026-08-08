# PM scope gate — W4 requirements sweep

**Input:** `gaps.md` (2026-08-08, commit 279fb8e6) — 10 PARTIAL, 0 MISSING of 54 active requirements.
**Constraint on this pass:** scope judgement only. No Linear writes (connector unauthorized this
run anyway), no application source modified. Ticket coverage is unknown, so nothing below is
claimed to be unticketed — only ungated.

The ordering principle is grading impact divided by cost, not severity alone. Several of these are
cheap enough that deferring them costs more in explanation than in engineering.

---

## 1. W4-R10 — type safety: the submission asserts a target it did not meet

**Ships now, in two separable pieces. This is the only finding I would call urgent.**

The engineering gap and the documentation gap are different problems and should not be bundled.

**(a) Correct the claim — applier tier, minutes, mandatory.**
`docs/IMPROVEMENTS.md:24` records this category's verdict as met. Re-running the audit's own
instrument at HEAD gives 1987 tracked violations against a 1535 baseline — up 29%, where the
target is down 25%. A grader who re-runs `count.sh` (the command the repo's own `baseline.md:14-18`
tells them to run) gets 1987 and finds a document claiming success. That converts an unmet target
into an accuracy problem, which is the more expensive failure: it puts every other "met" claim in
that document under suspicion. This is precisely the unmarked-inference pattern `CLAUDE.md`
already warns about, and it is cheap to fix — restate the verdict as not met, keep the real
per-ticket wins, and show the tracked total honestly.

**(b) Close the gap — real ticket, not this pass.**
Worth stating plainly because it changes what the fix should be: the *meaningful* sub-metric moved
the right way. Explicit `any` halved, 102 → 50, and `req.userId!`/`req.workspaceId!` went 236 → 0.
The tracked total rose because `as` assertions went 1385 → 1882, and `baseline.md:62` itself
documents that pattern as over-counting by 15–20% (it catches `import … as …`, comments, and
`as const`, which is a safety *improvement* counted as a violation).

So there are two legitimate routes, and they are not equally honest:
- **Reduce the real number** — target the `as` growth, most of which is in test files.
- **Re-measure with the corrected pattern** the baseline already documents, publishing both old
  and new numbers so the comparison stays auditable.

The second is defensible *only* if the corrected pattern is applied to the baseline too and both
are shown. Re-measuring only the "after" side to get a better delta is exactly what the brief's
"superficial fixes do not count" clause exists to catch. **Do not do that.**

**What would change this ruling:** nothing. (a) is not optional while the document is part of the
submission.

## 2. W4-R33 — "improve all 8 categories"

**Not separate work.** This is a roll-up: 6 of 7 non-Terraform categories clear their targets, and
it is PARTIAL solely because R10 is. It resolves when R10 resolves. Do not open work against it.

## 3. W4-R35 — the suite is red, for one trivial reason

**Ships now — applier tier, highest value-per-minute in this list.**

Two failures, one root cause, in `api/src/db/__tests__/migrationRunner.test.ts:167,184`. The test
compares a Postgres-ordered query (`ORDER BY version`, line 115) against a JavaScript
`[...expected].sort()`. Those two collations genuinely disagree on one pair —
`020_document_associations` vs `020b_sprint_assignee_ids` — verified directly: Postgres returns
`020b` first, JS returns `020_` first. Nothing is wrong with the migrations.

Fix is to compare like with like (sort both sides in JS, or make the query's ordering collation-
explicit). The brief says "Tests must still pass" in as many words, and 10% of the grade reads off
engineering discipline. A red suite caused by a test's own ordering assumption is the cheapest
possible thing to be penalised for.

**Note for whoever takes it:** this is not flaky and not environmental. It will reproduce on any
database whose collation differs from JS string sort, and it is stable on this machine.

## 4. W4-R42 — one-command start stops at the database

**Ships now — small, and I have first-hand evidence it bites.**

`./start.sh` does everything correctly *given a reachable Postgres server*, but does not start the
server process itself: it fails with the message at `api/src/db/ensureDatabase.ts:53-61`. I hit
exactly this today on a clean machine — it is the reason this sweep needed a manual Docker start
before anything could run. That is a manual step beyond "installing dependencies", which is the
requirement's literal bar.

The fix is bounded: when Postgres is unreachable and `docker-compose.local.yml` is present, offer
to start that container and wait for health, keeping the current message as the fallback. Roughly
20 lines in the script, no application code. The README is already honest about the limitation, so
only the script needs to change.

## 5. W4-R38 — dependency pinning

**Ships now, but only via the lockfile-driven method.**

144 of 153 workspace dependencies use caret ranges; the requirement says versions "must be pinned".
Independently recounted: 153 entries, 144 ranged, 9 exact, lockfile committed.

**How matters more than whether.** Pin each dependency to the version pnpm has *already resolved*
in `pnpm-lock.yaml`, so the installed tree is unchanged by construction and the diff cannot alter
behaviour. Then verify with a clean install plus type-check and the suite. Hand-picking versions,
or pinning to latest, turns a bookkeeping change into a dependency upgrade and is how this becomes
a bad week.

**What would change this ruling:** if a clean install after pinning shows any resolution change,
stop and reassess rather than pushing through.

## 6. W4-R27 — annotated plan output

**Ships now, at the scope the requirement actually names.**

The current tracing measured annotation coverage against all Terraform resource blocks (74 root +
66 module) and found roughly 13–15 individually annotated. But the requirement reads "Annotated
terraform plan output explaining every resource and its blast radius" — the unit is the resources
in the **saved plan output**, not every block in the codebase. That is a far smaller, tractable
set, and `terraform/render/plan/plan-annotated.md` already does it correctly at 2/2.

Scope it as: every resource appearing in each saved plan artifact gets its own sentence and blast-
radius note. Pure documentation, no deployment risk, dispatchable to a cheap worker.

## 7. W4-R32 and W4-R41 — deferred, with conditions

Both are real, both are honestly documented in the repo already, and both are too large to land
safely against this deadline.

**R32 (deployable by `terraform apply` alone).** Partly blocked upstream: the agent service has a
provider bug forcing manual Render API calls, and live deploys currently go through manual API
calls because `auto_deploy` is broken (TRO-361, open). The clean-apply path is proven for one
service and documented but unexercised for the primary one.
**Condition to revisit:** TRO-361 resolved, or the provider bug fixed upstream. Until then the
honest move is to keep documenting the constraint rather than claim the property.

**R41 (build/release/run separation).** The CI half is genuinely well built — one image per commit,
after `verify` passes, immutably tagged by full git SHA (`ci.yml:430-513`) — and
`docs/deployment-artifact-lifecycle.md` documents the lifecycle, satisfying that clause outright.
What is missing is promotion: both deploy paths rebuild from source rather than running the CI
artifact. Wiring that up is a deploy-pipeline change, not a patch, and doing it hastily risks the
one thing worth more than this requirement — a working deployment.
**Condition to revisit:** after submission, or if the Render promotion step is unheld.

Their shared virtue is worth protecting: the lifecycle doc states its own gap plainly at lines
15–25 and 219–225. **Do not "fix" either of these by softening the documentation.** An accurate
document describing an incomplete system is worth more than a confident one describing a fiction —
and R10 above is what the alternative costs.

## 8. W4-R51, W4-R54 — owner actions, not factory work

Demo video and social post. Scripts, draft copy, and image assets are complete in
`docs/submission/`; what is missing in both cases is the act itself and a link recorded in the
repo. No engineering involved, and no ticket should be opened — these are Troy's to do, and they
are among the cheapest points available in the whole brief.

---

## Summary of dispositions

| ID | Disposition | Tier |
|---|---|---|
| W4-R10 (a) correct the claim | **Fix now — mandatory** | applier |
| W4-R10 (b) close the gap | Ticket | investigator |
| W4-R33 | No action — resolves with R10 | — |
| W4-R35 | **Fix now** | applier |
| W4-R42 | **Fix now** | applier |
| W4-R38 | Fix now, lockfile-driven only | applier + verification |
| W4-R27 | Fix now, scoped to saved plan output | cheap worker |
| W4-R32 | Defer — blocked on TRO-361 | — |
| W4-R41 | Defer — post-submission | — |
| W4-R51, W4-R54 | Owner action, no ticket | — |

**Not gated by this pass:** the 41 `IMPLEMENTED-UNVERIFIED` requirements. They have file:line
traces and no behavioural verification, which is a statement about this sweep's coverage, not a
defect list. Re-running with the Linear connector authorized and the e2e suite executed would move
most of them without any code changing.
