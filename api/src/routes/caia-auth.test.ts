/**
 * TRO-309 (CodeQL js/server-side-unvalidated-url-redirection,
 * caia-auth.ts:320) — regression coverage for the `returnTo` open-redirect
 * bypass in the CAIA OAuth callback.
 *
 * `res.redirect(redirectUrl)` at the end of `GET /api/auth/caia/callback`
 * sends whatever `isValidReturnTo` approves straight into the `Location`
 * header. The original check only rejected a literal `//` prefix
 * (protocol-relative). That misses a documented WHATWG-URL-parser bypass:
 * browsers normalize a leading `\` to `/` when resolving a relative
 * reference against an http(s) origin, so a `returnTo` of `/\evil.com`
 * survived the old check (`startsWith('/')` true, `startsWith('//')` false)
 * but resolves identically to `//evil.com` once a browser parses the
 * `Location` header — confirmed directly with Node's spec-compliant `URL`
 * parser (the same resolution algorithm a browser runs):
 *
 *   new URL('/\\evil.com', 'https://ship.example.com/api/auth/caia/callback').href
 *     -> 'https://evil.com/'
 *
 * This file unit-tests the extracted pure predicate — no HTTP request, no
 * OAuth mocking, no database — because `isValidReturnTo` is exactly the
 * code CodeQL flagged, and the route does nothing to its result beyond
 * passing it straight to `res.redirect`.
 */
import { describe, it, expect } from 'vitest';
import { isValidReturnTo } from './caia-auth.js';

describe('TRO-309: isValidReturnTo', () => {
  it('accepts ordinary same-origin relative paths', () => {
    expect(isValidReturnTo('/')).toBe(true);
    expect(isValidReturnTo('/dashboard')).toBe(true);
    expect(isValidReturnTo('/issues/123?tab=comments')).toBe(true);
  });

  it('rejects a protocol-relative URL', () => {
    expect(isValidReturnTo('//evil.com')).toBe(false);
    expect(isValidReturnTo('//evil.com/phish')).toBe(false);
  });

  it('rejects paths that do not start with a single slash', () => {
    expect(isValidReturnTo('evil.com')).toBe(false);
    expect(isValidReturnTo('https://evil.com')).toBe(false);
  });

  it('rejects the backslash bypass that a browser normalizes to "//"', () => {
    // Confirmed with Node's WHATWG-URL-spec-compliant `URL` parser (the same
    // algorithm a browser uses to resolve a `Location` header):
    //   new URL('/\\evil.com', 'https://ship.example.com/x').href
    //     === 'https://evil.com/'
    // A vulnerable `isValidReturnTo` returns true here because the literal
    // string does not start with '//' — this is exactly the gap CodeQL
    // flagged at caia-auth.ts:320.
    expect(isValidReturnTo('/\\evil.com')).toBe(false);
    expect(isValidReturnTo('/\\evil.com/phish')).toBe(false);
  });

  it('rejects a backslash anywhere in the path, not just a leading one', () => {
    expect(isValidReturnTo('/a\\evil.com')).toBe(false);
  });
});
