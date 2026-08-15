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
 *
 * TRO-348 closes FG-8's own gap: `gate.ts`'s `acceptDraft` (TRO-321) was
 * real, tested, and correct in isolation, but had no HTTP caller anywhere in
 * the codebase — a `grep -rn "acceptDraft" agent/src api/src web/src`
 * excluding tests found none — so TRO-338's draft-survival metric could never
 * record anything live either. `draftStore` is now hoisted the same way
 * `itemStore` was for FG-10 (previously a `const` scoped inside the
 * `isConfigComplete` branch, invisible to `createServer`), and two new deps
 * are constructed alongside it: `gateShipClient` (a `GateShipClient`, built
 * from the same shared `resilientHttpClient` as everything else — see that
 * variable's own comment — but holding no token itself; every call takes the
 * accepting person's own token as an explicit argument, same structural
 * guarantee `gate.ts`'s module docstring describes) and `draftSurvivalTracker`
 * (a real `FileDraftSurvivalTracker`, where before nothing in production ever
 * constructed one). All three are passed to `createServer` so `POST
 * /accept-draft` (`server.ts`) can call `acceptDraft` for real, with the
 * draft-survival metric now actually being recorded on every accepted draft.
 */

import 'dotenv/config';
import {
  loadConfig,
  isConfigComplete,
  assertAnthropicBudgetFitsHandlerDeadline,
  FLEETGRAPH_CLIENT_ID,
  FLEETGRAPH_APP_SCOPES,
} from './config.js';
import { ShipClient as SdkShipClient } from '@ship/sdk';
import { createServer, buildShipClient, buildAnthropicModel } from './server.js';
import { buildGraph, type CompiledGraph } from './graph.js';
import { ShipClient, GateShipClient, type GateShipClientLike } from './shipClient.js';
import { InMemoryItemStore, type ItemStore } from './itemStore.js';
import { InMemoryDraftStore, type DraftStore } from './draftStore.js';
import { createProactivePoller } from './proactivePoll.js';
import { FileCostTracker } from './costTracking.js';
import { FileDraftSurvivalTracker, type DraftSurvivalTracker } from './draftSurvival.js';

const config = loadConfig();

// TRO-379: fail loudly at startup rather than once a slow real request
// exposes a budget that never held together — independent of
// isConfigComplete (see assertAnthropicBudgetFitsHandlerDeadline's own
// docstring for why these four fields are always checkable).
assertAnthropicBudgetFitsHandlerDeadline(config);

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
// Hoisted the same way again (TRO-348) — undefined here means createServer's
// /accept-draft degrades to a clear 503 rather than calling a method on
// nothing (server.ts). This is the SAME store deepDeps below writes standup
// drafts into; /accept-draft must read/mark-posted on that exact instance,
// never a second, separately-constructed one that could drift from what the
// deep-tier poller fills.
let draftStore: DraftStore | undefined;
// Hoisted the same way again (TRO-348) — undefined here means createServer's
// /accept-draft degrades to a clear 503. This is `gate.ts`'s own
// write-capable client, the one place in this whole package that performs a
// Ship write; see `shipClient.ts`'s "gate's write-capable client" section for
// why it is a separate class from `ShipClient` and holds no token itself.
let gateShipClient: GateShipClientLike | undefined;
// Hoisted the same way again (TRO-348 / closing TRO-338's own gap) —
// undefined here means /accept-draft still works, just without recording the
// draft-survival metric (`gate.ts`'s `acceptDraft` already treats a missing
// tracker as "don't record," non-fatally).
let draftSurvivalTracker: DraftSurvivalTracker | undefined;

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
  // TRO-368: explicit timeout + retry/backoff for the LLM-provider call —
  // the one outbound call class the resilientClient.ts layer never covered
  // (that file's own docstring claims "Ship API and the model provider
  // both", but grepping it turns up no Anthropic-specific code at all).
  // Unconfigured, `@anthropic-ai/sdk` defaults to a 10-MINUTE timeout and
  // `AsyncCallerParams` defaults `maxRetries` to 6 — both inherited library
  // defaults, not chosen ones, and exactly what let `server.ts`'s own
  // comment on this handler concede that a hung call here "keeps running to
  // completion server-side" after `chatHandlerTimeoutMs` gives up on
  // *waiting* for it. Built via `buildAnthropicModel` (server.ts) rather
  // than inline, so the exact params this real construction uses are the
  // same ones `server.test.ts` asserts on — see
  // `anthropicRequestTimeoutMs`/`anthropicMaxRetries` in config.ts for the
  // chosen values and the full reasoning.
  const model = buildAnthropicModel(config);
  // Built once, shared by the bound-token `shipClient` below AND the
  // on-demand `shipClientFactory` (TRO-342) — the circuit breaker/
  // self-throttle it carries are about Ship's own reachability, not caller
  // identity, so there is no reason for a per-asker client to reset that
  // state.
  const resilientHttpClient = buildShipClient(config);

  // PF-702 (TRO-428) — AGENT_PLATFORM_MODE=sdk: the SHARED/proactive
  // instance authenticates as the app itself (Client Credentials against
  // ship_app_fleetgraph, PF-701 — see config.ts's FLEETGRAPH_CLIENT_ID/
  // FLEETGRAPH_APP_SCOPES doc comment) rather than impersonating a human, and
  // its 10 reads delegate to @ship/sdk's /api/v1/* surface instead of the
  // internal /api/* routes — see shipClient.ts's module docstring for the
  // per-method mapping and the fields that cannot carry over. Stays
  // 'internal' by default (this ticket does not flip PF-704's default); the
  // secret check below is a startup fail-loud, same posture
  // assertAnthropicBudgetFitsHandlerDeadline above already uses for a
  // configuration this process cannot function correctly under.
  let sharedSdkClient: SdkShipClient | undefined;
  if (config.agentPlatformMode === 'sdk') {
    if (!config.fleetgraphOauthClientSecret) {
      throw new Error(
        '[agent] AGENT_PLATFORM_MODE=sdk requires FLEETGRAPH_OAUTH_CLIENT_SECRET (the ' +
          "ship_app_fleetgraph app's client secret, PF-701) to mint an app-identity Client " +
          'Credentials token. Set it, or unset AGENT_PLATFORM_MODE to run in internal mode.'
      );
    }
    sharedSdkClient = await SdkShipClient.clientCredentials({
      baseUrl: config.shipApiBaseUrl,
      clientId: FLEETGRAPH_CLIENT_ID,
      clientSecret: config.fleetgraphOauthClientSecret,
      scope: FLEETGRAPH_APP_SCOPES.join(' '),
    });
  }

  const shipClient = new ShipClient({
    baseUrl: config.shipApiBaseUrl,
    // isConfigComplete() already guarantees this is set (in EITHER mode —
    // that check is unconditional on agentPlatformMode) for every branch
    // that reaches this construction. Used for the proactive fast tier
    // (`proactiveDeps`) and the deep tier (`deepDeps`) only — both
    // intentionally still run under ONE shared token, since neither has a
    // per-invocation requesting user to source a per-call one from (see
    // `ProactiveDeps`/`DeepDeps`'s own docstrings in graph.ts). In `sdk`
    // mode this token is unused (see `sdk` field below). `?? ''` rather
    // than `as string` (CodeRabbit finding, TRO-428): the invariant above
    // is real, but asserting it away is worse than a fallback that's
    // simply never exercised in practice — a `ShipClientOptions.token:
    // string | undefined` widening plus pushing the requirement down into
    // `internal`-mode's own code paths would be the fully clean fix, but it
    // changes the constructor's public contract used by every existing
    // `ShipClient` call site (including many tests) — deferred to PF-704,
    // which already owns the flag-matrix work this rough edge belongs to
    // (see CHANGES.md, TRO-428).
    token: config.shipApiToken ?? '',
    client: resilientHttpClient,
    sdk: sharedSdkClient,
  });
  // TRO-342: the on-demand path DOES have a requesting user on every
  // invocation (the person asking in the chat panel), so it gets a FRESH
  // `ShipClient` per invocation, bound to that person's own token — never
  // the shared one above. See `OnDemandDeps.shipClientFactory`'s own
  // docstring (graph.ts) for the full rationale. PF-702: in `sdk` mode this
  // ALSO delegates through @ship/sdk, but authenticated with the asking
  // person's OWN token — never the app's Client Credentials token — so
  // TRO-342's "no service account for on-demand reads" guarantee is
  // unchanged by this ticket; only the wire protocol/response parsing
  // changes, not who is authenticated.
  const onDemandShipClientFactory = (token: string): ShipClient =>
    new ShipClient({
      baseUrl: config.shipApiBaseUrl,
      token,
      client: resilientHttpClient,
      sdk: config.agentPlatformMode === 'sdk' ? new SdkShipClient({ token, baseUrl: config.shipApiBaseUrl }) : undefined,
    });
  itemStore = new InMemoryItemStore();
  draftStore = new InMemoryDraftStore();
  // TRO-348: the SAME `resilientHttpClient` every other outbound call above
  // shares — its circuit breaker/self-throttle are about Ship's own health,
  // not caller identity, so a write path has no more reason to fragment that
  // state than the on-demand read path did (see `onDemandShipClientFactory`'s
  // own comment). `GateShipClient` itself holds no token — see
  // `shipClient.ts`'s "gate's write-capable client" section.
  gateShipClient = new GateShipClient({ baseUrl: config.shipApiBaseUrl, client: resilientHttpClient });
  // TRO-348: closes the gap `gate.ts`'s own `GateDeps.draftSurvivalTracker`
  // docstring named — "nothing currently constructs the production
  // `FileDraftSurvivalTracker` ... because nothing calls `acceptDraft` from a
  // real route yet." Now something does (the /accept-draft route below).
  draftSurvivalTracker = new FileDraftSurvivalTracker();
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

const app = createServer(config, { graph, itemStore, draftStore, gateShipClient, draftSurvivalTracker });

app.listen(config.port, () => {
  console.log(`[agent] listening on :${config.port}`);
});
