/**
 * The compiled LangGraph graph (TRO-313 / FG-2).
 *
 * Phase 2 (node design for the six FleetGraph use cases — see FLEETGRAPH.MD
 * "Graph Diagram" / "Node design rationale", both marked Pending) is explicitly
 * out of scope here. This ticket's job is narrower: prove a real, compiled
 * LangGraph graph exists, runs, and is traced by LangSmith from the first
 * invocation. Two nodes are enough to prove that:
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
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

/** The subset of ChatAnthropic's interface this graph actually needs — narrow
 * on purpose so tests can pass a plain object instead of a real client. */
export interface AnthropicModel {
  invoke(input: string): Promise<{ content: unknown }>;
}

export const GraphState = Annotation.Root({
  /** The raw incoming request text (a question, a trigger payload, etc). */
  input: Annotation<string>(),
  /** The model's response, once `respond` has run. */
  output: Annotation<string>(),
});

export type GraphStateType = typeof GraphState.State;

/** Node names, exported so both the smoke test and any future caller can
 * assert against a single source of truth rather than a string literal. */
export const NODE_NAMES = ['ingest', 'respond'] as const;
export type NodeName = (typeof NODE_NAMES)[number];

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join('');
  }
  return String(content);
}

/**
 * Build and compile the graph. `model` is injected so the compiled graph is
 * fully testable against a stable fake — see FG-2's "how it will be proven":
 * the smoke test asserts the compiled graph exposes its node set, never a
 * live call.
 */
export function buildGraph(model: AnthropicModel) {
  const graph = new StateGraph(GraphState)
    .addNode('ingest', (state: GraphStateType) => ({ input: state.input.trim() }))
    .addNode('respond', async (state: GraphStateType) => {
      const result = await model.invoke(state.input);
      return { output: contentToString(result.content) };
    })
    .addEdge(START, 'ingest')
    .addEdge('ingest', 'respond')
    .addEdge('respond', END);

  return graph.compile();
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
