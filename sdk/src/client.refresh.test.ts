/**
 * Refresh-on-401 with a single-flight mutex, and transparent refresh-token
 * rotation (PF-404's own AC, verbatim: "refresh rotation transparent to
 * caller" + "a genuine concurrency test proving only ONE refresh call
 * fires"). Pure unit tests — `fetch` is stubbed; no real network, no real
 * server. The real-server proof of the underlying rotation mechanics
 * (single-use, family invalidation) is PF-105's own `token.test.ts` /
 * PF-800's drill — this file is scoped to what belongs to the SDK: that the
 * CLIENT behaves correctly under concurrency and across a rotation, given a
 * server that behaves per that contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipClient } from './client.js';
import { MemoryTokenStore } from './tokenStore.js';
import { ShipSdkError } from './errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function meBody(scopes: string[] = ['issues:read']) {
  return { user: { id: 'u1', email: 'a@b.com', name: 'A' }, app: null, scopes };
}

describe('ShipClient refresh-on-401', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on a single 401, transparently refreshes and retries the original request once', async () => {
    let meCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/me') {
        meCalls += 1;
        if (meCalls === 1) return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
        return jsonResponse(meBody());
      }
      if (pathname === '/oauth/token') {
        refreshCalls += 1;
        return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'issues:read' });
      }
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenStore = new MemoryTokenStore();
    await tokenStore.set({ accessToken: 'stale-access', refreshToken: 'refresh-1' });

    const client = new ShipClient({ baseUrl: 'http://example.com', clientId: 'ship_app_x', tokenStore });

    const me = await client.me();

    expect(me.scopes).toEqual(['issues:read']);
    expect(meCalls).toBe(2); // original 401, then the retry
    expect(refreshCalls).toBe(1);

    // The rotated tokens were persisted, not just held in memory.
    expect(await tokenStore.get()).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  });

  it('SINGLE-FLIGHT: N concurrent requests that all 401 at once trigger exactly ONE refresh call, not N', async () => {
    const CONCURRENCY = 6;
    let meCalls = 0;
    let refreshCalls = 0;
    let refreshHasResolved = false;
    const refreshRequestBodies: string[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;

      if (pathname === '/api/v1/me') {
        meCalls += 1;
        if (!refreshHasResolved) {
          return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
        }
        return jsonResponse(meBody());
      }

      if (pathname === '/oauth/token') {
        refreshCalls += 1;
        refreshRequestBodies.push(String(init?.body));
        // A small real delay so the concurrent `.me()` calls' first 401s
        // genuinely all land BEFORE this resolves, rather than the
        // single-flight guarantee being trivially true just because nothing
        // ever overlapped. The guarantee itself comes from
        // `refreshOnce()`'s promise memoization, not from this timing — this
        // just makes the test a real concurrency exercise rather than an
        // accidental one.
        await new Promise((resolve) => setTimeout(resolve, 15));
        refreshHasResolved = true;
        return jsonResponse({
          access_token: 'rotated-access-1',
          refresh_token: 'rotated-refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'issues:read',
        });
      }

      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenStore = new MemoryTokenStore();
    await tokenStore.set({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    const client = new ShipClient({ baseUrl: 'http://example.com', clientId: 'ship_app_x', tokenStore });

    const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => client.me()));

    for (const result of results) {
      expect(result.scopes).toEqual(['issues:read']);
    }

    // The core proof: exactly one refresh POST went out despite 6 concurrent
    // callers all hitting 401.
    expect(refreshCalls).toBe(1);
    // Every caller still got its own 401 THEN its own successful retry.
    expect(meCalls).toBe(CONCURRENCY * 2);

    const refreshBody = new URLSearchParams(refreshRequestBodies[0] ?? '');
    expect(refreshBody.get('refresh_token')).toBe('refresh-1');
  }, 10_000);

  it('ROTATION IS TRANSPARENT: after a refresh rotates the token, a LATER independent 401 refreshes again using the NEW refresh token, not the original', async () => {
    let meCallCount = 0;
    let meShouldFail = true;
    const refreshRequestBodies: string[] = [];
    let refreshCallCount = 0;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;

      if (pathname === '/api/v1/me') {
        meCallCount += 1;
        if (meShouldFail) {
          return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: `r${meCallCount}` }, 401);
        }
        return jsonResponse(meBody());
      }

      if (pathname === '/oauth/token') {
        refreshCallCount += 1;
        refreshRequestBodies.push(String(init?.body));
        meShouldFail = false;
        return jsonResponse({
          access_token: `rotated-access-${refreshCallCount}`,
          refresh_token: `rotated-refresh-${refreshCallCount}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'issues:read',
        });
      }

      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenStore = new MemoryTokenStore();
    await tokenStore.set({ accessToken: 'stale-access', refreshToken: 'original-refresh' });
    const client = new ShipClient({ baseUrl: 'http://example.com', clientId: 'ship_app_x', tokenStore });

    // First 401 wave -> first refresh, using the ORIGINAL refresh token.
    await client.me();
    expect(refreshCallCount).toBe(1);
    const firstRefreshBody = new URLSearchParams(refreshRequestBodies[0] ?? '');
    expect(firstRefreshBody.get('refresh_token')).toBe('original-refresh');

    // Simulate the access token expiring again later — a second, INDEPENDENT
    // 401 wave (not concurrent with the first).
    meShouldFail = true;
    await client.me();

    // A second refresh fired, and — the whole point — it used the ROTATED
    // token from the first refresh, not the original (which the server would
    // have already revoked on reuse per PF-105's family-invalidation rule).
    expect(refreshCallCount).toBe(2);
    const secondRefreshBody = new URLSearchParams(refreshRequestBodies[1] ?? '');
    expect(secondRefreshBody.get('refresh_token')).toBe('rotated-refresh-1');
  });

  it('with no clientId configured, a 401 is never treated as refreshable — falls straight through as before this ticket (backward compatibility)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const tokenStore = new MemoryTokenStore();
    await tokenStore.set({ accessToken: 'stale-access', refreshToken: 'refresh-1' });
    // No clientId — refresh has nothing to authenticate the grant as.
    const client = new ShipClient({ baseUrl: 'http://example.com', tokenStore });

    await expect(client.me()).rejects.toBeInstanceOf(ShipSdkError);
    await expect(client.me()).rejects.toMatchObject({ kind: 'auth', httpStatus: 401 });
    // Only the direct /api/v1/me calls — never attempted /oauth/token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('when refresh itself fails (revoked/expired refresh token), the refresh failure is surfaced rather than silently retried', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/me') {
        return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
      }
      if (pathname === '/oauth/token') {
        return jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token has already been used.' }, 400);
      }
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokenStore = new MemoryTokenStore();
    await tokenStore.set({ accessToken: 'stale-access', refreshToken: 'reused-refresh' });
    const client = new ShipClient({ baseUrl: 'http://example.com', clientId: 'ship_app_x', tokenStore });

    await expect(client.me()).rejects.toMatchObject({ kind: 'auth' });
  });
});
