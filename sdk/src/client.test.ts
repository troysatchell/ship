/**
 * `ShipClient` construction + request-wiring unit tests. Pure — `fetch` is
 * stubbed (`vi.stubGlobal`), no real network, no real server. This does NOT
 * stand in for the AC's "against a running server" requirement — that's
 * `sdk/src/__tests__/client.liveServer.test.ts`. This file exists to cover a
 * gap those files don't: the constructor's own logic (no I/O, baseUrl
 * trimming/defaulting, `Authorization` header presence) in isolation, fast
 * and deterministic, including `stripTrailingSlashes`'s behavior — the
 * function a GitHub CodeQL `js/polynomial-redos` alert flagged when it was
 * still `.replace(/\/+$/, '')` (verified as a false positive — that regex is
 * linear, not polynomial — before rewriting it as a plain loop; see
 * client.ts's own comment). This suite is what actually exercises the
 * rewritten behavior, which had no direct test coverage before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const EMPTY_ME_BODY = { user: null, app: null, scopes: [] };

function fakeFetch(body: unknown = EMPTY_ME_BODY, status = 200) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    jsonResponse(body, status)
  );
}

function firstCall(fetchSpy: ReturnType<typeof fakeFetch>): [string | URL | Request, RequestInit?] {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

describe('ShipClient construction and request wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('constructor performs no I/O — fetch is never called just by constructing', () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trims one or more trailing slashes from an explicit baseUrl', async () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't', baseUrl: 'http://example.com///' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/me');
  });

  it('leaves a baseUrl with no trailing slash unchanged', async () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't', baseUrl: 'http://example.com' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/me');
  });

  it('a baseUrl that is ALL trailing slashes trims to empty, not an error', async () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't', baseUrl: '////' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('/api/v1/me');
  });

  it('defaults to http://localhost:3000 when baseUrl is omitted and SHIP_API_BASE_URL is unset', async () => {
    vi.stubEnv('SHIP_API_BASE_URL', '');
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://localhost:3000/api/v1/me');
  });

  it('reads SHIP_API_BASE_URL when baseUrl is omitted (agent/src/config.ts convention)', async () => {
    vi.stubEnv('SHIP_API_BASE_URL', 'http://ship-env-default.example/');
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://ship-env-default.example/api/v1/me');
  });

  it('an explicit baseUrl takes priority over SHIP_API_BASE_URL', async () => {
    vi.stubEnv('SHIP_API_BASE_URL', 'http://from-env.example');
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 't', baseUrl: 'http://from-opts.example' }).me();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://from-opts.example/api/v1/me');
  });

  it('sends a Bearer Authorization header when a token is provided', async () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ token: 'abc123', baseUrl: 'http://example.com' }).me();

    const [, init] = firstCall(fetchSpy);
    expect(init?.headers).toEqual({ Authorization: 'Bearer abc123' });
  });

  it('omits the Authorization header entirely when no token is provided', async () => {
    const fetchSpy = fakeFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await new ShipClient({ baseUrl: 'http://example.com' }).me();

    const [, init] = firstCall(fetchSpy);
    expect(init?.headers).toEqual({});
  });

  it('me() returns the parsed JSON body typed as Me on a 200 response', async () => {
    const body = { user: { id: 'u1', email: 'a@b.com', name: 'A' }, app: null, scopes: ['issues:read'] };
    const fetchSpy = fakeFetch(body);
    vi.stubGlobal('fetch', fetchSpy);

    const me = await new ShipClient({ token: 't', baseUrl: 'http://example.com' }).me();

    expect(me).toEqual(body);
  });
});
