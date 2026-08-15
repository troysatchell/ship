/**
 * `runWhoami` unit tests — `fetch` fully mocked, no real server. Covers the
 * three states this ticket's AC implies: never logged in, a working token,
 * and a token the server rejects (e.g. expired/revoked) — the AC's "works"
 * is only meaningful if the failure paths are ALSO proven to behave (this
 * repo's own "check the negative space" convention, lessons.md rule 27).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from '@ship/sdk/node';
import { runWhoami } from './whoami.js';
import { createCapturingIo } from '../io.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ME_BODY = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' },
  app: null,
  scopes: ['documents:read', 'issues:read'],
};

let credentialsDir: string;
let credentialsPath: string;

beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-whoami-test-'));
  credentialsPath = join(credentialsDir, 'credentials.json');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(credentialsDir, { recursive: true, force: true });
});

describe('runWhoami', () => {
  it('reports "not logged in" and exits non-zero when no credentials file exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWhoami({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines).toHaveLength(1);
    expect(io.stderrLines[0]).toMatch(/Not logged in/);
    expect(io.stderrLines[0]).toContain(credentialsPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prints the identity for a working, previously-persisted token', async () => {
    await new FileTokenStore(credentialsPath).set({ accessToken: 'ship_at_ok', refreshToken: 'ship_rt_ok' });

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      expect(pathname).toBe('/api/v1/me');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer ship_at_ok');
      return jsonResponse(ME_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWhoami({ io, env: {}, credentialsPath });

    expect(code).toBe(0);
    expect(io.stdoutLines).toEqual(['Ada Lovelace <ada@example.com> — scopes: documents:read, issues:read']);
    expect(io.stderrLines).toEqual([]);
  });

  it('renders a rejected/expired token (server 401) as a non-zero exit', async () => {
    await new FileTokenStore(credentialsPath).set({ accessToken: 'ship_at_expired' });

    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'unauthorized', message: 'Access token expired.', request_id: 'req_1' }, 401)
    );
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWhoami({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines).toEqual(['Error [auth]: Access token expired. (HTTP 401)']);
  });

  it('reports a corrupt credentials file loudly rather than treating it as "not logged in"', async () => {
    await writeFile(credentialsPath, '{ not valid json', 'utf8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWhoami({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/invalid JSON/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
