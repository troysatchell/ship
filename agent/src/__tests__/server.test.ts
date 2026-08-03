import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';

const READY_CONFIG = {
  ANTHROPIC_API_KEY: 'sk-test',
  SHIP_API_BASE_URL: 'https://ship.example.gov',
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

  it('returns 503 when the Ship base URL is unreachable — asserted against a stable fake', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timeout'));
    const app = createServer(loadConfig(READY_CONFIG), { fetchImpl });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.reason).toContain('ship_unreachable');
  });

  it('returns 200 when config is complete and Ship is reachable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const app = createServer(loadConfig(READY_CONFIG), { fetchImpl });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });
});
