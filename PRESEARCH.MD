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

## Phase 2: Graph Architecture

**A note on how this phase was written, stated plainly rather than left implicit.** Phase 1 above
was written before any of this existed — it settles the agent's responsibilities, its trigger model,
and the rules governing what it may do without a human, all reasoned from Ship's *existing* code,
never from a graph that hadn't been built yet. Phase 1 never names LangGraph, a `StateGraph`, or any
node, because none had been chosen on August 3. Everything below was written after
`agent/src/graph.ts` (1,889 lines — FG-2/FG-5/FG-6/FG-7/FG-17/FG-18/FG-19) was built, tested, and
merged, reading the compiled graph's own `.addNode`/`.addEdge`/`.addConditionalEdges` calls directly,
the same source-level verification FLEETGRAPH.MD's own "Graph Architecture" content already used.
Where a choice below was made *during* implementation rather than settled in Phase 1 — a different
thing from simply building what Phase 1 already decided — that is named in its own subsection rather
than folded into the rest as if it had always been the plan.

### 4. Node Design

#### What nodes make up the graph, and what does each one do?

Twenty-two nodes (`NODE_NAMES`, `graph.ts:857-880`), arranged into seven chains sharing one compiled
`StateGraph`:

| Chain | Trigger | Nodes | Calls the model? |
|---|---|---|---|
| Bare chat | `on_demand`, no seed | `ingest -> respond` | `respond` only |
| On-demand expansion | `on_demand`, seed present | `resolveSeed -> expandFrontier` (looping) `-> finalizeExpansion -> composeAnswer` | `composeAnswer` only |
| Proactive fast/steady | `proactive_fast` / `proactive_steady` | `pollChangeFeed -> resolveMentions -> detectBlockingApprovals -> commitInboxItems` | never |
| Deep (standup drafts) | `proactive_deep` | `gatherStandupActivity -> composeStandupDraft -> commitStandupDraft` | `composeStandupDraft`, skippable |
| Blocker escalation | `proactive_escalation` | `detectBlockerFanout -> composeBlockerEscalation -> commitBlockerEscalation` | `composeBlockerEscalation`, skippable |
| Retro drafting | `proactive_retro` | `gatherRetroActivity -> composeRetroDraft -> commitRetroDraft` | `composeRetroDraft`, skippable |
| Plan-change discrimination | `proactive_plan_change` | `detectPlanChange -> composePlanChangeDraft -> commitPlanChangeDraft` | `composePlanChangeDraft`, skippable — the one chain where the model's own verdict, not just a deterministic gate, decides whether anything is written |

Read directly off `graph.ts`'s own node/edge calls (`graph.ts:1238-1889`), cross-checked against the
module docstring's prose (`graph.ts:1-385`) rather than trusted from either alone — the two agree.
FLEETGRAPH.MD's "Graph Diagram" section (TRO-324/FG-13) performed the identical source-level
verification and reaches the same seven chains; this section restates it in prose because that is the
form this template's question asks for, not because it found a disagreement.

#### How does one compiled graph serve seven different triggers?

`routeTrigger` (`graph.ts:1188-1205`) is the single `addConditionalEdges(START, routeTrigger, {...})`
call (`graph.ts:1850`) every invocation passes through first. It reads `state.trigger`, and for
`on_demand` specifically, whether `state.seedDocumentId` is set (`graph.ts:1189-1191`) — that presence
check is what splits `on_demand` into the bare-chat and expansion paths, since `TriggerKind` itself
only has one `on_demand` value (`graph.ts:462-469`). Every other chain maps one `TriggerKind` value to
one `RouteKey` (`graph.ts:1170-1178`) directly, one-to-one.

#### Which node is the one place any given chain calls the model, and why is that boundary drawn there?

Six nodes call `model.invoke(...)`: `respond`, `composeAnswer`, `composeStandupDraft`,
`composeBlockerEscalation`, `composeRetroDraft`, `composePlanChangeDraft` — one per chain, always the
last node before that chain's own commit/end step, never the first. Every one of the six builds its
prompt entirely from state a prior, model-free node already gathered (`buildExpansionPrompt`,
`buildStandupPrompt`, `buildBlockerEscalationPrompt`, `buildRetroPrompt`, `buildPlanChangePrompt` —
`graph.ts`'s own imports, `graph.ts:391-419`) — the model is never the thing deciding *what* evidence
to look at, only how to phrase what a deterministic gather step already found. `AnthropicModel`
(`graph.ts:436-444`) is the one injected interface every one of the six calls through, which is what
lets every existing test substitute a plain object with no real API dependency (`graph.test.ts`'s own
docstring, quoted in FLEETGRAPH.MD's Cost Analysis: "every test for all three uses a stable fake
model, by design").

#### Where does execution path genuinely vary run to run, and where does it stay fixed?

`expandFrontier`'s self-loop (`routeExpansionLoop`, `graph.ts:1213-1215`, wired at `graph.ts:1867`) is
the only real conditional self-edge in the graph — it keeps visiting while `state.frontier.length >
0`, so a document-rich seed produces many `expandFrontier` visits before `documentCap` cuts it off,
and a sparse one exits after one or two. This is not asserted from reading the loop alone:
FLEETGRAPH.MD's Execution Traces section measured it — 9 real child spans for the bare-chat path, 47
for an expansion run that reached `documentCap=12`, 14 for the fixed four-node proactive chain
(FLEETGRAPH.MD:327-331) — three different real LangSmith trace shapes for three structurally
different chains, the proactive one fixed by construction (four plain `.addEdge` calls, no
conditional edge at all) and the expansion one genuinely variable.

#### What was decided during implementation rather than settled in Phase 1?

Three things, named plainly rather than left to look as if Phase 1 already knew them:

1. **The framework itself.** Phase 1 above never names LangGraph — it settles *what* the agent must
   do, not *how* it is built. `graph.ts`'s own module docstring records the choice: "Model provider:
   Anthropic API directly (`@langchain/anthropic`), confirmed by the maintainer 2026-08-03"
   (`graph.ts:69-73`) — decided when FG-2 started building, not something this document's own August 3
   reasoning had reached.
2. **Three of the seven chains got their own trigger, decided ticket by ticket, not planned as a
   set.** Phase 1's use cases 3 ("draft the retro"), 4 ("what changed since you approved"), and 5
   ("trace a blocker and route it") describe the same three problems in prose, but nothing in Phase 1
   says any would become its own `TriggerKind` with its own required field. Each did, and each
   ticket's own module-docstring section states its own reasoning rather than inheriting one from
   Phase 1: `proactive_retro`/`proactive_plan_change` (TRO-335/FG-17, TRO-336/FG-18) both exist
   because "the week ends" produces no row for a poller to observe (`graph.ts:259-269`, restated for
   plan-change at `graph.ts:326-331`) — the same "nothing writes a row when a week ends" fact Phase
   1's own Trigger Model section already names, now applied to a design decision Phase 1 never made;
   `proactive_escalation` (TRO-346/TRO-337/FG-19) exists because a new `blocks` association write
   touches no `documents.updated_at` and produces no `document_history` row either (`graph.ts:182-190`)
   — verified against the association route's own source while building FG-19, not derived from Phase
   1.
3. **The on-demand path's per-asker token model (TRO-342) replaced an earlier, less-safe
   implementation — it was not built this way from the start.** Phase 1's Constraints section (below)
   states the intent: "the agent runs under each person's own token... it can reach anything you could
   reach, and nothing you could not." FG-7's *first* implementation of on-demand expansion did not
   actually do this: `graph.ts`'s own docstring on `askingUserToken` says so directly — "before
   TRO-342, every on-demand run — regardless of who asked — shared the ONE `ShipClient` `index.ts`
   built from `SHIP_API_TOKEN` at process startup... Ship's own server-side 404 was never actually
   gated on the real asker, because the shared token could see everything" (`graph.ts:547-564`). The
   principle was right in Phase 1; the code did not match it until a later ticket found and closed the
   gap.

---

### 5. State Management

#### What state lives inside one graph invocation, and how is it organized?

All of it lives in `GraphState`, one `Annotation.Root` (`graph.ts:471-851`), grouped by the chain that
owns each field: shared fields every chain can touch (`trigger`, `cursor`, `changeFeedPage`, `people`,
`inboxItems`, `clearedItemIds`); on-demand expansion's own block (`seedDocumentId`, `askingUserId`,
`askingUserToken`, `frontier`, `visitedDocumentIds`, `expandedDocuments`, `citedSources`,
`expansionCapped`); the deep tier's own block (`targetPersonUserId`, `standupAnchor`,
`standupActivity`, `standupSkipReason`, `standupDraftText`, `standupProposedTransitions`); and one
further block each for blocker escalation, retro drafting, and plan-change discrimination, each with
its own `...SkipReason`/`...DraftText` pair. `weekId` is the one field two chains share on purpose —
`proactive_retro` and `proactive_plan_change` both mean the same thing by it, a `sprint` document's
id, and never run in the same invocation to collide over it (`graph.ts:741-751`).

Two reducer shapes do real work, not just bookkeeping: a **concatenating** reducer
(`(current, update) => [...current, ...update]`) on fields more than one node in the same run can
append to — `inboxItems`/`clearedItemIds` (`resolveMentions` and `detectBlockingApprovals` both
produce `inboxItems`, and `commitStandupDraft` is a third producer onto the same field —
`graph.ts:75-83`, `514-517`) and `visitedDocumentIds`/`expandedDocuments` (`expandFrontier`, called
repeatedly by its own self-loop). Every other field is **last-write-wins** (`update ?? current`),
because exactly one node ever produces it per run.

#### What carries across separate proactive runs, and where does it actually live?

Nothing in `GraphState` does — LangGraph resets every channel per invocation. The one piece of state
genuinely carried between one `proactive_steady` tick and the next is the lagged change-feed cursor,
held as a plain closure variable (`let cursor`, `agent/src/proactivePoll.ts:43`) inside
`createProactivePoller`, advanced only after a tick's `graph.invoke(...)` call resolves successfully
(`proactivePoll.ts:48-49`). A failed tick leaves `cursor` untouched (`proactivePoll.ts:50-52`), so the
next tick re-reads the same window instead of skipping past it — the concrete implementation of the
"self-correcting" polling property Phase 1's Trigger Model section already argued for in principle,
now a specific two-line `catch` block rather than a design intention.

#### Where do drafts and inbox items actually live, and what survives a restart?

Both `ItemStore` and `DraftStore` are in-memory, single-process stores — `itemStore.ts:1-33`'s own
docstring gives the reasoning: `agent/package.json` has no database dependency at all, one Render
process serves everything (no horizontal scaling configured, per FLEETGRAPH.MD's Deployment model
section), and every inbox item is re-derivable from Ship's own state on the next poll — a restart
costs at most one poll cycle's delay (≤60s), never a permanently lost item.

**That guarantee does not extend to drafts the same way, and this section says so rather than
implying otherwise.** A mention or blocking-approval item is recomputed fresh from
`change-feed`/`documents`/`team/people` every cycle — nothing agent-local to lose. A standup, retro,
plan-change, or blocker-escalation draft's *composed text* is different in kind: it is the model's
one-time output, held only in `DraftStore` (`draftStore.ts:1-27`'s own docstring: kept separate from
`ItemStore` specifically because a draft carries data — full prose, proposed transitions — nothing
else needs). A process restart with an unposted draft in `DraftStore` loses that draft's actual text;
the underlying activity that would let a *future* invocation compose a replacement is still
derivable, but the specific composition — including any edits a person may already be partway through
— is not recoverable. Nothing in this codebase currently closes that gap; it is a real, named
consequence of the in-memory choice, not a hidden one.

#### What state-management piece was planned and never built?

**Cross-request derived-content caching, keyed on document + content version.** FLEETGRAPH.MD's own
"State management" section names this as the third of three planned pieces and states plainly that it
"is not implemented; every run re-fetches what it needs" (FLEETGRAPH.MD:604-606) — the reasoning for
building it stands (ten people asking about the same week should read it once, not ten times), but
nothing in `graph.ts`, `expansion.ts`, or anywhere else in `agent/src` keys a cache off document id
plus content version today. Worth being precise about the honesty point here: this specific idea does
not appear anywhere in this document's own Phase 1 cost-cliff list above ("what this costs at 100
projects and at 1,000" names only the nightly-pass-on-idle-projects cliff) — it was identified later,
during the cost-analysis work that became FLEETGRAPH.MD's own cliffs list, not foreseen in this
document's original pass.

---

### 6. Human-in-the-Loop Design

#### Where is the one gate a human decision has to pass through?

`agent/src/gate.ts` (TRO-321/FG-8) — and, as important as what it is, what it is *not*: it is not a
node in the compiled `StateGraph` at all. It is a separate module, called later, once a person opens
a drafted item and decides (`gate.ts:1-13`'s own docstring). FLEETGRAPH.MD's Graph Diagram section
verified the same thing at the source level and drew the gate as an explicitly dashed, external box
for exactly this reason (FLEETGRAPH.MD:270-279): "nothing in `graph.ts` ever writes to Ship
(`DeepShipClientLike` and `OnDemandShipClientLike` are read-only interfaces by construction...
`DraftStore`/`ItemStore` are both entirely in-process."

#### What four operations does the gate expose, and what does each one write, or deliberately not write, to Ship?

| Function | Ship write | What it does instead |
|---|---|---|
| `acceptDraft` (`gate.ts:105-157`) | `POST /api/standups` then `PATCH` its content, attributed to the accepting person | Marks the draft `posted`, dismisses its inbox item, records the draft-survival measurement if a tracker is wired |
| `discardItem` (`gate.ts:178-196`) | None | Marks a draft-backed item's draft `dismissed`; dismisses the inbox item either way |
| `acceptProposedTransition` (`gate.ts:227-256`) | One `PATCH /api/issues/:id`, attributed to the accepting person, only field `'state'` — any other field fails loudly rather than guessing an endpoint | Records that one transition (by index) `accepted`, leaving sibling transitions on the same draft untouched |
| `rejectProposedTransition` (`gate.ts:264-272`) | None — does not even accept a token parameter | Records the transition `rejected`, terminal per `setProposedTransitionStatus`'s own contract, never later acceptable |

#### How does a human's identity, not the agent's, end up on the Ship write?

Every write-capable function above takes the acting person's own token as an explicit parameter —
never reads one from config or the environment (`gate.ts:15-21`). The type that makes this structural
rather than a convention is `GateShipClientLike` (`shipClient.ts`): it has no token field to fall back
to, so a write under the agent's own identity is not a bug a careless call site could introduce —
there is no code path in the package that could construct one. `agent/src/__tests__/
graphWriteBoundary.test.ts` is the regression proof that nothing upstream of this file ever reaches a
Ship write at all (cited by FLEETGRAPH.MD:111 for the identical claim).

#### What does the agent do without waiting for a human, and where exactly is that line drawn?

Unchanged from Phase 1's own rule, restated here because the template asks the question again in this
phase, not because implementation moved the line: "acts, when a query proves it... drafts, when a
model inferred it... never [writes a performance rating, sets an approval state, applies an issue
transition, creates or deletes a document, or writes anything that would read as though a person
wrote it]" (Phase 1, "What can it do without approval"). Implementation enforces the "never" list
structurally, not by convention: `DeepShipClientLike`/`OnDemandShipClientLike` (`shipClient.ts`)
expose no write method for any node in those chains to call even by mistake — restated at the end of
every one of the module docstring's five chain sections (`graph.ts:162-166`, `249-250`, `379-384`),
not asserted once and assumed to hold everywhere.

#### What closed this loop end-to-end, and what took longer to wire up than the gate logic itself?

**The gate logic existed, was unit-tested, and had zero callers for most of the sprint — a real gap,
not a hypothetical one, closed later by a separate ticket.** FG-8/TRO-321 built and tested
`acceptDraft` correctly in isolation. `CHANGES.md`'s TRO-348 entry records the exact discovery:
`grep -rn "acceptDraft" agent/src api/src web/src`, excluding tests, "found no caller anywhere" — no
HTTP route in `agent/src/server.ts`, no proxy route in `api/src/routes/agent.ts`, nothing. TRO-348 is
what added `POST /accept-draft` to both (`server.ts:393-451` on the agent side, mirrored in `api/`'s
own agent routes), and only then did `index.ts` construct a real `FileDraftSurvivalTracker` for
production use (`index.ts:199-203`) — a dependency `gate.ts`'s own docstring on
`draftSurvivalTracker` had already named as unbuilt ("nothing currently constructs the production
`FileDraftSurvivalTracker`... because nothing calls `acceptDraft` from a real route yet"). This is the
ticket's own worked example (TRO-360's brief names it directly) of a decision that happened *after*
the original design, not one Phase 1 or FG-8 foresaw in this shape — recorded that way rather than
folded silently into "the gate was built."

**Even with the HTTP wire closed, no browser page reaches it yet.** TRO-348's own `CHANGES.md` entry
found `InboxSidebar.tsx` renders a `standup_draft` item's action link to `/standup-draft/{draft.id}`,
but `web/src/main.tsx`'s routes have no match for that path — it falls through to `NotFoundPage`.
Drafts are reachable by direct HTTP call today, not yet by anyone using Ship's own UI. Named here as a
current, real state rather than smoothed into "the human-in-the-loop design is complete."

---

### 7. Error and Failure Handling

#### What must the agent do when Ship — or the model provider — is unreachable?

The graded bar, verbatim from the brief (quoted in TRO-315's own ticket text): "All outbound calls
from the agent (to Ship APIs, LLM providers, and any external tools) must implement explicit timeouts
and retry logic with exponential backoff. The agent must degrade gracefully if Ship is unreachable —
it should not crash or hang indefinitely." TRO-315's own status note records that the "demonstrated
live in the Architecture Defense" half of that requirement is no longer a scheduling constraint (the
defense already happened, confirmed by the maintainer 2026-08-03) — the engineering requirement
itself still stands and still gates FG-5/FG-6/FG-7.

#### What is the actual client-layer design, and what are the real numbers?

`agent/src/resilientClient.ts`'s `ResilientClient` wraps four concerns for every call it makes: an
explicit connect/read timeout via `AbortController` racing a timer (`timedFetch`,
`resilientClient.ts:226-261`, never an unbounded `fetch`); retry with exponential backoff and full
jitter on idempotent `GET` reads only (`get()`, `resilientClient.ts:168-200`; `request()` —
non-idempotent — gets timeout and the breaker but never a retry, `resilientClient.ts:202-213`); a
circuit breaker wrapping *each individual attempt*, not the whole retry sequence
(`resilientClient.ts:16-23`'s own design note: this is what makes "returns 503 → retries with growing
delays → opens the breaker" one coherent sequence rather than two); and self-throttling via an
injected `RateLimiter`, because — Phase 1's own finding, still true — "both of Ship's rate limiters
fail open" (Phase 1, "Reliability").

The production numbers, all from `config.ts` (`DEFAULT_*` constants, `config.ts:73-85`, each
independently overridable by env var):

| Knob | Default | Env var |
|---|---|---|
| Ship request timeout | 5,000ms | `SHIP_REQUEST_TIMEOUT_MS` |
| Breaker failure threshold | 5 consecutive failures | `SHIP_BREAKER_FAILURE_THRESHOLD` |
| Breaker cooldown | 30,000ms | `SHIP_BREAKER_COOLDOWN_MS` |
| Retry max attempts (GET only) | 3 (including the first) | `SHIP_RETRY_MAX_ATTEMPTS` |
| Self-throttle ceiling | 500 requests/minute | `SHIP_SELF_THROTTLE_RPM`, well under Ship's shared ~6,000/min per-IP ceiling (Phase 1's own cost-model finding) |
| Retry base delay | 200ms, doubling per attempt, capped at 16× base | `server.ts:102`'s `buildShipClient` |

The circuit breaker (`circuitBreaker.ts`) is a deliberate copy, not a reinvention, of
`api/src/utils/circuitBreaker.ts` (TRO-311/RULE-7) — copied specifically *because* that file's history
matters: its first version had a genuine half-open concurrency race (a second call arriving while a
trial call's `await fn()` was still in flight fell through the `state === 'open'` check and called
`fn()` itself, breaking the "exactly one trial call" invariant), fixed in `273f058` with an explicit
`else if (state === 'half-open') throw new CircuitOpenError()` guard (`circuitBreaker.ts:1-17`,
`89-93`). This agent's breaker starts from the fixed version, and TRO-315's own regression-proof list
carries the identical concurrent-half-open test forward (`__tests__/circuitBreaker.test.ts`).

#### What is the degradation contract when Ship stays down, concretely?

Every failure mode `ResilientClient.get()` can hit — 5xx, timeout, network error, or an already-open
breaker — normalizes to one thing: `ShipUnreachableError`, message `"I can't reach Ship right now."`
(`resilientClient.ts:77-85`), never a raw stack trace and never an unbounded hang. `/health`
(`server.ts:231-233`) always returns 200 — process-alive only, no dependency check, deliberately what
Render's own platform check points at. `/ready` (`health.ts:34-58`, `server.ts:235-247`) goes through
the same resilient client, so once the breaker has actually tripped, `/ready` fails **fast** rather
than paying out a full timeout+retry cycle on every poll — an explicit design property, not incidental
(`health.ts:1-11`'s own docstring). `proactivePoll.ts`'s `tick()` never lets a failure reach the
process boundary: every error is caught, forwarded to an optional `onError`, and the same cursor is
retried next interval (`proactivePoll.ts:45-53`) — a failed tick costs a delay, never a crash and
never a gap.

#### Where is the actual coverage gap, verified by reading the code rather than trusting the client's own header comment?

**`resilientClient.ts`'s own module docstring claims to be "a single outbound client layer used by
every call the agent makes — Ship API and the model provider both" (`resilientClient.ts:1-3`). That
claim does not hold in the real production wiring, and this section says so rather than repeating it
uncritically.** `agent/src/index.ts:162-166` constructs the model client directly —
`new ChatAnthropic({ apiKey, model: 'claude-haiku-4-5-20251001', maxTokens: 1024 })` — with no
`ResilientClient`, no `CircuitBreaker`, and no explicit timeout of its own; only the *Ship* client
(`buildShipClient(config)`, `index.ts:172`, feeding both the bound-token `ShipClient` and the
per-asker `onDemandShipClientFactory`) actually goes through `ResilientClient`. The only bound on a
hung model call in production is indirect: `server.ts`'s `/chat` handler races the *whole*
`graph.invoke(...)` call against `config.chatHandlerTimeoutMs` (25,000ms default,
`server.ts:313-325`) via an `AbortSignal` LangGraph itself honors — and `server.ts`'s own comment,
written by whoever added that timeout, is explicit about what it does *not* do: "neither
`AnthropicModel.invoke(input: string)`... nor any `ShipClientLike` method accepts or forwards a
signal, even though the underlying `ResilientClient.get`/`request` DOES support one... So when the
abort fires while a node's own `model.invoke()`... call is already in flight, THAT single call keeps
running to completion server-side (confirmed with a throwaway probe... the node's own awaited promise
settled ~3s after `invoke()` had already rejected)" (`server.ts:296-312`). Concretely: the *handler*
gives up and returns a 504 to its caller within the configured bound, but the in-flight Anthropic call
underneath it is not itself cancelled, retried, or breaker-protected — it is bounded only by whatever
default `@langchain/anthropic` ships with, which this codebase does not override. This is a real,
verifiable gap between what TRO-315's scope describes and what `index.ts` actually wires, not a
hypothetical one — stated here rather than papered over with prose that assumes the docstring's claim
is true.

---

## Phase 3: Stack and Deployment

### 8. Deployment Model

**This section summarizes; FLEETGRAPH.MD's own "Deployment model" section (its longest, most
frequently updated section, spanning several separate verification passes from 2026-08-04 through
2026-08-05) is the full operational record and is not reproduced here in full.** Every fact below
names where in that section the fuller account lives.

#### Where does this run, and why not the AWS stack Ship itself runs on?

**Ship-on-Render (`ship-rr6m.onrender.com`) + agent-on-Render (a Render docker web service,
`terraform/render/agent_service.tf`) + Render Postgres `ship-db` as the graded database** — the
brief's own recommended default, adopted without deviation because no AWS credentials have existed in
this environment all sprint (re-verified: no `aws` CLI, no `AWS_*` env vars — FLEETGRAPH.MD's
Deployment model section, "Settled (TRO-341/FG-23)").

#### Whose identity does the agent run under, and why is there no service account?

Unchanged from Phase 1's own Constraints section below: every API token belongs to a real user, so
the agent runs under each person's own token — restated in FLEETGRAPH.MD verbatim and, as Section 4
above documents, only actually implemented this way for the on-demand path once TRO-342 landed.

#### What is the promotion/rollback story, and what does each layer actually catch?

Two layers, neither a bespoke script (FLEETGRAPH.MD's "Rollback trigger and procedure"): **CI gates
merge** — a failing run never reaches `main`, so it never reaches Render's `auto_deploy` trigger
either; and **Render's own health-check-gated promotion** is a liveness net, not a readiness one —
`/health` returning 200 only proves the process is up, not that it can reach Ship or has its secrets.
`agent/src/deployReadiness.ts`'s `evaluateReadinessSamples` is the decision function TRO-322/FG-12
built to close that second gap: a *sustained* run of not-ready samples warrants a rollback; a single
transient failure that recovers does not. `agent/src/scripts/check-readiness-and-rollback.ts` is the
CLI — dry-run by default, `--execute` additionally re-triggers the last other `live` Render deploy.
Proven by local simulation (two real `index.ts` processes, one pointed at an unreachable Ship, one
reachable) rather than mocked, and explicitly **not wired to fire automatically** against the live
services — that decision is reserved for explicit human sign-off, same posture as every other
credential-bearing action in this project (FLEETGRAPH.MD, "TRO-322/FG-12 — both layers demonstrated").

#### What went wrong in practice, and what did closing it actually cost?

**Auto-deploy repeatedly did not fire on real merges, discovered by checking rather than trusting "CI
green and PR merged."** FLEETGRAPH.MD records this happening at least twice — once found the live
`ship` service six days stale despite two merged PRs, once again found four merges' worth of routes
(`/api/change-feed`, `/api/agent/inbox`, `/chat`, `/inbox`) 404ing on the graded deployment
(FLEETGRAPH.MD, "The gap recurred exactly as predicted, 2026-08-05"). Root cause is still not fully
diagnosed (`gh api .../hooks` returns `[]`, suggestive of a GitHub App integration rather than a
classic webhook, but not conclusive). The standing remediation — a direct
`POST .../v1/services/{id}/deploys` call — is documented as the operating procedure until the root
cause is found, not treated as fixed. A second, distinct gap surfaced *after* that remediation:
`AGENT_INTERNAL_SECRET` shipped in code before Terraform gained the corresponding variables, so the
newly-deployed routes 500'd with `internal_secret_not_configured` until the secret was set directly
via the Render REST API — `terraform apply` itself cannot update the free-tier agent service at all,
for any field, a verified provider bug (`ignore_changes` only suppresses the plan *diff*, not what the
provider's `Update` call sends). Recorded in full in FLEETGRAPH.MD's "Post-deploy verification" and
"Done, 2026-08-04" paragraphs — named here as the honest shape of what deployment actually cost, not
summarized away as "deployed successfully."

---

### 9. Performance

**Same posture as Section 8: FLEETGRAPH.MD's "Cost Analysis" section carries the full instrumented
ledger; this section states the headline numbers it already measured, with citations, rather than
re-deriving them.**

#### What does detection latency actually measure, and what did it come out to?

One real, timed run (`agent/src/scripts/trace-invoke-proactive.ts`, built for this measurement): a
real comment mentioning a real person, written to a real seeded Ship API, then polled with real
`proactive_steady` graph invocations (never a blind sleep) until the mention was genuinely present in
`ItemStore`. **Observed: 5,185ms**, event write to item present (FLEETGRAPH.MD:1044-1052). That number
is dominated by `change-feed.ts`'s own deliberate `CHANGE_FEED_LAG_MS = 5,000` safety margin, not by
agent processing (31ms for the final tick's own `graph.invoke()`) — the same "cursor must lag"
reliability point Phase 1's Trigger Model section already argued for in principle, now its first real
measured confirmation. The **derived** (not directly observed) worst-case bound for a running
60-second-cadence poller is ~60,031ms. A separate, CI-run E2E spec
(`e2e/agent-detection-latency.spec.ts`, TRO-322/FG-12) exercises the real public HTTP API instead of a
direct `graph.invoke()` call and observed **7,751ms** locally. Both are comfortably under the brief's
5-minute bar; both are stated at the confidence level FLEETGRAPH.MD actually earned for them — one
real number and one derived bound, never conflated.

#### What is the real, measured per-invocation cost so far, separate from the projection?

Instrumented via `agent/.cache/cost-ledger.jsonl` (TRO-339/FG-21) on every real `model.invoke()` call
across the three model-calling nodes that have ever actually run against the live Anthropic API.
Total real spend to date, all nodes: **$0.001922** across 3 invocations (FLEETGRAPH.MD:1003-1018) —
`respond` (bare chat) at $0.000218/run, `composeAnswer` (expansion) averaging $0.000852/run across
exactly two very different real runs (a 0-document mistaken invocation and a real 12-document,
cap-reached run). `composeStandupDraft` has **zero** real invocations — not a placeholder, a stated
fact: no scheduler exists anywhere in this package that decides whose standup window is open and
invokes the graph for them (`graph.ts:130-134`, restated in FLEETGRAPH.MD's Graph Diagram "Note 1").
The same is true of `composeBlockerEscalation`, `composeRetroDraft`, and `composePlanChangeDraft` —
real, tested, never yet invoked against the real API, for the identical reason: each chain's own
module-docstring section states plainly that no scheduler decides when it runs (`graph.ts:213-216`,
`266-269`, `328-331`).

#### What is the cost model at scale, and where does it break first?

FLEETGRAPH.MD's Production Cost Projections table: **~$450/month at 100 users, ~$4,470 at 1,000,
~$44,700 at 10,000** — about a third more than the detection design Phase 1 replaced, which was
cheaper mainly because it declined to do anything (FLEETGRAPH.MD:1094-1128; Phase 1's own equivalent
table above, produced before implementation, projected $595/$5,940 at 100/1,000 projects on different
unit assumptions — the two are not directly comparable line items, and this section does not pretend
they are). **On-demand answering dominates at 64% of spend**, because following the graph outward
costs more input tokens than answering from one document — the direct cost of treating the open
document as a starting point rather than a fence, the same correction Phase 1's own "What it reasons
about on demand" section argued for. **The request-rate ceiling arrives before the budget does**:
Ship's ~6,000 req/min per-source-IP limit starts binding around 2,000 users, while the bill is still
under $9,000/month (FLEETGRAPH.MD:1139-1143) — matching Phase 1's own finding under the older cost
model almost exactly.

#### What is the single biggest lever on cost, and has it been pulled?

FLEETGRAPH.MD's own cost model names it: **which model answers on-demand questions** — moving that
tier to the cheaper model is projected to cut per-user cost from $4.47 to $3.32, a 26% reduction
(FLEETGRAPH.MD:1147-1148), on the assumption that "high-volume drafting work runs on the cheaper
model; the reasoning tiers run on the more capable one" (FLEETGRAPH.MD:1118-1119, restated from this
document's own Phase 1 cost section above). **Checking the actual wiring changes the answer: there is
no two-tier setup to move away from.** `index.ts:162-166` constructs exactly one `ChatAnthropic`
instance — `model: 'claude-haiku-4-5-20251001'` — and passes that single object into `buildGraph` as
the one `model` every node in the graph shares (`graph.ts`'s own `buildGraph(model: AnthropicModel,
...)` signature takes one model for the whole graph, not one per chain). `respond`, `composeAnswer`
(the on-demand/reasoning tier the projection assumes is on a pricier model), and every
`compose*Draft` node all call the identical Haiku client. So the cost cliff, checked against the real
code rather than the projection's own assumption, is not "pull this lever to save 26%" — the
cheap-tier choice already applies everywhere, on-demand included, and the $4.47/$3.32 comparison in
FLEETGRAPH.MD describes a tiering design that has not been built. Stated precisely rather than
repeating the projection's framing unexamined: real production spend, to the extent the 3-invocation
ledger says anything at all, is more likely to track the *cheaper* end of both cost tables above than
either assumed.

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
