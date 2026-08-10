import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Extend Express Request with the per-request UUID this middleware assigns.
// Merges with the other `declare global { namespace Express { ... } }`
// augmentations in this codebase (e.g. `api/src/middleware/auth.ts`) — each
// file adds its own property, TypeScript combines them into one interface.
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Assigns a UUIDv4 `request_id` to every `/api/v1` request, attaches it to
 * `req.requestId` for downstream handlers/logs, and echoes it back as the
 * `X-Request-Id` response header (PLUGFORGE.MD §4, PF-001 AC).
 *
 * Logged here rather than left to be inferred from the header alone, so a
 * server-side log line can be correlated with a client-visible response
 * without the caller doing anything.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  // `req.baseUrl + req.path`, not `req.originalUrl` — `originalUrl` includes
  // the raw query string, so a caller's query params (which can carry
  // sensitive values, e.g. a token passed as `?access_token=...`) would leak
  // into this log line (finding #3, PR #170 review). `baseUrl + path` is the
  // matched mount prefix plus the path within it, no query string.
  console.log(`[api/v1] request_id=${requestId} ${req.method} ${req.baseUrl}${req.path}`);
  next();
}
