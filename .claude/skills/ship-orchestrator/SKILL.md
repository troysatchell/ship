---
name: ship-orchestrator
description: >-
  Dispatch layer for the ShipShape ticket factory — routes a ticket to the right role brief,
  decides what may run in parallel versus what must serialize, sizes concurrency against real
  machine limits, and recovers a factory run after a crash (orphaned worktrees, stale In Progress
  locks, abandoned branches). Use when assembling an agent brief, when deciding how many tickets to
  run at once, or when picking up a factory run that was interrupted. `ship-factory` owns the run
  loop; this owns dispatch and recovery.
---

# Ship orchestrator

`/ship-factory` is the run loop — select, dispatch, gate, PR, triage, merge. This skill is the part
of step 3 that the loop leaves implicit: **what exactly goes into the agent's brief, what may run
beside it, and how to recover when a run dies mid-flight.**

## 1. Route the ticket to a role brief

The agent contract (`ship-factory/references/agent-contract.md`) is domain-blind by design. Compose
the brief as:

```
agent-contract.md  (filled in)
+ lessons.md       (verbatim, under "Standing rules")
+ role skill(s)    (this table)
```

| Finding prefix | Category | Role brief to inject |
|---|---|---|
| `TS-*` | Type safety | `/ship-frontend` if the weak files are in `web/`, `/ship-backend` if in `api/`. Check the file list — TS findings span both. |
| `BUN-*` | Bundle size | `/ship-frontend` |
| `A11Y-*` | Accessibility | `/ship-frontend` — and check escalation gates 4 and 5 **before** dispatching |
| `API-*` | API response time | `/ship-backend` |
| `DB-*` | DB query efficiency | `/ship-backend` |
| `ERR-*` | Runtime errors | `/ship-backend` for collaboration/socket/API paths; `/ship-frontend` for UI error states; both if the fix crosses the boundary |
| `TEST-*` | Test coverage | `/ship-qa` — plus the role skill for the package under test |
| `TF-*` | Terraform | none yet; escalation gate 2 applies (irreversible infra) |

**Every** ticket also gets `/ship-qa`'s regression-test placement rule, because the gate's
regression-test check can be satisfied by a test the gate never runs. That single rule is worth
carrying into every brief even when the ticket is not a TEST-* finding.

Multi-role tickets get both briefs. Two briefs is fine; a vague brief is not.

## 2. Decide what runs in parallel

**The unit is the bundle where one exists** (a `[PR-x] EPIC` parent declaring "one branch, one PR,
one CodeRabbit review" — see `/ship-factory` § *The unit of work is the bundle*). Parallelism runs
**between** bundles; sub-issues inside one run in the epic's stated order on a single branch, except
where they touch disjoint files and the epic does not order them.

Default is otherwise **everything at once** — each bundle or unbundled ticket has its own worktree,
database, and ports. Serialize only for these four reasons:

1. **A real blocking dependency.** Linear `blocks` relations: API-1 → API-2/API-3, TF-3 → TF-4,
   TF-2 → TF-1.
2. **Same-file collisions.** Two branches editing one file produce a merge conflict that costs more
   than the parallelism saved. Known collisions:
   - ERR-1 ⇄ ERR-2 — both `api/src/collaboration/index.ts`. **One branch, batched.**
3. **Shared root cause** — these are one fix, so batching them is cheaper *and* produces a better
   measurement story:
   - DB-2 ⇄ API-6
   - DB-4 ⇄ API-4 / API-5 / ERR-7
   - BUN-1 ⇄ BUN-2 / BUN-3 / BUN-4 / BUN-6
4. **Measurement ordering.** `/db-query-audit` runs **after** `/api-perf-audit`, never
   concurrently — the statement logging it enables skews the other's timings.

Reserve the **whole batch — or the whole bundle** — in Linear (all tickets → In Progress) before any
agent starts. The lock only works if it covers every ticket the branch will close; otherwise a
second worker picks up a ticket already being fixed inside someone else's diff.

## 2a. Dispatch ticket agents — and the orchestrator itself — on Sonnet

Pass `model: "sonnet"` on every `Agent` call that dispatches ticket work, a triage round, or a
measurement run. Set by the maintainer 2026-07-29.

The reasoning matters more than the setting: **the brief carries the knowledge, not the model.** By the
time an agent is dispatched it has the role skill, `lessons.md`'s standing rules, the finding's
measured evidence, the escalation boundaries, and the gate to check itself against. It is executing a
well-specified task, not deriving one. Across a ~75-ticket backlog, paying top-tier rates per ticket is
waste.

**The orchestrator defaults to Sonnet too — revised 2026-07-30, after `docs/submission/AI-COST-ANALYSIS.md`
showed the same shape of waste one layer up.** The original reasoning ("the orchestrator holds the
board and makes the judgement-heavy calls, so it stays on its own model") assumed those calls were
open-ended. They mostly aren't: ticket selection, batching, the merge checklist (gate pass + CI green
+ review triaged + no escalation), and crash recovery are all specified as literal tables and
checklists in this skill and `ship-factory`'s — the same "well-specified task, not deriving one"
argument that already justified Sonnet for ticket agents applies to running that loop. Measured cost
was concentrated exactly where this predicts: orchestration (Opus/Fable-tier) was ~75% of the
sprint's spend despite ticket agents (Sonnet) carrying more raw cache-read volume — the expense was
the tier, not the work.

**Raise the model for a specific decision, not the default, when the call is genuinely open-ended:**

- Classifying a CodeRabbit finding whose fix-now / new-ticket / dismissed call is contested or
  precedent-setting (not the routine cases `references/triage.md` already covers).
- Judging a review-ledger recurrence — is this the 2nd occurrence (add a `lessons.md` rule) or the 3rd+
  (add a mechanical `gate.sh` check)? — where the pattern across tickets isn't obvious from the ledger
  report alone.
- Recognizing whether a situation actually crosses an `references/escalation.md` gate, when it's not a
  clean match to the gate's stated trigger.
- Inventing a measurement methodology rather than applying one — the TRO-197 bundle-metric case below.

Say why when you do. Do not quietly raise the default back up for the whole run.

Two caveats:

- `subagent_type: "fork"` always inherits the parent model; `model` is ignored there. Use a normal
  agent type for ticket work.
- If a specific ticket genuinely needs more reasoning — a contested diagnosis, or one where the right
  *metric* has to be invented rather than measured (TRO-197's bundle work is the example: the audit's
  own metric flattered the fix, so a better one had to be designed) — raise the model **for that
  ticket** and say why. Do not quietly raise the default back up.

## 3. Size the concurrency to the machine

Parallelism is bounded by things that are not ticket-shaped:

- **One Postgres container.** Every worktree database lives on `ship-audit-pg` at `:5433`. Each api
  test run TRUNCATEs 16 tables in *its own* database — safe across worktrees, but they share the
  container's connection limit and CPU. Beyond roughly a handful of simultaneous gate runs, test
  timings stop being comparable to anything.
- **Do not run e2e while several gates are running.** Each Playwright worker spins up its own
  Postgres container + API + preview server. `playwright.config.ts` sizes workers from *free*
  memory at startup, so it will happily over-provision if the worktrees allocate afterwards. The
  file records a 90GB memory explosion and a system crash from over-subscription.
- **`pnpm build` and `pnpm type-check` are CPU-bound** and run in every gate. Concurrent gates are
  the real ceiling, not concurrent agents.

Practical shape: dispatch agents broadly, but stagger the **gate** runs. An agent thinking is cheap;
five simultaneous full gates are not.

## 4. Recover an interrupted run

The run loop has no crash-recovery step. When picking up after an interruption, reconcile three
sources of truth before dispatching anything new — they drift independently.

```bash
git worktree list                      # what exists on disk
git branch -a --list 'fix/*' 'feat/*'  # what has commits
# Linear: issues in "In Progress" for THIS RUN'S project (look it up; do not
# hardcode — the active project changes between sprints)
```

Then, per worktree:

| Disk | Branch | Linear | Read | Action |
|---|---|---|---|---|
| exists | has commits | In Progress | agent died mid-ticket | run `gate.sh` yourself; the diff is the real state. Gate-green → PR. Red → re-dispatch with the gate output as context. |
| exists | no commits | In Progress | agent died before committing | stale lock. `scripts/factory/worktree.sh <ticket> <branch>` re-provisions and **resets the database**; re-dispatch clean. |
| gone | has commits | In Progress | worktree pruned, work survives | recreate the worktree on the existing branch; do not start over. |
| exists | merged | Done | leftover | `git worktree remove`, drop the database. |
| — | — | In Progress, nothing on disk | never started, or lock never released | verify no PR exists, then move back to the backlog. |

**Never re-dispatch a ticket without checking for existing commits first.** A second agent starting
from scratch on a branch that already has a partial fix produces a diff neither agent can explain.

Two mechanical notes:

- `git worktree prune` removes bookkeeping for worktrees whose directory is gone. It does **not**
  delete the branch or the database. Databases are cleaned up separately.
- **In a linked worktree, `.git` is a FILE, not a directory.** Anything writing `.git/info/exclude`
  fails with "Not a directory", and under `set -e` it silently aborts the rest of a provisioning
  script — this already cost one worktree whose database was created but never migrated. Resolve
  via `git rev-parse --git-common-dir`.

## 5. Board hygiene

- **Never dispatch outside the run's active project** in team `Troysatchell`. As of 2026-08-08 that
  is `FleetGraph — Week 5 Project Intelligence Agent`; `ShipShape Audit Remediation` is Week 4 and
  closed at 121/123. **Confirm the active project at the start of every run rather than trusting
  this line** — it is the sentence in this file most likely to be stale.

  The team holds six projects, including an iOS app, a healthcare copilot, and another product's
  security audit at `TRO-250`–`TRO-275`. Their issue numbers **interleave** with Ship's, so a
  number range will not tell you which project a ticket belongs to. Filter by project via the API.
  Measured 2026-08-08: scoping by number range instead reported 88 orphan tickets where the true
  answer was 9.
- **CodeRabbit-derived tickets carry the `coderabbit` label.** They were never counted toward Week
  4's 68-finding audit baseline, which is submitted and fixed. Apply the same discipline to any
  future baseline: a finding discovered by review is not part of the baseline it was found against.
- A batched branch's PR **lists every ticket it closes**, and all of them move together: In Progress
  → In Review → Done. A batch where one ticket silently stays open is worse than no batch.
- Escalation blocks **the ticket, not the run**. Mark it, move to the next eligible ticket, hold the
  question in a batch, and keep going.

## 6. What to report

A running board, not a narrative: done (with PR links), in flight, blocked with the reason, new
tickets filed from triage, and anything skipped. If you lowered a bar, dropped a ticket, or skipped
a category, say so — silent truncation reads as success when it wasn't.
