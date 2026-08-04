import { describe, expect, it, vi } from 'vitest';
import { GateShipClient, ShipApiError, ShipClient, plainTextToTipTapDoc } from '../shipClient.js';

function fakeClient(response: Response) {
  return { get: vi.fn().mockResolvedValue(response) };
}

describe('ShipClient', () => {
  it('getChangeFeed builds the URL with since/limit and sends a Bearer token', async () => {
    const client = fakeClient(
      new Response(JSON.stringify({ next_cursor: 'x', documents: [], history: [], comments: [] }), { status: 200 })
    );
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov/', token: 'tok-123', client });

    await ship.getChangeFeed('2026-01-01T00:00:00.000Z', 50);

    expect(client.get).toHaveBeenCalledWith(
      'https://ship.example.gov/api/change-feed?since=2026-01-01T00%3A00%3A00.000Z&limit=50',
      { headers: { Authorization: 'Bearer tok-123' } }
    );
  });

  it('getChangeFeed omits limit when not provided', async () => {
    const client = fakeClient(
      new Response(JSON.stringify({ next_cursor: 'x', documents: [], history: [], comments: [] }), { status: 200 })
    );
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok', client });

    await ship.getChangeFeed('2026-01-01T00:00:00.000Z');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).not.toContain('limit');
  });

  it('getDocument fetches /api/documents/:id and returns the parsed body', async () => {
    const doc = { id: 'doc-1', document_type: 'issue', title: 'Test', content: null, visibility: 'workspace', created_by: 'u1', properties: {} };
    const client = fakeClient(new Response(JSON.stringify(doc), { status: 200 }));
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok', client });

    const result = await ship.getDocument('doc-1');

    expect(client.get).toHaveBeenCalledWith('https://ship.example.gov/api/documents/doc-1', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(result).toEqual(doc);
  });

  it('getPeople fetches /api/team/people', async () => {
    const people = [{ id: 'p1', user_id: 'u1', name: 'Alice Chen', email: null, isArchived: false, isPending: false, reportsTo: null, role: null }];
    const client = fakeClient(new Response(JSON.stringify(people), { status: 200 }));
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok', client });

    const result = await ship.getPeople();

    expect(client.get).toHaveBeenCalledWith('https://ship.example.gov/api/team/people', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(result).toEqual(people);
  });

  it('listDocuments builds the URL with type/limit and sends a Bearer token (TRO-319 / FG-6)', async () => {
    const client = fakeClient(new Response(JSON.stringify([]), { status: 200 }));
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok-abc', client });

    await ship.listDocuments('standup', 500);

    expect(client.get).toHaveBeenCalledWith('https://ship.example.gov/api/documents?type=standup&limit=500', {
      headers: { Authorization: 'Bearer tok-abc' },
    });
  });

  it('listDocuments omits limit when not provided and returns the parsed body', async () => {
    const rows = [{ id: 'standup-1', document_type: 'standup', properties: { author_id: 'user-a' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }];
    const client = fakeClient(new Response(JSON.stringify(rows), { status: 200 }));
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok', client });

    const result = await ship.listDocuments('standup');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).not.toContain('limit');
    expect(result).toEqual(rows);
  });

  it('throws ShipApiError on a non-ok response rather than returning an error body as data', async () => {
    const client = fakeClient(new Response(JSON.stringify({ error: 'Document not found' }), { status: 404 }));
    const ship = new ShipClient({ baseUrl: 'https://ship.example.gov', token: 'tok', client });

    await expect(ship.getDocument('missing')).rejects.toBeInstanceOf(ShipApiError);
  });
});

// TRO-321 / FG-8 — the gate's write-capable client. Deliberately a SEPARATE
// describe block, same posture as the class itself being separate from
// `ShipClient`: see `shipClient.ts`'s "gate's write-capable client" section.
describe('GateShipClient', () => {
  function fakeRequestClient(response: Response) {
    return { request: vi.fn().mockResolvedValue(response) };
  }

  it('postStandup POSTs /api/standups with the CALLER-SUPPLIED token, never a stored one', async () => {
    const created = {
      id: 'standup-1',
      title: 'Tuesday Aug 4 Standup',
      document_type: 'standup',
      content: null,
      properties: { author_id: 'user-a', date: '2026-08-04' },
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:00:00.000Z',
    };
    const client = fakeRequestClient(new Response(JSON.stringify(created), { status: 201 }));
    const gate = new GateShipClient({ baseUrl: 'https://ship.example.gov', client });

    const result = await gate.postStandup('accepter-token', '2026-08-04');

    expect(client.request).toHaveBeenCalledWith('https://ship.example.gov/api/standups', {
      method: 'POST',
      headers: { Authorization: 'Bearer accepter-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-04' }),
    });
    expect(result).toEqual(created);
  });

  it('the SAME client instance uses whichever token is passed per call — no stickiness to a prior call\'s token', async () => {
    const body = JSON.stringify({
      id: 's1',
      title: 't',
      document_type: 'standup',
      content: null,
      properties: {},
      created_at: 'x',
      updated_at: 'x',
    });
    // A fresh Response per call — a Fetch Response body can only be read
    // once, and reusing one instance across two `.request()` calls would
    // throw on the second `.json()` regardless of which token was used.
    const client = { request: vi.fn(() => Promise.resolve(new Response(body, { status: 201 }))) };
    const gate = new GateShipClient({ baseUrl: 'https://ship.example.gov', client });

    await gate.postStandup('token-for-alice', '2026-08-04');
    await gate.postStandup('token-for-bob', '2026-08-05');

    const headers = (client.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers.Authorization
    );
    expect(headers).toEqual(['Bearer token-for-alice', 'Bearer token-for-bob']);
  });

  it('setStandupContent PATCHes /api/standups/:id with a TipTap doc built from the text', async () => {
    const updated = {
      id: 'standup-1',
      title: 't',
      document_type: 'standup',
      content: null,
      properties: {},
      created_at: 'x',
      updated_at: 'y',
    };
    const client = fakeRequestClient(new Response(JSON.stringify(updated), { status: 200 }));
    const gate = new GateShipClient({ baseUrl: 'https://ship.example.gov', client });

    await gate.setStandupContent('accepter-token', 'standup-1', 'Line one.\nLine two.');

    expect(client.request).toHaveBeenCalledWith('https://ship.example.gov/api/standups/standup-1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer accepter-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Line one.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Line two.' }] },
          ],
        },
      }),
    });
  });

  it('applyIssueTransition PATCHes /api/issues/:id with only { state }, never automated_by', async () => {
    const client = fakeRequestClient(new Response(JSON.stringify({ id: 'issue-1' }), { status: 200 }));
    const gate = new GateShipClient({ baseUrl: 'https://ship.example.gov', client });

    await gate.applyIssueTransition('accepter-token', 'issue-1', 'in_review');

    expect(client.request).toHaveBeenCalledWith('https://ship.example.gov/api/issues/issue-1', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer accepter-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'in_review' }),
    });
  });

  it('throws ShipApiError on a non-ok response', async () => {
    const client = fakeRequestClient(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    const gate = new GateShipClient({ baseUrl: 'https://ship.example.gov', client });

    await expect(gate.postStandup('tok', '2026-08-04')).rejects.toBeInstanceOf(ShipApiError);
  });
});

describe('plainTextToTipTapDoc', () => {
  it('converts one line per paragraph, and a blank line into an empty paragraph', () => {
    expect(plainTextToTipTapDoc('First.\n\nThird.')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Third.' }] },
      ],
    });
  });
});
