# FleetGraph

A project intelligence agent for Ship, the project management tool built by the U.S. Department
of the Treasury.

**Status:** Agent definition, graph architecture (FG-5/FG-6/FG-7/FG-8, `agent/src/graph.ts`),
execution traces, trigger model, deployment model, and the Architecture Decisions write-ups are
complete and written against the merged code (PRs #117, #120, #122) — every "settled" claim in
this document names the file that implements it. **The Test Cases table's trace-link column is now
filled (TRO-356, 2026-08-06)** — all six rows ran against a local, freshly-seeded
database, each with a real, public LangSmith trace link verified to resolve logged out. **All six
rows now match their Expected Output exactly** (TRO-364, 2026-08-07): row 2 was a partial match
for four days — its blocking-approval half could not fire because Ship's own approval routes never
logged the transition to `document_history` — fixed at the routes, re-fixtured, and re-traced; the
resolved finding (original kept as history) is in the Test Cases section. A timed live detection
test against the deployed site observed **42.6 seconds** event-to-inbox (bar: 5 minutes) — see
Grader Access. **Accuracy and trim pass (TRO-381 / TRO-351, 2026-08-09):** the Use Cases section's
own note wrongly said Use Case 5's agent side was unbuilt when the same document's Graph Diagram
section already documented it as implemented — corrected. The "four paths" claim in Architecture
Decisions and six stale `graph.ts` line citations around the Graph Diagram were re-verified against
current source and fixed; `graph.ts` citations in this document now name symbols instead of line
numbers, which drift. The Trigger Model table gained a note on why `proactive_escalation`/
`proactive_plan_change` don't fit its three cadence tiers. The Cost Analysis section's
Development-and-Testing-Costs subsection now leads with a clean, current four-row table instead of
a superseded 2026-08-05 snapshot. Architecture Decisions' Deployment-model subsection was
condensed — process narration and content duplicated with the Test Cases section's own
graded-database narrative were cut; no cited claim, required section, or defended design decision
was removed. See CHANGES.md for the full list.

Last updated: August 9, 2026

---

## Agent Responsibility

### What the agent is for

Ship asks people to write down what happened — standups, weekly plans, weekly retros, weekly
reviews, project retros. Its accountability engine computes ten kinds of missing paperwork,
deterministically, and chases people for it.

That engine works. It also cannot tell whether any of the paperwork is true. The content check
strips three known template headings and passes if a single non-whitespace character remains, so a
weekly plan whose entire body is the word "stuff" is fully compliant.

The obvious response is to grade the writing. We tried that framing and rejected it. An agent that
tells a federal employee their standup looks thin — on a document that feeds a performance rating
— is a surveillance tool aimed at the least powerful person in the room. It also solves the wrong
problem. **People write "stuff" because writing it properly is tedious and they are busy.**
Enforcement does not change that. Removing the tedium does.

> **Ship asks people to write down what happened. FleetGraph already knows — so it writes the
> first draft, and it tells you what needs you.**

The agent saves time and surfaces obligations. It does not audit compliance.

### What it monitors proactively

Ship has no event bus. "Events" means observed state changes, found by comparing each document's
last-updated timestamp against a saved cursor and reading the document history table where entries
exist.

| Event | How it is observed | What the agent does with it |
|---|---|---|
| An issue changes state | A history row on the state field | Material for a standup draft |
| An issue changes assignee | A history row on the assignee field | Someone's list changes |
| A comment is posted | A new comment row | Draft material; possibly a mention |
| A document body is edited | The last-updated timestamp moves | Draft material |
| Someone is mentioned | Walking the changed body for mention markers | Goes into that person's list |
| A plan or review approval flips | The approval status field changes | Unblocks someone, or starts a clock |
| A week crosses a boundary | Date arithmetic on the week number | Opens the retro drafting window |

**Nothing in Ship writes a row when a week ends.** There is no change to detect, which is why a
purely change-driven design is insufficient and the agent needs a scheduled pass as well.

### What it reasons about on demand

The document you have open **seeds** the question. It does not fence it.

This corrects an earlier draft that treated the current view as a boundary and had the agent
refuse to look further. The brief says the chat "uses that as the **starting point** for its
reasoning." A starting point and a boundary are different things.

**The boundary is what you are allowed to see. The view only decides where to start.**

From the open document the agent walks outward as far as the question requires — the project, the
week, the program, the issues and their history, the people and their other work, documents that
mention it and documents it mentions, and what changed recently in any of those.

**It names every document it pulled in and why.** That is the trust mechanism: the reach of an
answer is always visible, so following the graph never feels like the agent went wandering.

### What it does without approval, and what always needs a human

The gate is **where the fact came from**, not how large the write is. The important part is what
the agent produces when it is not certain.

**It acts, when a query proves it** — each of these is a structured lookup with no interpretation:

- Resolving mentions to people to user accounts, and assembling those into someone's list
- Linking a document to the issue or week it refers to, when the reference is unambiguous —
  **not yet built (verified TRO-370, 2026-08-08).** No implementation exists anywhere in
  `agent/src`: no write to `document_associations` on any code path, no such method on
  `ShipClient` (`shipClient.ts`'s write surface is exactly `postStandup`, `setStandupContent`,
  `applyIssueTransition`). The other three actions in this list are real and implemented outside
  `gate.ts` (`agent/src/graph.ts`'s write boundary, `graphWriteBoundary.test.ts`'s proof); this one
  is a described capability with no code behind it.
- Writing its own drafts and items, attributed to the agent
- Clearing its own item when the condition ends

**It drafts, when a model inferred it.** The second output mode is a draft the human edits and
posts. It never posts as the human, and never leaves an opinion the human is expected to act on.

**It never does these at all:**

- Writing a performance rating. These are federal performance ratings on the standard five-level
  scale. Not at any confidence, not for any reason.
- Setting an approval state, week status, or ownership.
- Applying an issue state transition. It may *propose* one with its evidence attached; a person
  accepts it.
- Creating, archiving, or deleting any document.
- Writing anything that would read as though a person wrote it.

> **Every output is either an action a query proved, or a draft a human confirms. The agent never
> has an opinion it expects you to act on.**

That rule is what structurally prevents the agent becoming a complaint generator.

Implemented in `agent/src/gate.ts` (TRO-321 / FG-8): every Ship write the gate can perform —
accept a draft, accept or reject a single proposed transition, discard — takes the acting person's
own token as an explicit parameter, and the gate's client type has no agent token to fall back to,
so a write under the agent's identity is impossible by construction rather than by convention.
Nothing upstream of the gate writes to Ship at all
(`agent/src/__tests__/graphWriteBoundary.test.ts` is the proof).

### Who it notifies, and when

Ship has no notification infrastructure at all — no notifications table, no email service, no push
mechanism. So the agent reaches people by writing into Ship itself.

The surface is **one list per person: what needs you.** Not a stream of individual pings.
Everything a person is on the hook for, assembled and ranked, presented when they arrive:

1. Mentions of them they have not seen
2. Approvals they are blocking — someone else's week cannot start
3. Work assigned to them that is waiting on something they control
4. Drafts the agent has prepared for them

Ranked by who else is blocked and for how long. Every item carries a direct action, not just a
description. Escalation to a manager exists but is last, and only after several periods with no
resolution — and because only half the people in the system have a manager recorded, that path
degrades gracefully when the link is absent. The agent never broadcasts to the workspace.

### Precision, and why the bar moved

A wrong draft costs a few seconds of editing, and the person was going to write the document
anyway. A wrong accusation, on a document feeding a performance review, costs trust permanently.

The earlier detection design optimised hard against the second and ended up doing almost nothing.
Changing the output format from criticism to draft removes most of that risk, which lets the
confidence bar come down, which lets the agent do considerably more. **The precision obsession was
downstream of a bad output format, not a fundamental constraint.**

The quality signal is also better than detection ever had: **how much of a draft survives to the
posted version.** A draft posted unedited was a good draft; one rewritten from scratch was not.
That is measurable in production with no labelling effort.

### How it knows who is on a project and what their role is

Ship keeps this in three places, and confusing them is the trap.

The workspace membership table has a role column, but it holds only "admin" or "member", and the
schema comment says in capitals that it is for authorization only. Using it to work out someone's
job is wrong.

Person documents hold the real data: a link to a user account, a link to a manager, and a free-text
job role. That job role is unreliable — free text with no fixed values, and in the current database
not one of the twenty people has it filled in.

Project membership lives in a separate associations table, alongside owner and assignee fields.

Roles are derived from structure, never read from a field — as a **design**:

| Role | How it is derived |
|---|---|
| Director | People reporting to them two or more levels deep; owns programs |
| Project manager | Owns projects or weeks; appears as approver on plans |
| Engineer | Has issues assigned; nobody reports to them |

**Not yet built (verified TRO-370, 2026-08-08): this table is a design, not a running taxonomy.**
`agent/src/roles.ts`'s own module docstring says so directly — "FLEETGRAPH.MD's Director/PM/Engineer
taxonomy is real but not needed by anything in this ticket's scope... left for whichever later FG
ticket routes an escalation or needs to tell a Director apart from a PM." What IS implemented and
real is narrower: `findManagerUserId`/`findManagerChain` (`roles.ts`) walk `reports_to` one hop or
to the root — enough to answer "who has authority to unblock this plan approval" and "who is the
lowest manager over everyone currently blocked" (TRO-337's escalation routing), never enough to
answer "is this person a Director." No code anywhere in `agent/src` computes "reports to them two or
more levels deep" or "owns projects or weeks" to label someone with one of these three roles.

---

## Graph Diagram

**Done (TRO-324 / FG-13, 2026-08-05).** Every node, edge and conditional below was read directly
off the compiled `StateGraph` in `agent/src/graph.ts` — its `.addNode`/`.addEdge`/
`.addConditionalEdges` calls, not the design brief. That source-level verification covers the whole
diagram, including the `proactive_deep` chain. Trace-level verification is narrower: only the bare
on-demand chat, on-demand expansion, and proactive fast/steady chains are additionally cross-checked
against the real LangSmith traces in the "Execution Traces" section immediately below, which show the
same node sequences actually executing for those three paths. The `proactive_deep` chain
(`gatherStandupActivity -> composeStandupDraft -> commitStandupDraft`) is verified against source
only, the same as the rest of the diagram — no real, publicly-linked trace for it appears in the
"Execution Traces" section below. That is no longer because the node has never really run: the cost
ledger (this file's Cost Analysis section) records one real `composeStandupDraft` invocation,
timestamped 2026-08-07 — this section's own prior "still has zero real invocations" claim was stale
and is corrected as of TRO-366 (2026-08-08); see the Cost Analysis section for the fix. That
invocation's trace was never captured into this document, which is the actual reason no trace
appears below. Separately, and still true: no scheduler exists to trigger `proactive_deep` for a
real person on any ongoing basis — one recorded invocation is not a scheduler. Where the diagram
disagrees with the summary bullets that used to stand in this section's place, that disagreement is
called out explicitly rather than smoothed over — see the two notes after the diagram.

**Updated (TRO-349, 2026-08-05).** Three chains were missing from the diagram above:
`proactive_escalation` (`detectBlockerFanout -> composeBlockerEscalation ->
commitBlockerEscalation`, TRO-346/TRO-337 / FG-19), `proactive_retro` (`gatherRetroActivity ->
composeRetroDraft -> commitRetroDraft`, TRO-335 / FG-17), and `proactive_plan_change`
(`detectPlanChange -> composePlanChangeDraft -> commitPlanChangeDraft`, TRO-336 / FG-18) — all three
already implemented in `graph.ts` (`buildGraph`'s `.addNode`/`.addEdge`/`.addConditionalEdges` calls
and the `routeTrigger`/`RouteKey` switch) but never added to this section. Added here the same way
as the rest of the diagram — read directly off that source, not the design brief. Same
source-only-verification posture as `proactive_deep`: `graph.ts`'s own module docstring states, for
each of the three, that "there is deliberately no scheduler in this file (or anywhere in this
package)" that decides when they run, so — same reasoning as `proactive_deep` above — no real
LangSmith trace exists for any of the three yet either.

```mermaid
flowchart TD
    START(["START"])
    RT{"routeTrigger<br/>state.trigger + seedDocumentId presence"}
    START --> RT

    RT -->|"on_demand,<br/>no seedDocumentId"| ingest["ingest<br/>trim input — no model, no Ship call"]
    ingest --> respond["respond 🤖<br/>model.invoke(input)"]
    respond --> ENDchat(["END<br/>output: chat answer"])

    RT -->|"on_demand,<br/>seedDocumentId set"| resolveSeed["resolveSeed<br/>visit seed doc, build initial frontier"]
    resolveSeed --> expandFrontier["expandFrontier<br/>pop highest-ranked candidate,<br/>visit it, discover more, re-rank"]
    expandFrontier -->|"routeExpansionLoop:<br/>frontier non-empty AND cap not reached"| expandFrontier
    expandFrontier -->|"routeExpansionLoop:<br/>frontier empty OR documentCap reached"| finalizeExpansion["finalizeExpansion<br/>build citedSources — no model"]
    finalizeExpansion --> composeAnswer["composeAnswer 🤖<br/>model.invoke(expansion prompt)<br/>+ capNoticeText() if capped"]
    composeAnswer --> ENDanswer(["END<br/>output: answer + citedSources"])

    RT -->|"proactive_fast OR proactive_steady<br/>— same chain, two poll cadences"| pollChangeFeed["pollChangeFeed<br/>GET change-feed + people — no model"]
    pollChangeFeed --> resolveMentions["resolveMentions<br/>literal @Name + TipTap mentions — no model"]
    resolveMentions --> detectBlockingApprovals["detectBlockingApprovals<br/>plan/review approval field — no model"]
    detectBlockingApprovals --> commitInboxItems["commitInboxItems<br/>ItemStore.upsert / .clear"]
    commitInboxItems --> ENDinbox(["END<br/>ItemStore updated"])

    RT -->|"proactive_deep<br/>requires targetPersonUserId"| gatherStandupActivity["gatherStandupActivity<br/>anchor + moved/commented/stale;<br/>checks shouldGenerateDraftFor FIRST"]
    gatherStandupActivity --> composeStandupDraft["composeStandupDraft 🤖*<br/>*model call SKIPPED in-node when<br/>standupSkipReason is set — note 2 below"]
    composeStandupDraft --> commitStandupDraft["commitStandupDraft<br/>DraftStore.upsert + ItemStore.upsert;<br/>no-op if skipped or no draft text"]
    commitStandupDraft --> ENDdraft(["END<br/>DraftStore + ItemStore updated"])

    RT -->|"proactive_escalation<br/>requires blockingIssueId"| detectBlockerFanout["detectBlockerFanout<br/>gather impact fan-out;<br/>gates on projects/people/reporting line — no model"]
    detectBlockerFanout --> composeBlockerEscalation["composeBlockerEscalation 🤖*<br/>*model call SKIPPED in-node when<br/>blockerEscalationSkipReason is set"]
    composeBlockerEscalation --> commitBlockerEscalation["commitBlockerEscalation<br/>DraftStore.upsert + ItemStore.upsert;<br/>no-op if skipped or no recipient"]
    commitBlockerEscalation --> ENDescalation(["END<br/>DraftStore + ItemStore updated"])

    RT -->|"proactive_retro<br/>requires weekId"| gatherRetroActivity["gatherRetroActivity<br/>week's success criteria + closed issues;<br/>gates on criteria/owner/dates — no model"]
    gatherRetroActivity --> composeRetroDraft["composeRetroDraft 🤖*<br/>*model call SKIPPED in-node when<br/>retroSkipReason is set"]
    composeRetroDraft --> commitRetroDraft["commitRetroDraft<br/>DraftStore.upsert + ItemStore.upsert;<br/>no-op if skipped or no draft text"]
    commitRetroDraft --> ENDretro(["END<br/>DraftStore + ItemStore updated"])

    RT -->|"proactive_plan_change<br/>requires weekId"| detectPlanChange["detectPlanChange<br/>reads Ship's OWN changed_since_approved flag;<br/>gates on approver/diff source/whitespace-only — no model"]
    detectPlanChange --> composePlanChangeDraft["composePlanChangeDraft 🤖*<br/>*model call SKIPPED in-node when<br/>planChangeSkipReason already set;<br/>MATERIAL/NOT MATERIAL verdict can<br/>ALSO set it after the call"]
    composePlanChangeDraft --> commitPlanChangeDraft["commitPlanChangeDraft<br/>DraftStore.upsert + ItemStore.upsert;<br/>no-op if skipped or no draft text"]
    commitPlanChangeDraft --> ENDplanchange(["END<br/>DraftStore + ItemStore updated"])

    ENDinbox -.->|"item sits in ItemStore<br/>until a human acts"| GATE
    ENDdraft -.->|"draft sits in DraftStore/ItemStore<br/>until a human decides"| GATE[["Human-in-the-loop gate<br/>gate.ts — FG-8 / TRO-321<br/>NOT a node in this StateGraph"]]
    ENDescalation -.->|"draft sits in DraftStore/ItemStore<br/>until a human decides"| GATE
    ENDretro -.->|"draft sits in DraftStore/ItemStore<br/>until a human decides"| GATE
    ENDplanchange -.->|"draft sits in DraftStore/ItemStore<br/>until a human decides"| GATE
    GATE -->|"acceptDraft / acceptProposedTransition<br/>accepting person's OWN token"| WRITE[("real Ship write")]
    GATE -->|"discardItem / rejectProposedTransition"| NOWRITE["no Ship write"]

    classDef modelCall fill:#fef3c7,stroke:#d97706,stroke-width:2px;
    classDef external fill:#e5e7eb,stroke:#6b7280,stroke-width:2px,stroke-dasharray:5 5;
    class respond,composeAnswer,composeStandupDraft,composeBlockerEscalation,composeRetroDraft,composePlanChangeDraft modelCall;
    class GATE,WRITE,NOWRITE external;
```

**The four constraints, verified against the diagram above, node by node:**

- **Both modes run through the same graph; only the entry trigger differs.** True, and it is exactly
  `routeTrigger` above — one `addConditionalEdges(START, routeTrigger, {...})` call in `graph.ts`,
  reading `state.trigger` (and, for `on_demand`, whether `seedDocumentId` is set) to pick one of
  eight `RouteKey` values (seven distinct destination chains — `proactive_fast`/`proactive_steady`
  share one; see "Node design rationale" below). Confirmed against `routeTrigger`'s own source in
  `graph.ts` (the function of that name — this document cites symbols, not line numbers, for
  `graph.ts`; see the note under "Node design rationale" for why), not inferred.
- **The on-demand path expands outward with a hard cap, and that loop is the main source of
  genuinely different execution paths between runs.** True, and it is `expandFrontier`'s real
  self-edge (the `addConditionalEdges('expandFrontier', routeExpansionLoop, {...})` call in
  `graph.ts`) — a document-rich seed loops many times before the cap or an empty frontier
  exits it; a sparse one exits after one or two hops. The "Execution Traces" section below shows this
  concretely: a real run against a seed with project/sprint/program/assignee associations produced 47
  child spans (many `expandFrontier` visits, cap reached at 12 documents) against 9 for the bare
  on-demand chat path with no seed.
- **One human-in-the-loop gate.** True, but it is not a node in this `StateGraph` at all — `gate.ts`
  (FG-8 / TRO-321) is a separate module, called later, under the ACCEPTING PERSON'S OWN token, once
  they open a drafted item and decide. Nothing in `graph.ts` ever writes to Ship (`DeepShipClientLike`
  and `OnDemandShipClientLike` are read-only interfaces by construction — see `graph.ts`'s own module
  docstring); `DraftStore`/`ItemStore` are both entirely in-process. The diagram shows this as an
  external, dashed box specifically so it is not mistaken for part of the graph's own topology. Note
  that the two `on_demand` paths (`ENDchat`/`ENDanswer`) do NOT route through this gate at all —
  `respond`/`composeAnswer` return their output directly as the synchronous `/chat` response; there is
  no stored draft to later accept or discard for a chat answer, only for standup drafts and proposed
  transitions (the `proactive_deep` path) and inbox items (`proactive_fast`/`proactive_steady`).
- **The proactive path composes drafts once per person per window, not once per change.** True as a
  DESIGN COMMITMENT, but — see Note 1 below — this is **not currently a branch in the compiled
  graph** the way the other three constraints are. Read on.

**Note 1 — "is a window open" is not a graph branch today; it is an unbuilt external
scheduler's job.** The old text in this section (now replaced) said the graph "branches on 'is a
window open for this person'." Read against `graph.ts` directly, that branch does not exist anywhere
in the compiled graph: there is no node or conditional edge anywhere in `buildGraph` that asks
"has this person's standup window opened yet." The `proactive_deep` trigger requires a
`targetPersonUserId` to already be known and passed in (`requireTargetPersonUserId` in `graph.ts`)
— WHO gets a draft composed, and WHEN, is entirely the responsibility of a
caller this graph does not contain. The module's own docstring says so directly:
*"There is deliberately no scheduler in this file (or anywhere in this package) that decides WHOSE
window is open and invokes the graph for them."* The thing that DOES live inside the graph and is
easy to mistake for the same idea is `shouldGenerateDraftFor` (checked first thing inside
`gatherStandupActivity`'s own node body in `graph.ts`) — but that is a different question: "has this person been
ignoring their last several drafts long enough that composing another one is waste" (cost cliff #3),
evaluated only AFTER the graph has already been invoked for them. It is not "is it currently their
window." Both are real, correct design commitments; only one of them is implemented as graph
structure as of this ticket. This is exactly the kind of prose/code gap this repo's provenance rules
exist to catch — recorded here rather than quietly reworded away.

**Note 2 — the deep-tier "skip if ignored" behavior is an in-node data branch, not a StateGraph
conditional edge.** Contrast this directly with `expandFrontier`'s self-loop, which IS a real
`addConditionalEdges` call. `gatherStandupActivity -> composeStandupDraft -> commitStandupDraft` is
three plain `.addEdge` calls in `graph.ts`'s `buildGraph` — `composeStandupDraft` always runs as a graph
node, every single time, regardless of `standupSkipReason`. The skip is a plain `if
(state.standupSkipReason) { return {}; }` inside that node's own function body in `graph.ts`,
never calling `model.invoke` on that path. A LangSmith trace of a skipped run
would show `composeStandupDraft` as a real, present, near-instant span with no model child run
underneath it — structurally different from `expandFrontier`'s self-loop, where the NUMBER of
`expandFrontier` spans in a trace varies run to run. The diagram marks this with a footnoted 🤖\* on
the node rather than drawing a second decision diamond that does not correspond to a real edge in
the code.

---

## Execution Traces

**Done (TRO-324 / FG-13, 2026-08-05).** Three real LangSmith traces, produced in this worktree
against the real Anthropic API (for the two on-demand traces) and the real local Ship API (all
three), captured via the LangSmith API (`GET /runs/{id}` and `POST /runs/query`) the same way FG-21
verified its own trace — never eyeballed from the console. All three sit in the same
`fleetgraph-agent` LangSmith project (`c1e38b67-b458-4e8b-a680-be74ece5e1a6`) FG-21 already used, so
they are directly comparable. Every trace link in this section is a public LangSmith share link —
no login or org membership required to open it.

| Path | Trigger | Trace | Child spans | Real cost |
|---|---|---|---|---|
| Bare on-demand chat (`ingest -> respond`, FG-2) | `on_demand`, no seed | [45c12238](https://smith.langchain.com/public/53ee51bf-7f86-4ed5-bef2-3b0ecf9d596e/r/45c12238-df88-4c11-bd67-1ee27edc0736) | 9 | $0.000218 (FG-21's own trace, reused here — not re-run) |
| On-demand expansion (`resolveSeed -> expandFrontier` ×9 `-> finalizeExpansion -> composeAnswer`, FG-7) | `on_demand`, real seed document (`96ed3528-…`, an issue with project/sprint/program associations) | [5e9d072b](https://smith.langchain.com/public/592b4f32-3c11-43ed-9abc-640c3f8257ee/r/5e9d072b-0559-41ff-bbba-3fa4df218142) | 47 | $0.00101 |
| Proactive deterministic (`pollChangeFeed -> resolveMentions -> detectBlockingApprovals -> commitInboxItems`, FG-5) | `proactive_steady`, real change-feed cursor | [88b0880a](https://smith.langchain.com/public/8e698e3a-d0a4-47ba-97ee-de0098c5660d/r/88b0880a-f4dd-4ac6-b496-1ae66235377a) | 14 | $0 (no model call anywhere on this path — verified: LangSmith itself reports `total_tokens: 0` for this run) |

**What genuinely differs between these three, verified via `GET /runs/{id}`'s own
`child_run_ids`/`inputs`/`total_tokens` fields, not asserted:**

- **Node names.** The proactive trace's `POST /runs/query?trace=<id>` child list is exactly
  `pollChangeFeed -> resolveMentions -> detectBlockingApprovals -> commitInboxItems` (plus LangGraph's
  own internal `ChannelWrite`/`Branch` bookkeeping spans) — no `respond`, `composeAnswer`, or
  `composeStandupDraft` node anywhere in it, confirming "no model" for this tier is true at the trace
  level, not just in the source comment.
- **Span count as a direct, observable proxy for the expansion loop's real variability.** 9 spans
  (bare chat) vs. 47 spans (expansion, `documentCap=12` reached) vs. 14 spans (proactive, fixed
  4-node chain) — three different real numbers for three genuinely different graph shapes, not one
  execution path relabeled three ways.
- **`inputs.seedDocumentId`/`inputs.trigger`, read back from LangSmith itself.** The expansion
  trace's own recorded input shows `seedDocumentId: "96ed3528-c565-4c53-ad67-e157ecc60a8a"` and
  `trigger: "on_demand"`; the proactive trace's shows `trigger: "proactive_steady"`,
  `cursor: "2026-08-05T01:14:00.840Z"` — the actual arguments each run was invoked with, not
  reconstructed after the fact.

**How they were produced.** `pnpm --filter @ship/agent trace:invoke-on-demand -- 96ed3528-c565-4c53-ad67-e157ecc60a8a "What is going on with this issue, and what week and project is it part of?"`
against this worktree's own local `pnpm --filter @ship/api dev` (port 3884, this worktree's own
seeded database `ship_wt_tro_331` — never the graded Render deployment) produced the expansion
trace. The proactive trace needed a new script — no equivalent to `trace-invoke.ts`/
`trace-invoke-on-demand.ts` existed for FG-5's deterministic path before this ticket — so this ticket
adds `agent/src/scripts/trace-invoke-proactive.ts` (`pnpm --filter @ship/agent trace:invoke-proactive`),
covered in full in the Cost Analysis section's detection-latency writeup below, since the same run
that produced this trace also produced this ticket's real detection-latency measurement.

**One real cost incurred by a genuine mistake, disclosed rather than hidden.** While first invoking
`trace-invoke-on-demand.ts` directly via `pnpm exec tsx ... -- <args>` (bypassing the package.json
script alias), a literal `"--"` was passed through as the script's own `seedDocumentId` argument
instead of being consumed as a separator — `pnpm --filter @ship/agent trace:invoke-on-demand -- <args>`
(via the package script) strips it; `pnpm exec tsx <script> -- <args>` (invoked directly) does not.
The result was one real, unintended `on_demand_expand` invocation against an invalid seed id — real
tokens spent (94 in / 120 out, $0.000694), real trace produced
([9b24aa47](https://smith.langchain.com/public/ee2db601-70a1-474b-bbe2-603395438bfa/r/9b24aa47-4260-4e0d-9b99-639b1806fc11), `documentsPulled: 0`,
`resolveSeed` failed to fetch the malformed id and correctly produced a "no accessible document"
answer rather than fabricating one). Not used as either of the two required comparison traces above
— reported here because it is real spend a reader of the cost ledger will otherwise not be able to
account for, and because pretending it did not happen is exactly the kind of smoothing-over this
repo's provenance rules exist to prevent.

---

## Use Cases

Every one either saves time or removes a lookup. None grade anybody.

| # | Role | Trigger | Agent detects / produces | Human decides |
|---|---|---|---|---|
| 1 | Engineer | The standup window opens on a working day for someone with assigned issues in an active week | A draft standup assembled from what actually happened — issues that changed state, comments written, documents edited, blockers hit. Where nothing moved, it says so and names what has been sitting | Edit and post, or discard. Accept or reject any proposed issue state changes individually |
| 2 | Anyone | The person opens Ship, or opens the panel | One ranked list: mentions they have not seen, approvals they are blocking, work waiting on them, drafts prepared for them — each with why it matters and a direct action | What to act on, and in what order |
| 3 | Engineer or PM | The retro window opens for a week whose plan carries at least one success criterion | The delivered section pre-filled from issues that actually closed, mapped against each criterion, with unmatched criteria called out so they can be explained rather than quietly dropped | Edit, add unplanned work the agent cannot see, submit |
| 4 | Director | A weekly plan is edited after it was approved | What materially changed, before and after side by side, plus a drafted re-approval request or a drafted question to the author | Re-approve, or send the question |
| 5 | Director or PM | An issue blocks work in two or more projects whose blocked people sit in different reporting lines | The full impact, the lowest manager with authority over everyone blocked, and a drafted message to them | Send it, or step in directly |
| 6 | Anyone | The person opens the chat panel anywhere in Ship | An answer seeded by the open document and expanded along whatever the question requires, naming every document pulled in and why | What to do about it |

**Notes**

**Use case 1 absorbs what used to be a separate "your standup is thin" detection.** The drift
signal still gets delivered — it is just delivered as help. Removing that detection as a
standalone use case was a deliberate decision: it was the only case where the agent criticised a
person directly, on a document feeding a performance rating, and it is the notification users mute
first.

**Use case 2 replaces per-mention notifications.** An earlier design pinged on each mention event.
That is dribble. What a person wants on arrival is everything that needs them, in one place,
ranked — an inbox, not a stream.

**Use cases 1 and 2 need no language model for their hardest parts.** Mention resolution and
approval-blocking are structured lookups. The model composes prose and ranks; the floor underneath
it is deterministic.

**Use case 5 has shipped on both sides (corrected TRO-381, 2026-08-09 — this note previously said
the agent side was unbuilt; that was false and had been since 2026-08-05).** When this was first
written, Ship could not express "issue A blocks issue B" at all, and no agent code touched the
case. Ship-side: migration `041_add_blocks_relationship.sql` (FG-15 / TRO-333) added `blocks` to
`relationship_type`, migration 040 rejects circular association chains, and PR #120 added the
blocks/blocked-by sidebar (TRO-334). Agent-side: the `proactive_escalation` chain —
`detectBlockerFanout → composeBlockerEscalation → commitBlockerEscalation` — implements the impact
fan-out, lowest-common-manager resolution, and drafted message (TRO-346/TRO-337 / FG-19, commit
`a600a12`, 2026-08-05); the Graph Diagram section above already documents this same chain as
implemented, which is what made the old claim here self-contradictory within one document. Test
Cases row 5 below exercises it against a real trace. What genuinely remains open: no scheduler
invokes `proactive_escalation` automatically for a real fan-out as it occurs — the same
not-yet-built gap the Trigger Model section documents for `proactive_deep`/`proactive_retro`/
`proactive_plan_change`.

---

## Trigger Model

### The decision: hybrid, with polling as the backbone

| Tier | How often | What it does | Latency |
|---|---|---|---|
| **Fast** | The moment a document is saved | Mentions and assignment changes land in the affected person's list. No model. | ~3 seconds |
| **Steady** | Every 60 seconds | Collect what changed; hold the material each person's next draft will be built from | ~80 seconds |
| **Deep** | Per person, before their window opens | Compose the drafts — standups in the morning, retros at week end | Scheduled |

**`proactive_escalation` and `proactive_plan_change` don't get a fourth row here, and that is a
scoping decision, not an omission (TRO-351).** This table's tiers are organised by CADENCE — how
often something runs, whether a fixed poll interval or a per-person window. `proactive_retro`
already fits the Deep row as written ("retros at week end" names it, even though — like
`proactive_deep` — nothing schedules it yet). `proactive_escalation` (fires when an issue's blocker
fan-out crosses two-or-more-projects-and-different-reporting-lines) and `proactive_plan_change`
(fires when an already-approved plan is edited) are a different shape: event-CONDITION triggers,
not cadence triggers. Neither has a "window" to schedule against the way Deep's per-person morning
window does, and neither runs on any interval today — both are reachable only by invoking the graph
directly with the matching trigger (see `agent/src/scripts/trace-invoke-escalation.ts`/
`trace-invoke-plan-change.ts`, and `graph.ts`'s own module docstring, which states the "no scheduler
in this file" fact for all four non-poll triggers, not just `proactive_deep`). Forcing either into a
fourth cadence row would misstate what actually decides when they run today: nothing does, on any
schedule.

The steady tier used to be where the model ran, once per suspicious change. Under drafting it
mostly **accumulates material**, and the model runs once per person per window instead. That is
cheaper per unit of value and produces better output — a standup written from a whole day of
activity beats six separate observations.

The five-minute detection requirement binds only on the fast tier, which is deterministic and runs
in about three seconds.

**Implementation status (2026-08-04):** the steady tier is live — `agent/src/index.ts` starts the
poll loop at `DEFAULT_PROACTIVE_POLL_INTERVAL_MS = 60_000` (`config.ts`), and each tick runs the
deterministic `pollChangeFeed → resolveMentions → detectBlockingApprovals → commitInboxItems`
chain, which is the traced proactive run in the Execution Traces section. The graph also accepts
`proactive_fast` through the same chain, but the Ship-side in-process save hook that would trigger
it is not built yet — today "fast" is simply this poll at whatever cadence it is configured to. The
deep tier's composition path (`proactive_deep`) is implemented and tested end-to-end, but nothing
yet schedules it per person — `index.ts`'s own module comment states there is no scheduler in the
package that decides whose standup window is open.

Polling works as the backbone because Ship's collaborative editor saves on a two-second delay and
always stamps the last-updated time when it does, making that timestamp a complete signal for
every content change. The document history table is only partial by comparison — it records field
changes broadly but body text only for weekly plans and retros.

### The tradeoffs

| | Polling only | Webhooks only | Hybrid (chosen) |
|---|---|---|---|
| Changes needed in Ship | One read endpoint | Emission code in 2+ places | One read endpoint plus one in-process hook |
| Coverage | Complete | Only where emission was added | Complete |
| Missed events | Self-correcting — next tick re-reads | Permanent. A dropped delivery is gone | Polling backstops the fast path |
| Week boundaries | Detected — the schedule is the trigger | Never fires. Nothing changes when a week ends | Detected |
| Mention reaching a list | Up to 60 seconds | ~1 second | ~3 seconds |
| Cost when idle | One indexed query returning nothing | Nothing | One indexed query returning nothing |
| Coupling to Ship's uptime | None | Ship's save path waits on your endpoint | None — the hook is fire-and-forget |
| Testability | Replay a time range | Must simulate emission | Both |

**Webhooks alone fail for two verified reasons.** Ship has no outbound webhook mechanism and no
database notification channel, so emission would need adding both to the REST write path and to the
collaborative editor's save path — and missing the second blinds the agent to the document edits
its drafts are built from. And a week ending produces no change at all, so there is nothing to
hook.

**Polling alone is genuinely viable** and was the runner-up, costing up to 60 seconds before a
mention reaches someone's list. The hybrid buys that back for the price of one hook, and if the
hook fails the poll still catches it within a minute. **The fast path is an optimisation on top of
a correct baseline, not something the design depends on.**

### Reliability

**The cursor must lag.** Asking for everything updated since a saved timestamp permanently misses
rows whose transaction commits after the cursor moved past their timestamp. An auto-incrementing
history ID has the same flaw — those numbers are handed out before commit. The fix is to lag the
cursor behind real time and de-duplicate. **Implemented, on both sides:** the endpoint holds back
rows newer than a safe cutoff (`CHANGE_FEED_LAG_MS = 5_000` in `change-feed.ts`), and the agent's
poll loop (`agent/src/proactivePoll.ts`) advances its cursor only after a successful tick, so a
failed poll re-reads the same window instead of skipping past it.

**Both of Ship's rate limiters fail open.** On a cache outage the server-side ceiling disappears
entirely, so the agent cannot treat it as a safety net and must throttle itself.

### The blocking dependency (resolved — the change-feed shipped)

**When this was written, Ship's API had no way to ask what changed.** No "since this time"
parameter existed anywhere; the main document listing endpoint sorts by position and creation
date, so recently-updated documents never surfaced; paging is offset-only. An agent deployed
separately could not go around it — the production database sits in private subnets reachable
only from the application's own servers.

The decision was to **add a change-feed endpoint to Ship** rather than move the agent inside the
network, because keeping permission enforcement inside Ship's own API matters in a system carrying
federal performance ratings. That endpoint now exists: `GET /api/change-feed`
(`api/src/routes/change-feed.ts`, FG-1 / TRO-312, mounted in `app.ts`), backed by the
last-updated index that came directly out of the Week 4 audit. It is the poll source the traced
proactive run above actually used — the graph's `pollChangeFeed` node is a thin wrapper around it.

---

## Grader Access

Working credentials for the deployed site, verified by a real login against this exact deployment
on 2026-08-07. (Deliberately published: the grading brief requires working credentials, this
deployment is a graded test environment, and every account holds only synthetic seed data — the
same password `seed.ts` has always printed. Nothing here grants access to anything real.)

| Field | Value |
|---|---|
| URL | `https://ship-rr6m.onrender.com` |
| Email | `alice.chen@ship.local` |
| Password | `admin123` |

Every seeded user shares the password `admin123` (`api/src/db/seed.ts` — printed at seed time).
`alice.chen@ship.local` is the account worth grading from: Test Case 2's ranked inbox items are
addressed to her. `dev@ship.local` (same password) is the root admin when a sees-everything view
is needed. Two operational notes: sessions idle out after 15 minutes (12 hours absolute) — a
logged-out state mid-review means log in again, not breakage; and chat requires an open document
by design (the empty-state callout in the panel says so explicitly — a standalone chatbot is
exactly what this agent is not).

### Timed live detection test (deployed site, 2026-08-07)

The grading requirement: an event introduced into Ship must surface within five minutes. Run
against this exact deployment (graded `ship` + `ship-agent` as deployed 2026-08-06, `af573d3`),
observed, not derived:

- **T0 = 2026-08-07T14:50:13.130Z** — a real comment mentioning `@Iris Nguyen` written through
  the real API (`POST /api/documents/65f499b2-…/comments` → HTTP 201, as `dev@ship.local`).
- **T1 = 2026-08-07T14:50:55.759Z** — the mention item observed in Iris's own ranked inbox via
  session-authed `GET /api/agent/inbox` — the same endpoint the UI's `useInboxQuery.ts` renders —
  carrying `evidence.commentId` equal to the exact comment id written at T0.
- **Observed: 42.6 seconds** end-to-end (bar: 300s), polling as the recipient every 10s.
  Consistent with the architecture's derived bound: up-to-60s steady-tier tick + 5s change-feed
  lag + poll granularity. A second probe the same hour landed at ~16s (the item's own `createdAt`
  minus its comment's write timestamp) — same mechanism, luckier phase alignment with the tick.

Reproduce it: log in (credentials above), comment `@Full Name` of any seeded person on any issue,
then open that person's inbox (their login, same password) — the item appears on the next tick.

---

## Test Cases

**The graph these cases exercise is built and merged** — PR #117 (proactive detection, on-demand
expansion, standup drafts, the gate), PR #120 (the UI surfaces), and PR #129 (TRO-346/FG-19, the
blocker-escalation fan-out walk Test Case 5 needs). Three real traces (bare on-demand chat,
on-demand expansion, and `proactive_steady`) already existed in the Execution Traces section above
before this section's own column was filled; four of the graph's seven `TriggerKind` values
(`proactive_deep`, `proactive_escalation`, `proactive_retro`, `proactive_plan_change`) had never
been traced anywhere in this document until this ticket.

**Done (TRO-356, 2026-08-06).** All six rows below now have a real, public LangSmith trace link,
produced against **this worktree's own local database** (`pnpm db:seed` against `.factory-env`'s
`DATABASE_URL`, never the graded `ship-db` — that is TRO-357/TRO-358's separate scope) and this
worktree's own local API (`pnpm dev:api`, port from `.factory-env`). Rows 1, 3, and 4 exercise the
deep-tier draft-composition triggers (`proactive_deep`, `proactive_retro`, `proactive_plan_change`)
— none of which had a trace-link script or a public trace anywhere in this document before this
ticket; `agent/src/scripts/trace-invoke-{deep,retro,plan-change}.ts` are new, matching the existing
`trace-invoke-proactive.ts`/`trace-invoke-on-demand.ts` pattern. Row 5 uses a new
`trace-invoke-escalation.ts`, same pattern, for the `proactive_escalation` trigger TRO-346 built.
Every trace was verified to resolve **logged out** — not just the page shell (a client-rendered SPA
that returns an identical 200 shell for a fabricated share token too, verified directly and NOT
trustworthy alone), but the backing `GET /api/v1/public/{share_token}/run` LangSmith API, checked
against a real vs. a fabricated token to confirm it actually discriminates (200 with the real run's
own inputs/token-count/child-run-count vs. 404).

**Row 2 was a partial match for four days — fixed 2026-08-07; the original finding is kept below
as history.** The mention-detection half was always real and traced: two `@Alice Chen` mentions
from the FG-3 seed fixture surface correctly. The blocking-approval half did not, and this was a
verified Ship-side gap, not a fixture problem or an agent bug: `agent/src/proactive.ts`'s
`buildBlockingApprovalItems` only ever creates a NEW
blocking item from a `document_history` row whose `field` is `plan_approval`/`review_approval` and
whose `new_value.state` is neither `'approved'` nor absent. Reading every `logDocumentChange(...,
'plan_approval', ...)` / `logDocumentChange(..., 'review_approval', ...)` call site in
`api/src/routes/weeks.ts` (`/approve-plan`, `/unapprove-plan`, `/approve-review`) showed every one of
them writes `state: 'approved'` or `null` — the exact two values `buildBlockingApprovalItems`
treats as *resolving* an item, never creating one. `/request-plan-changes` and
`/request-retro-changes` — the routes that actually PUT a week into a blocked state — updated
`properties.plan_approval`/`review_approval` directly and never called `logDocumentChange` for that
field at all. (Worse, found while fixing: `PATCH /api/weeks/:id/plan` set
`state: 'changed_since_approved'` in properties without logging it either — so *neither* of the
detector's creating branches had a real producer.) So no document_history row recording entry into
a blocked state existed anywhere in
this codebase's real write paths — confirmed empirically too: polling `proactive_steady` over a
6-day window against the FG-3 fixture's own blocked week returned the 2 real mentions and zero
`plan_approval`/`review_approval` history entries (`changeFeedPage.history` inspected directly).
The fixture's own direct-`UPDATE` construction (seed.ts's TC2 block) was not the cause — it would
fail the identical way even if built entirely through Ship's own approval-workflow API.

**The fix (2026-08-07, branch `troysatchell/tc2-blocking-approval-history`).** Two halves, both
required:

1. **Ship now logs every approval transition to `document_history`.** Three write sites in
   `api/src/routes/weeks.ts`: `request-plan-changes` and `request-retro-changes` log their
   `changes_requested` entry (owner-routed: "revise and resubmit"), and `PATCH /api/weeks/:id/plan`
   logs the `approved → changed_since_approved` transition (approver-routed: "waiting on your plan
   approval"). Covered by three red-before-green route tests in `api/src/routes/weeks.test.ts`
   ("approval transitions reach document_history") — all three failed with zero history rows before
   the fix, and the full api suite (832 tests) passes with it.
2. **The TC2 fixture was re-modeled and moved out of the seed's `fg3Baseline` gate**
   (`api/src/db/seed.ts`). Re-modeled as approved-then-edited — Alice approved Emma's plan, Emma
   revised it, so the week waits on Alice's *re-approval* (`changed_since_approved`) — because the
   detector routes `changes_requested` to the OWNER, meaning the old fixture state would have put
   the item in Emma's inbox, not Alice's, even after fix #1; the documented expected output
   requires the approver to hold it. Moved outside the gate (with the transition row itself as the
   idempotency marker) because the graded database's `document_history` is no longer empty, which
   skips the whole gated block on a re-seed.

Re-run against a fresh scratch database (`ship_tc2fix_test`, seeded from scratch, blocked week
`2b343bef-7ac0-45c7-b9d3-01e51238b9dc` "Week 16"), one process, shared in-memory stores:
`proactive_deep` for Alice (her waiting standup draft), then `proactive_steady` over a 6-day
window. Alice's ranked list came back exactly as documented — **4 items, blocking approval first**
(`blocking_approval`, `mention`, `mention`, `standup_draft`) — and the steady run's public trace is
row 2's link below, verified logged-out the same two ways as every other row (public page AND
`GET /api/v1/public/{share_token}/run`: 200 with the run's own 14 child runs for the real token,
404 for a fabricated one).

**Graded-database fixture status — all four resolved (TRO-357, 2026-08-06).** The gap below was
closed by re-running the (by then repaired) seed against the graded database — history kept, not
rewritten:

**Original run (TRO-341/FG-23, 2026-08-04) — seeded, with two real gaps found, not hidden.**
`pnpm db:seed` ran against the graded `ship-db` (external connection, temporary IP allowlist, reset
immediately after). Pre-seed sanity check: 257 documents / 11 users / 0 `document_history` rows,
matching the documented 2026-07-28 snapshot exactly — confirming this database's existing rows
really were produced by this same seed script, the precondition the seeding plan itself named.
Post-seed: Test Cases 2 and 4 fixtures created successfully; Test Case 3's fixture ran but produced
0 closed issues, not the 3 its own row requires; Test Case 1's fixture did not fire at all. Both
gaps traced to the same root cause — the old fixture logic *selected* pre-existing issues from
whatever sprint resolved as "current" *today*, and issue-to-sprint assignments (frozen at the
2026-07-28 base-data creation) had drifted out of alignment with it six days later. Recorded, not
fixed in that pass: its scope was seeding and environment, not redesigning the fixture's
sprint-selection logic.

**Fix (TRO-345, PR #130, merged to `main` 2026-08-05).** `api/src/db/seed.ts` reworked so Test
Cases 1 and 3 **create** their own Ship Core issues directly in the current sprint, each behind its
own idempotency marker (`properties->>'fg3_fixture' = 'tc1'`/`'tc3'`) independent of the block-wide
`document_history`-non-empty gate — so a repaired seed run can create these rows against a database
where Test Cases 2/4 (and that gate) had already fired, without disturbing them. Code only; the
re-seed itself (item 2 of that ticket's scope) was deliberately held for sign-off.

**Re-seed (TRO-357, 2026-08-06) — gap closed, both fixtures now fire.** Temporary IP allowlist
opened to a single `/32`, pre-seed check (375 documents / 11 users / 1 workspace /
1 `document_history` row — grown from the 2026-08-04 snapshot by organic activity against the live
graded deployment in the intervening 9 days, not a wrong-database signal: the workspace/user counts
and every known TC2/TC4 document id below matched exactly before proceeding), `pnpm db:migrate`
(no-op, already current), `pnpm db:seed` (additive — printed `✅ Test Case 1 fixture` and
`✅ Test Case 3 fixture` by name, then the `📋 FG-3 test case document ids` block below), allowlist
reset to `[]` and reset confirmed via a follow-up `GET`. Post-seed: documents 375 → 382 (+7: TC1's
3 issues + 1 standup, TC3's 3 issues), `document_history` 1 → 2 (TC1's one state-change row),
`fg3_fixture='tc1'`/`'tc3'` issue counts 0 → 3 / 0 → 3. Directly queried and confirmed: engineer
Emma Johnson now has exactly 3 non-done TC1 issues (`in_review`, `in_progress`, `todo`, the last
untouched for 7 days); the TC3 week carries all 4 success criteria with exactly 3 `done` issues
completed inside the current week window. TC2/TC4's ids (table below) still resolve to the same
document type and title as the 2026-08-04 run — unchanged.

Document ids that resolve, against the graded `ship-db` (not this worktree's local scratch
database):

| Fixture | Document id |
|---|---|
| Test Case 1 — standup anchor | `85676a52-d676-429c-8d76-9c74b1bbdb8a` |
| Test Case 1 — moved to in_review | `cfc40bfe-4a77-48e3-938a-46412695f331` |
| Test Case 1 — commented | `6e0ad162-7255-42ab-bd89-8250304913bf` |
| Test Case 1 — stale (7 days untouched) | `e252bd46-b1e8-4f14-9bb5-2aa174e3f3df` |
| Test Case 2 — mention 1 | `65f499b2-8e8c-417c-8372-f60ff4ba8c75` |
| Test Case 2 — mention 2 | `a8a08536-d4ef-44a9-a9c1-12d1efe39dc4` |
| Test Case 2 — blocked week | `e5adadd7-e574-4f6b-9893-3da2261cf463` |
| Test Case 3 — week (3 issues closed within it, 4 success criteria) | `c8dfb32e-5b08-47d4-8150-af7728543ac4` |
| Test Case 3 — closed issues | `71eb8b0e-bcdb-4463-9e78-ce1a88cf2361`, `5f593b41-8668-4077-90cd-d4b99b4df79d`, `343d850f-dc9c-4c83-8f15-7f752cb9813d` |
| Test Case 4 — week (approved then edited) | `0e44bc95-6ee9-4aa7-a6c0-41205bf87e85` |

**This worktree's own local fixture, TC1/TC3 now self-fixturing (TRO-345, PR #130).** Unlike the
graded-db pass above, Test Cases 1 and 3 no longer depend on pre-existing issues happening to land
in whatever sprint resolves as "current" — `api/src/db/seed.ts` now CREATES the 3 issues/week each
needs directly, so both fired cleanly on a fresh `pnpm db:seed` run today:

| Fixture | Document id |
|---|---|
| Test Case 1 — engineer (Emma Johnson, user id) | `7646949b-f39f-46f9-a007-2ce8b8137a74` |
| Test Case 1 — moved to in_review | `afcb0603-46bf-43f1-a6b7-3f9d676a2d4d` |
| Test Case 1 — commented | `69af9e2b-9044-410d-a476-760fbef33846` |
| Test Case 1 — stale (no activity in 7 days) | `aa68b12f-a448-4bbf-a6d6-33407569827f` |
| Test Case 2 — mention 1 | `8a7fd8fd-85b8-4dd9-bdd2-8ca4e8e79264` |
| Test Case 2 — mention 2 | `ecf703b4-13d8-4855-aaa0-ed6ab42fe34b` |
| Test Case 2 — blocked week (re-modeled approved-then-edited 2026-08-07, see the resolved finding above; the 2026-08-07 trace ran on a fresh scratch database where this week seeded as `2b343bef-7ac0-45c7-b9d3-01e51238b9dc`) | `e96f2f49-b28e-481b-bdd8-47dcfda1a1c9` |
| Test Case 3 — week | `aa161243-041c-499e-872c-26545a4cb6ef` |
| Test Case 4 — week (approved then edited) | `7754bd4f-d940-4a6c-ac82-c72204f14d28` |
| Test Case 5 — blocking issue (`blocks` associations added live, via the real API, not the seed) | `9e69830f-6568-4828-b9cf-e13acb279f63` |
| Test Case 6 — seed issue (`blocks` + a week comment added live, via the real API) | `969262e7-7ad5-4804-9136-7502869280f5` |

Test Case 5's fixture is not in `seed.ts` — no `blocks`-relationship fixture existed there before
this ticket (verified: grepped the file). Constructed via two real `POST
/api/documents/:id/associations` calls against pre-existing base-seed issues in different projects,
assigned to people in genuinely different reporting lines (Grace Lee, reports to Bob Martinez;
Henry Patel, reports to Carol Williams — both ultimately Dev User, confirmed via `GET
/api/team/people`). Test Case 6's fixture is likewise constructed live: a new blocking issue plus a
real comment on the seed issue's own week, via the real API — not a raw SQL insert.

| # | Ship State | Expected Output | Trace Link |
|---|---|---|---|
| 1 | An engineer with 3 assigned issues; since their last standup, one moved to in review, they commented on another, and the third has not moved in 6 days | A draft standup naming the two that moved and what changed, flagging the third as sitting for 6 days, with a proposed state change on the one in review | [8acb9a96](https://smith.langchain.com/public/3605ce55-784b-40ba-971a-08570648a07e/r/8acb9a96-25a3-4d52-9f26-f0306a1a0711) — matches: draft names both the moved and commented issues, flags the third's 7 days of inactivity, and carries one proposed transition (in_progress → in_review) |
| 2 | A person mentioned in two documents they do not own, blocking one approval on someone else's week, with a standup draft waiting | A four-item ranked list, approval first because another person's week cannot start, each item carrying a direct action | [37526a99](https://smith.langchain.com/public/e5029c32-16e2-4957-82e7-b53a99b1a9dc/r/37526a99-acae-43a1-89a3-e256b22ab700) — **matches (2026-08-07, after the fix above)**: four-item ranked list for Alice — blocking approval first ("Week 16" waiting on her re-approval), both mentions, then her standup draft. The earlier partial-match trace ([75c74a0b](https://smith.langchain.com/public/dc7c8673-25e9-423b-b526-3a53db2b160a/r/75c74a0b-f2bf-4b75-a134-c9d20ca51bb3)) is kept for the record |
| 3 | A week whose plan lists 4 success criteria; 3 issues closed during the week, mapping to 2 of them | A delivered section pre-filled from the 3 closed issues, mapped to their criteria, with the 2 unmatched criteria called out | [6910e85c](https://smith.langchain.com/public/1b01b5a2-3dd1-496b-b8f2-f064394bf058/r/6910e85c-5d26-47d2-9582-8096b1672ea8) — matches: 3 closed issues mapped to criteria 1–2, criteria 3–4 explicitly called out as undelivered |
| 4 | A weekly plan approved at version N, then edited to remove one success criterion | A before-and-after on the removed criterion plus a drafted question to the author, routed to the approver | [c6d75795](https://smith.langchain.com/public/3dfdbb29-6a5c-4365-89b4-a3a3f318c1a5/r/c6d75795-caa8-42b4-bf79-49ee5c1ca172) — matches: model verdict MATERIAL, drafted question correctly names the removed criterion (CSRF protection) |
| 5 | An issue in Project A blocking two issues in Project B whose assignees report to different managers | The impact fan-out, the lowest common manager, and a drafted message | [8ab81ab8](https://smith.langchain.com/public/9d46d5e1-6ceb-4575-ae9d-c6a504893aea/r/8ab81ab8-7b80-4b88-83fd-072ed65ad537) — matches: 2 blocked issues across 2 projects, lowest common manager found (Dev User), drafted escalation message |
| 6 | A user opens the chat on an issue and asks why it is stalled; the answer requires its week, its blocking issue, and a comment on a different document | An answer drawing on all four documents, each named with the reason it was pulled in | [2d251e49](https://smith.langchain.com/public/287ae116-652f-4421-afaf-c16e769c75ed/r/2d251e49-7245-40f8-b04f-f783208f7af3) — matches: answer cites the seed issue, its blocking issue, and its week (via the week's own comment), each with the reason it was pulled in |

**How these were produced and verified.** `pnpm db:seed` against this worktree's own
`.factory-env`-derived `DATABASE_URL`, then `pnpm dev:api` (this worktree's own port), then
`agent/.env.local` (untracked, gitignored) staged with `SHIP_API_BASE_URL` pointed at that port and
a real per-user `SHIP_API_TOKEN`. Rows 1/3/4/5 each used a new one-off script
(`agent/src/scripts/trace-invoke-{deep,retro,plan-change,escalation}.ts`, matching
`trace-invoke-proactive.ts`'s existing pattern — real model calls, deliberately not covered by
`pnpm test`); row 2 (2026-08-07 re-run, after the fix) used a one-process investigation script (uncommitted,
same posture as the original's): `proactive_deep` for Alice, then
`graph.invoke({ trigger: 'proactive_steady', cursor })` over a 6-day window against the same
in-memory stores — one process because `itemStore`/`draftStore` are deliberately in-memory, so the
standup-draft item and the steady tick's items can only meet in one `ItemStore`, whose ranked
`list()` output is the four-item claim; row 6 used the
existing `trace-invoke-on-demand.ts`. Every link was verified to
resolve **logged out** two ways: the page itself (200, matches the byte-identical shell of an
already-known-good previously-published link) AND — the real check, since the page shell alone
returns 200 for a fabricated share token too — `GET
https://api.smith.langchain.com/api/v1/public/{share_token}/run` with no auth header, confirmed to
return the real run's own `inputs`/`total_tokens`/`child_run_ids` for a genuine token and `404` for
a fabricated one.

**A real credential-exposure risk found and fixed while producing row 6.** The `on_demand` trigger's
graph state carries `askingUserToken` (added by TRO-342, after TRO-324's two on-demand traces above
were captured) — and LangSmith's public run API returns a shared run's full recorded `inputs`
verbatim, including that field, to anyone with the link, no login required. A first attempt at row
6's trace was shared before this was noticed, briefly exposing a real, live Ship API token (scoped
only to this worktree's own local database, not reachable from outside this machine). Caught by
diffing the public API response against what should never appear there, not assumed safe by
analogy to the older traces. Recovered by revoking that token immediately (verified dead: `401`
after) and deleting the LangSmith share (`DELETE .../share`, verified `404` after). Row 6's actual
link above was produced with a single-use token minted specifically for that one invocation and
revoked (via the session cookie, not the token itself) immediately after the graph call returned and
before the run was ever shared — the token embedded in the public trace is real but already dead.
**Follow-up worth its own ticket, not fixed here (out of this ticket's file scope):**
`trace-invoke.ts`/`trace-invoke-on-demand.ts` should stop passing a live token into traced graph
state at all (a scoped, already-expired token, or LangSmith input redaction, or excluding that field
from what gets traced) — the exposure risk is structural to the script, not specific to this run.

**Most of these have no reachable trigger state today.** The development database is a load-testing
fixture built to a Week 4 specification, and it records none of the activity these drafts are built
from: the document history table is empty, comments are empty, issue start and completion
timestamps are unset on all 254 issues including all 71 marked done, and plan approval state is
unset on all 35 weeks. The code that writes all of this exists and runs in normal use, so this is
fixture work rather than a research problem — and the brief explicitly asks for "the Ship state
that should trigger the agent," which makes constructing them part of the assignment.

---

## Architecture Decisions

### Framework

**Settled — LangGraph.** `@langchain/langgraph` is a real dependency of `agent/package.json`, and
the whole agent is one `StateGraph` over a typed `Annotation.Root` state in `agent/src/graph.ts`.
The traces in the Execution Traces section landed in LangSmith through LangGraph's native
instrumentation — no manual instrumentation was needed, which is exactly why the brief
recommended it.

### Node design rationale

**Settled — implemented in `agent/src/graph.ts`.** One compiled graph serves every mode.
`routeTrigger` reads `state.trigger` (plus `seedDocumentId` presence, for `on_demand`) into eight
`RouteKey` values that resolve to **seven distinct chains** — `proactive_fast` and
`proactive_steady` share one destination chain, the other six each have their own:

1. Bare chat (`ingest → respond`)
2. Seeded expansion (`resolveSeed → expandFrontier`, a conditional self-loop that runs until the
   frontier empties or `documentCap` is hit, then `finalizeExpansion → composeAnswer`)
3. The deterministic proactive chain, both cadences
   (`pollChangeFeed → resolveMentions → detectBlockingApprovals → commitInboxItems`, no model call
   on the whole path)
4. The deep tier (`gatherStandupActivity → composeStandupDraft → commitStandupDraft`)
5. Blocker escalation (`detectBlockerFanout → composeBlockerEscalation → commitBlockerEscalation`,
   TRO-346/TRO-337 / FG-19)
6. Retro drafting (`gatherRetroActivity → composeRetroDraft → commitRetroDraft`, TRO-335 / FG-17)
7. Plan-change detection (`detectPlanChange → composePlanChangeDraft → commitPlanChangeDraft`,
   TRO-336 / FG-18)

**Corrected TRO-351, 2026-08-09** — this section previously said "four paths," which was the count
before the three drafting chains above (5–7) were added; the surrounding sentence was never
rewritten when they landed, only the diagram was (TRO-349). Both principles this section fixed in
advance survived implementation regardless of the count: accumulation and composition run on
different clocks (the proactive chain commits material to the item store; each drafting chain
composes per person or per week), and the expansion loop is the main source of run-to-run path
difference — observed directly as 9 vs 47 vs 14 child spans across the three traces above.

**On citing `graph.ts` by line number, and why this document mostly stopped doing it (TRO-351).**
Every specific line citation into `graph.ts` in this document went stale at least once, and the
drift compounds fast: `routeTrigger` alone was cited at `graph.ts:617-628` when this section was
first written (2026-08-04, confirmed via `git log -S`), had already drifted to ~`1188-1205` by the
time TRO-351 was filed the very next day (2026-08-05 — three drafting chains, FG-17/18/19, landed
in between), and sits at a third number, 1277, as of this fix (2026-08-09) — roughly 660
line-numbers of total drift in five days, with no mechanism forcing every citing sentence to move in
lockstep. A file that grows this fast makes a bare line number a claim with a short shelf life.
Citations into `graph.ts`
in this document now name the function/node **symbol** instead (`routeTrigger`, `expandFrontier`,
`requireTargetPersonUserId`, `shouldGenerateDraftFor`) — grep-able, and true regardless of how many
lines get inserted above it. Citations into smaller, slower-moving files (`api/src/app.ts`,
migration files) keep their line numbers, since those are cheap to re-verify and were found accurate
when checked for this pass.

### State management

**Mostly settled — one of the three planned requirements is deliberately not built yet.** Within a
run, all state lives in the graph's typed channels (`GraphState` in `graph.ts`); the expansion
loop's `visitedDocumentIds` channel is what stops it re-reading a document it already pulled.
Between proactive runs the carried state is exactly the lagged change-feed cursor, held in memory
by `proactivePoll.ts` and advanced only on success. Per-person accumulated material lives in
in-memory stores (`itemStore.ts`, `draftStore.ts`) by explicit, documented decision — see
`itemStore.ts`'s header: one agent process, and every item is re-derivable from Ship's own state
on the next poll, so a restart costs at most one 60-second cycle, not lost data. The third planned
piece — a cross-request cache keyed on document + content version, so ten people asking about the
same week do not each re-read it — is **not implemented**; every run re-fetches what it needs. The
cache-key reasoning stands for whenever load makes it worth building.

### Deployment model

**Settled (TRO-341 / FG-23).** Topology: **Ship-on-Render (`https://ship-rr6m.onrender.com`) +
agent-on-Render (`https://ship-agent-t0zy.onrender.com`, current URL — see the redeploy note below,
it changes on every clean-machine `apply`) + the Render Postgres `ship-db`
(`dpg-d9kgth6417fc7386hhh0-a`) as the graded database.** This is the ticket's own recommended
default, adopted without deviation: no AWS credentials have existed in this environment all sprint
(re-verified this ticket: no `aws` CLI, no `AWS_*` env vars), so the AWS stack was never a live
option to weigh against it.

**Authentication does not expire.** Ship's session timeouts — fifteen minutes idle, twelve hours
absolute — apply only to browser sessions. API tokens are handled first and bypass that logic;
they are bounded only by their own expiry, which can be unset, and by explicit revocation. A
headless agent needs no re-authentication schedule.

**There is no service account, but which token backs a call depends on the tier** (corrected TRO-370,
2026-08-08 — the claim below held unqualified until TRO-342 split the tiers, and this section never
caught up). **On-demand** (`respond`/`composeAnswer`) uses a fresh, per-request token bound to the
ASKING person specifically (TRO-342, `index.ts`'s `onDemandShipClientFactory`) — following the graph
outward from the open document means reaching documents the person did not open, and running as them
is what makes THIS tier safe by construction: **it can reach anything they could reach, and nothing
they could not.** **Proactive (fast/steady) and deep** — mention resolution, blocking-approval
detection, and every draft-composing trigger (standup, retro, plan-change, escalation) — run under
ONE shared token instead, by explicit design: none of those triggers has a single per-invocation
asking person to source a per-call token from (`ProactiveDeps`/`DeepDeps`'s own docstrings in
`graph.ts`; `index.ts:182-189` builds this one shared `shipClient` and passes it to both). That
token currently belongs to a real seeded super-admin account, not a synthetic identity
(`dev@ship.local` — see "On the choice of identity" below), so "no service account" still holds in
that narrower sense — but a proactive draft about Alice's own standup is read and written under the
admin token's own visibility and permissions, not Alice's.

**Private documents are currently hypothetical.** All 523 documents are workspace-visible and none
are private. The risk is real in the schema and absent from the data. That count is the local
development database's; the graded `ship-db` is a **separate, smaller** dataset — 257 documents as
of its last verified snapshot (`memory-bank/techContext.md`, 2026-07-28) — and does not
automatically track a local worktree's seed. Closing that gap for the Test Case fixtures
specifically is this ticket's seeding-plan section below.

**Network path.** Production traffic must go through the content delivery network; the load
balancer accepts nothing else.

**Terraform, `/health` + `/ready`: done, including `apply` (TRO-313, TRO-315, TRO-316).** `agent/`
is a Render docker web service (`terraform/render/agent_service.tf`), deployed in the same Render
root as `ship` itself — target platform is Render, not AWS, per the standing no-AWS-credentials
fact above. `terraform apply` and a full destroy-and-redeploy proof both ran on 2026-08-04 with
explicit human sign-off, scoped only to the new agent service
(`terraform/render/plan/tro-316-destroy-redeploy-proof.md`): create → verified `/health`/`/ready`
200 → targeted `destroy` of the agent alone (verified `ship`/`ship-db` untouched) → re-`apply` from
config alone, no import → verified `/health`/`/ready` 200 again on the newly generated URL. **One
piece that proof deliberately left open, now closed:** `SHIP_API_TOKEN` was applied as a placeholder
string; a real per-user token has since been minted (see "Login and the 403" below) and wired into
the live agent — see the "Done, 2026-08-04" paragraph under "Login and the 403" for exactly how
(not via a second `terraform apply`, which hit a provider bug — worked around via the Render REST
API directly).

**Confirmed (not assumed): which branch Render deploys, and whether merged code actually reaches
it — and it does not, reliably.** `git_branch` defaults to `"main"` in `variables.tf` for both
services, and both `terraform.tfstate` and the Render API confirm `auto_deploy = true`,
`branch: main` on each — configuration is correct. But observed **three separate times this
sprint** (2026-08-04, 2026-08-05, and a third recurrence), a real merge to `main` did not reach the
live service: a stale `last-modified` header, a `404` on a route the merge had just added, and the
deploys API showing no new event, all independently confirming the same thing each time. Root cause
never fully diagnosed — `gh api repos/troysatchell/ship/hooks` returns `[]` (no classic webhook),
suggestive of Render's GitHub App integration silently failing to fire, but this session's `gh`
token cannot list App installations to confirm it.

**Standing operational procedure until that root cause is fixed:** after merging anything to `main`
that the graded demo depends on, do not assume `auto_deploy` fired. Manually verify —
`GET https://ship-rr6m.onrender.com/` and check its `last-modified` header against the merge time,
or probe a route the merge actually added. If stale, trigger a manual redeploy:
```bash
curl -X POST https://api.render.com/v1/services/<service-id>/deploys \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{}'
```
Current service ids: `srv-d9kf2t942hec73aofrt0` for `ship`, `srv-d9otunmgekts73eqs0h0` for `agent`
as of this ticket — re-check via `terraform output agent_service_url`/state, since the agent's
changes on every clean-machine `apply`. Exercised for real at least three times this sprint,
each time verified end-to-end afterward, not just at the health check — a real session (CSRF token
→ login → `POST /api/agent/chat` against a real fixture document) returning a grounded, cited
answer, the full session → api-proxy → internal-secret → graph → model chain, live on the graded
deployment. The second exercise surfaced a compounding gap worth recording: Terraform cannot update
the free-tier agent service at all (see "Done, 2026-08-04" below), so a new env var a merge
introduced (`AGENT_INTERNAL_SECRET`) existed nowhere until it was set directly via the Render
REST API's env-vars endpoint — the same workaround, applied to configuration instead of to a
missing deploy.

**Limitation, noted 2026-08-06 (TRO-358, CodeRabbit review):** triggering a deploy via the Render
REST API — unlike a dashboard-initiated action — does **not** disable `autoDeploy`. If this
procedure is ever used to roll back to an earlier commit rather than to catch up to `main`, a
subsequent push to GitHub `main` will silently replace that rollback. Either `PATCH` the service
with `autoDeploy: false` before a rollback and restore it after, or treat the rollback as
point-in-time only and re-verify the deployed commit after any later push.

**Rollback trigger and procedure.** Two layers, neither of which is a bespoke script:
1. **CI gates merge, not just deploy.** `.github/workflows/ci.yml`'s own header states it is "the
   merge gate the ticket factory depends on — a factory PR is not eligible for merge until this is
   green." Render's `git_branch = "main"` (both `web_service.tf` and `agent_service.tf`) means
   Render only ever builds from a branch that already passed CI to get there — a failing CI run
   never reaches `main` in the first place, so it never reaches Render's `auto_deploy` trigger
   either. This is the primary rollback: prevention before promotion, not correction after.
2. **Render's own health-check-gated promotion is a liveness safety net, not a readiness one.**
   `/health` (`health_check_path`, from FG-2) returns 200 whenever the process is up — it makes no
   config check and no Ship-dependency check (`agent/src/server.ts`). Per Render's documented
   zero-downtime deploy behavior, a new deploy is only promoted to receive live traffic once
   `/health` returns healthy within the deploy's startup window; if it never does — the process
   crashes on boot, or hangs — Render keeps the **previous** successful deploy serving traffic and
   marks the new one failed. That much is genuinely automatic and requires no Terraform beyond
   setting `health_check_path` correctly, which `agent_service.tf` does.
   **What this does NOT catch:** a deploy that boots cleanly but is missing
   `ANTHROPIC_API_KEY`/`SHIP_API_TOKEN`, or cannot reach Ship, still passes `/health` and is still
   promoted to live traffic — none of this is a readiness gate. `/ready` (config complete AND Ship
   reachable, FG-4's resilient client) reports that case as `503`, but `/ready` is deliberately NOT
   what Render's platform check points at, and no separate readiness check is currently configured
   or validated for that purpose — a deploy with a missing secret or an unreachable Ship still
   receives traffic today. `/ready` can also legitimately be false on a healthy, freshly-promoted
   instance if Ship itself is briefly down, and that specific case must not be read as "the deploy
   failed."

**TRO-322 / FG-12 — both layers demonstrated, not just described, plus the "boots but broken" gap
closed with real tooling; TRO-367 then wired that tooling to an automatic trigger, and TRO-383 added
a second trigger, driven by CI failure itself rather than by polling.** Three separate pieces of real,
generated evidence — none of this is re-derived from the reasoning above; see CHANGES.md's TRO-322
entry for exact commands/output, its TRO-367 entry for the polling trigger, and its TRO-383 entry for
the CI-failure trigger.

1. **Layer 1, proven on both platforms with a throwaway, never-merged branch.** A branch
   (`chore/tro-322-ci-rollback-proof-do-not-merge`) with one deliberate `pnpm type-check` failure
   was pushed to both remotes and opened as a PR (GitHub #131) and an MR (GitLab !1), then closed
   without merging once evidence was captured.
   - **GitHub:** `typecheck · build · unit tests` failed in 44s; `gh pr view` reported
     `mergeStateStatus: BLOCKED`. Exactly the documented behavior.
   - **GitLab — a real, previously-undocumented gap found while proving this.** Pipeline #17998
     (source `merge_request_event`) sat `pending` indefinitely against an ONLINE, IDLE shared
     runner. Root cause, confirmed via the GitLab API: the runner (`Snapshot pipeline runner`, id
     71) is configured `access_level: ref_protected`, and an MR pipeline runs against
     `refs/merge-requests/N/head`, which is not a protected ref — so the runner structurally never
     picks it up. Checked against this project's own pipeline history (`GET /projects/1602/
     pipelines`): **every pipeline before this one — 20 of 20 checked — has `source: push`,
     `ref: main`. This MR was the first `merge_request_event` pipeline in the project's history.**
     Net effect: an MR's pipeline can never complete on GitLab today, for ANY branch, not just this
     throwaway one. It does not silently pass, though — `GET /merge_requests/1` reported
     `merge_status: can_be_merged` but `detailed_merge_status: ci_still_running`, which GitLab
     treats as blocking (`only_allow_merge_if_pipeline_succeeds: true` on this project). So the
     prevention property this section claims still holds in effect (a stuck-forever MR cannot be
     merged), but not for the reason the header sentence implies ("CI gates merge" reads as "CI
     runs and passes/fails," not "CI never starts and merging is refused because it never will").
     This reconciles with `.gitlab-ci.yml`'s only working trigger being `push` to `main` — the
     documented factory workflow (push GitLab direct, GitHub via PR, then re-sync) means GitLab CI
     has only ever been exercised on already-decided `main` pushes, never as an actual merge gate.
     **Not fixed here** — the runner's `access_level` is an instance-level GitLab setting outside
     this project (owned by whoever registered runner 71), not something `.gitlab-ci.yml` or this
     repo controls. Worth a follow-up ticket: either get the runner's access level changed, or stop
     describing GitLab MR pipelines as a merge gate until it is.
2. **Layer 2's gap, reproduced live, closed with real tooling, and — as of TRO-367 (W5-R36, the only
   `MISSING` requirement in the Week 5 sweep) — actually WIRED to an automatic trigger.**
   `agent/src/deployReadiness.ts` (`evaluateReadinessSamples`/`pollReadiness`) is the decision
   function: a sustained run of not-ready samples (every sample in the window fails) warrants
   correction; a single failure that recovers — the transient-Ship-blip case this section already
   calls out — does not. Unit-tested (`deployReadiness.test.ts`, 10 cases, red-before-green proven
   by mutating the sustained-vs-transient check and watching the transient-blip tests fail for
   exactly that reason, then reverting). `agent/src/scripts/check-readiness-and-rollback.ts` is the
   CLI: polls a real `/ready` URL, evaluates, and — dry-run by default — reports whether a rollback
   is warranted (exit 2) without calling Render; `--execute --service-id <id>` (needs
   `RENDER_API_KEY`) additionally looks up the most recent other `live` deploy via `GET .../deploys`
   and re-triggers it via `POST .../deploys` with that deploy's `commitId`, Render's documented
   mechanism for redeploying a specific prior commit. Its own `poll -> evaluate -> decide -> call
   Render` pipeline is factored out as `runReadinessCheck` specifically so a test can exercise the
   FULL chain end to end against injected fakes (a fake `/ready` poller and a fake Render `fetch`,
   never a real network call) — see `check-readiness-and-rollback.test.ts`'s `runReadinessCheck`
   suite (6 cases: healthy → no action, transient → no action, dry-run → reports without calling
   Render, missing API key → reports without calling Render, sustained failure with `--execute` →
   actually calls Render's documented rollback endpoint with the correct previous commit id, plus
   one case proving the sample/evaluation logging point). Confirmed red first: every new case failed
   with `TypeError: runReadinessCheck is not a function` against the pre-TRO-367 script, then passed
   once `runReadinessCheck` was added.
   **Proven by local simulation, real processes, real output** (not mocked): two real
   `agent/src/index.ts` processes were started locally — one with `SHIP_API_BASE_URL` pointed at an
   unreachable port (config complete, Ship unreachable — exactly this section's named gap) and one
   pointed at a real, reachable stub. `curl` confirmed both returned `/health` → 200; only the
   broken one returned `/ready` → 503 (`ship_unreachable`). Running
   `check-readiness-and-rollback.ts --url .../ready --attempts 3 --interval-ms 1500` against each:
   the broken instance reported `sustained_not_ready: all 3 sample(s) reported not-ready` and
   exited 2; the healthy instance reported `healthy: every sample reported ready` and exited 0.
   **The trigger itself: `.github/workflows/agent-rollback-check.yml`.** Runs on a 15-minute
   `schedule:` (cron) plus `workflow_dispatch`, structurally asserted by
   `agentRollbackWorkflow.test.ts` (the `on:` block declares `schedule:`/`cron:`, not only manual
   dispatch; the readiness step passes `--execute`; `cancel-in-progress: false` so a scheduled tick
   never interrupts a rollback already in flight). It calls
   `check-readiness-and-rollback.ts --execute` against the real agent `/ready` URL, gated on two
   repository secrets — `RENDER_API_KEY` and `RENDER_AGENT_SERVICE_ID` — that this change does NOT
   and cannot set: provisioning real credentials against a live production service is exactly the
   outward-facing, credential-bearing infrastructure step this factory's escalation policy reserves
   for explicit human sign-off, matching every other live Render/Terraform action in this document.
   Until a human sets both, a "check secrets are configured" step reports a `::warning::` annotation
   on every scheduled run and every other step (including the readiness check itself) is skipped —
   neither failing loudly nor silently doing nothing.
   **What this closes, and what remains open, stated precisely.** Observed: the trigger is wired
   (the workflow file exists, fires unattended on a schedule, and its full decision-to-action
   pipeline is proven correct against fakes). Derived, not observed: that it will correctly redeploy
   the previous commit *against the actually-deployed production service* — no version of this
   trigger, in this change, has ever made a real call to Render's API, and no live rollback has ever
   been exercised against `ship-agent`. The remaining step is exactly the credential provisioning
   above, which is a human action, not a code change; the next scheduled run after both secrets are
   set is this trigger's first real, unattended exercise, and that run should be watched the first
   time. Do NOT simply repoint `agent_health_check_path` at `/ready` instead of using this
   trigger — this section's own transient-blip caveat means Render's platform check would then
   demote a healthy instance during any brief Ship outage, trading one failure mode for a worse one.
3. **TRO-383 — a second trigger, driven by CI failure itself, not by polling.** W5-R36's requirement
   text is literal: "If a CI run fails, the deployment must be rolled back automatically." The
   polling trigger above satisfies the *spirit* — it eventually notices a bad deploy — but nothing
   about it is CAUSED BY a CI run failing; a build that merges green and whose CI later fails against
   `main` (a post-merge rerun, a dependency regression only caught after merge) sits uncovered until
   the next scheduled tick, if at all. `.github/workflows/ci-failure-rollback.yml` closes that literal
   gap: it fires on the `workflow_run` event for `ci.yml`'s own `CI` workflow completing, filtered to
   `conclusion == 'failure'` on `main` (a PR's own run never matches — its `head_branch` is the PR's
   branch, not `main`).
   **It does not call Render just because CI failed.** A single red CI run is not evidence the
   deployed service is broken — this repo's own `lessons.md` records three distinct load-flake
   identities (`session-revocation.test.ts`, `programWeeksNav`, `auth.test.ts::extend-session`) that
   failed CI in one day on branches touching no file they could reach. So this trigger reuses the
   identical sustained-readiness decision the polling trigger already uses
   (`check-readiness-and-rollback.ts`'s `evaluateReadinessSamples`): a CI failure only earns an
   immediate readiness check, sooner than the next 15-minute tick — the check itself still requires
   EVERY sample in the window to report the live `/ready` endpoint unready before it will call Render.
   A flaky unrelated test cannot make `/ready` report unready, so it cannot cause a rollback by itself.
   **It shares the polling trigger's own concurrency group** (`agent-rollback-check`) rather than a
   new one — verified against GitHub's own documentation (Actions > Using jobs > Using concurrency),
   which states concurrency group names are scoped repository-wide, not per workflow file: two
   workflow files declaring the same group genuinely serialize against each other. A distinct group
   name would have let both triggers call Render at once; sharing this one means a CI-failure-prompted
   check and a scheduled tick queue behind each other instead.
   **Same secret gating, same honesty caveat as the polling trigger.** `RENDER_API_KEY` /
   `RENDER_AGENT_SERVICE_ID` gate every real step identically; unset, the workflow reports a
   `::warning::` annotation and does nothing else. Structurally asserted by
   `ciFailureRollbackWorkflow.test.ts` (the `on:` block's `workflow_run`/`types`/`branches`, the job's
   `conclusion == 'failure'` condition, the shared concurrency group read from both files rather than
   hardcoded, `--execute` behind the secrets gate). **Observed: the trigger exists, its condition and
   guard structure are proven against the real YAML, and its readiness-check step is the same,
   already-proven pipeline the polling trigger uses. Not observed: this trigger has never fired for
   real — no CI run has failed against `main` since it was added — and, exactly as with the polling
   trigger, no live call to Render's API has ever been made from either trigger.**

**Login and the 403 (TRO-341 / FG-23) — root-caused, not a WAF.** A bare
`POST https://ship-rr6m.onrender.com/api/auth/login` returns a platform-looking `403 Forbidden` —
generic HTML body, `ratelimit-*` headers, `server: cloudflare`. Traced to source, not guessed: the
`ratelimit-*` headers are `loginLimiter`'s own (`api/src/app.ts`), and `conditionalCsrf`
(`api/src/app.ts`) applies CSRF protection to **every** `/api/auth/*` route, login included, for any
request that isn't already carrying a `Bearer` token. A bare POST with no prior
`GET /api/csrf-token` (which sets the session cookie the sync check needs) fails that check;
`csrf-sync` throws with no route-local handler to catch it, so the error falls through to Express's
default `finalhandler` — that generic `<pre>Forbidden</pre>` HTML, not a Cloudflare/Render edge
rule (`cloudflare`/`cf-ray` headers appear on **every** response from this host, 200 or 403 alike —
present, but not the actor). Proven by fixing it: `GET /api/csrf-token` with a cookie jar →
`POST /api/auth/login` with that cookie plus `x-csrf-token: <token>` → `200`, real session,
`dev@ship.local` (`isSuperAdmin: true`). A real per-user API token was then minted through that
session (`POST /api/api-tokens`), name `fleetgraph-agent-tro-341`, no expiry, and verified working
via `Authorization: Bearer` against both a plain route and a `conditionalCsrf`-guarded one (Bearer
correctly bypasses CSRF). The raw value is not in this file or in git: it was folded into the main
checkout's gitignored `terraform/render/terraform.tfvars` and wired into the live agent — see the
"Done, 2026-08-04" paragraph immediately below.

**On the choice of identity, deliberately not changed here.** `dev@ship.local` is this repo's
established seed-fixture super-admin, already the login this entire sprint's manual verification
work has used and the identity "20+ e2e specs" (per this codebase's own prior convention) build on
— using it to mint the agent's token is consistent with that, not a new pattern. This is **not** the
"no service account" design being violated: FLEETGRAPH.MD's own stance is that every token belongs
to a real person, and `dev@ship.local` is a real (seeded) person's account, not a synthetic service
identity. A narrower, least-privilege, non-admin person's token would still be a legitimate future
tightening — deliberately not done under today's deadline pressure, and the token has no expiry,
which is worth a follow-up ticket for graded/demo-lifetime credential hygiene (rotation, an
expiration, and secret-manager storage instead of a gitignored `.tfvars` file) rather than blocking
this one.

**Done, 2026-08-04, with explicit human sign-off — but not via `terraform apply` as planned.**
`terraform plan` confirmed exactly one intended change (`SHIP_API_TOKEN` on
`render_web_service.agent`); `terraform apply` itself failed — `Could not update service...
maintenance mode can only be configured for non-free tier services` — a render-oss/render provider
bug: `ignore_changes` only suppresses what shows in the plan *diff*, but the provider's `Update`
call unconditionally includes `maintenance_mode` in its request body regardless of whether it
changed, so the failure reproduces for **any** change to this resource on the free tier (a new env
var, a plan-tier change, anything) — adding `maintenance_mode` to `lifecycle.ignore_changes` (tried,
matching `web_service.tf`'s existing `pull_request_previews_enabled` precedent) does not fix it.
**Worked around via the Render REST API directly** (`PUT /v1/services/{id}/env-vars/...`, then a
manual redeploy — an env-var PUT alone doesn't restart the running process). Verified:
`GET /health`/`GET /ready` both `200` against the live agent with the real, working per-user token;
Terraform's own state now agrees with reality. **Standing landmine, not a one-off:** until the
provider is patched or the service moves off the free tier, any future config change to
`render_web_service.agent` must go through the Render REST API — a `PUT`/`PATCH` to
`/v1/services/{id}` or its `/env-vars` sub-resource — not `terraform apply`. Filed as a follow-up
rather than solved here: exercising this failure mode in automated coverage isn't practical (it
needs a live Render API call against a free-tier resource), but someone should re-check
`terraform apply` against this resource each time the provider version pins forward, since that's
the actual fix path.

**Seeding the graded database with FG-3's fixture states (TRO-341 / FG-23) — procedure.**
`api/src/db/seed.ts`'s FG-3 block (`TRO-314`) is additive and self-gating: it checks
`COUNT(*) FROM document_history` for the workspace first and no-ops if non-zero, same as every
other block in the file — this is what makes re-running `pnpm db:seed` against an already-seeded
database safe, *provided* the target database's existing rows were themselves produced by this same
seed script (confirmed for `ship-db` each time this ran, by checking document/user counts matched
before proceeding). Two things stand between "safe in principle" and "runnable against the graded
database":

1. **`ship-db` has no public network path** — `ipAllowList` is unset (private-network connections
   only). Reaching it requires a temporary allowlist:
   ```bash
   curl -X PATCH https://api.render.com/v1/postgres/dpg-d9kgth6417fc7386hhh0-a \
     -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
     -d '{"ipAllowList":[{"cidrBlock":"<your-ip>/32","description":"temporary-fg23-seed"}]}'
   # ...seed run...  then immediately reset:
   curl -X PATCH https://api.render.com/v1/postgres/dpg-d9kgth6417fc7386hhh0-a \
     -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
     -d '{"ipAllowList":[]}'
   ```
2. **Migrating/seeding against Render needs `NODE_ENV=production`** — the branch that turns on SSL
   in `migrate.ts`/`seed.ts`, and requires `SESSION_SECRET` set or `app.ts` throws on boot (the SSM
   fallback, TRO-243, is what lets that path work off AWS).

Full sequence:
```bash
export DATABASE_URL="<ship-db external connection string>"
export NODE_ENV=production
export SESSION_SECRET="<same value already in terraform.tfvars>"
pnpm db:migrate   # idempotent — confirms the schema is present
pnpm db:seed       # additive; prints the real fixture ids for THIS database on success
```
Run for real twice against the graded database (2026-08-04, then again 2026-08-06 after a fixture
fix), both with explicit human sign-off and the allowlist opened and reset immediately after each
time — see the Test Cases section above ("Graded-database fixture status") for the complete
before/after evidence, what fired, what did not, and the fix in between; that is the authoritative
account and is not repeated here.

### Outbound Call Resilience

**Added TRO-368, 2026-08-08.** The brief's requirement is explicit: "All outbound calls from the
agent (to Ship APIs, LLM providers, and any external tools) must implement explicit timeouts and
retry logic with exponential backoff." Every outbound call class this package actually makes,
checked directly against source rather than assumed:

| Class | Timeout / backoff coverage | Where |
|---|---|---|
| Ship API (reads + writes) | Explicit `timeoutMs`; retry with exponential backoff + jitter (idempotent GET reads only); a circuit breaker with a half-open probe; self-throttling under Ship's own per-IP ceiling, since both of Ship's own rate limiters fail open (see "Reliability" above) | `resilientClient.ts`'s `ResilientClient`, built once via `buildShipClient` (`server.ts`) and shared by every `ShipClient`/`GateShipClient` in the process |
| LLM provider (Anthropic, `ChatAnthropic`) | Explicit `timeout` (`clientOptions.timeout`, forwarded to the raw `@anthropic-ai/sdk` client) and `maxRetries` (`@langchain/core`'s own `AsyncCaller`, exponential backoff + jitter via `p-retry` — verified by reading `async_caller.cjs`, not assumed from the option's name) | `server.ts`'s `anthropicModelParams`/`buildAnthropicModel` — the one place this package constructs the real `ChatAnthropic` used in production (`index.ts`) |
| Any other external tool (production paths) | None exist today. Every production request path (`/chat`, `/inbox`, `/accept-draft`, the proactive poller) makes outbound calls through exactly the two resilient classes above — no third service. | — |

**Manual CLI scripts are OUTSIDE this resilience story — stated explicitly, not left implicit
(CodeRabbit review, PR #156, finding 5).** The table above covers *production* request paths only.
Grepping `agent/src/scripts` turns up two scripts that make real outbound calls with **no timeout or
retry policy of their own**, and neither goes through `resilientClient.ts`:
- `trace-invoke-proactive.ts` — its two direct `fetch()` calls (`GET /api/team/people`,
  `POST .../comments`) are bare, unbounded fetches; they bypass even the `ShipClient`/
  `ResilientClient` this same script constructs for the rest of its work (its own `shipClient`
  variable, built via `buildShipClient(config)`, is never used for either call).
- `check-readiness-and-rollback.ts` — its readiness-polling loop (`fetcher.get: (url) => fetch(url)`)
  and its Render API calls (`rollbackViaRenderApi`: `GET`/`POST https://api.render.com/v1/services/
  {id}/deploys`) are both bare `fetch()`. The Render API is a genuinely different external service
  from Ship API or Anthropic — this document previously (and incorrectly) implied no third service
  existed; it does, it is just not on a production path.

Neither script runs on a request a real user's browser can trigger — both are human-invoked CLI
tools, explicitly not wired into any live trigger (`check-readiness-and-rollback.ts`'s own docstring:
"NOT wired into any live trigger against production in this change") — so this gap does not weaken
`/chat`/`/inbox`/`/accept-draft`'s own coverage. It is a real gap in the scripts themselves: a hung
Render API call or a hung `/ready` poll has nothing bounding it today. `check-readiness-and-rollback.ts`'s
readiness-polling half is being given an explicit timeout concurrently, on **PR #157** — not yet true
on this branch, so not claimed as done here. The Render-API half and `trace-invoke-proactive.ts`'s two
calls remain unbounded as of this document's own last-updated date; a future ticket, not this one,
would need to either route them through `ResilientClient` or accept the same explicit exclusion this
paragraph now states for manual tooling.

**A per-call timeout is not the same guarantee as a request-scoped deadline (TRO-379, 2026-08-09).**
The table above bounds each *individual* outbound call. It says nothing about whether a call can
outlive the `/chat` request that started it, and those are different properties:

- **The budget is now enforced at startup, not asserted in a comment.** `config.ts`'s
  `anthropicPreModelWorkAllowanceMs` (default 7,000 ms) turns a number that previously existed only
  as prose into a checked constant, and `assertAnthropicBudgetFitsHandlerDeadline` (called from
  `index.ts` right after `loadConfig`) throws when
  `anthropicWorstCaseCallMs(...) + anthropicPreModelWorkAllowanceMs > chatHandlerTimeoutMs`. With
  production defaults that is `18,000 ms + 7,000 ms = 25,000 ms`, exactly `chatHandlerTimeoutMs` —
  zero slack, and a misconfigured deployment now fails to boot rather than surfacing later as an
  unexplained 504.
- **The model call's cancellation is now explicit rather than accidental.** `composeAnswer` receives
  the node's `RunnableConfig` and passes `config.signal` into `model.invoke(prompt, { signal })` —
  the same signal `/chat` hands to `graph.invoke`. Worth recording *why*: `ChatAnthropic` was
  already being cancelled before this change, but only because LangGraph runs each node inside
  `AsyncLocalStorageProviderSingleton.runWithConfig` and `ChatAnthropic`, as a LangChain `Runnable`,
  picks that ambient config up via `ensureConfig()`. That is undocumented library behaviour a version
  bump could remove silently, with no test failing. A model implementation that is *not* a
  `Runnable` never received the signal at all — which is the bug
  `composeAnswerAbortPropagation.test.ts` reproduces and pins.
- **Known and still open: Ship reads do not take a signal.** `ShipClientLike` neither accepts nor
  forwards an `AbortSignal`, so a Ship read in flight when `/chat` aborts runs to completion
  server-side. It is bounded by `ResilientClient`'s own `timeoutMs` — so it cannot hang
  indefinitely — but it is not coupled to the caller's deadline. Tracked as **TRO-385**; stated here
  rather than left for a reader to discover, since the table above would otherwise read as full
  coverage.

**What changed, and what this section corrects.** Before TRO-368, this document's retry/fallback
coverage named only the Ship API class (the table's first row, already accurate) — it never named
the LLM-provider call as its own class, and the code matched that gap exactly: `index.ts`'s
`ChatAnthropic` construction (`agent/src/index.ts:162`, pre-fix) had no `timeout` or `maxRetries` at
all, silently inheriting `@anthropic-ai/sdk`'s own 10-minute default timeout and
`AsyncCallerParams`' 6-retry default. `server.ts`'s own `/chat` handler comment already conceded the
consequence: a hung model call "keeps running to completion server-side" even after the handler's
own `chatHandlerTimeoutMs` gives up *waiting* on it, because the `AbortSignal` that bounds the
handler does not reach inside a single in-flight `AnthropicModel.invoke()` call — that gap mattered
even more for `composeStandupDraft`/`composeBlockerEscalation`/`composeRetroDraft`/
`composePlanChangeDraft`, which share the same model instance but run outside any HTTP handler at
all once a scheduler exists to trigger them, so nothing bounded those calls either. Fixed by giving
`ChatAnthropic` explicit, chosen values rather than the library's unexamined defaults; every
`ChatAnthropic` construction in this package (the production one and the seven one-off trace/
golden-set scripts) now sets both explicitly and consistently. **Updated (CodeRabbit review, PR #156,
finding 1):** the original values (20s timeout, 2 retries/three total attempts — chosen to match
`resilientClient.ts`'s own `DEFAULT_RETRY_MAX_ATTEMPTS`) could collectively outlive `/chat`'s own
`chatHandlerTimeoutMs` deadline (worst case ~3 × 20s plus backoff, versus a 25s handler budget) —
lowered to 8s timeout / 1 retry (two total attempts), whose worst case (~18s) fits inside that budget
with margin. Full reasoning and the exact arithmetic live in `config.ts`'s
`anthropicRequestTimeoutMs`/`anthropicMaxRetries` docstrings and `anthropicWorstCaseCallMs`.

---

## Cost Analysis

### Development and Testing Costs

**Current figures.** Reproduce with `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts
-- --ledger cost-ledger-snapshot.jsonl` from the worktree — this reads the tracked, committed
snapshot (`agent/cost-ledger-snapshot.jsonl`, TRO-373), the same one
`agent/src/__tests__/fleetgraphCostFigures.test.ts` pins these numbers against, so this table and
the code cannot drift apart silently again.

| Item | Amount |
|---|---|
| Claude API — input tokens | 1,860 |
| Claude API — output tokens | 839 |
| Total invocations during development | 7 |
| Total development spend | $0.006055 |

**History below, chronological, kept in full rather than deleted.** This ledger has been refreshed
three times as real spend accumulated and as the reproduction command itself was fixed; each
snapshot below disclosed a real gap when it was current (an under-instrumented ledger, a
non-reproducible command, a stale document) rather than smoothing it over, which is why the record
stays rather than getting overwritten. The table immediately above is current; everything from here
to "Refreshed (TRO-366, 2026-08-08)" below is superseded and kept for that provenance, not as a
second source of truth.

**Instrumented as of TRO-339 (FG-21), 2026-08-05.** Every real `model.invoke()` call in
`agent/src/graph.ts` (the `respond`, `composeAnswer`, and `composeStandupDraft` nodes — the only
three that ever call the model) now records its real input/output tokens, model, and which node
served it, to `agent/.cache/cost-ledger.jsonl`. The table below is that recorded data, reproduced
verbatim by running `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` from the worktree
on 2026-08-05 — not an estimate. **This is a dated snapshot, not a live reproduction target:** the
ledger is append-only and kept growing after this date (see the 2026-08-08 and 2026-08-09 updates
below), so no artifact anywhere still holds it in this one-invocation state — running this same
command today reproduces whatever the ledger holds *now*, not this table. For the currently
reproducible figures, and the command that actually gets them from a fresh clone (TRO-373), see
"Refreshed (TRO-366, 2026-08-08)" below.

| Item (historical — 2026-08-05 snapshot, superseded) | Amount |
|---|---|
| Claude API — input tokens, as of 2026-08-05 | 33 |
| Claude API — output tokens, as of 2026-08-05 | 37 |
| Invocations recorded as of 2026-08-05 | 1 |
| Development spend as of 2026-08-05 | $0.000218 |

**Reconciliation and why the total was this small.** The one recorded invocation was cross-checked
directly against LangSmith's own usage reporting for the same trace: an exact match
(`prompt_tokens: 33`, `completion_tokens: 37`, `total_cost: 0.000218`), not a coincidence of
rounding. Querying LangSmith's full project history (not just this invocation) turned up only two
other real model calls, ever, this sprint — both predating this ticket and never captured anywhere.
FG-5's proactive chain, FG-6's standup-draft composition, and FG-7's on-demand expansion had never
once been invoked against the real Anthropic API — every test for all three uses a stable fake
model, by design. Real spend really had been near-zero; this instrumentation was landed before that
changed.

**Per-tier measured cost**, to replace the projected $0.021 standup / $0.015 inbox / $0.052 retro /
$0.065 on-demand figures below with observed ones once real traffic exists: only the bare on-demand
chat path had a real measurement yet at this point — $0.000218/run. `composeAnswer` (the
on-demand-with-expansion tier the $0.065 projection describes, which also records
documents-pulled-per-run for cost cliff #2) and `composeStandupDraft` were fully wired to record the
moment either ran for real, but neither had yet — a real gap, not a placeholder, since producing one
needed a live Ship API and seeded database, or a scheduler nobody has built yet.

**Update (TRO-324 / FG-13, 2026-08-05) — `composeAnswer` gets its first real measurement.** Producing
this ticket's own required trace-link proof (see "Execution Traces" above) meant running
`composeAnswer` for real, twice — the `documentsPulled: 0` mistaken invocation and the real
12-document expansion run, both recorded to the same ledger:

| Item | Amount |
|---|---|
| `composeAnswer` — invocations (2026-08-05 snapshot) | 2 |
| `composeAnswer` — cost/run (mean over the 2 priced invocations) | $0.000852 |
| `composeAnswer` — avg documents pulled | 6.00 (0 and 12 — the mistaken invocation and the real one) |
| `respond` — cost/run (unchanged from FG-21 — not re-run by this ticket) | $0.000218 |
| Total development spend as of 2026-08-05 | $0.001922 (3 invocations, 567 input tokens, 271 output tokens) |

`composeAnswer`'s $0.000852 mean, at the time, was the average of one near-zero-context run (a
mistaken invalid seed id, 0 documents) and one real 12-document, cap-reached run — close to the
opposite ends of what `composeAnswer` can cost, and, like the FG-21 table above, dated history now.

**Refreshed (TRO-366, 2026-08-08), then made reproducible (TRO-373, 2026-08-09).** The ledger kept
growing past the 2026-08-05 snapshot, and a grader running the command this document names got real
numbers this file no longer matched (7 invocations / $0.006055 against the 3 / $0.001922 published
above) — the table below is those 7 real records. Producing it exposed a second, structural problem:
the command that produced it had to be run against the project's long-lived development checkout,
because `agent/.cache/cost-ledger.jsonl` is gitignored and per-checkout by design — a fresh clone's
own empty ledger prints `No invocations recorded yet`, not these figures. Real numbers, genuinely
unreproducible. TRO-373 closed that gap by committing a byte-identical, read-only copy of those 7
records as a tracked snapshot (`agent/cost-ledger-snapshot.jsonl`) and adding `--ledger`/
`AGENT_COST_LEDGER_PATH` overrides to `cost-report.ts`, so the reproducible command is now:

```bash
pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl
```

Run from any fresh checkout — including this one, which has made zero real Anthropic API calls of
its own — this reproduces the table below exactly. The snapshot is a point-in-time copy, not a live
tap on the ledger (it will not pick up future real invocations without a follow-up commit), and
`agent/src/__tests__/fleetgraphCostFigures.test.ts` pins this document's figures against that same
committed snapshot directly, so the document and the snapshot cannot drift apart silently again.

| Item | Amount |
|---|---|
| `composeAnswer` — invocations | 6 |
| `composeAnswer` — cost/run (mean over the 6 priced invocations) | $0.000876 |
| `composeAnswer` — avg documents pulled | 6.50 (12, 12, 12, 1, 1, 1 across the six real runs) |
| `composeStandupDraft` — invocations | 1 |
| `composeStandupDraft` — cost/run | $0.000798 |
| **Total development spend to date, all nodes in this ledger** | **$0.006055 (7 invocations, 1,860 input tokens, 839 output tokens)** |

The total above is `composeAnswer` + `composeStandupDraft` only — everything the queried ledger
currently holds. It does **not** include `respond`'s $0.000218 from the 2026-08-05 table above: that
record (FG-21's single measurement, cross-checked against LangSmith at the time) is not itself a row
in this ledger snapshot. Where it went is not established here — either it lived in a different,
since-discarded worktree's own local ledger and never reached this checkout's, or it predates this
checkout's ledger history. Disclosed as an open gap, not papered over; the $0.000852/2-invocation
table above is left as dated history rather than silently dropped.

`composeAnswer`'s cost/run moved from the 2026-08-05 snapshot's 2-sample $0.000852 to a 6-sample
$0.000876 — three more 12-document runs and three 1-document runs are on the ledger the same day
(2026-08-05), never previously reported here. Six samples is still a small n, reported at that
confidence level and no higher.

**`composeStandupDraft` no longer has zero real invocations — this file's own prior claim to that
effect (here, and in the Graph Diagram section above) was stale and is corrected as of this update.**
The ledger's newest entry, timestamped 2026-08-07, is a real `composeStandupDraft` invocation. No
scheduler exists to trigger `proactive_deep` for a real person on any ongoing basis — that remains
true and unchanged — but "no scheduler yet" and "zero real invocations" are different claims, and
this file had conflated them.

**Estimated runs per day, observed: still too little real history for a rate, but no longer a single
calendar day.** `invocationsByDay` on the refreshed ledger buckets the 7 model-calling invocations
across **two** calendar days — `2026-08-05` (6) and `2026-08-07` (1) — not the single day this
section previously reported. Two clustered days still cannot honestly support a "runs per day" rate;
reported here as two raw daily counts, not annualized or extrapolated into anything resembling
"runs/day in production." The separately-tracked real-activity count TRO-324/FG-13 also reported — 6
real `proactive_steady` graph invocations (the "Execution Traces" / detection-latency polling loop
below), all on `2026-08-05` — is a different measurement, unaffected by this update, and still too
clustered to support a rate on its own.

**Detection latency — one real, timed measurement, plus the structural bound it does not replace.**
FLEETGRAPH.MD's own bar is "< 5 minutes from event appearing in Ship to the agent surfacing it,"
and the ticket wants the achieved number, not just the 60-second poll-interval design target
(`DEFAULT_PROACTIVE_POLL_INTERVAL_MS` in `agent/src/config.ts`). `agent/src/scripts/trace-invoke-proactive.ts`
(new, this ticket) does the real thing: writes one real comment mentioning a real person
(`@Bob Martinez`, literal-text convention, `mentions.ts`) on a real seeded issue in this worktree's
local Ship API, records the wall-clock write instant, and polls with real, independently-traced
`proactive_steady` graph invocations (never a blind fixed sleep — each poll re-checks the real
`ItemStore` for the actual item) until the mention is genuinely present for that real recipient.

Run 2026-08-05, real output:

| | |
|---|---|
| Event written at | `2026-08-05T01:15:00.841Z` |
| Surfaced in `ItemStore` at | `2026-08-05T01:15:06.026Z` |
| **OBSERVED, this run** | **5,185ms** (6 real ticks, 1000ms apart, until the item was present) |
| This run's own final tick's processing time alone (`graph.invoke()`, no wait) | 31ms |
| **DERIVED worst-case bound for a running production poller** | **~60,031ms** = configured 60,000ms poll interval + this run's own single-tick processing time |

**Why the observed number is ~5.2 seconds and not near-instant, and why that is a real finding, not
noise.** The first attempt at this measurement — a single tick fired within milliseconds of the
write — returned 0 items every time, reproducibly. Reading `api/src/routes/change-feed.ts` explained
why: `CHANGE_FEED_LAG_MS = 5_000` deliberately withholds any row more recent than `now - 5000ms`, a
real, correct safety margin against a slower transaction committing after a faster one's timestamp
(exactly the "the cursor must lag" reliability point this document's own Trigger Model section
already states in prose — this run is that mechanism's first real, measured confirmation). So the
~5.2s observed number is dominated by that deliberate 5-second server-side safety margin, not by
agent-side processing (which, per the 31ms figure above, is negligible) — a single agent process
polling as fast as it safely can is bounded below by Ship's own lag margin, not by anything in
`agent/`. This is a slightly OPTIMISTIC measurement relative to a real 60-second-cadence deployment,
where an event landing just after a tick starts waits up to a full interval for the next one — the
DERIVED ~60s bound above (not observed directly) covers that case. Both numbers are comfortably
under the 5-minute bar; only the top one was actually measured, and the two are never presented with
the same confidence.

**Scope of the 5,185ms observed number, stated explicitly.** It covers steady-tier polling
(`proactive_steady`, real `pollChangeFeed -> resolveMentions -> ... -> commitInboxItems` graph
invocations) through in-process `ItemStore` insertion specifically — event write to the mention item
being present in that in-memory store, and nothing past it. It does NOT exercise: the `proactive_fast`
poll hook (a different cadence, never invoked by this measurement), any production persistence adapter
for `ItemStore` (this run's store is the plain in-memory implementation, constructed fresh inside the
script), the agent's public HTTP API (this script calls `buildGraph`/`graph.invoke` directly, never
`POST /chat` or any other agent route), or the UI surfacing the item to a real user (no browser, no
inbox render, no human ever looked at it in this run). Each of those is a real, separate hop a
production deployment would add on top of this number, none of them measured here.

**TRO-322 / FG-12 closed exactly that gap with a real, CI-run, automated test** —
`e2e/agent-detection-latency.spec.ts` — rather than replacing this manual script (which stays a
useful one-off trace-link tool). Unlike the measurement above, the E2E spec exercises the agent's
real public HTTP API (`GET /api/agent/inbox`, api/'s real proxy, the agent's real `/inbox` route)
against a real, separately-spawned agent process running its real production poll loop
(`proactivePoll.ts`, not a hand-invoked `graph.invoke()` inside the test), and asserts elapsed time
against this document's own "< 5 minutes" bar as a hard `expect()`, not a printed number. Local run
(2026-08-05, both e2e specs together, 28.5s wall time): **observed 7,751ms**, comment write to the
mention present via a real `GET /api/agent/inbox` call — comfortably inside both the 5-minute bar
and a tighter CI-tuned operational bound built from real constants (`CHANGE_FEED_LAG_MS` +
this fixture's configured poll interval + buffer). Wired into CI on both platforms (`ci.yml`/
`.gitlab-ci.yml`'s `e2e-agent` job); see CHANGES.md's TRO-322 entry.

### Production Cost Projections

| 100 Users | 1,000 Users | 10,000 Users |
|---|---|---|
| **~$450/month** | **~$4,470/month** | **~$44,700/month** |

**Assumptions**

Unit ratios come from the live database — 15 projects, 523 documents, 254 issues, 20 people —
giving roughly 35 documents, 17 issues and 1.33 people per project. So 100 users is about 75
projects.

- **Proactive runs per project per day:** 1,440 polls (one per minute, mostly returning nothing),
  plus one draft composition per person per window — about 1.3 standup drafts and 1.3 inbox
  assemblies per project per working day, and roughly 1.3 retro drafts per project per week.
- **On-demand invocations per user per day:** 2
- **Average tokens per invocation:** 4,000 in / 600 out for a standup draft; 3,000 / 400 for an
  inbox assembly; 6,000 / 900 for a retro draft; 9,000 / 800 for an on-demand answer, which is
  larger than the old design because the agent now follows the graph outward.
- **Cost per run:** $0.021 standup draft, $0.015 inbox, $0.052 retro draft, $0.065 on-demand
  answer.
- **Estimated runs per day, per 1,000 users:** ~1,000 standup drafts, ~1,000 inbox assemblies,
  ~200 retro drafts, 2,000 on-demand answers.

Model tiering: high-volume drafting runs on the cheaper model; the reasoning tiers run on the more
capable one.

| Tier | Scales with | $/user/month |
|---|---|---|
| Standup drafts | People | $0.46 |
| Inbox assembly | People | $0.32 |
| Retro drafts | People | $0.23 |
| Nightly cross-project pass | Projects | $0.60 |
| On-demand answers | People | $2.86 |
| **Total** | | **$4.47** |

### Three things that matter more than the totals

**This is about a third more expensive than the detection design it replaces.** That is the correct
trade — the earlier design was cheaper mainly because it declined to do anything.

**On-demand dominates at 64% of spend, and it grew.** Following the graph outward costs more input
tokens than answering from a single document. That is the price of treating the current view as a
starting point rather than a fence, and it is worth paying.

**The rate limit runs out long before the budget does.** Ship's per-source-IP limiter allows 6,000
requests a minute across every user the agent serves. At roughly 2,000 users the agent begins
throttling itself, while the bill is still under $9,000 a month. **The 10,000-user column is a cost
projection, not a capacity claim** — reaching it requires multiple egress addresses or a raised
limit, which is an infrastructure conversation rather than a budget one.

### Cost cliffs, worst first

1. **Which model answers on-demand questions.** Moving that tier to the cheaper model takes the
   per-user cost from $4.47 to $3.32 — a 26% cut from one configuration change.
2. **How far on-demand expands the graph.** Following every edge from every document is unbounded.
   Relevance ranking with a hard cap on documents pulled in is what keeps this line finite, and it
   is the single most important implementation constraint in the design.
3. **Drafting for people who never read the drafts.** If someone ignores their drafts for two
   weeks, stop generating them and let them ask. Trivial to implement, and it removes the largest
   single source of waste.
4. **How the derived-content cache is keyed.** Keyed by document and content version, ten people
   asking about the same week read it once. Keyed by viewer, that work multiplies by readers.

---

## A note on the data behind these numbers

Everything measured comes from Ship's development database: 523 documents, 254 issues, 20 users,
20 people, 35 weeks spanning weeks 11 to 17.

It was built to a Week 4 specification — "seed the database with realistic data: 500+ documents,
100+ issues, 20+ users, 10+ sprints." It is a load-testing fixture, made to give benchmarking tools
enough rows to produce meaningful latency numbers, not to model how people behave. Weekly plans and
retros are drawn from eleven fixed content pools; confidence values are computed from how far in
the past a week is plus random noise.

**So counts from it measure the fixture, not Ship's users.** The unit ratios in the cost model are
safe, because documents and issues per project are exactly what the fixture was built to be
realistic about. Behavioural claims are not, and none are made here.
