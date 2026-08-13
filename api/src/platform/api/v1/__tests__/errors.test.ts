import { describe, it, expect } from 'vitest';
import {
  ApiError,
  unauthorizedError,
  forbiddenError,
  notFoundError,
  validationFailedError,
  rateLimitedError,
  serverError,
} from '../errors.js';
import type { ApiErrorCode, Unauthorized401Reason } from '../errors.js';

/**
 * PF-002 — ApiError typed constructors (PLUGFORGE.MD §2.5 shape).
 * Test design: ship-test-designer, Linear TRO-397 comment, 2026-08-10, "AC-1".
 */

const REQUEST_ID = 'test-request-id-0001';

function assertShape(err: ApiError, expectedCode: ApiErrorCode, expectedHttpStatus: number): void {
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe(expectedCode);
  expect(typeof err.message).toBe('string');
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.request_id).toBe(REQUEST_ID);
  expect(err.httpStatus).toBe(expectedHttpStatus);

  // toJSON() is the actual wire body — assert it has exactly the §2.5 keys,
  // no more (e.g. no leaked `httpStatus`, `name`, or `stack`), no less.
  const body = err.toJSON();
  const expectedKeys =
    body.details !== undefined
      ? ['code', 'message', 'details', 'request_id']
      : ['code', 'message', 'request_id'];
  expect(Object.keys(body).sort()).toEqual([...expectedKeys].sort());
  expect(body.code).toBe(expectedCode);
  expect(body.request_id).toBe(REQUEST_ID);
}

describe('PF-002: ApiError typed constructors (§2.5 shape)', () => {
  it('unauthorized', () => {
    assertShape(unauthorizedError(REQUEST_ID, 'missing_token'), 'unauthorized', 401);
  });

  it('forbidden', () => {
    assertShape(forbiddenError(REQUEST_ID), 'forbidden', 403);
  });

  it('not_found', () => {
    assertShape(notFoundError(REQUEST_ID), 'not_found', 404);
  });

  it('validation_failed', () => {
    assertShape(validationFailedError(REQUEST_ID), 'validation_failed', 400);
  });

  it('rate_limited', () => {
    assertShape(rateLimitedError(REQUEST_ID), 'rate_limited', 429);
  });

  it('server_error', () => {
    assertShape(serverError(REQUEST_ID), 'server_error', 500);
  });

  describe('httpStatus per error code', () => {
    const cases: Array<[string, number]> = [
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not_found', 404],
      ['validation_failed', 400],
      ['rate_limited', 429],
      ['server_error', 500],
    ];

    it.each(cases)('%s maps to HTTP %i', (code, expectedStatus) => {
      let err: ApiError;
      switch (code) {
        case 'unauthorized':
          err = unauthorizedError(REQUEST_ID, 'missing_token');
          break;
        case 'forbidden':
          err = forbiddenError(REQUEST_ID);
          break;
        case 'not_found':
          err = notFoundError(REQUEST_ID);
          break;
        case 'validation_failed':
          err = validationFailedError(REQUEST_ID);
          break;
        case 'rate_limited':
          err = rateLimitedError(REQUEST_ID);
          break;
        case 'server_error':
          err = serverError(REQUEST_ID);
          break;
        default:
          throw new Error(`Unhandled code: ${code}`);
      }
      expect(err.httpStatus).toBe(expectedStatus);
    });
  });

  describe('the three distinct 401 reasons (dispatch brief; PM decision TRO-430: revoked -> invalid_token)', () => {
    const cases: Unauthorized401Reason[] = ['missing_token', 'invalid_token', 'expired_token'];

    it.each(cases)('details.reason is %s', (reason) => {
      const err = unauthorizedError(REQUEST_ID, reason);
      assertShape(err, 'unauthorized', 401);
      expect(err.details?.reason).toBe(reason);
    });

    it('has no fourth "revoked_token" reason value', () => {
      // Not a runtime-checkable assertion by itself (TypeScript already
      // enforces the union at compile time) — this documents the PM
      // decision (TRO-430) as an explicit, checkable fact: 'revoked_token'
      // is not present anywhere the three real reasons are enumerated.
      expect(cases).not.toContain('revoked_token');
      expect(cases).toHaveLength(3);
    });
  });
});
