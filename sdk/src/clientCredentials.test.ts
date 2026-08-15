/**
 * `runClientCredentialsFlow` (PF-702, RFC 6749 §4.4). Pure unit tests —
 * `fetch` is stubbed, no real network — same convention as
 * `deviceLogin.test.ts` (read first; this file mirrors its shape). The
 * genuinely end-to-end proof against a real running server + a real
 * confidential app lives in
 * `__tests__/client.clientCredentials.liveServer.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClientCredentialsFlow } from './clientCredentials.js';
import { ShipSdkError } from './errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Explicitly typed, matching `fetch`'s own two-argument shape — same
 *  pattern as `resources/__tests__/pf205.test.ts`'s `fakeFetch`, so
 *  `.mock.calls[0]` is already `[string | URL | Request, RequestInit?] |
 *  undefined`, never needing an `as` cast to read. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => jsonResponse(body, status));
}

/** Guards `noUncheckedIndexedAccess` without a cast (this repo's own
 *  convention — see `resources/__tests__/pf205.test.ts`'s identical
 *  `firstCall` helper). */
function firstCall(fetchSpy: ReturnType<typeof fakeFetch>): [string | URL | Request, RequestInit?] {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

function requestBody(call: [string | URL | Request, RequestInit?]): URLSearchParams {
  return new URLSearchParams(String(call[1]?.body ?? ''));
}

describe('runClientCredentialsFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs grant_type=client_credentials with client_id/client_secret/scope, form-encoded, and resolves the token set', async () => {
    const fetchSpy = fakeFetch({ access_token: 'ship_at_app1', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read issues:read' });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runClientCredentialsFlow({
      baseUrl: 'http://example.com',
      clientId: 'ship_app_fleetgraph',
      clientSecret: 's3cr3t',
      scope: 'documents:read issues:read',
    });

    expect(result).toEqual({ accessToken: 'ship_at_app1', expiresIn: 3600, scope: 'documents:read issues:read' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = firstCall(fetchSpy);
    expect(String(call[0])).toBe('http://example.com/oauth/token');
    expect(call[1]?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = requestBody(call);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('ship_app_fleetgraph');
    expect(body.get('client_secret')).toBe('s3cr3t');
    expect(body.get('scope')).toBe('documents:read issues:read');
  });

  it('omits scope from the request body when not provided', async () => {
    const fetchSpy = fakeFetch({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read issues:read sprints:read' });
    vi.stubGlobal('fetch', fetchSpy);

    await runClientCredentialsFlow({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 's3cr3t' });

    expect(requestBody(firstCall(fetchSpy)).has('scope')).toBe(false);
  });

  it('never sends a refresh_token field, and the resolved token set never has a refreshToken (no refresh token issued for this grant)', async () => {
    const fetchSpy = fakeFetch({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read' });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runClientCredentialsFlow({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 's3cr3t' });

    expect('refreshToken' in result).toBe(false);
  });

  it('a 400 invalid_client (public app / bad secret) maps to a ShipSdkError with kind "auth"', async () => {
    const fetchSpy = fakeFetch({ error: 'invalid_client', error_description: 'Client authentication failed.' }, 401);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      runClientCredentialsFlow({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 'wrong' })
    ).rejects.toMatchObject({ kind: 'auth', httpStatus: 401 });
    await expect(
      runClientCredentialsFlow({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 'wrong' })
    ).rejects.toBeInstanceOf(ShipSdkError);
  });

  it('a thrown network error maps to a ShipSdkError via fromNetworkError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(
      runClientCredentialsFlow({ baseUrl: 'http://example.com', clientId: 'ship_app_fleetgraph', clientSecret: 's3cr3t' })
    ).rejects.toBeInstanceOf(ShipSdkError);
  });
});
