/**
 * The compiled LangGraph graph (TRO-313 / FG-2; extended by TRO-317 / FG-5).
 *
 * Phase 2 (node design for the six FleetGraph use cases — see FLEETGRAPH.MD
 * "Graph Diagram" / "Node design rationale", both marked Pending) is still
 * not fully done — FG-5 only builds the proactive fast tier's own nodes.
 * The on-demand path (`ingest` -> `respond`) is untouched from FG-2:
 *
 *   ingest  — normalizes the incoming request (no model call; deterministic).
 *   respond — the one node that calls the model, via an injectable
 *             `AnthropicModel` so tests never make a live call (a stable fake
 *             is passed in `__tests__/graph.test.ts`) while production wires
 *             a real `ChatAnthropic` in `index.ts`.
 *
 * Model provider: Anthropic API directly (`@langchain/anthropic`), confirmed
 * by the maintainer 2026-08-03 — see TRO-313's own "one decision still open"
 * section. Not Bedrock: this environment has never had AWS credentials this
 * sprint (memory-bank/activeContext.md), and the brief's "Claude API costs"
 * accounting matches billing through the Anthropic API, not Bedrock.
 *
 * FG-5 adds a second entry point, `pollChangeFeed` -> `resolveMentions` ->
 * `detectBlockingApprovals` -> `commitInboxItems`, for the proactive fast
 * tier (mention resolution + approval-blocking detection — TRO-317's own
 * Scope section). It is wired as ITS OWN trigger via a conditional edge off
 * `START`, not by touching `ingest`/`respond` — the ticket is explicit that
 * this path carries no model call at all. `GraphState` gains fields shared
 * with FG-7/FG-6 (the next two tickets on this branch): `trigger` lets any
 * future node branch on why the graph is running without hardcoding "this
 * graph only ever handles the proactive trigger" (`proactive_deep`, the
 * drafting tier, is named in the type but has no node yet — deliberately;
 * composing drafts is out of this ticket's scope). `inboxItems`/
 * `clearedItemIds` use concatenating reducers specifically so more than one
 * producer node can append to the same list in one run — FG-6/FG-7 add
 * their own item-producing nodes onto this same shape rather than inventing
 * a parallel one.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { ChangeFeedResponse, ShipClientLike, ShipPerson } from './shipClient.js';
import type { ItemStore, NewInboxItem } from './itemStore.js';
import { buildBlockingApprovalItems, buildMentionItems, pollChangeFeed } from './proactive.js';

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
 * composition) is named for forward-compatibility only — no node handles
 * it yet, and routing to it deliberately has no `pathMap` entry below, so
 * using it before it exists fails loudly instead of silently no-op-ing. */
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

/** Routes `START` by `state.trigger` — the seam that lets both modes share
 * one graph without either path knowing the other exists. No `pathMap`
 * entry for `proactive_deep` is deliberate: see `TriggerKind`'s docstring. */
function routeTrigger(state: GraphStateType): TriggerKind {
  return state.trigger;
}

/**
 * Build and compile the graph. `model` is injected so the compiled graph is
 * fully testable against a stable fake — see FG-2's "how it will be proven":
 * the smoke test asserts the compiled graph exposes its node set, never a
 * live call. `proactiveDeps` is the same pattern applied to FG-5's path —
 * optional so every existing on-demand call site/test is unaffected; see
 * `ProactiveDeps`'s own docstring for why a missing dep fails loudly rather
 * than silently.
 */
export function buildGraph(model: AnthropicModel, proactiveDeps?: ProactiveDeps) {
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
    .addConditionalEdges(START, routeTrigger, {
      on_demand: 'ingest',
      proactive_fast: 'pollChangeFeed',
      proactive_steady: 'pollChangeFeed',
    })
    .addEdge('ingest', 'respond')
    .addEdge('respond', END)
    .addEdge('pollChangeFeed', 'resolveMentions')
    .addEdge('resolveMentions', 'detectBlockingApprovals')
    .addEdge('detectBlockingApprovals', 'commitInboxItems')
    .addEdge('commitInboxItems', END);

  return graph.compile();
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
