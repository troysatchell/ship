/**
 * The compiled LangGraph graph (TRO-313 / FG-2; extended by TRO-317 / FG-5,
 * TRO-318 / FG-7, and TRO-319 / FG-6).
 *
 * Phase 2 (node design for the six FleetGraph use cases — see FLEETGRAPH.MD
 * "Graph Diagram" / "Node design rationale", both marked Pending) is still
 * not fully done. Four entry points exist so far, all sharing ONE compiled
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

/** The subset of ChatAnthropic's interface this graph actually needs — narrow
 * on purpose so tests can pass a plain object instead of a real client. */
export interface AnthropicModel {
  invoke(input: string): Promise<{ content: unknown }>;
}

/** Why the graph is running this invocation. `on_demand` is FG-2's original
 * chat path. `proactive_fast`/`proactive_steady` both route to the same
 * poll-based node chain FG-5 builds — the ticket's trigger table
 * (FLEETGRAPH.MD) treats them as two cadences of the same deterministic
 * work, not different logic. `proactive_deep` (drafting, once-per-window
 * composition, TRO-319 / FG-6) routes to `gatherStandupActivity` — see the
 * module docstring's "Deep tier draft composition" section. */
export type TriggerKind = 'on_demand' | 'proactive_fast' | 'proactive_steady' | 'proactive_deep';

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
  | 'proactive_deep';

/** Routes `START` by `state.trigger` (and, for `on_demand`, by whether a
 * seed document was given) — the seam that lets every mode share one graph
 * without any path knowing the others exist. `proactive_deep` now has a
 * `pathMap` entry too (TRO-319 / FG-6, below) — FG-7 already wired this
 * switch's `proactive_deep` case in anticipation, ahead of the node it
 * routes to existing. */
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
 * see `DeepDeps`'s own docstring.
 */
export function buildGraph(
  model: AnthropicModel,
  proactiveDeps?: ProactiveDeps,
  onDemandDeps?: OnDemandDeps,
  deepDeps?: DeepDeps
) {
  const graph = new StateGraph(GraphState)
    .addNode('ingest', (state: GraphStateType) => ({ input: state.input.trim() }))
    .addNode('respond', async (state: GraphStateType) => {
      const result = await model.invoke(state.input);
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
    .addConditionalEdges(START, routeTrigger, {
      on_demand_chat: 'ingest',
      on_demand_expand: 'resolveSeed',
      proactive_fast: 'pollChangeFeed',
      proactive_steady: 'pollChangeFeed',
      proactive_deep: 'gatherStandupActivity',
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
    .addEdge('commitStandupDraft', END);

  return graph.compile();
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
