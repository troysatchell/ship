/**
 * Agent service entrypoint (TRO-313 / FG-2; extended by TRO-317 / FG-5 and
 * TRO-318 / FG-7).
 *
 * LangSmith tracing is controlled entirely by env vars
 * (`LANGCHAIN_TRACING_V2`, `LANGCHAIN_PROJECT`, `LANGCHAIN_API_KEY` /
 * `LANGSMITH_API_KEY`, `LANGCHAIN_ENDPOINT`) that `@langchain/core` reads
 * itself — there is nothing to wire up here beyond loading `.env` before
 * anything else runs, and warning loudly if tracing looks off, since the
 * brief requires traces from the first invocation, not bolted on later.
 *
 * FG-5 additionally starts the proactive steady-tier poller (mention
 * resolution + approval-blocking detection, no model call) once config is
 * complete. It is intentionally NOT gated on `ANTHROPIC_API_KEY` alone —
 * `buildGraph`'s `model` argument is only ever invoked by the on-demand
 * `respond` node, never by anything on the proactive path this poller
 * drives — but `isConfigComplete` already requires the key today, so this
 * only matters once that changes.
 *
 * FG-7 originally wired the same shared `ShipClient` instance as
 * `onDemandDeps.shipClient` — TRO-342 (filed after FG-23/TRO-341 spotted
 * that this contradicted FLEETGRAPH.MD's "no service account" argument)
 * replaced that with `onDemandDeps.shipClientFactory`: a `(token) =>
 * ShipClient` closure built once here, but constructing a FRESH `ShipClient`
 * per on-demand invocation, bound to THAT invocation's own asker
 * (`graph.ts`'s `resolveSeed`/`expandFrontier` call it with
 * `state.askingUserToken`, sourced per-request — see `api/src/routes/
 * agent.ts`'s own TRO-342 section for where that token comes from). The
 * SAME underlying `resilientHttpClient` (below) backs both this factory and
 * the shared-token `shipClient` used by `proactiveDeps`/`deepDeps` — the
 * circuit breaker/self-throttle are about Ship's own health, not caller
 * identity, so there is no reason to fragment that state per asker.
 * `documentCap` comes from `config.onDemandDocumentCap` — see that field's
 * own docstring in `config.ts` for where the default number comes from.
 *
 * FG-6 (TRO-319) wires `deepDeps` the same way: the same shared `ShipClient`
 * instance again (it also structurally satisfies `DeepShipClientLike`) and
 * the SAME `itemStore` FG-5's proactive path already uses — a standup-draft
 * item lands in the same per-person inbox as mentions/blocking-approvals
 * (see `graph.ts`'s module docstring). A new `InMemoryDraftStore` holds the
 * full draft text/proposed transitions. There is no scheduler here (or
 * anywhere in this package) that decides WHOSE standup window is open and
 * invokes `trigger: 'proactive_deep'` with a `targetPersonUserId` for
 * them — same "not this ticket" posture FG-7 left the on-demand route in;
 * `deepDeps` is wired so the path is real and testable end-to-end, but
 * nothing calls it yet.
 *
 * FG-9 (TRO-320) closes the gap this file's own comment used to leave open —
 * "there is no route into the graph that supplies seedDocumentId/
 * askingUserId yet." `createServer` now takes the compiled `graph` as an
 * optional dep (`server.ts`'s `CreateServerDeps.graph`) so `POST /chat` can
 * invoke it; `graph` is only ever assigned inside the `isConfigComplete`
 * branch below, same as `itemStore`/`draftStore` — when config is
 * incomplete, `createServer` still gets called (still 200 on `/health`) but
 * with no `graph`, and `/chat` degrades to a clear 503 (FG-4's contract,
 * applied inbound this time instead of outbound).
 *
 * FG-10 (TRO-323) does the same for `itemStore`: it is now ALSO hoisted
 * above the `isConfigComplete` branch (previously a `const` scoped inside
 * it, invisible to `createServer`) and passed through as
 * `CreateServerDeps.itemStore` so `GET /inbox` can call `.list()` on the
 * exact same store FG-5/FG-6's producers write into — never a second,
 * separately-constructed store that could drift from what the poller fills.
 */

import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { loadConfig, isConfigComplete } from './config.js';
import { createServer, buildShipClient } from './server.js';
import { buildGraph, type CompiledGraph } from './graph.js';
import { ShipClient } from './shipClient.js';
import { InMemoryItemStore, type ItemStore } from './itemStore.js';
import { InMemoryDraftStore } from './draftStore.js';
import { createProactivePoller } from './proactivePoll.js';
import { FileCostTracker } from './costTracking.js';

const config = loadConfig();

if (!config.langchainTracingV2) {
  console.warn(
    '[agent] LANGCHAIN_TRACING_V2 is not "true" — LangSmith tracing is OFF. ' +
      'Set it before invoking the graph if a trace is expected.'
  );
}

if (!config.agentInternalSecret) {
  // Independent of isConfigComplete() (config.ts's own docstring explains
  // why) — this only means POST /chat and GET /inbox will reject every
  // request rather than the whole process being "not ready."
  console.warn(
    '[agent] AGENT_INTERNAL_SECRET is not set — POST /chat and GET /inbox will return 500 ' +
      'internal_secret_not_configured for EVERY request, including legitimate ones from api/ ' +
      '(fails closed, TRO-320 / FG-9 and TRO-323 / FG-10).'
  );
}

// Assigned only inside the isConfigComplete branch below, same as
// itemStore/draftStore — undefined here means createServer's /chat degrades
// to a clear 503 rather than calling .invoke on nothing (server.ts).
let graph: CompiledGraph | undefined;
// Hoisted the same way (TRO-323 / FG-10) — undefined here means
// createServer's /inbox degrades to a clear 503 rather than calling .list()
// on nothing (server.ts).
let itemStore: ItemStore | undefined;

if (!isConfigComplete(config)) {
  // server.ts checks agentInternalSecret BEFORE deps.graph/deps.itemStore —
  // so when BOTH are missing, POST /chat and GET /inbox actually return 500
  // (the secret warning above already said so), never 503. Naming 503 here
  // unconditionally would make the two warnings claim conflicting outcomes
  // for the same endpoints in that combined case.
  const chatStatusNote = config.agentInternalSecret
    ? ' POST /chat and GET /inbox will also return 503 agent_not_configured.'
    : ' POST /chat and GET /inbox are unavailable (see the AGENT_INTERNAL_SECRET warning above for the exact status).';
  console.warn(
    '[agent] Startup config is incomplete (ANTHROPIC_API_KEY, SHIP_API_BASE_URL, and/or ' +
      'SHIP_API_TOKEN missing). The process will stay up — /health still returns 200 — but ' +
      '/ready will return 503 until the missing values are set (graceful degradation, FG-4). ' +
      'The proactive poller (FG-5) will not start either.' +
      chatStatusNote
  );
} else {
  // Config complete: wire the real graph (real model, real Ship client, the
  // in-memory item store — see itemStore.ts for why in-memory is the right
  // call for this ticket) and start the steady-tier poller.
  const model = new ChatAnthropic({
    apiKey: config.anthropicApiKey,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
  });
  // Built once, shared by the bound-token `shipClient` below AND the
  // on-demand `shipClientFactory` (TRO-342) — the circuit breaker/
  // self-throttle it carries are about Ship's own reachability, not caller
  // identity, so there is no reason for a per-asker client to reset that
  // state.
  const resilientHttpClient = buildShipClient(config);
  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    // isConfigComplete() already guarantees this is set. Used for the
    // proactive fast tier (`proactiveDeps`) and the deep tier (`deepDeps`)
    // only — both intentionally still run under ONE shared token, since
    // neither has a per-invocation requesting user to source a per-call one
    // from (see `ProactiveDeps`/`DeepDeps`'s own docstrings in graph.ts).
    token: config.shipApiToken as string,
    client: resilientHttpClient,
  });
  // TRO-342: the on-demand path DOES have a requesting user on every
  // invocation (the person asking in the chat panel), so it gets a FRESH
  // `ShipClient` per invocation, bound to that person's own token — never
  // the shared one above. See `OnDemandDeps.shipClientFactory`'s own
  // docstring (graph.ts) for the full rationale.
  const onDemandShipClientFactory = (token: string): ShipClient =>
    new ShipClient({ baseUrl: config.shipApiBaseUrl, token, client: resilientHttpClient });
  itemStore = new InMemoryItemStore();
  const draftStore = new InMemoryDraftStore();
  // TRO-339 / FG-21: real per-invocation cost accounting for every model
  // call this graph makes — see costTracking.ts's own module docstring for
  // what was verified before adding this (LangSmith already captures usage
  // natively, but held almost no development-spend history; ChatAnthropic's
  // own response carries usage_metadata at runtime, which graph.ts's
  // AnthropicModel interface was previously discarding by construction of
  // the type). Appends to `agent/.cache/cost-ledger.jsonl` — query it via
  // `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts`.
  const costTracker = new FileCostTracker();
  graph = buildGraph(
    model,
    { shipClient, itemStore },
    { shipClientFactory: onDemandShipClientFactory, documentCap: config.onDemandDocumentCap },
    { shipClient, itemStore, draftStore },
    costTracker
  );

  const poller = createProactivePoller({
    graph,
    intervalMs: config.proactivePollIntervalMs,
    initialLookbackMs: config.proactiveInitialLookbackMs,
    onError: (err) => {
      console.error('[agent] proactive poll tick failed (will retry next cycle):', err);
    },
  });
  poller.start();
  // Also run one tick immediately at startup rather than waiting a full
  // interval for the first observation.
  void poller.tick();
  console.log(
    `[agent] proactive poller started (every ${config.proactivePollIntervalMs}ms, ` +
      `initial lookback ${config.proactiveInitialLookbackMs}ms)`
  );
}

const app = createServer(config, { graph, itemStore });

app.listen(config.port, () => {
  console.log(`[agent] listening on :${config.port}`);
});
