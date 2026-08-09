---
name: ship-factory
description: >-
  Run the ShipShape ticket factory — pull open work from Linear, dispatch each PR bundle (or
  unbundled ticket) to coding sub-agents in an isolated worktree, gate it on evidence, open one PR
  per bundle, triage the CodeRabbit review into new tickets, and keep going until every ticket is
  terminal. Use when the user says "run the factory", "work the tickets", "keep grinding the
  backlog", or wants autonomous delivery of the current project's ticket queue. Stops only at defined human
  gates.
---

# Ship Factory

You are the **orchestrator**. You hold the board and the gates; sub-agents do the building.
**Current work (2026-08-08): Week 5, `FleetGraph — Week 5 Project Intelligence Agent`.** That is the
default project for selection, briefs, and measurement. Week 4's `ShipShape Audit Remediation` is
**past** — 121 of its 123 tickets are Done and it is worked only to close a specific residual
(`TRO-354`, or a W4 requirement gap named by `audit/requirements/`). Do not pull W4 tickets as
general queue-filler; a wave spent on last week's grade is a wave not spent on this week's.
Re-read this paragraph at the start of every run: it is the one thing in this file that goes stale.

This skill exists because Ship carries a large remediation backlog against a hard deadline, and because
the grading rubric rewards things a naive "fix it" loop destroys: one branch per improvement,
before/after measurement, a regression test per bug, and an honest git history.

Read `references/evals.md` before your first dispatch — the two-tier eval is what makes "done"
mean something here. Read `references/model-tiering.md` before dispatching anything — it decides
which model does which work, and dispatching every task at investigator tier is the largest
avoidable cost in this factory. Read `references/escalation.md` before running unattended. The
other references are consulted at the step that needs them.

## Three phases

The factory below (§ *The loop*) is the **Build** phase. It assumes a ticket already exists and
already says what to do. That assumption holds for audit remediation, where
`audit/AUDIT_REPORT.md` did the analysis. It does **not** hold for new capability, which arrives
as an intent rather than a finding — and running Build directly on an intent produces tickets that
contradict each other, because nobody decided the shape first.

```
PLAN                              BUILD                    REVIEW
────                              ─────                    ──────
/ship-pm writes spec (/ship-spec) orchestrator selects     gate passes
    │ scope gate                  worktree.sh isolates       ├─▶ blind verifier  (right thing?)
    ▼                             applier or investigator    └─▶ /ship-qa-review (real proof?)
/ship-surveyor  — what is         gate.sh verifies                   │ both pass
    │             actually there      │                              ▼
    ▼                                 │                          PR opens
/ship-architect designs               │                              ▼
    │                                 │                       CodeRabbit (correct code?)
    ▼                                 │                              ▼
/ship-test-designer                   │                       /ship-pm triages
    │  the tests, before any code     │                              ▼
    ▼                                 │                     appliers fix / tickets filed
  tiered tickets ────────────────────▶│                              │
       ▲                              └──────────────────────────────┘
       └──── rewrite (max 2) ◀──── failure
```

**Plan** runs once per body of work, not per ticket. It ends when the architect hands over a tiered
ticket set with dependencies marked. Skip it only when the tickets already exist and were written
from evidence — an audit finding qualifies, a wish does not.

**Review** now has two reviewers with different jobs. CodeRabbit asks whether the code is correct.
`/ship-qa-review` asks whether the proof is real — whether the regression test actually runs, whether
red was ever seen, whether the bar moved instead of the code. Both feed `/ship-pm`, which makes the
call on every finding rather than applying a rule table.

## The loop closes itself — read `references/self-closing-loop.md`

Findings feed back in without a human. The short version:

- **Error-class findings get no ticket.** A missing `await`, a new `as any`, a missing index the
  reviewer already located — dispatch an applier, let `gate.sh` prove it, close it, record it in
  the ledger. A ticket for a one-line mechanical fix costs more than the fix.
- **Issue-class findings get a ticket, an investigator, and a verifier.** Anything needing
  diagnosis, a design decision, or a change to product behaviour.
- **The verifier is blind on purpose.** After the gate passes, a separate agent checks the work
  against the *original* finding — and it receives only the finding verbatim, the diff, and the
  gate JSON. **Not the investigator's report.** That narrative is a framing written by whoever
  decided what to build; a verifier that reads it first can only check internal consistency.
- **A close requires a `confirmed` verdict.** A merge without one is an unreviewed merge wearing
  the same label.
- **Two rejected verifications escalates** — separate from and independent of the gate's
  three-failure cap. Three failed gates is a mechanical problem; two rejected verifications means
  the ticket is wrong or the investigator cannot see it. Both need a person.

**One test decides what reaches the human:** *is this work stream stopped until they answer?*
**A gate holds its own ticket, not the factory** — park that worktree, mark the ticket `blocked`
with the reason, and dispatch the next eligible ticket immediately. Never drain in-flight work to
wait for an answer. If the wave can keep going, it does not get sent. Progress, successes, wave counts, a dismissed finding, a first or
second failed gate inside the retry budget — all pull, not push. `localhost:7373` answers "how is
it going" for free.

Three things pass: a spent retry budget, two rejected verifications, and any `escalation.md` gate.
Plus one batched summary **only if an unattended run ends with unresolved items** — a clean run
sends nothing, and the script enforces that rather than trusting the caller. Send via
`scripts/factory/notify.mjs`; set `SLACK_WEBHOOK_URL` once and it degrades to stdout without it.
**Batch** — three tickets blocking within a minute is one message.

## The unit of work is the bundle, not the ticket

**Set by the maintainer 2026-08-03, after CodeRabbit rate-limited the factory.** One PR per ticket
produced a review queue that stalled — and a stalled reviewer blocks merges harder than a large
diff does. Related tickets now ship together: **one bundle, one worktree, one branch, one PR, one
review.**

**A bundle is a Linear parent issue titled `[PR-x] EPIC: …` whose body says "one branch, one PR,
one CodeRabbit review."** That declaration is the discriminator, and it is deliberately explicit —
a plain `EPIC:` parent (the audit's category epics, `TRO-167`/`TRO-169`/`TRO-241`) is a *grouping*,
not a bundle, and its children still ship one PR each. Do not infer a bundle from a parent link
alone.

Working a bundle:

- Reserve **every** sub-issue in Linear before dispatching anything. The bundle is the lock.
- One worktree, named for the **bundle**. Every sub-issue is a commit on that branch, sequenced by
  the epic's internal order.
- Sub-issues still tier individually (`references/model-tiering.md`) — an apply-tier ticket inside a
  bundle still gets a cheap applier. **Bundling changes where the work lands, not who does it.**
- `gate.sh` runs on the bundle branch after each sub-issue's commit, and again before the PR. A
  sub-issue that cannot pass the gate is reverted out of the branch and marked `blocked`; **the rest
  of the bundle still ships.** One stuck ticket must not hold four finished ones hostage.
- The bundle's own definition of done (in the epic body) is checked in addition to each sub-issue's.

### Bundles have a size ceiling, and it is not a style preference

**Measured 2026-08-08 across 21 PRs (2026-08-02→08, CodeRabbit export, 256 comments):**

| PR size | comments posted | accepted | acceptance |
|---|---|---|---|
| **≥20 comments** | 168 | 20 | **11%** |
| **<20 comments** | 88 | 40 | **45%** |

Acceptance falls **four-fold** as review volume rises. Two PRs (#107 at 85 comments, #108 at 61)
produced 57% of the week's entire finding volume between them and accepted 15% and 11% of it. On
#107 — the largest PR of the week — a **Critical finding was posted and dismissed**. Every
performance finding all week (5 across 3 PRs) was dismissed: 0% accepted.

The honest reading is not "CodeRabbit gets noisier on big PRs." It is that **we stop reading
properly.** Bundling was adopted to stop a stalled review queue, and it works — but its cost lands
somewhere invisible, in dismissals nobody re-examines, and that cost is now measured.

So:

- **Target under 20 review comments per PR.** That is roughly 3–5 related sub-issues, not eight.
- **A bundle whose review exceeds ~40 comments is over-bundled.** Say so in the report, and split
  the next one rather than defending this one.
- **Never dismiss a Critical or a Major on a PR carrying more than 20 comments without writing the
  reason in the ledger.** That is exactly where the one dismissed Critical went.
- **Dismissals are the metric to watch, not throughput.** A 90%-acceptance PR (#122: 9 of 10) means
  the review was read. An 11%-acceptance PR means it was survived.

**A ticket earns its own PR only when it is genuinely separable *and* the bundle would otherwise be
unreviewable — and that is a call to make out loud in the report, not silently.**

Unbundled tickets keep the original per-ticket behaviour throughout the loop below. Where a step
says "ticket", read "bundle" when working one.

## What "done" means in this factory

A ticket is **not** done when the agent says it is, and **not** done when tests pass. It is done
when all of this holds:

1. Work is on its own branch named for the **bundle** (or the ticket, when unbundled), based on
   `main`.
2. `scripts/factory/gate.sh` returns `verdict: pass` — typecheck, build, no new test failures vs
   `audit/factory/quarantine.json`, no weakened tests, a regression test present, a `CHANGES.md`
   entry, and a bounded diff. **In a bundle, every sub-issue carries its own regression test and its
   own `CHANGES.md` entry** — the gate checks the branch, so one sub-issue's test can mask another's
   absence. Check per sub-issue, not per branch.
3. A PR is open and CI is green — **one PR for the whole bundle**, listing every ticket it closes.
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

### 1. Select the next bundle (or ticket)

Pull open issues from Linear, **team `Troysatchell`**, scoped to the project the run is for.
**Default: `FleetGraph — Week 5 Project Intelligence Agent`** — that is the live work.
`ShipShape Audit Remediation` is Week 4 and effectively closed (121/123 Done); select from it only
for a named residual, never as queue-filler.

Scope is load-bearing, and issue numbers will not give it to you. This team holds six projects whose
numbers **interleave**: `TRO-250`–`275` are a separate product's security audit, `TRO-312`–`365` are
mostly FleetGraph, and the W4 project is `TRO-164`–`249` plus `TRO-276`–`311` plus `TRO-354`. There
is also an iOS app and a healthcare copilot in the same team. Measured 2026-08-08: scoping a sweep by
number range instead of by project produced **88 orphan tickets where the true answer was 9** — the
other ~80 were other products' work. **Filter by project via the API. Never infer scope from a
ticket-number range, and never dispatch outside the selected project.**

**Select bundles first.** If open work has `[PR-x] EPIC` parents, the selectable unit is the bundle
and its sub-issues are never selected independently. Order bundles by their epic's declared position
in the dispatch order (`A ∥ B → C → D ∥ E → F → G` for FleetGraph), then by priority.

Within a bundle, order sub-issues by the epic's stated internal order. For unbundled tickets, order
by, in priority sequence:
- **Unblocks other work first** — Linear `blocks` relations are real dependencies (API-1 → API-2/3;
  TF-3 → TF-4; TF-2 → TF-1).
- **Urgent before High before Medium.**
- **Shared root cause batched together** — DB-2⇄API-6, DB-4⇄API-4/API-5/ERR-7, BUN-1⇄BUN-2/3/4/6
  are one fix each, not six. Batching them is cheaper *and* produces a better measurement story.

Move **every** ticket in the batch — or **every sub-issue in the bundle** — to **In Progress** in
Linear before dispatching. Not just the primary one. That is the lock, and it only works if it
covers everything the branch will close. Reserve the whole set before any agent starts, or a second
worker can select a ticket that is already being fixed inside someone else's branch.

### 1a. Run in parallel — serialize only on real dependencies

**Parallelism now lives between bundles, not inside them.** Dispatch every eligible bundle
concurrently; within a bundle, sub-issues run in the epic's stated order on one branch. That is the
trade the bundling policy buys — fewer PRs at the cost of some intra-bundle serialization — and it
is why bundles are grouped by shared surface, so the sequenced work is the work that would have
conflicted anyway.

Two sub-issues in one bundle may still run concurrently when they touch disjoint files and the epic
does not order them. Same worktree, same branch — so this is ordinary concurrent editing, and the
moment two agents want the same file it stops being worth it.

The **only** reasons to serialize whole units:

- **A true blocking dependency.** Linear `blocks` relations: API-1 → API-2/API-3, TF-3 → TF-4,
  TF-2 → TF-1. The blocked ticket waits.
- **Same-file collisions.** ERR-1 and ERR-2 are both in `api/src/collaboration/index.ts` and are
  one change; they go on **one branch as a batch**, not two parallel ones that conflict.
- **Expensive-tier measurement ordering.** `db-query-audit` must run after `api-perf-audit`, never
  concurrently — its statement logging skews the other's timings.

Everything else runs at once. Each **bundle** (or unbundled ticket) has its own worktree, its own
database, and ports that `worktree.sh` **probes for and claims** rather than deriving from a hash
alone — the hash only sets a stable starting point, and `md5 % 900` collides in practice (~50% odds
by 36 concurrent units). Re-evaluate the graph after every completion: a unit whose blockers are now
`Done` becomes eligible immediately.

Bundling also *reduces* database pressure — one bundle holds one database for four tickets instead
of four — so concurrency sizing (`/ship-orchestrator` §3) gets easier, not harder.

### 2. Provision an isolated worktree

```bash
# per bundle — the epic id names the worktree and the branch
scripts/factory/worktree.sh TRO-325 feat/pr-a-ship-api-foundations

# per ticket, when unbundled
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
```

Creates the worktree, a dedicated database, per-unit ports, and `.factory-env`. Re-running it
resets the database — a retry starts clean rather than inheriting a half-migrated state.

**One worktree per bundle, not per sub-issue.** Provisioning a worktree per sub-issue and merging
them back is exactly the fan-out the bundling policy exists to remove.

### 3. Dispatch — tier it first

**Before composing any brief, decide the tier** (`references/model-tiering.md`):

> Can you name the file, the change, and the check that proves it?
> **Yes** → dispatch an `haiku` applier with the applier contract. Nothing else — no lessons, no
> role skill. **No** → dispatch a `sonnet` investigator with the full brief below.

Apply-tier covers every ticket the architect decomposed to file-and-change precision, and nearly
every fix-now CodeRabbit finding — the reviewer already did the diagnosis. Sending a
40 KB-briefed investigator to add a missing `await` is the single largest source of waste in this
factory. An applier that finds its instruction does not match the file **stops and reports**; that
is a correct outcome and costs one cheap round trip.

For investigate-tier only, use the contract in `references/agent-contract.md` verbatim as the
agent's brief, filled in with the ticket. The contract carries the non-negotiables: scope, the
locked-quarantine rule, the provenance requirements, and the instruction to keep working rather
than check in.

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

**The cap is per sub-issue, not per bundle.** A sub-issue that spends its retry budget is reverted
out of the bundle branch and marked `blocked`; the bundle continues with the rest and its PR lists
the ticket that was dropped and why. **Never let one stuck sub-issue block a finished bundle** — and
never quietly ship the bundle without saying a ticket fell out of it.

**Append a scorecard row after EVERY gate run — pass or fail, including each retry.** One line to
`audit/factory/scorecard.jsonl`, right here in the loop, before you retry or move on:

```json
{"ticket":"TRO-312","bundle":"TRO-325","attempt":2,"verdict":"fail","failedGates":["regression-test"],"ts":"..."}
```

Rows stay **per sub-issue** — that is the level the gate-pass-on-first-attempt trend is meaningful
at. `bundle` is omitted for unbundled tickets.

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
summary. Template in `references/agent-contract.md`. A batched or bundled branch **must list every
ticket it closes**. Move all of them to **In Review** and attach the PR link.

**One PR per bundle.** Its body is structured *per sub-issue* — each ticket's problem, its change,
and its proof — because a bundle PR is the one place a reviewer can lose track of what is being
claimed. A bundle PR that reads as one undifferentiated change has defeated the purpose: the point
was to spend one review well, not to hide four changes inside one diff. Also name any sub-issue that
was dropped from the bundle and why.

### 7. Review — two reviewers, one decider

**Run both reviewers.** They answer different questions and neither substitutes for the other:

- **CodeRabbit** reviews the *code*. Is it correct?
- **`/ship-qa-review`** reviews the *proof*. Does the regression test actually run in a suite the
  gate executes? Was red ever seen? Did the bar move instead of the code? Does every "verified"
  claim name what was run? None of that is visible to a code reviewer, and this repo's own audit
  found 68 e2e tests that passed without executing a single assertion.

**Both feed `/ship-pm`, which decides.** Do not apply a rule table yourself. The PM asks three
questions of every finding — *is it in scope, is it needed, is it efficient to fix now* — and the
second one is the one the old mechanical triage never asked. A finding can be entirely correct and
still not worth acting on; the PM must be able to say why, naming something real.

The PM's disposition routes the work:

| Disposition | Goes to |
|---|---|
| Fix now, and the file and change are named | An `haiku` applier — the common case |
| Fix now, but the cause is unknown | A `sonnet` investigator |
| Real, not this branch | A new Linear ticket |
| Dismissed | The thread, with the reason and its evidence |

`references/triage.md` holds the mechanics — ticket format, labels, priorities. `/ship-pm` holds
the judgment. **New tickets get filed in Linear automatically** — that is how the factory grows its
own backlog instead of losing findings in PR threads.

**Record every finding in the ledger, whatever its disposition:**

```bash
node scripts/factory/review-ledger.mjs record --ticket TRO-276 --pr 12 --source cli \
  --severity major --category type-safety \
  --file api/src/__tests__/process-safety.test.ts \
  --disposition fixed --summary "non-null assertions and any cast" --ts 2026-07-29
```

This is not bookkeeping. Fixing findings one at a time and discarding them means a defect class can
recur on four separate branches without anyone noticing it is the same defect four times — which is
exactly what happened on the first real day of operation: five type-safety findings across four
tickets, each fixed in isolation.

**Then read the aggregate before dispatching the next wave:**

```bash
node scripts/factory/review-ledger.mjs report
```

The thresholds are the point:

| Recurrence | Meaning | Action |
|---|---|---|
| 1 ticket | feedback | fix it, move on |
| **2 tickets** | a rule is missing from the brief | add it to `references/lessons.md` |
| **3+ tickets** | the prompt is not holding | add a **mechanical check** to `gate.sh` |

A rule stated in the brief and ignored three times does not need restating louder. `gate.sh` G7b
(`review-patterns.mjs`) exists because two classes crossed that line. Extend it when others do.

Also read the **dismissed** list the report prints. Dismissals are legitimate — two on day one were
correct, one with strong disconfirming evidence — but a growing pile in one category means the
factory is talking itself out of real feedback.

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

**Checkpoint the orchestrator session between waves — don't let "keep working" mean one unbroken
session for the whole run.** Every turn resends the accumulated transcript; a session that runs
continuously for a full multi-day sprint pays for that entire growing history on every tool call, not
just for the work in front of it (`docs/submission/AI-COST-ANALYSIS.md` — orchestration was ~75% of
the sprint's measured spend, dominated by re-reading context across thousands of requests, not by
writing code). The board and the gates make this safe: `board.mjs`/`serve.mjs`/`status.mjs` and
`scorecard.jsonl` read from worktrees, `gh`, and Linear — not from anything held only in the session's
memory — so a fresh session picks up exactly where the last one left off with a cheap reload (`git
worktree list`, the scorecard, `activeContext.md`), not a rebuild.

End the current session and start a new one at a natural boundary — after a wave of tickets merges,
before dispatching the next batch — rather than continuing indefinitely in one session. This is
scheduling discipline, not a change to the "don't ask, keep going" instruction: the user still doesn't
need to approve anything, the run just resumes in a session that isn't dragging its entire history
along.

## Visibility — keep the board current

Two surfaces, deliberately, because they answer different questions:

```bash
node scripts/factory/serve.mjs           # OPERATE — http://localhost:7373, free to refresh
node scripts/factory/status.mjs          # OPERATE — one-screen terminal view
node scripts/factory/board.mjs > audit/factory/board.html   # SHARE — then republish
```

**Use `serve.mjs` while a run is in progress.** It rebuilds from live state on every request,
costs nothing, and needs no agent in the loop. `status.mjs` is the same data in the terminal.

**The published Artifact is for sharing a milestone, not for operating.** It can only be updated
by an agent calling the Artifact tool — a shell script cannot republish it — so every refresh
costs a tool call and only happens mid-turn. Republish it at meaningful checkpoints (end of a
run, before a demo), not per transition. Use the **same file path** so it redeploys to the one
stable URL rather than minting a new one:

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
- **Nothing on a branch that the branch does not close.** A bundle branch covers exactly its epic's
  sub-issues; a batched-root-cause branch covers exactly its batch. Either way the PR lists every
  ticket it closes. **Unrelated drive-by fixes are still not allowed** — bundling widened what may
  share a branch, it did not remove the requirement that everything on it be accounted for.
- **Never split a bundle to dodge a slow review.** If CodeRabbit is slow, wait — opening four PRs to
  route around one queue is the exact behaviour that caused the rate limit.
- **Claims carry provenance.** `.claude/CLAUDE.md` requires observed-vs-derived to be marked. Three
  documented failures in this project came from unmarked inference. The PR template enforces it;
  do not let agents write "verified" about something they reasoned about.
- **Surface, don't hide.** If you skip a category, lower a bar, or drop a ticket, say so in the
  report. Silent truncation reads as success when it wasn't.
