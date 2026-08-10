import { Router } from 'express';
import { requestIdMiddleware } from './requestId.js';

/**
 * The public API router — `/api/v1/*` (PLUGFORGE.MD §2.1, §4 PF-001).
 *
 * Deliberately minimal in this ticket: request-id middleware plus a health
 * check. What it does NOT have yet, on purpose, because the infrastructure
 * doesn't exist until later tickets:
 *   - No bearer auth / scope checks (PF-107, E1).
 *   - No `ApiError`-shaped error handling or 404 fallthrough (PF-002).
 *   - No OpenAPI registration (PF-202 creates the v1 registry this route
 *     needs to register against — see `api/src/platform/README.md`).
 * `/health` needs none of the above: it is an unauthenticated liveness
 * check, same convention as the existing internal `GET /health` in
 * `api/src/app.ts`.
 *
 * `api/src/platform/api/v1/**` must never import from `api/src/routes/**`
 * (the internal handlers) — PLUGFORGE.MD §2.1's one-way boundary rule,
 * enforced by lint starting PF-003. This file imports nothing from there.
 */
export const v1Router = Router();

v1Router.use(requestIdMiddleware);

v1Router.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
