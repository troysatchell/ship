import { describe, it, expect } from 'vitest';
import {
  HTTP_STATUS,
  ERROR_CODES,
  SESSION_TIMEOUT_MS,
  ABSOLUTE_SESSION_TIMEOUT_MS,
} from './constants.js';

describe('session timeout constants', () => {
  // Asserted against independently-computed millisecond values, not against
  // `15 * 60 * 1000` re-typed — that would just check the file against itself
  // and pass even if the arithmetic in constants.ts were wrong. Ship's own
  // CLAUDE.md documents these as the enforced session semantics (15min idle,
  // 12hr absolute per NIST SP 800-63B-4 AAL2), so a silent unit mistake here
  // (e.g. minutes vs. seconds) is exactly the kind of regression this guards.
  it('SESSION_TIMEOUT_MS is 15 minutes in milliseconds', () => {
    expect(SESSION_TIMEOUT_MS).toBe(900_000);
  });

  it('ABSOLUTE_SESSION_TIMEOUT_MS is 12 hours in milliseconds', () => {
    expect(ABSOLUTE_SESSION_TIMEOUT_MS).toBe(43_200_000);
  });

  it('the absolute timeout is longer than the idle timeout', () => {
    // Sanity-checks the relationship between the two, independent of the
    // exact figures above: an absolute cap shorter than the idle window would
    // make the idle timeout unreachable.
    expect(ABSOLUTE_SESSION_TIMEOUT_MS).toBeGreaterThan(SESSION_TIMEOUT_MS);
  });
});

describe('HTTP_STATUS', () => {
  it('maps each name to its standard HTTP status code', () => {
    expect(HTTP_STATUS.OK).toBe(200);
    expect(HTTP_STATUS.CREATED).toBe(201);
    expect(HTTP_STATUS.NO_CONTENT).toBe(204);
    expect(HTTP_STATUS.BAD_REQUEST).toBe(400);
    expect(HTTP_STATUS.UNAUTHORIZED).toBe(401);
    expect(HTTP_STATUS.FORBIDDEN).toBe(403);
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS.CONFLICT).toBe(409);
    expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
  });

  it('has no two names sharing the same status code', () => {
    // A copy-paste error while adding a new status is the realistic failure
    // mode here (e.g. accidentally reusing 404 for a new entry) — this catches
    // it without hardcoding every literal a second time.
    const codes = Object.values(HTTP_STATUS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('ERROR_CODES', () => {
  it('exposes distinct string identifiers for every error case', () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every code is its own uppercase-snake-case name (the API contract callers match on)', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });
});
