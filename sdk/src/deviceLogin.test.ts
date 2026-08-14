/**
 * `runDeviceLoginFlow` (PF-404, RFC 8628). Pure unit tests — `fetch` and
 * `sleep` are both stubbed, no real network, no real waits — deliberately so
 * the `slow_down` backoff proof below is fast and deterministic (same
 * "injected clock/wait, no real sleep" convention this repo already uses for
 * time-reasoning code, e.g. `api/src/platform/oauth/device.ts`'s own `now`
 * param). The genuinely end-to-end proof against a real running server lives
 * in `__tests__/client.deviceLogin.liveServer.test.ts` — this file is what
 * proves the ticket's specific AC that `slow_down` GENUINELY increases the
 * wait used for every subsequent poll, not just that the flow eventually
 * succeeds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDeviceLoginFlow } from './deviceLogin.js';
import { ShipSdkError } from './errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DEVICE_CODE_BODY = {
  device_code: 'devc_abc123',
  user_code: 'BDWJ-KXQT',
  verification_uri: 'http://example.com/oauth-device-verify',
  verification_uri_complete: 'http://example.com/oauth-device-verify?user_code=BDWJ-KXQT',
  expires_in: 600,
  interval: 5,
};

const TOKEN_SUCCESS_BODY = {
  access_token: 'ship_at_xyz',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'documents:read',
  refresh_token: 'ship_rt_xyz',
};

function requestPath(call: [string | URL | Request, RequestInit?]): string {
  return new URL(String(call[0])).pathname;
}

/** Guards `noUncheckedIndexedAccess` without a `!`/`as` (this repo's own
 * convention — see e.g. `client.test.ts`'s `firstCall` helper). */
function definedAt<T>(arr: readonly T[], index: number, label: string): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`expected a value at index ${index} (${label})`);
  return value;
}

describe('runDeviceLoginFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests a device code, calls onUserCode once with (user_code, verification_uri), then resolves with the tokens on immediate approval', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      if (pathname === '/oauth/token') return jsonResponse(TOKEN_SUCCESS_BODY);
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onUserCode = vi.fn();
    const sleep = vi.fn(async () => {});

    const tokens = await runDeviceLoginFlow({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_test',
      onUserCode,
      sleep,
    });

    expect(onUserCode).toHaveBeenCalledTimes(1);
    expect(onUserCode).toHaveBeenCalledWith('BDWJ-KXQT', 'http://example.com/oauth-device-verify');

    expect(tokens.accessToken).toBe('ship_at_xyz');
    expect(tokens.refreshToken).toBe('ship_rt_xyz');
    expect(tokens.scope).toBe('documents:read');

    // First call is the device-code request, second is the (immediately
    // successful) poll.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestPath(definedAt(fetchMock.mock.calls, 0, 'first fetch call'))).toBe('/oauth/device/code');
    expect(requestPath(definedAt(fetchMock.mock.calls, 1, 'second fetch call'))).toBe('/oauth/token');
    // No poll ever succeeded, so sleep was never needed.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls through authorization_pending, waiting the server-advertised interval each time', async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      pollCount += 1;
      if (pollCount < 3) {
        return jsonResponse({ error: 'authorization_pending', error_description: 'not yet' }, 400);
      }
      return jsonResponse(TOKEN_SUCCESS_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const tokens = await runDeviceLoginFlow({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_test',
      onUserCode: () => {},
      sleep,
    });

    expect(tokens.accessToken).toBe('ship_at_xyz');
    // Two authorization_pending polls, each followed by a wait at the
    // UNCHANGED 5s interval the server advertised.
    expect(sleepCalls).toEqual([5000, 5000]);
  });

  it('honors slow_down by GENUINELY increasing the wait for every subsequent poll — not retrying at the same cadence (this ticket\'s own AC)', async () => {
    // Poll sequence: pending, slow_down, slow_down, success.
    const responses = [
      { error: 'authorization_pending', error_description: 'not yet' },
      { error: 'slow_down', error_description: 'polled too soon' },
      { error: 'slow_down', error_description: 'polled too soon' },
    ];
    let pollIndex = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      if (pollIndex < responses.length) {
        const body = definedAt(responses, pollIndex, 'scripted poll response');
        pollIndex += 1;
        return jsonResponse(body, 400);
      }
      return jsonResponse(TOKEN_SUCCESS_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    await runDeviceLoginFlow({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_test',
      onUserCode: () => {},
      sleep,
    });

    // interval starts at 5000ms (server-advertised). authorization_pending
    // waits at the current interval unchanged. Each slow_down adds 5000ms
    // BEFORE the next wait — proving the increase is genuinely carried
    // forward to subsequent polls, not just acknowledged and discarded.
    expect(sleepCalls).toEqual([5000, 10000, 15000]);
    // Strictly increasing — the core of the AC.
    for (let i = 1; i < sleepCalls.length; i++) {
      expect(definedAt(sleepCalls, i, 'sleep call')).toBeGreaterThan(definedAt(sleepCalls, i - 1, 'previous sleep call'));
    }
  });

  it('rejects with a ShipSdkError when the user denies (access_denied)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'access_denied', error_description: 'The user denied the request.' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runDeviceLoginFlow({
        baseUrl: 'http://example.com',
        clientId: 'ship_app_test',
        onUserCode: () => {},
        sleep: async () => {},
      })
    ).rejects.toBeInstanceOf(ShipSdkError);
  });

  it('rejects when the device code expires server-side (expired_token)', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'expired_token', error_description: 'The device code has expired.' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runDeviceLoginFlow({
        baseUrl: 'http://example.com',
        clientId: 'ship_app_test',
        onUserCode: () => {},
        sleep: async () => {},
      })
    ).rejects.toThrow(/expired/);
  });

  it('bails out client-side once the injected clock passes the server-advertised expires_in, even with no server response yet', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'authorization_pending', error_description: 'not yet' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    let now = 0;
    const nowFn = () => now;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(
      runDeviceLoginFlow({
        baseUrl: 'http://example.com',
        clientId: 'ship_app_test',
        onUserCode: () => {},
        now: nowFn,
        sleep,
      })
    ).rejects.toThrow(/expired/);
  });

  it('surfaces a network failure (fetch throws) as a ShipSdkError with kind "network"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(
      runDeviceLoginFlow({
        baseUrl: 'http://example.com',
        clientId: 'ship_app_test',
        onUserCode: () => {},
        sleep: async () => {},
      })
    ).rejects.toMatchObject({ kind: 'network' });
  });
});
