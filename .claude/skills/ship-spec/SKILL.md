---
name: ship-spec
description: >-
  Writes the spec that opens a factory build phase — problem stated as a cost, observable success
  condition, explicit non-goals, verified repo facts. Use when starting new work that has no audit
  finding behind it, before any architecture or ticket decomposition. Invoked by /ship-pm, which
  gates the result.
---

# Ship Spec

A spec exists to make one question answerable: **when is this done?**

The factory's gate can prove a change is correct. It cannot prove a change was worth making, and
it cannot tell you when to stop. That is what this document does, and it is why work with no spec
behind it sprawls.

Not every job needs one. A spec is for work with no audit finding behind it — new capability,
where the problem, the boundary and the success condition all have to be decided. A ticket that
says "fix DB-7, the index is missing" already has its spec; writing another is ceremony.

## Format

Six sections. Scale each to the decision it carries — a section with nothing contested is one line,
and padding a spec to look thorough is how non-goals get lost in the middle of a page.

### 1. The problem, as a cost

State what it costs someone that this does not exist. Not the feature.

> ❌ Add a change-feed endpoint to Ship's API.
> ✅ The agent has no way to ask what changed since it last looked, so proactive mode cannot exist
>    at all. Verified: no `since`/`updated_since` parameter anywhere in `api/src/routes/`; the
>    document list sorts by position and creation date, so recently-updated documents never appear
>    at its head.

The second version survives contact with an architect who knows a cheaper way. The first does not,
because it already picked one.

### 2. Who it is for, and what they do differently

Name the role and the changed behaviour. "Engineers benefit from faster feedback" is not a user;
"an engineer who currently retypes their standup from memory stops doing that" is.

If you cannot name a person whose day changes, the work may be real and still not belong in this
phase.

### 3. Success, observably

Something a human can run, or look at, and get a yes or no from. If it cannot be observed, the
factory cannot gate it and you will merge on vibes.

> ❌ The agent is useful and reliable.
> ✅ Given a standup posted with text identical to the author's previous one, the agent produces a
>    draft naming their unmentioned assigned issues, within the detection window, and the run
>    appears in the trace log.

Include the number when there is one. "Fast" is not a success condition; "under five minutes from
the event landing in Ship" is.

### 4. Non-goals

**The section that does the most work.** Every spec without one grows a ticket at a time until the
phase misses its deadline.

List what a reasonable person might assume is included and is not — and say why, briefly. "Not
doing X because it needs Y, which is not in this phase" is a decision. "Not doing X" alone reads as
an oversight and gets added back by the next person.

### 5. Verified repo facts

Everything the spec asserts about the codebase, with how you know it.

This section is the context transfer that makes the rest of the factory cheap. A fact verified here
once does not get rediscovered by an architect, then a ticket agent, then a reviewer.

`.claude/CLAUDE.md` requires observed-versus-derived marking, and three documented failures in this
project came from a derived claim carrying the confidence of an observed one. Mark which is which,
and state the configuration anything was checked under.

> Observed: `document_associations.relationship_type` is an enum of exactly
> `parent | project | sprint | program` (`schema.sql`), and `document_links` has 0 rows in the dev
> database. Ship cannot express "A blocks B."
>
> Derived: because the org chart lives in `person.properties.reports_to` and no route joins the
> two, no existing view can show a blocker's cross-team impact. Not exhaustively checked — read
> the route list, did not read every component.

### 6. Constraints and deadline

What cannot change — product rules, security posture, the date. If the deadline forces a cut, the
cut belongs in non-goals, made explicitly, not discovered later when the work does not fit.

## Before handing it to the PM gate

Read it once as an adversary:

- Could two people read the success condition and disagree about whether it was met?
- Does any sentence describe an implementation? Move it out — that is the architect's decision and
  naming it here removes their ability to find something cheaper.
- Is any repo claim unmarked, or marked observed when it was actually reasoned?
- Would the non-goals stop the three most likely scope additions? If not, they are not doing their
  job.
- Is anything in here unfalsifiable? Delete it. A spec sentence that cannot be wrong is decoration.

## What happens next

`/ship-pm` gates it. A failed gate names the row that failed — problem-as-cost, observable success,
non-goals present, claims verified, fits the phase. Fix that row rather than softening the spec to
pass.

On approval it goes to `/ship-architect`, which owns the *how*: design, file-level decomposition,
and the ticket set the factory builds from.
