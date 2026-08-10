/**
 * PF-002 — the ApiError contract (PLUGFORGE.MD §2.5, verbatim shape).
 *
 * Binding boundary decision (PM, on TRO-416): this contract governs
 * `/api/v1` ONLY. `/oauth` endpoints speak RFC 6749's own error shape
 * (`error` / `error_description`), not this one — nothing in this file is
 * meant to be reused for an oauth-shaped response.
 */

/** §2.5's `code` enum, verbatim. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error';

/**
 * Distinct 401 reasons (dispatch brief, TRO-397). The bearer-auth middleware
 * that will actually produce these (PF-107 — not built yet; this ticket has
 * no auth infrastructure) reports which of three things was wrong with the
 * credential.
 *
 * PM decision on TRO-430: a **revoked** token maps to `invalid_token`, not a
 * fourth reason — there is deliberately no `revoked_token` value here.
 */
export type Unauthorized401Reason = 'missing_token' | 'invalid_token' | 'expired_token';

/** The exact wire shape of §2.5 — what every `/api/v1` failure response body is. */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/**
 * §2.5 names the `code` enum and the shape but not an HTTP status per code —
 * this mapping is derived, not specified verbatim by the PRD.
 * `validation_failed` -> 400 matches this repo's existing internal-API
 * convention for a zod/validation failure (e.g. `api/src/routes/documents.ts`
 * responds `res.status(400)` beside a parse failure); `rate_limited` -> 429
 * and the other four are standard HTTP semantics for their names.
 */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  server_error: 500,
};

const DEFAULT_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  unauthorized: 'Authentication is required to access this resource.',
  forbidden: 'You do not have permission to access this resource.',
  not_found: 'The requested resource was not found.',
  validation_failed: 'The request could not be validated.',
  rate_limited: 'Too many requests. Please try again later.',
  server_error: 'An unexpected error occurred.',
};

const REASON_MESSAGES: Readonly<Record<Unauthorized401Reason, string>> = {
  missing_token: 'No bearer token was provided.',
  invalid_token: 'The provided bearer token is invalid.',
  expired_token: 'The provided bearer token has expired.',
};

/**
 * A `/api/v1` failure — throwable from any route/middleware mounted on
 * `v1Router` (`router.ts`). `errorMiddleware.ts`'s `errorMiddleware` catches
 * instances of this class via `instanceof` and serializes `.toJSON()`
 * directly: the class's own fields ARE the response body, plus the HTTP
 * status needed to send it.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  readonly request_id: string;

  constructor(
    code: ApiErrorCode,
    message: string,
    requestId: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = API_ERROR_HTTP_STATUS[code];
    this.request_id = requestId;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /** The exact §2.5 wire shape — what every `/api/v1` error response body is. */
  toJSON(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      request_id: this.request_id,
    };
  }
}

/** code: 'unauthorized', HTTP 401. `reason` selects the specific 401 variant. */
export function unauthorizedError(
  requestId: string,
  reason: Unauthorized401Reason,
  message: string = REASON_MESSAGES[reason],
  details?: Record<string, unknown>
): ApiError {
  return new ApiError('unauthorized', message, requestId, { ...details, reason });
}

/** code: 'forbidden', HTTP 403. */
export function forbiddenError(
  requestId: string,
  message: string = DEFAULT_MESSAGES.forbidden,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError('forbidden', message, requestId, details);
}

/** code: 'not_found', HTTP 404. */
export function notFoundError(
  requestId: string,
  message: string = DEFAULT_MESSAGES.not_found,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError('not_found', message, requestId, details);
}

/** code: 'validation_failed', HTTP 400. */
export function validationFailedError(
  requestId: string,
  message: string = DEFAULT_MESSAGES.validation_failed,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError('validation_failed', message, requestId, details);
}

/** code: 'rate_limited', HTTP 429. */
export function rateLimitedError(
  requestId: string,
  message: string = DEFAULT_MESSAGES.rate_limited,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError('rate_limited', message, requestId, details);
}

/**
 * code: 'server_error', HTTP 500. Deliberately takes no `details` parameter,
 * unlike the other five constructors: this is the SANITIZED shape sent to
 * the client for an unexpected failure (PF-002 AC — no stack/SQL leaks). The
 * actual error detail belongs only in the server-side log
 * (`errorMiddleware.ts`), never in this object.
 */
export function serverError(requestId: string, message: string = DEFAULT_MESSAGES.server_error): ApiError {
  return new ApiError('server_error', message, requestId);
}
