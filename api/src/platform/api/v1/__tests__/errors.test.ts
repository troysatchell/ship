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

function assertShape(err: ApiError, expectedCode: ApiErrorCode): void {
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe(expectedCode);
  expect(typeof err.message).toBe('string');
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.request_id).toBe(REQUEST_ID);

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
    assertShape(unauthorizedError(REQUEST_ID, 'missing_token'), 'unauthorized');
  });

  it('forbidden', () => {
    assertShape(forbiddenError(REQUEST_ID), 'forbidden');
  });

  it('not_found', () => {
    assertShape(notFoundError(REQUEST_ID), 'not_found');
  });

  it('validation_failed', () => {
    assertShape(validationFailedError(REQUEST_ID), 'validation_failed');
  });

  it('rate_limited', () => {
    assertShape(rateLimitedError(REQUEST_ID), 'rate_limited');
  });

  it('server_error', () => {
    assertShape(serverError(REQUEST_ID), 'server_error');
  });

  describe('the three distinct 401 reasons (dispatch brief; PM decision TRO-430: revoked -> invalid_token)', () => {
    const cases: Unauthorized401Reason[] = ['missing_token', 'invalid_token', 'expired_token'];

    it.each(cases)('details.reason is %s', (reason) => {
      const err = unauthorizedError(REQUEST_ID, reason);
      assertShape(err, 'unauthorized');
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
