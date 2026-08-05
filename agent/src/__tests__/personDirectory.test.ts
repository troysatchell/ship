import { describe, expect, it } from 'vitest';
import { isPersonDirectoryEntry } from '../scripts/personDirectory.js';

// Regression (CodeRabbit, GitHub PR #122 round): trace-invoke-proactive.ts's
// isPersonDirectoryEntry (now split into personDirectory.ts so it can be
// unit-tested without importing the live-API script it came from) never
// checked user_id's type when present. A directory row shaped like
// `{ id: '...', name: '...', user_id: 42 }` used to pass the guard, and the
// script then treats a NUMBER as a person id downstream — a real risk in a
// script whose entire job is correlating one specific recipient. Before the
// fix, the "rejects a wrong-typed user_id" case below failed with `true`
// (the guard passed it) instead of `false` — a plain assertion failure, not
// a thrown error.
describe('isPersonDirectoryEntry', () => {
  it('accepts an entry with a string user_id', () => {
    expect(isPersonDirectoryEntry({ id: 'p1', name: 'Ada Lovelace', user_id: 'u1' })).toBe(true);
  });

  it('accepts an entry with no user_id at all', () => {
    expect(isPersonDirectoryEntry({ id: 'p1', name: 'Ada Lovelace' })).toBe(true);
  });

  it('accepts an entry with an explicit null user_id (no linked account)', () => {
    expect(isPersonDirectoryEntry({ id: 'p1', name: 'Ada Lovelace', user_id: null })).toBe(true);
  });

  it('rejects an entry whose user_id is a number, not a string', () => {
    expect(isPersonDirectoryEntry({ id: 'p1', name: 'Ada Lovelace', user_id: 42 })).toBe(false);
  });

  it('rejects an entry whose id is missing', () => {
    expect(isPersonDirectoryEntry({ name: 'Ada Lovelace' })).toBe(false);
  });

  it('rejects an entry whose name is missing', () => {
    expect(isPersonDirectoryEntry({ id: 'p1' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isPersonDirectoryEntry(null)).toBe(false);
    expect(isPersonDirectoryEntry('p1')).toBe(false);
    expect(isPersonDirectoryEntry(undefined)).toBe(false);
  });
});
