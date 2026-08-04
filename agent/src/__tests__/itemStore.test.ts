import { describe, expect, it } from 'vitest';
import { InMemoryItemStore, type NewInboxItem } from '../itemStore.js';

function mention(id: string, recipientUserId: string): NewInboxItem {
  return {
    id,
    recipientUserId,
    type: 'mention',
    summary: 'Mentioned in a document',
    evidence: { documentId: 'doc-1', documentType: 'issue' },
    action: { label: 'View', href: '/issue/doc-1' },
  };
}

function blockingApproval(
  id: string,
  recipientUserId: string,
  blockedCount: number,
  blockedSince: string
): NewInboxItem {
  return {
    id,
    recipientUserId,
    type: 'blocking_approval',
    summary: 'Plan waiting on your approval',
    evidence: { documentId: 'sprint-1', documentType: 'sprint' },
    action: { label: 'Review plan', href: '/sprint/sprint-1' },
    blockedCount,
    blockedSince,
  };
}

describe('InMemoryItemStore', () => {
  it('upserts: writing the same id twice updates rather than duplicates', () => {
    const store = new InMemoryItemStore();
    store.upsert(mention('mention:1', 'user-a'));
    store.upsert(mention('mention:1', 'user-a'));

    expect(store.all()).toHaveLength(1);
  });

  it('preserves createdAt across an upsert but advances updatedAt', () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = new InMemoryItemStore(() => clock);

    const first = store.upsert(mention('mention:1', 'user-a'));
    clock = new Date('2026-01-01T00:05:00.000Z');
    const second = store.upsert(mention('mention:1', 'user-a'));

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('clear() removes an item and reports whether something was actually removed', () => {
    const store = new InMemoryItemStore();
    store.upsert(mention('mention:1', 'user-a'));

    expect(store.clear('mention:1')).toBe(true);
    expect(store.get('mention:1')).toBeUndefined();
    expect(store.clear('mention:1')).toBe(false); // already gone — no-op
  });

  it('list() only returns items for the requested recipient', () => {
    const store = new InMemoryItemStore();
    store.upsert(mention('mention:1', 'user-a'));
    store.upsert(mention('mention:2', 'user-b'));

    expect(store.list('user-a').map((i) => i.id)).toEqual(['mention:1']);
  });

  it('list() ranks blocking_approval items before mention items', () => {
    const store = new InMemoryItemStore();
    store.upsert(mention('mention:1', 'user-a'));
    store.upsert(blockingApproval('blocking:1', 'user-a', 1, '2026-01-01T00:00:00.000Z'));

    const list = store.list('user-a');
    expect(list[0]?.type).toBe('blocking_approval');
    expect(list[1]?.type).toBe('mention');
  });

  it('list() ranks blocking_approval items by blockedCount descending, then oldest blockedSince first', () => {
    const store = new InMemoryItemStore();
    store.upsert(blockingApproval('blocking:low', 'user-a', 1, '2026-01-03T00:00:00.000Z'));
    store.upsert(blockingApproval('blocking:high', 'user-a', 3, '2026-01-02T00:00:00.000Z'));
    store.upsert(blockingApproval('blocking:high-older', 'user-a', 3, '2026-01-01T00:00:00.000Z'));

    const ids = store.list('user-a').map((i) => i.id);
    expect(ids).toEqual(['blocking:high-older', 'blocking:high', 'blocking:low']);
  });
});
