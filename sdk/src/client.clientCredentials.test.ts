/**
 * `ShipClient.clientCredentials()` (PF-702) — construction, and
 * reauthenticate-on-401 with a single-flight mutex. Pure unit tests, same
 * shape as `client.refresh.test.ts` (read first — this mirrors it, adapted
 * for a grant with no refresh token: re-auth re-runs the ORIGINAL
 * client_credentials request instead of a `grant_type=refresh_token` one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipClient } from './client.js';
import { ShipSdkError } from './errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function meBody(scopes: string[] = ['documents:read']) {
  return { user: null, app: { id: 'app-1', client_id: 'ship_app_fleetgraph', name: 'FleetGraph Agent', is_first_party: true }, scopes };
}

function tokenSuccessBody(accessToken: string, scope = 'documents:read') {
  return { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope };
}

describe('ShipClient.clientCredentials()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints a token via client_credentials and constructs a working ShipClient', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/token') return jsonResponse(tokenSuccessBody('app-token-1'));
      if (pathname === '/api/v1/me') return jsonResponse(meBody());
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await ShipClient.clientCredentials({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_fleetgraph',
      clientSecret: 's3cr3t',
      scope: 'documents:read',
    });

    const me = await client.me();
    expect(me.app?.client_id).toBe('ship_app_fleetgraph');
    expect(me.user).toBeNull();
  });

  it('on a 401, transparently re-authenticates (re-running client_credentials, not refresh_token) and retries once', async () => {
    let meCalls = 0;
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/me') {
        meCalls += 1;
        if (meCalls === 1) return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
        return jsonResponse(meBody());
      }
      if (pathname === '/oauth/token') {
        tokenCalls += 1;
        const body = new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('refresh_token')).toBeNull();
        return jsonResponse(tokenSuccessBody(`app-token-${tokenCalls}`));
      }
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await ShipClient.clientCredentials({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_fleetgraph',
      clientSecret: 's3cr3t',
    });
    expect(tokenCalls).toBe(1); // the initial mint

    const me = await client.me();

    expect(me.app?.client_id).toBe('ship_app_fleetgraph');
    expect(meCalls).toBe(2); // original 401, then the retry
    expect(tokenCalls).toBe(2); // initial mint + one re-auth
  });

  it('SINGLE-FLIGHT: N concurrent requests that all 401 at once trigger exactly ONE re-auth call, not N', async () => {
    const CONCURRENCY = 6;
    let meCalls = 0;
    let tokenCalls = 0;
    let reauthHasResolved = false;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;

      if (pathname === '/api/v1/me') {
        meCalls += 1;
        if (!reauthHasResolved) {
          return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
        }
        return jsonResponse(meBody());
      }

      if (pathname === '/oauth/token') {
        tokenCalls += 1;
        if (tokenCalls === 1) return jsonResponse(tokenSuccessBody('app-token-initial'));
        // A small real delay so the concurrent `.me()` calls' first 401s
        // genuinely all land BEFORE this resolves — same technique
        // client.refresh.test.ts's identical concurrency test uses.
        await new Promise((resolve) => setTimeout(resolve, 15));
        reauthHasResolved = true;
        return jsonResponse(tokenSuccessBody('app-token-reauth'));
      }

      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await ShipClient.clientCredentials({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 's3cr3t' });
    expect(tokenCalls).toBe(1);

    const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => client.me()));

    for (const result of results) {
      expect(result.app?.client_id).toBe('ship_app_fleetgraph');
    }
    // Exactly one re-auth POST despite 6 concurrent callers all hitting 401.
    expect(tokenCalls).toBe(2); // initial mint + exactly one re-auth
    expect(meCalls).toBe(CONCURRENCY * 2);
  }, 10_000);

  it('when re-auth itself fails (secret rotated/revoked), the failure is surfaced rather than silently retried', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/me') return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // First call succeeds (mints the initial token); THEN stub reauth to fail.
    const initialFetch = vi.fn(async () => jsonResponse(tokenSuccessBody('app-token-1')));
    vi.stubGlobal('fetch', initialFetch);
    const client = await ShipClient.clientCredentials({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 's3cr3t' });

    const failingFetch = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/me') return jsonResponse({ code: 'unauthorized', message: 'expired', request_id: 'r1' }, 401);
      if (pathname === '/oauth/token') return jsonResponse({ error: 'invalid_client', error_description: 'Client authentication failed.' }, 401);
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', failingFetch);

    await expect(client.me()).rejects.toMatchObject({ kind: 'auth' });
    await expect(client.me()).rejects.toBeInstanceOf(ShipSdkError);
  });
});
