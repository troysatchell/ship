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

  // TRO-321 / FG-8 — dismiss-with-dedup (proof #4: "a dismissed item is not
  // re-created on the following poll").
  describe('dismiss()', () => {
    it('removes the item, same as clear()', () => {
      const store = new InMemoryItemStore();
      store.upsert(mention('mention:1', 'user-a'));

      expect(store.dismiss('mention:1')).toBe(true);
      expect(store.get('mention:1')).toBeUndefined();
    });

    it('returns false (no-op) for an item that does not currently exist', () => {
      const store = new InMemoryItemStore();
      expect(store.dismiss('no-such-item')).toBe(false);
    });

    it('an exact-version replay after dismiss is NOT resurrected by upsert (proof #4)', () => {
      const store = new InMemoryItemStore();
      const item = mention('mention:1', 'user-a');
      store.upsert(item);

      store.dismiss('mention:1');
      // Simulates the immediate next poll re-deriving the identical mention
      // (e.g. an agent restart re-scanning an overlapping lookback window).
      store.upsert(item);

      expect(store.get('mention:1')).toBeUndefined();
      expect(store.all()).toHaveLength(0);
    });

    it('plain clear() (NOT dismiss()) does NOT protect against this — the two are different for a reason', () => {
      // This is the control that proves dismiss() is doing real work, not
      // that upsert()-by-id already made this safe for free.
      const store = new InMemoryItemStore();
      const item = mention('mention:1', 'user-a');
      store.upsert(item);

      store.clear('mention:1');
      store.upsert(item);

      expect(store.get('mention:1')).toBeDefined();
    });

    it('a genuinely NEW occurrence of a blocking_approval id (new blockedSince) is NOT suppressed by an earlier dismissal', () => {
      const store = new InMemoryItemStore();
      const first = blockingApproval('blocking:sprint-1:plan_approval', 'user-a', 1, '2026-01-01T00:00:00.000Z');
      store.upsert(first);
      store.dismiss('blocking:sprint-1:plan_approval');

      // A LATER, genuinely new blocking-approval cycle for the same
      // (document, field) id — different blockedSince, i.e. a different
      // underlying document_history row.
      const second = blockingApproval('blocking:sprint-1:plan_approval', 'user-a', 1, '2026-02-01T00:00:00.000Z');
      store.upsert(second);

      expect(store.get('blocking:sprint-1:plan_approval')).toBeDefined();
      expect(store.get('blocking:sprint-1:plan_approval')?.blockedSince).toBe('2026-02-01T00:00:00.000Z');
    });

    it('an exact-version replay of a blocking_approval (same blockedSince) IS suppressed', () => {
      const store = new InMemoryItemStore();
      const item = blockingApproval('blocking:sprint-1:plan_approval', 'user-a', 1, '2026-01-01T00:00:00.000Z');
      store.upsert(item);
      store.dismiss('blocking:sprint-1:plan_approval');

      store.upsert(item);

      expect(store.get('blocking:sprint-1:plan_approval')).toBeUndefined();
    });
  });
});
