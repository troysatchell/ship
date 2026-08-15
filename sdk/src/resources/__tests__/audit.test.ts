/**
 * `AuditClient` request-SHAPE tests — mocked `fetch`, same technique and
 * same "explicitly labeled as such" convention `webhooks.test.ts` uses (see
 * that file's header). The end-to-end proof against a real server lives in
 * `sdk/src/__tests__/audit.liveServer.test.ts`; this file only proves
 * `AuditClient.list()` builds the HTTP request PF-501's server route
 * expects (method, URL, query string) and parses a well-formed response
 * back into the typed `AuditRowList` shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipClient } from '../../client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    jsonResponse(body, status)
  );
}

function firstCall(fetchSpy: ReturnType<typeof fakeFetch>): [string | URL | Request, RequestInit?] {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

describe('AuditClient — request shape only (see file header; audit.liveServer.test.ts has the real-server proof)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list() GETs /api/v1/audit with no query params when called with no args', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.audit.list();

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/audit');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t' });
    expect(page).toEqual({ data: [], next_cursor: null });
  });

  it('list() passes limit/cursor/app_client_id as query params', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.audit.list({ limit: 10, cursor: 'abc', app_client_id: 'ship_app_xyz' });

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/audit?limit=10&cursor=abc&app_client_id=ship_app_xyz');
  });

  it('list() parses a real audit-row shape back into typed fields', async () => {
    const row = {
      id: 'row_1',
      request_id: 'req_1',
      app_client_id: 'ship_app_xyz',
      user_id: null,
      method: 'GET',
      route: '/api/v1/documents',
      scope_used: 'documents:read',
      status: 200,
      latency_ms: 12,
      created_at: '2026-08-14T00:00:00.000Z',
    };
    const fetchSpy = fakeFetch({ data: [row], next_cursor: 'opaque-cursor' });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.audit.list();

    expect(page.data).toEqual([row]);
    expect(page.next_cursor).toBe('opaque-cursor');
  });

  it('list() rejects with a ShipSdkError (kind: forbidden) on a 403 (missing scope, or authenticated but not admin/owner)', async () => {
    const fetchSpy = fakeFetch(
      { code: 'forbidden', message: 'Missing required scope: audit:read', request_id: 'req_2' },
      403
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await expect(client.audit.list()).rejects.toMatchObject({ kind: 'forbidden', httpStatus: 403 });
  });
});
