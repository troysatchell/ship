/**
 * TRO-317 / FG-5 — the four proofs the ticket names ("How it will be
 * proven"), plus the branch coverage behind them. Every case runs against
 * stable fakes (`ShipClientLike`) — never a live Ship API call, matching
 * the rest of this package's convention (graph.test.ts, resilientClient.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ShipClientLike, ChangeFeedResponse, ShipDocument, ShipPerson } from '../shipClient.js';
import { buildMentionItems, buildBlockingApprovalItems, pollChangeFeed } from '../proactive.js';
import { InMemoryItemStore } from '../itemStore.js';
import { buildGraph } from '../graph.js';

function emptyFeed(overrides: Partial<ChangeFeedResponse> = {}): ChangeFeedResponse {
  return {
    next_cursor: '2026-01-01T00:01:00.000Z',
    documents: [],
    documents_truncated: false,
    history: [],
    history_truncated: false,
    comments: [],
    comments_truncated: false,
    ...overrides,
  };
}

function person(overrides: Partial<ShipPerson> = {}): ShipPerson {
  return {
    id: 'person-alice',
    user_id: 'user-alice',
    name: 'Alice Chen',
    email: 'alice@example.gov',
    isArchived: false,
    isPending: false,
    reportsTo: null,
    role: null,
    ...overrides,
  };
}

function doc(overrides: Partial<ShipDocument> = {}): ShipDocument {
  return {
    id: 'issue-1',
    document_type: 'issue',
    title: 'Some Issue',
    content: { type: 'doc', content: [] },
    visibility: 'workspace',
    created_by: 'user-someone-else',
    properties: {},
    ...overrides,
  };
}

function fakeShipClient(overrides: Partial<ShipClientLike> = {}): ShipClientLike {
  return {
    getChangeFeed: vi.fn(),
    getDocument: vi.fn(),
    getPeople: vi.fn(),
    ...overrides,
  };
}

describe('buildMentionItems — comment-sourced mentions (the FG-3 fixture shape)', () => {
  it('produces exactly one inbox item for a comment mentioning a known person', async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'issue-1',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: "Hey @Alice Chen, can you weigh in on this before we ship? Wasn't sure who owns the final call.",
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'comment:comment-1:2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(doc({ id: 'issue-1', title: 'Rollout plan' })) });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'mention:comment:comment-1:user-alice',
      recipientUserId: 'user-alice',
      type: 'mention',
      evidence: { documentId: 'issue-1', documentType: 'issue', commentId: 'thread-1' },
    });
  });

  it('skips a mentioned person with no linked user account', async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'issue-1',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: '@Alice Chen please review.',
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(doc()) });

    const items = await buildMentionItems(client, feed, [person({ user_id: null, isPending: true })]);

    expect(items).toEqual([]);
  });

  it('skips a mention whose parent document can no longer be fetched', async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'gone-doc',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: '@Alice Chen please review.',
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockRejectedValue(new Error('404')) });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toEqual([]);
  });
});

describe('buildMentionItems — structured TipTap mentions in a document body', () => {
  it('produces one inbox item per person-mention node found in the fetched body', async () => {
    const feed = emptyFeed({
      documents: [
        { id: 'wiki-1', document_type: 'wiki', title: 'Design doc', updated_at: '2026-01-01T00:00:00.000Z', created_by: 'user-emma', dedupe_key: 'x' },
      ],
    });
    const bodyWithMention = doc({
      id: 'wiki-1',
      document_type: 'wiki',
      title: 'Design doc',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'mention', attrs: { id: 'person-alice', mentionType: 'person' } }],
          },
        ],
      },
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(bodyWithMention) });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'mention:document:wiki-1:user-alice',
      recipientUserId: 'user-alice',
      evidence: { documentId: 'wiki-1', documentType: 'wiki' },
    });
  });

  it('never-surface: a mention evidenced only by a document the recipient cannot see is not created', async () => {
    const feed = emptyFeed({
      documents: [
        { id: 'private-doc', document_type: 'wiki', title: 'Private notes', updated_at: '2026-01-01T00:00:00.000Z', created_by: 'user-someone-else', dedupe_key: 'x' },
      ],
    });
    const privateDocWithMention = doc({
      id: 'private-doc',
      document_type: 'wiki',
      visibility: 'private',
      created_by: 'user-someone-else', // NOT the mentioned recipient
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'person-alice', mentionType: 'person' } }] }],
      },
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(privateDocWithMention) });

    const items = await buildMentionItems(client, feed, [person()]); // person() -> user-alice

    expect(items).toEqual([]);
  });

  it('the same private document DOES surface a mention to its own creator', async () => {
    const feed = emptyFeed({
      documents: [
        { id: 'private-doc', document_type: 'wiki', title: 'My notes', updated_at: '2026-01-01T00:00:00.000Z', created_by: 'user-alice', dedupe_key: 'x' },
      ],
    });
    const privateDocWithMention = doc({
      id: 'private-doc',
      document_type: 'wiki',
      visibility: 'private',
      created_by: 'user-alice',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'person-alice', mentionType: 'person' } }] }],
      },
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(privateDocWithMention) });

    const items = await buildMentionItems(client, feed, [person()]);

    expect(items).toHaveLength(1);
  });
});

describe('mention resolution + ItemStore together — proof #1 (no duplicate on re-poll)', () => {
  it('a body edit adding a mention produces exactly one inbox item, and re-polling the same window does not duplicate it', async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'issue-1',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: '@Alice Chen can you weigh in?',
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(doc()) });
    const store = new InMemoryItemStore();

    // First poll.
    const firstItems = await buildMentionItems(client, feed, [person()]);
    for (const item of firstItems) store.upsert(item);

    // Re-poll of the SAME window — the change-feed's own lag/dedupe_key
    // design means an overlapping re-read is expected, not a bug (see
    // change-feed.ts's own docstring). The item store must absorb it.
    const secondItems = await buildMentionItems(client, feed, [person()]);
    for (const item of secondItems) store.upsert(item);

    expect(store.list('user-alice')).toHaveLength(1);
  });
});

describe('buildBlockingApprovalItems — routing decisions', () => {
  const sprintDoc = (props: Record<string, unknown>) =>
    doc({ id: 'sprint-1', document_type: 'sprint', title: "Emma's Week 6", properties: { owner_id: 'user-emma', ...props } });

  it("'changes_requested' routes the item to the OWNER (mirrors accountability.ts's checkChangesRequested)", async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'changes_requested', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(sprintDoc({})) });

    const { items, resolvedIds } = await buildBlockingApprovalItems(client, feed, [person({ id: 'person-emma', user_id: 'user-emma' })]);

    expect(resolvedIds).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.recipientUserId).toBe('user-emma');
    expect(items[0]?.type).toBe('blocking_approval');
  });

  it("a pending/never-reviewed approval (no prior state) routes to the owner's MANAGER", async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: null, approved_by: null }),
          changed_by: 'user-emma',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(sprintDoc({})) });
    const people = [person({ id: 'person-emma', user_id: 'user-emma', reportsTo: 'user-alice' })];

    const { items } = await buildBlockingApprovalItems(client, feed, people);

    expect(items).toHaveLength(1);
    expect(items[0]?.recipientUserId).toBe('user-alice');
  });

  it("'changed_since_approved' also routes to the manager", async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'changed_since_approved', approved_by: 'user-alice' }),
          changed_by: 'user-emma',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(sprintDoc({})) });
    const people = [person({ id: 'person-emma', user_id: 'user-emma', reportsTo: 'user-alice' })];

    const { items } = await buildBlockingApprovalItems(client, feed, people);

    expect(items[0]?.recipientUserId).toBe('user-alice');
  });

  it('degrades gracefully (no item, no throw) when the owner has no manager on record', async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: null, approved_by: null }),
          changed_by: 'user-emma',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(sprintDoc({})) });
    const people = [person({ id: 'person-emma', user_id: 'user-emma', reportsTo: null })];

    const { items } = await buildBlockingApprovalItems(client, feed, people);

    expect(items).toEqual([]);
  });

  it('ignores history fields that are not plan_approval/review_approval', async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'issue-1',
          field: 'state',
          old_value: 'in_progress',
          new_value: 'done',
          changed_by: 'user-emma',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient();

    const { items, resolvedIds } = await buildBlockingApprovalItems(client, feed, []);

    expect(items).toEqual([]);
    expect(resolvedIds).toEqual([]);
    expect(client.getDocument).not.toHaveBeenCalled();
  });

  it('only the latest transition per (document, field) in one window is acted on', async () => {
    const feed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'changes_requested', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
        {
          id: 2,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'approved', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-01T00:05:00.000Z', // later — this is the one that should win
          dedupe_key: 'x',
        },
      ],
    });
    const client = fakeShipClient({ getDocument: vi.fn().mockResolvedValue(sprintDoc({})) });

    const { items, resolvedIds } = await buildBlockingApprovalItems(client, feed, [person({ id: 'person-emma', user_id: 'user-emma' })]);

    expect(items).toEqual([]);
    expect(resolvedIds).toEqual(['blocking-approval:sprint-1:plan_approval']);
  });
});

describe('blocking-approval items + ItemStore — proof #2 (cleared when the condition ends)', () => {
  it('an approved plan clears the previously-written blocking item', async () => {
    const store = new InMemoryItemStore();
    const people = [person({ id: 'person-emma', user_id: 'user-emma' })];
    const client = fakeShipClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'sprint-1', document_type: 'sprint', title: "Emma's Week", properties: { owner_id: 'user-emma' } })
      ),
    });

    // Poll 1: changes requested — item created for the owner.
    const firstFeed = emptyFeed({
      history: [
        {
          id: 1,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'changes_requested', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const first = await buildBlockingApprovalItems(client, firstFeed, people);
    for (const item of first.items) store.upsert(item);
    for (const id of first.resolvedIds) store.clear(id);

    expect(store.list('user-emma')).toHaveLength(1);

    // Poll 2: the owner revised and it's now approved — condition ended.
    const secondFeed = emptyFeed({
      history: [
        {
          id: 2,
          document_id: 'sprint-1',
          field: 'plan_approval',
          old_value: null,
          new_value: JSON.stringify({ state: 'approved', approved_by: 'user-alice' }),
          changed_by: 'user-alice',
          automated_by: null,
          created_at: '2026-01-02T00:00:00.000Z',
          dedupe_key: 'y',
        },
      ],
    });
    const second = await buildBlockingApprovalItems(client, secondFeed, people);
    for (const item of second.items) store.upsert(item);
    for (const id of second.resolvedIds) store.clear(id);

    expect(store.list('user-emma')).toHaveLength(0);
  });
});

describe('pollChangeFeed', () => {
  it('returns the raw feed and its next_cursor', async () => {
    const feed = emptyFeed({ next_cursor: '2026-02-01T00:00:00.000Z' });
    const client = fakeShipClient({ getChangeFeed: vi.fn().mockResolvedValue(feed) });

    const result = await pollChangeFeed(client, '2026-01-01T00:00:00.000Z', 50);

    expect(client.getChangeFeed).toHaveBeenCalledWith('2026-01-01T00:00:00.000Z', 50);
    expect(result).toEqual({ feed, nextCursor: '2026-02-01T00:00:00.000Z' });
  });
});

describe('end-to-end via the compiled graph — proof #3 (timed)', () => {
  it('event on the change feed produces a stored item well within the 5-minute window', async () => {
    const feed = emptyFeed({
      comments: [
        {
          id: 'comment-1',
          document_id: 'issue-1',
          comment_id: 'thread-1',
          parent_id: null,
          author_id: 'user-emma',
          content: '@Alice Chen can you take a look?',
          resolved_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          dedupe_key: 'x',
        },
      ],
    });
    const shipClient = fakeShipClient({
      getChangeFeed: vi.fn().mockResolvedValue(feed),
      getDocument: vi.fn().mockResolvedValue(doc()),
      getPeople: vi.fn().mockResolvedValue([person()]),
    });
    const itemStore = new InMemoryItemStore();
    const model = { invoke: vi.fn() }; // never called on this path — proves it below

    const graph = buildGraph(model, { shipClient, itemStore });

    const startedAt = performance.now();
    await graph.invoke({ trigger: 'proactive_fast', cursor: '2026-01-01T00:00:00.000Z' });
    const elapsedMs = performance.now() - startedAt;

    // Derived, not observed: this measures the graph's own code path under
    // fakes (no real network/model latency) — it proves the mechanism adds
    // no unbounded delay, not the live 60s-cadence end-to-end timing, which
    // the ticket itself says is "graded with a timed live run" (a separate,
    // out-of-unit-test-suite measurement).
    expect(elapsedMs).toBeLessThan(5 * 60 * 1000);
    expect(itemStore.list('user-alice')).toHaveLength(1);
    expect(model.invoke).not.toHaveBeenCalled(); // no model call in this ticket's path
  });
});
