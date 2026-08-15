/**
 * PF-702 (TRO-428) — regression test for a real gap found while wiring the
 * agent's `getIssuesByAssignee` through this SDK: `IssuesClient.list()`
 * never forwarded `assignee_id`, even though the server
 * (`ListIssuesQuerySchema`, `api/src/platform/api/v1/resources/issues.ts`)
 * has accepted that query param since PF-205. See `types.ts`'s
 * `ListIssuesParams` doc comment and CHANGES.md (TRO-428) for the full
 * finding. Same mocked-fetch request-shape technique as
 * `resources/__tests__/pf205.test.ts` (real server-side coverage for the
 * `assignee_id` filter itself lives in
 * `api/src/platform/api/v1/resources/__tests__/issues.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShipClient } from '../../client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Same explicitly-typed-mock pattern as `resources/__tests__/pf205.test.ts`'s
 *  `fakeFetch`/`firstCall` — avoids an `as` cast on `.mock.calls[0]`. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => jsonResponse(body, status));
}

function firstCall(fetchSpy: ReturnType<typeof fakeFetch>): [string | URL | Request, RequestInit?] {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call;
}

describe('IssuesClient.list() assignee_id (PF-702 fix)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards assignee_id as a query param when provided', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.issues.list({ assignee_id: 'user-123', limit: 10 });

    expect(String(firstCall(fetchSpy)[0])).toBe('http://example.com/api/v1/issues?limit=10&assignee_id=user-123');
  });

  it('omits assignee_id entirely when not provided (not the literal string "undefined")', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.issues.list({ limit: 10 });

    expect(String(firstCall(fetchSpy)[0])).not.toContain('assignee_id');
  });
});
