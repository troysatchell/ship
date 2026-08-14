/**
 * AES-256-GCM encrypt/decrypt for webhook signing secrets at rest
 * (PF-302 / TRO-431, PLUGFORGE.MD §2.2 note).
 *
 * The §2.2 note, restated in `docs/architecture.md`'s "Documented
 * Deviations": the brief says "hashed signing secret", but the server must
 * POSSESS the secret at delivery time to compute the HMAC signature
 * (`signer.ts`, PF-303) — a one-way hash is unimplementable for that. So
 * `webhook_subscriptions.signing_secret_ciphertext` (migration 047) holds an
 * AES-256-GCM ciphertext, not a hash: `encryptSecret` is called once at
 * creation/rotation time, its output stored, and the plaintext handed back
 * to the caller exactly once — never persisted, never logged. `decryptSecret`
 * exists for the one caller that legitimately needs the plaintext back (the
 * future PF-304 deliverer, computing an HMAC over an outgoing payload) — no
 * route in this ticket calls it, by design (PF-302's own AC: "secret
 * non-recoverable via API after creation").
 *
 * Key source: `SECRET_ENCRYPTION_KEY` (PLUGFORGE.MD §2.2/§2.10 — the only
 * env var name used anywhere in this codebase for this purpose; confirmed by
 * grep across `api/`, `docs/`, and `PLUGFORGE.MD` before writing this file —
 * no other secret-encryption key name exists to collide with or duplicate).
 * A 64-character hex string decoding to exactly 32 bytes (AES-256's key
 * size) — generate one with `openssl rand -hex 32`.
 *
 * Wire format: `base64(iv[12] || authTag[16] || ciphertext[N])` — one
 * self-contained blob per §2.2's single `signing_secret_ciphertext` column
 * (not three sibling columns the PRD's table doesn't list). 12-byte IV is
 * GCM's recommended/default nonce size (`crypto.createCipheriv`'s default
 * for `aes-256-gcm`, unchanged here); 16-byte auth tag is GCM's standard
 * (and Node's) tag length.
 *
 * Dependency-free apart from `node:crypto`, matching this directory's own
 * isolation convention (`signer.ts`, `events.ts`, `eventBus.ts` all state
 * the same rationale in their headers): this file has nothing to do with a
 * database row or an Express request, so it has no business importing
 * either.
 *
 * **Known, disclosed limitation: no key versioning/rotation (CodeRabbit,
 * this PR's review).** There is exactly one active `SECRET_ENCRYPTION_KEY`
 * at a time, with no version tag stored alongside the ciphertext and no
 * active/legacy keyring to resolve against. Rotating the deployment's own
 * `SECRET_ENCRYPTION_KEY` — as opposed to a single subscription's `whsec_...`
 * signing secret, which `POST /:id/rotate` already handles — would make
 * every existing `signing_secret_ciphertext` row undecryptable, with no
 * migration path back. This is a real gap, not a silently-ignored one: it is
 * out of PF-302's own AC ("CRUD tests; secret non-recoverable via API after
 * creation; rotation endpoint" — that "rotation" is the subscription
 * secret's, per PLUGFORGE.MD §2.2, not the deployment key's), and building a
 * versioned keyring is a real feature (key storage, re-encryption-in-place
 * on retirement, a migration to add the version column) that no ticket has
 * yet scoped. Flagged here explicitly so it is found by grep before it is
 * found by an actual key-rotation incident.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** The only env var this codebase uses for the secret-encryption key
 * (PLUGFORGE.MD §2.2/§2.10). */
export const SECRET_ENCRYPTION_KEY_ENV = 'SECRET_ENCRYPTION_KEY'

/**
 * Thrown by `decryptSecret` ONLY for a `combined.length` check that fails
 * before any key-dependent operation runs — i.e. the base64-decoded blob is
 * structurally too short to contain an IV and auth tag, full stop, under ANY
 * key. A dedicated class rather than plain `Error` (PF-304/TRO-438's
 * `platform/webhooks/deliverer.ts` needs to tell this ONE genuinely
 * deterministic-regardless-of-key failure apart from every other way
 * `decryptSecret` can throw — a missing/malformed `SECRET_ENCRYPTION_KEY`
 * (this module's own `loadEncryptionKey`), or a GCM auth-tag mismatch from
 * `decipher.final()`, which is indistinguishable at the crypto level between
 * "this ciphertext is genuinely corrupt" and "this ciphertext was encrypted
 * under a PREVIOUS `SECRET_ENCRYPTION_KEY` that has since rotated" — this
 * module's own header already discloses that second case as a known,
 * unsupported gap. Both of those are process/deployment-level conditions an
 * operator might still fix without touching the affected row, so the
 * deliverer treats them as transient and retries; only THIS narrow,
 * unambiguous case is treated as permanent.
 */
export class MalformedCiphertextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedCiphertextError'
  }
}

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH_BYTES = 32 // AES-256
const IV_LENGTH_BYTES = 12 // GCM's standard/default nonce size
const AUTH_TAG_LENGTH_BYTES = 16 // GCM's standard tag size

/**
 * Resolves and validates the encryption key from `SECRET_ENCRYPTION_KEY`.
 * Called fresh on every encrypt/decrypt (not cached at module load) so a
 * misconfigured or rotated env var is caught at the call site rather than
 * baked in from whatever the process saw first — cheap, since this is only
 * ever called on the create/rotate/deliver path, never per-request on a
 * hot read.
 *
 * Throws rather than falling back to any default: an unset or malformed key
 * here means every stored ciphertext in this environment is either
 * unreadable or (worse, if a fallback silently supplied a weak/predictable
 * key) readable by anyone who could guess the fallback. Fail loud.
 */
function loadEncryptionKey(): Buffer {
  const raw = process.env[SECRET_ENCRYPTION_KEY_ENV]
  if (!raw) {
    throw new Error(
      `${SECRET_ENCRYPTION_KEY_ENV} is not set. Required to encrypt/decrypt webhook signing ` +
        'secrets at rest (AES-256-GCM, PLUGFORGE.MD §2.2). Generate one with: openssl rand -hex 32'
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      `${SECRET_ENCRYPTION_KEY_ENV} must be a hex string (got a non-hex value of length ${raw.length}).`
    )
  }
  const key = Buffer.from(raw, 'hex')
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${SECRET_ENCRYPTION_KEY_ENV} must decode to exactly ${KEY_LENGTH_BYTES} bytes ` +
        `(a 64-character hex string) for AES-256 — decoded to ${key.length} bytes.`
    )
  }
  return key
}

/**
 * Encrypts `plaintext` (a `whsec_...` secret) under `SECRET_ENCRYPTION_KEY`.
 * Returns the base64-encoded `iv || authTag || ciphertext` blob to store
 * verbatim in `webhook_subscriptions.signing_secret_ciphertext`.
 *
 * A fresh random IV every call (never reused across encryptions under the
 * same key — GCM's core safety requirement) is why this function, not the
 * caller, owns IV generation: there is no seam here for a caller to
 * accidentally pass the same IV twice.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadEncryptionKey()
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

/**
 * Decrypts a blob produced by `encryptSecret`, returning the original
 * plaintext `whsec_...` secret. Throws (via `createDecipheriv`'s own
 * `setAuthTag`/`final()` behavior) if the ciphertext was tampered with, was
 * encrypted under a different key, or is malformed — GCM's authentication
 * property means a corrupted blob fails loudly rather than decrypting to
 * garbage silently.
 */
export function decryptSecret(encoded: string): string {
  const key = loadEncryptionKey()
  const combined = Buffer.from(encoded, 'base64')
  if (combined.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
    throw new MalformedCiphertextError('decryptSecret: encoded value is too short to contain an IV and auth tag.')
  }
  const iv = combined.subarray(0, IV_LENGTH_BYTES)
  const authTag = combined.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES)
  const ciphertext = combined.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
