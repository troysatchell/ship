# Model tiering — who thinks, who types

The factory's first design gave every worker the same brief: `agent-contract.md` (6.7 KB) +
`lessons.md` (23 KB) + a role skill (10–20 KB). About 40 KB of prefix, per agent, per ticket,
whether the ticket needed a root-cause investigation or a one-line type annotation.

That is backwards. **Context should sit with whoever is reasoning, not with whoever is typing.**

## Three tiers

| Tier | Who | Model | Context it carries | Lifetime |
|---|---|---|---|---|
| **Direct** | Orchestrator, PM, Architect, QA Lead | `opus` | Full repo understanding, the spec, the board, accumulated review history | Long-lived — many tickets across one session |
| **Investigate** | Ticket agent | `sonnet` | Contract + lessons + role skill + the ticket | One ticket |
| **Apply** | Fix worker | `haiku` | One precise instruction. Nothing else. | One fix, minutes |

The directing tier is where prompt caching pays. Those agents keep a stable prefix across dozens
of turns, so the repo context is written into cache once and read cheaply thereafter. The applying
tier is the opposite: it should be so cheap to spin up that caching is irrelevant, because there is
almost nothing to cache.

## The discriminator — investigate or apply?

This is the only judgment that matters, and a directing agent makes it before every dispatch:

> **Can I name the file, the change, and the check that proves it?**
>
> **Yes** → dispatch an applier. **No** → dispatch an investigator.

Concrete:

| Work | Tier | Why |
|---|---|---|
| "Replace the `as any` on `documents.ts:412` with `DocumentRow`; `pnpm type-check` must stay clean" | Apply | File, change, and check are all named |
| "Add `blocks` to the relationship enum in three places (listed) plus a migration modelled on 017" | Apply | Fully specified, precedent named |
| "CodeRabbit says this query has no index — add one" | Apply | The reviewer already did the diagnosis |
| "Standups are not persisting under load; find out why" | Investigate | Requires diagnosis |
| "Implement the change-feed endpoint" | Investigate | Design decisions remain open |
| "This test is flaky — fix it" | Investigate | Root cause unknown |

**A CodeRabbit finding is almost always apply-tier.** The reviewer has already located the defect
and named the file. Sending a 40 KB-briefed Sonnet agent to add a missing `await` is the single
largest source of waste in the old design.

## The applier contract

Appliers get **this and nothing else**. No `lessons.md`, no role skill, no audit report. If the
instruction is not self-contained enough for that, it was an investigate-tier task and the
discriminator was applied wrong.

```
You are making one precise, pre-specified change in the Ship repository.

WORKTREE: {{path}} — work only here. Already checked out on the right branch.
FILE:     {{file:line}}
CHANGE:   {{exactly what to do}}
WHY:      {{one sentence — so you can tell if the instruction is wrong}}
PROVE IT: {{the exact command that must pass}}

Rules:
- Change only what is described. Nothing else, no drive-by fixes.
- Never `git commit --no-verify`.
- Never weaken a test to get green — no .skip, no .todo, no removed assertions.
- If the instruction does not match what you find in the file, STOP and report the
  discrepancy. Do not improvise a different fix. A wrong instruction is information.

Report: the diff you made, the command output proving it, or the discrepancy that stopped you.
```

The stop-on-discrepancy rule is what makes a cheap model safe here. An applier that finds reality
does not match its instruction has discovered something the directing agent got wrong — that is a
signal worth more than a guessed fix, and it costs one cheap round trip to surface.

## Caching discipline for the directing tier

Directing agents earn their cost only if their prefix stays stable. Three rules:

1. **Do not rebuild the brief between tickets.** Same session, same system prompt, append the new
   ticket as a message. Rewriting the prefix per ticket discards the cache.
2. **Put volatile content last.** The spec, the repo facts, and the standing rules are stable and
   go first. The ticket, the board state, and the review output go after them.
3. **Checkpoint between waves, not mid-wave.** A directing session that runs for days pays to
   resend its whole history on every call. End the session at a wave boundary and start fresh —
   the board, the scorecard and Linear are the state, not the transcript.

## What this changes about dispatch

The orchestrator no longer dispatches one agent per ticket. It dispatches:

- **One investigator** per ticket that needs diagnosis, as before.
- **N appliers** in parallel for work that is already specified — including every fix-now
  CodeRabbit finding, and every ticket the Architect decomposed to file-and-change precision.

A ticket can move between tiers mid-flight. An investigator that finishes its diagnosis and finds
three more mechanical changes should **report them as applier instructions** rather than doing them
itself. The whole point is that the expensive context does the thinking once and the typing is
cheap.

## Sizing

Appliers are cheap enough to run wide, but they still hit the same Postgres container and the same
worktree pool. Cap concurrent appliers at the same limit `/ship-orchestrator` §3 sets for
investigators, and prefer batching several appliers into one worktree when they touch the same
branch — a worktree per one-line fix is more setup cost than the fix.
