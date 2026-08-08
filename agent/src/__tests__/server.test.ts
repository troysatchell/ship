import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createServer, anthropicModelParams, buildAnthropicModel } from '../server.js';
import type { ShipReadClient } from '../health.js';
import { InMemoryItemStore, type InboxItem, type NewInboxItem } from '../itemStore.js';
import { InMemoryDraftStore, type NewStandupDraft } from '../draftStore.js';
import type { CreatedStandup, GateShipClientLike } from '../shipClient.js';
import type { DraftSurvivalRecord, DraftSurvivalTracker } from '../draftSurvival.js';

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
  const VALID_BODY = { seedDocumentId: 'doc-123', question: 'why is this stalled?', askingUserId: 'user-456', askingUserToken: 'user-456-token' };

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

  it('invokes the graph with trigger "on_demand" and the seed/question/askingUserId/askingUserToken from the request, and relays output/citedSources/expansionCapped', async () => {
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
        // TRO-342: this is what lets resolveSeed/expandFrontier authenticate
        // every outbound Ship call as the asking person, never a shared one.
        askingUserToken: VALID_BODY.askingUserToken,
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

  it('TRO-342: returns 400 (never calls the graph) when askingUserToken is missing, even with every other required field present', async () => {
    const graph = fakeGraph({ output: 'x', citedSources: [], expansionCapped: false });
    const app = createServer(loadConfig(CHAT_CONFIG), { graph });
    const { askingUserToken: _omitted, ...bodyWithoutToken } = VALID_BODY;
    const res = await request(app).post('/chat').set('X-Internal-Secret', SECRET).send(bodyWithoutToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(graph.invoke).not.toHaveBeenCalled();
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

// TRO-348: the missing HTTP route into `gate.ts`'s `acceptDraft` — FG-8 built
// that function, tested it thoroughly in isolation (`gate.test.ts`), and
// never wired it to anything a real request could reach (`grep -rn
// "acceptDraft" agent/src api/src web/src`, excluding tests, found no
// caller). These tests deliberately use REAL `InMemoryDraftStore`/
// `InMemoryItemStore` instances (only the outbound Ship write is faked) so a
// regression here proves the route actually drives `acceptDraft`'s real
// logic end to end, not just that a mock was told what to return.
describe('POST /accept-draft', () => {
  const SECRET = 'test-internal-secret';
  const ACCEPT_DRAFT_CONFIG = { ...READY_CONFIG, AGENT_INTERNAL_SECRET: SECRET };
  const ACCEPTER_TOKEN = 'accepter-own-token-abc';
  const DRAFT_ID = 'standup-draft:user-a:2026-08-04';

  function fakeGateClient(): GateShipClientLike & {
    postStandup: ReturnType<typeof vi.fn>;
    setStandupContent: ReturnType<typeof vi.fn>;
    applyIssueTransition: ReturnType<typeof vi.fn>;
  } {
    return {
      postStandup: vi.fn(async (): Promise<CreatedStandup> => ({
        id: 'standup-created-1',
        title: 'Standup',
        document_type: 'standup',
        content: null,
        properties: {},
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:00.000Z',
      })),
      setStandupContent: vi.fn(async (_token: string, standupId: string): Promise<CreatedStandup> => ({
        id: standupId,
        title: 'Standup',
        document_type: 'standup',
        content: null,
        properties: {},
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:05:00.000Z',
      })),
      applyIssueTransition: vi.fn(async () => {}),
    };
  }

  function draftInput(overrides: Partial<NewStandupDraft> = {}): NewStandupDraft {
    return {
      id: DRAFT_ID,
      personUserId: 'user-a',
      windowDate: '2026-08-04',
      draftText: 'I moved AUTH-12 to In Review.',
      proposedTransitions: [],
      ...overrides,
    };
  }

  function standupDraftItem(): NewInboxItem {
    return {
      id: DRAFT_ID,
      recipientUserId: 'user-a',
      type: 'standup_draft',
      summary: 'Your standup draft is ready',
      evidence: {},
      action: { label: 'Review draft', href: `/standup-draft/${DRAFT_ID}` },
      draftId: DRAFT_ID,
    };
  }

  function seededStores() {
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    draftStore.upsert(draftInput());
    itemStore.upsert(standupDraftItem());
    return { draftStore, itemStore };
  }

  it('returns 500 when the server itself has no AGENT_INTERNAL_SECRET configured — fails closed, not open', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(READY_CONFIG), { draftStore, itemStore, gateShipClient });
    const res = await request(app).post('/accept-draft').send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_secret_not_configured');
  });

  it('returns 401 when the X-Internal-Secret header is missing', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });
    const res = await request(app).post('/accept-draft').send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 for a wrong secret of the SAME length as the real one — exercises the timingSafeEqual comparison itself', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });
    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', 'x'.repeat(SECRET.length))
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(gateShipClient.postStandup).not.toHaveBeenCalled();
  });

  it('returns 503 (agent not configured) when the secret matches but draftStore/itemStore/gateShipClient were never wired — config incomplete', async () => {
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG)); // no deps at all
    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('agent_not_configured');
  });

  it('returns 400 when draftId is missing, even with a valid secret and real deps', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });
    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ accepterToken: ACCEPTER_TOKEN });
    expect(res.status).toBe(400);
    expect(gateShipClient.postStandup).not.toHaveBeenCalled();
  });

  it('returns 400 when accepterToken is missing', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });
    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID });
    expect(res.status).toBe(400);
    expect(gateShipClient.postStandup).not.toHaveBeenCalled();
  });

  // THE REGRESSION TEST (TRO-348): before this ticket, there was no route to
  // even reach — this is the case that proves one now exists AND that it
  // drives the real acceptDraft, including TRO-338's draft-survival metric,
  // which had no live caller anywhere until this route existed.
  it('calls the real acceptDraft: posts under the accepting person\'s own token, marks the draft posted, dismisses the inbox item, and records a draft-survival measurement', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const draftSurvivalTracker: DraftSurvivalTracker & { record: ReturnType<typeof vi.fn> } = {
      record: vi.fn(async (_entry: DraftSurvivalRecord) => {}),
    };
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), {
      draftStore,
      itemStore,
      gateShipClient,
      draftSurvivalTracker,
    });

    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ standupId: 'standup-created-1' });
    // Attribution: the Ship write happened under the ACCEPTING person's own
    // token — gate.ts's non-negotiable, exercised here through the route.
    expect(gateShipClient.postStandup).toHaveBeenCalledWith(ACCEPTER_TOKEN, '2026-08-04');
    expect(gateShipClient.setStandupContent).toHaveBeenCalledWith(
      ACCEPTER_TOKEN,
      'standup-created-1',
      'I moved AUTH-12 to In Review.'
    );
    // The draft is marked posted in the SAME store instance the route was
    // given — proves the route reached the real store, not a copy.
    expect(draftStore.get(DRAFT_ID)?.status).toBe('posted');
    // The inbox item is gone.
    expect(itemStore.get(DRAFT_ID)).toBeUndefined();
    // TRO-338's metric actually fires through a live route for the first
    // time — the assertion this whole ticket exists to make pass.
    expect(draftSurvivalTracker.record).toHaveBeenCalledTimes(1);
    expect(draftSurvivalTracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: DRAFT_ID, personUserId: 'user-a', identical: true })
    );
  });

  it('posts a person-edited finalText when supplied, instead of the draft\'s own original text', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });

    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN, finalText: 'Edited before posting.' });

    expect(res.status).toBe(200);
    expect(gateShipClient.setStandupContent).toHaveBeenCalledWith(
      ACCEPTER_TOKEN,
      'standup-created-1',
      'Edited before posting.'
    );
  });

  it('returns 404 (gate_error) when the draft does not exist', async () => {
    const draftStore = new InMemoryDraftStore();
    const itemStore = new InMemoryItemStore();
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });

    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: 'no-such-draft', accepterToken: ACCEPTER_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('gate_error');
    expect(gateShipClient.postStandup).not.toHaveBeenCalled();
  });

  it('returns 409 (gate_error) when the draft was already posted', async () => {
    const { draftStore, itemStore } = seededStores();
    draftStore.markPosted(DRAFT_ID, 'already posted text');
    const gateShipClient = fakeGateClient();
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });

    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('gate_error');
    expect(gateShipClient.postStandup).not.toHaveBeenCalled();
  });

  it('returns 502 (never a hang or a raw stack trace) when the Ship write itself fails', async () => {
    const { draftStore, itemStore } = seededStores();
    const gateShipClient = fakeGateClient();
    gateShipClient.postStandup.mockRejectedValueOnce(new Error('Ship unreachable'));
    const app = createServer(loadConfig(ACCEPT_DRAFT_CONFIG), { draftStore, itemStore, gateShipClient });

    const res = await request(app)
      .post('/accept-draft')
      .set('X-Internal-Secret', SECRET)
      .send({ draftId: DRAFT_ID, accepterToken: ACCEPTER_TOKEN });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('accept_draft_failed');
  });
});

describe('anthropicModelParams / buildAnthropicModel (TRO-368)', () => {
  // Requirement: "All outbound calls from the agent (to Ship APIs, LLM
  // providers, and any external tools) must implement explicit timeouts and
  // retry logic with exponential backoff." Ship API calls already had this
  // (resilientClient.ts); the LLM-provider call did not — `index.ts`
  // constructed `ChatAnthropic` with no `timeout`/`maxRetries`, silently
  // inheriting the SDK's own 10-minute timeout and AsyncCaller's 6-retry
  // default. This asserts the values actually reaching the constructor are
  // explicit and configured, not the library's own unexamined defaults.

  it('carries an explicit request timeout and retry count, not the library defaults', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_REQUEST_TIMEOUT_MS: '20000',
      ANTHROPIC_MAX_RETRIES: '2',
    });
    const params = anthropicModelParams(config);

    expect(params.clientOptions.timeout).toBe(20000);
    expect(params.maxRetries).toBe(2);
    // Neither is the library's own inherited default — the whole point of
    // this ticket is that those defaults (10 minutes; 6 retries) are wrong
    // for a call sitting inside a request handler.
    expect(params.clientOptions.timeout).not.toBe(600_000);
    expect(params.maxRetries).not.toBe(6);
  });

  it('reads the timeout and retry count from config, not a hardcoded literal', () => {
    // Different from the default-value test above: proves the params
    // function actually forwards whatever config carries, rather than
    // happening to match a hardcoded number that looks configurable.
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_REQUEST_TIMEOUT_MS: '9000',
      ANTHROPIC_MAX_RETRIES: '5',
    });
    const params = anthropicModelParams(config);

    expect(params.clientOptions.timeout).toBe(9000);
    expect(params.maxRetries).toBe(5);
  });

  it('builds a real ChatAnthropic instance whose own public clientOptions carries the explicit timeout', () => {
    // clientOptions is a public field on the constructed instance itself
    // (verified by reading @langchain/anthropic's chat_models.cjs — it is
    // assigned directly from the constructor's fields.clientOptions, never
    // defaulted away) — this is the one piece of the fix checkable on the
    // real object, not just on the plain params passed in. maxRetries is
    // consumed by @langchain/core's AsyncCaller into a `protected` field on
    // that instance, so it is asserted at the params layer above instead of
    // read back off the model here.
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_REQUEST_TIMEOUT_MS: '20000',
    });
    const model = buildAnthropicModel(config);

    expect(model.clientOptions.timeout).toBe(20000);
  });

  it('defaults to explicit, chosen values when neither env var is set — never an unset field left to the library', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' });
    const params = anthropicModelParams(config);

    expect(params.clientOptions.timeout).toBe(20_000);
    expect(params.maxRetries).toBe(2);
  });
});
