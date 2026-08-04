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
 * FG-7 wires the same `ShipClient` instance as `onDemandDeps.shipClient` —
 * it already satisfies `OnDemandShipClientLike` structurally (a strict
 * superset of `ShipClientLike`'s methods), so no second client is
 * constructed. `documentCap` comes from `config.onDemandDocumentCap` — see
 * that field's own docstring in `config.ts` for where the default number
 * comes from. There is no route into the graph that supplies
 * `seedDocumentId`/`askingUserId` yet (FG-9 owns the chat panel that will);
 * until then, `on_demand` invocations with no seed still take the
 * unchanged `ingest -> respond` path.
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
 */

import 'dotenv/config';
import { ChatAnthropic } from '@langchain/anthropic';
import { loadConfig, isConfigComplete } from './config.js';
import { createServer, buildShipClient } from './server.js';
import { buildGraph, type CompiledGraph } from './graph.js';
import { ShipClient } from './shipClient.js';
import { InMemoryItemStore } from './itemStore.js';
import { InMemoryDraftStore } from './draftStore.js';
import { createProactivePoller } from './proactivePoll.js';

const config = loadConfig();

if (!config.langchainTracingV2) {
  console.warn(
    '[agent] LANGCHAIN_TRACING_V2 is not "true" — LangSmith tracing is OFF. ' +
      'Set it before invoking the graph if a trace is expected.'
  );
}

if (!config.agentInternalSecret) {
  // Independent of isConfigComplete() (config.ts's own docstring explains
  // why) — this only means POST /chat will reject every request rather than
  // the whole process being "not ready."
  console.warn(
    '[agent] AGENT_INTERNAL_SECRET is not set — POST /chat will reject every request ' +
      '(fails closed, TRO-320 / FG-9), including legitimate ones from api/.'
  );
}

// Assigned only inside the isConfigComplete branch below, same as
// itemStore/draftStore — undefined here means createServer's /chat degrades
// to a clear 503 rather than calling .invoke on nothing (server.ts).
let graph: CompiledGraph | undefined;

if (!isConfigComplete(config)) {
  console.warn(
    '[agent] Startup config is incomplete (ANTHROPIC_API_KEY, SHIP_API_BASE_URL, and/or ' +
      'SHIP_API_TOKEN missing). The process will stay up — /health still returns 200 — but ' +
      '/ready will return 503 until the missing values are set (graceful degradation, FG-4). ' +
      'The proactive poller (FG-5) will not start either, and POST /chat will return 503.'
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
  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    // isConfigComplete() already guarantees this is set.
    token: config.shipApiToken as string,
    client: buildShipClient(config),
  });
  const itemStore = new InMemoryItemStore();
  const draftStore = new InMemoryDraftStore();
  graph = buildGraph(
    model,
    { shipClient, itemStore },
    { shipClient, documentCap: config.onDemandDocumentCap },
    { shipClient, itemStore, draftStore }
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

const app = createServer(config, { graph });

app.listen(config.port, () => {
  console.log(`[agent] listening on :${config.port}`);
});
