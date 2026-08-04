import { describe, expect, it, vi } from 'vitest';
import { checkReady, type ShipReadClient } from '../health.js';

describe('checkReady', () => {
  it('is not ready when config is incomplete, without making any network call', async () => {
    const client: ShipReadClient = { get: vi.fn() };
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: false,
      client,
    });

    expect(result).toEqual({ ready: false, reason: 'config_incomplete' });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('is ready when config is complete and the client resolves', async () => {
    const client: ShipReadClient = { get: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) };
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov/',
      configComplete: true,
      client,
    });

    expect(result).toEqual({ ready: true, reason: 'ok' });
    expect(client.get).toHaveBeenCalledWith('https://ship.example.gov/health');
  });

  it('is not ready when the client resolves with a non-ok response (e.g. Ship returning 503)', async () => {
    const client: ShipReadClient = { get: vi.fn().mockResolvedValue(new Response(null, { status: 503 })) };
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: true,
      client,
    });

    expect(result.ready).toBe(false);
  });

  it('is not ready when the client rejects (Ship unreachable, breaker open, timeout, etc.)', async () => {
    const client: ShipReadClient = { get: vi.fn().mockRejectedValue(new Error("I can't reach Ship right now.")) };
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: true,
      client,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain('ship_unreachable');
    expect(result.reason).toContain("I can't reach Ship right now.");
  });
});
