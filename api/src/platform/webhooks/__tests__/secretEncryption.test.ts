/**
 * Unit tests for `secretEncryption.ts` (PF-302 / TRO-431).
 *
 * Pure crypto — no database, no Express app — same "no fixtures needed"
 * shape as `signer.test.ts` in this same directory. Proves the AES-256-GCM
 * round trip the §2.2-note deviation depends on: encrypt, decrypt back to
 * the exact plaintext, and — the part that actually matters for "encrypted
 * at rest" to be a real security property, not just a label — that a
 * tampered ciphertext or a wrong key both fail loudly rather than silently
 * decrypting to garbage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  encryptSecret,
  decryptSecret,
  SECRET_ENCRYPTION_KEY_ENV,
} from '../secretEncryption.js';
import { generateWebhookSecret } from '../secrets.js';

function freshHexKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

describe('secretEncryption (PF-302 / TRO-431)', () => {
  const originalKey = process.env[SECRET_ENCRYPTION_KEY_ENV];

  beforeEach(() => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = freshHexKey();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    } else {
      process.env[SECRET_ENCRYPTION_KEY_ENV] = originalKey;
    }
  });

  it('round-trips a plaintext secret exactly', () => {
    const plaintext = generateWebhookSecret();
    expect(plaintext).toMatch(/^whsec_[0-9a-f]{64}$/);

    const ciphertext = encryptSecret(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(typeof ciphertext).toBe('string');

    const decrypted = decryptSecret(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('produces a different ciphertext for the same plaintext each call (random IV)', () => {
    const plaintext = generateWebhookSecret();
    const first = encryptSecret(plaintext);
    const second = encryptSecret(plaintext);
    expect(first).not.toBe(second);
    // Both still decrypt to the same plaintext under the same key.
    expect(decryptSecret(first)).toBe(plaintext);
    expect(decryptSecret(second)).toBe(plaintext);
  });

  it('rejects a tampered ciphertext (GCM auth tag catches it)', () => {
    const plaintext = generateWebhookSecret();
    const ciphertext = encryptSecret(plaintext);

    const raw = Buffer.from(ciphertext, 'base64');
    // Flip a byte well past the IV+authTag prefix, inside the actual
    // ciphertext bytes.
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    const tampered = raw.toString('base64');

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects a ciphertext encrypted under a different key', () => {
    const plaintext = generateWebhookSecret();
    const ciphertext = encryptSecret(plaintext);

    process.env[SECRET_ENCRYPTION_KEY_ENV] = freshHexKey();

    expect(() => decryptSecret(ciphertext)).toThrow();
  });

  it('throws a clear error when SECRET_ENCRYPTION_KEY is unset', () => {
    delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    expect(() => encryptSecret('whsec_test')).toThrow(/SECRET_ENCRYPTION_KEY is not set/);
  });

  it('throws a clear error when SECRET_ENCRYPTION_KEY is not 32 bytes of hex', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = 'deadbeef'; // 4 bytes, not 32
    expect(() => encryptSecret('whsec_test')).toThrow(/must decode to exactly 32 bytes/);
  });

  it('throws a clear error when SECRET_ENCRYPTION_KEY is not hex', () => {
    process.env[SECRET_ENCRYPTION_KEY_ENV] = 'not-hex-at-all-zzzz';
    expect(() => encryptSecret('whsec_test')).toThrow(/must be a hex string/);
  });
});
