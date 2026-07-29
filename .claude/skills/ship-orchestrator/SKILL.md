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

Default is **everything at once** — each ticket has its own worktree, database, and ports. Serialize
only for these four reasons:

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

Reserve the **whole batch** in Linear (all tickets → In Progress) before any agent starts. The lock
only works if it covers every ticket the branch will close; otherwise a second worker picks up a
ticket already being fixed inside someone else's diff.

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
# Linear: issues in "In Progress" for project ShipShape Audit Remediation
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

- **Never dispatch outside project `ShipShape Audit Remediation`** in team `Troysatchell`. That
  workspace also holds an iOS app, a healthcare copilot, and a separate security audit at
  `TRO-250`–`TRO-275`. They are not factory work.
- **CodeRabbit-derived tickets carry the `coderabbit` label** and must never be counted toward the
  68-finding audit baseline — that number is submitted and fixed.
- A batched branch's PR **lists every ticket it closes**, and all of them move together: In Progress
  → In Review → Done. A batch where one ticket silently stays open is worse than no batch.
- Escalation blocks **the ticket, not the run**. Mark it, move to the next eligible ticket, hold the
  question in a batch, and keep going.

## 6. What to report

A running board, not a narrative: done (with PR links), in flight, blocked with the reason, new
tickets filed from triage, and anything skipped. If you lowered a bar, dropped a ticket, or skipped
a category, say so — silent truncation reads as success when it wasn't.
