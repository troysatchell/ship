import { describe, expect, it, vi } from 'vitest';
import { acceptDraft, acceptProposedTransition, discardItem, GateError, rejectProposedTransition } from '../gate.js';
import { InMemoryDraftStore, type NewStandupDraft, type ProposedTransition } from '../draftStore.js';
import { InMemoryItemStore, type NewInboxItem } from '../itemStore.js';
import type { CreatedStandup, GateShipClientLike } from '../shipClient.js';

const ACCEPTER_TOKEN = 'accepter-own-token-abc';
const AGENT_TOKEN = 'agent-service-account-token-should-never-be-used-here';

function fakeGateClient(): GateShipClientLike & {
  postStandup: ReturnType<typeof vi.fn>;
  setStandupContent: ReturnType<typeof vi.fn>;
  applyIssueTransition: ReturnType<typeof vi.fn>;
} {
  return {
    postStandup: vi.fn(async (_token: string, _date: string): Promise<CreatedStandup> => ({
      id: 'standup-created-1',
      title: 'Tuesday Aug 4 Standup',
      document_type: 'standup',
      content: null,
      properties: {},
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:00:00.000Z',
    })),
    setStandupContent: vi.fn(async (_token: string, standupId: string, _text: string): Promise<CreatedStandup> => ({
      id: standupId,
      title: 'Tuesday Aug 4 Standup',
      document_type: 'standup',
      content: null,
      properties: {},
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:05:00.000Z',
    })),
    applyIssueTransition: vi.fn(async (_token: string, _issueId: string, _toState: string): Promise<void> => {}),
  };
}

function draftInput(overrides: Partial<NewStandupDraft> = {}): NewStandupDraft {
  return {
    id: 'standup-draft:user-a:2026-08-04',
    personUserId: 'user-a',
    windowDate: '2026-08-04',
    draftText: 'I moved "Build issue assignment flow" to In Review.',
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

function standupDraftItem(draftId: string, recipientUserId = 'user-a'): NewInboxItem {
  return {
    id: draftId,
    recipientUserId,
    type: 'standup_draft',
    summary: 'Your standup draft is ready',
    evidence: {},
    action: { label: 'Review draft', href: `/standup-draft/${draftId}` },
    draftId,
  };
}

function mentionItem(id: string, recipientUserId = 'user-a'): NewInboxItem {
  return {
    id,
    recipientUserId,
    type: 'mention',
    summary: 'Mentioned in a document',
    evidence: { documentId: 'doc-1', documentType: 'issue' },
    action: { label: 'View', href: '/issue/doc-1' },
  };
}

describe('acceptDraft', () => {
  it('posts under the ACCEPTING person\'s own token, never the agent\'s', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput());
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    await acceptDraft({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', ACCEPTER_TOKEN);

    expect(shipClient.postStandup).toHaveBeenCalledWith(ACCEPTER_TOKEN, '2026-08-04');
    expect(shipClient.postStandup).not.toHaveBeenCalledWith(AGENT_TOKEN, expect.anything());
    // Nothing in this call signature even HAS a slot for an agent-side token —
    // this assertion documents that every call this test observed used the
    // accepter's token, not that some other, unobserved call used the agent's.
    for (const call of shipClient.postStandup.mock.calls) {
      expect(call[0]).toBe(ACCEPTER_TOKEN);
    }
  });

  it('posts the draft text as the standup content by default, and marks the draft posted', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ draftText: 'Original composed text.' }));
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    const result = await acceptDraft(
      { shipClient, itemStore, draftStore },
      'standup-draft:user-a:2026-08-04',
      ACCEPTER_TOKEN
    );

    expect(shipClient.setStandupContent).toHaveBeenCalledWith(ACCEPTER_TOKEN, 'standup-created-1', 'Original composed text.');
    expect(result).toEqual({ standupId: 'standup-created-1' });
    expect(draftStore.get('standup-draft:user-a:2026-08-04')?.status).toBe('posted');
  });

  it('posts a person-EDITED final text when supplied, without mutating the stored draftText', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ draftText: 'Original composed text.' }));
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    await acceptDraft(
      { shipClient, itemStore, draftStore },
      'standup-draft:user-a:2026-08-04',
      ACCEPTER_TOKEN,
      'Edited by the person before posting.'
    );

    expect(shipClient.setStandupContent).toHaveBeenCalledWith(
      ACCEPTER_TOKEN,
      'standup-created-1',
      'Edited by the person before posting.'
    );
    // draftText itself — the model's original composition — is untouched.
    expect(draftStore.get('standup-draft:user-a:2026-08-04')?.draftText).toBe('Original composed text.');
  });

  it('removes the item from the inbox once accepted', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput());
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    await acceptDraft({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', ACCEPTER_TOKEN);

    expect(itemStore.get('standup-draft:user-a:2026-08-04')).toBeUndefined();
  });

  it('never touches proposedTransitions on the accepted draft', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    await acceptDraft({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', ACCEPTER_TOKEN);

    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
    expect(draftStore.get('standup-draft:user-a:2026-08-04')?.proposedTransitions[0]?.status).toBe('pending');
  });

  it('refuses to accept a draft that does not exist', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();

    await expect(acceptDraft({ shipClient, itemStore, draftStore }, 'no-such-draft', ACCEPTER_TOKEN)).rejects.toThrow(
      GateError
    );
    expect(shipClient.postStandup).not.toHaveBeenCalled();
  });

  it('refuses to accept an already-posted draft a second time', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput());
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));
    await acceptDraft({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', ACCEPTER_TOKEN);

    shipClient.postStandup.mockClear();
    await expect(
      acceptDraft({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
    expect(shipClient.postStandup).not.toHaveBeenCalled();
  });
});

describe('discardItem', () => {
  it('discarding a standup_draft writes nothing to Ship, marks the draft dismissed, and clears the inbox item', () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput());
    itemStore.upsert(standupDraftItem('standup-draft:user-a:2026-08-04'));

    discardItem({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04');

    expect(shipClient.postStandup).not.toHaveBeenCalled();
    expect(shipClient.setStandupContent).not.toHaveBeenCalled();
    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
    expect(draftStore.get('standup-draft:user-a:2026-08-04')?.status).toBe('dismissed');
    expect(itemStore.get('standup-draft:user-a:2026-08-04')).toBeUndefined();
  });

  it('discarding a non-draft item (mention/blocking_approval) writes nothing and only touches the inbox', () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    itemStore.upsert(mentionItem('mention:document:doc-1:user-a'));

    discardItem({ shipClient, itemStore, draftStore }, 'mention:document:doc-1:user-a');

    expect(shipClient.postStandup).not.toHaveBeenCalled();
    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
    expect(itemStore.get('mention:document:doc-1:user-a')).toBeUndefined();
  });

  it('a dismissed item is not re-created by the following poll (proof #4)', () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    const item = mentionItem('mention:document:doc-1:user-a');
    itemStore.upsert(item);

    discardItem({ shipClient, itemStore, draftStore }, 'mention:document:doc-1:user-a');

    // Simulates the NEXT poll re-deriving the exact same mention (e.g. an
    // agent restart re-scanning an overlapping lookback window) and calling
    // upsert() again, same as graph.ts's commitInboxItems always does.
    itemStore.upsert(item);

    expect(itemStore.get('mention:document:doc-1:user-a')).toBeUndefined();
  });

  it('refuses to discard an item that does not exist', () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();

    expect(() => discardItem({ shipClient, itemStore, draftStore }, 'no-such-item')).toThrow(GateError);
  });
});

describe('acceptProposedTransition', () => {
  it('applies exactly the accepted transition, attributed via the accepting token, and leaves siblings untouched', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(
      draftInput({
        proposedTransitions: [
          transition({ issueId: 'issue-1', toState: 'in_review' }),
          transition({ issueId: 'issue-2', toState: 'done' }),
        ],
      })
    );

    await acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN);

    expect(shipClient.applyIssueTransition).toHaveBeenCalledTimes(1);
    expect(shipClient.applyIssueTransition).toHaveBeenCalledWith(ACCEPTER_TOKEN, 'issue-1', 'in_review');

    const draft = draftStore.get('standup-draft:user-a:2026-08-04');
    expect(draft?.proposedTransitions[0]?.status).toBe('accepted');
    // The sibling at index 1 — untouched.
    expect(draft?.proposedTransitions[1]?.status).toBe('pending');
  });

  it('rejecting one and accepting another applies exactly one Ship write (proof #5)', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(
      draftInput({
        proposedTransitions: [
          transition({ issueId: 'issue-1', toState: 'in_review' }),
          transition({ issueId: 'issue-2', toState: 'done' }),
        ],
      })
    );

    rejectProposedTransition({ draftStore }, 'standup-draft:user-a:2026-08-04', 0);
    await acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 1, ACCEPTER_TOKEN);

    expect(shipClient.applyIssueTransition).toHaveBeenCalledTimes(1);
    expect(shipClient.applyIssueTransition).toHaveBeenCalledWith(ACCEPTER_TOKEN, 'issue-2', 'done');

    const draft = draftStore.get('standup-draft:user-a:2026-08-04');
    expect(draft?.proposedTransitions[0]?.status).toBe('rejected');
    expect(draft?.proposedTransitions[1]?.status).toBe('accepted');
  });

  it('refuses to accept an unsupported field', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition({ field: 'priority', toState: 'high' })] }));

    await expect(
      acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
  });

  it('refuses to accept the same transition twice', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));

    await acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN);
    shipClient.applyIssueTransition.mockClear();

    await expect(
      acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
  });

  it('refuses to accept an already-rejected transition', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));

    rejectProposedTransition({ draftStore }, 'standup-draft:user-a:2026-08-04', 0);

    await expect(
      acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
    expect(shipClient.applyIssueTransition).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range index', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));

    await expect(
      acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 5, ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
  });
});

describe('rejectProposedTransition', () => {
  it('performs no Ship write — the function signature does not even accept a token', () => {
    const draftStore = new InMemoryDraftStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));

    rejectProposedTransition({ draftStore }, 'standup-draft:user-a:2026-08-04', 0);

    expect(draftStore.get('standup-draft:user-a:2026-08-04')?.proposedTransitions[0]?.status).toBe('rejected');
  });

  it('a rejected transition is terminal — cannot later be re-rejected or accepted', async () => {
    const shipClient = fakeGateClient();
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput({ proposedTransitions: [transition()] }));

    rejectProposedTransition({ draftStore }, 'standup-draft:user-a:2026-08-04', 0);

    expect(() => rejectProposedTransition({ draftStore }, 'standup-draft:user-a:2026-08-04', 0)).toThrow(GateError);
    await expect(
      acceptProposedTransition({ shipClient, itemStore, draftStore }, 'standup-draft:user-a:2026-08-04', 0, ACCEPTER_TOKEN)
    ).rejects.toThrow(GateError);
  });
});
