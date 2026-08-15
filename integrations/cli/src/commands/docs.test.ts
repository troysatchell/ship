/**
 * `runDocsLs`/`runDocsGet`/`runDocsCreate` unit tests — `fetch` fully
 * mocked, no real server. `src/__tests__/docs.liveServer.test.ts` proves the
 * create -> get round trip against a REAL running Ship API; this file proves
 * each command's OWN wiring (loads a stored token, calls the right
 * `DocumentsClient` method, renders success/failure via `Io`/`formatError`,
 * returns the right exit code) given a server that behaves a given way.
 *
 * Per this repo's "check the negative space" convention (lessons.md rule
 * 27), each case below is picked to be the SPECIFIC regression that would
 * make it fail — not just a happy-path smoke test:
 *   - the empty-list case catches a version of `runDocsLs` that only handles
 *     `count > 0` and silently prints nothing when there's genuinely
 *     nothing to list;
 *   - the two-page case catches a version that called `list()` once instead
 *     of `iterate()` (PF-601's own AC: cursors stay internal) — it would
 *     only print page 1's items and never issue the second request;
 *   - "missing --title" and "empty --title" catch a version of
 *     `runDocsCreate` that let a falsy title reach `client.documents.create`
 *     and rely on the server's `validation_failed` alone — asserted via
 *     `fetchMock` never being called, the same "fails fast" proof
 *     `login.test.ts` uses for a missing client id;
 *   - "not logged in" catches a version of `loadClient` that constructs a
 *     `ShipClient` with `token: undefined` instead of stopping first — the
 *     bug would surface as a generic 401 from the server, not this file's
 *     own clear message;
 *   - the malformed/404 and network/server-error cases catch a version that
 *     forgot to route SDK errors through `formatError`, or dropped the
 *     non-zero exit code on a caught error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from '@ship/sdk/node';
import { runDocsCreate, runDocsGet, runDocsLs } from './docs.js';
import { createCapturingIo } from '../io.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DOC_A = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Alpha',
  document_type: 'wiki',
  properties: {},
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const DOC_B = {
  id: '22222222-2222-2222-2222-222222222222',
  title: 'Beta',
  document_type: 'issue',
  properties: { priority: 'high' },
  created_at: '2026-08-02T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
};

let credentialsDir: string;
let credentialsPath: string;

beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-docs-test-'));
  credentialsPath = join(credentialsDir, 'credentials.json');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(credentialsDir, { recursive: true, force: true });
});

async function withStoredToken(accessToken = 'ship_at_ok'): Promise<void> {
  await new FileTokenStore(credentialsPath).set({ accessToken });
}

describe('runDocsLs', () => {
  it('prints one line per document, tab-separated (id, type, title)', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/documents');
      return jsonResponse({ data: [DOC_A, DOC_B], next_cursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(0);
    expect(io.stdoutLines).toEqual([
      `${DOC_A.id}\twiki\tAlpha`,
      `${DOC_B.id}\tissue\tBeta`,
    ]);
    expect(io.stderrLines).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prints "No documents found." for an empty workspace, not silence', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(0);
    expect(io.stdoutLines).toEqual(['No documents found.']);
  });

  it('pages internally via iterate() — a second page is fetched and its cursor never printed', async () => {
    await withStoredToken();
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestCount += 1;
      if (requestCount === 1) {
        expect(url.searchParams.get('cursor')).toBeNull();
        return jsonResponse({ data: [DOC_A], next_cursor: 'opaque-cursor-1' });
      }
      expect(url.searchParams.get('cursor')).toBe('opaque-cursor-1');
      return jsonResponse({ data: [DOC_B], next_cursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(io.stdoutLines).toEqual([`${DOC_A.id}\twiki\tAlpha`, `${DOC_B.id}\tissue\tBeta`]);
    expect(io.stdoutLines.join('\n')).not.toContain('opaque-cursor-1');
  });

  it('reports "not logged in" and exits non-zero when no credentials file exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a network failure (fetch throws) as a non-zero exit with a "network" kind', async () => {
    await withStoredToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [network]: fetch failed']);
  });

  it('renders a server error (HTTP 500) as a non-zero exit with the mapped kind and status', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'server_error', message: 'Something broke.', request_id: 'req_1' }, 500)
    );
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsLs({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [server]: Something broke. (HTTP 500)']);
  });
});

describe('runDocsGet', () => {
  it('fetches and prints a document by id', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/api/v1/documents/${DOC_A.id}`);
      return jsonResponse(DOC_A);
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsGet({ io, env: {}, credentialsPath, id: DOC_A.id });

    expect(code).toBe(0);
    expect(io.stdoutLines).toEqual([
      [
        `id: ${DOC_A.id}`,
        'title: Alpha',
        'document_type: wiki',
        `created_at: ${DOC_A.created_at}`,
        `updated_at: ${DOC_A.updated_at}`,
        'properties: {}',
      ].join('\n'),
    ]);
    expect(io.stderrLines).toEqual([]);
  });

  it('renders a malformed/nonexistent id as a non-zero exit (server maps both to not_found)', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'not_found', message: 'Document not found.', request_id: 'req_2' }, 404)
    );
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsGet({ io, env: {}, credentialsPath, id: 'does-not-exist' });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [not_found]: Document not found. (HTTP 404)']);
  });

  it('reports "not logged in" and exits non-zero when no credentials file exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsGet({ io, env: {}, credentialsPath, id: DOC_A.id });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a network failure (fetch throws) as a non-zero exit', async () => {
    await withStoredToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const io = createCapturingIo();
    const code = await runDocsGet({ io, env: {}, credentialsPath, id: DOC_A.id });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [network]: fetch failed']);
  });
});

describe('runDocsCreate', () => {
  it('creates a document with the given title and prints it', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/documents');
      expect(init?.method).toBe('POST');
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toEqual({ title: 'Alpha' });
      return jsonResponse(DOC_A, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: 'Alpha' });

    expect(code).toBe(0);
    expect(io.stdoutLines[0]).toBe('Created document.');
    expect(io.stdoutLines[1]).toContain(`id: ${DOC_A.id}`);
    expect(io.stderrLines).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast with no --title (before ever calling fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: undefined });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error: --title is required.']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an empty --title the same as omitted (before ever calling fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: '' });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error: --title is required.']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a server-side validation_failed as a non-zero exit with rendered ApiError', async () => {
    await withStoredToken();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { code: 'validation_failed', message: 'The request could not be validated.', request_id: 'req_3' },
        400
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: 'Alpha' });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [validation]: The request could not be validated. (HTTP 400)']);
  });

  it('reports "not logged in" and exits non-zero when no credentials file exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: 'Alpha' });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a network failure (fetch throws) as a non-zero exit', async () => {
    await withStoredToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const io = createCapturingIo();
    const code = await runDocsCreate({ io, env: {}, credentialsPath, title: 'Alpha' });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [network]: fetch failed']);
  });
});
