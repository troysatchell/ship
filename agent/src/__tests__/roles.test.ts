import { describe, expect, it } from 'vitest';
import { findManagerUserId } from '../roles.js';

describe('findManagerUserId', () => {
  const people = [
    { user_id: 'emma-user-id', reportsTo: 'alice-user-id' },
    { user_id: 'alice-user-id', reportsTo: null },
    { user_id: 'no-manager-user-id', reportsTo: null },
  ];

  it('returns the manager user id for someone with reports_to set', () => {
    expect(findManagerUserId('emma-user-id', people)).toBe('alice-user-id');
  });

  it('returns null when the person has no manager on record', () => {
    expect(findManagerUserId('no-manager-user-id', people)).toBeNull();
  });

  it('returns null (degrades gracefully) when the owner is not found in the directory at all', () => {
    expect(findManagerUserId('unknown-user-id', people)).toBeNull();
  });
});
