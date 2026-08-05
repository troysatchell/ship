/**
 * E2E test bootstrap for the agent service (TRO-322 / FG-12).
 *
 * Mirrors `index.ts`'s real wiring — real `ShipClient`, real `ItemStore`/
 * `DraftStore`, the real compiled graph, the real proactive poller, the real
 * Express server from `server.ts` — with exactly one substitution: a stable,
 * deterministic fake in place of `ChatAnthropic`. This is the ticket's own
 * mocking rule, applied to the one thing in this chain that would otherwise
 * be a live, non-deterministic, budget-spending network call: "Tests that
 * call Ship APIs or LLM providers must use stable fakes or recorded
 * fixtures — not live services — so they pass consistently in CI regardless
 * of network state or API availability."
 *
 * Because `citedSources` is built structurally from the documents the
 * expansion walk actually visited (`finalizeExpansion`, `graph.ts`) and
 * never from anything the model writes, a fake model does not weaken the
 * "grounded, source-naming answer" proof the on-demand E2E flow needs — the
 * citations are real Ship data, walked for real, through the real graph.
 * Only the prose is canned.
 *
 * Not imported by `index.ts` or any production entrypoint. Exists only for
 * `e2e/fixtures/agentEnv.ts` to spawn as a child process (`node
 * dist/scripts/e2e-server.js` after `pnpm --filter @ship/agent build`, or
 * `tsx src/scripts/e2e-server.ts` for local/dev iteration).
 */
import 'dotenv/config';
import { loadConfig, isConfigComplete } from '../config.js';
import { createServer, buildShipClient } from '../server.js';
import { buildGraph, type AnthropicModel, type CompiledGraph } from '../graph.js';
import { ShipClient } from '../shipClient.js';
import { InMemoryItemStore, type ItemStore } from '../itemStore.js';
import { InMemoryDraftStore } from '../draftStore.js';
import { createProactivePoller } from '../proactivePoll.js';

const config = loadConfig();

if (!isConfigComplete(config)) {
  console.error(
    '[e2e-server] config incomplete — ANTHROPIC_API_KEY, SHIP_API_BASE_URL, and SHIP_API_TOKEN ' +
      'are all required to start (agent/src/config.ts: isConfigComplete). A placeholder ' +
      'ANTHROPIC_API_KEY value is fine here — this script never constructs a real model client, ' +
      'so the key is never read, sent, or billed against.'
  );
  process.exit(1);
}

if (!config.agentInternalSecret) {
  console.error('[e2e-server] AGENT_INTERNAL_SECRET is not set — POST /chat and GET /inbox would reject every request.');
  process.exit(1);
}

// Deterministic, recorded response text — overridable per-test via env so a
// spec can assert on content it chose, without this file hardcoding every
// spec's expectation. `finalizeExpansion` already built `citedSources` from
// real visited documents before `composeAnswer` ever calls this — the
// grounding a caller sees does not depend on what this string says.
const RECORDED_ANSWER =
  process.env.E2E_FAKE_MODEL_ANSWER ??
  'Recorded e2e fixture response: based on the documents pulled into context, here is a summary grounded in what Ship actually records.';

const fakeModel: AnthropicModel = {
  model: 'e2e-fake-model',
  invoke: async () => ({
    content: RECORDED_ANSWER,
    usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }),
};

const shipClient = new ShipClient({
  baseUrl: config.shipApiBaseUrl,
  // isConfigComplete() above already guarantees this is set.
  token: config.shipApiToken as string,
  client: buildShipClient(config),
});
const itemStore: ItemStore = new InMemoryItemStore();
const draftStore = new InMemoryDraftStore();

const graph: CompiledGraph = buildGraph(
  fakeModel,
  { shipClient, itemStore },
  { shipClient, documentCap: config.onDemandDocumentCap },
  { shipClient, itemStore, draftStore }
);

// Real poller, real interval (test callers set PROACTIVE_POLL_INTERVAL_MS
// short via env — see e2e/fixtures/agentEnv.ts) — the detection-latency E2E
// flow needs the actual production poll loop running, not a hand-invoked
// graph.invoke() from inside the test process.
const poller = createProactivePoller({
  graph,
  intervalMs: config.proactivePollIntervalMs,
  initialLookbackMs: config.proactiveInitialLookbackMs,
  onError: (err) => {
    console.error('[e2e-server] proactive poll tick failed (will retry next cycle):', err);
  },
});
poller.start();
void poller.tick();

const app = createServer(config, { graph, itemStore });

app.listen(config.port, () => {
  console.log(
    `[e2e-server] listening on :${config.port} — fake model (deterministic), real graph, ` +
      `real ShipClient against ${config.shipApiBaseUrl}, polling every ${config.proactivePollIntervalMs}ms`
  );
});
