/**
 * `@ship/sdk` error mapping (PF-400, PLUGFORGE.MD §2.8).
 *
 * The server's `/api/v1` failure shape (`ApiErrorBody`) is mirrored here from
 * the actual source of truth, `api/src/platform/api/v1/errors.ts` — read
 * before writing this file, not inferred from PLUGFORGE.MD's prose alone.
 * That file's `ApiErrorCode` enum has exactly six values; this module maps
 * each to one of §2.8's seven `SdkErrorKind` values (the six mapped 1:1, plus
 * `'network'` for a failure that never reached the server at all — a thrown
 * `fetch()`, not a parsed response body).
 */

/** Mirrors `api/src/platform/api/v1/errors.ts`'s `ApiErrorCode`, verbatim. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error';

/**
 * Mirrors `api/src/platform/api/v1/errors.ts`'s `ApiErrorBody` wire shape.
 * `code` is typed as `string`, not `ApiErrorCode`, deliberately: this is what
 * the SDK receives off the wire (`JSON.parse` of an untrusted response body),
 * and a future server-side code this client doesn't know about yet must not
 * be a compile-time impossibility for a value the SDK never controls the
 * production of. `mapApiErrorCodeToKind` below is the boundary that narrows
 * it, with an explicit documented fallback.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/** PLUGFORGE.MD §2.8's discriminated-union `kind` values, verbatim. */
export type SdkErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limit'
  | 'server'
  | 'network';

/**
 * The PM-specified mapping (ticket brief, verbatim):
 *   unauthorized -> auth, forbidden -> forbidden, not_found -> not_found,
 *   validation_failed -> validation, rate_limited -> rate_limit,
 *   server_error -> server.
 */
const CODE_TO_KIND: Readonly<Record<ApiErrorCode, SdkErrorKind>> = {
  unauthorized: 'auth',
  forbidden: 'forbidden',
  not_found: 'not_found',
  validation_failed: 'validation',
  rate_limited: 'rate_limit',
  server_error: 'server',
};

function isKnownApiErrorCode(code: string): code is ApiErrorCode {
  return Object.prototype.hasOwnProperty.call(CODE_TO_KIND, code);
}

/**
 * Pure mapping function — the unit this ticket's AC asks be tested directly
 * (all 6 documented codes). An unrecognized `code` (a server ahead of this
 * SDK version, or a malformed/proxied response) falls back to `'server'`
 * rather than throwing out of the mapper itself — the caller (`ShipSdkError`
 * below) still surfaces the original `message`/`details` untouched, so no
 * information is lost, just optimistically classified as a server-side
 * problem rather than crashing the mapper on unknown input.
 */
export function mapApiErrorCodeToKind(code: string): SdkErrorKind {
  return isKnownApiErrorCode(code) ? CODE_TO_KIND[code] : 'server';
}

/** The shape every `ShipSdkError` satisfies — PLUGFORGE.MD §2.8's literal
 *  `{ kind: ..., ... }` discriminated union, as a named type consumers can
 *  reference (e.g. in a `catch (e)` block after narrowing `e instanceof
 *  ShipSdkError`) without depending on the class's other `Error` machinery. */
export interface SdkErrorShape {
  readonly kind: SdkErrorKind;
  readonly message: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
}

interface ShipSdkErrorOptions {
  httpStatus?: number;
  requestId?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Thrown by `ShipClient` methods on any non-2xx response or network failure.
 *
 * RETURN-VS-THROW (ticket asks this be documented, not just decided
 * silently): throws. PLUGFORGE.MD §2.8's own interface declares
 * `me(): Promise<Me>` — a bare, non-union return type, not `Promise<Me |
 * SdkError>` or a `Result<Me, SdkError>`. A throwing method keeps every
 * resource-client method's success type simple (`Promise<Me>`,
 * `Promise<Document>`, …) and lets a caller use ordinary `try/catch` +
 * `instanceof` narrowing — the idiomatic shape for "consumers switch
 * exhaustively" on `.kind` (§2.8) is a `catch` block, not a manual
 * `if ('kind' in result)` check on every successful call site too. A
 * return-based `Result` union would also make every resource-client method
 * generic over its own error union for no benefit, since the error shape is
 * identical across all of them.
 */
export class ShipSdkError extends Error implements SdkErrorShape {
  readonly kind: SdkErrorKind;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(kind: SdkErrorKind, message: string, options: ShipSdkErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ShipSdkError';
    this.kind = kind;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.details !== undefined) this.details = options.details;
  }

  /** Builds a `ShipSdkError` from a parsed `/api/v1` error response body. */
  static fromApiErrorBody(body: ApiErrorBody, httpStatus: number): ShipSdkError {
    return new ShipSdkError(mapApiErrorCodeToKind(body.code), body.message, {
      httpStatus,
      requestId: body.request_id,
      details: body.details,
    });
  }

  /**
   * Builds a `ShipSdkError` for a request that never reached the server at
   * all — `fetch()` itself throwing (DNS failure, connection refused,
   * timeout, offline). `kind: 'network'` has no server-issued `ApiErrorCode`
   * counterpart, which is exactly why it isn't in `CODE_TO_KIND`'s domain.
   */
  static fromNetworkError(cause: unknown): ShipSdkError {
    const message = cause instanceof Error ? cause.message : 'The request failed before reaching the server.';
    return new ShipSdkError('network', message, { cause });
  }
}
