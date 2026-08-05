/**
 * The compiled LangGraph graph (TRO-313 / FG-2; extended by TRO-317 / FG-5,
 * TRO-318 / FG-7, TRO-319 / FG-6, TRO-335 / FG-17, and TRO-336 / FG-18).
 *
 * Phase 2 (node design for the six FleetGraph use cases — see FLEETGRAPH.MD
 * "Graph Diagram" / "Node design rationale", both marked Pending) is still
 * not fully done. Seven entry points exist so far, all sharing ONE compiled
 * graph, selected by `trigger`:
 *
 *   on_demand (no seed document) -> ingest -> respond
 *     FG-2's original stub, UNCHANGED: a bare question with nothing to
 *     expand from. ingest normalizes the input (no model call); respond is
 *     the one node that calls the model.
 *
 *   on_demand (seed document present) -> resolveSeed -> expandFrontier
 *     (looping) -> finalizeExpansion -> composeAnswer
 *     FG-7's own addition — see the "On-demand expansion" section below.
 *
 *   proactive_fast / proactive_steady -> pollChangeFeed -> resolveMentions
 *     -> detectBlockingApprovals -> commitInboxItems
 *     FG-5's proactive fast tier (mention resolution + approval-blocking
 *     detection). No model call anywhere in this chain.
 *
 *   proactive_deep -> gatherStandupActivity -> composeStandupDraft ->
 *     commitStandupDraft
 *     FG-6's own addition — see the "Deep tier draft composition" section
 *     below. Requires `targetPersonUserId` (one graph invocation composes
 *     ONE person's draft — "once per person per window," not once per
 *     change, is the ticket's own cadence requirement). The only node in
 *     this chain that calls the model is `composeStandupDraft`, and it is
 *     skipped entirely (no model call, no spend) when the waste-control
 *     stop condition fires — see that section.
 *
 *   proactive_escalation -> detectBlockerFanout -> composeBlockerEscalation
 *     -> commitBlockerEscalation
 *     TRO-346/TRO-337 / FG-19's own addition — see the "Blocker escalation
 *     fan-out" section below. Requires `blockingIssueId` (one invocation
 *     evaluates ONE blocking issue), same required-field posture as
 *     `targetPersonUserId` above. The only node in this chain that calls the
 *     model is `composeBlockerEscalation`, skipped entirely when
 *     `detectBlockerFanout` determines escalation is not warranted (no
 *     model call, no spend) — see that section.
 *
 *   proactive_retro -> gatherRetroActivity -> composeRetroDraft ->
 *     commitRetroDraft
 *     TRO-335 / FG-17's own addition — see the "Retro delivery drafting"
 *     section below. Requires `weekId` (one invocation drafts ONE week's
 *     retro), same required-field posture as `targetPersonUserId`/
 *     `blockingIssueId` above. The only node in this chain that calls the
 *     model is `composeRetroDraft`, skipped entirely when
 *     `gatherRetroActivity` determines the trigger condition is not met (no
 *     success criteria, no recorded owner, no computable calendar window, or
 *     the week itself not found) — see that section.
 *
 *   proactive_plan_change -> detectPlanChange -> composePlanChangeDraft ->
 *     commitPlanChangeDraft
 *     TRO-336 / FG-18's own addition — see the "Plan-change discrimination"
 *     section below. Requires `weekId` — the SAME state field
 *     `proactive_retro` requires, reused rather than duplicated because both
 *     triggers key off one week's own id. The only node in this chain that
 *     calls the model is `composePlanChangeDraft`, skipped entirely when
 *     `detectPlanChange` determines the week was not actually edited after
 *     approval, has no diffable "before" snapshot, or every criterion is
 *     identical after whitespace normalization. `composePlanChangeDraft`
 *     itself can ALSO end up writing nothing — the one chain in this
 *     package where the model's own verdict, not just a deterministic
 *     gate, decides whether anything gets drafted — see that section.
 *
 * Model provider: Anthropic API directly (`@langchain/anthropic`), confirmed
 * by the maintainer 2026-08-03 — see TRO-313's own "one decision still open"
 * section. Not Bedrock: this environment has never had AWS credentials this
 * sprint (memory-bank/activeContext.md), and the brief's "Claude API costs"
 * accounting matches billing through the Anthropic API, not Bedrock.
 *
 * `GraphState` gains fields shared across tiers: `trigger` lets any node
 * branch on why the graph is running without hardcoding "this graph only
 * ever handles the proactive trigger" — originally written (FG-7) when
 * `proactive_deep` (the drafting tier) was named in the type with no node
 * behind it yet ("composing drafts is out of this ticket's scope"); FG-6 is
 * that node, below. `inboxItems`/`clearedItemIds` (FG-5) use concatenating
 * reducers specifically so more than one producer node can append to the
 * same list in one run — `commitStandupDraft` (FG-6) is a third producer
 * onto `inboxItems` for the same reason.
 *
 * ---- On-demand expansion (TRO-318 / FG-7) --------------------------------
 *
 * "The open document seeds the question. It does not fence it." — the ticket
 * corrected an earlier draft that treated the open document as a boundary.
 * `resolveSeed` visits the seed document; `expandFrontier` is a real LOOP
 * (a conditional self-edge, `routeExpansionLoop` below) that pops the
 * highest-ranked remaining candidate, visits it, discovers its own further
 * candidates, and re-ranks — until either the frontier empties or the hard
 * `documentCap` (required, `OnDemandDeps.documentCap` — see that interface's
 * own docstring for why it cannot be omitted) is reached. This loop is what
 * makes an on-demand run's node sequence genuinely variable run to run — a
 * dense neighbourhood produces many `expandFrontier` visits before the cap
 * cuts it off; a sparse one exhausts its frontier after one or two. That
 * variability is the proof the ticket's item #4 asks for: "a graph that
 * looks identical across every run is a pipeline, not a graph." Compare
 * against FG-5's `pollChangeFeed -> resolveMentions -> detectBlockingApprovals
 * -> commitInboxItems` chain, which is the same four nodes, same order,
 * every single run — genuinely different shape, not just a different label.
 *
 * The hard cap only gates `on_demand` when a seed document is present. A
 * bare question (no seed) still runs the original `ingest -> respond` two
 * nodes UNCHANGED — every existing FG-2 test keeps passing without touching
 * `OnDemandDeps` at all, and "does this question have something to expand
 * from" is a real, product-meaningful distinction (FG-9's eventual chat
 * panel will not always have a document open).
 *
 * Citations are structural, not a suffix: every document the walk visits is
 * carried through the state as an `ExpandedDocument` (title + reason +
 * content snippet + comment snippets — `expansion.ts`), and `citedSources`
 * is built directly from that same list by `finalizeExpansion`, independent
 * of anything the model writes. `composeAnswer` is the one node in this
 * path that calls the model — it builds a prompt from `expandedDocuments`
 * (`buildExpansionPrompt`) and never lets the model's own text decide which
 * sources get cited.
 *
 * ---- Deep tier draft composition (TRO-319 / FG-6) -------------------------
 *
 * "Composition runs once per person per window, not once per change" (the
 * ticket's Scope section) — a materially different cadence from FG-5's
 * every-60-seconds `proactive_steady` chain, which is why this is its own
 * trigger and its own node chain rather than a fifth node bolted onto FG-5's.
 * One invocation with `trigger: 'proactive_deep'` composes exactly ONE
 * person's draft (`targetPersonUserId`, required — `requireDeepDeps`/the
 * gather node throw a clear error otherwise, same "fails loudly rather than
 * silently" posture as `OnDemandDeps.documentCap`). There is deliberately no
 * scheduler in this file (or anywhere in this package) that decides WHOSE
 * window is open and invokes the graph for them — same posture FG-7 left
 * `seedDocumentId`/`askingUserId` in: a real trigger route is a future
 * ticket's job (this bundle's ordering makes FG-8 the next one, and even
 * FG-8 is the accept-flow, not necessarily the scheduler).
 *
 * `gatherStandupActivity` finds the anchor ("since their last standup" —
 * `standupDraft.ts`'s `findStandupAnchor`) and classifies every one of the
 * person's currently assigned issues into moved / commented / stale
 * (`gatherPersonActivity`) — no model call anywhere in this node. It ALSO
 * evaluates the waste-control stop condition here, before any model spend:
 * `DraftStore.shouldGenerateDraftFor` (ticket's "cost cliff #3" — "if a
 * person ignores their drafts for two weeks, stop generating them and let
 * them ask"). When it returns false, `standupSkipReason` is set and
 * `composeStandupDraft` skips its model call entirely — the skip is the
 * whole point of checking this early rather than after composing.
 *
 * `composeStandupDraft` is the ONLY node in this chain that calls the
 * model — same shape as `composeAnswer`: a deterministic prompt
 * (`buildStandupPrompt`) built entirely from `standupActivity`, never from
 * anything the model chooses on its own. `commitStandupDraft` writes the
 * result into TWO stores: `DraftStore` (the full draft text — immutable
 * once set, the quality-survival signal's groundwork — plus any
 * `ProposedTransition`s with their evidence) and `ItemStore` (a lightweight
 * `standup_draft` `InboxItem` pointing at the draft via `draftId`, joining
 * FG-5's mention/blocking-approval items in the SAME shared per-person
 * list — FLEETGRAPH.MD's "one list per person: what needs you").
 *
 * Hard limits (TRO-319, verbatim: "never writes a performance rating, never
 * sets an approval state / week status / ownership, never applies an issue
 * transition, never creates or deletes a document, and never writes
 * anything that would read as though a person wrote it") are enforced
 * STRUCTURALLY, not by convention: `DeepShipClientLike` (`shipClient.ts`)
 * exposes only READ methods — there is no write method for any node in this
 * chain to call even by mistake. Nothing this chain produces is ever
 * written to Ship; `DraftStore`/`ItemStore` are both entirely inside this
 * agent process.
 *
 * ---- Blocker escalation fan-out (TRO-346/TRO-337 / FG-19) ----------------
 *
 * FLEETGRAPH.MD's use case 5, verbatim: "An issue blocks work in two or more
 * projects whose blocked people sit in different reporting lines" ->
 * "the full impact, the lowest manager with authority over everyone
 * blocked, and a drafted message to them." TRO-337 is the fuller spec;
 * TRO-346 is the urgent framing of the identical work — this section
 * closes both.
 *
 * Trigger-model decision (this ticket's own call, documented per its
 * instruction, not re-litigated elsewhere): `proactive_escalation`, a NEW
 * trigger requiring `blockingIssueId` — structurally identical to how FG-6
 * added `proactive_deep` requiring `targetPersonUserId`, not a branch bolted
 * onto the existing `proactive_fast`/`proactive_steady` chain. This was a
 * real choice, not the only option, made against one VERIFIED fact:
 * creating a `blocks` association writes only to `document_associations`
 * (`api/src/routes/associations.ts`'s `POST /:id/associations`) — it never
 * touches the blocking issue's own `documents.updated_at`, and no DB trigger
 * does either (only migration 040's cycle-prevention trigger fires on that
 * table, and it never writes to `documents`). `GET /api/change-feed`
 * (`pollChangeFeed`'s own source) is built entirely from `documents.updated_at`
 * plus `document_history` plus `comments` (`change-feed.ts`) — none of which
 * a new `blocks` edge ever produces a row in. Concretely: `detectBlockingApprovals`
 * (the ticket's own suggested "closest existing analog") works BECAUSE an
 * approval-state change goes through the standard issue/week PATCH endpoint
 * and writes a real `document_history` row; a `blocks` edge's creation has
 * no equivalent row anywhere this agent can poll. Treating this like a
 * `proactive_fast`/`proactive_steady` detection node would mean pretending
 * to observe an event this agent's only proactive data source cannot
 * carry — the chain would only "accidentally" re-evaluate a fan-out on some
 * LATER, unrelated change to one of the involved documents, which is not a
 * specification of the use case, it is a coincidence dressed up as
 * detection. `on_demand` was the other real option (extending the existing
 * expansion walk, which already resolves `blocks` edges for citation
 * purposes) and was rejected because TRO-337 frames this as the agent
 * SURFACING an escalation to a Director/PM ("no page joins them" — nobody
 * would know to ask), not answering a question someone already knew to ask;
 * FLEETGRAPH.MD's own "Who it notifies" section already treats manager
 * escalation as something the agent produces, not something chat answers.
 * Reusing the deep tier's exact compose/commit shape (`DeepDeps`,
 * `DraftStore`/`ItemStore`, "draft only, never sent") was the ticket's own
 * explicit instruction. `blockingIssueId` is required for the identical
 * reason `targetPersonUserId` is (`requireBlockingIssueId`, mirroring
 * `requireTargetPersonUserId`) — and, matching `proactive_deep`'s own
 * documented gap, there is deliberately no scheduler in this file (or
 * anywhere in this package) that decides WHICH issue's fan-out to check and
 * WHEN; a real trigger route (e.g. driven by `document_associations` writes
 * once Ship exposes them, or a periodic full scan) is a future ticket's job.
 *
 * `detectBlockerFanout` gathers the impact fan-out (`blockerFanout.ts`'s
 * `gatherBlockerFanout` — which issues, which projects, which people; no
 * model call) and THEN decides whether escalation is warranted at all —
 * TRO-337's own trigger condition, both required: (a) two or more DISTINCT
 * projects touched (the blocking issue's own project plus every distinct
 * blocked-issue project — Test Case 5's shape is exactly one of each), and
 * (b) two or more distinct blocked people who are NOT all in the same
 * reporting line (`roles.ts`'s `findLowestCommonManager`, which returns
 * `'same_reporting_line'` as an explicit, typed reason — TRO-337's own
 * non-escalation proof #3). Either gate failing sets
 * `blockerEscalationSkipReason` and skips straight through: no model call,
 * no draft, no inbox item — the same "check before spending" posture
 * `gatherStandupActivity`'s waste-control check already uses.
 *
 * `composeBlockerEscalation` is the ONLY node in this chain that calls the
 * model — same shape as `composeAnswer`/`composeStandupDraft`: a
 * deterministic prompt (`buildBlockerEscalationPrompt`) built entirely from
 * the gathered fan-out and the LCA result, never from anything the model
 * chooses on its own. It runs even when `findLowestCommonManager` returns
 * `'no_common_manager'` (TRO-337's OWN verified-normal case: "reports_to is
 * set on only 10 of 20 people... must handle a missing link as the normal
 * case, not an exception") — the prompt says so plainly rather than
 * asserting unproven authority, and `commitBlockerEscalation` routes the
 * resulting draft to `highestReachableUserId` when one exists (TRO-337's
 * other sanctioned degrade path), never fabricating a recipient.
 *
 * `commitBlockerEscalation` writes into the SAME two stores
 * `commitStandupDraft` does — `DraftStore` (the drafted message text) and
 * `ItemStore` (a lightweight `blocker_escalation` `InboxItem`, joining the
 * same shared per-person inbox, ranked LAST per FLEETGRAPH.MD's "Who it
 * notifies": "Escalation to a manager exists but is last"). Nothing in this
 * chain — or anywhere upstream of `gate.ts` — ever sends the drafted
 * message; `DeepShipClientLike` has no write method to call in the first
 * place (same structural guarantee the deep tier already relies on).
 *
 * ---- Retro delivery drafting (TRO-335 / FG-17) ---------------------------
 *
 * FLEETGRAPH.MD's use case 3, verbatim: "When the retro window opens for a
 * week whose plan carries at least one success criterion: pre-fill the
 * delivered section from issues that actually closed in that week, mapped
 * against each criterion, and call out the criteria with no matching closed
 * work so they can be explained rather than silently dropped." Same
 * trigger-model shape as FG-6/FG-19: a NEW trigger (`proactive_retro`)
 * requiring `weekId`, not a branch bolted onto an existing chain — "the week
 * ends" produces no change for a poller to observe in the first place
 * (FLEETGRAPH.MD's own Trigger Model section: "nothing writes a row when a
 * week ends... the trigger is date arithmetic on the week number, on a
 * schedule, not an event"), so there is nothing here for `proactive_fast`/
 * `proactive_steady` to detect even in principle. Same posture as FG-6/FG-19
 * again: there is deliberately no scheduler in this file (or anywhere in
 * this package) that decides WHICH week's retro window is open and WHEN; a
 * real trigger route is a future ticket's job (`retroDraft.ts`'s own module
 * docstring says so too).
 *
 * `gatherRetroActivity` fetches the week (a `sprint` document — see
 * `retroDraft.ts`'s module docstring for the `weekly_plan`/`weekly_retro`
 * naming trap this deliberately avoids) and every issue that closed within
 * it (`retroDraft.ts`'s `gatherWeekDelivery` — no model call, but a real
 * network call to compute the week's own calendar window; see that
 * function's docstring for why a date window is load-bearing here and not
 * optional polish). It then evaluates three gates itself, before any model
 * spend: the week must carry at least one success criterion (the ticket's
 * OWN condition, not a waste-control heuristic like FG-6's), it must have a
 * recorded owner (the "who to draft for" this chain is drafting on behalf
 * of — see `retroDraft.ts` for why `properties.owner_id` is safe to read as
 * a plain `users.id` here), and its calendar window must have been
 * computable at all (`weekDatesUnavailable` — the closed-issue set cannot
 * be trusted otherwise). Any gate failing sets `retroSkipReason` and skips
 * straight through: no model call, no draft, no inbox item — the same
 * "check before spending" posture `gatherStandupActivity`'s waste-control
 * check and `detectBlockerFanout`'s project/people gates already use.
 *
 * `composeRetroDraft` is the ONLY node in this chain that calls the
 * model — same shape as `composeStandupDraft`/`composeBlockerEscalation`: a
 * deterministic prompt (`buildRetroPrompt`) built entirely from the gathered
 * `WeekDeliverySummary`, instructed to map each closed issue to the
 * criterion/criteria it evidences and to name every criterion left
 * unmatched (the ticket's own proof condition), never inventing an issue or
 * criterion the gather step did not find.
 *
 * `commitRetroDraft` writes into the SAME two stores `commitStandupDraft`/
 * `commitBlockerEscalation` do — `DraftStore` (the drafted delivered-section
 * text, keyed `retro-draft:{weekId}`, an upsert on re-invocation for the
 * same week) and `ItemStore` (a lightweight `retro_draft` `InboxItem`,
 * joining the same shared per-person inbox, ranked alongside
 * `standup_draft` — see `itemStore.ts`'s own `TYPE_RANK` docstring). Nothing
 * in this chain — or anywhere upstream of `gate.ts` — ever submits the
 * drafted retro; `DeepShipClientLike` has no write method to call in the
 * first place (same structural guarantee every deep-tier chain relies on).
 * The human "edits, adds unplanned work the agent cannot see, and submits"
 * (the ticket's own words) — this chain never sees or drafts unplanned
 * work, only what it can verify closed.
 *
 * ---- Plan-change discrimination (TRO-336 / FG-18) -------------------------
 *
 * FLEETGRAPH.MD's use case 4, verbatim: "A weekly plan is edited after it
 * was approved" -> "What materially changed, before and after side by
 * side, plus a drafted re-approval request or a drafted question to the
 * author." The ticket's own framing is sharper: "the 'plan changed after
 * approval' flag trips on typo fixes, so managers ignore it — and a quiet
 * scope cut looks identical... The detection is not the missing piece —
 * the discrimination is."
 *
 * "The detection" is Ship's own, already correct: `PATCH /api/weeks/:id`
 * (`weeks.ts:1910-1921`) already flips `properties.plan_approval.state`
 * from `'approved'` to `'changed_since_approved'` the instant
 * `success_criteria`/`plan` changes on an approved week. This chain does
 * NOT re-detect that — `detectPlanChange` reads it directly off the week
 * document as its own trigger CONDITION (mirroring how `detectBlockerFanout`
 * reads `blocks` associations rather than re-deriving them). Same trigger
 * shape as FG-6/FG-17/FG-19 again: a required `weekId` (reusing the field
 * `proactive_retro` already declares — see `GraphState`'s own comment on
 * it), no scheduler in this file that decides which week's flag to check and
 * when (a future ticket's job, identical posture to every prior deep-tier
 * chain here).
 *
 * `detectPlanChange` gathers the "before"/"after" success-criteria snapshot
 * and computes an alignment (`planChangeDraft.ts`'s `gatherPlanChange`/
 * `alignCriteria`), for the real discrepancy this ticket found between its
 * own "Verified" citations and what the reachable seed fixture actually
 * populates — the same class of gap TRO-335 found in its own ticket. It
 * gates on FOUR conditions before any model call: the week must actually be
 * `'changed_since_approved'` (`not_changed_since_approval` skip otherwise —
 * this is the ticket's OWN detection signal, already correct); it must have
 * a recorded approver to route the draft to (`no_approver` skip); a usable
 * "before" snapshot must exist (`no_diff_source` skip — never guessed at);
 * and `alignCriteria` must find at least one criterion that is not
 * EXACTLY identical after whitespace normalization (`no_material_change`
 * skip otherwise) — this LAST gate is the full, provable guarantee behind
 * "a whitespace... change must produce nothing," and no more than that:
 * `alignCriteria` deliberately does NOT try to also classify a genuine
 * character-level typo as non-material, because a first attempt at doing
 * that with a similarity threshold was PROVEN WRONG against real example
 * text (`planChangeDraft.ts`'s own module docstring has the numbers) — a
 * fixed edit-distance score cannot reliably tell a typo from a weakened
 * requirement, since both can land at similar or even inverted similarity
 * scores depending on sentence length. Whitespace-only changes are the one
 * case this file can prove without the model; everything else is a
 * genuine judgment call.
 *
 * `composePlanChangeDraft` is the ONLY node in this chain that calls the
 * model, and it is the ONE node in this entire package where the model
 * decides more than phrasing — `buildPlanChangePrompt` requires a
 * `MATERIAL`/`NOT MATERIAL` verdict as the first line of the response, and
 * `parseMaterialityVerdict` (`planChangeDraft.ts`) reads it: `MATERIAL`
 * sets `planChangeDraftText` to what follows; `NOT MATERIAL` sets
 * `planChangeSkipReason: 'no_material_change'` — the SAME skip reason
 * `detectPlanChange`'s deterministic gate can also set, now decided by the
 * model instead for a case the deterministic gate correctly declined to
 * judge. A malformed response (neither prefix) degrades to `MATERIAL` with
 * the whole response as the draft — the asymmetric-cost reasoning
 * FLEETGRAPH.MD's own "Precision, and why the bar moved" section states
 * generally: a false positive here costs a few seconds to dismiss; a false
 * negative silently reproduces the exact bug this ticket exists to fix.
 *
 * `commitPlanChangeDraft` writes into the SAME two stores every other
 * deep-tier chain does — `DraftStore` (keyed `plan-change-draft:{weekId}`,
 * an upsert on re-invocation for the same week) and `ItemStore` (a
 * lightweight `plan_change_draft` `InboxItem`, addressed to the APPROVER —
 * `plan_approval.approved_by` — joining the same shared per-person inbox,
 * ranked alongside `standup_draft`/`retro_draft`). Nothing in this chain —
 * or anywhere upstream of `gate.ts` — ever writes an approval state or
 * sends the drafted question; `DeepShipClientLike` has no write method to
 * call in the first place. The ticket names this explicitly as "the one
 * place where violating [the draft-only gate] would be most tempting and
 * most damaging, since these documents feed federal performance ratings" —
 * enforced the same structural way every other hard limit in this package
 * is: the type the graph holds has nothing to call.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ChangeFeedResponse, DeepShipClientLike, OnDemandShipClientLike, ShipClientLike, ShipPerson } from './shipClient.js';
import type { ItemStore, NewInboxItem } from './itemStore.js';
import { buildBlockingApprovalItems, buildMentionItems, pollChangeFeed } from './proactive.js';
import {
  buildCandidatesFromDocument,
  buildCitedSources,
  buildExpansionPrompt,
  capNoticeText,
  sortFrontierByRelevance,
  visitDocument,
  type CitedSource,
  type ExpandedDocument,
  type ExpansionCandidate,
} from './expansion.js';
import type { DraftStore, ProposedTransition } from './draftStore.js';
import {
  buildProposedTransitions,
  buildStandupPrompt,
  findStandupAnchor,
  gatherPersonActivity,
  type PersonActivitySummary,
  type StandupAnchor,
} from './standupDraft.js';
import { buildBlockerEscalationPrompt, gatherBlockerFanout, type BlockerFanoutImpact } from './blockerFanout.js';
import { buildRetroPrompt, gatherWeekDelivery, type WeekDeliverySummary } from './retroDraft.js';
import {
  buildPlanChangePrompt,
  gatherPlanChange,
  parseMaterialityVerdict,
  type PlanChangeSummary,
} from './planChangeDraft.js';
import { findLowestCommonManager, type LowestCommonManagerResult } from './roles.js';
import type { CostTracker, InvocationSite, RealUsage } from './costTracking.js';

/** The subset of ChatAnthropic's interface this graph actually needs — narrow
 * on purpose so tests can pass a plain object instead of a real client.
 *
 * `usage_metadata` and `model` (TRO-339 / FG-21) were added to this
 * interface after confirming, by reading `@langchain/core`'s own
 * `AIMessage`/`AIMessageChunk` typings directly, that a real
 * `ChatAnthropic.invoke()` call genuinely returns both at runtime — this
 * narrow interface was silently discarding them by construction of the
 * type before this ticket. Both are optional so every existing test double
 * (`{ invoke: () => ({ content: ... }) }`, no usage field, no model field)
 * keeps compiling and passing unchanged; a double that omits `usage_metadata`
 * simply produces no cost-tracking record for that call (see
 * `recordInvocation` below), which is correct — this file must never
 * fabricate a token count nobody reported. */
export interface AnthropicModel {
  invoke(input: string): Promise<{ content: unknown; usage_metadata?: RealUsage }>;
  /** The model identifier, when the injected model exposes one — the real
   * `ChatAnthropic` instance does, via its own public `.model` field.
   * Recording this per call (not once per `buildGraph` call) is what makes
   * a future second model tier visible for free, per the ticket's own
   * instruction. */
  model?: string;
}

/** Why the graph is running this invocation. `on_demand` is FG-2's original
 * chat path. `proactive_fast`/`proactive_steady` both route to the same
 * poll-based node chain FG-5 builds — the ticket's trigger table
 * (FLEETGRAPH.MD) treats them as two cadences of the same deterministic
 * work, not different logic. `proactive_deep` (drafting, once-per-window
 * composition, TRO-319 / FG-6) routes to `gatherStandupActivity` — see the
 * module docstring's "Deep tier draft composition" section.
 * `proactive_escalation` (TRO-346/TRO-337 / FG-19) routes to
 * `detectBlockerFanout` — see the module docstring's "Blocker escalation
 * fan-out" section, including why this is its own trigger rather than a
 * branch on the fast/steady chain. `proactive_retro` (TRO-335 / FG-17)
 * routes to `gatherRetroActivity` — see the module docstring's "Retro
 * delivery drafting" section, same "own trigger, own required field"
 * reasoning again. `proactive_plan_change` (TRO-336 / FG-18) routes to
 * `detectPlanChange` — see the module docstring's "Plan-change
 * discrimination" section, same reasoning once more. */
export type TriggerKind =
  | 'on_demand'
  | 'proactive_fast'
  | 'proactive_steady'
  | 'proactive_deep'
  | 'proactive_escalation'
  | 'proactive_retro'
  | 'proactive_plan_change';

export const GraphState = Annotation.Root({
  /** The raw incoming request text (a question, a trigger payload, etc). */
  input: Annotation<string>(),
  /** The model's response, once `respond` has run. */
  output: Annotation<string>(),

  /** Defaults to 'on_demand' so every FG-2 call site/test that never sets
   * this keeps routing through `ingest` -> `respond` unchanged. */
  trigger: Annotation<TriggerKind>({
    reducer: (current, update) => update ?? current,
    default: () => 'on_demand',
  }),

  /** The lagged change-feed cursor (FG-1's own `since`/`next_cursor`
   * contract — an ISO 8601 string). `undefined` on a graph's first-ever
   * proactive run; `pollChangeFeed` bootstraps a lookback window in that
   * case rather than requiring every caller to know Ship's cursor format
   * up front. */
  cursor: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The raw change-feed page fetched this run, before resolution. */
  changeFeedPage: Annotation<ChangeFeedResponse | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The people directory (`GET /api/team/people`), fetched once per run
   * alongside the change feed — both `resolveMentions` and
   * `detectBlockingApprovals` need it (mention-doc-id -> user id, and
   * owner -> manager, respectively). */
  people: Annotation<ShipPerson[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),

  /** Inbox items produced this run, not yet written to the store —
   * `commitInboxItems` does that. A concatenating reducer (not
   * last-write-wins) so `resolveMentions` and `detectBlockingApprovals`
   * both append to the SAME list without clobbering each other — the seam
   * FG-6/FG-7 extend with their own producer nodes. */
  inboxItems: Annotation<NewInboxItem[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  /** Item ids whose condition ended THIS run (ticket proof #2: "an item is
   * cleared automatically when its condition ends") — also concatenating,
   * for the same reason as `inboxItems`. */
  clearedItemIds: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  // ---- On-demand expansion (TRO-318 / FG-7) -------------------------------

  /** The document open when the question was asked — "the open document
   * seeds the question" (ticket). Presence of this field (not `trigger`
   * alone) is what routes `on_demand` into the expansion path rather than
   * the bare `ingest -> respond` chain; see the module docstring. */
  seedDocumentId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Whose token this run is authenticated as — reused as a second,
   * independent visibility check (`expansion.ts`'s `passesAskerVisibility`)
   * on top of Ship's own server-side 404s. Optional: see that function's
   * docstring for what happens when a caller hasn't wired it through yet. */
  askingUserId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Documents discovered but not yet visited, kept sorted by relevance
   * (`sortFrontierByRelevance`) — a real priority queue, not a FIFO. Fully
   * replaced each node call (last-write-wins), unlike `inboxItems`: only
   * `expandFrontier` ever produces the "next" frontier, so there is no
   * multi-producer append to reconcile. */
  frontier: Annotation<ExpansionCandidate[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),

  /** Every document id the walk has ATTEMPTED to visit, success or failure —
   * the walk's own cycle guard, independent of whatever cycle protection the
   * database promises (`document_associations`' BEFORE trigger is
   * per-relationship-type and not race-proof under concurrent writers — see
   * migration 040's own docstring and `memory-bank/fleetgraph-backlog.md`:
   * "FG-7's traversal must carry its own hard document cap and its own
   * visited-set regardless of what the database promises here"). Note this
   * is a SUPERSET of `expandedDocuments`' ids — a document that 404s (gone,
   * or invisible to this token) still lands here so it is never retried via
   * a second edge, even though it never becomes evidence. */
  visitedDocumentIds: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  /** Documents successfully pulled into context, in visit order — what the
   * hard cap actually counts against (`expandedDocuments.length`), and the
   * source `finalizeExpansion` builds `citedSources` from. */
  expandedDocuments: Annotation<ExpandedDocument[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),

  /** The output-facing citation list — "It names every document it pulled
   * in and why" (ticket). Built once, by `finalizeExpansion`, directly from
   * `expandedDocuments`. */
  citedSources: Annotation<CitedSource[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),

  /** True when `expandFrontier` stopped because `documentCap` was reached
   * with candidates still unexplored — ticket proof #2: "says so rather
   * than truncating silently." False (the ordinary case) means the frontier
   * simply ran out on its own. */
  expansionCapped: Annotation<boolean>({
    reducer: (current, update) => update ?? current,
    default: () => false,
  }),

  // ---- Deep tier draft composition (TRO-319 / FG-6) -----------------------

  /** Which person's draft this invocation composes — REQUIRED for
   * `trigger: 'proactive_deep'` (one invocation, one person's draft; see the
   * module docstring). No default beyond `undefined`: `gatherStandupActivity`
   * throws a clear error if this trigger runs without one, rather than
   * silently composing nothing or guessing a recipient. */
  targetPersonUserId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The "since their last standup" anchor `gatherStandupActivity` resolved
   * (`standupDraft.ts`'s `findStandupAnchor`). */
  standupAnchor: Annotation<StandupAnchor | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The classified activity `gatherStandupActivity` gathered — moved /
   * commented / stale issues plus whether anything moved at all
   * (`hasAnyActivity`, proof #2's "nothing moved" signal). `undefined` only
   * if the run never reached that node (should not happen on this trigger's
   * own path, but left optional rather than asserted, matching this file's
   * existing style for every other per-run-computed field). */
  standupActivity: Annotation<PersonActivitySummary | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Set by `gatherStandupActivity` when the waste-control stop condition
   * fires (`DraftStore.shouldGenerateDraftFor` returned false — "cost cliff
   * #3"). `composeStandupDraft` reads this to skip its model call entirely,
   * and `commitStandupDraft` reads it to skip writing anything. */
  standupSkipReason: Annotation<'ignored_by_recipient' | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The model's composed draft text, once `composeStandupDraft` has run.
   * `undefined` when the run was skipped (`standupSkipReason` set). */
  standupDraftText: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Observed state changes, packaged with their evidence — "attaches a
   * proposed transition on the one in review" (proof #1). Never applied by
   * this or any node; see `standupDraft.ts`'s `buildProposedTransitions`
   * docstring. */
  standupProposedTransitions: Annotation<ProposedTransition[]>({
    reducer: (current, update) => update ?? current,
    default: () => [],
  }),

  // ---- Blocker escalation fan-out (TRO-346/TRO-337 / FG-19) ---------------

  /** Which issue's fan-out this invocation evaluates — REQUIRED for
   * `trigger: 'proactive_escalation'` (one invocation, one blocking issue;
   * see the module docstring's "Blocker escalation fan-out" section).
   * Same required-field posture as `targetPersonUserId`:
   * `detectBlockerFanout` throws a clear error if this trigger runs without
   * one, rather than silently doing nothing or guessing which issue. */
  blockingIssueId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The full impact fan-out `detectBlockerFanout` gathered
   * (`blockerFanout.ts`'s `gatherBlockerFanout`) — which issues, projects,
   * and people are touched. Set even when escalation turns out not to be
   * warranted (`blockerEscalationSkipReason` set alongside it), so a caller
   * can still inspect what was found. */
  blockerFanoutImpact: Annotation<BlockerFanoutImpact | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Set by `detectBlockerFanout` when escalation is NOT warranted —
   * TRO-337's own explicit non-escalation cases (proof #3: same reporting
   * line) plus the gates that must hold before the walk even asks the
   * question (too few distinct projects/people to have a "different lines"
   * problem at all, or the blocking issue itself was gone/inaccessible).
   * `composeBlockerEscalation` reads this to skip its model call entirely,
   * and `commitBlockerEscalation` reads it to skip writing anything —
   * identical shape to `standupSkipReason`. */
  blockerEscalationSkipReason: Annotation<
    | 'issue_not_found'
    | 'single_project'
    | 'insufficient_people'
    | 'same_reporting_line'
    | 'people_unavailable'
    | undefined
  >({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The lowest-common-manager result (`roles.ts`'s
   * `findLowestCommonManager`) once `detectBlockerFanout` has determined
   * escalation IS warranted. `reason: 'found'` carries a confirmed
   * `managerUserId`; `reason: 'no_common_manager'` carries no confirmed
   * manager but may carry `highestReachableUserId` — TRO-337's own
   * "degrades to a usable answer" requirement. `undefined` when the run
   * never reached that decision (escalation was skipped, or the node never
   * ran). */
  blockerEscalationManager: Annotation<LowestCommonManagerResult | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The model's composed escalation message, once `composeBlockerEscalation`
   * has run. `undefined` when the run was skipped
   * (`blockerEscalationSkipReason` set). */
  blockerEscalationDraftText: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  // ---- Retro delivery drafting (TRO-335 / FG-17) --------------------------

  /** Which week this invocation operates on — REQUIRED for both
   * `trigger: 'proactive_retro'` (one invocation, one week's retro; see the
   * module docstring's "Retro delivery drafting" section) AND
   * `trigger: 'proactive_plan_change'` (one invocation, one week's
   * plan-change check; see "Plan-change discrimination"). Shared rather
   * than duplicated (`retroWeekId`/`planChangeWeekId`) because both triggers
   * mean the same thing by it — a `sprint` document's id — and never run in
   * the same invocation to collide over it. Same required-field posture as
   * `targetPersonUserId`/`blockingIssueId`: `gatherRetroActivity`/
   * `detectPlanChange` each throw a clear error if their own trigger runs
   * without one, rather than silently doing nothing or guessing which week. */
  weekId: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The full delivery summary `gatherRetroActivity` gathered
   * (`retroDraft.ts`'s `gatherWeekDelivery`) — the week's success criteria,
   * its owner, and every issue that closed within it. Set even when the
   * trigger condition is not met (`retroSkipReason` set alongside it), so a
   * caller can still inspect what was found. */
  weekDeliverySummary: Annotation<WeekDeliverySummary | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Set by `gatherRetroActivity` when the trigger condition is NOT met, or
   * when the closed-issue set cannot be trusted — the week itself was
   * gone/inaccessible/not a `sprint` document (`'week_not_found'`), it
   * carries no success criteria at all (the ticket's own trigger condition:
   * `'no_success_criteria'`), it has no recorded owner to draft for
   * (`'no_owner'`), or its own calendar window could not be computed
   * (`'week_dates_unavailable'` — see `retroDraft.ts`'s
   * `WeekDeliverySummary.weekDatesUnavailable` for why this is a real,
   * verified failure mode, not a theoretical one). `composeRetroDraft` reads
   * this to skip its model call entirely, and `commitRetroDraft` reads it
   * to skip writing anything — identical shape to `standupSkipReason`/
   * `blockerEscalationSkipReason`. */
  retroSkipReason: Annotation<
    'week_not_found' | 'no_success_criteria' | 'no_owner' | 'week_dates_unavailable' | undefined
  >({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The model's composed "what I delivered" text, once `composeRetroDraft`
   * has run. `undefined` when the run was skipped (`retroSkipReason` set). */
  retroDraftText: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  // ---- Plan-change discrimination (TRO-336 / FG-18) -----------------------

  /** The full plan-change summary `detectPlanChange` gathered
   * (`planChangeDraft.ts`'s `gatherPlanChange`) — the week's approval
   * state, its approver, and (when reachable) the materiality-aligned
   * criteria diff. Set even when the trigger condition is not met
   * (`planChangeSkipReason` set alongside it), so a caller can still
   * inspect what was found. */
  planChangeSummary: Annotation<PlanChangeSummary | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** Set by `detectPlanChange` BEFORE any model call when the trigger
   * condition is not met or the change cannot be trusted — the week itself
   * was gone/inaccessible/not a `sprint` document (`'week_not_found'`); its
   * `plan_approval.state` is not `'changed_since_approved'`, Ship's OWN
   * detection signal not having fired (`'not_changed_since_approval'`); it
   * has no recorded approver to route a draft to (`'no_approver'`); no
   * "before" criteria snapshot could be found in either `document_history`
   * or `plan_history` (`'no_diff_source'` — never guessed at, see
   * `planChangeDraft.ts`'s own module docstring); or every criterion is
   * identical after whitespace normalization (`'no_material_change'` —
   * the ONE materiality question this file answers without the model, see
   * `planChangeDraft.ts`'s `alignCriteria`). `'no_material_change'` can
   * ALSO be set AFTER a model call, by `composePlanChangeDraft` itself,
   * when the model's own `NOT MATERIAL` verdict decides a change that
   * survived the deterministic gate (e.g. a genuine typo) still is not
   * material — see the module docstring's "Why the model decides
   * materiality here" section. `'empty_draft'` is the defensive edge case
   * (CodeRabbit, TRO-336 PR review) where the model returns `MATERIAL` but
   * writes nothing after the verdict line — never expected from a real
   * model, but `commitPlanChangeDraft`'s own guard already refuses to write
   * an empty draft either way; this reason exists so a caller inspecting
   * `planChangeSkipReason` sees WHY nothing was written instead of the
   * field staying `undefined` despite no draft existing. Whichever reason
   * applies, `commitPlanChangeDraft` reads it to skip writing anything —
   * identical shape to `retroSkipReason`/`blockerEscalationSkipReason`. */
  planChangeSkipReason: Annotation<
    | 'week_not_found'
    | 'not_changed_since_approval'
    | 'no_approver'
    | 'no_diff_source'
    | 'no_material_change'
    | 'empty_draft'
    | undefined
  >({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),

  /** The model's composed question text, once `composePlanChangeDraft` has
   * run. `undefined` when the run was skipped (`planChangeSkipReason`
   * set). */
  planChangeDraftText: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
});

export type GraphStateType = typeof GraphState.State;

/** Node names, exported so both the smoke test and any future caller can
 * assert against a single source of truth rather than a string literal. */
export const NODE_NAMES = [
  'ingest',
  'respond',
  'pollChangeFeed',
  'resolveMentions',
  'detectBlockingApprovals',
  'commitInboxItems',
  'resolveSeed',
  'expandFrontier',
  'finalizeExpansion',
  'composeAnswer',
  'gatherStandupActivity',
  'composeStandupDraft',
  'commitStandupDraft',
  'detectBlockerFanout',
  'composeBlockerEscalation',
  'commitBlockerEscalation',
  'gatherRetroActivity',
  'composeRetroDraft',
  'commitRetroDraft',
  'detectPlanChange',
  'composePlanChangeDraft',
  'commitPlanChangeDraft',
] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/** Dependencies the proactive path needs, injected the same way `model` is
 * (buildGraph's existing pattern) — a real `ShipClient`/`ItemStore` are
 * wired in `index.ts`; tests inject stable fakes. Optional on `buildGraph`
 * itself so every existing FG-2 on-demand test/call site keeps compiling
 * unchanged; a proactive node throws a clear error if it ever runs without
 * these, rather than silently doing nothing. */
export interface ProactiveDeps {
  shipClient: ShipClientLike;
  itemStore: ItemStore;
  /** How many rows `GET /api/change-feed` returns per poll. Omitted =
   * Ship's own default (`DEFAULT_CHANGE_FEED_LIMIT`, currently 100). */
  changeFeedLimit?: number;
  /** Injected clock — tests never depend on real wall-clock time
   * (lessons.md #17). Only used to bootstrap the FIRST poll's `since` when
   * no cursor has been carried forward yet. */
  now?: () => Date;
  /** How far back the very first poll (no prior cursor) looks — default 24h,
   * a generous catch-up window for "the agent just started/redeployed",
   * matching `itemStore.ts`'s "at most one poll cycle of delay" contract. */
  initialLookbackMs?: number;
}

const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Dependencies the on-demand expansion path needs (TRO-318 / FG-7) — same
 * injection pattern as `ProactiveDeps`. Optional on `buildGraph` itself so
 * every bare on-demand call (`ingest -> respond`, no seed document) is
 * unaffected; a missing dep only surfaces as an error once a caller actually
 * tries to run the expansion path (`requireOnDemandDeps`, mirroring
 * `requireProactiveDeps`).
 *
 * `documentCap` has NO default anywhere in this file, deliberately: the
 * ticket calls it "a required parameter, not a nice-to-have" — "following
 * every edge from every document is unbounded, and on-demand is already 64%
 * of projected spend" (FLEETGRAPH.MD's Cost Analysis). Making it a required
 * field (not `documentCap?: number`) means TypeScript itself refuses to
 * compile a call site that constructs `OnDemandDeps` without one — the cap
 * cannot be silently forgotten, only explicitly chosen. Production wires a
 * concrete number from config (`index.ts`); nothing in this file guesses one.
 */
export interface OnDemandDeps {
  shipClient: OnDemandShipClientLike;
  /** Hard ceiling on documents pulled into context, counting the seed
   * itself. Required — see this interface's own docstring. */
  documentCap: number;
  /** How many of a person's OTHER assigned issues become candidates per
   * visited issue, before ranking/cap take over. Omitted = `expansion.ts`'s
   * own default (5). */
  assigneeCandidateLimit?: number;
  /** How many of a visited document's comments (most recent first) become
   * evidence text. Omitted = `expansion.ts`'s own default (3). */
  commentSnippetLimit?: number;
}

/**
 * Dependencies the deep-tier draft composition path needs (TRO-319 / FG-6) —
 * same injection pattern as `ProactiveDeps`/`OnDemandDeps`. Optional on
 * `buildGraph` itself so no existing call site is affected; a missing dep
 * only surfaces once a caller actually invokes `trigger: 'proactive_deep'`
 * (`requireDeepDeps`, mirroring the other two `require*Deps` helpers).
 *
 * `itemStore` is typed identically to `ProactiveDeps.itemStore` — production
 * wiring (`index.ts`) passes the SAME instance to both, so a standup-draft
 * item lands in the exact shared per-person inbox FG-5's mention/
 * blocking-approval items already use (see the module docstring's "Deep
 * tier draft composition" section for why this is one shared inbox rather
 * than a second, parallel one). Kept as its own field — not folded into
 * `ProactiveDeps` — so a caller can wire the deep tier without also needing
 * a `shipClient` shaped for the (different) proactive-fast contract.
 */
export interface DeepDeps {
  shipClient: DeepShipClientLike;
  itemStore: ItemStore;
  draftStore: DraftStore;
  /** Injected clock — tests never depend on real wall-clock time
   * (lessons.md #17), matching `ProactiveDeps.now`. */
  now?: () => Date;
  /** First-ever-standup lookback — omitted = `standupDraft.ts`'s own
   * default (7 days, matching Ship's own sprint length). */
  initialLookbackMs?: number;
  /** How many rows `GET /api/change-feed` returns for the activity window —
   * omitted = `standupDraft.ts`'s own default (500). */
  changeFeedLimit?: number;
  /** The waste-control stop condition's window, in days — omitted =
   * `draftStore.ts`'s own default (14, the ticket's own number: "if a
   * person ignores their drafts for two weeks, stop generating them"). */
  ignoreThresholdDays?: number;
}

/** Narrows to Anthropic's native `{ type: 'text', text: string, ... }` content block shape. */
function hasStringText(value: unknown): value is { text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof (value as Record<string, unknown>).text === 'string'
  );
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  // A native text block (`{ type: 'text', text: '...' }`) carries its own
  // string payload — return that directly rather than stringifying the
  // whole object around it.
  if (hasStringText(content)) return content.text;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (hasStringText(part)) return part.text;
        return JSON.stringify(part);
      })
      .join('');
  }
  return String(content);
}

function requireProactiveDeps(deps: ProactiveDeps | undefined, nodeName: NodeName): ProactiveDeps {
  if (!deps) {
    throw new Error(
      `graph node "${nodeName}" requires ProactiveDeps (shipClient/itemStore) — buildGraph was ` +
        'called with none. This node only runs for a proactive trigger; pass deps if the caller ' +
        'ever invokes the graph with trigger: "proactive_fast" | "proactive_steady".'
    );
  }
  return deps;
}

function requireOnDemandDeps(deps: OnDemandDeps | undefined, nodeName: NodeName): OnDemandDeps {
  if (!deps) {
    throw new Error(
      `graph node "${nodeName}" requires OnDemandDeps (shipClient/documentCap) — buildGraph was ` +
        'called with none. This node only runs when an on_demand trigger carries a ' +
        '`seedDocumentId`; pass deps if the caller ever sets one.'
    );
  }
  return deps;
}

function requireDeepDeps(deps: DeepDeps | undefined, nodeName: NodeName): DeepDeps {
  if (!deps) {
    throw new Error(
      `graph node "${nodeName}" requires DeepDeps (shipClient/itemStore/draftStore) — buildGraph ` +
        'was called with none. This node only runs for trigger: "proactive_deep"; pass deps if the ' +
        'caller ever invokes the graph with that trigger.'
    );
  }
  return deps;
}

/** Forwards one real model call's usage to the injected `CostTracker`
 * (TRO-339 / FG-21) — the seam every one of `respond`/`composeAnswer`/
 * `composeStandupDraft` calls right after its own `model.invoke(...)`.
 * A no-op, never throwing, when either `tracker` is `undefined` (no
 * tracker was wired — every existing on-demand/proactive/deep test and
 * call site that predates this ticket) or `usage` is `undefined` (the
 * injected model didn't report it — a bare test double, never the real
 * `ChatAnthropic`). Never invents a token count: absence of `usage` means
 * absence of a record, not a record of zero.
 *
 * `tracker.record(...)` itself is wrapped in try/catch (CodeRabbit,
 * TRO-339 round 2): a cost-accounting side effect (e.g. `FileCostTracker`
 * hitting a disk write failure) must never be able to fail the graph
 * response for a model call that already succeeded. On failure this logs a
 * warning (`console.warn`, this codebase's existing convention — see
 * `index.ts`) and does not rethrow.
 *
 * `async`, and `await`-ed by all three call sites below (CodeRabbit, GitHub
 * PR #122 round): `CostTracker.record` itself is now async
 * (`FileCostTracker.record` does a non-blocking `fs/promises` write instead
 * of a blocking `mkdirSync`/`appendFileSync` pair) — awaiting it here, still
 * inside the same try/catch, preserves the "never fails the real response"
 * guarantee while letting a genuine write failure (rejection, not just a
 * throw) still be caught and logged rather than becoming an unhandled
 * rejection. */
async function recordInvocation(
  tracker: CostTracker | undefined,
  // `InvocationSite` (`costTracking.ts`), not a hand-written duplicate union
  // (CodeRabbit, TRO-336 PR review) — a second copy of this list had already
  // drifted once in this same ticket (see `costTracking.ts`'s own module
  // docstring), and this call site was the other place it could drift again.
  node: InvocationSite,
  trigger: TriggerKind,
  model: string | undefined,
  usage: RealUsage | undefined,
  documentsPulled?: number
): Promise<void> {
  if (!tracker || !usage) return;
  try {
    await tracker.record({
      node,
      trigger,
      model: model ?? 'unknown',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      documentsPulled,
    });
  } catch (err) {
    console.warn(`[agent] cost tracker failed to record a "${node}" invocation (non-fatal):`, err);
  }
}

function requireTargetPersonUserId(state: GraphStateType, nodeName: NodeName): string {
  if (!state.targetPersonUserId) {
    throw new Error(
      `graph node "${nodeName}" requires state.targetPersonUserId — one "proactive_deep" ` +
        'invocation composes exactly one person\'s draft (the ticket\'s own cadence: "once per ' +
        'person per window"); pass targetPersonUserId when invoking the graph with that trigger.'
    );
  }
  return state.targetPersonUserId;
}

/** Same required-field posture as `requireTargetPersonUserId`, for the
 * blocker-escalation chain (TRO-346/TRO-337 / FG-19) — see the module
 * docstring's "Blocker escalation fan-out" section for why this is a
 * required field rather than something the node discovers on its own. */
function requireBlockingIssueId(state: GraphStateType, nodeName: NodeName): string {
  if (!state.blockingIssueId) {
    throw new Error(
      `graph node "${nodeName}" requires state.blockingIssueId — one "proactive_escalation" ` +
        'invocation evaluates exactly one blocking issue\'s fan-out; pass blockingIssueId when ' +
        'invoking the graph with that trigger.'
    );
  }
  return state.blockingIssueId;
}

/** Same required-field posture as `requireTargetPersonUserId`/
 * `requireBlockingIssueId`, for the retro-delivery chain (TRO-335 / FG-17) —
 * see the module docstring's "Retro delivery drafting" section for why this
 * is a required field rather than something the node discovers on its own. */
function requireWeekId(state: GraphStateType, nodeName: NodeName): string {
  if (!state.weekId) {
    throw new Error(
      `graph node "${nodeName}" requires state.weekId — one "proactive_retro"/"proactive_plan_change" ` +
        'invocation operates on exactly one week; pass weekId when invoking the graph with either trigger.'
    );
  }
  return state.weekId;
}

/** `START`'s routing keys — a superset of `TriggerKind` because `on_demand`
 * itself splits into two different node chains depending on whether a seed
 * document is present (see the module docstring). `proactive_deep` and bare
 * `on_demand` are valid VALUES of `TriggerKind` but `routeTrigger` never
 * returns them as-is; both are re-expressed as one of the keys below
 * (`on_demand` always becomes `on_demand_chat`/`on_demand_expand`), so the
 * exhaustive switch in `routeTrigger` never needs a cast to get there. */
type RouteKey =
  | 'on_demand_chat'
  | 'on_demand_expand'
  | 'proactive_fast'
  | 'proactive_steady'
  | 'proactive_deep'
  | 'proactive_escalation'
  | 'proactive_retro'
  | 'proactive_plan_change';

/** Routes `START` by `state.trigger` (and, for `on_demand`, by whether a
 * seed document was given) — the seam that lets every mode share one graph
 * without any path knowing the others exist. `proactive_deep` now has a
 * `pathMap` entry too (TRO-319 / FG-6, below) — FG-7 already wired this
 * switch's `proactive_deep` case in anticipation, ahead of the node it
 * routes to existing. `proactive_escalation` (TRO-346/TRO-337 / FG-19),
 * `proactive_retro` (TRO-335 / FG-17), and `proactive_plan_change`
 * (TRO-336 / FG-18) all follow the identical pattern. */
function routeTrigger(state: GraphStateType): RouteKey {
  switch (state.trigger) {
    case 'on_demand':
      return state.seedDocumentId ? 'on_demand_expand' : 'on_demand_chat';
    case 'proactive_fast':
      return 'proactive_fast';
    case 'proactive_steady':
      return 'proactive_steady';
    case 'proactive_deep':
      return 'proactive_deep';
    case 'proactive_escalation':
      return 'proactive_escalation';
    case 'proactive_retro':
      return 'proactive_retro';
    case 'proactive_plan_change':
      return 'proactive_plan_change';
  }
}

/** `expandFrontier`'s own self-loop condition: keep visiting while
 * candidates remain. `expandFrontier` itself is the ONLY place that ever
 * empties the frontier early (the hard-cap branch), so this router needs no
 * cap knowledge of its own — it just asks "is there still something to
 * visit," which is what makes the loop length genuinely variable run to run
 * (see the module docstring's proof-#4 discussion). */
function routeExpansionLoop(state: GraphStateType): 'expandFrontier' | 'finalizeExpansion' {
  return state.frontier.length > 0 ? 'expandFrontier' : 'finalizeExpansion';
}

/**
 * Build and compile the graph. `model` is injected so the compiled graph is
 * fully testable against a stable fake — see FG-2's "how it will be proven":
 * the smoke test asserts the compiled graph exposes its node set, never a
 * live call. `proactiveDeps` is the same pattern applied to FG-5's path —
 * optional so every existing on-demand call site/test is unaffected; see
 * `ProactiveDeps`'s own docstring for why a missing dep fails loudly rather
 * than silently. `deepDeps` (TRO-319 / FG-6) is the same pattern again —
 * see `DeepDeps`'s own docstring. `costTracker` (TRO-339 / FG-21) follows the
 * identical optional-injection pattern: omitted, every existing call site
 * (this file's own tests included) is unaffected; passed, every real
 * `model.invoke()` call site (`respond`/`composeAnswer`/`composeStandupDraft`)
 * forwards its usage to it via `recordInvocation`.
 */
export function buildGraph(
  model: AnthropicModel,
  proactiveDeps?: ProactiveDeps,
  onDemandDeps?: OnDemandDeps,
  deepDeps?: DeepDeps,
  costTracker?: CostTracker
) {
  const graph = new StateGraph(GraphState)
    .addNode('ingest', (state: GraphStateType) => ({ input: state.input.trim() }))
    .addNode('respond', async (state: GraphStateType) => {
      const result = await model.invoke(state.input);
      await recordInvocation(costTracker, 'respond', state.trigger, model.model, result.usage_metadata);
      return { output: contentToString(result.content) };
    })
    .addNode('pollChangeFeed', async (state: GraphStateType) => {
      const deps = requireProactiveDeps(proactiveDeps, 'pollChangeFeed');
      const now = deps.now ?? (() => new Date());
      const lookbackMs = deps.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS;
      const since = state.cursor ?? new Date(now().getTime() - lookbackMs).toISOString();

      const [{ feed, nextCursor }, people] = await Promise.all([
        pollChangeFeed(deps.shipClient, since, deps.changeFeedLimit),
        deps.shipClient.getPeople(),
      ]);

      return { changeFeedPage: feed, cursor: nextCursor, people };
    })
    .addNode('resolveMentions', async (state: GraphStateType) => {
      const deps = requireProactiveDeps(proactiveDeps, 'resolveMentions');
      if (!state.changeFeedPage) return {};
      const items = await buildMentionItems(deps.shipClient, state.changeFeedPage, state.people);
      return { inboxItems: items };
    })
    .addNode('detectBlockingApprovals', async (state: GraphStateType) => {
      const deps = requireProactiveDeps(proactiveDeps, 'detectBlockingApprovals');
      if (!state.changeFeedPage) return {};
      const { items, resolvedIds } = await buildBlockingApprovalItems(
        deps.shipClient,
        state.changeFeedPage,
        state.people
      );
      return { inboxItems: items, clearedItemIds: resolvedIds };
    })
    .addNode('commitInboxItems', (state: GraphStateType) => {
      const deps = requireProactiveDeps(proactiveDeps, 'commitInboxItems');
      for (const item of state.inboxItems) {
        deps.itemStore.upsert(item);
      }
      for (const id of state.clearedItemIds) {
        deps.itemStore.clear(id);
      }
      return {};
    })
    // ---- On-demand expansion (TRO-318 / FG-7) --------------------------
    .addNode('resolveSeed', async (state: GraphStateType) => {
      const deps = requireOnDemandDeps(onDemandDeps, 'resolveSeed');
      // Routing guarantees this (on_demand_expand only fires when
      // seedDocumentId is set), but the field is still Optional on
      // GraphState, so narrow it explicitly rather than asserting.
      if (!state.seedDocumentId) return {};

      const seed = await visitDocument(
        deps.shipClient,
        state.seedDocumentId,
        { reason: 'the document you had open', hop: 0 },
        state.askingUserId,
        deps.commentSnippetLimit
      );

      if (!seed) {
        // The seed itself is gone or not visible to this token — nothing to
        // expand from. `composeAnswer` reads an empty `expandedDocuments`
        // and says so, rather than guessing (`buildExpansionPrompt`).
        return { visitedDocumentIds: [state.seedDocumentId] };
      }

      const candidates = await buildCandidatesFromDocument(deps.shipClient, seed.doc, 1, {
        assigneeCandidateLimit: deps.assigneeCandidateLimit,
      });

      return {
        visitedDocumentIds: [seed.record.documentId],
        expandedDocuments: [seed.record],
        frontier: sortFrontierByRelevance(candidates.filter((c) => c.documentId !== seed.record.documentId)),
      };
    })
    .addNode('expandFrontier', async (state: GraphStateType) => {
      const deps = requireOnDemandDeps(onDemandDeps, 'expandFrontier');

      if (state.frontier.length === 0) {
        return {};
      }
      if (state.expandedDocuments.length >= deps.documentCap) {
        // Cap reached with candidates still unexplored — stop, and say so
        // (proof #2: "says so rather than truncating silently") via the
        // `expansionCapped` flag `composeAnswer` reads. Clearing the
        // frontier is what lets `routeExpansionLoop` exit on the next check.
        return { expansionCapped: true, frontier: [] };
      }

      const next = state.frontier[0];
      if (!next) {
        // Unreachable given the length check above — kept as an explicit
        // runtime guard (rather than a type assertion) to stay honest under
        // `noUncheckedIndexedAccess` (lessons.md #16/#21).
        return {};
      }
      const rest = state.frontier.slice(1);

      if (state.visitedDocumentIds.includes(next.documentId)) {
        // Reached via a second edge after already being attempted (success
        // or failure) — the walk's own visited-set cycle guard. Skipping
        // here costs no cap budget, since nothing new is being pulled in.
        return { frontier: rest };
      }

      const visited = await visitDocument(
        deps.shipClient,
        next.documentId,
        next,
        state.askingUserId,
        deps.commentSnippetLimit
      );

      if (!visited) {
        return { visitedDocumentIds: [next.documentId], frontier: rest };
      }

      const discovered = await buildCandidatesFromDocument(deps.shipClient, visited.doc, next.hop + 1, {
        assigneeCandidateLimit: deps.assigneeCandidateLimit,
      });

      const alreadyKnown = new Set([
        ...state.visitedDocumentIds,
        visited.record.documentId,
        ...rest.map((c) => c.documentId),
      ]);
      const newCandidates = discovered.filter((c) => !alreadyKnown.has(c.documentId));

      return {
        visitedDocumentIds: [visited.record.documentId],
        expandedDocuments: [visited.record],
        frontier: sortFrontierByRelevance([...rest, ...newCandidates]),
      };
    })
    .addNode('finalizeExpansion', (state: GraphStateType) => {
      return { citedSources: buildCitedSources(state.expandedDocuments) };
    })
    .addNode('composeAnswer', async (state: GraphStateType) => {
      const prompt = buildExpansionPrompt(state.input, state.expandedDocuments);
      const result = await model.invoke(prompt);
      // documentsPulled (cost cliff #2, TRO-339): how far this on-demand run
      // expanded the graph, so FG-7's hard document cap can be tuned against
      // evidence rather than guessed.
      await recordInvocation(
        costTracker,
        'composeAnswer',
        state.trigger,
        model.model,
        result.usage_metadata,
        state.expandedDocuments.length
      );
      const modelOutput = contentToString(result.content);
      const deps = requireOnDemandDeps(onDemandDeps, 'composeAnswer');
      const output = state.expansionCapped ? `${modelOutput}${capNoticeText(deps.documentCap)}` : modelOutput;
      return { output };
    })
    // ---- Deep tier draft composition (TRO-319 / FG-6) -------------------
    .addNode('gatherStandupActivity', async (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'gatherStandupActivity');
      const personUserId = requireTargetPersonUserId(state, 'gatherStandupActivity');
      const now = deps.now ?? (() => new Date());

      // Waste control (ticket's "cost cliff #3") — checked BEFORE any
      // gathering or model spend, not after: if this person has ignored
      // their last several drafts for the threshold window, skip entirely.
      if (!deps.draftStore.shouldGenerateDraftFor(personUserId, deps.ignoreThresholdDays)) {
        return { standupSkipReason: 'ignored_by_recipient' as const };
      }

      const anchor = await findStandupAnchor(deps.shipClient, personUserId, now, deps.initialLookbackMs);
      const activity = await gatherPersonActivity(deps.shipClient, personUserId, anchor, {
        now,
        changeFeedLimit: deps.changeFeedLimit,
      });

      return { standupAnchor: anchor, standupActivity: activity };
    })
    .addNode('composeStandupDraft', async (state: GraphStateType) => {
      requireDeepDeps(deepDeps, 'composeStandupDraft');
      if (state.standupSkipReason) {
        // Waste control's whole point: no model call, no spend, when the
        // recipient has been ignoring their drafts.
        return {};
      }
      if (!state.standupActivity) return {};

      const prompt = buildStandupPrompt(state.standupActivity);
      const result = await model.invoke(prompt);
      await recordInvocation(costTracker, 'composeStandupDraft', state.trigger, model.model, result.usage_metadata);
      const draftText = contentToString(result.content);
      const proposedTransitions = buildProposedTransitions(state.standupActivity.moved);

      return { standupDraftText: draftText, standupProposedTransitions: proposedTransitions };
    })
    .addNode('commitStandupDraft', (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'commitStandupDraft');
      if (state.standupSkipReason || !state.standupDraftText) {
        // Either skipped (waste control) or nothing to commit (e.g. the
        // gather step never ran) — never write a partial/empty draft.
        return {};
      }
      const personUserId = requireTargetPersonUserId(state, 'commitStandupDraft');
      const now = deps.now ?? (() => new Date());
      const windowDate = now().toISOString().slice(0, 10);
      const draftId = `standup-draft:${personUserId}:${windowDate}`;

      const draft = deps.draftStore.upsert({
        id: draftId,
        personUserId,
        windowDate,
        draftText: state.standupDraftText,
        proposedTransitions: state.standupProposedTransitions,
      });

      // Evidence a real Ship document whenever one is available — the most
      // significant gathered activity item, falling back to the anchor
      // standup, matching `InboxItemEvidence`'s original (pre-FG-6)
      // contract wherever a candidate exists. Both can legitimately be
      // absent (a first-ever draft for someone with no assigned issues);
      // `documentId`/`documentType` are optional precisely for that case
      // (see `itemStore.ts`'s own docstring).
      const activity = state.standupActivity;
      const evidenceIssue = activity ? (activity.moved[0] ?? activity.commented[0] ?? activity.stale[0]) : undefined;
      const summary = !activity || activity.hasAnyActivity
        ? 'Your standup draft is ready'
        : 'Your standup draft is ready — nothing moved since your last one';

      deps.itemStore.upsert({
        id: draft.id,
        recipientUserId: personUserId,
        type: 'standup_draft',
        summary,
        evidence: evidenceIssue
          ? { documentId: evidenceIssue.issueId, documentType: 'issue' }
          : activity?.anchor.lastStandupId
            ? { documentId: activity.anchor.lastStandupId, documentType: 'standup' }
            : {},
        action: { label: 'Review draft', href: `/standup-draft/${draft.id}` },
        draftId: draft.id,
      });

      return {};
    })
    // ---- Blocker escalation fan-out (TRO-346/TRO-337 / FG-19) -----------
    .addNode('detectBlockerFanout', async (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'detectBlockerFanout');
      const blockingIssueId = requireBlockingIssueId(state, 'detectBlockerFanout');

      const impact = await gatherBlockerFanout(deps.shipClient, blockingIssueId);
      if (!impact) {
        // The blocking issue itself is gone or invisible to this token —
        // nothing to fan out from, not an error (same posture as
        // `resolveSeed`'s own "seed itself is gone" branch).
        return { blockerEscalationSkipReason: 'issue_not_found' as const };
      }

      // Gate (a): TRO-337's own trigger condition counts the blocking
      // issue's own project alongside every distinct blocked-issue project
      // ("an issue blocks work in TWO OR MORE projects") — Test Case 5's
      // shape is exactly one of each.
      if (impact.distinctProjectIds.length < 2) {
        return { blockerFanoutImpact: impact, blockerEscalationSkipReason: 'single_project' as const };
      }
      // Gate (b) precondition: fewer than two distinct blocked PEOPLE means
      // there is no "different reporting lines" question to ask at all —
      // checked before the people-directory fetch below, so a fan-out with
      // one (or zero) assigned blocked issues never pays for it.
      if (impact.blockedPeopleUserIds.length < 2) {
        return { blockerFanoutImpact: impact, blockerEscalationSkipReason: 'insufficient_people' as const };
      }

      // `ShipPerson` is a structural superset of `PersonDirectoryEntry`
      // (`user_id`/`reportsTo`) — passed directly, same convention
      // `proactive.ts`'s `buildBlockingApprovalItems` already uses for
      // `findManagerUserId`.
      //
      // CodeRabbit (TRO-346 PR review): this is a Ship API call like any
      // other in this file's proactive/deep paths, and the assignment's own
      // Engineering Requirements mandate the agent "degrade gracefully if
      // Ship is unreachable — it should not crash or hang indefinitely."
      // The impact fan-out itself was already gathered successfully at this
      // point (`gatherBlockerFanout` above already tolerates per-call
      // failures internally); losing only the people directory should not
      // crash the whole node.
      let people: ShipPerson[];
      try {
        people = await deps.shipClient.getPeople();
      } catch {
        return { blockerFanoutImpact: impact, blockerEscalationSkipReason: 'people_unavailable' as const };
      }
      const manager = findLowestCommonManager(impact.blockedPeopleUserIds, people);

      // Gate (b): TRO-337 proof #3 — already in the same reporting line
      // does not escalate at all, no draft, no item.
      if (manager.reason === 'same_reporting_line') {
        return { blockerFanoutImpact: impact, blockerEscalationSkipReason: 'same_reporting_line' as const };
      }

      // `manager.reason` is 'found' or 'no_common_manager' here —
      // `'single_person'` is structurally unreachable (gated above by the
      // `blockedPeopleUserIds.length < 2` check), both remaining reasons
      // warrant a drafted message (TRO-337's own degrade path for the
      // latter — see `composeBlockerEscalation`).
      return { blockerFanoutImpact: impact, blockerEscalationManager: manager };
    })
    .addNode('composeBlockerEscalation', async (state: GraphStateType) => {
      requireDeepDeps(deepDeps, 'composeBlockerEscalation');
      if (state.blockerEscalationSkipReason || !state.blockerFanoutImpact || !state.blockerEscalationManager) {
        // Not warranted (a skip reason was set) or the gather step never
        // reached a decision — no model call, no spend, same "check before
        // spending" posture as `composeStandupDraft`'s own skip.
        return {};
      }

      const prompt = buildBlockerEscalationPrompt(state.blockerFanoutImpact, state.blockerEscalationManager);
      const result = await model.invoke(prompt);
      await recordInvocation(costTracker, 'composeBlockerEscalation', state.trigger, model.model, result.usage_metadata);
      return { blockerEscalationDraftText: contentToString(result.content) };
    })
    .addNode('commitBlockerEscalation', (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'commitBlockerEscalation');
      if (
        state.blockerEscalationSkipReason ||
        !state.blockerEscalationDraftText ||
        !state.blockerFanoutImpact ||
        !state.blockerEscalationManager
      ) {
        // Skipped, or nothing to commit (e.g. the compose step never ran) —
        // never write a partial/empty draft.
        return {};
      }

      // TRO-337's OWN degrade path: a confirmed manager when one exists,
      // otherwise the best-available partial-authority fallback
      // (`highestReachableUserId` — see `roles.ts`'s own docstring). If
      // NEITHER exists (nobody in the group has any manager recorded at
      // all), there is genuinely no one to route the draft to — the fan-out
      // fact is real, but nothing is written, rather than inventing a
      // recipient.
      const recipientUserId = state.blockerEscalationManager.managerUserId ?? state.blockerEscalationManager.highestReachableUserId;
      if (!recipientUserId) {
        return {};
      }

      const now = deps.now ?? (() => new Date());
      const windowDate = now().toISOString().slice(0, 10);
      const draftId = `blocker-escalation:${state.blockerFanoutImpact.blockingIssueId}:${windowDate}`;

      // Reuses `DraftStore`/`StandupDraft` AS-IS rather than introducing a
      // parallel store (this ticket's own instruction: "using the existing
      // ItemStore/DraftStore plumbing"). `personUserId`/`windowDate` are
      // standup-tier field names but already generalize exactly to what an
      // escalation draft needs: a per-recipient, per-day, upsertable text
      // record with the same unseen/viewed/dismissed/posted lifecycle.
      // `proposedTransitions` is always empty here — an escalation draft
      // never proposes an issue state change.
      const draft = deps.draftStore.upsert({
        id: draftId,
        personUserId: recipientUserId,
        windowDate,
        draftText: state.blockerEscalationDraftText,
        proposedTransitions: [],
      });

      const impact = state.blockerFanoutImpact;
      deps.itemStore.upsert({
        id: draft.id,
        recipientUserId,
        type: 'blocker_escalation',
        summary: `"${impact.blockingIssueTitle}" is blocking work across ${impact.distinctProjectIds.length} projects`,
        evidence: { documentId: impact.blockingIssueId, documentType: 'issue' },
        action: { label: 'Review drafted message', href: `/issue/${impact.blockingIssueId}` },
        draftId: draft.id,
      });

      return {};
    })
    // ---- Retro delivery drafting (TRO-335 / FG-17) -----------------------
    .addNode('gatherRetroActivity', async (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'gatherRetroActivity');
      const weekId = requireWeekId(state, 'gatherRetroActivity');

      const summary = await gatherWeekDelivery(deps.shipClient, weekId);
      if (!summary) {
        // The week itself is gone, invisible to this token, or not actually
        // a `sprint` document — nothing to draft from, not an error (same
        // posture as `detectBlockerFanout`'s own "issue not found" branch).
        return { retroSkipReason: 'week_not_found' as const };
      }
      // Gate (a): the ticket's OWN trigger condition — "a week whose plan
      // carries at least one success criterion." Checked before the owner
      // check below so the more fundamental "this week has no structured
      // plan at all" reason is reported when both are true.
      if (summary.successCriteria.length === 0) {
        return { weekDeliverySummary: summary, retroSkipReason: 'no_success_criteria' as const };
      }
      // Gate (b): nobody to draft FOR — see `retroDraft.ts`'s module
      // docstring for why `owner_id` is safe to read as a `users.id` here.
      if (!summary.ownerUserId) {
        return { weekDeliverySummary: summary, retroSkipReason: 'no_owner' as const };
      }
      // Gate (c): the closed-issue set itself cannot be trusted without a
      // real calendar window — see `retroDraft.ts`'s
      // `WeekDeliverySummary.weekDatesUnavailable` docstring for the real,
      // verified failure mode this guards against (a stale issue leaking
      // into a much later week's draft). Checked last since (a)/(b) are the
      // ticket's own more fundamental trigger conditions.
      if (summary.weekDatesUnavailable) {
        return { weekDeliverySummary: summary, retroSkipReason: 'week_dates_unavailable' as const };
      }
      return { weekDeliverySummary: summary };
    })
    .addNode('composeRetroDraft', async (state: GraphStateType) => {
      requireDeepDeps(deepDeps, 'composeRetroDraft');
      if (state.retroSkipReason || !state.weekDeliverySummary) {
        // Trigger condition not met, or the gather step never reached a
        // decision — no model call, no spend, same "check before spending"
        // posture as `composeStandupDraft`/`composeBlockerEscalation`.
        return {};
      }

      const prompt = buildRetroPrompt(state.weekDeliverySummary);
      const result = await model.invoke(prompt);
      await recordInvocation(costTracker, 'composeRetroDraft', state.trigger, model.model, result.usage_metadata);
      return { retroDraftText: contentToString(result.content) };
    })
    .addNode('commitRetroDraft', (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'commitRetroDraft');
      if (state.retroSkipReason || !state.retroDraftText || !state.weekDeliverySummary) {
        // Skipped, or nothing to commit (e.g. the compose step never ran) —
        // never write a partial/empty draft.
        return {};
      }
      const summary = state.weekDeliverySummary;
      const ownerUserId = summary.ownerUserId;
      if (!ownerUserId) {
        // Unreachable in practice — reaching this node with no
        // `retroSkipReason` requires `gatherRetroActivity` to have already
        // confirmed `ownerUserId` is set (see that node's own gate (b)).
        // Kept as an explicit runtime guard rather than a type assertion,
        // matching this file's existing style under `noUncheckedIndexedAccess`
        // (lessons.md #16/#21).
        return {};
      }

      // Stable per week — re-invoking for the same week is an upsert
      // (matches `commitBlockerEscalation`'s own per-day upsert contract,
      // scoped to a week instead of a day since a retro drafts once per
      // week, not once per calendar day).
      const draftId = `retro-draft:${summary.weekId}`;
      const draft = deps.draftStore.upsert({
        id: draftId,
        personUserId: ownerUserId,
        windowDate: `week-${summary.weekNumber}`,
        draftText: state.retroDraftText,
        proposedTransitions: [],
      });

      deps.itemStore.upsert({
        id: draft.id,
        recipientUserId: ownerUserId,
        type: 'retro_draft',
        summary:
          summary.closedIssues.length > 0
            ? `Your Week ${summary.weekNumber} retro draft is ready`
            : `Your Week ${summary.weekNumber} retro draft is ready — no issues closed this week`,
        evidence: { documentId: summary.weekId, documentType: 'sprint' },
        action: { label: 'Review draft', href: `/retro-draft/${draft.id}` },
        draftId: draft.id,
      });

      return {};
    })
    // ---- Plan-change discrimination (TRO-336 / FG-18) ---------------------
    .addNode('detectPlanChange', async (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'detectPlanChange');
      const weekId = requireWeekId(state, 'detectPlanChange');

      const summary = await gatherPlanChange(deps.shipClient, weekId, { changeFeedLimit: deps.changeFeedLimit });
      if (!summary) {
        // The week itself is gone, invisible to this token, or not actually
        // a `sprint` document — nothing to evaluate, not an error (same
        // posture as `detectBlockerFanout`'s own "issue not found" branch).
        return { planChangeSkipReason: 'week_not_found' as const };
      }
      // Gate (a): the ticket's OWN detection signal — Ship's approval
      // tracking already flipped to 'changed_since_approved'; if it hasn't,
      // there is nothing post-approval to discriminate about yet.
      if (summary.approvalState !== 'changed_since_approved') {
        return { planChangeSummary: summary, planChangeSkipReason: 'not_changed_since_approval' as const };
      }
      // Gate (b): nobody to route the draft TO.
      if (!summary.approverUserId) {
        return { planChangeSummary: summary, planChangeSkipReason: 'no_approver' as const };
      }
      // Gate (c): no "before" snapshot found in either document_history or
      // plan_history — see `planChangeDraft.ts`'s own module docstring for
      // why this is a real, verified gap, not a theoretical one. Never
      // guessed at.
      if (!summary.diffSourceFound) {
        return { planChangeSummary: summary, planChangeSkipReason: 'no_diff_source' as const };
      }
      // Gate (d): the ONE materiality question decided here, deterministically,
      // never by the model — every criterion identical after whitespace
      // normalization. Checked last since (a)-(c) are more fundamental "can
      // we even evaluate this" gates. Anything that survives this gate
      // (including a genuine character-level typo) still needs the model's
      // own MATERIAL/NOT MATERIAL verdict — see `composePlanChangeDraft` and
      // this file's module docstring for why.
      if (!summary.alignment.hasAnyChange) {
        return { planChangeSummary: summary, planChangeSkipReason: 'no_material_change' as const };
      }
      return { planChangeSummary: summary };
    })
    .addNode('composePlanChangeDraft', async (state: GraphStateType) => {
      requireDeepDeps(deepDeps, 'composePlanChangeDraft');
      if (state.planChangeSkipReason || !state.planChangeSummary) {
        // A deterministic gate already failed (including the one
        // materiality question `detectPlanChange` can answer on its own —
        // whitespace-only), or the gather step never reached a decision —
        // no model call, no spend, same "check before spending" posture as
        // every other `compose*` node in this file.
        return {};
      }

      const prompt = buildPlanChangePrompt(state.planChangeSummary);
      const result = await model.invoke(prompt);
      await recordInvocation(costTracker, 'composePlanChangeDraft', state.trigger, model.model, result.usage_metadata);

      // The ONE node in this package where the model's own verdict — not
      // just a deterministic gate — decides whether anything gets written.
      // See this file's module docstring, "Plan-change discrimination", for
      // why: a first deterministic attempt at this exact judgment (typo vs.
      // weakened) was proven wrong against real text.
      const verdict = parseMaterialityVerdict(contentToString(result.content));
      if (!verdict.material) {
        return { planChangeSkipReason: 'no_material_change' as const };
      }
      if (!verdict.draftText) {
        // Defensive (CodeRabbit, TRO-336 PR review): a `MATERIAL` verdict
        // with nothing after it — never expected from a real model, but
        // `commitPlanChangeDraft`'s own guard already refuses to write an
        // empty draft either way. Naming the reason here means a caller
        // inspecting `planChangeSkipReason` sees WHY, rather than it
        // staying `undefined` despite no draft existing.
        return { planChangeSkipReason: 'empty_draft' as const };
      }
      return { planChangeDraftText: verdict.draftText };
    })
    .addNode('commitPlanChangeDraft', (state: GraphStateType) => {
      const deps = requireDeepDeps(deepDeps, 'commitPlanChangeDraft');
      if (state.planChangeSkipReason || !state.planChangeDraftText || !state.planChangeSummary) {
        // Skipped, or nothing to commit (e.g. the compose step never ran) —
        // never write a partial/empty draft, and NEVER write an approval
        // state (the ticket's own hard limit) — `DeepShipClientLike` has no
        // write method to call in the first place.
        return {};
      }
      const summary = state.planChangeSummary;
      const approverUserId = summary.approverUserId;
      if (!approverUserId) {
        // Unreachable in practice — reaching this node with no
        // `planChangeSkipReason` requires `detectPlanChange` to have
        // already confirmed `approverUserId` is set (see that node's own
        // gate (b)). Kept as an explicit runtime guard rather than a type
        // assertion, matching this file's existing style under
        // `noUncheckedIndexedAccess` (lessons.md #16/#21).
        return {};
      }

      // Stable per week — re-invoking while the week is still
      // 'changed_since_approved' is an upsert (matches `commitRetroDraft`'s
      // own per-week upsert contract).
      const draftId = `plan-change-draft:${summary.weekId}`;
      const { alignment } = summary;
      const draft = deps.draftStore.upsert({
        id: draftId,
        personUserId: approverUserId,
        windowDate: `week-${summary.weekNumber}`,
        draftText: state.planChangeDraftText,
        proposedTransitions: [],
      });

      const changeCount = alignment.removed.length + alignment.added.length + alignment.modified.length;
      deps.itemStore.upsert({
        id: draft.id,
        recipientUserId: approverUserId,
        type: 'plan_change_draft',
        summary: `Week ${summary.weekNumber}'s plan changed after you approved it (${changeCount} criterion change${changeCount === 1 ? '' : 's'})`,
        evidence: { documentId: summary.weekId, documentType: 'sprint' },
        action: { label: 'Review draft', href: `/plan-change-draft/${draft.id}` },
        draftId: draft.id,
      });

      return {};
    })
    .addConditionalEdges(START, routeTrigger, {
      on_demand_chat: 'ingest',
      on_demand_expand: 'resolveSeed',
      proactive_fast: 'pollChangeFeed',
      proactive_steady: 'pollChangeFeed',
      proactive_deep: 'gatherStandupActivity',
      proactive_escalation: 'detectBlockerFanout',
      proactive_retro: 'gatherRetroActivity',
      proactive_plan_change: 'detectPlanChange',
    })
    .addEdge('ingest', 'respond')
    .addEdge('respond', END)
    .addEdge('pollChangeFeed', 'resolveMentions')
    .addEdge('resolveMentions', 'detectBlockingApprovals')
    .addEdge('detectBlockingApprovals', 'commitInboxItems')
    .addEdge('commitInboxItems', END)
    .addEdge('resolveSeed', 'expandFrontier')
    .addConditionalEdges('expandFrontier', routeExpansionLoop, {
      expandFrontier: 'expandFrontier',
      finalizeExpansion: 'finalizeExpansion',
    })
    .addEdge('finalizeExpansion', 'composeAnswer')
    .addEdge('composeAnswer', END)
    .addEdge('gatherStandupActivity', 'composeStandupDraft')
    .addEdge('composeStandupDraft', 'commitStandupDraft')
    .addEdge('commitStandupDraft', END)
    .addEdge('detectBlockerFanout', 'composeBlockerEscalation')
    .addEdge('composeBlockerEscalation', 'commitBlockerEscalation')
    .addEdge('commitBlockerEscalation', END)
    .addEdge('gatherRetroActivity', 'composeRetroDraft')
    .addEdge('composeRetroDraft', 'commitRetroDraft')
    .addEdge('commitRetroDraft', END)
    .addEdge('detectPlanChange', 'composePlanChangeDraft')
    .addEdge('composePlanChangeDraft', 'commitPlanChangeDraft')
    .addEdge('commitPlanChangeDraft', END);

  return graph.compile();
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
