/**
 * Webhook signing-secret generation (PF-302 / TRO-431).
 *
 * Mirrors `platform/oauth/credentials.ts`'s `generateClientSecret` shape
 * (random-bytes-derived, distinguishing prefix) for consistency with this
 * codebase's established secret-generation pattern — the one difference
 * from that module is what happens to the value afterward: OAuth app
 * secrets are hashed at rest (`hashClientSecret`, SHA-256, one-way);
 * webhook signing secrets are encrypted at rest (`secretEncryption.ts`,
 * AES-256-GCM, reversible), because a signer must recover the plaintext to
 * compute an HMAC (see `secretEncryption.ts`'s header for the full
 * rationale). Kept in its own file rather than folded into
 * `secretEncryption.ts` so "generate a secret" and "encrypt/decrypt a
 * secret" stay independently testable, single-purpose modules — the same
 * split `credentials.ts` (generate/hash) and `appRegistration.ts`
 * (DB reads/writes) already draw for OAuth apps.
 *
 * Dependency-free apart from `node:crypto`, same isolation rationale as the
 * rest of this directory (`signer.ts`, `events.ts`, `eventBus.ts`,
 * `secretEncryption.ts`).
 */

import { randomBytes } from 'node:crypto'

/** `whsec_...` — PLUGFORGE.MD §2.2's own prefix for webhook signing
 * secrets, distinct from `ship_app_`/`ship_appsec_` (OAuth) and `ship_`
 * (personal API tokens) so a leaked value's origin is unambiguous at a
 * glance, same reasoning `credentials.ts` documents for its own prefixes. */
const WEBHOOK_SECRET_PREFIX = 'whsec_'

/** Generates a new plaintext webhook signing secret, e.g.
 * `whsec_3f9a...` (32 random bytes, hex-encoded — same entropy as
 * `generateClientSecret`). Never persisted in this form: the caller encrypts
 * it (`secretEncryption.ts#encryptSecret`) before storing, and returns this
 * exact return value to the API caller exactly once. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('hex')}`
}
