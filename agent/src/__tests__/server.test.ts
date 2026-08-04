import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import type { ShipReadClient } from '../health.js';

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

    expect(graph.invoke).toHaveBeenCalledWith({
      trigger: 'on_demand',
      input: VALID_BODY.question,
      seedDocumentId: VALID_BODY.seedDocumentId,
      askingUserId: VALID_BODY.askingUserId,
    });
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
});
