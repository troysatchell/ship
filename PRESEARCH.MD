# PRESEARCH — FleetGraph

A project intelligence agent for Ship, the project management tool built by the U.S. Department
of the Treasury.

Date: August 3, 2026

---

## What the agent is for

Ship asks people to write down what happened. Standups, weekly plans, weekly retros, weekly
reviews, project retros. It has an accountability engine that computes ten kinds of missing
paperwork, deterministically, and chases people for it.

That engine works. It also cannot tell whether any of the paperwork is true. The content check
strips three known template headings and passes if a single non-whitespace character remains, so
a weekly plan whose entire body is the word "stuff" is fully compliant.

The obvious response is to grade the writing. We tried that framing first and rejected it. An
agent that tells a federal employee their standup looks thin — on a document that feeds a
performance rating — is a surveillance tool aimed at the least powerful person in the room. It
is also solving the wrong problem. **People write "stuff" because writing it properly is tedious
and they are busy.** Enforcement does not change that. Removing the tedium does.

So:

> **Ship asks people to write down what happened. FleetGraph already knows — so it writes the
> first draft, and it tells you what needs you.**

The agent's job is to save time and surface obligations, not to audit compliance. Everything
below follows from that.

---

## A note on the data we tested against

Everything here was checked against Ship's development database: 523 documents, 254 issues, 20
users, 20 person records, 35 weeks spanning weeks 11 to 17.

That database was built to a specification in the Week 4 brief — "seed the database with
realistic data: 500+ documents, 100+ issues, 20+ users, 10+ sprints." It is a load-testing
fixture, made to give benchmarking tools enough rows to produce meaningful latency numbers, not
to model how people behave.

Consequences that matter:

| What we found | Why the fixture is like that |
|---|---|
| Zero rows of document history | Latency benchmarks never read the audit trail |
| Zero comments | Same |
| Start and completion timestamps empty on all 254 issues, including all 71 marked done | Nothing in a load test reads them |
| Plan approval state never set on any of the 35 weeks | Not needed to render the page |
| Performance ratings never set | Not needed to render the page |
| Job role empty on all 20 people | Not needed to render the page |
| Reports-to set on only 10 of 20 people | The seed builds a three-level hierarchy and stops |
| All 523 documents workspace-visible, none private | The seed creates no private documents |
| Weekly plans and retros drawn from 11 fixed content pools | Fastest way to manufacture 500+ documents |

**So counts from this database measure the fixture, not Ship's users.** The unit ratios used in
the cost model are safe, because documents and issues per project are exactly what the fixture
was built to be realistic about. Behavioural claims are not, and none are made here.

This matters more under the new framing than it did under the old one. The agent drafts from
observable activity — issue state changes, comments, edits — and the fixture records none of
that. Building those states is fixture work, and the Week 5 brief explicitly asks for "the Ship
state that should trigger the agent," so constructing them is part of the assignment.

---

## Phase 1: Define Your Agent

### 1. Agent responsibility scoping

#### What events in Ship should the agent monitor proactively?

Ship has no event bus and no way to push notifications outward. So "events" means observed state
changes, found by comparing each document's last-updated timestamp against a saved cursor and
reading the document history table where entries exist.

| Event | How it is observed | What the agent does with it |
|---|---|---|
| An issue changes state | A history row recording the state field | Material for a standup draft |
| An issue changes assignee | A history row recording the assignee field | Someone's inbox changes |
| A comment is posted | A new comment row | Material for a draft; possibly a mention |
| A document body is edited | The last-updated timestamp moves | Material for a draft |
| Someone is mentioned | Walking the changed body for mention markers | Goes into that person's inbox |
| A plan or review approval flips | The approval status field changes | Unblocks someone, or starts a waiting clock |
| A week crosses its start or end boundary | Date arithmetic on the week number | Retro drafting window opens |

The last one matters and is easy to miss. **Nothing in Ship writes a row when a week ends.** There
is no change to detect. This is why a purely change-driven design is insufficient and the agent
needs a scheduled pass as well as a change-driven one.

#### What constitutes a condition worth surfacing?

Under the old detection framing this was a long list of gates designed to stop the agent being
wrong in public. Changing the output from a criticism to a draft changes the calculation.

**A wrong draft costs a few seconds of editing. A wrong accusation costs trust permanently.** So
the bar comes down, and the agent can do considerably more.

What survives as a gate:

1. **Ship does not already say it.** No existing accountability item covers the same thing.
   Restating "you owe a standup" adds nothing. Note the agent's normal move here is different —
   rather than repeat the nag, it drafts the thing Ship is nagging about.
2. **There is something to say.** A standup draft with no observed activity behind it is not
   drafted silently — it says plainly that nothing moved, which is itself the useful signal.
3. **It is new.** No open item already exists for this document at this version.
4. **The recipient can act on it.** Nothing routed to someone with no authority over the work.

What is still never surfaced, even when detectable:

- Anything evidenced only by a document the recipient cannot see.
- Any concern about a week that has already been rated. Once a manager has recorded a performance
  rating, commenting means arguing with a closed federal personnel decision.
- Anything about a person with no manager link and no assigned work — there is nowhere to route
  it, and half the people in the system have no manager recorded.

#### What does it reason about when invoked on demand?

The document you have open **seeds** the question. It does not fence it.

This was the biggest correction to an earlier draft of this document, which treated the current
view as a boundary and had the agent refuse to look further. The brief says the chat "knows what
the user is looking at and uses that as the **starting point** for its reasoning." A starting
point and a boundary are different things.

**The boundary is what you are allowed to see. The view only decides where to start.**

From the open document the agent walks outward as far as the question requires:

- The document's project, week, and program
- Its issues, and their history
- The people on it, and their other work
- Documents that mention it, and documents it mentions
- What changed recently in any of the above

**It names every document it pulled in and why.** That is the trust mechanism — you can always
see the reach of an answer, so following the graph never feels like the agent went wandering.

#### What can it do without approval, and what always requires confirmation?

The gate is **where the fact came from**, not how large the write is. But the important change is
what the agent produces when it is not certain.

**It acts, when a query proves it.** Each of these is a structured lookup with no interpretation:

- Resolving mentions to people to user accounts, and assembling those into someone's inbox
- Linking a document to the issue or week it refers to, when the reference is unambiguous
- Writing its own drafts and findings, attributed to the agent
- Clearing its own item when the condition ends

**It drafts, when a model inferred it.** The agent's second output mode is a draft the human
edits and posts. It never posts as the human, and it never leaves an opinion the human is
expected to act on.

**It never does these at all:**

- Writing a performance rating. These are federal performance ratings on the standard five-level
  scale. Not at any confidence, not for any reason.
- Setting an approval state, week status, or ownership.
- Applying an issue state transition. It may *propose* one with its evidence attached; a person
  accepts it.
- Creating, archiving, or deleting any document.
- Writing anything that would read as though a person wrote it.

Stated as one rule:

> **Every output is either an action a query proved, or a draft a human confirms. The agent never
> has an opinion it expects you to act on.**

That rule is what structurally prevents the agent from becoming a complaint generator.

#### How does it know who to notify, and when?

Ship has no notification infrastructure at all — no notifications table, no email service, no
push mechanism. So the agent reaches people by writing into Ship itself.

The main surface is **one list per person: what needs you.** Not a stream of individual pings.
Everything the agent knows a person is on the hook for is assembled, ranked, and presented in one
place when they arrive:

1. Mentions of them they have not seen
2. Approvals they are blocking — someone else's week cannot start
3. Work assigned to them that is waiting on something they control
4. Drafts the agent has prepared for them

Ranking is by who else is blocked and for how long. Everything in the list carries a direct
action, not just a description.

Escalation to a manager exists but is deliberately last, and only after several periods with no
resolution. Because only half the people in the system have a manager recorded, that path must
degrade gracefully when the link is absent.

The agent never broadcasts to the workspace.

#### Precision, and why the bar moved

The two ways this agent can be wrong are not symmetrical, but the asymmetry is much smaller than
it was under the detection framing.

A wrong draft costs a few seconds of editing, and the human was going to write the document
anyway. A wrong accusation, on a document feeding a performance review, costs trust permanently.

The old design optimised hard against the second and ended up doing almost nothing. Changing the
output format from criticism to draft removes most of that risk, which lets the confidence bar
come down, which lets the agent do considerably more work. **The precision obsession was
downstream of a bad output format, not a fundamental constraint.**

Testing still splits into two artifacts:

**Regression tests** answer "did the code change behaviour?" They use recorded model responses so
they are deterministic in continuous integration, as the brief requires.

**A golden set** answers "did the drafts get worse?" Real Ship activity with human-written
reference drafts, run when the prompt or model changes. The second exists because the first hides
what it is meant to catch — recorded responses pin the output, so a prompt rewrite can change
production behaviour while the test suite stays green.

For drafting, the quality signal is better than for detection: **how much of the draft survives
to the posted version.** A draft the human posts unedited is a good draft. One they rewrite from
scratch is not. That is measurable in production without any labelling effort, and it is the
feedback loop the detection design never had.

#### How does it know who is on a project, and what their role is?

Ship keeps this in three places and confusing them is the trap.

The workspace membership table has a role column, but it only holds "admin" or "member", and the
schema comment says in capitals that it is for authorization only. Using it to work out someone's
job is simply wrong.

Person documents hold the real people data: a link to a user account, a link to a manager, and a
free-text job role. That job role is unreliable — free text with no fixed values, and in the
current database not one of the twenty people has it filled in.

Project membership lives in a separate associations table, alongside owner and assignee fields.

So roles are derived from structure, never read from a field:

| Role | How it is derived |
|---|---|
| Director | People reporting to them two or more levels deep; owns programs |
| Project manager | Owns projects or weeks; appears as approver on plans |
| Engineer | Has issues assigned; nobody reports to them |

---

### 2. Use cases

Every one of these either saves time or removes a lookup. None of them grade anybody.

#### Engineer: draft my standup

**The pain:** A daily standup is a small tax that lands when you are mid-task. The information in
it — what moved, what is blocked — is already recorded in Ship as issue state changes, comments
and document edits. People retype it from memory, badly, or they write "same as yesterday."

**Trigger:** The standup window opens on a working day for someone with assigned issues in an
active week.

**What the agent produces:** A draft assembled from what actually happened since their last
standup — issues that changed state, comments they wrote, documents they edited, and anything
they were blocked on. Where nothing moved, the draft says so plainly, and names the issues that
have not moved and for how long.

**What the human decides:** Edit and post, or discard.

**Autonomy:** Drafts only. Never posts as the person. May attach proposed issue state changes
with their evidence, which the person accepts or rejects individually.

*This absorbs what used to be a separate "your standup is thin" detection. The drift signal is
still delivered — it is just delivered as help rather than as criticism.*

#### Anyone: what needs me

**The pain:** Obligations are scattered across mentions inside documents, approvals sitting in
someone else's week, and issues assigned to you that are waiting on something. Nothing in Ship
aggregates them, and Ship's own accountability results are computed only for the person asking
and only cover missing paperwork.

**Trigger:** The person opens Ship, or opens the panel.

**What the agent produces:** One ranked list. Mentions of them they have not seen; approvals they
are blocking; work waiting on them; drafts prepared for them. Each item carries why it matters
(who else is blocked, for how long) and a direct action.

**What the human decides:** What to act on, and in what order.

**Autonomy:** Assembly is deterministic — mentions and approvals are structured lookups. The
ranking is judgment. Nothing in the list acts on its own.

#### Engineer or PM: draft the retro from what shipped

**The pain:** At the end of a week, someone reconstructs from memory what they delivered against
a plan they wrote five days ago. Ship holds the answer — the plan carries structured success
criteria, and the issues that closed this week are recorded.

**Trigger:** The retro window opens for a week whose plan carries at least one success criterion.

**What the agent produces:** The delivered section pre-filled from issues that actually closed,
mapped against each success criterion, with the criteria that have no matching closed work called
out so they can be explained rather than quietly dropped.

**What the human decides:** Edit, add the unplanned work the agent cannot see, submit.

**Autonomy:** Drafts only. The agent never sets the approval state — that is an explicit human
gate.

#### Director: what changed since you approved

**The pain:** Ship records which version of a plan a manager approved and flags the plan if it is
edited afterward. But the flag trips on any edit at all, so a typo fix and a quiet scope
reduction look identical. The manager has to diff it by hand or ignore the flag, and in practice
they ignore it.

**Trigger:** A weekly plan is edited after its approval.

**What the agent produces:** What materially changed, with the before and after side by side, and
a drafted re-approval request or a drafted question back to the author.

**What the human decides:** Re-approve, or send the question.

**Autonomy:** Drafts only. Approval states are never written by the agent.

#### Director or PM: trace a blocker and route it

**The pain:** When one issue is holding up work in several projects, nobody sees the whole shape
of it. Ship keeps blocking relationships in one place and the org chart in another, and **no page
joins the two.**

**Trigger:** An issue is blocking work in two or more projects, and the blocked people sit in
different reporting lines.

**What the agent produces:** The full impact — which issues, which projects, which people — the
lowest-level manager with authority over all of them, and a drafted message to that person.

**What the human decides:** Send it, or step in directly.

**Autonomy:** Working out who to escalate to is graph arithmetic on the reporting structure, so
routing needs no approval. The message is drafted, not sent.

**Dependency:** Ship cannot currently express "issue A blocks issue B" — the relationship types
are only parent, project, sprint and program, and the backlinks table is empty. Ship has a
containment tree and an org chart but no dependency graph. The decision is to add the missing
relationship to Ship rather than design around it. Scoped in
`memory-bank/fleetgraph-backlog.md`.

#### Anyone: answer from here, and follow the thread

**The pain:** Answering "what is going on with this?" means opening eight tabs. Ship's own
accountability results only ever cover the person asking.

**Trigger:** The person opens the chat panel anywhere in Ship.

**What the agent produces:** An answer seeded by the open document and expanded along whatever the
question actually requires — the project, the week, the issues, the people, recent changes,
related documents. **Every document it pulled in is named, with the reason it was pulled.**

**What the human decides:** What to do about it.

**Autonomy:** Read and answer. Anything it proposes doing follows the rules above.

---

### 3. Trigger model

#### The decision: hybrid, with polling as the backbone

The work splits into three rhythms.

| Tier | How often | What it does | Latency |
|---|---|---|---|
| **Fast** | The moment a document is saved | Mentions and assignment changes land in the affected person's list. No model. | About three seconds |
| **Steady** | Every 60 seconds | Collect what changed; keep the material each person's next draft will be built from | Around 80 seconds |
| **Deep** | Per person, before their window opens | Compose the actual drafts — standups in the morning, retros at week end | Scheduled, not reactive |

Note the change from an earlier design. The steady tier used to be where the model ran, once per
suspicious change. Under drafting it mostly **accumulates material**, and the model runs once per
person per window instead. That is both cheaper per unit of value and better output — a standup
draft written from a whole day of activity is more useful than six separate observations.

The five-minute detection requirement in the brief binds only on the fast tier, which is
deterministic and runs in about three seconds.

Polling can be the backbone because Ship's collaborative editor saves on a two-second delay and
always stamps the last-updated time when it does. That makes the last-updated timestamp a
complete signal for every content change. The document history table is only partial by
comparison — it records field changes broadly but only records body text for weekly plans and
retros.

#### Polling versus webhooks versus a hybrid

| | Polling only | Webhooks only | Hybrid (chosen) |
|---|---|---|---|
| Changes needed in Ship | One read endpoint | Emission code in at least two places | One read endpoint plus one in-process hook |
| Coverage | Complete | Only where emission was added | Complete |
| Missed events | Self-correcting — the next tick re-reads | Permanent. A dropped delivery is gone forever | Polling backstops the fast path |
| Week boundaries | Detected — the schedule is the trigger | Never fires. Nothing changes when a week ends | Detected |
| Mention reaching a list | Up to 60 seconds | About a second | About three seconds |
| Cost when nothing is happening | One indexed query returning nothing | Nothing | One indexed query returning nothing |
| Coupling to Ship's uptime | None | Ship's save path waits on your endpoint | None — the hook is fire-and-forget |
| Ease of testing | Replay a time range | Must simulate emission | Both |

**Webhooks alone fail for two reasons, both verified in the code.** Ship has no outbound webhook
mechanism and no database notification channel, so emission would have to be added both to the
REST write path and to the collaborative editor's save path. Missing the second would blind the
agent to the document edits its drafts are built from. And a week ending produces no change at
all, so there is nothing to hook.

**Polling alone is genuinely viable** and was the runner-up. It costs up to 60 seconds before a
mention reaches someone's list. The hybrid buys that back at the price of a single hook — and if
that hook fails, the poll still catches it within a minute. The fast path is an optimisation on
top of a correct baseline, not something the design depends on.

#### Reliability

**The cursor must lag.** Asking for everything updated since a saved timestamp will permanently
miss rows whose transaction commits after the cursor moved past their timestamp. Using an
auto-incrementing history ID has the same flaw, because those numbers are handed out before the
transaction commits. Neither is safe alone. The fix is to lag the cursor slightly behind real
time and de-duplicate.

**Both of Ship's rate limiters fail open.** On a cache outage the server-side ceiling disappears
entirely, so the agent cannot treat it as a safety net and must throttle itself.

#### The blocking dependency

**Ship's API has no way to ask what changed.** There is no "since this time" parameter anywhere.
The main document listing endpoint sorts by position and creation date, so recently-updated
documents never appear at the top. Paging is offset-only, and a source comment states that proper
cursor paging is a known gap. The few endpoints that sort by last-updated are fixed-purpose and
take no time filter.

An agent deployed separately cannot go around this — the production database sits in private
subnets reachable only from the application's own servers.

The decision is to **add a change-feed endpoint to Ship** rather than move the agent inside the
network, because keeping permission enforcement inside Ship's own API matters in a system carrying
federal performance ratings. The supporting index already exists, created by a migration that came
directly out of the Week 4 audit, which found seven route modules sorting by last-updated with no
index behind them.

#### How stale is too stale

| Work | Tolerance | Why |
|---|---|---|
| A mention reaching someone's list | Seconds | A person is waiting on them |
| An approval appearing as "you are blocking someone" | Minutes | Somebody's week cannot start |
| A standup draft | Ready before the person looks for it | Late is the same as absent |
| A retro draft | Ready when the week closes | The material is complete by then |
| Scope changed after approval | Hours | Decision-grade, not urgent |
| Cross-team blocker | Daily | Matches how often a director looks |

#### What this costs at 100 projects and at 1,000

Working from the real ratios in the current database — about 35 documents, 17 issues and 1.33
people per project — and these assumptions:

| Assumption | Value |
|---|---|
| Standup drafts per person per working day | 1 |
| Retro drafts per person per week | 1 |
| Inbox assemblies per person per working day | 1 |
| On-demand questions per person per working day | 2 |
| Working days per month | 22 |

The high-volume drafting work runs on the cheaper model; the reasoning tiers run on the more
capable one.

| Tier | Cost per project per month |
|---|---|
| Standup drafts | $0.61 |
| Inbox assembly | $0.43 |
| Retro drafts | $0.30 |
| Nightly cross-project pass | $0.80 |
| On-demand answers | $3.80 |
| **Total** | **$5.94** |

| Scale | People | Monthly cost |
|---|---|---|
| **100 projects** | About 133 | **Around $595** |
| **1,000 projects** | About 1,330 | **Around $5,940** |

**This is roughly a third more expensive than the detection design it replaces**, and that is the
correct trade. The old design was cheaper because it mostly declined to do anything.

Two things still stand out more than the totals.

**On-demand dominates at 64% of spend**, and it grew — following the graph outward costs more
input tokens than answering from one document. That is the price of the scoping correction and
it is worth paying.

**The rate limit runs out long before the budget does.** At 1,000 projects the bill is around
$5,940 a month while the agent is using about two thirds of the requests-per-minute allowance it
shares across all its users. The ceiling arrives around 2,000 people. This design runs out of
request headroom, not money.

The things that could blow the budget, worst first:

1. **Which model answers on-demand questions.** Moving that tier to the cheaper model takes the
   per-project cost from $5.94 to $4.42 — a 26% cut from one configuration change.
2. **How far on-demand expands the graph.** Following every edge from every document is unbounded.
   Relevance ranking with a hard cap on documents pulled in is what keeps this line finite.
3. **Drafting for people who never read the drafts.** If someone ignores their drafts for two
   weeks, stop generating them and let them ask. Trivial to implement, and it removes the single
   largest source of waste in the design.
4. **Running the nightly pass on projects with no activity.** About 40% more on that tier.

---

## Constraints carried forward

**Authentication does not expire for a background agent.** Ship's session timeouts — fifteen
minutes idle, twelve hours absolute — apply only to browser sessions. API tokens are handled first
and bypass that logic entirely; they are bounded only by their own expiry, which can be unset, and
by explicit revocation. A headless agent needs no re-authentication schedule.

**There is no service account.** Every API token belongs to a real user, so a background agent has
to run as somebody. The model chosen is per-user: the agent runs under each person's own token.
This matters more under the new framing than it did before — following the graph outward from the
current view means the agent will reach documents the user did not open, and running as them is
what makes that safe by construction. **It can reach anything you could reach, and nothing you
could not.**

**Private documents are currently hypothetical.** All 523 documents in the database are
workspace-visible and none are private. The risk is real in the schema and absent from the data.

**Network path.** Production traffic must go through the content delivery network; the load
balancer accepts nothing else.

**Do not point the test suite at the development database.** Running Ship's tests wipes whatever
database they are aimed at. This was a Week 4 audit finding and it still applies.
