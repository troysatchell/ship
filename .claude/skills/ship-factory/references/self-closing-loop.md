# The self-closing loop

The factory should consume its own findings. A defect surfaces, gets fixed, gets independently
verified, and closes — with no human in it. A person only ever sees the cases the loop genuinely
cannot resolve, and they see those in Slack rather than by watching a terminal.

That only works if two things are true: the loop can **tell the difference** between a finding it
can close and one that needs a decision, and its verification is **independent** of whoever did the
work. Both are below.

```
finding ─▶ classify ─┬─▶ error-class ─▶ applier ────┐
                     │                              ▼
                     └─▶ issue-class ─▶ ticket ─▶ gate ─┬─ pass ─┬─▶ verifier   ─┐
                              ▲                         │        └─▶ qa-review  ─┤
                              │                         │                        ▼
                              │                    fails ×3                  both ok?
                              │                         │                    ├─ yes ─▶ PR ─▶ CodeRabbit
                              │                         ▼                    │              ─▶ PM triage
                              └──── REWRITE ◀──── can a rewrite fix it?      │              ─▶ CLOSED
                                    (max 2)            │ no                  └─ no ──────────┘
                                                       ▼                        (back to the agent)
                                                     SLACK
```

**Read the rewrite arrow first.** It is what keeps the escalation channel quiet, and it was missing
from the first version of this design.

## Classify first — error or issue

**Error-class: the finding already specifies the defect.** Nothing needs deciding; something needs
typing, and a mechanical check can prove it worked.

- A type error, a missing `await`, an unhandled rejection
- A new `any` / `as any` / non-null `!` this diff introduced
- A missing index on a query the reviewer named
- A route returning 500 where it should return 400
- A lint or convention violation with an unambiguous fix

**These do not get a ticket.** A ticket for a missing `await` is bookkeeping that costs more than
the fix. Dispatch an applier (`references/model-tiering.md`), let `gate.sh` prove it, close it.
Record the finding in the review ledger so recurrence still gets counted — that is what a ticket
would have given you, without the overhead.

**Issue-class: the finding names a symptom, not a fix.** Anything requiring diagnosis, a design
decision, a tradeoff, or a change to what users see.

- "This flow is slow" — cause unknown
- "This test is flaky" — cause unknown
- "This endpoint should paginate" — a design decision
- Anything touching auth, session, or security semantics
- Anything that changes product behaviour

**These get a ticket, an investigator, and a verifier.** The ticket exists because the work has to
be reviewable and because the git history is read directly.

When genuinely unsure, treat it as issue-class. A ticket for something that turned out mechanical
costs one wave of overhead; an applier turned loose on something that needed a decision costs a
wrong fix that passes its gate.

## Rewrite before you escalate

A ticket that failed is usually not a ticket that needs a human. It is more often a ticket that
was **written badly** — under-specified, tiered wrong, or three changes wearing one title. The PM
reads the failure and asks one question:

> **Would a differently-written ticket succeed?**

| The failure says | Rewrite as |
|---|---|
| The applier stopped — the instruction did not match the file | An investigator ticket. The change was not as specified. |
| The agent kept fixing things outside scope | Two or more tickets, one change each |
| The gate failed on the regression test three times | A ticket that names what the test must assert, not just that one is required |
| The agent asked what to do | A ticket that answers it — the missing decision belonged in the ticket |
| The verifier said "fixes the symptom, not the cause" | A ticket stating the cause, if the PM can now name it |

Rewrite, re-queue, dispatch fresh. **Not** a retry against the same agent — a new ticket, new
worktree, and no inherited context, because the inherited context is what produced the failure.

**Cap: two rewrites.** A third failure on the same work means the problem is not the wording, and
that is exactly the signal worth a person's attention. Without the cap this loop spins.

This is the mechanism that makes the escalation channel rare. Anything an agent could fix given a
better instruction gets a better instruction, automatically, and never reaches Slack.

## Two pre-PR checks, then CodeRabbit

Both run after the gate passes and **before the PR opens**, in parallel with each other:

| Check | Question | Why here |
|---|---|---|
| **Verifier** (blind) | Did we build the right thing? | Independent of the investigator's framing |
| **QA review** | Is the proof real? | Repo-specific: does the test run where the gate executes, was red seen, did the quarantine widen |

Only when both pass does a PR open, and only then does CodeRabbit review the code.

**The ordering is deliberate.** Opening a PR whose regression test never runs, and then having a
reviewer spend a full pass on it, means the review was spent on code whose proof was invalid the
whole time. And running QA *alongside* CodeRabbit is worse than either — QA validates the proof,
CodeRabbit's fix-nows change the code, and QA's verdict is now about a diff that no longer exists.

Each check has one job and they do not overlap: **right thing / real proof / correct code.**

## The verifier — and why it must be blind

After an investigator reports done and `gate.sh` passes, a **separate agent verifies the work**.
Not a second opinion on the code — a check that the right thing was built.

**The verifier receives exactly three things:**

1. The original finding or ticket, **verbatim, as first written**
2. The diff (`git diff main...HEAD`)
3. The gate result JSON

**It does not receive the investigator's report, its commit messages, or its PR body.**

That omission is the entire mechanism. An investigator's narrative is a *framing* — it explains why
what was built is what was needed, and it is persuasive precisely because it was written by
whoever decided that. A verifier that reads it first inherits the framing and can only check
internal consistency. Reading the finding fresh and the diff cold is what makes the check
independent, and independence is the only property that makes the loop safe to close without a
human.

This is the same discipline `.claude/CLAUDE.md` demands of claims generally. Three documented
failures in this project came from a derived claim carrying the confidence of an observed one; a
verifier that starts from the investigator's account is guaranteed to repeat that pattern.

**The verifier answers three questions, in order:**

All three are about **fidelity to the finding** — the one thing the verifier has that nobody else
does. Proof quality belongs to `/ship-qa-review`, running alongside it; the two do not overlap.

| Question | Rejects when |
|---|---|
| **Does the diff address the finding as originally stated?** | It fixes something adjacent, or fixes the symptom the finding described rather than the cause it named. |
| **If the hypothesis was wrong, does the diff say so?** | A finding whose stated cause turns out to be wrong is a legitimate and common outcome. What is not legitimate is silently solving a different problem and reporting the ticket done — the divergence has to be stated, so the next reader is not misled about what was actually wrong. |
| **Did anything else change?** | Files outside the finding's scope. Drive-by fixes break one-change-per-branch, and the git history is read directly. |

**Verdict is one of three:**

- `confirmed` — all three pass. The work closes.
- `not-addressed` — back to the same investigator with the specific question that failed, and the
  diff. Same agent, because its context is worth keeping.
- `scope-drift` — the work is correct but exceeds the ticket. Split it: the in-scope part merges,
  the rest becomes a new ticket. Do not merge the whole thing to save a wave.

**Two rejections on one ticket escalates.** Not three — a verifier rejecting twice means either the
investigator cannot see the problem or the ticket is wrong, and both need a person. The gate's
retry cap is separate and independent: three failed gates escalates on mechanical grounds, two
rejected verifications escalates on comprehension grounds.

## What self-closes, and what a close means

A ticket closes itself when **all** of:

1. `gate.sh` returns `verdict: pass`
2. CI is green on the PR
3. The verifier returned `confirmed`
4. Every review finding is triaged, with the fix-now ones fixed and re-reviewed
5. No open escalation on the ticket

The Linear ticket carries the evidence — gate result, PR link, verifier verdict, and any
measurement. **A close with no verifier verdict attached is not a close**; it is an unreviewed
merge wearing the same label.

## What reaches the human

**One test, and it is the only one:**

> **Is this work stream stopped until the person answers?**

**A gate holds its own ticket, not the factory.** Everything running in parallel continues — the
blocked worktree parks, its Linear ticket goes to `blocked` with the reason, and the orchestrator
selects the next eligible ticket immediately. Do not drain in-flight work to wait for an answer,
and do not stop dispatching. The whole point of one-worktree-per-ticket is that a stall is local.

Escalate the ticket, keep the wave moving, and pick the parked ticket back up when the answer
lands. If it can keep going, it does not go to Slack. That rules out most of what a status channel
usually carries — progress, successes, wave counts, a finding the PM already dismissed, a first or
second failed gate still inside the retry budget. All of that is **pull, not push**: the board at
`localhost:7373` answers "how is it going" for free, rebuilt from live state on every request, and
costs nobody's attention.

**And nothing reaches it that a rewrite could have fixed.** That is the point of the rewrite loop
above: a failure is first treated as a badly-written ticket, twice, before it is treated as a
problem needing a person. In practice that should leave very little.

What survives:

| Trigger | Severity | Why the factory cannot proceed |
|---|---|---|
| A third failure after two rewrites | `blocked` | The wording is not the problem. Something real is. |
| Two rejected verifications | `blocked` | Either the ticket is wrong or the investigator cannot see the problem, and the PM could not tell which from the failure alone. |
| Any trigger in `escalation.md` | `gate` | Credentials, irreversible or outward-facing actions, product-visible behaviour, auth/session semantics, a screen-reader claim, a wrong ticket, scope explosion, an unreproducible measurement |
| An unattended run ends **with unresolved items** | `summary` | One batched message listing what is waiting. `--count 0` sends nothing — a clean run is silence, enforced in the script rather than left to a caller's discipline. |

There is deliberately **no informational severity**. Adding one is how this channel stops being
read, and a channel that is not read is worse than no channel because it looks like coverage.

**Batch.** Three tickets blocking within a minute is one message with three items. The escalation
surface is worth exactly as much as it is rare.

**A PM dismissal is not an escalation.** If the PM dismisses a finding the reviewer rated critical,
that is a judgment the factory can proceed on — it goes in the review ledger, where the dismissal
report will surface it if a pattern forms. Pinging on every disagreement trains the reader to skim.

```bash
node scripts/factory/notify.mjs --severity blocked --ticket TRO-311 \
  --title "Two rejected verifications" \
  --why "Verifier says the diff fixes the symptom, not the cause named in the finding." \
  --need "Confirm whether the finding's hypothesis is wrong, or the fix is." \
  --link https://github.com/troysatchell/ship/pull/42
```

The script degrades to stdout when `SLACK_WEBHOOK_URL` is unset, and never fails a run — a
notification failure must not take the factory down.

**Batch escalations where you can.** Three tickets blocking within a minute is one message with
three items, not three pings. The escalation surface is the only thing competing for a person's
attention, and its value is entirely a function of how rarely it fires.
