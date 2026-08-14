/**
 * PF-205 (Linear TRO-414) — request-SHAPE tests for the new SDK methods
 * this ticket adds: `documents.getAssociations/getReverseAssociations/
 * getBacklinks/getComments`, `sprints.get`, `people.list/iterate`,
 * `changes.list`. Same mocked-`fetch` technique as
 * `resources/__tests__/webhooks.test.ts` (see that file's header for why a
 * request-shape test is a legitimate, distinct thing from a live-server
 * integration test) — chosen here over extending
 * `__tests__/resources.liveServer.test.ts` because these seven methods
 * already have real server-side regression coverage
 * (`api/src/platform/api/v1/resources/__tests__/{documents,sprints,people,
 * changes}.test.ts`, added in this same ticket); this file's job is proving
 * the SDK builds the right request and parses the right response shape, not
 * re-proving server behavior a sibling suite already covers.
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

describe('PF-205: new SDK methods — request shape (mocked fetch; real server behavior covered by api-side tests)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('documents.getAssociations() GETs /documents/:id/associations with limit/cursor', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.documents.getAssociations('doc-1', { limit: 5, cursor: 'abc' });

    const [url, init] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/documents/doc-1/associations?limit=5&cursor=abc');
    expect(init?.method).toBe('GET');
    expect(page).toEqual({ data: [], next_cursor: null });
  });

  it('documents.getReverseAssociations() GETs /documents/:id/reverse-associations', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.documents.getReverseAssociations('doc-1');

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/documents/doc-1/reverse-associations');
  });

  it('documents.getBacklinks() GETs /documents/:id/backlinks and parses display_id', async () => {
    const backlink = { id: 'src-1', document_type: 'issue', title: 'Linking issue', display_id: '#42' };
    const fetchSpy = fakeFetch({ data: [backlink], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.documents.getBacklinks('doc-1');

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/documents/doc-1/backlinks');
    expect(page.data[0]).toEqual(backlink);
  });

  it('documents.getComments() GETs /documents/:id/comments', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.documents.getComments('doc-1', { limit: 10 });

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/documents/doc-1/comments?limit=10');
  });

  it('sprints.get() GETs /sprints/:id and parses the cadence fields', async () => {
    const sprintDetail = {
      id: 'sprint-1',
      title: 'Sprint 1',
      document_type: 'sprint',
      properties: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      sprint_number: 1,
      owner_id: 'user-1',
      status: 'active',
      workspace_sprint_start_date: '2026-01-05',
      start_date: '2026-01-05',
      end_date: '2026-01-11',
    };
    const fetchSpy = fakeFetch(sprintDetail);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const result = await client.sprints.get('sprint-1');

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/sprints/sprint-1');
    expect(result).toEqual(sprintDetail);
  });

  it('people.list() GETs /people with limit/cursor', async () => {
    const fetchSpy = fakeFetch({ data: [], next_cursor: null });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    await client.people.list({ limit: 20, cursor: 'xyz' });

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/people?limit=20&cursor=xyz');
  });

  it('people.iterate() walks every page via list(), never exposing a cursor', async () => {
    const page1 = { data: [{ id: 'p1' }], next_cursor: 'c1' };
    const page2 = { data: [{ id: 'p2' }], next_cursor: null };
    const fetchSpy = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const seen: string[] = [];
    for await (const person of client.people.iterate()) {
      seen.push((person as { id: string }).id);
    }

    expect(seen).toEqual(['p1', 'p2']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallUrl = fetchSpy.mock.calls[1]?.[0];
    expect(String(secondCallUrl)).toContain('cursor=c1');
  });

  it('changes.list() GETs /changes with since/limit; since is required at the type level', async () => {
    const responseBody = {
      data: [{ resource: 'document', dedupe_key: 'document:d1:2026-01-01T00:00:00.000Z', id: 'd1', document_type: 'wiki', title: 'x', updated_at: '2026-01-01T00:00:00.000Z', created_by: null }],
      next_cursor: '2026-01-01T00:00:05.000Z',
      truncated: { documents: false, document_history: false, comments: false },
    };
    const fetchSpy = fakeFetch(responseBody);
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ShipClient({ token: 't', baseUrl: 'http://example.com' });

    const page = await client.changes.list({ since: '2026-01-01T00:00:00.000Z', limit: 50 });

    const [url] = firstCall(fetchSpy);
    expect(url).toBe('http://example.com/api/v1/changes?since=2026-01-01T00%3A00%3A00.000Z&limit=50');
    expect(page).toEqual(responseBody);
    expect(page.data[0]?.resource).toBe('document');
  });
});
