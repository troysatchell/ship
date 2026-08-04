import { describe, expect, it } from 'vitest';
import { isDocumentVisibleTo } from '../visibility.js';

describe('isDocumentVisibleTo', () => {
  it('is visible when the document is workspace-wide, regardless of creator', () => {
    expect(isDocumentVisibleTo({ visibility: 'workspace', created_by: 'someone-else' }, 'recipient')).toBe(true);
  });

  it('is visible to a private document\'s own creator', () => {
    expect(isDocumentVisibleTo({ visibility: 'private', created_by: 'recipient' }, 'recipient')).toBe(true);
  });

  it('is NOT visible to someone else when the document is private (the never-surface case)', () => {
    expect(isDocumentVisibleTo({ visibility: 'private', created_by: 'someone-else' }, 'recipient')).toBe(false);
  });

  it('is NOT visible when private and created_by is null', () => {
    expect(isDocumentVisibleTo({ visibility: 'private', created_by: null }, 'recipient')).toBe(false);
  });
});
