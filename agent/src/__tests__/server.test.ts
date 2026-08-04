import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import type { ShipReadClient } from '../health.js';
import type { InboxItem } from '../itemStore.js';

const READY_CONFIG = {
  ANTHROPIC_API_KEY: 'sk-test',
  SHIP_API_BASE_URL: 'https://ship.example.gov',
  SHIP_API_TOKEN: 'token-abc',
};

describe('GET /health', () => {
  it('always returns 200, even with an incomplete config and no Ship connectivity', async () => {
    const app = createServer(loadConfig({}));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 503 when config is incomplete', async () => {
    const app = createServer(loadConfig({}));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('config_incomplete');
  });

  it('returns 503 when the Ship base URL is unreachable — asserted against a stable fake client, never a live call', async () => {
    const client: ShipReadClient = { get: vi.fn().mockRejectedValue(new Error("I can't reach Ship right now.")) };
    const app = createServer(loadConfig(READY_CONFIG), { client });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.reason).toContain('ship_unreachable');
  });

  it('returns 200 when config is complete and Ship is reachable', async () => {
    const client: ShipReadClient = { get: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) };
    const app = createServer(loadConfig(READY_CONFIG), { client });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('the SAME client (and its breaker) is reused across requests — repeated failures eventually short-circuit rather than each poll paying a fresh cost', async () => {
    const client: ShipReadClient = { get: vi.fn().mockRejectedValue(new Error("I can't reach Ship right now.")) };
    const app = createServer(loadConfig(READY_CONFIG), { client });

    await request(app).get('/ready');
    await request(app).get('/ready');
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    // Same client instance handled all three polls — proves it wasn't
    // rebuilt (and its breaker state reset) on every request.
    expect(client.get).toHaveBeenCalledTimes(3);
  });
});

// TRO-320 / FG-9: the route the Ship-side chat panel proxies through
// (api/src/routes/agent.ts). This service is reachable from the public
// internet (a Render service, no private networking) — the internal-secret
// check must run BEFORE the graph is ever touched.
describe('POST /chat', () => {
  const SECRET = 'test-internal-secret';
  const CHAT_CONFIG = { ...READY_CONFIG, AGENT_INTERNAL_SECRET: SECRET };
  const VALID_BODY = { seedDocumentId: 'doc-123', question: 'why is this stalled?', askingUserId: 'user-456' };

  function fakeGraph(resolved: { output: string; citedSources: unknown[]; expansionCapped: boolean }) {
    return { invoke: vi.fn().mockResolvedValue(resolved) };
  }

  it('returns 500 when the server itself has no AGENT_INTERNAL_SECRET configured — fails closed, not open', async () => {
    const app = createServer(loadConfig(READY_CONFIG), { graph: fakeGraph({ output: 'x', citedSources: [], expansionCapped: false }) });
    const res = await request(app).post('/chat').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_secret_not_configured');
  });

  it('returns 401 when the X-Internal-Secret header is missing', async () => {
    const app = createServer(loadConfig(CHAT_CONFIG), { graph: fakeGraph({ output: 'x', citedSources: [], expansionCapped: false }) });
    const res = await request(app).post('/chat').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 when the X-Internal-Secret header does not match', async () => {
    const app = createServer(loadConfig(CHAT_CONFIG), { graph: fakeGraph({ output: 'x', citedSources: [], expansionCapped: false }) });
    const res = await request(app).post('/chat').set('X-Internal-Secret', 'wrong-secret').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 for a wrong secret of the SAME length as the real one — exercises the timingSafeEqual comparison itself, not just the length-mismatch guard in front of it', async () => {
    const sameLengthWrongSecret = 'x'.repeat(SECRET.length);
    const graph = fakeGraph({ output: 'x', citedSources: [], expansionCapped: false });
    const app = createServer(loadConfig(CHAT_CONFIG), { graph });
    const res = await request(app).post('/chat').set('X-Internal-Secret', sameLengthWrongSecret).send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it('returns 503 (agent not configured) when the secret matches but no graph was wired — config incomplete', async () => {
    const app = createServer(loadConfig(CHAT_CONFIG)); // no graph dep at all
    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('agent_not_configured');
  });

  it('returns 400 when the body is missing required fields, even with a valid secret and a real graph', async () => {
    const graph = fakeGraph({ output: 'x', citedSources: [], expansionCapped: false });
    const app = createServer(loadConfig(CHAT_CONFIG), { graph });
    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send({ question: 'no seed here' });
    expect(res.status).toBe(400);
    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it('invokes the graph with trigger "on_demand" and the seed/question/askingUserId from the request, and relays output/citedSources/expansionCapped', async () => {
    const citedSources = [{ documentId: 'week-1', documentType: 'sprint', title: 'Week 12', reason: "the issue's week" }];
    const graph = fakeGraph({ output: 'This issue is stalled because...', citedSources, expansionCapped: false });
    const app = createServer(loadConfig(CHAT_CONFIG), { graph });

    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(VALID_BODY);

    // Second argument (CodeRabbit review, PR #120): a real AbortSignal,
    // passed so LangGraph can actually cancel the run if the handler's own
    // timeout fires — see server.ts's own comment on `POST /chat`.
    expect(graph.invoke).toHaveBeenCalledWith(
      {
        trigger: 'on_demand',
        input: VALID_BODY.question,
        seedDocumentId: VALID_BODY.seedDocumentId,
        askingUserId: VALID_BODY.askingUserId,
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      output: 'This issue is stalled because...',
      citedSources,
      expansionCapped: false,
    });
  });

  it('returns 502 (never a hang or a raw stack trace) when the graph invocation itself throws', async () => {
    const graph = { invoke: vi.fn().mockRejectedValue(new Error('Ship unreachable mid-expansion')) };
    const app = createServer(loadConfig(CHAT_CONFIG), { graph });
    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('graph_invoke_failed');
  });

  /**
   * CodeRabbit review, PR #120: `graph.invoke(...)` had no deadline of its
   * own — a hung graph/model/Ship call kept this handler (and its request
   * slot) alive indefinitely, even after api/'s own proxy gave up and
   * returned a 502 to the browser (api/'s AGENT_REQUEST_TIMEOUT_MS, 30s).
   *
   * `abortAwareGraph` below is not a bare stub: it actually honors the
   * `signal` passed as `invoke`'s second argument (rejecting when it fires),
   * modeling the REAL `@langchain/langgraph` behavior confirmed with a
   * throwaway probe against the real package before writing this test —
   * `graph.invoke(input, { signal })` rejects within ~10ms of an abort,
   * regardless of whether the node in flight ever finishes on its own. A
   * mock that ignored the signal and just resolved/rejected on its own timer
   * would prove nothing about whether the signal is actually wired through.
   */
  function abortAwareGraph(resolveAfterMs: number) {
    const invoke = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ output: 'too late', citedSources: [], expansionCapped: false }),
          resolveAfterMs
        );
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
    });
    return { invoke };
  }

  it('returns 504 (never an unbounded hang) when graph.invoke does not settle within chatHandlerTimeoutMs, and actually aborts the SAME signal it passed to the graph', async () => {
    const graph = abortAwareGraph(5000); // would resolve in 5s if never aborted
    const config = loadConfig({ ...CHAT_CONFIG, CHAT_HANDLER_TIMEOUT_MS: '20' });
    const app = createServer(config, { graph });

    const start = Date.now();
    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(VALID_BODY);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(504);
    expect(res.body.error).toBe('graph_invoke_timeout');
    // Settled near the configured 20ms timeout, nowhere near the 5s the
    // fake graph would otherwise have taken — the handler's response is
    // genuinely bounded by chatHandlerTimeoutMs, not by graph.invoke ever
    // settling on its own.
    expect(elapsed).toBeLessThan(2000);

    // The exact AbortSignal object graph.invoke received is the one that
    // ended up aborted — real propagation, not a signal built and then
    // never wired anywhere (the bare-`Promise.race` shape this replaces).
    expect(graph.invoke).toHaveBeenCalledTimes(1);
    const [, options] = graph.invoke.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(options.signal.aborted).toBe(true);
  });

  it('preserves the existing 200 success shape when graph.invoke settles well within chatHandlerTimeoutMs', async () => {
    const graph = abortAwareGraph(1);
    const config = loadConfig({ ...CHAT_CONFIG, CHAT_HANDLER_TIMEOUT_MS: '5000' });
    const app = createServer(config, { graph });

    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ output: 'too late', citedSources: [], expansionCapped: false });
  });
});

// TRO-323 / FG-10: the route Ship's ranked-inbox surface proxies through
// (api/src/routes/agent.ts's own GET /inbox). Same public-internet exposure
// as /chat, so the same secret check must run first. itemStore.list() is
// already fully ranked (itemStore.ts's own docstring, FG-5/FG-6) — this
// route is read-only plumbing, so these tests assert it calls list() with
// the right recipient and relays the result verbatim, never that it
// re-derives or re-sorts anything.
describe('GET /inbox', () => {
  const SECRET = 'test-internal-secret';
  const CHAT_CONFIG = { ...READY_CONFIG, AGENT_INTERNAL_SECRET: SECRET };
  const RECIPIENT = 'user-456';

  function fakeItemStore(items: InboxItem[]) {
    return { list: vi.fn().mockReturnValue(items) };
  }

  const SAMPLE_ITEM: InboxItem = {
    id: 'blocking-approval:sprint-1:state',
    recipientUserId: RECIPIENT,
    type: 'blocking_approval',
    summary: 'AUTH-12 is waiting on your approval',
    evidence: { documentId: 'issue-2', documentType: 'issue' },
    action: { label: 'Review AUTH-12', href: '/documents/issue-2' },
    blockedCount: 3,
    blockedSince: '2026-07-30T12:00:00.000Z',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
  };

  it('returns 500 when the server itself has no AGENT_INTERNAL_SECRET configured — fails closed, not open', async () => {
    const app = createServer(loadConfig(READY_CONFIG), { itemStore: fakeItemStore([SAMPLE_ITEM]) });
    const res = await request(app).get('/inbox').query({ recipientUserId: RECIPIENT });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_secret_not_configured');
  });

  it('returns 401 when the X-Internal-Secret header is missing', async () => {
    const app = createServer(loadConfig(CHAT_CONFIG), { itemStore: fakeItemStore([SAMPLE_ITEM]) });
    const res = await request(app).get('/inbox').query({ recipientUserId: RECIPIENT });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 for a wrong secret of the SAME length as the real one — exercises the timingSafeEqual comparison itself, not just the length-mismatch guard in front of it', async () => {
    const sameLengthWrongSecret = 'x'.repeat(SECRET.length);
    const itemStore = fakeItemStore([SAMPLE_ITEM]);
    const app = createServer(loadConfig(CHAT_CONFIG), { itemStore });
    const res = await request(app)
      .get('/inbox')
      .query({ recipientUserId: RECIPIENT })
      .set('X-Internal-Secret', sameLengthWrongSecret);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(itemStore.list).not.toHaveBeenCalled();
  });

  it('returns 503 (agent not configured) when the secret matches but no itemStore was wired — config incomplete', async () => {
    const app = createServer(loadConfig(CHAT_CONFIG)); // no itemStore dep at all
    const res = await request(app).get('/inbox').query({ recipientUserId: RECIPIENT }).set('X-Internal-Secret', SECRET);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('agent_not_configured');
  });

  it('returns 400 when recipientUserId is missing, even with a valid secret and a real itemStore', async () => {
    const itemStore = fakeItemStore([SAMPLE_ITEM]);
    const app = createServer(loadConfig(CHAT_CONFIG), { itemStore });
    const res = await request(app).get('/inbox').set('X-Internal-Secret', SECRET);
    expect(res.status).toBe(400);
    expect(itemStore.list).not.toHaveBeenCalled();
  });

  it('calls itemStore.list with the recipientUserId query param and relays its items verbatim, in the order list() returned them', async () => {
    const items = [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: 'mention:doc-9:user-456', type: 'mention' as const, summary: 'You were mentioned in Week 12', blockedCount: undefined, blockedSince: undefined }];
    const itemStore = fakeItemStore(items);
    const app = createServer(loadConfig(CHAT_CONFIG), { itemStore });

    const res = await request(app).get('/inbox').query({ recipientUserId: RECIPIENT }).set('X-Internal-Secret', SECRET);

    expect(itemStore.list).toHaveBeenCalledWith(RECIPIENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items });
  });

  it('returns an empty list (not an error) when the recipient has nothing waiting on them', async () => {
    const itemStore = fakeItemStore([]);
    const app = createServer(loadConfig(CHAT_CONFIG), { itemStore });
    const res = await request(app).get('/inbox').query({ recipientUserId: RECIPIENT }).set('X-Internal-Secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });
});
