import { describe, expect, it, vi } from 'vitest';
import { buildGraph, NODE_NAMES, type AnthropicModel } from '../graph.js';
import type { ShipClientLike, ChangeFeedResponse } from '../shipClient.js';
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
