import { describe, expect, it } from 'vitest';
import { InMemoryDraftStore, type NewStandupDraft, type ProposedTransition } from '../draftStore.js';

function draft(id: string, personUserId: string, windowDate: string, overrides: Partial<NewStandupDraft> = {}): NewStandupDraft {
  return {
    id,
    personUserId,
    windowDate,
    draftText: 'I moved issue X to In Review.',
    proposedTransitions: [],
    ...overrides,
  };
}

function transition(overrides: Partial<ProposedTransition> = {}): ProposedTransition {
  return {
    issueId: 'issue-1',
    issueTitle: 'Build issue assignment flow',
    field: 'state',
    fromState: 'in_progress',
    toState: 'in_review',
    evidence: { kind: 'history', changedAt: '2026-08-04T09:00:00.000Z', changedBy: 'user-a' },
    ...overrides,
  };
}

describe('InMemoryDraftStore', () => {
  it('upserts: writing the same id twice updates rather than duplicates', () => {
    const store = new InMemoryDraftStore();
    store.upsert(draft('d1', 'user-a', '2026-08-01'));
    store.upsert(draft('d1', 'user-a', '2026-08-01', { draftText: 'revised text' }));

    expect(store.listForPerson('user-a')).toHaveLength(1);
    expect(store.get('d1')?.draftText).toBe('revised text');
  });

  it('preserves createdAt across an upsert but advances updatedAt', () => {
    let clock = new Date('2026-08-01T08:00:00.000Z');
    const store = new InMemoryDraftStore(() => clock);

    const first = store.upsert(draft('d1', 'user-a', '2026-08-01'));
    clock = new Date('2026-08-01T09:00:00.000Z');
    const second = store.upsert(draft('d1', 'user-a', '2026-08-01'));

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('new drafts default to status "unseen"', () => {
    const store = new InMemoryDraftStore();
    const d = store.upsert(draft('d1', 'user-a', '2026-08-01'));
    expect(d.status).toBe('unseen');
  });

  it('re-upserting the same window preserves a status the person already set (does not un-dismiss)', () => {
    const store = new InMemoryDraftStore();
    store.upsert(draft('d1', 'user-a', '2026-08-01'));
    store.markDismissed('d1');

    const updated = store.upsert(draft('d1', 'user-a', '2026-08-01', { draftText: 'recomposed' }));

    expect(updated.status).toBe('dismissed');
    expect(updated.draftText).toBe('recomposed');
  });

  it('markViewed/markDismissed/markPosted report false for an unknown id', () => {
    const store = new InMemoryDraftStore();
    expect(store.markViewed('missing')).toBe(false);
    expect(store.markDismissed('missing')).toBe(false);
    expect(store.markPosted('missing')).toBe(false);
  });

  it('markViewed/markDismissed/markPosted update status and report true for a real id', () => {
    const store = new InMemoryDraftStore();
    store.upsert(draft('d1', 'user-a', '2026-08-01'));

    expect(store.markViewed('d1')).toBe(true);
    expect(store.get('d1')?.status).toBe('viewed');
  });

  // TRO-321 / FG-8
  describe('proposedTransitions status', () => {
    it('upsert normalizes a producer-supplied transition with no status to "pending"', () => {
      const store = new InMemoryDraftStore();
      const d = store.upsert(draft('d1', 'user-a', '2026-08-01', { proposedTransitions: [transition()] }));

      expect(d.proposedTransitions[0]?.status).toBe('pending');
    });
  });

  describe('setProposedTransitionStatus', () => {
    it('marks only the transition at the given index, leaving siblings untouched', () => {
      const store = new InMemoryDraftStore();
      store.upsert(
        draft('d1', 'user-a', '2026-08-01', {
          proposedTransitions: [transition({ issueId: 'issue-1' }), transition({ issueId: 'issue-2' })],
        })
      );

      expect(store.setProposedTransitionStatus('d1', 0, 'accepted')).toBe(true);

      const d = store.get('d1');
      expect(d?.proposedTransitions[0]?.status).toBe('accepted');
      expect(d?.proposedTransitions[1]?.status).toBe('pending');
    });

    it('returns false for an unknown draft id', () => {
      const store = new InMemoryDraftStore();
      expect(store.setProposedTransitionStatus('missing', 0, 'accepted')).toBe(false);
    });

    it('returns false for an out-of-range index', () => {
      const store = new InMemoryDraftStore();
      store.upsert(draft('d1', 'user-a', '2026-08-01', { proposedTransitions: [transition()] }));

      expect(store.setProposedTransitionStatus('d1', 5, 'accepted')).toBe(false);
    });

    it('refuses to change a transition that is not currently pending (no toggling back and forth)', () => {
      const store = new InMemoryDraftStore();
      store.upsert(draft('d1', 'user-a', '2026-08-01', { proposedTransitions: [transition()] }));

      expect(store.setProposedTransitionStatus('d1', 0, 'rejected')).toBe(true);
      // Already rejected — trying to flip it to accepted (or reject it again) is refused.
      expect(store.setProposedTransitionStatus('d1', 0, 'accepted')).toBe(false);
      expect(store.setProposedTransitionStatus('d1', 0, 'rejected')).toBe(false);
      expect(store.get('d1')?.proposedTransitions[0]?.status).toBe('rejected');
    });
  });

  it('listForPerson only returns drafts for the requested person, newest window first', () => {
    const store = new InMemoryDraftStore();
    store.upsert(draft('d1', 'user-a', '2026-08-01'));
    store.upsert(draft('d2', 'user-a', '2026-08-03'));
    store.upsert(draft('d3', 'user-b', '2026-08-02'));

    const list = store.listForPerson('user-a');
    expect(list.map((d) => d.id)).toEqual(['d2', 'd1']);
  });

  describe('shouldGenerateDraftFor — the 14-day waste-control stop condition (TRO-319)', () => {
    it('is true for a person with no drafts at all (first-ever draft)', () => {
      const store = new InMemoryDraftStore();
      expect(store.shouldGenerateDraftFor('user-a')).toBe(true);
    });

    it('is true when the MOST RECENT draft was viewed, however old an unseen draft further back is', () => {
      let now = new Date('2026-07-01T00:00:00.000Z');
      const store = new InMemoryDraftStore(() => now);
      // An old, never-viewed draft — 45+ days stale by the time this check
      // runs. It must NOT count, because it is not part of the unbroken
      // run ending at the most recent draft (which WAS viewed).
      store.upsert(draft('old', 'user-a', '2026-07-01'));

      now = new Date('2026-08-15T00:00:00.000Z');
      const recent = store.upsert(draft('recent', 'user-a', '2026-08-15'));
      store.markViewed(recent.id);

      expect(store.shouldGenerateDraftFor('user-a')).toBe(true);
    });

    it('is false once an unbroken run of unseen drafts has spanned >= the threshold (14 days default)', () => {
      let now = new Date('2026-08-01T08:00:00.000Z');
      const store = new InMemoryDraftStore(() => now);

      // The oldest draft in the unseen run — never viewed/dismissed.
      store.upsert(draft('d1', 'user-a', '2026-08-01'));

      // 15 days later, still unseen.
      now = new Date('2026-08-16T08:00:00.000Z');
      expect(store.shouldGenerateDraftFor('user-a')).toBe(false);
    });

    it('is true just under the threshold and false once it is crossed (boundary check)', () => {
      let now = new Date('2026-08-01T00:00:00.000Z');
      const store = new InMemoryDraftStore(() => now);
      store.upsert(draft('d1', 'user-a', '2026-08-01'));

      now = new Date('2026-08-14T23:59:59.000Z'); // just under 14 days
      expect(store.shouldGenerateDraftFor('user-a')).toBe(true);

      now = new Date('2026-08-15T00:00:01.000Z'); // just over 14 days
      expect(store.shouldGenerateDraftFor('user-a')).toBe(false);
    });

    it('a single interaction anywhere in the run resets the streak — only an UNBROKEN ignored run counts', () => {
      let now = new Date('2026-08-01T00:00:00.000Z');
      const store = new InMemoryDraftStore(() => now);

      store.upsert(draft('d1', 'user-a', '2026-08-01'));
      store.markDismissed('d1'); // acted on

      now = new Date('2026-08-05T00:00:00.000Z');
      store.upsert(draft('d2', 'user-a', '2026-08-05')); // unseen, but the streak restarts here

      now = new Date('2026-08-10T00:00:00.000Z'); // only 5 days since d2, well under 14
      expect(store.shouldGenerateDraftFor('user-a')).toBe(true);
    });

    it('respects a custom thresholdDays argument', () => {
      let now = new Date('2026-08-01T00:00:00.000Z');
      const store = new InMemoryDraftStore(() => now);
      store.upsert(draft('d1', 'user-a', '2026-08-01'));

      now = new Date('2026-08-04T00:00:00.000Z'); // 3 days later
      expect(store.shouldGenerateDraftFor('user-a', 2)).toBe(false); // 3 >= 2-day threshold
      expect(store.shouldGenerateDraftFor('user-a', 7)).toBe(true); // 3 < 7-day threshold
    });
  });
});
