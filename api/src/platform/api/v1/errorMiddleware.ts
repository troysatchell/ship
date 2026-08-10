import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError, notFoundError, serverError } from './errors.js';

/**
 * PF-002 (PLUGFORGE.MD §2.5, §4) — mounted on `v1Router` in this exact order
 * (see `router.ts`): every real route/resource router first, THEN
 * `notFoundHandler`, THEN `errorMiddleware`. Anything that reaches
 * `notFoundHandler` matched no route above it; anything that reaches
 * `errorMiddleware` either came from `notFoundHandler` or was
 * thrown/forwarded (`next(err)`) by a route above it.
 *
 * New `/api/v1` routes attach to `v1Routes` (exported from `router.ts`), not
 * directly to `v1Router` — see the comment there for why that split exists.
 */

/**
 * Reads the per-request id PF-001's `requestIdMiddleware` attaches to every
 * `/api/v1` request (mounted first on `v1Router`, before anything in this
 * file runs). The fallback is defensive only — every request reaching this
 * router already ran that middleware, so it is not expected to be exercised
 * in practice, but `req.requestId` is typed optional on `express.Request`
 * (`requestId.ts`), so TypeScript cannot see that guarantee statically.
 */
function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/**
 * Wraps an async Express handler so a rejected promise reaches
 * `errorMiddleware` instead of becoming an unhandled rejection. Express 4
 * (this repo's version — `api/package.json`) auto-forwards a *synchronous*
 * throw inside a route handler to `next(err)`, but not a rejected promise
 * from an `async` function — that requires an explicit `.catch(next)`. Every
 * `/api/v1` route that does real work (a DB call — most of what later
 * resource tickets, e.g. PF-200, will add) will be async, so this ticket
 * provides the wrapper those routes need for the 500-sanitization contract
 * to actually hold. Not required by this ticket's own two specified test
 * cases (both use a synchronous throw) — see `error-middleware.test.ts`'s
 * "additional coverage" case for the async proof, and no route in this
 * ticket uses it yet.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Catch-all mounted after every real route on `v1Router` (via `v1Routes`).
 * AC: "unknown-route ... produce the shape." Forwards a `not_found`
 * `ApiError` into `errorMiddleware` below rather than responding directly,
 * so the response body is built in exactly one place regardless of which
 * failure path produced it.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  const requestId = requestIdOf(req);
  next(notFoundError(requestId, `No route matches ${req.method} ${req.baseUrl}${req.path}`));
};

/**
 * Terminal error handler for `v1Router`. Two paths:
 *  - `err` is an `ApiError` (thrown deliberately by a route, or forwarded by
 *    `notFoundHandler` above): serialize it as-is via `.toJSON()` — its
 *    fields already are the public §2.5 contract.
 *  - anything else (an unexpected `Error`, a rejected promise's reason, or
 *    any other thrown value) is sanitized into a generic `server_error`
 *    before it reaches the client (AC: "500 sanitization ... no stack
 *    leaks"). The original error is logged server-side, correlated by
 *    `request_id`, per the architect note ("log server-side with
 *    request_id") — a logging side effect this ticket's tests do not assert
 *    on (test design: "NOT ASSERTED").
 */
export const errorMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = requestIdOf(req);

  if (err instanceof ApiError) {
    if (err.code === 'server_error') {
      console.error(`[api/v1] request_id=${requestId} server_error: ${err.message}`);
    }
    res.status(err.httpStatus).json(err.toJSON());
    return;
  }

  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[api/v1] request_id=${requestId} unhandled error:`, detail);

  const sanitized = serverError(requestId);
  res.status(sanitized.httpStatus).json(sanitized.toJSON());
};
