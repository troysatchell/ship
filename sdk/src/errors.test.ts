/**
 * PF-400 AC: unit tests for the ApiError -> kind mapping — all 6 documented
 * `ApiErrorCode` values, plus the network-failure case (which has no server
 * `code` at all — it's a `fetch()` throw, see `ShipSdkError.fromNetworkError`).
 * Pure — no I/O, no server, no `fetch`.
 */
import { describe, expect, it } from 'vitest';
import { mapApiErrorCodeToKind, ShipSdkError, type ApiErrorBody, type ApiErrorCode } from './errors.js';

describe('mapApiErrorCodeToKind', () => {
  // The PM-specified mapping, verbatim from the ticket brief.
  const cases: Array<[ApiErrorCode, ReturnType<typeof mapApiErrorCodeToKind>]> = [
    ['unauthorized', 'auth'],
    ['forbidden', 'forbidden'],
    ['not_found', 'not_found'],
    ['validation_failed', 'validation'],
    ['rate_limited', 'rate_limit'],
    ['server_error', 'server'],
  ];

  it.each(cases)('maps %s -> %s', (code, expectedKind) => {
    expect(mapApiErrorCodeToKind(code)).toBe(expectedKind);
  });

  it('falls back to "server" for an unrecognized code (forward-compat with an unknown server version)', () => {
    expect(mapApiErrorCodeToKind('some_future_code_this_sdk_does_not_know')).toBe('server');
  });
});

describe('ShipSdkError.fromApiErrorBody', () => {
  it.each([
    ['unauthorized', 'auth'],
    ['forbidden', 'forbidden'],
    ['not_found', 'not_found'],
    ['validation_failed', 'validation'],
    ['rate_limited', 'rate_limit'],
    ['server_error', 'server'],
  ] satisfies Array<[ApiErrorCode, string]>)(
    'wraps a parsed %s ApiErrorBody into a ShipSdkError with kind %s, preserving message/requestId/details/httpStatus',
    (code, expectedKind) => {
      const body: ApiErrorBody = {
        code,
        message: `${code} happened`,
        request_id: `req_${code}`,
        details: { reason: code },
      };

      const err = ShipSdkError.fromApiErrorBody(body, 418);

      expect(err).toBeInstanceOf(ShipSdkError);
      expect(err).toBeInstanceOf(Error);
      expect(err.kind).toBe(expectedKind);
      expect(err.message).toBe(`${code} happened`);
      expect(err.requestId).toBe(`req_${code}`);
      expect(err.details).toEqual({ reason: code });
      expect(err.httpStatus).toBe(418);
    }
  );

  it('omits details when the body has none', () => {
    const body: ApiErrorBody = { code: 'not_found', message: 'gone', request_id: 'req_1' };
    const err = ShipSdkError.fromApiErrorBody(body, 404);
    expect(err.details).toBeUndefined();
  });
});

describe('ShipSdkError.fromNetworkError (the network-failure case)', () => {
  it('maps a thrown fetch failure to kind "network", carrying the original error as cause', () => {
    const cause = new TypeError('fetch failed: ECONNREFUSED');

    const err = ShipSdkError.fromNetworkError(cause);

    expect(err).toBeInstanceOf(ShipSdkError);
    expect(err.kind).toBe('network');
    expect(err.message).toBe('fetch failed: ECONNREFUSED');
    expect(err.cause).toBe(cause);
    // A network failure never reached the server, so there is no HTTP status
    // or server-issued request_id to carry.
    expect(err.httpStatus).toBeUndefined();
    expect(err.requestId).toBeUndefined();
  });

  it('handles a non-Error thrown value (e.g. a string or object thrown by an unusual fetch polyfill)', () => {
    const err = ShipSdkError.fromNetworkError('offline');

    expect(err.kind).toBe('network');
    expect(err.message).toBe('The request failed before reaching the server.');
    expect(err.cause).toBe('offline');
  });
});
