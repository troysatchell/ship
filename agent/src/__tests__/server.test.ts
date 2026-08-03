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
