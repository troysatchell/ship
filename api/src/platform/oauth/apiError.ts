/**
 * Local construction of the §2.5 `ApiError` JSON shape, scoped to this
 * ticket (PF-107 / TRO-430) only:
 *
 *   { code, message, details?, request_id }
 *
 * PF-002 ("`ApiError` + public error middleware") is being built on a
 * separate, unmerged branch at the same time as this ticket. Importing its
 * error-shape module from here would create a merge-order dependency between
 * two tickets the PRD/Linear graph does not otherwise couple — whichever of
 * the two branches merges second would need to rebase against code that
 * didn't exist when it was written. Instead, this file reproduces the
 * *shape* PLUGFORGE.MD §2.5 defines (the JSON contract, not PF-002's
 * implementation) locally, so PF-107 and PF-002 can merge in either order.
 *
 * CONSOLIDATION POINT — flagged in this ticket's final report: once PF-002
 * lands, replace every call site below (`bearerAuth.ts`, `requireScope.ts`)
 * with PF-002's shared error-response helper/middleware, and delete this
 * file. Nothing outside `api/src/platform/oauth/` and
 * `api/src/platform/scopes/` imports from here today, so the swap is
 * contained to those two directories.
 */

import type { Response } from 'express';

/**
 * §2.5's closed `code` enum. PF-107 only ever produces `unauthorized` (401,
 * from `bearerAuth`) and `forbidden` (403, from `requireScope`) — the other
 * four values exist in the type for shape-fidelity with PF-002's eventual
 * canonical definition, not because this ticket emits them.
 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error';

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/**
 * Writes a §2.5-shaped error response and ends the request.
 *
 * `requestId` should be `req.requestId` (set by PF-001's
 * `requestIdMiddleware`, mounted ahead of `bearerAuth` on every real
 * `/api/v1` route). Falls back to `''` rather than throwing when absent —
 * true in a scratch test app that mounts `bearerAuth` without the v1
 * router's request-id middleware ahead of it; the AC for this ticket does
 * not assert on `request_id`'s value, only on `code`/`details`.
 */
export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string | undefined,
  details?: Record<string, unknown>,
): void {
  const body: ApiErrorBody = {
    code,
    message,
    request_id: requestId ?? '',
  };
  if (details) body.details = details;
  res.status(status).json(body);
}
