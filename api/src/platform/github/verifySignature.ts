/**
 * GitHub App webhook signature verification (PF-804 / TRO-453).
 *
 * GitHub's own scheme (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
 * NOT `@ship/sdk`'s `verifyWebhook` / `platform/webhooks/signer.ts`'s `Ship-Signature` — this is a
 * different external system with its own header name and digest format, verified against a
 * DIFFERENT secret (`GITHUB_WEBHOOK_SECRET`, set when the GitHub App is registered, never
 * `SECRET_ENCRYPTION_KEY` or a `webhook_subscriptions` row):
 *
 *   Header:          X-Hub-Signature-256: sha256=<hex-hmac-sha256>
 *   Signed payload:  the raw request body bytes, unmodified (no timestamp prefix, unlike Ship's
 *                    own `t=...,v1=...` scheme — GitHub's format has no replay-window concept
 *                    built into the signature itself).
 *
 * Dependency-free apart from `node:crypto`, matching `platform/webhooks/signer.ts`'s own
 * isolation convention (same rationale: this file has nothing to do with Express or Postgres).
 *
 * Constant-time comparison via `timingSafeEqual` — a plain `===` on the two hex strings would let
 * a timing attack narrow down a correct signature byte-by-byte, same reasoning as `signer.ts`'s
 * own `verify()`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const GITHUB_SIGNATURE_HEADER_NAME = 'x-hub-signature-256'

/** SHA-256 hex digests are always exactly 64 lowercase-or-uppercase hex characters. */
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/i

function assertNonEmptySecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret must be a non-empty string')
  }
}

/**
 * Verifies a GitHub App webhook delivery's `X-Hub-Signature-256` header against the raw request
 * body bytes.
 *
 * `headers` accepts Express's `req.headers` shape directly (lowercased keys, `string | string[] |
 * undefined` values — Node lowercases incoming header names, and a duplicated header becomes an
 * array) rather than requiring the caller to pre-extract the one header this function reads.
 *
 * `rawBody` MUST be the exact bytes GitHub signed — see `githubWebhook.ts`'s route registration
 * for why it uses `express.raw()`, not `express.json()`, for the exact same reason
 * `integrations/slack/src/server.ts` does (a re-serialized JSON body is not guaranteed
 * byte-identical to what was actually signed).
 *
 * Returns `false` (never throws) for a missing/malformed/multi-valued header or a mismatched
 * digest — every one of those is "this delivery does not verify," not a distinct error case the
 * caller needs to branch on. Throws only for `secret` itself being empty/non-string (a caller
 * misconfiguration — `GITHUB_WEBHOOK_SECRET` unset — not a per-request verification outcome; same
 * split `signer.ts`'s `assertNonEmptySecret` makes).
 */
export function verifyGithubSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secret: string
): boolean {
  assertNonEmptySecret(secret)

  const headerValue = headers[GITHUB_SIGNATURE_HEADER_NAME]
  if (typeof headerValue !== 'string') {
    // Undefined (missing) or an array (duplicated header, ambiguous — reject
    // rather than guess which value to trust) both fail closed here.
    return false
  }

  const prefix = 'sha256='
  if (!headerValue.startsWith(prefix)) return false
  const providedDigest = headerValue.slice(prefix.length)
  if (!HEX_DIGEST_PATTERN.test(providedDigest)) return false

  const expectedDigest = createHmac('sha256', secret).update(rawBody).digest('hex')

  // Both sides are validated-length hex strings by this point (64 chars),
  // so `Buffer.from(..., 'hex')` always produces equal-length buffers —
  // `timingSafeEqual` throws on a length mismatch otherwise, but that case
  // is already excluded by the regex test above.
  const providedBuf = Buffer.from(providedDigest.toLowerCase(), 'hex')
  const expectedBuf = Buffer.from(expectedDigest, 'hex')
  return timingSafeEqual(providedBuf, expectedBuf)
}
