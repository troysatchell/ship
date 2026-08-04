import { describe, expect, it, vi } from 'vitest';
import { ShipApiError, ShipClient } from '../shipClient.js';

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
