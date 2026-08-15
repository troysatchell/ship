import { Router } from 'express';
import type { Router as RouterType } from 'express';
import { requestIdMiddleware } from './requestId.js';
import { errorMiddleware, notFoundHandler } from './errorMiddleware.js';
import { documentsRouter } from './resources/documents.js';
import { v1OpenApiDocument } from '../../openapi/index.js';
import { issuesRouter } from './resources/issues.js';
import { sprintsRouter } from './resources/sprints.js';
import { meRouter } from './resources/me.js';
import { createWebhooksRouter } from './resources/webhooks.js';
import { auditRouter } from './resources/audit.js';
import { peopleRouter } from './resources/people.js';
import { changesRouter } from './resources/changes.js';
import { rateLimitDefaults } from '../../ratelimit/middleware.js';
import { auditLogMiddleware } from '../../audit/middleware.js';
import type { IWebhookDeliverer } from '../../webhooks/deliverer.js';

/**
 * The public API router — `/api/v1/*` (PLUGFORGE.MD §2.1, §4 PF-001/PF-002).
 *
 * Stack, in fixed order:
 *   1. `requestIdMiddleware` — every request gets a `request_id` before
 *      anything else runs (PF-001).
 *   2. `rateLimitDefaults` (PF-500, TRO-427) — sets baseline `X-RateLimit-*`
 *      headers on EVERY request, before any routing happens. This is what
 *      makes PLUGFORGE.MD §2.7's "100% of /api/v1 responses carry
 *      X-RateLimit-*" true even for a request `rateLimitBuckets` (mounted
 *      per-route, after each route's own `bearerAuth`) never reaches — an
 *      unauthenticated 401, a 404 from an unmatched route, or a genuinely
 *      public route like `GET /health`. See that file's own doc comment for
 *      the full reasoning.
 *   3. `auditLogMiddleware` (PF-501, TRO-432) — same "before routing" ordering
 *      rationale as `rateLimitDefaults` immediately above, applied to the
 *      public audit trail: it attaches a `res.on('finish')` listener that
 *      writes one `public_api_audit` row per request, observing every
 *      response `v1Routes` below produces AND every one it doesn't (401s,
 *      404s, /health). See `platform/audit/middleware.ts`'s own doc comment.
 *   4. `v1Routes` — every actual `/api/v1` endpoint attaches HERE, not
 *      directly to `v1Router`. Because Express resolves a mounted router's
 *      own stack at request time (not at mount time), anything added to
 *      `v1Routes` later — a future ticket's resource router (PF-200 etc.),
 *      or a test's scratch route — is still tried before step 4 below,
 *      regardless of when it is registered relative to this module's own
 *      top-level code. Attaching new routes directly to `v1Router` below its
 *      own `.use()` calls at the bottom of this file would NOT have that
 *      property: those calls run once, at module-load time, so anything
 *      appended to `v1Router` afterwards would land AFTER the catch-all in
 *      step 4 and be permanently unreachable dead code.
 *   5. `notFoundHandler` — nothing above matched; produces the §2.5
 *      `not_found` shape (PF-002).
 *   6. `errorMiddleware` — terminal. Catches whatever `notFoundHandler`
 *      forwarded, plus any thrown/forwarded error from a v1 route (PF-002).
 *
 * `api/src/platform/api/v1/**` must never import from `api/src/routes/**`
 * (the internal handlers) — PLUGFORGE.MD §2.1's one-way boundary rule,
 * enforced by lint starting PF-003. This file imports nothing from there.
 *
 * ── `createV1Router()` and the module-level `v1Router`/`v1Routes` default ──
 * (TRO-603.) `webhooksRouter` used to be a plain module-level `Router()`,
 * built once at module load — which meant `index.ts`'s real webhook
 * deliverer (constructed later, asynchronously, inside its own bootstrap)
 * could never reach it; `POST /deliveries/:id/replay` had no choice but to
 * build a throwaway `InMemoryWebhookDeliverer` per request (see
 * `resources/webhooks.ts`'s own history of that limitation). Fixed by making
 * router construction itself a factory, `createV1Router(webhookDeliverer?)`,
 * mirroring `resources/webhooks.ts`'s own `createWebhooksRouter()` change and
 * the pre-existing `createOAuthAuthorizeRouter(webOrigin)` precedent
 * (`routes/oauth-authorize.ts`).
 *
 * The module-level `v1Router`/`v1Routes` exports below are the factory
 * called with no deliverer — i.e. exactly the router this file always built,
 * byte-for-byte — kept so every existing consumer that imports them directly
 * (`app.ts`'s default path, and the handful of test files that mount
 * `v1Router`/attach scratch routes to `v1Routes` without going through
 * `createApp()`) needs no change. `app.ts`'s `createApp()` only calls
 * `createV1Router(options.webhookDeliverer)` itself when a caller (in
 * practice, `index.ts`) actually passes one; every other `createApp()` call
 * site keeps using this default singleton, unchanged.
 */
export function createV1Router(webhookDeliverer?: IWebhookDeliverer): {
  v1Router: RouterType;
  v1Routes: RouterType;
} {
  const v1Router = Router();
  const v1Routes = Router();

  v1Router.use(requestIdMiddleware);
  v1Router.use(rateLimitDefaults);
  v1Router.use(auditLogMiddleware);
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

  // PF-201 (Linear TRO-400) — issues, sprints, and me: typed views over the
  // unified document model, plus the bearer-token identity endpoint.
  v1Routes.use('/issues', issuesRouter);
  v1Routes.use('/sprints', sprintsRouter);
  v1Routes.use('/me', meRouter);

  // PF-302 (Linear TRO-431) — webhook subscriptions CRUD + rotation.
  v1Routes.use('/webhooks', createWebhooksRouter(webhookDeliverer));

  // PF-501 (Linear TRO-432) — the public API audit trail.
  v1Routes.use('/audit', auditRouter);

  // PF-205 (Linear TRO-414) — the agent's remaining reads: people directory
  // and the public change-feed contract (distinct from webhooks — see
  // resources/changes.ts's header for why the two must not be conflated).
  v1Routes.use('/people', peopleRouter);
  v1Routes.use('/changes', changesRouter);

  // Add new /api/v1 resource routes to `v1Routes` above this line — never
  // below it, and never directly to `v1Router` (see the stack-order comment
  // above for why).
  v1Router.use(notFoundHandler);
  v1Router.use(errorMiddleware);

  return { v1Router, v1Routes };
}

// Default singleton instance — see the doc comment above for why this
// exists alongside `createV1Router()`.
const defaultV1 = createV1Router();
export const v1Router: RouterType = defaultV1.v1Router;
export const v1Routes: RouterType = defaultV1.v1Routes;
