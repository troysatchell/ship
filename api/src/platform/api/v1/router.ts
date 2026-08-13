import { Router } from 'express';
import { requestIdMiddleware } from './requestId.js';
import { errorMiddleware, notFoundHandler } from './errorMiddleware.js';
import { documentsRouter } from './resources/documents.js';
import { v1OpenApiDocument } from '../../openapi/index.js';

/**
 * The public API router — `/api/v1/*` (PLUGFORGE.MD §2.1, §4 PF-001/PF-002).
 *
 * Stack, in fixed order:
 *   1. `requestIdMiddleware` — every request gets a `request_id` before
 *      anything else runs (PF-001).
 *   2. `v1Routes` — every actual `/api/v1` endpoint attaches HERE, not
 *      directly to `v1Router`. Because Express resolves a mounted router's
 *      own stack at request time (not at mount time), anything added to
 *      `v1Routes` later — a future ticket's resource router (PF-200 etc.),
 *      or a test's scratch route — is still tried before step 3 below,
 *      regardless of when it is registered relative to this module's own
 *      top-level code. Attaching new routes directly to `v1Router` below its
 *      own `.use()` calls at the bottom of this file would NOT have that
 *      property: those calls run once, at module-load time, so anything
 *      appended to `v1Router` afterwards would land AFTER the catch-all in
 *      step 3 and be permanently unreachable dead code.
 *   3. `notFoundHandler` — nothing above matched; produces the §2.5
 *      `not_found` shape (PF-002).
 *   4. `errorMiddleware` — terminal. Catches whatever `notFoundHandler`
 *      forwarded, plus any thrown/forwarded error from a v1 route (PF-002).
 *
 * `api/src/platform/api/v1/**` must never import from `api/src/routes/**`
 * (the internal handlers) — PLUGFORGE.MD §2.1's one-way boundary rule,
 * enforced by lint starting PF-003. This file imports nothing from there.
 */
export const v1Router = Router();
export const v1Routes = Router();

v1Router.use(requestIdMiddleware);
v1Router.use(v1Routes);

v1Routes.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// PF-200 (Linear TRO-398) — the documents resource.
v1Routes.use('/documents', documentsRouter);

// PF-202 (Linear TRO-402) — the generated /api/v1 OpenAPI 3.1 document.
// Public, no auth (same as /health above) — served from a module-load-time
// cache (`platform/openapi/index.ts`'s `v1OpenApiDocument`), not regenerated
// per request, since the registry only changes at deploy time.
v1Routes.get('/openapi.json', (_req, res) => {
  res.status(200).json(v1OpenApiDocument);
});

// Add new /api/v1 resource routes to `v1Routes` above this line — never
// below it, and never directly to `v1Router` (see the stack-order comment
// above for why).
v1Router.use(notFoundHandler);
v1Router.use(errorMiddleware);
