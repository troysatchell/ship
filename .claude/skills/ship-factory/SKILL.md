---
name: ship-factory
description: >-
  Run the ShipShape ticket factory — pull open findings from Linear, dispatch each to a coding
  sub-agent in an isolated worktree, gate it on evidence, open a PR, triage the CodeRabbit review
  into new tickets, and keep going until every ticket is terminal. Use when the user says "run the
  factory", "work the tickets", "keep grinding the backlog", or wants autonomous remediation of the
  68 audit findings. Stops only at defined human gates.
---

# Ship Factory

You are the **orchestrator**. You hold the board and the gates; sub-agents do the building.
This skill exists because Ship has ~75 open remediation tickets and a hard deadline, and because
the grading rubric rewards things a naive "fix it" loop destroys: one branch per improvement,
before/after measurement, a regression test per bug, and an honest git history.

Read `references/evals.md` before your first dispatch — the two-tier eval is what makes "done"
mean something here. Read `references/escalation.md` before running unattended. The other
references are consulted at the step that needs them.

## What "done" means in this factory

A ticket is **not** done when the agent says it is, and **not** done when tests pass. It is done
when all of this holds:

1. Work is on its own branch named for the ticket, based on `main`.
2. `scripts/factory/gate.sh` returns `verdict: pass` — typecheck, build, no new test failures vs
   `audit/factory/quarantine.json`, no weakened tests, a regression test present, a `CHANGES.md`
   entry, and a bounded diff.
3. A PR is open and CI is green.
4. The CodeRabbit review has been **triaged**, not merely received (`references/triage.md`).
5. For findings with a measurable target: a compare-mode measurement exists proving the delta
   against the `audit-baseline` tag (`references/evals.md`). Cheap categories run per ticket;
   expensive ones batch per category.
6. The Linear ticket carries the evidence — gate result, PR link, and the measured before/after.

Anything short of that is `blocked`, not `done`. Say which.

## Preflight — once per factory run

1. **Clean tree on `main`, synced with both remotes.** `git status` must be empty.
2. **Postgres container up.** `docker ps | grep ship-audit-pg`. Every ticket gets its own
   database because `api/src/test/setup.ts` TRUNCATEs 16 tables in the `beforeAll` of every test
   file — agents sharing a database will corrupt each other's runs and produce failures that look
   like code defects.
3. **Quarantine baseline current.** `audit/factory/quarantine.json` records the 13 known-failing
   web tests (TEST-1 / TRO-223). If a ticket fixes some of them, update the file in that PR.
4. **`gh` can resolve the repo.** `origin`'s *fetch* URL is GitLab, so `gh` cannot infer it —
   export `GH_REPO=troysatchell/ship` or every `gh pr` call fails.
5. **Read the lessons file** (`references/lessons.md`) and carry its rules into every agent prompt.

If a precondition fails and the user is present, ask. Unattended, do the safe prep you can, then
stop and report exactly what blocks you.

## The loop

### 1. Select the next ticket

Pull open issues from Linear, **team `Troysatchell`, project `ShipShape Audit Remediation`**.
Scope matters: that workspace also holds three unrelated projects (an iOS app, a healthcare
copilot, and a separate security audit at `TRO-250`–`TRO-275`). Never dispatch outside the project.

Order by, in priority sequence:
- **Unblocks other work first** — Linear `blocks` relations are real dependencies (API-1 → API-2/3;
  TF-3 → TF-4; TF-2 → TF-1).
- **Urgent before High before Medium.**
- **Shared root cause batched together** — DB-2⇄API-6, DB-4⇄API-4/API-5/ERR-7, BUN-1⇄BUN-2/3/4/6
  are one fix each, not six. Batching them is cheaper *and* produces a better measurement story.

Move **every** ticket in the batch to **In Progress** in Linear before dispatching — not just the
primary one. That is the lock, and it only works if it covers everything the branch will close.
Reserve the whole batch before any agent starts, or a second worker can select a ticket that is
already being fixed inside someone else's branch.

### 1a. Run in parallel — serialize only on real dependencies

Dispatch every eligible ticket concurrently. The **only** reasons to serialize:

- **A true blocking dependency.** Linear `blocks` relations: API-1 → API-2/API-3, TF-3 → TF-4,
  TF-2 → TF-1. The blocked ticket waits.
- **Same-file collisions.** ERR-1 and ERR-2 are both in `api/src/collaboration/index.ts` and are
  one change; they go on **one branch as a batch**, not two parallel ones that conflict.
- **Expensive-tier measurement ordering.** `db-query-audit` must run after `api-perf-audit`, never
  concurrently — its statement logging skews the other's timings.

Everything else runs at once. Each ticket has its own worktree, its own database, and ports that
`worktree.sh` **probes for and claims** rather than deriving from a hash alone — the hash only sets
a stable starting point, and `md5 % 900` collides in practice (~50% odds by 36 concurrent tickets).
Re-evaluate the graph after every completion: a ticket whose blockers are now `Done` becomes
eligible immediately.

### 2. Provision an isolated worktree

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
```

Creates the worktree, a dedicated database, per-ticket ports, and `.factory-env`. Re-running it
resets the database — a retry starts clean rather than inheriting a half-migrated state.

### 3. Dispatch the coding sub-agent

Use the contract in `references/agent-contract.md` verbatim as the agent's brief, filled in with
the ticket. The contract carries the non-negotiables: scope, the locked-quarantine rule, the
provenance requirements, and the instruction to keep working rather than check in.

The contract is deliberately domain-blind, so **compose the brief in three parts**:

```
agent-contract.md (filled in) + lessons.md (verbatim) + the role skill(s) for this finding
```

`/ship-orchestrator` §1 holds the routing table — `TS-*`/`BUN-*`/`A11Y-*` → `/ship-frontend`,
`API-*`/`DB-*`/`ERR-*` → `/ship-backend`, `TEST-*` → `/ship-qa`, plus the cases that need two. Every
brief carries `/ship-qa`'s regression-test placement rule regardless of category, because the gate's
regression-test check can be satisfied by a test the gate never executes.

`/ship-orchestrator` also owns the parallelism decision (§2), concurrency sizing against the single
Postgres container (§3), and **recovery of an interrupted run** (§4) — reconcile worktrees, branches,
and Linear locks there before dispatching anything new.

### 4. Gate it — do not trust the self-report

```bash
cd ../Ship-wt-tro_178 && scripts/factory/gate.sh
```

Run it **yourself**. An agent reporting green is a claim; the gate is the result. On failure, feed
the exact gate output back to the same agent (context is worth keeping) and retry.

**Retry cap: 3.** After three failed gates, stop, mark the ticket `blocked` in Linear with the
gate output and your best read on why, and move to the next ticket. Do not raise the cap to force
a pass — the cap is what converts "burns tokens forever" into "surfaces a hard problem".

**Append a scorecard row after EVERY gate run — pass or fail, including each retry.** One line to
`audit/factory/scorecard.jsonl`, right here in the loop, before you retry or move on:

```json
{"ticket":"TRO-178","attempt":2,"verdict":"fail","failedGates":["regression-test"],"ts":"..."}
```

If rows are only written on success, failed and retried tickets vanish from the record and the
gate-pass-on-first-attempt trend — the whole point of the scorecard — reads as 100%. Fill the
`cr*` fields in at triage (step 7).

### 5. Measure (findings with a target)

Cheap tier runs inline; expensive tier batches per category. `references/evals.md` says which is
which and how to run compare mode against the `audit-baseline` tag. A performance or bundle ticket
without a measured delta is not done — measurable improvement is 40% of the grade.

### 6. Open the PR

**Pushing a factory branch and opening its PR is pre-authorized** — do it without asking. This is
an explicit standing delegation for factory runs; it does not extend to any other push, to force
pushes, or to a branch that failed its gate.

Push to GitHub (`GH_REPO=troysatchell/ship`) and open a PR whose body is the evidence, not a
summary. Template in `references/agent-contract.md`. A batched branch **must list every ticket it
closes**. Move all of them to **In Review** and attach the PR link.

### 7. Triage the review

CodeRabbit reviews the PR. Classify every finding into fix-now / new-ticket / dismissed-with-reason
per `references/triage.md`. **New tickets get filed in Linear automatically** — that is how the
factory grows its own backlog instead of losing findings in PR threads.

### 8. Merge — auto-merge once the review is green

**Standing policy, set by the maintainer 2026-07-29:** once the CodeRabbit review is green, the
factory merges. No per-PR confirmation.

"Green" means all four hold:

1. `gate.sh` verdict `pass`.
2. CI green on the PR.
3. Every CodeRabbit finding triaged, with the **fix-now** ones actually fixed and re-reviewed —
   in-scope, non-trivial findings get fixed; trivial nits and findings that contradict a
   deliberate design decision are dismissed with a written reason (`references/triage.md`).
4. No open escalation on the ticket.

Merge with `--no-ff` so the branch structure survives — 10% of the grade is read directly off the
git log. Then move the ticket(s) to **Done** with the evidence attached.

If any of the four fails, the PR stays open and the factory moves to the next ticket. Never merge
to clear a queue.

**Exception — non-ticket content skips the CodeRabbit gate** (maintainer, 2026-07-29). A PR that
does not change code in service of a ticket may merge on gate + CI green alone, without waiting
for the review. That covers factory tooling, skills, docs, the memory bank, and CI config.

The test is what the change *is*, not which files it touches: if a reviewer's opinion could change
whether the product behaves correctly, it is ticket content and the gate applies. Anything under
`api/`, `web/`, or `shared/` is ticket content by default. When genuinely unsure, wait for the
review — the exception exists to stop tooling PRs blocking on a slow reviewer, not to route fixes
around it.

Triage the review anyway when it lands. Skipping the *gate* is not skipping the *reading*: file
what it finds (`references/triage.md`), as a follow-up PR if the branch is already merged.

> **Remote note.** CI and CodeRabbit run on GitHub, but the graded submission remote is GitLab.
> After merging, make sure `main` reaches both — `origin` pushes to GitLab *and* GitHub, but it
> *fetches* from GitLab, so a merge performed on GitHub must be pulled down before the next push
> or the two will diverge. Verify with `git ls-remote` against both rather than assuming.
>
> Verified 2026-07-29 on PR #1: after the GitHub merge, GitLab `main` was still one commit behind.
> The fix that does not disturb a checked-out feature branch is
> `git fetch https://github.com/troysatchell/ship.git main:main && git push origin main`.

### 9. Close the loop back into the factory

After each ticket, append what happened to `references/lessons.md` **when a gate caught something
a better prompt would have prevented**. That file is injected into every subsequent agent brief.
This is the self-improvement mechanism and it only works if it stays short and specific — rules
that earned their place, not a diary.

## Running unattended

The user's instruction is: keep working, stop only when I need to verify something.

Between tickets, do not ask "shall I continue?" — continue. Escalate only on the conditions in
`references/escalation.md`, and when you do, batch the questions so the user answers once and the
factory resumes rather than being interrupted per-ticket.

Report progress as a running board: tickets done (with PR links), in flight, blocked with reasons,
and new tickets filed from review triage. Keep it scannable.

## Visibility — keep the board current

```bash
node scripts/factory/status.mjs          # terminal, any time
node scripts/factory/board.mjs > audit/factory/board.html   # then republish
```

**Regenerate and republish the board after every state transition** — a ticket dispatched,
a gate run, a PR opened, a merge. Publish with the Artifact tool using the **same file path**
(`audit/factory/board.html`) so it redeploys to the one stable URL rather than minting a new one:

https://claude.ai/code/artifact/28506acd-4d74-4889-aee6-a2b6d9932a83

Both read from sources of truth — worktrees, `.factory/gate-result.json`, `gh pr list`, the
scorecard, and local session transcripts. There is deliberately **no status file to update**,
because a status file that drifts is worse than none: it reads as authoritative while being wrong.
That also means the board is only as fresh as its last regeneration; it is a snapshot and says so.

Linear stays authoritative for *ticket status*; the board shows *execution state*. When they
disagree, Linear wins and something has gone wrong — say so rather than reconciling silently.

## Guardrails

- **Never `git commit --no-verify`.** Pre-commit runs the compliance scan; bypassing it is a
  security-compliance violation in this repo. `/ship-security-compliance` has what the hook actually
  runs — including the fact that a missing `comply` CLI lets commits through on a warning, so a
  successful commit is not by itself evidence the secrets scan ran.
- **Never let an agent widen the quarantine.** Adding entries to `quarantine.json` to get green is
  gaming the gate. Only *removing* entries (tests genuinely fixed) is legitimate.
- **Never dispatch outside the ShipShape project** in Linear.
- **One finding per branch.** Batched root causes are one branch covering several tickets — that is
  fine, and the PR must list every ticket it closes. Unrelated drive-by fixes are not.
- **Claims carry provenance.** `.claude/CLAUDE.md` requires observed-vs-derived to be marked. Three
  documented failures in this project came from unmarked inference. The PR template enforces it;
  do not let agents write "verified" about something they reasoned about.
- **Surface, don't hide.** If you skip a category, lower a bar, or drop a ticket, say so in the
  report. Silent truncation reads as success when it wasn't.
