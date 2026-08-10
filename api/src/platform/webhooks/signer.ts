/**
 * HMAC webhook signer (TRO-433 / PF-303).
 *
 * Contract (PLUGFORGE.MD §2.6, verbatim):
 *   Header:          Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
 *   Signed payload:  `${t}.${rawBody}`
 *   Default clock-skew tolerance: 300 seconds, inclusive at the boundary.
 *
 * This module is intentionally dependency-free (only Node's built-in `node:crypto`) and does not
 * import from anywhere else under `api/src/platform/` — PF-001's platform scaffold may land in a
 * parallel branch, and this file must build and test in isolation regardless of merge order.
 *
 * `sign`/`verify` both take an injected `Clock` rather than reading `Date.now()` directly, so
 * callers (and PF-304's deliverer, and this module's own tests) can pin time deterministically.
 * The `header` string returned by `sign()` and accepted by `verify()` is the **header value only**
 * (e.g. `"t=1700000000,v1=<hex>"`) — attaching it to the `Ship-Signature` HTTP header name, and
 * reading it back off `req.headers`, is the caller's job (the deliverer / the receiving route),
 * not this module's.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Returns the current instant as Unix seconds (not milliseconds). */
export type Clock = () => number

/** Default clock: wall-clock time, in Unix seconds. */
export const systemClock: Clock = () => Math.floor(Date.now() / 1000)

/** Default tolerance window for `verify()`, in seconds. Matches PLUGFORGE.MD §2.6. */
export const DEFAULT_TOLERANCE_SECONDS = 300

/** The HTTP header name this signature travels under. Informational — this module never reads
 *  or writes HTTP headers itself. */
export const SHIP_SIGNATURE_HEADER_NAME = 'Ship-Signature'

/**
 * Computes the HMAC-SHA256 hex digest of `${t}.${rawBody}` under `secret`.
 * Not exported — `sign`/`verify` are the only public surface, so both sides of a comparison are
 * always produced by this exact same code path.
 */
function computeDigest(t: number, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
}

/**
 * Rejects an empty or non-string `secret`. `createHmac('sha256', '')` succeeds in Node — it does
 * not throw on an empty key — so without this guard a caller whose `secret` resolves to `''` (an
 * unset environment variable is the common way that happens) would get a `sign()` that silently
 * produces a header, and a `verify()` that silently accepts it, under a key any party can guess.
 * Both `sign` and `verify` call this and let the `TypeError` propagate — the empty-secret case is
 * a caller misconfiguration, not a verification outcome, so it is not folded into `verify()`'s
 * `false` return path the way a malformed header or a tolerance miss is.
 */
function assertNonEmptySecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret must be a non-empty string')
  }
}

/** SHA-256 hex digests are always exactly 64 lowercase-or-uppercase hex characters. */
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i

/**
 * Constant-time comparison of two SHA-256 hex digests.
 *
 * Both inputs are validated as exactly 64 hex characters before any comparison. This matters
 * beyond readability: `Buffer.from(str, 'hex')` does not throw on invalid hex — it silently stops
 * decoding at the first invalid character, so a malformed or short `v1` (attacker-controlled, from
 * the header being verified) could otherwise produce a shorter buffer than intended. The existing
 * length check below already rejects any resulting mismatch, but validating the format up front is
 * the honest fix rather than relying on that as an accidental side effect. A length mismatch (or,
 * now, a format mismatch) means "not equal" with nothing secret left to compare, so both paths
 * return `false` before calling `timingSafeEqual`, which throws on unequal-length buffers rather
 * than returning `false`.
 */
function constantTimeHexEquals(a: string, b: string): boolean {
  if (!HEX_SHA256_PATTERN.test(a) || !HEX_SHA256_PATTERN.test(b)) return false
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

interface ParsedSignatureHeader {
  t: number
  v1: string
}

/**
 * Parses a `Ship-Signature` header value into its `t`/`v1` components. Returns `null` for any
 * structurally invalid header (missing `v1`, missing/non-numeric `t`, empty string) rather than
 * throwing — `verify()` treats a parse failure as "not valid", never as an error.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (!header) return null

  const parts: Record<string, string> = {}
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    const key = segment.slice(0, eq).trim()
    const value = segment.slice(eq + 1).trim()
    if (key) parts[key] = value
  }

  const tRaw = parts.t
  const v1 = parts.v1
  if (!tRaw || !v1) return null

  if (!/^\d+$/.test(tRaw)) return null
  const t = Number(tRaw)
  if (!Number.isSafeInteger(t)) return null

  return { t, v1 }
}

/**
 * Signs `rawBody` and returns the `Ship-Signature` header **value** — `t=<unix-seconds>,v1=<hex>`.
 * `t` comes from `clock()`, called exactly once.
 */
export function sign(rawBody: string, secret: string, clock: Clock = systemClock): string {
  assertNonEmptySecret(secret)
  const t = clock()
  const v1 = computeDigest(t, rawBody, secret)
  return `t=${t},v1=${v1}`
}

/**
 * Verifies a `Ship-Signature` header value against `rawBody` and `secret`.
 *
 * Throws a `TypeError` for an empty or non-string `secret` (a caller misconfiguration — see
 * `assertNonEmptySecret`) or for a `clock()` callback that itself throws; otherwise returns
 * `false`, never throws, for: a structurally malformed header (missing `v1`, missing or
 * non-numeric `t`), a non-finite or negative `toleranceSeconds`, a non-finite `clock()` result, a
 * timestamp outside `toleranceSeconds` of `clock()` (inclusive at the boundary), or a signature
 * mismatch. The digest comparison always goes through `crypto.timingSafeEqual`.
 *
 * The `toleranceSeconds`/`clock()`-result guards exist because `Math.abs(now - t) >
 * toleranceSeconds` is a "fails open" comparison for non-finite operands: `NaN > anything` is
 * always `false`, so a caller-misconfigured tolerance (`NaN`, `Infinity`, a negative value) or a
 * broken clock could otherwise disable the replay-protection window entirely rather than
 * rejecting the request.
 */
export function verify(
  header: string,
  rawBody: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  clock: Clock = systemClock,
): boolean {
  assertNonEmptySecret(secret)

  const parsed = parseSignatureHeader(header)
  if (!parsed) return false

  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false

  const now = clock()
  if (!Number.isFinite(now)) return false
  if (Math.abs(now - parsed.t) > toleranceSeconds) return false

  const expected = computeDigest(parsed.t, rawBody, secret)
  return constantTimeHexEquals(expected, parsed.v1)
}
