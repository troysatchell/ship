/**
 * HTTP surface for the agent service (TRO-313 / FG-2).
 *
 * `/health` — process alive. Always 200; no dependency check. This is what
 * Terraform (FG-11) points its platform health check at.
 * `/ready`  — Ship API reachable AND config loaded. 503 otherwise. Distinct
 * from `/health` on purpose: a process that is up but cannot reach Ship
 * should keep running (FG-4's degradation contract) while signalling that it
 * cannot yet serve real requests.
 */

import express, { type Express } from 'express';
import type { AgentConfig } from './config.js';
import { isConfigComplete } from './config.js';
import { checkReady } from './health.js';

export interface CreateServerDeps {
  fetchImpl?: typeof fetch;
}

export function createServer(config: AgentConfig, deps: CreateServerDeps = {}): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (_req, res) => {
    const result = await checkReady({
      shipApiBaseUrl: config.shipApiBaseUrl,
      configComplete: isConfigComplete(config),
      timeoutMs: config.shipRequestTimeoutMs,
      fetchImpl: deps.fetchImpl,
    });

    if (!result.ready) {
      res.status(503).json({ status: 'not_ready', reason: result.reason });
      return;
    }
    res.status(200).json({ status: 'ready' });
  });

  return app;
}
