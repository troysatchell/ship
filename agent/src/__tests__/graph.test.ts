import { describe, expect, it, vi } from 'vitest';
import { buildGraph, NODE_NAMES, type AnthropicModel, type DeepDeps, type OnDemandDeps } from '../graph.js';
import type { ChangeFeedResponse, DeepShipClientLike, OnDemandShipClientLike, ShipClientLike, ShipDocument } from '../shipClient.js';
import { InMemoryItemStore } from '../itemStore.js';
import { InMemoryDraftStore } from '../draftStore.js';

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
      const onDemandDeps: OnDemandDeps = { shipClientFactory: () => fourCitationClient(), documentCap: 4 };
      const compiled = buildGraph(model, undefined, onDemandDeps);

      const result = await compiled.invoke({
        trigger: 'on_demand',
        input: 'Why is this issue stalled?',
        seedDocumentId: STALE_ISSUE_ID,
        askingUserId: EMMA_USER_ID,
        askingUserToken: 'emma-token',
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
    const onDemandDeps: OnDemandDeps = { shipClientFactory: () => client, documentCap: 3 };
    const compiled = buildGraph(model, undefined, onDemandDeps);

    const result = await compiled.invoke({
      trigger: 'on_demand',
      input: 'What is going on here?',
      seedDocumentId: DENSE_SEED,
      askingUserToken: 'asker-token',
    });

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
    const onDemandDeps: OnDemandDeps = { shipClientFactory: () => client, documentCap: 5 };
    const compiled = buildGraph(model, undefined, onDemandDeps);

    const result = await compiled.invoke({
      trigger: 'on_demand',
      input: 'What is going on with the team this week?',
      seedDocumentId: SEED_ID,
      askingUserId: ASKER_ID,
      askingUserToken: 'asker-token',
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
    // Never invoked either — a bare question routes straight into
    // ingest -> respond without ever calling resolveSeed, so nothing here
    // ever asks for a client, let alone a token (TRO-342).
    const shipClientFactory = vi.fn().mockReturnValue(shipClient);
    const compiled = buildGraph(model, undefined, { shipClientFactory, documentCap: 10 });

    const result = await compiled.invoke({ trigger: 'on_demand', input: '  no seed here  ' });

    expect(model.invoke).toHaveBeenCalledWith('no seed here');
    expect(shipClientFactory).not.toHaveBeenCalled();
    expect(result.output).toBe('plain reply');
    expect(shipClient.getDocument).not.toHaveBeenCalled();
    expect(result.citedSources).toEqual([]);
  });

  describe('per-requesting-user Ship tokens (TRO-342)', () => {
    /**
     * Before TRO-342, `OnDemandDeps.shipClient` was ONE bound-token
     * `ShipClient` instance, built once at process startup from the
     * agent's own `SHIP_API_TOKEN` env var — the SAME instance backed every
     * on-demand invocation, regardless of who asked. That contradicted
     * FLEETGRAPH.MD's "no service account" argument on the read side, even
     * though FG-8's write gate (`gate.ts`) already got this right.
     *
     * `shipClientFactory` is what closes that: `resolveSeed`/`expandFrontier`
     * resolve a client from `state.askingUserToken` on EVERY invocation,
     * never a value fixed at `buildGraph()` time. These two tests prove
     * that directly, rather than trusting the field rename alone.
     */
    it('resolves the client from THIS invocation\'s own askingUserToken — two different askers never share a client', async () => {
      const aliceClient = fourCitationClient();
      const bobDoc = fixtureDoc({ id: 'bob-seed', title: "Bob's own document" });
      const bobClient: OnDemandShipClientLike = {
        getDocument: vi.fn().mockResolvedValue(bobDoc),
        getAssociations: vi.fn().mockResolvedValue([]),
        getReverseAssociations: vi.fn().mockResolvedValue([]),
        getBacklinks: vi.fn().mockResolvedValue([]),
        getComments: vi.fn().mockResolvedValue([]),
        getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      };
      const shipClientFactory = vi.fn((token: string) => (token === 'alice-token' ? aliceClient : bobClient));
      const onDemandDeps: OnDemandDeps = { shipClientFactory, documentCap: 4 };
      const model: AnthropicModel = { invoke: vi.fn().mockResolvedValue({ content: 'answer' }) };

      const aliceResult = await buildGraph(model, undefined, onDemandDeps).invoke({
        trigger: 'on_demand',
        input: 'q1',
        seedDocumentId: STALE_ISSUE_ID,
        askingUserId: 'alice',
        askingUserToken: 'alice-token',
      });
      const bobResult = await buildGraph(model, undefined, onDemandDeps).invoke({
        trigger: 'on_demand',
        input: 'q2',
        seedDocumentId: 'bob-seed',
        askingUserId: 'bob',
        askingUserToken: 'bob-token',
      });

      expect(shipClientFactory).toHaveBeenCalledWith('alice-token');
      expect(shipClientFactory).toHaveBeenCalledWith('bob-token');
      // Alice's run only ever touched alice's client...
      expect(aliceClient.getDocument).toHaveBeenCalledWith(STALE_ISSUE_ID);
      expect(bobClient.getDocument).not.toHaveBeenCalledWith(STALE_ISSUE_ID);
      // ...and Bob's run only ever touched Bob's — never crossed over.
      expect(bobClient.getDocument).toHaveBeenCalledWith('bob-seed');
      expect(aliceClient.getDocument).not.toHaveBeenCalledWith('bob-seed');
      expect(aliceResult.citedSources.map((s) => s.documentId)).toContain(STALE_ISSUE_ID);
      expect(bobResult.citedSources.map((s) => s.documentId)).toEqual(['bob-seed']);
    });

    it('throws a clear error — and never even calls shipClientFactory — when a seeded on_demand run carries no askingUserToken', async () => {
      const shipClientFactory = vi.fn().mockReturnValue(fourCitationClient());
      const onDemandDeps: OnDemandDeps = { shipClientFactory, documentCap: 4 };
      const model: AnthropicModel = { invoke: vi.fn() };
      const compiled = buildGraph(model, undefined, onDemandDeps);

      await expect(
        compiled.invoke({
          trigger: 'on_demand',
          input: 'hi',
          seedDocumentId: STALE_ISSUE_ID,
          askingUserId: EMMA_USER_ID,
          // no askingUserToken
        })
      ).rejects.toThrow(/askingUserToken/);

      expect(shipClientFactory).not.toHaveBeenCalled();
      expect(model.invoke).not.toHaveBeenCalled();
    });
  });
});

describe('buildGraph — deep tier draft composition (TRO-319 / FG-6)', () => {
  /**
   * Fixture ids/titles/values below are REAL rows in this worktree's seeded
   * dev database (`pnpm db:seed`'s FG-3 "Test Case 1" fixture block — see
   * `standupDraft.test.ts`'s own header comment for how these were
   * verified). `DeepShipClientLike` is a FAKE here — same "never a live
   * call" posture as every other describe block in this file; `model` is a
   * stable fake for the same reason (no `ANTHROPIC_API_KEY` anywhere in
   * this worktree — checked again for this ticket).
   */
  const EMMA_USER_ID = '6e6d2906-6e53-4a8c-a166-ca3661029363';
  const STANDUP_ID = 'bf55a6c9-83ba-498f-9778-ae7697ea1bdb';
  const ANCHOR_ISO = '2026-08-01T14:34:49.637Z';
  const MOVED_ISSUE_ID = '9c862982-c6a0-4795-b710-05da50a94623'; // "Build issue assignment flow"
  const COMMENTED_ISSUE_ID = '09f9b549-e60f-434b-b741-6ca78a507d65'; // "Create sprint retrospective view"
  const STALE_ISSUE_ID = '2bea5768-22fa-4c33-bdfa-fc500819f0ea'; // "Implement burndown chart"

  function fakeDeepShipClient(overrides: Partial<DeepShipClientLike> = {}): DeepShipClientLike {
    return {
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
      getAssociations: vi.fn().mockResolvedValue([]),
      getDocument: vi.fn(),
      listDocuments: vi.fn().mockResolvedValue([
        { id: STANDUP_ID, document_type: 'standup', properties: { author_id: EMMA_USER_ID }, created_at: ANCHOR_ISO, updated_at: ANCHOR_ISO },
      ]),
      ...overrides,
    };
  }

  function testCase1Client(): DeepShipClientLike {
    return fakeDeepShipClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([
        { id: MOVED_ISSUE_ID, title: 'Build issue assignment flow', state: 'in_review', updated_at: '2026-08-03T14:34:49.638Z' },
        { id: COMMENTED_ISSUE_ID, title: 'Create sprint retrospective view', state: 'in_progress', updated_at: '2026-08-03T14:34:49.639Z' },
        { id: STALE_ISSUE_ID, title: 'Implement burndown chart', state: 'todo', updated_at: '2026-07-28T14:34:49.640Z' },
      ]),
      getChangeFeed: vi.fn().mockResolvedValue({
        ...emptyFeed(),
        history: [
          {
            id: 212,
            document_id: MOVED_ISSUE_ID,
            field: 'state',
            old_value: 'in_progress',
            new_value: 'in_review',
            changed_by: EMMA_USER_ID,
            automated_by: null,
            created_at: '2026-08-03T14:34:49.638Z',
            dedupe_key: 'history:212',
          },
        ],
        comments: [
          {
            id: 'efa909fd-3ec8-421b-967d-9665ef3031be',
            document_id: COMMENTED_ISSUE_ID,
            comment_id: '06b7f1da-478d-4c6b-9414-40cac3dfbda6',
            parent_id: null,
            author_id: EMMA_USER_ID,
            content: 'Making progress on Create sprint retrospective view — should land by end of week.',
            resolved_at: null,
            created_at: '2026-08-03T14:34:49.639Z',
            updated_at: '2026-08-03T14:34:49.639Z',
            dedupe_key: 'comment:efa909fd',
          },
        ],
      }),
    });
  }

  function deps(overrides: Partial<DeepDeps> = {}): DeepDeps {
    return {
      shipClient: testCase1Client(),
      itemStore: new InMemoryItemStore(),
      draftStore: new InMemoryDraftStore(),
      now: () => new Date('2026-08-04T14:34:49.641Z'),
      ...overrides,
    };
  }

  it('exposes every deep-tier node in NODE_NAMES on the compiled graph', () => {
    expect(NODE_NAMES).toEqual(
      expect.arrayContaining(['gatherStandupActivity', 'composeStandupDraft', 'commitStandupDraft'])
    );
  });

  it('throws a clear error if a proactive_deep trigger runs without DeepDeps, rather than silently no-op-ing', async () => {
    const compiled = buildGraph(fakeModel('unused'));

    await expect(
      compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID })
    ).rejects.toThrow(/DeepDeps/);
  });

  it('throws a clear error if proactive_deep runs without targetPersonUserId, rather than guessing a recipient', async () => {
    const compiled = buildGraph(fakeModel('unused'), undefined, undefined, deps());

    await expect(compiled.invoke({ trigger: 'proactive_deep' })).rejects.toThrow(/targetPersonUserId/);
  });

  describe('Test Case 1 — 3 assigned issues: one moved, one commented, one stale (proof #1)', () => {
    it('composes a draft, attaches a proposed transition with evidence on the moved issue, and never calls the model with a live key', async () => {
      const model = fakeModel('DRAFT: I moved "Build issue assignment flow" to In Review...');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      // The prompt handed to the model names both issues that had activity
      // and flags the third with its age — TRO-319 proof #1, verified at
      // the prompt-content level (the model itself is a stable fake).
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Build issue assignment flow');
      expect(prompt).toContain('Create sprint retrospective view');
      expect(prompt).toContain('Implement burndown chart');
      expect(prompt).toContain('7 days');

      expect(result.standupProposedTransitions).toEqual([
        {
          issueId: MOVED_ISSUE_ID,
          issueTitle: 'Build issue assignment flow',
          field: 'state',
          fromState: 'in_progress',
          toState: 'in_review',
          evidence: { kind: 'history', changedAt: '2026-08-03T14:34:49.638Z', changedBy: EMMA_USER_ID },
        },
      ]);

      // The draft is stored, never posted — retrievable via DraftStore only.
      const items = itemStore.list(EMMA_USER_ID);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item.type).toBe('standup_draft');
      expect(item.draftId).toBeDefined();

      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('DRAFT: I moved "Build issue assignment flow" to In Review...');
      expect(stored?.proposedTransitions).toHaveLength(1);
      expect(stored?.status).toBe('unseen');
    });

    it('re-invoking the same window is an upsert — no duplicate draft or item', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const sharedDeps = deps({ itemStore, draftStore });
      const compiled = buildGraph(fakeModel('draft text'), undefined, undefined, sharedDeps);

      await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });
      await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      expect(itemStore.list(EMMA_USER_ID)).toHaveLength(1);
      expect(draftStore.listForPerson(EMMA_USER_ID)).toHaveLength(1);
    });
  });

  describe('Zero-activity case (proof #2)', () => {
    it('states nothing moved rather than inventing content, for a person with no assigned issues', async () => {
      const model = fakeModel('Nothing moved since your last standup.');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const client = fakeDeepShipClient({ getIssuesByAssignee: vi.fn().mockResolvedValue([]) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client, itemStore, draftStore }));

      await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Nothing moved in this window');
      expect(prompt).not.toContain('Build issue assignment flow'); // no invented activity

      const items = itemStore.list(EMMA_USER_ID);
      const item = items[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item.summary).toContain('nothing moved');

      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.proposedTransitions).toEqual([]);
    });
  });

  describe('Proof #3 — the draft is never posted by the agent and never attributed to the person', () => {
    it('DeepShipClientLike exposes only read methods — there is no write method for this path to call', async () => {
      const client = testCase1Client();
      // Every method on the fake is one of the five reads DeepShipClientLike
      // declares; nothing resembling create/update/post/apply exists on it
      // to call even by mistake (enforced structurally by the TYPE, not by
      // this assertion — this just documents the surface actually used).
      expect(Object.keys(client).sort()).toEqual(
        ['getAssociations', 'getChangeFeed', 'getDocument', 'getIssuesByAssignee', 'listDocuments'].sort()
      );
    });

    it('the drafted text is retrievable ONLY from DraftStore — commitStandupDraft never calls a document-writing endpoint', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(fakeModel('a private draft'), undefined, undefined, deps({ itemStore, draftStore }));

      await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      // The InboxItem is a lightweight pointer — the actual prose lives only
      // in DraftStore, never duplicated onto anything Ship-visible.
      const item = itemStore.list(EMMA_USER_ID)[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item).not.toHaveProperty('draftText');
      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('a private draft');
    });
  });

  describe('Waste control — 14 days of ignored drafts stops generation (proof #4)', () => {
    it('skips the model call entirely and writes nothing when the person has ignored their last 14+ days of drafts', async () => {
      // A single SHARED clock — both DraftStore's internal age-math and the
      // graph's own `deps.now` must agree on "now," or `shouldGenerateDraftFor`
      // measures the streak's age against the wrong instant.
      let now = new Date('2026-08-01T00:00:00.000Z');
      const draftStore = new InMemoryDraftStore(() => now);
      draftStore.upsert({
        id: 'standup-draft:pre-existing:2026-08-01',
        personUserId: EMMA_USER_ID,
        windowDate: '2026-08-01',
        draftText: 'an old ignored draft',
        proposedTransitions: [],
      });
      // Never viewed/dismissed — 15 days later this is an unbroken ignored run.
      now = new Date('2026-08-16T00:00:00.000Z');

      const model = fakeModel('should never be called');
      const itemStore = new InMemoryItemStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore, now: () => now }));

      const result = await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.standupDraftText).toBeUndefined();
      expect(itemStore.list(EMMA_USER_ID)).toHaveLength(0);
      // The old draft is untouched, not deleted — "let them ask" (the
      // ticket's own words), not "erase the record."
      expect(draftStore.get('standup-draft:pre-existing:2026-08-01')).toBeDefined();
    });

    it('resumes generating once the person interacts with a draft (the streak resets)', async () => {
      let now = new Date('2026-08-01T00:00:00.000Z');
      const draftStore = new InMemoryDraftStore(() => now);
      const old = draftStore.upsert({
        id: 'standup-draft:pre-existing:2026-08-01',
        personUserId: EMMA_USER_ID,
        windowDate: '2026-08-01',
        draftText: 'an old draft the person actually looked at',
        proposedTransitions: [],
      });
      draftStore.markViewed(old.id);
      now = new Date('2026-08-16T00:00:00.000Z');

      const model = fakeModel('a fresh draft');
      const itemStore = new InMemoryItemStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore, now: () => now }));

      await compiled.invoke({ trigger: 'proactive_deep', targetPersonUserId: EMMA_USER_ID });

      expect(model.invoke).toHaveBeenCalledTimes(1);
      expect(itemStore.list(EMMA_USER_ID)).toHaveLength(1);
    });
  });
});

describe('buildGraph — blocker escalation fan-out (TRO-346/TRO-337 / FG-19)', () => {
  /**
   * Synthetic fixture (not real seeded DB rows) — same posture as the
   * on-demand expansion describe block above (`seed-dense`/`seed-visible`),
   * because this describe block, like that one, never makes a live call;
   * only the deep-tier standup describe block above needs real ids (it
   * verifies its prompt content against a real fixture's exact facts).
   *
   * Org chart: engineer-a reports to manager-x; engineer-b reports to
   * manager-y; both manager-x and manager-y report to director-1 — mirrors
   * FLEETGRAPH.MD Test Case 5 exactly ("An issue in Project A blocking two
   * issues in Project B whose assignees report to different managers").
   */
  const BLOCKER_ISSUE_ID = 'blocker-issue-1';
  const PROJECT_A_ID = 'project-a';
  const PROJECT_B_ID = 'project-b';
  const BLOCKED_ISSUE_1 = 'blocked-issue-1';
  const BLOCKED_ISSUE_2 = 'blocked-issue-2';
  const ENGINEER_A = 'user-engineer-a';
  const ENGINEER_B = 'user-engineer-b';
  const MANAGER_X = 'user-manager-x';
  const MANAGER_Y = 'user-manager-y';
  const DIRECTOR_1 = 'user-director-1';

  function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
    return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
  }

  function person(userId: string, reportsTo: string | null) {
    return { id: `person-doc:${userId}`, user_id: userId, name: userId, email: null, isArchived: false, isPending: false, reportsTo, role: null };
  }

  function differentManagersPeople() {
    return [
      person(ENGINEER_A, MANAGER_X),
      person(ENGINEER_B, MANAGER_Y),
      person(MANAGER_X, DIRECTOR_1),
      person(MANAGER_Y, DIRECTOR_1),
      person(DIRECTOR_1, null),
    ];
  }

  function testCase5Client(overrides: Partial<DeepShipClientLike> = {}): DeepShipClientLike {
    return {
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
      listDocuments: vi.fn().mockResolvedValue([]),
      getPeople: vi.fn().mockResolvedValue(differentManagersPeople()),
      getDocument: vi.fn(async (id: string) => {
        if (id === BLOCKER_ISSUE_ID) return doc({ id: BLOCKER_ISSUE_ID, title: 'Vendor API is down' });
        if (id === PROJECT_A_ID) return doc({ id: PROJECT_A_ID, title: 'Project A', document_type: 'project' });
        if (id === PROJECT_B_ID) return doc({ id: PROJECT_B_ID, title: 'Project B', document_type: 'project' });
        if (id === BLOCKED_ISSUE_1) return doc({ id: BLOCKED_ISSUE_1, title: 'Ship the checkout flow', properties: { assignee_id: ENGINEER_A } });
        if (id === BLOCKED_ISSUE_2) return doc({ id: BLOCKED_ISSUE_2, title: 'Wire up billing', properties: { assignee_id: ENGINEER_B } });
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string, type?: string) => {
        if (id === BLOCKER_ISSUE_ID && type === 'project') return [{ related_id: PROJECT_A_ID, relationship_type: 'project' }];
        if (id === BLOCKER_ISSUE_ID && type === 'blocks') {
          return [
            { related_id: BLOCKED_ISSUE_1, relationship_type: 'blocks' },
            { related_id: BLOCKED_ISSUE_2, relationship_type: 'blocks' },
          ];
        }
        if ((id === BLOCKED_ISSUE_1 || id === BLOCKED_ISSUE_2) && type === 'project') {
          return [{ related_id: PROJECT_B_ID, relationship_type: 'project' }];
        }
        return [];
      }),
      ...overrides,
    };
  }

  function deps(overrides: Partial<DeepDeps> = {}): DeepDeps {
    return {
      shipClient: testCase5Client(),
      itemStore: new InMemoryItemStore(),
      draftStore: new InMemoryDraftStore(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('exposes every blocker-escalation node in NODE_NAMES on the compiled graph', () => {
    expect(NODE_NAMES).toEqual(
      expect.arrayContaining(['detectBlockerFanout', 'composeBlockerEscalation', 'commitBlockerEscalation'])
    );
  });

  it('throws a clear error if a proactive_escalation trigger runs without DeepDeps, rather than silently no-op-ing', async () => {
    const compiled = buildGraph(fakeModel('unused'));

    await expect(
      compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID })
    ).rejects.toThrow(/DeepDeps/);
  });

  it('throws a clear error if proactive_escalation runs without blockingIssueId, rather than guessing which issue', async () => {
    const compiled = buildGraph(fakeModel('unused'), undefined, undefined, deps());

    await expect(compiled.invoke({ trigger: 'proactive_escalation' })).rejects.toThrow(/blockingIssueId/);
  });

  describe('Test Case 5 — cross-project fan-out with different managers (proof: fan-out + LCA + draft)', () => {
    it('computes the correct fan-out, the correct lowest common manager, and drafts a message routed to them', async () => {
      const model = fakeModel('DRAFT: "Vendor API is down" is blocking checkout and billing work...');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      // The full impact fan-out: which issues, which projects, which people.
      expect(result.blockerFanoutImpact?.blockedIssues).toHaveLength(2);
      expect(result.blockerFanoutImpact?.distinctProjectIds.sort()).toEqual([PROJECT_A_ID, PROJECT_B_ID]);
      expect(result.blockerFanoutImpact?.blockedPeopleUserIds.sort()).toEqual([ENGINEER_A, ENGINEER_B].sort());

      // The correct lowest common manager — director-1, not either direct manager.
      expect(result.blockerEscalationManager).toEqual({ managerUserId: DIRECTOR_1, reason: 'found' });
      expect(result.blockerEscalationSkipReason).toBeUndefined();

      // The model was given the real fan-out facts.
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('Vendor API is down');
      expect(prompt).toContain('Ship the checkout flow');
      expect(prompt).toContain('Wire up billing');

      // A drafted message, routed to the lowest common manager, never sent.
      const items = itemStore.list(DIRECTOR_1);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item.type).toBe('blocker_escalation');
      expect(item.draftId).toBeDefined();

      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('DRAFT: "Vendor API is down" is blocking checkout and billing work...');
      expect(stored?.status).toBe('unseen');
      expect(stored?.personUserId).toBe(DIRECTOR_1);
    });

    it('re-invoking for the same issue on the same day is an upsert — no duplicate draft or item', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const sharedDeps = deps({ itemStore, draftStore });
      const compiled = buildGraph(fakeModel('draft text'), undefined, undefined, sharedDeps);

      await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });
      await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      expect(itemStore.list(DIRECTOR_1)).toHaveLength(1);
      expect(draftStore.listForPerson(DIRECTOR_1)).toHaveLength(1);
    });
  });

  describe('Missing-link degrade (TRO-337 proof: one assignee with no reports_to degrades gracefully)', () => {
    it('does not throw, and still drafts a message naming that no common manager could be confirmed', async () => {
      const noManagerPeople = [
        person(ENGINEER_A, MANAGER_X),
        person(MANAGER_X, DIRECTOR_1),
        person(DIRECTOR_1, null),
        // engineer-b has NO reports_to at all — TRO-337's own verified
        // normal case ("reports_to is set on only 10 of the 20 people").
        person(ENGINEER_B, null),
      ];
      const model = fakeModel('DRAFT: no single manager confirmed, looping in the reachable contact...');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const client = testCase5Client({ getPeople: vi.fn().mockResolvedValue(noManagerPeople) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client, itemStore, draftStore }));

      await expect(
        compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID })
      ).resolves.not.toThrow();

      const result = await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      expect(result.blockerEscalationManager?.reason).toBe('no_common_manager');
      expect(result.blockerEscalationManager?.managerUserId).toBeNull();
      // Routes to the highest reachable point — engineer-a's own chain root
      // (director-1) is the only real data available.
      expect(result.blockerEscalationManager?.highestReachableUserId).toBe(DIRECTOR_1);

      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('No single manager could be confirmed');

      // Still produces a USABLE answer — a real drafted item, routed to the
      // highest reachable contact — not silence.
      const items = itemStore.list(DIRECTOR_1);
      expect(items).toHaveLength(1);
    });
  });

  describe('Same reporting line (TRO-337 proof: does not escalate at all)', () => {
    it('makes no model call and writes no draft/item when both blocked people share the same direct manager', async () => {
      const sameLinePeople = [
        person(ENGINEER_A, MANAGER_X),
        person(ENGINEER_B, MANAGER_X), // same direct manager as engineer-a
        person(MANAGER_X, DIRECTOR_1),
        person(DIRECTOR_1, null),
      ];
      const model = fakeModel('should never be called');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const client = testCase5Client({ getPeople: vi.fn().mockResolvedValue(sameLinePeople) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client, itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.blockerEscalationSkipReason).toBe('same_reporting_line');
      expect(result.blockerEscalationDraftText).toBeUndefined();
      expect(itemStore.all()).toHaveLength(0);
      expect(draftStore.listForPerson(DIRECTOR_1)).toHaveLength(0);
      expect(draftStore.listForPerson(MANAGER_X)).toHaveLength(0);
    });
  });

  describe('Skipped when the fan-out never spans two or more projects', () => {
    it('makes no model call when both blocked issues sit in the SAME project as the blocking issue', async () => {
      const model = fakeModel('should never be called');
      const client = testCase5Client({
        getAssociations: vi.fn(async (id: string, type?: string) => {
          // Every project association resolves to the SAME project — no
          // cross-project fan-out at all.
          if (type === 'project') return [{ related_id: PROJECT_A_ID, relationship_type: 'project' }];
          if (id === BLOCKER_ISSUE_ID && type === 'blocks') {
            return [
              { related_id: BLOCKED_ISSUE_1, relationship_type: 'blocks' },
              { related_id: BLOCKED_ISSUE_2, relationship_type: 'blocks' },
            ];
          }
          return [];
        }),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.blockerEscalationSkipReason).toBe('single_project');
    });
  });

  describe('Proof — the drafted message is never sent by any code path this ticket adds', () => {
    it('DeepShipClientLike exposes only read methods — there is no write method for this path to call', async () => {
      const client = testCase5Client();
      // Every method on the fake is one of the six reads DeepShipClientLike
      // declares; nothing resembling create/update/post/apply/send exists on
      // it to call even by mistake (enforced structurally by the TYPE, not
      // by this assertion — this documents the surface actually used).
      expect(Object.keys(client).sort()).toEqual(
        ['getAssociations', 'getChangeFeed', 'getDocument', 'getIssuesByAssignee', 'getPeople', 'listDocuments'].sort()
      );
    });

    it('the drafted text is retrievable ONLY from DraftStore — commitBlockerEscalation never calls a sending endpoint', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(fakeModel('a private escalation draft'), undefined, undefined, deps({ itemStore, draftStore }));

      await compiled.invoke({ trigger: 'proactive_escalation', blockingIssueId: BLOCKER_ISSUE_ID });

      // The InboxItem is a lightweight pointer — the actual prose lives only
      // in DraftStore, never duplicated onto anything Ship-visible, and the
      // draft's status starts 'unseen' (never 'posted' — nothing in this
      // chain ever calls markPosted; only gate.ts's acceptDraft does, under
      // a human's own token).
      const item = itemStore.list(DIRECTOR_1)[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item).not.toHaveProperty('draftText');
      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('a private escalation draft');
      expect(stored?.status).toBe('unseen');
    });
  });
});

describe('buildGraph — retro delivery drafting (TRO-335 / FG-17)', () => {
  /**
   * Synthetic fixture (not real seeded DB rows) — same posture as the
   * blocker-escalation describe block above: this describe block never
   * makes a live model call, so there is nothing a real fixture id would
   * add over a readable synthetic one. Shape matches FLEETGRAPH.MD's own
   * Test Case 3 row exactly: "A week whose plan lists 4 success criteria;
   * 3 issues closed during the week, mapping to 2 of them."
   */
  const WEEK_ID = 'week-12';
  const OWNER_USER_ID = 'user-week-owner';
  const CLOSED_ISSUE_1 = 'closed-issue-1';
  const CLOSED_ISSUE_2 = 'closed-issue-2';
  const CLOSED_ISSUE_3 = 'closed-issue-3';
  const OPEN_ISSUE = 'open-issue-1';

  const SUCCESS_CRITERIA = [
    'Sprint management flows end-to-end with no manual DB edits',
    'Sprint timeline UI renders for every active week',
    'Progress chart reflects real issue counts within 1 minute',
    'Issue assignment flow ships behind a feature flag',
  ];

  function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
    return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
  }

  function weekDoc(overrides: Partial<ShipDocument['properties']> = {}): ShipDocument {
    return doc({
      id: WEEK_ID,
      title: 'Week 12',
      document_type: 'sprint',
      properties: { sprint_number: 12, owner_id: OWNER_USER_ID, success_criteria: SUCCESS_CRITERIA, ...overrides },
    });
  }

  // Week 12's computed window: sprint_number 12, workspace_sprint_start_date
  // '2026-05-18' → [2026-08-03T00:00:00.000Z, 2026-08-10T00:00:00.000Z),
  // verified by direct computation (same formula `retroDraft.ts`'s
  // `computeWeekWindow` uses) rather than hand arithmetic. All 3 closed
  // issues below fall inside it; the "old, unrelated done issue" fixture
  // deliberately falls outside it — the real bug this design was corrected
  // for (see `retroDraft.ts`'s module docstring: verified against this
  // worktree's own seeded database, an issue sharing a sprint association
  // from a month earlier must not leak into this week's draft).
  const OLD_UNRELATED_DONE_ISSUE = 'old-unrelated-done-issue';

  function testCase3Client(overrides: Partial<DeepShipClientLike> = {}): DeepShipClientLike {
    return {
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
      listDocuments: vi.fn().mockResolvedValue([]),
      getPeople: vi.fn().mockResolvedValue([]),
      getAssociations: vi.fn().mockResolvedValue([]),
      getWeekDates: vi.fn().mockResolvedValue({ workspace_sprint_start_date: '2026-05-18' }),
      getDocument: vi.fn(async (id: string) => {
        if (id === WEEK_ID) return weekDoc();
        if (id === CLOSED_ISSUE_1) return doc({ id: CLOSED_ISSUE_1, title: 'Wire sprint management CRUD end-to-end', properties: { state: 'done' }, completed_at: '2026-08-03T10:00:00.000Z' });
        if (id === CLOSED_ISSUE_2) return doc({ id: CLOSED_ISSUE_2, title: 'Remove last manual DB edit from sprint close-out', properties: { state: 'done' }, completed_at: '2026-08-04T10:00:00.000Z' });
        if (id === CLOSED_ISSUE_3) return doc({ id: CLOSED_ISSUE_3, title: 'Ship sprint timeline UI for active weeks', properties: { state: 'done' }, completed_at: '2026-08-05T10:00:00.000Z' });
        if (id === OPEN_ISSUE) return doc({ id: OPEN_ISSUE, title: 'Issue assignment flow (still in progress)', properties: { state: 'in_progress' } });
        if (id === OLD_UNRELATED_DONE_ISSUE) return doc({ id: OLD_UNRELATED_DONE_ISSUE, title: 'Old work closed a month earlier', properties: { state: 'done' }, completed_at: '2026-07-01T10:00:00.000Z' });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) => {
        if (id === WEEK_ID && type === 'sprint') {
          return [
            { document_id: CLOSED_ISSUE_1, relationship_type: 'sprint' },
            { document_id: CLOSED_ISSUE_2, relationship_type: 'sprint' },
            { document_id: CLOSED_ISSUE_3, relationship_type: 'sprint' },
            { document_id: OPEN_ISSUE, relationship_type: 'sprint' },
            { document_id: OLD_UNRELATED_DONE_ISSUE, relationship_type: 'sprint' },
          ];
        }
        return [];
      }),
      ...overrides,
    };
  }

  function deps(overrides: Partial<DeepDeps> = {}): DeepDeps {
    return {
      shipClient: testCase3Client(),
      itemStore: new InMemoryItemStore(),
      draftStore: new InMemoryDraftStore(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('exposes every retro-drafting node in NODE_NAMES on the compiled graph', () => {
    expect(NODE_NAMES).toEqual(
      expect.arrayContaining(['gatherRetroActivity', 'composeRetroDraft', 'commitRetroDraft'])
    );
  });

  it('throws a clear error if a proactive_retro trigger runs without DeepDeps, rather than silently no-op-ing', async () => {
    const compiled = buildGraph(fakeModel('unused'));

    await expect(compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID })).rejects.toThrow(/DeepDeps/);
  });

  it('throws a clear error if proactive_retro runs without weekId, rather than guessing which week', async () => {
    const compiled = buildGraph(fakeModel('unused'), undefined, undefined, deps());

    await expect(compiled.invoke({ trigger: 'proactive_retro' })).rejects.toThrow(/weekId/);
  });

  describe('Test Case 3 — 4 success criteria, 3 closed issues mapping to 2 of them (recorded model response)', () => {
    it('pre-fills the delivered section from the 3 closed issues, mapped to their criteria, with the 2 unmatched criteria called out', async () => {
      // A recorded, fixed model response (the ticket's own instruction:
      // "Recorded model response so CI is deterministic") — the MAPPING of
      // issues to criteria is a model judgment call this test does not
      // re-derive; what this test proves is that the model was handed every
      // real fact (all 4 criteria, all 3 closed issues, none invented) and
      // that its response is committed to the draft/item stores untouched.
      const recordedResponse =
        'Delivered:\n' +
        '- Sprint management flows end-to-end with no manual DB edits — closed "Wire sprint management ' +
        'CRUD end-to-end" and "Remove last manual DB edit from sprint close-out".\n' +
        '- Sprint timeline UI renders for every active week — closed "Ship sprint timeline UI for active ' +
        'week".\n' +
        'Not yet delivered (no matching closed work — please explain):\n' +
        '- Progress chart reflects real issue counts within 1 minute\n' +
        '- Issue assignment flow ships behind a feature flag';
      const model = fakeModel(recordedResponse);
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      // The gathered facts: all 4 criteria, exactly the 3 done issues (the
      // 4th, still in_progress, excluded).
      expect(result.weekDeliverySummary?.successCriteria).toEqual(SUCCESS_CRITERIA);
      expect(result.weekDeliverySummary?.closedIssues).toHaveLength(3);
      expect(result.weekDeliverySummary?.closedIssues.map((i) => i.issueId).sort()).toEqual(
        [CLOSED_ISSUE_1, CLOSED_ISSUE_2, CLOSED_ISSUE_3].sort()
      );
      expect(result.retroSkipReason).toBeUndefined();

      // The model was given every real fact, nothing invented.
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      for (const criterion of SUCCESS_CRITERIA) {
        expect(prompt).toContain(criterion);
      }
      expect(prompt).toContain('Wire sprint management CRUD end-to-end');
      expect(prompt).toContain('Remove last manual DB edit from sprint close-out');
      expect(prompt).toContain('Ship sprint timeline UI for active weeks');
      expect(prompt).not.toContain('Issue assignment flow (still in progress)');
      // The stale done issue (same sprint association, closed a month
      // before this week's own window) must never leak into the prompt —
      // the real bug this design was corrected for.
      expect(prompt).not.toContain('Old work closed a month earlier');

      // The recorded model response lands in the draft, untouched.
      const items = itemStore.list(OWNER_USER_ID);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item.type).toBe('retro_draft');
      expect(item.evidence).toEqual({ documentId: WEEK_ID, documentType: 'sprint' });
      expect(item.draftId).toBeDefined();

      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe(recordedResponse);
      expect(stored?.status).toBe('unseen');
      expect(stored?.personUserId).toBe(OWNER_USER_ID);
      expect(stored?.proposedTransitions).toEqual([]);
    });

    it('re-invoking for the same week is an upsert — no duplicate draft or item', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const sharedDeps = deps({ itemStore, draftStore });
      const compiled = buildGraph(fakeModel('draft text'), undefined, undefined, sharedDeps);

      await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });
      await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(itemStore.list(OWNER_USER_ID)).toHaveLength(1);
      expect(draftStore.listForPerson(OWNER_USER_ID)).toHaveLength(1);
    });
  });

  describe('Skipped when the week has no success criteria at all (the trigger condition itself)', () => {
    it('makes no model call and writes no draft/item', async () => {
      const model = fakeModel('should never be called');
      const client = testCase3Client({ getDocument: vi.fn().mockResolvedValue(weekDoc({ success_criteria: [] })) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.retroSkipReason).toBe('no_success_criteria');
      expect(result.retroDraftText).toBeUndefined();
    });
  });

  describe('Skipped when the week has no recorded owner', () => {
    it('makes no model call and writes no draft/item', async () => {
      const model = fakeModel('should never be called');
      const client = testCase3Client({ getDocument: vi.fn().mockResolvedValue(weekDoc({ owner_id: undefined })) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.retroSkipReason).toBe('no_owner');
    });
  });

  describe('Skipped when the week itself is gone or invisible to this token', () => {
    it('makes no model call and does not throw', async () => {
      const model = fakeModel('should never be called');
      const client = testCase3Client({ getDocument: vi.fn().mockRejectedValue(new Error('404: gone')) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.retroSkipReason).toBe('week_not_found');
    });
  });

  describe("Skipped when the week's own calendar window could not be computed", () => {
    it('makes no model call and writes no draft/item — never guesses a closed-issue set it cannot vouch for', async () => {
      const model = fakeModel('should never be called');
      const client = testCase3Client({ getWeekDates: vi.fn().mockRejectedValue(new Error('Ship unreachable')) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.retroSkipReason).toBe('week_dates_unavailable');
      expect(result.weekDeliverySummary?.closedIssues).toEqual([]);
      // Success criteria/owner were still gathered — only the closed-issue
      // set (and therefore the draft) is withheld.
      expect(result.weekDeliverySummary?.successCriteria).toEqual(SUCCESS_CRITERIA);
    });
  });

  describe('Zero-closed-issues case — every criterion is left explicitly unmatched', () => {
    it('still composes a draft, naming that nothing closed', async () => {
      const model = fakeModel('DRAFT: no issues closed this week; every criterion is unmet.');
      const client = testCase3Client({
        getReverseAssociations: vi.fn().mockResolvedValue([]),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      expect(result.retroSkipReason).toBeUndefined();
      expect(result.weekDeliverySummary?.closedIssues).toEqual([]);
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('No issues closed this week');
      expect(result.retroDraftText).toBe('DRAFT: no issues closed this week; every criterion is unmet.');
    });
  });

  describe('Proof — the drafted retro is never submitted by any code path this ticket adds', () => {
    it('DeepShipClientLike exposes only read methods — there is no write method for this path to call', () => {
      // `Record<keyof DeepShipClientLike, true>` fails to COMPILE if a new
      // member is ever added to the type without being listed here
      // (CodeRabbit, TRO-335 PR review) — a future write method added to
      // `DeepShipClientLike` breaks this test at typecheck time, not just if
      // someone remembers to update a plain string array.
      const readOnlySurface: Record<keyof DeepShipClientLike, true> = {
        getAssociations: true,
        getChangeFeed: true,
        getDocument: true,
        getIssuesByAssignee: true,
        getPeople: true,
        getReverseAssociations: true,
        getWeekDates: true,
        listDocuments: true,
      };
      const client = testCase3Client();
      expect(Object.keys(client).sort()).toEqual(Object.keys(readOnlySurface).sort());
    });

    it('the drafted text is retrievable ONLY from DraftStore — commitRetroDraft never calls a submitting endpoint', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(fakeModel('a private retro draft'), undefined, undefined, deps({ itemStore, draftStore }));

      await compiled.invoke({ trigger: 'proactive_retro', weekId: WEEK_ID });

      const item = itemStore.list(OWNER_USER_ID)[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item).not.toHaveProperty('draftText');
      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('a private retro draft');
      expect(stored?.status).toBe('unseen');
    });
  });
});

describe('buildGraph — plan-change discrimination (TRO-336 / FG-18)', () => {
  /**
   * Synthetic fixture text matches FLEETGRAPH.MD's own Test Case 4 exactly
   * ("a plan approved at version N, then edited to remove one success
   * criterion") and this ticket's own real seed fixture text
   * (`api/src/db/seed.ts`'s Test Case 4 block) — never a live model call,
   * same posture as every other describe block in this file.
   */
  const WEEK_ID = 'week-13';
  const APPROVER_USER_ID = 'user-approver-1';
  const ORIGINAL_CRITERIA = [
    'All auth endpoints covered by integration tests',
    'Password reset flow ships behind a feature flag',
    'Session timeout matches the 15-minute policy',
    'CSRF protection verified on every mutating route',
  ];
  const EDITED_CRITERIA = ORIGINAL_CRITERIA.slice(0, 3);

  function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
    return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
  }

  function weekDoc(overrides: Partial<ShipDocument['properties']> = {}): ShipDocument {
    return doc({
      id: WEEK_ID,
      title: 'Week 13',
      document_type: 'sprint',
      properties: {
        sprint_number: 13,
        success_criteria: EDITED_CRITERIA,
        plan_approval: {
          state: 'changed_since_approved',
          approved_by: APPROVER_USER_ID,
          approved_at: '2026-07-30T18:07:58.245Z',
          approved_version_id: null,
          comment: 'Approved — clear goals for the week.',
        },
        plan_history: [
          { plan: JSON.stringify(ORIGINAL_CRITERIA), timestamp: '2026-07-30T18:07:58.245Z', author_id: 'user-owner-1', author_name: 'Dev User' },
        ],
        ...overrides,
      },
    });
  }

  function testCase4Client(overrides: Partial<DeepShipClientLike> = {}): DeepShipClientLike {
    return {
      getIssuesByAssignee: vi.fn().mockResolvedValue([]),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
      listDocuments: vi.fn().mockResolvedValue([]),
      getPeople: vi.fn().mockResolvedValue([]),
      getAssociations: vi.fn().mockResolvedValue([]),
      getReverseAssociations: vi.fn().mockResolvedValue([]),
      getWeekDates: vi.fn().mockResolvedValue({ workspace_sprint_start_date: '2026-05-18' }),
      getDocument: vi.fn().mockResolvedValue(weekDoc()),
      ...overrides,
    };
  }

  function deps(overrides: Partial<DeepDeps> = {}): DeepDeps {
    return {
      shipClient: testCase4Client(),
      itemStore: new InMemoryItemStore(),
      draftStore: new InMemoryDraftStore(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      ...overrides,
    };
  }

  it('exposes every plan-change node in NODE_NAMES on the compiled graph', () => {
    expect(NODE_NAMES).toEqual(
      expect.arrayContaining(['detectPlanChange', 'composePlanChangeDraft', 'commitPlanChangeDraft'])
    );
  });

  it('throws a clear error if a proactive_plan_change trigger runs without DeepDeps, rather than silently no-op-ing', async () => {
    const compiled = buildGraph(fakeModel('unused'));

    await expect(compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID })).rejects.toThrow(/DeepDeps/);
  });

  it('throws a clear error if proactive_plan_change runs without weekId, rather than guessing which week', async () => {
    const compiled = buildGraph(fakeModel('unused'), undefined, undefined, deps());

    await expect(compiled.invoke({ trigger: 'proactive_plan_change' })).rejects.toThrow(/weekId/);
  });

  describe('Test Case 4 — one criterion removed after approval (recorded model response)', () => {
    it('pre-fills a before-and-after on the removed criterion and drafts a question, routed to the approver', async () => {
      // A recorded, fixed model response (same "recorded model response so
      // CI is deterministic" pattern TRO-335's Test Case 3 already
      // established) — required here specifically because THIS chain asks
      // the model for a MATERIAL/NOT MATERIAL verdict, not just prose; see
      // `planChangeDraft.ts`'s own module docstring for why a deterministic
      // heuristic could not make this call reliably.
      const recordedResponse =
        'MATERIAL\n\n' +
        'Hi — I noticed "CSRF protection verified on every mutating route" was removed from this week\'s ' +
        'plan after I approved it. Could you help me understand why? Happy to re-approve once I understand ' +
        'the change.';
      const model = fakeModel(recordedResponse);
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      // The gathered facts: the removed criterion, nothing added or
      // modified, correctly aligned from plan_history (the reachable seed
      // fixture's real shape).
      expect(result.planChangeSummary?.alignment.removed).toEqual([
        'CSRF protection verified on every mutating route',
      ]);
      expect(result.planChangeSummary?.alignment.added).toEqual([]);
      expect(result.planChangeSummary?.alignment.modified).toEqual([]);
      expect(result.planChangeSkipReason).toBeUndefined();

      // The model was given the real removed criterion, nothing invented.
      const prompt = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('CSRF protection verified on every mutating route');
      expect(prompt).not.toContain('Session timeout'); // unchanged criteria are not facts to report

      // A drafted question, routed to the APPROVER (not the plan's owner),
      // never sent.
      const items = itemStore.list(APPROVER_USER_ID);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item.type).toBe('plan_change_draft');
      expect(item.evidence).toEqual({ documentId: WEEK_ID, documentType: 'sprint' });
      expect(item.draftId).toBeDefined();

      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe(
        'Hi — I noticed "CSRF protection verified on every mutating route" was removed from this week\'s ' +
          'plan after I approved it. Could you help me understand why? Happy to re-approve once I understand ' +
          'the change.'
      );
      expect(stored?.status).toBe('unseen');
      expect(stored?.personUserId).toBe(APPROVER_USER_ID);
      expect(stored?.proposedTransitions).toEqual([]);
    });

    it('re-invoking for the same week is an upsert — no duplicate draft or item', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const sharedDeps = deps({ itemStore, draftStore });
      const compiled = buildGraph(fakeModel('MATERIAL\n\ndraft text'), undefined, undefined, sharedDeps);

      await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });
      await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(itemStore.list(APPROVER_USER_ID)).toHaveLength(1);
      expect(draftStore.listForPerson(APPROVER_USER_ID)).toHaveLength(1);
    });
  });

  describe("Negative case (deterministic) — a whitespace-only edit produces nothing, and never even calls the model", () => {
    it('makes NO model call at all — proven before the fix made it correctly not-fire', async () => {
      const model = fakeModel('should never be called');
      // Only whitespace differs from ORIGINAL_CRITERIA — every criterion is
      // identical after normalization.
      const client = testCase4Client({
        getDocument: vi.fn().mockResolvedValue(
          weekDoc({
            success_criteria: [
              'All auth endpoints covered by integration tests',
              'Password reset flow ships behind a feature flag',
              'Session timeout matches the 15-minute policy  ', // trailing whitespace
              ' CSRF protection verified on every mutating route', // leading whitespace
            ],
          })
        ),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.planChangeSkipReason).toBe('no_material_change');
      expect(result.planChangeDraftText).toBeUndefined();
    });
  });

  describe('Negative case (model-mediated) — a genuine typo-only edit calls the model, which correctly withholds a draft', () => {
    it('calls the model (the deterministic gate cannot decide this on its own) and writes nothing when it returns NOT MATERIAL', async () => {
      const model = fakeModel('NOT MATERIAL');
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      // A real one-character typo fix, not exactly equal after whitespace
      // normalization — this MUST reach the model (it is not the
      // deterministic whitespace-only case above).
      const client = testCase4Client({
        getDocument: vi.fn().mockResolvedValue(
          weekDoc({
            success_criteria: [
              'All auth endpoints covered by integration tests',
              'Password reset flow ships behind a feature flag',
              'Session timeout matches the 15-minute policy',
              'CSRF protection verified on every mutating rotue', // typo: rotue
            ],
          })
        ),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client, itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).toHaveBeenCalledTimes(1);
      expect(result.planChangeSkipReason).toBe('no_material_change');
      expect(result.planChangeDraftText).toBeUndefined();
      expect(itemStore.all()).toHaveLength(0);
      expect(draftStore.listForPerson(APPROVER_USER_ID)).toHaveLength(0);
    });
  });

  describe('Defensive edge case — a MATERIAL verdict with nothing written after it', () => {
    it('writes no draft/item and reports planChangeSkipReason: "empty_draft" rather than leaving the reason unexplained', async () => {
      const model = fakeModel('MATERIAL'); // no blank line, no question text after it
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const compiled = buildGraph(model, undefined, undefined, deps({ itemStore, draftStore }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).toHaveBeenCalledTimes(1);
      expect(result.planChangeSkipReason).toBe('empty_draft');
      expect(result.planChangeDraftText).toBeUndefined();
      expect(itemStore.all()).toHaveLength(0);
      expect(draftStore.listForPerson(APPROVER_USER_ID)).toHaveLength(0);
    });
  });

  describe('Skipped when the week is not actually changed_since_approved', () => {
    it('makes no model call', async () => {
      const model = fakeModel('should never be called');
      const client = testCase4Client({
        getDocument: vi.fn().mockResolvedValue(
          weekDoc({ plan_approval: { state: 'approved', approved_by: APPROVER_USER_ID, approved_at: '2026-07-30T18:07:58.245Z', approved_version_id: null } })
        ),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.planChangeSkipReason).toBe('not_changed_since_approval');
    });
  });

  describe('Skipped when the week has no recorded approver', () => {
    it('makes no model call', async () => {
      const model = fakeModel('should never be called');
      const client = testCase4Client({
        getDocument: vi.fn().mockResolvedValue(
          weekDoc({ plan_approval: { state: 'changed_since_approved', approved_by: null, approved_at: '2026-07-30T18:07:58.245Z', approved_version_id: null } })
        ),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.planChangeSkipReason).toBe('no_approver');
    });
  });

  describe('Skipped when no "before" snapshot can be found', () => {
    it('makes no model call and never guesses at a diff', async () => {
      const model = fakeModel('should never be called');
      const client = testCase4Client({
        getDocument: vi.fn().mockResolvedValue(weekDoc({ plan_history: [] })),
      });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.planChangeSkipReason).toBe('no_diff_source');
    });
  });

  describe('Skipped when the week itself is gone or invisible to this token', () => {
    it('makes no model call and does not throw', async () => {
      const model = fakeModel('should never be called');
      const client = testCase4Client({ getDocument: vi.fn().mockRejectedValue(new Error('404: gone')) });
      const compiled = buildGraph(model, undefined, undefined, deps({ shipClient: client }));

      const result = await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      expect(model.invoke).not.toHaveBeenCalled();
      expect(result.planChangeSkipReason).toBe('week_not_found');
    });
  });

  describe('Proof — no approval state is ever written by any code path this ticket adds', () => {
    it('DeepShipClientLike exposes only read methods — there is no write method for this path to call', () => {
      // `Record<keyof DeepShipClientLike, true>` fails to compile if a new
      // member is ever added to the type without being listed here — same
      // compile-time-checked proof pattern TRO-335's own retro chain uses.
      const readOnlySurface: Record<keyof DeepShipClientLike, true> = {
        getAssociations: true,
        getChangeFeed: true,
        getDocument: true,
        getIssuesByAssignee: true,
        getPeople: true,
        getReverseAssociations: true,
        getWeekDates: true,
        listDocuments: true,
      };
      const client = testCase4Client();
      expect(Object.keys(client).sort()).toEqual(Object.keys(readOnlySurface).sort());
    });

    it('the drafted text is retrievable ONLY from DraftStore — commitPlanChangeDraft never calls a write endpoint, and the week\'s own plan_approval is never touched', async () => {
      const itemStore = new InMemoryItemStore();
      const draftStore = new InMemoryDraftStore();
      const getDocument = vi.fn().mockResolvedValue(weekDoc());
      const client = testCase4Client({ getDocument });
      const compiled = buildGraph(fakeModel('MATERIAL\n\na private plan-change draft'), undefined, undefined, deps({ shipClient: client, itemStore, draftStore }));

      await compiled.invoke({ trigger: 'proactive_plan_change', weekId: WEEK_ID });

      const item = itemStore.list(APPROVER_USER_ID)[0];
      if (!item) throw new Error('expected exactly one item');
      expect(item).not.toHaveProperty('draftText');
      const stored = item.draftId ? draftStore.get(item.draftId) : undefined;
      expect(stored?.draftText).toBe('a private plan-change draft');
      expect(stored?.status).toBe('unseen');

      // `getDocument` was never called with a write-shaped argument — it is
      // a `Pick<..., 'getDocument'>` read call every time; there is no
      // second, write-capable client anywhere in this invocation for a
      // plan_approval write to have gone through even by mistake.
      for (const call of getDocument.mock.calls) {
        expect(call).toHaveLength(1); // getDocument(id) only — no write payload argument
      }
    });
  });
});
