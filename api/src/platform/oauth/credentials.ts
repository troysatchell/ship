/**
 * Client-id / client-secret generation and hashing for OAuth apps (PF-102).
 *
 * Pattern mirrors `api/src/routes/api-tokens.ts`'s `generateApiToken`/`hashToken`
 * exactly: a random-bytes-derived opaque string, SHA-256 hashed at rest. Split
 * into its own file (rather than living inline in `appRegistration.ts`) so the
 * hashing primitive has no dependency on `pool`/DB code and can be unit-tested
 * and reused by PF-104's `/oauth/token` client-auth path without pulling in
 * anything else from this module.
 */

import crypto from 'crypto';

/** Public client identifier, e.g. `ship_app_...` (PLUGFORGE.MD §2.2). */
const CLIENT_ID_PREFIX = 'ship_app_';

/**
 * Confidential-client secret prefix. `ship_appsec_` (not `ship_app_`) so a
 * leaked value is unambiguously identifiable as a *secret* — the same
 * distinguishing-prefix reasoning `ship_` already uses for personal API
 * tokens (`api-tokens.ts`) vs. session cookies.
 */
const CLIENT_SECRET_PREFIX = 'ship_appsec_';

export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

export function generateClientSecret(): string {
  return `${CLIENT_SECRET_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

/** SHA-256 hex digest — same hashing pattern as `api-tokens.ts`'s `hashToken`. */
export function hashClientSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}
