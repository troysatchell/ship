/**
 * HTTP surface for the agent service (TRO-313 / FG-2; upgraded by
 * TRO-315 / FG-4; extended by TRO-320 / FG-9).
 *
 * `/health` — process alive. Always 200; no dependency check. This is what
 * Terraform (FG-11) points its platform health check at.
 * `/ready`  — Ship API reachable AND config loaded. 503 otherwise, via the
 * resilient client (timeout + retry/backoff + circuit breaker +
 * self-throttle) — a process that is up but cannot reach Ship keeps running
 * (FG-4's degradation contract) while signalling that it cannot yet serve
 * real requests.
 * `/chat`   — POST only (TRO-320 / FG-9). The route FG-9's Ship-side chat
 * panel proxies through (`api/src/routes/agent.ts` — the browser never calls
 * this service directly, see that file's own docstring for why). Requires a
 * matching `X-Internal-Secret` header, checked BEFORE the graph is ever
 * touched — this service is reachable from the public internet (a Render
 * service, no private networking configured), so an unauthenticated route
 * here would let anyone spend the configured Anthropic API budget and query
 * as an arbitrary `askingUserId`. Degrades the same way `/ready` does when
 * `deps.graph` is absent (config incomplete): a clear 503, never a hang.
 * `askingUserToken` (TRO-342) is likewise required in the body — the
 * expansion walk (`graph.ts`'s `resolveSeed`/`expandFrontier`) authenticates
 * every outbound Ship read as THIS token's own owner, never a shared
 * process-level one; `api/src/routes/agent.ts` mints it fresh per request
 * from the caller's own session, it is never client-suppliable.
 * Also bounded once the graph IS present (CodeRabbit review, PR #120):
 * `graph.invoke` races against `config.chatHandlerTimeoutMs`, aborted via a
 * real `AbortSignal` LangGraph itself honors — a 504 after that window,
 * never an unbounded wait on a hung model/Ship call. See the route's own
 * comment for exactly what that cancellation does and does not reach.
 * `/inbox`  — GET only (TRO-323 / FG-10). The route Ship's ranked-inbox
 * surface proxies through (`api/src/routes/agent.ts`'s own `GET /inbox`).
 * Same `X-Internal-Secret` check as `/chat`, same public-internet exposure
 * reasoning, same 503-when-unconfigured degradation. Does no ranking or
 * filtering of its own — `itemStore.list()` (`itemStore.ts`) is already
 * fully ranked (FG-5/FG-6), so this route is read-only plumbing, not a
 * second place that could disagree with the store about order.
 * `/accept-draft` — POST only (TRO-348). The route Ship's inbox/draft-review
 * surface proxies through (`api/src/routes/agent.ts`'s own
 * `POST /accept-draft`) to actually call `gate.ts`'s `acceptDraft` — FG-8
 * built that function, tested it, and never wired it to anything a real
 * request could reach; this route is that missing wire. Same
 * `X-Internal-Secret` check and 503-when-unconfigured degradation as
 * `/chat`/`/inbox`. `accepterToken` in the body is the ACCEPTING PERSON'S
 * OWN Ship API token — same non-negotiable posture as `/chat`'s
 * `askingUserToken` (TRO-342): `api/src/routes/agent.ts` mints it fresh per
 * request from the caller's own session, it is never client-suppliable, and
 * it is what lets `acceptDraft`'s Ship write attribute to the accepting
 * person instead of the agent's own identity. A `GateError` (no such draft /
 * already posted / no such pending transition — `gate.ts`) is a domain
 * outcome, not a service failure, so it is surfaced as 404/409 rather than
 * collapsed into the generic 502 `/chat`/`/inbox` use for an unreachable or
 * misbehaving dependency.
 *
 * The `client` is built once per server (not per request) and reused across
 * every `/ready` poll — the circuit breaker's whole point is to remember
 * state ACROSS calls, so constructing a fresh one per request would silently
 * defeat it.
 */

import { timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import type { AgentConfig } from './config.js';
import { isConfigComplete } from './config.js';
import { checkReady, type ShipReadClient } from './health.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { RateLimiter } from './rateLimiter.js';
import { ResilientClient } from './resilientClient.js';
import type { CompiledGraph } from './graph.js';
import type { ItemStore } from './itemStore.js';
import type { DraftStore } from './draftStore.js';
import type { GateShipClientLike } from './shipClient.js';
import type { DraftSurvivalTracker } from './draftSurvival.js';
import { acceptDraft, GateError } from './gate.js';

const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/** Constant-time secret comparison — a plain `===` on a security-sensitive
 * header leaks timing information about how many leading bytes matched.
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * so that case is handled explicitly first. */
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

const THROTTLE_WINDOW_MS = 60_000; // shipSelfThrottleRpm is requests/minute

export function buildShipClient(config: AgentConfig, fetchImpl?: typeof fetch): ResilientClient {
  return new ResilientClient({
    breaker: new CircuitBreaker({
      failureThreshold: config.shipBreakerFailureThreshold,
      cooldownMs: config.shipBreakerCooldownMs,
    }),
    rateLimiter: new RateLimiter({
      maxPerWindow: config.shipSelfThrottleRpm,
      windowMs: THROTTLE_WINDOW_MS,
    }),
    timeoutMs: config.shipRequestTimeoutMs,
    retry: { maxAttempts: config.shipRetryMaxAttempts, baseDelayMs: 200 },
    fetchImpl,
  });
}

export interface CreateServerDeps {
  /** Override the Ship client — tests inject a stable fake here. */
  client?: ShipReadClient;
  /** Only used when `client` is not provided, to build the default one. */
  fetchImpl?: typeof fetch;
  /** The compiled graph, when config is complete (TRO-320 / FG-9) — `index.ts`
   * only constructs one inside its `isConfigComplete` branch, same as
   * `shipClient`/`itemStore` today. `undefined` here means `/chat` degrades
   * to a clear 503 rather than calling `.invoke` on nothing. Narrowed to
   * `Pick<CompiledGraph, 'invoke'>` — same pattern as
   * `ProactivePollerOptions.graph` (`proactivePoll.ts`) — so tests can pass a
   * plain stable fake instead of a real compiled graph. */
  graph?: Pick<CompiledGraph, 'invoke'>;
  /** The item store, when config is complete (TRO-323 / FG-10; widened by
   * TRO-348 to also carry `dismiss`, which `POST /accept-draft` needs to
   * remove the draft's inbox item the same way `gate.ts`'s `acceptDraft`
   * always has) — same hoisting pattern as `graph`: `index.ts` only
   * constructs one inside its `isConfigComplete` branch. `undefined` here
   * means `/inbox` AND `/accept-draft` both degrade to a clear 503 rather
   * than calling a method on nothing. Narrowed to `Pick<ItemStore, 'list' |
   * 'dismiss'>` — same reasoning as `graph`'s narrowing to
   * `Pick<CompiledGraph, 'invoke'>` — so tests can pass a plain stable fake
   * instead of a real `InMemoryItemStore`. `'get'` is ALSO required here
   * (beyond what `/inbox`'s own `.list()` call needs) purely so this type
   * satisfies `gate.ts`'s `GateDeps.itemStore` — a `Pick<ItemStore, 'get' |
   * 'dismiss'>` shared across every function in that file, even though
   * `acceptDraft` itself only ever calls `.dismiss()` (see that file's own
   * comment on why the shared type is wider than any one function's use). */
  itemStore?: Pick<ItemStore, 'list' | 'get' | 'dismiss'>;
  /** The deep tier's own draft store (TRO-348) — the SAME `InMemoryDraftStore`
   * instance `index.ts`'s `deepDeps` already writes into, hoisted the same
   * way `itemStore`/`graph` are: undefined here means `POST /accept-draft`
   * degrades to a clear 503 instead of calling a method on nothing. Matches
   * `gate.ts`'s own `GateDeps.draftStore` Pick exactly (`'get' |
   * 'markPosted' | 'markDismissed' | 'setProposedTransitionStatus'`) —
   * `acceptDraft` itself only calls `.get()`/`.markPosted()`, but `GateDeps`
   * is one type shared with `discardItem`/`acceptProposedTransition`/
   * `rejectProposedTransition`, so this has to satisfy the same shape to be
   * passed through to `acceptDraft` at all. */
  draftStore?: Pick<DraftStore, 'get' | 'markPosted' | 'markDismissed' | 'setProposedTransitionStatus'>;
  /** The gate's write-capable Ship client (TRO-348) — `gate.ts`'s own
   * `GateShipClientLike`, built once in `index.ts` from the SAME
   * `ResilientClient` every other outbound call shares (its circuit
   * breaker/self-throttle are about Ship's own health, not caller identity).
   * Holds no token of its own — every call to it takes the accepting
   * person's token as an explicit argument (see this file's module
   * docstring). `undefined` here means `/accept-draft` degrades to 503. */
  gateShipClient?: GateShipClientLike;
  /** TRO-338 / FG-20's production signal, finally given a live caller
   * (TRO-348) — a real `FileDraftSurvivalTracker`, constructed in `index.ts`
   * only inside the `isConfigComplete` branch. Optional even when every
   * other TRO-348 dep is present: `gate.ts`'s `acceptDraft` already treats a
   * missing tracker as "don't record," non-fatally, and that degrade-alone
   * behavior is worth preserving here rather than making the whole route
   * depend on the ledger file being writable. */
  draftSurvivalTracker?: DraftSurvivalTracker;
}

/** Request body `POST /chat` expects — mirrors the on-demand expansion
 * path's own invocation shape (`graph.ts`'s module docstring / FG-7's
 * `trace-invoke-on-demand.ts`). Not validated with a schema library: this
 * package has no existing dependency on one (`agent/package.json`), and
 * three required-string fields don't warrant adding one. */
interface ChatRequestBody {
  seedDocumentId: string;
  question: string;
  askingUserId: string;
  /** The asking user's OWN Ship API token (TRO-342) — minted per-request by
   * `api/src/routes/agent.ts` (never something a browser could supply
   * itself; that route builds it server-side from the session's own
   * `req.userId`) and required exactly like `askingUserId`: every real
   * `/chat` call already carries a `seedDocumentId` (also required below),
   * which always routes into `resolveSeed`/`expandFrontier` — so every
   * request this validator accepts is one that will actually need a token
   * to authenticate its Ship reads with. See `graph.ts`'s
   * `requireAskingUserToken` for what happens if a caller upstream of this
   * check is ever changed to omit it. */
  askingUserToken: string;
}

function isValidChatRequestBody(body: unknown): body is ChatRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.seedDocumentId === 'string' && b.seedDocumentId.length > 0 &&
    typeof b.question === 'string' && b.question.trim().length > 0 &&
    typeof b.askingUserId === 'string' && b.askingUserId.length > 0 &&
    typeof b.askingUserToken === 'string' && b.askingUserToken.length > 0
  );
}

/** Request body `POST /accept-draft` expects (TRO-348) — mirrors `gate.ts`'s
 * `acceptDraft(deps, draftId, accepterToken, finalText)` signature exactly,
 * one field per positional argument (after `deps`, which this route builds
 * from its own injected dependencies, never from the request). */
interface AcceptDraftRequestBody {
  draftId: string;
  /** The ACCEPTING PERSON'S OWN Ship API token — same non-negotiable
   * requirement as `ChatRequestBody.askingUserToken` above, and for the same
   * reason: `api/src/routes/agent.ts` mints this fresh per request from the
   * caller's own session, never something a browser could supply itself. */
  accepterToken: string;
  /** Optional — omitted means "post the draft's own original text
   * unedited" (`gate.ts`'s `acceptDraft` defaults to `draft.draftText`).
   * Present only when the accepting person edited the draft before posting. */
  finalText?: string;
}

function isValidAcceptDraftRequestBody(body: unknown): body is AcceptDraftRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.draftId === 'string' && b.draftId.length > 0 &&
    typeof b.accepterToken === 'string' && b.accepterToken.length > 0 &&
    (b.finalText === undefined || typeof b.finalText === 'string')
  );
}

export function createServer(config: AgentConfig, deps: CreateServerDeps = {}): Express {
  const client: ShipReadClient = deps.client ?? buildShipClient(config, deps.fetchImpl);

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (_req, res) => {
    const result = await checkReady({
      shipApiBaseUrl: config.shipApiBaseUrl,
      configComplete: isConfigComplete(config),
      client,
    });

    if (!result.ready) {
      res.status(503).json({ status: 'not_ready', reason: result.reason });
      return;
    }
    res.status(200).json({ status: 'ready' });
  });

  app.post('/chat', async (req, res) => {
    // Checked before anything else, including whether the graph exists —
    // an unconfigured deployment should not leak "not configured" to a
    // caller that never proved it's allowed to ask (TRO-320's own security
    // note: this route is reachable from the public internet).
    if (!config.agentInternalSecret) {
      // No secret configured on THIS process at all — every request must be
      // rejected; there is no value any caller could ever present that
      // would be correct. Distinct from a wrong/missing header (401): this
      // is a server misconfiguration, not a caller failure.
      res.status(500).json({ error: 'internal_secret_not_configured' });
      return;
    }
    const provided = req.header(INTERNAL_SECRET_HEADER);
    if (!provided || !secretsMatch(provided, config.agentInternalSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!deps.graph) {
      // Config incomplete (no ANTHROPIC_API_KEY/SHIP_API_BASE_URL/
      // SHIP_API_TOKEN) — same degradation contract as /ready: signal
      // plainly rather than hang or throw calling .invoke on nothing.
      res.status(503).json({ error: 'agent_not_configured' });
      return;
    }

    if (!isValidChatRequestBody(req.body)) {
      res.status(400).json({ error: 'invalid_request', message: 'seedDocumentId, question, askingUserId, and askingUserToken are all required strings' });
      return;
    }

    // CodeRabbit review, PR #120: api/'s proxy aborts its own outbound fetch
    // after AGENT_REQUEST_TIMEOUT_MS (30s, api/src/routes/agent.ts) — but
    // that only stops api/'s wait; a hung graph/model/Ship call would
    // otherwise keep this handler (and the request slot it holds) alive
    // indefinitely for a caller that already received a 502. Race the
    // invoke against a timer, AND propagate real cancellation, not just an
    // abandoned promise: `CompiledGraph#invoke` accepts a `RunnableConfig`
    // whose `signal` LangGraph itself honors — verified directly against
    // `@langchain/langgraph` (not assumed from its types): aborting mid-run
    // makes `invoke()` reject within ~10ms of the signal firing, rather than
    // waiting for whatever node was in flight to finish on its own. Passing
    // the signal is a genuine improvement over a bare `Promise.race`, which
    // would leave this exact graph run orphaned in the background forever
    // with nothing left to observe its eventual settlement.
    //
    // Full honesty about what this does NOT do (read before trusting a
    // "cancelled" claim you didn't verify — CLAUDE.md's own provenance
    // rule): neither `AnthropicModel.invoke(input: string)` (this file's own
    // narrow model interface, `graph.ts`) nor any `ShipClientLike` method
    // (`shipClient.ts`) accepts or forwards a signal, even though the
    // underlying `ResilientClient.get`/`request` (`resilientClient.ts`) DOES
    // support one — nothing in `graph.ts`'s node bodies threads `config`
    // through to either call today. So when the abort fires while a node's
    // own `model.invoke()`/Ship HTTP call is already in flight, THAT single
    // call keeps running to completion server-side (confirmed with a
    // throwaway probe against the real package: the node's own awaited
    // promise settled ~3s after `invoke()` had already rejected) — this
    // timeout bounds THIS HANDLER'S response, not every byte of work the
    // graph kicked off. Threading the signal into `AnthropicModel`/
    // `ShipClientLike` themselves would close that gap; it is a real,
    // separately-scoped change to graph.ts's node bodies and every caller
    // of those interfaces, not a one-line addition here.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.chatHandlerTimeoutMs);
    try {
      const result = await deps.graph.invoke(
        {
          trigger: 'on_demand',
          input: req.body.question,
          seedDocumentId: req.body.seedDocumentId,
          askingUserId: req.body.askingUserId,
          askingUserToken: req.body.askingUserToken,
        },
        { signal: controller.signal }
      );
      res.status(200).json({
        output: result.output,
        citedSources: result.citedSources,
        expansionCapped: result.expansionCapped,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // The timer fired, not a graph-internal failure. Distinct from the
        // 502 branch below: the caller (api/'s proxy) has almost certainly
        // already given up by the time this fires (its own 30s bound is
        // longer than chatHandlerTimeoutMs's default, but not guaranteed
        // under load), so this just frees the handler rather than claiming
        // any particular downstream effect.
        console.error(
          `[agent] /chat timed out after ${config.chatHandlerTimeoutMs}ms waiting on graph.invoke — ` +
            'the underlying node call may still be running server-side; see this handler\'s own comment.'
        );
        res.status(504).json({ error: 'graph_invoke_timeout' });
        return;
      }
      // Never let a graph-internal failure (a bad Ship response, a model
      // error) reach the caller as a raw stack trace or an unresolving
      // request — same posture as ResilientClient's own normalized errors.
      console.error('[agent] /chat graph invocation failed:', err);
      res.status(502).json({ error: 'graph_invoke_failed' });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get('/inbox', (req, res) => {
    // Same order as /chat: the secret check runs before anything else,
    // including whether itemStore exists — an unconfigured deployment
    // should not leak "not configured" to a caller that never proved it's
    // allowed to ask (this route is reachable from the public internet too).
    if (!config.agentInternalSecret) {
      res.status(500).json({ error: 'internal_secret_not_configured' });
      return;
    }
    const provided = req.header(INTERNAL_SECRET_HEADER);
    if (!provided || !secretsMatch(provided, config.agentInternalSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!deps.itemStore) {
      // Config incomplete — same degradation contract as /chat's `!deps.graph`
      // branch and /ready: a clear 503, never a hang and never an empty list
      // that would read as "no items" instead of "not configured."
      res.status(503).json({ error: 'agent_not_configured' });
      return;
    }

    const recipientUserId = req.query.recipientUserId;
    if (typeof recipientUserId !== 'string' || recipientUserId.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'recipientUserId is required' });
      return;
    }

    // itemStore.list() is already fully ranked (itemStore.ts's own
    // docstring: blocking_approval first, highest blockedCount first within
    // that, ties broken by longest-waiting; then mention oldest-first; then
    // standup_draft oldest-first) — this route does no sorting of its own.
    const items = deps.itemStore.list(recipientUserId);
    res.status(200).json({ items });
  });

  app.post('/accept-draft', async (req, res) => {
    // Same order as /chat and /inbox: the secret check runs before anything
    // else, including whether the gate's own deps exist — this route is
    // reachable from the public internet too (TRO-320's own reasoning
    // applies unchanged; this route performs a real Ship WRITE, so an
    // unauthenticated caller here is worse than /chat's read-only exposure).
    if (!config.agentInternalSecret) {
      res.status(500).json({ error: 'internal_secret_not_configured' });
      return;
    }
    const provided = req.header(INTERNAL_SECRET_HEADER);
    if (!provided || !secretsMatch(provided, config.agentInternalSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!deps.draftStore || !deps.itemStore || !deps.gateShipClient) {
      // Config incomplete — same degradation contract as /chat's `!deps.graph`
      // and /inbox's `!deps.itemStore` branches: a clear 503, never a hang
      // and never a half-performed write.
      res.status(503).json({ error: 'agent_not_configured' });
      return;
    }

    if (!isValidAcceptDraftRequestBody(req.body)) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'draftId and accepterToken are required strings; finalText, if present, must be a string',
      });
      return;
    }

    try {
      const result = await acceptDraft(
        {
          shipClient: deps.gateShipClient,
          itemStore: deps.itemStore,
          draftStore: deps.draftStore,
          draftSurvivalTracker: deps.draftSurvivalTracker,
        },
        req.body.draftId,
        req.body.accepterToken,
        req.body.finalText
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof GateError) {
        // A domain outcome (no such draft / already posted), not a service
        // failure — surfaced distinctly from the generic 502 below so a
        // caller (api/'s proxy, eventually a UI) can render "already
        // posted"/"not found" rather than a generic "agent unavailable."
        const status = err.message.startsWith('no such draft') ? 404 : 409;
        res.status(status).json({ error: 'gate_error', message: err.message });
        return;
      }
      // Everything else (a Ship write itself failing, e.g. ShipApiError from
      // GateShipClient) — never a raw stack trace or an unresolving request,
      // same posture as /chat's graph_invoke_failed branch.
      console.error('[agent] /accept-draft failed:', err);
      res.status(502).json({ error: 'accept_draft_failed' });
    }
  });

  return app;
}
