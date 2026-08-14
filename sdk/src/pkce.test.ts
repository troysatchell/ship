/**
 * `generatePkcePair()` (PF-404, RFC 7636). Cross-checked against Node's
 * `crypto` module's independent SHA-256 implementation — not just against
 * itself — so a bug that made both the WebCrypto digest call AND the test's
 * own assertion wrong the same way would still be caught.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { generatePkcePair } from './pkce.js';

/** RFC 7636 §4.1's unreserved set: `[A-Z] [a-z] [0-9] - . _ ~`. base64url
 * encoding (what this module produces) only ever emits a subset of that
 * (no `.`/`~`), so this is a valid, slightly-stricter check. */
const UNRESERVED_BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('generatePkcePair', () => {
  it('produces a code_verifier of the RFC 7636 §4.1-required length (43-128 chars) from the unreserved set', async () => {
    const { codeVerifier } = await generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(UNRESERVED_BASE64URL);
  });

  it('produces a code_challenge that is also base64url (no padding, no +/ characters)', async () => {
    const { codeChallenge } = await generatePkcePair();
    expect(codeChallenge).toMatch(UNRESERVED_BASE64URL);
    // SHA-256 digest is 32 bytes -> 43 base64url chars, unpadded.
    expect(codeChallenge.length).toBe(43);
  });

  it('code_challenge really is BASE64URL(SHA256(ASCII(code_verifier))) — RFC 7636 §4.2, verified against Node crypto (an independent implementation)', async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();

    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    expect(codeChallenge).toBe(expected);
  });

  it('generates a fresh, unpredictable pair on every call — never reused across invocations', async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();

    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});
