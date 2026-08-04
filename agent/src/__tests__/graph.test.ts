import { describe, expect, it, vi } from 'vitest';
import { buildGraph, NODE_NAMES, type AnthropicModel, type OnDemandDeps } from '../graph.js';
import type { ShipClientLike, ChangeFeedResponse, OnDemandShipClientLike, ShipDocument } from '../shipClient.js';
import { InMemoryItemStore } from '../itemStore.js';

function fakeModel(response: string): AnthropicModel {
  return { invoke: vi.fn().mockResolvedValue({ content: response }) };
}

function emptyFeed(): ChangeFeedResponse {
  return {
    next_cursor: '2026-01-01T00:01:00.000Z',
    documents: [],
    documents_truncated: false,
    history: [],
    history_truncated: false,
    comments: [],
    comments_truncated: false,
  };
}

function fakeShipClient(overrides: Partial<ShipClientLike> = {}): ShipClientLike {
  return {
    getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
    getDocument: vi.fn(),
    getPeople: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('buildGraph', () => {
  it('compiles and exposes every declared node in its node set', () => {
    const compiled = buildGraph(fakeModel('fake reply'));
    const nodeKeys = Object.keys(compiled.nodes);

    for (const name of NODE_NAMES) {
      expect(nodeKeys, `compiled graph should expose node "${name}"`).toContain(name);
    }
  });

  it('runs ingest -> respond against a stable fake model and returns its output — never a live call', async () => {
    const model = fakeModel('the fake model said this');
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: '  what is the status of TRO-313?  ' });

    expect(model.invoke).toHaveBeenCalledTimes(1);
    // ingest trims before respond ever sees it
    expect(model.invoke).toHaveBeenCalledWith('what is the status of TRO-313?');
    expect(result.output).toBe('the fake model said this');
  });

  it('joins array-shaped model content (e.g. multi-block Anthropic responses) into a single string', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({ content: ['part one ', 'part two'] }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('part one part two');
  });

  it('extracts `.text` from a native Anthropic `{ type: "text", text }` block inside an array, rather than JSON.stringify-ing it', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'hello from a real content block' }],
      }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('hello from a real content block');
  });

  it('extracts `.text` from a bare (non-array) native text block too', async () => {
    const model: AnthropicModel = {
      invoke: vi.fn().mockResolvedValue({ content: { type: 'text', text: 'top-level text block' } }),
    };
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: 'hello' });

    expect(result.output).toBe('top-level text block');
  });

  it('propagates a model failure rather than swallowing it', async () => {
    const model: AnthropicModel = { invoke: vi.fn().mockRejectedValue(new Error('model unavailable')) };
    const compiled = buildGraph(model);

    await expect(compiled.invoke({ input: 'hello' })).rejects.toThrow('model unavailable');
  });
});

describe('buildGraph — proactive routing (TRO-317 / FG-5)', () => {
  it('exposes every proactive node in NODE_NAMES on the compiled graph', () => {
    const compiled = buildGraph(fakeModel('unused'), {
      shipClient: fakeShipClient(),
      itemStore: new InMemoryItemStore(),
    });
    const nodeKeys = Object.keys(compiled.nodes);

    for (const name of NODE_NAMES) {
      expect(nodeKeys, `compiled graph should expose node "${name}"`).toContain(name);
    }
  });

  it('an omitted trigger still routes through the unchanged on-demand path (default: on_demand)', async () => {
    const model = fakeModel('reply');
    const compiled = buildGraph(model);

    const result = await compiled.invoke({ input: '  hi  ' });

    expect(model.invoke).toHaveBeenCalledWith('hi');
    expect(result.output).toBe('reply');
  });

  it("trigger: 'proactive_fast' never calls the model and polls the change feed instead", async () => {
    const model = fakeModel('should never be used');
    const shipClient = fakeShipClient();
    const itemStore = new InMemoryItemStore();
    const compiled = buildGraph(model, { shipClient, itemStore });

    await compiled.invoke({ trigger: 'proactive_fast', cursor: '2026-01-01T00:00:00.000Z' });

    expect(model.invoke).not.toHaveBeenCalled();
    expect(shipClient.getChangeFeed).toHaveBeenCalledWith('2026-01-01T00:00:00.000Z', undefined);
  });

  it("trigger: 'proactive_steady' routes to the same node chain as 'proactive_fast'", async () => {
    const shipClient = fakeShipClient();
    const compiled = buildGraph(fakeModel('unused'), { shipClient, itemStore: new InMemoryItemStore() });

    await compiled.invoke({ trigger: 'proactive_steady', cursor: '2026-01-01T00:00:00.000Z' });

    expect(shipClient.getChangeFeed).toHaveBeenCalledTimes(1);
  });

  it('advances the cursor to next_cursor after a successful poll', async () => {
    const shipClient = fakeShipClient({
      getChangeFeed: vi.fn().mockResolvedValue({ ...emptyFeed(), next_cursor: '2026-03-01T00:00:00.000Z' }),
    });
    const compiled = buildGraph(fakeModel('unused'), { shipClient, itemStore: new InMemoryItemStore() });

    const result = await compiled.invoke({ trigger: 'proactive_fast', cursor: '2026-01-01T00:00:00.000Z' });

    expect(result.cursor).toBe('2026-03-01T00:00:00.000Z');
  });

  it('bootstraps a lookback window when no cursor has been carried forward yet', async () => {
    const shipClient = fakeShipClient();
    const now = () => new Date('2026-01-02T00:00:00.000Z');
    const compiled = buildGraph(fakeModel('unused'), {
      shipClient,
      itemStore: new InMemoryItemStore(),
      now,
      initialLookbackMs: 60 * 60 * 1000, // 1h
    });

    await compiled.invoke({ trigger: 'proactive_fast' });

    expect(shipClient.getChangeFeed).toHaveBeenCalledWith('2026-01-01T23:00:00.000Z', undefined);
  });

  it('throws a clear error if a proactive trigger runs without ProactiveDeps, rather than silently no-op-ing', async () => {
    const compiled = buildGraph(fakeModel('unused')); // no proactiveDeps

    await expect(compiled.invoke({ trigger: 'proactive_fast' })).rejects.toThrow(/ProactiveDeps/);
  });

  it('writes resolved mention items into the injected ItemStore', async () => {
    const shipClient = fakeShipClient({
      getChangeFeed: vi.fn().mockResolvedValue({
        ...emptyFeed(),
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
      }),
      getDocument: vi.fn().mockResolvedValue({
        id: 'issue-1',
        document_type: 'issue',
        title: 'Some issue',
        content: null,
        visibility: 'workspace',
        created_by: 'user-emma',
        properties: {},
      }),
      getPeople: vi.fn().mockResolvedValue([
        {
          id: 'person-alice',
          user_id: 'user-alice',
          name: 'Alice Chen',
          email: null,
          isArchived: false,
          isPending: false,
          reportsTo: null,
          role: null,
        },
      ]),
    });
    const itemStore = new InMemoryItemStore();
    const compiled = buildGraph(fakeModel('unused'), { shipClient, itemStore });

    await compiled.invoke({ trigger: 'proactive_fast', cursor: '2026-01-01T00:00:00.000Z' });

    expect(itemStore.list('user-alice')).toHaveLength(1);
  });
});

describe('buildGraph — on-demand expansion (TRO-318 / FG-7)', () => {
  /**
   * Fixture ids/titles below are REAL rows in this worktree's seeded dev
   * database (`pnpm db:seed`'s FG-3 fixture block — verified by querying
   * `ship_wt_tro_327` directly, not guessed): the stale issue is
   * `testCase1_stale`, its week is `testCase3_week` (the two happen to be
   * the same sprint — both derive from `currentShipCoreSprint`), the
   * "assigned to the same person" issue is `testCase1_commented` (its real
   * seeded comment is reproduced verbatim below), and the related issue is
   * `testCase3_closedIssues[0]`, which really does share that same week in
   * the seed. `ShipClientLike`/`OnDemandShipClientLike` are still FAKES
   * here (per TRO-313's own testing contract — no live DB or HTTP call from
   * this test), but every id/title/comment is grounded in real seeded data
   * rather than synthetic placeholders, per TRO-318's own guidance.
   *
   * No live model call either: `ANTHROPIC_API_KEY` is not set anywhere in
   * this worktree (checked `.env`, `.env.local`, `agent/.env.example` — no
   * real key present), so — same posture as FG-5 and FG-2 before it — this
   * uses a stable fake `AnthropicModel` rather than a recorded live
   * response.
   */
  const STALE_ISSUE_ID = '9f770f55-f332-424e-9b9e-00d3efcf1dad'; // "Implement burndown chart"
  const WEEK_ID = '100414f1-b1fa-4b3c-a853-b599664f7cd1'; // "Week 14"
  const COMMENTED_ISSUE_ID = '8c8ec6b1-6bd9-4904-972d-970526027883'; // "Create sprint retrospective view"
  const RELATED_ISSUE_ID = 'ce9b7f33-9916-40eb-a540-3971eef5acb2'; // "Implement sprint management"
  const EMMA_USER_ID = '0c472094-0746-4c41-95c2-d2c2e2a5aac6'; // Emma Johnson

  function fixtureDoc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
    return {
      document_type: 'issue',
      content: null,
      visibility: 'workspace',
      created_by: null,
      properties: {},
      ...overrides,
    };
  }

  /** Builds the fake client for the four-citation scenario: seed -> its
   * week (forward `sprint`) and Emma's other work (assignee); the week ->
   * a sibling issue in the same week (reverse `sprint`); the sibling and
   * the "other work" issue both being dead ends (no further candidates). */
  function fourCitationClient(): OnDemandShipClientLike {
    const docsById: Record<string, ShipDocument> = {
      [STALE_ISSUE_ID]: fixtureDoc({
        id: STALE_ISSUE_ID,
        title: 'Implement burndown chart',
        properties: { assignee_id: EMMA_USER_ID, state: 'todo' },
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Burndown chart work has not moved in a week.' }] }] },
      }),
      [WEEK_ID]: fixtureDoc({ id: WEEK_ID, title: 'Week 14', document_type: 'sprint' }),
      [COMMENTED_ISSUE_ID]: fixtureDoc({
        id: COMMENTED_ISSUE_ID,
        title: 'Create sprint retrospective view',
        properties: { assignee_id: EMMA_USER_ID, state: 'in_progress' },
      }),
      [RELATED_ISSUE_ID]: fixtureDoc({
        id: RELATED_ISSUE_ID,
        title: 'Implement sprint management',
        properties: { assignee_id: 'other-user', state: 'done' },
      }),
    };

    return {
      getDocument: vi.fn(async (id: string) => {
        const doc = docsById[id];
        if (!doc) throw new Error(`404: ${id}`);
        return doc;
      }),
      getAssociations: vi.fn(async (id: string) =>
        id === STALE_ISSUE_ID ? [{ related_id: WEEK_ID, relationship_type: 'sprint' }] : []
      ),
      getReverseAssociations: vi.fn(async (id: string) =>
        id === WEEK_ID ? [{ document_id: RELATED_ISSUE_ID, relationship_type: 'sprint' }] : []
      ),
      getBacklinks: vi.fn().mockResolvedValue([]),
      getComments: vi.fn(async (id: string) =>
        id === COMMENTED_ISSUE_ID
          ? [
              {
                id: 'comment-1',
                content: 'Making progress on Create sprint retrospective view — should land by end of week.',
                author: { id: EMMA_USER_ID, name: 'Emma Johnson', email: 'emma.johnson@ship.local' },
                created_at: '2026-08-03T13:30:05.099Z',
                resolved_at: null,
              },
            ]
          : []
      ),
      getIssuesByAssignee: vi.fn(async (assigneeUserId: string) =>
        assigneeUserId === EMMA_USER_ID
          ? [{ id: COMMENTED_ISSUE_ID, title: 'Create sprint retrospective view', state: 'in_progress', updated_at: '2026-08-03T00:00:00.000Z' }]
          : []
      ),
    };
  }

  it(
    'proof #1: answers a question about a stalled issue citing its week, its related issue, and ' +
      'a comment on a different document — four named sources with reasons',
    async () => {
      const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'It looks stalled because nobody has touched it in a week.' }) };
      const onDemandDeps: OnDemandDeps = { shipClient: fourCitationClient(), documentCap: 4 };
      const compiled = buildGraph(model, undefined, onDemandDeps);

      const result = await compiled.invoke({
        trigger: 'on_demand',
        input: 'Why is this issue stalled?',
        seedDocumentId: STALE_ISSUE_ID,
        askingUserId: EMMA_USER_ID,
      });

      expect(result.citedSources).toHaveLength(4);
      expect(result.citedSources.map((s) => s.documentId).sort()).toEqual(
        [STALE_ISSUE_ID, WEEK_ID, COMMENTED_ISSUE_ID, RELATED_ISSUE_ID].sort()
      );

      const seedCitation = result.citedSources.find((s) => s.documentId === STALE_ISSUE_ID);
      expect(seedCitation).toMatchObject({ title: 'Implement burndown chart', reason: 'the document you had open' });

      const weekCitation = result.citedSources.find((s) => s.documentId === WEEK_ID);
      expect(weekCitation).toMatchObject({ title: 'Week 14', documentType: 'sprint' });
      expect(weekCitation?.reason).toContain('week');

      const relatedCitation = result.citedSources.find((s) => s.documentId === RELATED_ISSUE_ID);
      expect(relatedCitation).toMatchObject({ title: 'Implement sprint management' });

      const commentedCitation = result.citedSources.find((s) => s.documentId === COMMENTED_ISSUE_ID);
      expect(commentedCitation).toMatchObject({ title: 'Create sprint retrospective view' });

      // The comment itself is carried as evidence on the document that holds
      // it — a DIFFERENT document from the seed — not reconstructed after
      // the fact from a log.
      const commentedRecord = result.expandedDocuments.find((d) => d.documentId === COMMENTED_ISSUE_ID);
      expect(commentedRecord?.commentSnippets).toEqual([
        'Emma Johnson: Making progress on Create sprint retrospective view — should land by end of week.',
      ]);

      // The model was given every citation's title and reason in its prompt.
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Implement burndown chart');
      expect(prompt).toContain('Week 14');
      expect(prompt).toContain('Implement sprint management');
      expect(prompt).toContain('Create sprint retrospective view');
      expect(prompt).toContain('Making progress on Create sprint retrospective view');

      expect(result.output).toContain('It looks stalled');
      expect(result.expansionCapped).toBe(false);
    }
  );

  it('proof #2: a seed in a dense neighbourhood never pulls in more than the configured cap, and says so', async () => {
    const DENSE_SEED = 'seed-dense';
    const relatedIds = Array.from({ length: 10 }, (_, i) => `related-${i}`);

    const client: OnDemandShipClientLike = {
      getDocument: vi.fn(async (id: string) => {
        if (id === DENSE_SEED) return fixtureDoc({ id: DENSE_SEED, title: 'A very connected document' });
        if (relatedIds.includes(id)) return fixtureDoc({ id, title: `Related ${id}` });
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string) =>
        id === DENSE_SEED ? relatedIds.map((relatedId) => ({ related_id: relatedId, relationship_type: 'project' })) : []
      ),
      getReverseAssociations: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      getComments: vi.fn().mockResolvedValue([]),
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
    };

    const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'Summary.' }) };
    const onDemandDeps: OnDemandDeps = { shipClient: client, documentCap: 3 };
    const compiled = buildGraph(model, undefined, onDemandDeps);

    const result = await compiled.invoke({ trigger: 'on_demand', input: 'What is going on here?', seedDocumentId: DENSE_SEED });

    // Never exceeds the cap — 10 real candidates existed, only `documentCap`
    // (3, including the seed) were ever pulled in.
    expect(result.expandedDocuments).toHaveLength(3);
    expect(result.citedSources).toHaveLength(3);
    expect(result.expansionCapped).toBe(true);
    // Says so rather than truncating silently.
    expect(result.output).toContain('3-document limit');
  });

  it('proof #3: a document a related-document a token cannot see is absent from both the answer and the citation list', async () => {
    const SEED_ID = 'seed-visible';
    const VISIBLE_RELATED_ID = 'visible-related';
    const PRIVATE_RELATED_ID = 'private-related';
    const ASKER_ID = 'asker-user';

    const client: OnDemandShipClientLike = {
      getDocument: vi.fn(async (id: string) => {
        if (id === SEED_ID) return fixtureDoc({ id: SEED_ID, title: 'Team status' });
        if (id === VISIBLE_RELATED_ID) return fixtureDoc({ id: VISIBLE_RELATED_ID, title: 'Week 9', document_type: 'sprint' });
        if (id === PRIVATE_RELATED_ID) {
          // Simulates the leak `associations.ts`'s forward/reverse routes are
          // capable of (they check access on the ANCHOR document only, never
          // on each joined related document) — the id and title reach this
          // far, but the document itself is private and NOT owned by the
          // asker. `passesAskerVisibility` (reusing FG-5's own
          // `isDocumentVisibleTo`) is what has to catch this, not a 404.
          return fixtureDoc({ id: PRIVATE_RELATED_ID, title: 'Confidential compensation review', visibility: 'private', created_by: 'someone-else' });
        }
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string) =>
        id === SEED_ID
          ? [
              { related_id: VISIBLE_RELATED_ID, relationship_type: 'sprint' },
              { related_id: PRIVATE_RELATED_ID, relationship_type: 'project' },
            ]
          : []
      ),
      getReverseAssociations: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      getComments: vi.fn().mockResolvedValue([]),
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
    };

    const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'Here is what is going on.' }) };
    const onDemandDeps: OnDemandDeps = { shipClient: client, documentCap: 5 };
    const compiled = buildGraph(model, undefined, onDemandDeps);

    const result = await compiled.invoke({
      trigger: 'on_demand',
      input: 'What is going on with the team this week?',
      seedDocumentId: SEED_ID,
      askingUserId: ASKER_ID,
    });

    const citedIds = result.citedSources.map((s) => s.documentId);
    expect(citedIds).toContain(VISIBLE_RELATED_ID);
    expect(citedIds).not.toContain(PRIVATE_RELATED_ID);

    const expandedIds = result.expandedDocuments.map((d) => d.documentId);
    expect(expandedIds).not.toContain(PRIVATE_RELATED_ID);

    // Attempted (so it is never retried via a second edge), but never
    // pulled in.
    expect(result.visitedDocumentIds).toContain(PRIVATE_RELATED_ID);

    const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain('Confidential compensation review');
    expect(result.output).not.toContain('Confidential compensation review');
  });

  it('throws a clear error if on_demand carries a seedDocumentId but no OnDemandDeps, rather than silently skipping expansion', async () => {
    const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'unused' }) };
    const compiled = buildGraph(model); // no onDemandDeps

    await expect(
      compiled.invoke({ trigger: 'on_demand', input: 'hi', seedDocumentId: 'doc-1' })
    ).rejects.toThrow(/OnDemandDeps/);
  });

  it('a bare on_demand question with no seedDocumentId still uses ingest -> respond even when OnDemandDeps IS supplied', async () => {
    const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'plain reply' }) };
    const shipClient: OnDemandShipClientLike = {
      getDocument: vi.fn(),
      getAssociations: vi.fn(),
      getReverseAssociations: vi.fn(),
      getBacklinks: vi.fn(),
      getComments: vi.fn(),
      getIssuesByAssignee: vi.fn(),
    };
    const compiled = buildGraph(model, undefined, { shipClient, documentCap: 10 });

    const result = await compiled.invoke({ trigger: 'on_demand', input: '  no seed here  ' });

    expect(model.invoke).toHaveBeenCalledWith('no seed here');
    expect(result.output).toBe('plain reply');
    expect(shipClient.getDocument).not.toHaveBeenCalled();
    expect(result.citedSources).toEqual([]);
  });
});
