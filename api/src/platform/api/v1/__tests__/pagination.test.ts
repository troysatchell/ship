/**
 * TRO-602 follow-up (local CodeRabbit review, `major`): `preciseTimestamp()`
 * performed zero runtime validation, so it would silently brand a
 * `Date#toISOString()` string — exactly the lossy value the whole ticket
 * exists to keep out — as "precise". The suggested fix ("require a fixed
 * six-digit fraction") is itself wrong: verified directly against this DB
 * that Postgres's `timestamptz::text` cast trims trailing zero digits and
 * omits the fraction entirely when it's exactly zero (`05:33:23+00`, not
 * `05:33:23.000000+00`) — a fixed-six-digit check would reject a large
 * fraction of genuinely precise real timestamps. These tests cover the
 * corrected, variable-length version instead.
 */

import { describe, it, expect } from 'vitest';
import { preciseTimestamp, encodeCursor, decodeCursor } from '../pagination.js';

describe('preciseTimestamp', () => {
  it('accepts a Postgres timestamptz::text cast with a full 6-digit fraction', () => {
    expect(() => preciseTimestamp('2026-08-15 05:33:23.123456+00')).not.toThrow();
  });

  it('accepts a Postgres timestamptz::text cast with NO fraction (exactly zero microseconds)', () => {
    // The specific case CodeRabbit's literal suggestion would have broken.
    expect(() => preciseTimestamp('2026-08-15 05:33:23+00')).not.toThrow();
  });

  it('accepts a Postgres timestamptz::text cast with a trimmed short fraction', () => {
    expect(() => preciseTimestamp('2026-08-15 05:33:23.5+00')).not.toThrow();
    expect(() => preciseTimestamp('2026-08-15 05:33:23.05+00')).not.toThrow();
  });

  it('rejects a Date#toISOString() value — the exact lossy shape TRO-602 fixed', () => {
    const lossy = new Date('2026-08-15T05:33:23.123Z').toISOString();
    expect(() => preciseTimestamp(lossy)).toThrow(/not shaped like a Postgres timestamptz::text cast/);
  });

  it('rejects garbage', () => {
    expect(() => preciseTimestamp('not-a-timestamp')).toThrow();
    expect(() => preciseTimestamp('')).toThrow();
  });
});

describe('decodeCursor: malformed created_at degrades to null, never throws', () => {
  it('round-trips a real cursor through encode -> decode', () => {
    const cursor = { id: 'abc-123', created_at: preciseTimestamp('2026-08-15 05:33:23.123456+00') };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('returns null (not a thrown exception) for a hand-crafted cursor with a Date#toISOString() created_at', () => {
    const handCrafted = Buffer.from(
      JSON.stringify({ id: 'abc-123', created_at: new Date('2026-08-15T05:33:23.123Z').toISOString() }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(handCrafted)).not.toThrow();
    expect(decodeCursor(handCrafted)).toBeNull();
  });

  it('returns null for a hand-crafted cursor with a garbage created_at', () => {
    const handCrafted = Buffer.from(
      JSON.stringify({ id: 'abc-123', created_at: 'not-a-timestamp' }),
      'utf8'
    ).toString('base64url');
    expect(decodeCursor(handCrafted)).toBeNull();
  });
});
