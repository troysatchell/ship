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
  /** The item store, when config is complete (TRO-323 / FG-10) — same
   * hoisting pattern as `graph`: `index.ts` only constructs one inside its
   * `isConfigComplete` branch. `undefined` here means `/inbox` degrades to a
   * clear 503 rather than calling `.list` on nothing. Narrowed to
   * `Pick<ItemStore, 'list'>` — same reasoning as `graph`'s narrowing to
   * `Pick<CompiledGraph, 'invoke'>` — so tests can pass a plain stable fake
   * instead of a real `InMemoryItemStore`. */
  itemStore?: Pick<ItemStore, 'list'>;
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
}

function isValidChatRequestBody(body: unknown): body is ChatRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.seedDocumentId === 'string' && b.seedDocumentId.length > 0 &&
    typeof b.question === 'string' && b.question.trim().length > 0 &&
    typeof b.askingUserId === 'string' && b.askingUserId.length > 0
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
      res.status(400).json({ error: 'invalid_request', message: 'seedDocumentId, question, and askingUserId are all required strings' });
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

  return app;
}
