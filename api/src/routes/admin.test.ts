/**
 * TRO-308 (js/polynomial-redos, admin.ts:929 on main) — regression coverage
 * for the invite-email validator's ReDoS fix.
 *
 * See the comment above `isValidInviteEmail` in `admin.ts` for the full
 * mechanism. Short version: the old single regex
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` had two adjacent `[^\s@]+` groups in the
 * domain portion, neither excluding `.`, so a rejected input with many dots
 * in that region forced the engine to retry every way of splitting the run
 * of dots between the two groups. `isValidInviteEmail` replaces it with a
 * `split-on-@-then-validate-each-side` approach where at most one unbounded
 * quantifier is ever live over a given substring.
 *
 * This file only unit-tests the extracted pure function — no HTTP request,
 * no database — both because that is the fastest, most deterministic way to
 * prove the timing claim (no supertest/network overhead in the loop) and
 * because `isValidInviteEmail` is exactly the code CodeQL flagged; testing it
 * directly is not a weaker proof than going through the route, since the
 * route does nothing to the email but lowercase/trim it and call this
 * function.
 */
import { describe, it, expect } from 'vitest';
import { isValidInviteEmail } from './admin.js';

describe('TRO-308: isValidInviteEmail', () => {
  describe('accepts realistic valid addresses', () => {
    it.each([
      'user@example.com',
      'first.last@example.com',
      'first.last@sub.example.co.uk',
      'user+tag@example.com',
      'user_name@example-domain.com',
      'a@b.co',
    ])('%s', (email) => {
      expect(isValidInviteEmail(email)).toBe(true);
    });
  });

  describe('rejects malformed addresses', () => {
    it.each([
      ['not-an-email', 'no @ at all'],
      ['@missinglocal.com', 'empty local part'],
      ['missingdomain@', 'empty domain'],
      ['two@at@signs.com', 'more than one @'],
      ['user@localhost', 'domain with no dot'],
      ['user@.com', 'domain starting with a dot'],
      ['user@com.', 'domain ending with a dot'],
      ['user@ex ample.com', 'whitespace inside the domain'],
      ['user @example.com', 'whitespace inside the local part'],
    ])('%s (%s)', (email) => {
      expect(isValidInviteEmail(email)).toBe(false);
    });

    // Deliberately stricter than the old regex, which accepted this
    // (verified by direct comparison against the old pattern while designing
    // the fix): a domain with an empty label between two dots is not a
    // legitimate hostname, and rejecting it is a correction, not a
    // regression, of the real-world behavior this validator is meant to
    // enforce.
    it('rejects a domain with consecutive dots (empty label)', () => {
      expect(isValidInviteEmail('user@example..com')).toBe(false);
    });
  });

  describe('does not exhibit quadratic-time backtracking on a pathological input', () => {
    /**
     * EMPIRICAL, not theoretical — measured on this machine, in this run.
     * Timing assertions are inherently a little environment-sensitive (a
     * heavily loaded CI box could push the absolute numbers up), so the
     * ceiling below is generous: the OLD regex took ~886ms at n=40,000 on
     * this same machine (see the comment above `isValidInviteEmail` in
     * admin.ts for the full measurement table showing ~n^2 growth: 0.6ms at
     * n=1,000 up to 886ms at n=40,000). The fixed validator is checked at
     * n=200,000 — 5x the input size that made the old code take nearly a
     * full second — against a ceiling more than an order of magnitude below
     * where the old code would land if it scaled the same way (which, being
     * quadratic, it would: n=200,000 is 5x n=40,000, so the old code would be
     * expected to take roughly 25x as long, i.e. tens of seconds).
     *
     * The crafted input mirrors the old regex's actual worst case: many `.`
     * characters after the `@` (the ambiguous domain-vs-domain split),
     * followed by a character (`' '`) excluded by every character class
     * involved, so the match can never succeed and the engine — old or new
     * — is forced to fully exhaust whatever backtracking the pattern allows
     * before returning `false`.
     */
    it('rejects many repeated dots after the @ in well under a second', () => {
      const n = 200_000;
      const pathological = 'a@' + '.'.repeat(n) + ' ';
      const ceilingMs = 500;

      const start = performance.now();
      const result = isValidInviteEmail(pathological);
      const elapsedMs = performance.now() - start;

      expect(result).toBe(false);
      expect(
        elapsedMs,
        `isValidInviteEmail took ${elapsedMs.toFixed(1)}ms on a ${pathological.length}-char ` +
          `pathological input (ceiling ${ceilingMs}ms) — this is the shape that made the old ` +
          `regex take ~886ms at n=40,000 (see admin.ts); investigate whether the fix ` +
          'regressed to a backtracking-prone pattern.'
      ).toBeLessThan(ceilingMs);
    });

    it('also stays fast for the pattern this ticket originally described (many dots before the @)', () => {
      // Kept alongside the real pathological case above rather than instead
      // of it: this shape was already O(n) even on the OLD regex (measured
      // 0.06ms at n=40,000 while designing the fix), so it is a pin, not a
      // red-before-green case — but the ticket's brief specifically named
      // this shape, so it stays covered to show it was checked, not assumed.
      const n = 200_000;
      const pathological = '.'.repeat(n) + '@' + ' ';
      const ceilingMs = 500;

      const start = performance.now();
      const result = isValidInviteEmail(pathological);
      const elapsedMs = performance.now() - start;

      expect(result).toBe(false);
      expect(elapsedMs).toBeLessThan(ceilingMs);
    });
  });
});
