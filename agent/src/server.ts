/**
 * HTTP surface for the agent service (TRO-313 / FG-2; upgraded by
 * TRO-315 / FG-4).
 *
 * `/health` — process alive. Always 200; no dependency check. This is what
 * Terraform (FG-11) points its platform health check at.
 * `/ready`  — Ship API reachable AND config loaded. 503 otherwise, via the
 * resilient client (timeout + retry/backoff + circuit breaker +
 * self-throttle) — a process that is up but cannot reach Ship keeps running
 * (FG-4's degradation contract) while signalling that it cannot yet serve
 * real requests.
 *
 * The `client` is built once per server (not per request) and reused across
 * every `/ready` poll — the circuit breaker's whole point is to remember
 * state ACROSS calls, so constructing a fresh one per request would silently
 * defeat it.
 */

import express, { type Express } from 'express';
import type { AgentConfig } from './config.js';
import { isConfigComplete } from './config.js';
import { checkReady, type ShipReadClient } from './health.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { RateLimiter } from './rateLimiter.js';
import { ResilientClient } from './resilientClient.js';

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

  return app;
}
