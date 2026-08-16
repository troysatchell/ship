/**
 * `WebhooksClient` request-SHAPE tests — mocked `fetch`, NOT integration
 * tests, and deliberately labeled as such throughout this file.
 *
 * Historical note (PF-401): originally written when `/api/v1/webhooks*` had
 * no server route at all, so this file was this client's only coverage.
 * That is no longer true — every route this file exercises is real and
 * merged (PF-302/304/305/306, all landed; `resources/webhooks.ts`'s header
 * has the full history), and `sdk/src/__tests__/webhooks.liveServer.test.ts`
 * (added TRO-599; path corrected here — it lives directly under
 * `sdk/src/__tests__/`, not `sdk/src/resources/__tests__/`) now covers the
 * same client against a real running server and a real database, the same
 * pattern `documents`/`issues`/`sprints` already get in
 * `sdk/src/__tests__/resources.liveServer.test.ts`. This file's job is
 * unchanged and still distinct: proving `WebhooksClient` builds the exact
 * HTTP request (method, URL, query string, JSON body) and parses a
 * well-formed response back into the typed shape, cheaply and without a
 * database — a mocked-`fetch` request-shape test is a legitimate,
 * complementary thing to a live-server integration test, not a stand-in
 * for one that's since been added. Response bodies used as fixtures below
 * are the REAL shapes (TRO-599: verified against `serializeSubscription()`/
 * `serializeDelivery()`); `createSubscription()`'s REQUEST body is now the
 * REAL shape too (TRO-607/TRO-452 independently fixed the previously-
 * disclosed gap — see webhooks.ts's header for the full history).
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

describe('WebhooksClient — request shape only (no real server exists to integration-test against; see file header)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listSubscriptions() GETs /api/v1/webhooks with limit/cursor as query params', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.webhooks.listSubscriptions({ limit: 10, cursor: 'abc' });

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks?limit=10&cursor=abc');
    expect(init?.method).toBe('GET');
    expect(page).toEqual({ data: [], next_cursor: null });
  });

  it('listSubscriptions() omits query params entirely when called with no args', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.webhooks.listSubscriptions();

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks');
  });

  it('createSubscription() POSTs to /api/v1/webhooks with a JSON body and returns the shown-once secret', async () => {
    // Both response AND request shapes are the REAL ones now. Response:
    // TRO-599, verified against serializeSubscription() + the routes' own
    // `{ ...serialized, secret, warning }` construction — app_id/singular
    // event_type/target_url/no updated_at, plus `warning`. Request:
    // TRO-607/TRO-452 independently fixed the same gap (TRO-452 needed a
    // working createSubscription() to implement `ship webhooks tail`) —
    // app_id/singular event_type/target_url, per
    // `CreateWebhookSubscriptionRequestSchema`
    // (`platform/api/v1/resources/webhooks.ts`), replacing the old
    // `url`/plural-`events` shape that would 400 against a real server (see
    // webhooks.ts's header for the full history).
    const responseBody = {
      id: 'sub_1',
      app_id: 'app_1',
      event_type: 'document.created',
      target_url: 'https://example.com/hook',
      active: true,
      created_at: '2026-08-14T00:00:00.000Z',
      secret: 'whsec_abc123',
      warning: 'Save this secret now. It will not be shown again.',
    };
    const fetchSpy = fakeFetch(responseBody, 201);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    // Request body now matches the real server schema: app_id/singular
    // event_type/target_url. This mocked test proves the SDK builds the
    // correct HTTP request and parses the response correctly. A real UUID,
    // not a placeholder like 'app_1' — the real request schema requires
    // app_id to be a valid UUID (CodeRabbit, TRO-607 review), and this mock
    // should stay representative of what actually validates.
    const appId = '11111111-1111-4111-8111-111111111111';
    const created = await client.webhooks.createSubscription({
      app_id: appId,
      event_type: 'document.created',
      target_url: 'https://example.com/hook',
    });

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t', 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      app_id: appId,
      event_type: 'document.created',
      target_url: 'https://example.com/hook',
    });
    expect(created).toEqual(responseBody);
    expect(created.secret).toBe('whsec_abc123');
  });

  it('deleteSubscription() DELETEs /api/v1/webhooks/:id and resolves with no body', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => new Response(null, { status: 204 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await expect(client.webhooks.deleteSubscription('sub_1')).resolves.toBeUndefined();

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks/sub_1');
    expect(init?.method).toBe('DELETE');
  });

  it('getSubscription() GETs /api/v1/webhooks/:id and never returns a secret field', async () => {
    const responseBody = {
      id: 'sub_1',
      app_id: 'app_1',
      event_type: 'document.created',
      target_url: 'https://example.com/hook',
      active: true,
      created_at: '2026-08-14T00:00:00.000Z',
    };
    const fetchSpy = fakeFetch(responseBody);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const subscription = await client.webhooks.getSubscription('sub_1');

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks/sub_1');
    expect(init?.method).toBe('GET');
    expect(subscription).toEqual(responseBody);
    expect('secret' in subscription).toBe(false);
  });

  it('rotateSecret() POSTs to /api/v1/webhooks/:id/rotate with no body and returns the new plaintext secret', async () => {
    const responseBody = {
      id: 'sub_1',
      app_id: 'app_1',
      event_type: 'document.created',
      target_url: 'https://example.com/hook',
      active: true,
      created_at: '2026-08-14T00:00:00.000Z',
      secret: 'whsec_rotated456',
      warning: 'Save this secret now. It will not be shown again.',
    };
    const fetchSpy = fakeFetch(responseBody, 200);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const rotated = await client.webhooks.rotateSecret('sub_1');

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks/sub_1/rotate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(rotated.secret).toBe('whsec_rotated456');
  });

  it('listDeliveries() GETs /api/v1/webhooks/deliveries with subscription_id/status filters', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.webhooks.listDeliveries({ subscription_id: 'sub_1', status: 'failed' });

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks/deliveries?subscription_id=sub_1&status=failed');
  });

  it('replayDelivery() POSTs to /api/v1/webhooks/deliveries/:id/replay', async () => {
    // Real shape (TRO-599: verified against serializeDelivery()) — includes
    // event_id/idempotency_key/response_excerpt/next_attempt_at, and status
    // 'dead' rather than the old guessed 'dead_letter'. replayed_from_id set
    // (non-null on a replay row — PF-306/TRO-446).
    const responseBody = {
      id: 'del_2',
      subscription_id: 'sub_1',
      event_id: 'evt_1',
      event_type: 'document.created',
      idempotency_key: 'idem_1',
      attempt_number: 1,
      status: 'pending',
      response_status: null,
      response_excerpt: null,
      latency_ms: null,
      next_attempt_at: null,
      replayed_from_id: 'del_1',
      created_at: '2026-08-14T00:00:00.000Z',
    };
    const fetchSpy = fakeFetch(responseBody, 201);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const replayed = await client.webhooks.replayDelivery('del_1');

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/webhooks/deliveries/del_1/replay');
    expect(init?.method).toBe('POST');
    expect(replayed).toEqual(responseBody);
  });

  it('a non-2xx response still maps to a ShipSdkError through a resource client, same as ShipClient.me()', async () => {
    const fetchSpy = fakeFetch(
      { code: 'forbidden', message: 'missing scope', request_id: 'req_1' },
      403
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await expect(client.webhooks.listSubscriptions()).rejects.toMatchObject({
      kind: 'forbidden',
      httpStatus: 403,
    });
  });
});
