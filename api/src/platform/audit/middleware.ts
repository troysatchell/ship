/**
 * `auditLogMiddleware` — writes one `public_api_audit` row per `/api/v1`
 * request (PLUGFORGE.MD §2.7, §4 PF-501/TRO-432).
 *
 * Mounted globally on `v1Router`, immediately after `rateLimitDefaults` and
 * before `v1Routes` (`platform/api/v1/router.ts`) — same position rationale
 * that file already documents for `rateLimitDefaults` itself: it has to run
 * before routing so it observes EVERY response, including ones no specific
 * resource route ever produces — `GET /health`, `GET /openapi.json`, a 401
 * from `bearerAuth` before any route handler runs, a 404 from
 * `notFoundHandler`, a 403 from `requireScope`. This is the literal reading
 * of the architect note ("middleware records EVERY v1 call") and the PLAN's
 * §2.7 "100% of /api/v1 responses" language, mirrored from how PF-500's
 * `rateLimitDefaults` already achieves the equivalent guarantee for
 * `X-RateLimit-*` headers.
 *
 * Mounting a listener early and reading state at 'finish' — not writing
 * inline — is what lets this middleware observe the FINAL status
 * code/latency of a request that fails deep inside routing: by the time
 * `res.on('finish')` fires, whatever ran downstream (`bearerAuth`,
 * `requireScope`, a resource handler) has already set `req.principal` /
 * `req.auditScopeUsed` and `res.statusCode`, all readable here via closure
 * over the same `req`/`res` objects Express passes through the whole chain.
 *
 * Fire-and-forget by design (architect note, this ticket's brief: "write
 * async/fire-and-forget so it never blocks the response ... but test rows do
 * land, i.e. don't drop writes, just don't await them in the request's
 * critical path"):
 *   - "never blocks the response": the INSERT is only ever started inside
 *     `res.on('finish')`, i.e. strictly AFTER the response has already been
 *     sent — there is no way for this write's latency to add to any
 *     caller's request, by construction, not by racing an unawaited promise
 *     against `res.end()`.
 *   - "don't drop writes": `writeAuditRow` is a real `await`ed query inside
 *     an async function, not `pool.query(...)` fired with its promise
 *     discarded — a failure is caught and logged (never silently lost), and
 *     `__tests__/middleware.test.ts` proves a row actually lands after a
 *     real HTTP round-trip, not just that this file compiles.
 */

import type { NextFunction, Request, Response } from 'express';
import { pool } from '../../db/client.js';

export interface AuditRowInput {
  requestId: string;
  appClientId: string | null;
  userId: string | null;
  method: string;
  route: string;
  scopeUsed: string | null;
  status: number;
  latencyMs: number;
}

/** The one place `public_api_audit` is ever written to — exported so the
 *  regression test can call it directly as a pure DB-write unit test,
 *  separate from the HTTP-level integration test that proves
 *  `auditLogMiddleware` actually wires this up on a real request. */
export async function writeAuditRow(input: AuditRowInput): Promise<void> {
  await pool.query(
    `INSERT INTO public_api_audit
       (request_id, app_client_id, user_id, method, route, scope_used, status, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.requestId,
      input.appClientId,
      input.userId,
      input.method,
      input.route,
      input.scopeUsed,
      input.status,
      input.latencyMs,
    ]
  );
}

/**
 * The literal request path, no query string — `req.originalUrl` is set once
 * at the top of the request and is never rewritten as nested routers
 * descend (unlike `req.url`/`req.baseUrl`, which Express mutates while
 * dispatching into `v1Routes` -> a resource sub-router -> a matched route).
 * Reading it here, at 'finish' time, avoids depending on exactly how far
 * Express's `req.baseUrl`/`req.route` bookkeeping has unwound by the point a
 * handler sent its response without calling `next()` again — a route
 * pattern (`/documents/:id`) would be nicer for grouping, but a literal path
 * is unambiguously correct for every case (matched route, 404, or a request
 * rejected before routing even started) with no framework-internals
 * assumption to get wrong.
 *
 * Deliberately drops the query string — same reasoning `requestId.ts`'s own
 * request-line log already states: a caller's query params can carry
 * sensitive values (e.g. a token passed as `?access_token=...`), so they
 * must never reach a log line or a stored row.
 */
function routeOf(req: Request): string {
  const [pathOnly] = req.originalUrl.split('?');
  return pathOnly && pathOnly.length > 0 ? pathOnly : req.path;
}

export function auditLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAtNs = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
    const requestId = req.requestId ?? 'missing-request-id';
    const principal = req.principal;

    void writeAuditRow({
      requestId,
      appClientId: principal?.app?.clientId ?? null,
      userId: principal?.user?.id ?? null,
      method: req.method,
      route: routeOf(req),
      scopeUsed: req.auditScopeUsed ?? null,
      status: res.statusCode,
      latencyMs: Math.round(latencyMs),
    }).catch((error) => {
      // The response is already sent by the time this listener runs — an
      // audit-write failure must never surface to the caller. Logged
      // server-side only, correlated by request_id (same convention as
      // errorMiddleware.ts's server_error logging).
      console.error(`[api/v1] request_id=${requestId} public_api_audit write failed:`, error);
    });
  });

  next();
}
