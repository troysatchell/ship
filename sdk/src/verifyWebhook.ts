/**
 * `verifyWebhook` — the SDK-side webhook signature verifier (PF-403, PLUGFORGE.MD §2.6/§2.8).
 *
 * Port of `api/src/platform/webhooks/signer.ts`'s `verify()` — same algorithm, byte-identical:
 * parse the `Ship-Signature` header (`t=<unix-seconds>,v1=<hex-hmac-sha256>`), reject anything
 * outside `toleranceSec` of "now" (inclusive at the boundary), recompute the HMAC-SHA256 digest
 * of `${t}.${rawBody}` under `secret`, and compare against the header's `v1` in constant time via
 * `crypto.timingSafeEqual`. Cross-validated against the exact same fixture file the server-side
 * signer's own test suite uses (`shared/fixtures/webhook-signature-vectors.json`, created by
 * PF-303/TRO-433 specifically for this ticket's byte-parity proof) — see `verifyWebhook.test.ts`.
 *
 * Three deliberate differences from `signer.ts`'s `verify()`, all narrowing the public surface for
 * a one-call, boolean-returning, third-party-facing SDK function rather than changing the crypto
 * itself:
 *
 *   1. No injected `Clock` callback on the public path — PLUGFORGE.MD §2.8's documented signature
 *      is exactly `verifyWebhook(headers, rawBody, secret, toleranceSec = 300)`, so "now" is read
 *      from `Date.now()` by default. A fifth, optional `now` parameter (Unix seconds) is added
 *      ONLY so this file's own tests — including the shared-fixture cross-validation, whose cases
 *      carry fixed 2023 Unix timestamps — can pin "now" deterministically instead of depending on
 *      real time or a live `Date` mock. Every documented call shape (3 or 4 arguments) is
 *      unaffected; `now` is never required and never appears in PLUGFORGE.MD's signature.
 *   2. `headers` accepts a plain `Record<string,string>` (Node's `req.headers`) OR a standard
 *      `Headers` object (fetch API — Express 5/undici, edge runtimes, and this SDK's own
 *      fetch-based `ShipClient` all speak this), read case-insensitively either way.
 *   3. Never throws. `signer.ts`'s `verify()` throws `TypeError` for an empty/non-string `secret`
 *      by design: it treats a misconfigured secret as a caller bug distinct from "not valid," which
 *      is the right call for the server's OWN signer, called only by code in this repo. This
 *      function is the public, one-call, boolean-returning contract third-party webhook receivers
 *      call directly in a route handler (PLUGFORGE.MD §2.8: `function verifyWebhook(...): boolean`;
 *      the PF-403 AC list has no throwing case) — so the same misconfiguration is folded into the
 *      `false` return path instead. This closes the identical vulnerability signer.ts's own guard
 *      exists for (an empty, guessable key can never produce a `true` result here) without forcing
 *      every webhook route handler to additionally wrap this call in `try`/`catch`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default clock-skew tolerance, in seconds. Matches `signer.ts`'s `DEFAULT_TOLERANCE_SECONDS`
 *  and PLUGFORGE.MD §2.6/§2.8, verbatim. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The HTTP header this signature travels under — matches `signer.ts`'s
 *  `SHIP_SIGNATURE_HEADER_NAME`, verbatim. */
export const SHIP_SIGNATURE_HEADER_NAME = 'Ship-Signature';

/** SHA-256 hex digests are always exactly 64 lowercase-or-uppercase hex characters. */
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;

interface ParsedSignatureHeader {
  t: number;
  v1: string;
}

/**
 * Reads the `Ship-Signature` header value out of either accepted header shape,
 * case-insensitively. `Headers#get` is already case-insensitive per the fetch spec; a plain
 * `Record<string,string>` is not guaranteed lower-cased by every caller (Node's own `req.headers`
 * is, but a hand-built object — a test fixture, a non-Node runtime — may not be), so this scans
 * keys rather than assuming exact casing.
 */
function getSignatureHeaderValue(headers: Record<string, string> | Headers): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(SHIP_SIGNATURE_HEADER_NAME) ?? undefined;
  }

  const targetLower = SHIP_SIGNATURE_HEADER_NAME.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLower) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * Parses a `Ship-Signature` header value into its `t`/`v1` components. Returns `null` for any
 * structurally invalid header (missing `v1`, missing/non-numeric `t`, empty string) — mirrors
 * `signer.ts`'s (not exported) `parseSignatureHeader`, verbatim, so both sides parse identically.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (!header) return null;

  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key) parts[key] = value;
  }

  const tRaw = parts.t;
  const v1 = parts.v1;
  if (!tRaw || !v1) return null;

  if (!/^\d+$/.test(tRaw)) return null;
  const t = Number(tRaw);
  if (!Number.isSafeInteger(t)) return null;

  return { t, v1 };
}

/**
 * Computes the HMAC-SHA256 hex digest of `${t}.${rawBody}` under `secret` — the same signed
 * payload as `signer.ts`'s (not exported) `computeDigest`, built over raw bytes rather than
 * through a string round-trip.
 *
 * CodeRabbit review (this ticket, minor): an earlier version normalized a `Buffer` `rawBody` by
 * calling `.toString('utf8')` and handing the RESULT to `createHmac(...).update(string)` — a real
 * bug, not just a style nit. `update(string)` re-encodes that string as UTF-8 before hashing, and
 * `decode-then-reencode` is only lossless when the original bytes were already valid UTF-8.
 * `signer.ts` signs whatever bytes the delivery actually sent; a `rawBody` Buffer containing a
 * byte sequence that ISN'T valid UTF-8 would silently get its invalid bytes replaced (U+FFFD) on
 * decode, producing a digest over different bytes than the ones that were signed — a legitimate
 * webhook body could then fail verification. Building the HMAC input as a `Buffer` directly (this
 * version) hashes the exact bytes handed in, matching `signer.ts`'s guarantee regardless of
 * whether `rawBody` happens to be valid UTF-8. `t` itself is always ASCII digits, so
 * `Buffer.from(`${t}.`, 'utf8')` never loses information.
 */
function computeDigest(t: number, rawBody: string | Buffer, secret: string): string {
  const bodyBytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const payload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), bodyBytes]);
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time comparison of two SHA-256 hex digests — byte-identical to `signer.ts`'s (not
 * exported) `constantTimeHexEquals`, including the format-before-length guard against
 * `Buffer.from(str, 'hex')`'s silent truncation on invalid hex (see that file's own comment for
 * why: a genuinely valid 64-char digest with trailing garbage appended still decodes to 32 bytes,
 * so a length-only check cannot tell it apart from a real signature).
 */
function constantTimeHexEquals(a: string, b: string): boolean {
  if (!HEX_SHA256_PATTERN.test(a) || !HEX_SHA256_PATTERN.test(b)) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a `Ship-Signature` header against `rawBody` and `secret`. One call: parses the header,
 * checks `toleranceSec` clock-skew tolerance (inclusive at the boundary), recomputes the
 * HMAC-SHA256 digest, and compares in constant time. Never throws — see this file's header
 * comment for why that is a deliberate divergence from `signer.ts`'s `verify()`.
 *
 * Returns `false` (never throws) for: an empty/non-string `secret`; a non-finite or negative
 * `toleranceSec` (guarding the same fail-OPEN hazard `signer.ts` guards against — `NaN > x` is
 * always `false`, so a misconfigured tolerance must be rejected explicitly rather than silently
 * disabling the replay-protection window); a missing or structurally unparseable `Ship-Signature`
 * header (including one with no `v1=` component); a timestamp outside `toleranceSec` seconds of
 * "now"; or a digest mismatch (tampered body, wrong secret, or a malformed `v1` that isn't valid
 * hex).
 *
 * `now` is Unix seconds and is NOT part of PLUGFORGE.MD §2.8's documented signature — see this
 * file's header comment. Omit it; the default is the real wall clock.
 */
export function verifyWebhook(
  headers: Record<string, string> | Headers,
  rawBody: string | Buffer,
  secret: string,
  toleranceSec: number = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (!Number.isFinite(toleranceSec) || toleranceSec < 0) return false;
  if (!Number.isFinite(now)) return false;

  const headerValue = getSignatureHeaderValue(headers);
  if (!headerValue) return false;

  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return false;

  if (Math.abs(now - parsed.t) > toleranceSec) return false;

  const expected = computeDigest(parsed.t, rawBody, secret);
  return constantTimeHexEquals(expected, parsed.v1);
}
