/**
 * RFC 7636 PKCE pair generation (PF-404, PLUGFORGE.MD §2.8) — a real,
 * exported building block (`ShipClient.authorizationCodeFlow` uses it, and
 * so can any other consumer; this ticket's own instruction: "this ticket's
 * version needs to be a real exported function other consumers use, not
 * test-only").
 *
 * WebCrypto only (`globalThis.crypto`/`crypto.subtle`), per the ticket's
 * "generate a `code_verifier`/`code_challenge` pair via WebCrypto (S256)"
 * instruction and the SDK's zero-runtime-dependency, browser-safe
 * constraint — Node's `crypto` module (what
 * `e2e/oauth-pkce-chain.spec.ts`'s and `token.test.ts`'s own `makePkcePair`
 * helpers use) is not available in a browser bundle at all. WebCrypto has
 * been a global in both environments long enough not to matter here: every
 * evergreen browser, and Node itself since v19 (this repo's CI pins Node 22
 * — `.github/workflows/ci.yml`; `sdk/package.json`'s own `engines.node` is
 * `>=18`, which is why `getWebCrypto()` below still guards rather than
 * assumes).
 *
 * The construction mirrors this codebase's own existing PKCE test helpers
 * exactly (`api/src/platform/oauth/__tests__/token.test.ts`'s
 * `makePkcePair`, `e2e/oauth-pkce-chain.spec.ts`'s `makePkcePair`) — not
 * reinvented, per this ticket's own instruction — translated from Node's
 * `crypto.randomBytes`/`crypto.createHash` to WebCrypto's
 * `getRandomValues`/`subtle.digest`, which is the only thing that has to
 * change to run in a browser.
 */

export interface PkcePair {
  /** RFC 7636 §4.1: 43-128 characters from the unreserved set
   * `[A-Z a-z 0-9 - . _ ~]`. base64url of 32 random bytes is exactly 43
   * characters, entirely within that set. */
  readonly codeVerifier: string;
  /** RFC 7636 §4.2: `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`. */
  readonly codeChallenge: string;
}

const PKCE_VERIFIER_BYTES = 32;

/** `globalThis.crypto`'s type (via `@types/node`'s global augmentation) is
 * declared non-optional, but this function runs in environments this
 * package's own type declarations don't control (an older browser, a
 * runtime with WebCrypto stripped out) — same defensive-despite-the-types
 * posture `client.ts`'s `resolveDefaultBaseUrl` already takes for
 * `typeof process`. */
function getWebCrypto(): typeof globalThis.crypto {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
    throw new Error(
      'generatePkcePair() requires the WebCrypto API (globalThis.crypto.subtle) — ' +
        'available natively in every evergreen browser and in Node >= 19 (Node 18 needs ' +
        '--experimental-global-webcrypto).'
    );
  }
  return globalThis.crypto;
}

/** `btoa`/`String.fromCharCode` rather than `Buffer` — `Buffer` does not
 * exist in a browser bundle; `btoa` is a global in both Node (`@types/node`
 * declares it, backed by a real runtime implementation since Node 16) and
 * every browser. Iterating with `for...of` rather than indexing avoids
 * `noUncheckedIndexedAccess`'s `number | undefined` entirely (iterating a
 * `Uint8Array` yields definite `number`s — lessons.md RULE-16, no `!`/`as`
 * needed here). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Generates one fresh RFC 7636 `code_verifier`/`code_challenge` (S256) pair.
 * A new pair MUST be generated per authorization attempt — never reused
 * across flows.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const webCrypto = getWebCrypto();

  const verifierBytes = new Uint8Array(PKCE_VERIFIER_BYTES);
  webCrypto.getRandomValues(verifierBytes);
  const codeVerifier = base64UrlEncode(verifierBytes);

  // RFC 7636 §4.2: SHA256(ASCII(code_verifier)) — the verifier's own
  // (already base64url, hence ASCII-safe) character bytes, not the random
  // bytes it was derived from.
  const verifierUtf8Bytes = new TextEncoder().encode(codeVerifier);
  const digest = await webCrypto.subtle.digest('SHA-256', verifierUtf8Bytes);
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}
