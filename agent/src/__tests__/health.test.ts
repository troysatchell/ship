import { describe, expect, it, vi } from 'vitest';
import { checkReady } from '../health.js';

describe('checkReady', () => {
  it('is not ready when config is incomplete, without making any network call', async () => {
    const fetchImpl = vi.fn();
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: false,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result).toEqual({ ready: false, reason: 'config_incomplete' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is ready when config is complete and Ship responds 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov/',
      configComplete: true,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result).toEqual({ ready: true, reason: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ship.example.gov/health',
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it('is not ready when Ship responds with a non-2xx status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: true,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result).toEqual({ ready: false, reason: 'ship_unhealthy_503' });
  });

  it('is not ready when the fetch rejects (Ship unreachable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkReady({
      shipApiBaseUrl: 'https://ship.example.gov',
      configComplete: true,
      timeoutMs: 1000,
      fetchImpl,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain('ship_unreachable');
    expect(result.reason).toContain('ECONNREFUSED');
  });
});
