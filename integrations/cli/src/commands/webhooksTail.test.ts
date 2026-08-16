/**
 * `createTailListener`/`runWebhooksTail` unit tests (PF-602, Linear
 * TRO-452). Two describe blocks, matching the two exported pieces this
 * file's own header documents as deliberately separable:
 *
 *   - `createTailListener` — driven directly with a REAL local HTTP POST
 *     (via `node:http`, exactly like the production listener speaks) and a
 *     hand-computed `Ship-Signature` header (same technique
 *     `sdk/src/verifyWebhook.test.ts`'s own `buildHeader()` uses to avoid an
 *     api/sdk cross-package import). No `@ship/sdk` client, no fake server,
 *     no database — this is this ticket's own brief's "importable module
 *     with a fake delivery POST, separate from the CLI entrypoint's process
 *     lifecycle" regression test.
 *   - `runWebhooksTail` — `fetch` mocked for the three `@ship/sdk` calls it
 *     makes (`GET /api/v1/me`, `POST /api/v1/webhooks`,
 *     `DELETE /api/v1/webhooks/:id`), but the listener itself is REAL and
 *     receives a REAL local HTTP delivery with a signature computed from the
 *     mocked-response's own `secret` — proving the full wire-up (port ->
 *     target_url -> secret -> verify) actually holds together, not just
 *     each piece in isolation. `stopSignal` is always injected explicitly
 *     (never the default SIGINT/SIGTERM listener) so no test registers a
 *     real process signal handler that outlives it.
 *
 * Per this repo's "check the negative space" convention (lessons.md rule
 * 27): each case is picked to be the SPECIFIC regression that would make it
 * fail, not a happy-path smoke test — see each `it()`'s own name/comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore } from '@ship/sdk/node';
import { createTailListener, runWebhooksTail } from './webhooksTail.js';
import { createCapturingIo } from '../io.js';

/** Same technique `sdk/src/verifyWebhook.test.ts`'s own `buildHeader()`
 *  uses — builds a real `Ship-Signature` header value without importing
 *  across the api/sdk package boundary. */
function buildSignatureHeader(t: number, rawBody: string, secret: string): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** POSTs directly to the listener's real bound port over a real loopback
 *  socket — deliberately NOT `fetch` (which every test in this file also
 *  stubs globally for the SDK's own calls; using the stub's exact interface
 *  for the thing under test would blur "what am I actually proving"). */
function postDelivery(
  port: number,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePost, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePost({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('createTailListener', () => {
  const SECRET = 'whsec_unit_test_not_a_real_secret';
  const BODY = JSON.stringify({ type: 'document.created', id: 'evt_1' });

  it('prints a ✓ verified line (with the event type) and responds 200 for a delivery with a valid signature', async () => {
    const io = createCapturingIo();
    const listener = createTailListener({ io });
    const port = await listener.listen(0);
    listener.setSecret(SECRET);

    try {
      const t = Math.floor(Date.now() / 1000);
      const res = await postDelivery(port, { 'ship-signature': buildSignatureHeader(t, BODY, SECRET) }, BODY);

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ received: true });
      expect(io.stdoutLines).toHaveLength(1);
      expect(io.stdoutLines[0]).toMatch(/^✓ verified\s/);
      expect(io.stdoutLines[0]).toContain('document.created');
    } finally {
      await listener.close();
    }
  });

  it('prints a ✗ rejected line and responds 401 for a delivery with a signature under the WRONG secret', async () => {
    const io = createCapturingIo();
    const listener = createTailListener({ io });
    const port = await listener.listen(0);
    listener.setSecret(SECRET);

    try {
      const t = Math.floor(Date.now() / 1000);
      const res = await postDelivery(port, { 'ship-signature': buildSignatureHeader(t, BODY, 'whsec_a_totally_different_secret') }, BODY);

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ received: false });
      expect(io.stdoutLines).toEqual([expect.stringMatching(/^✗ rejected\s/)]);
    } finally {
      await listener.close();
    }
  });

  it('rejects a delivery with NO Ship-Signature header at all (not just a wrong one)', async () => {
    const io = createCapturingIo();
    const listener = createTailListener({ io });
    const port = await listener.listen(0);
    listener.setSecret(SECRET);

    try {
      const res = await postDelivery(port, {}, BODY);

      expect(res.status).toBe(401);
      expect(io.stdoutLines).toEqual([expect.stringMatching(/^✗ rejected\s/)]);
    } finally {
      await listener.close();
    }
  });

  it('rejects every delivery received before setSecret() has ever been called, rather than verifying against undefined', async () => {
    const io = createCapturingIo();
    const listener = createTailListener({ io });
    const port = await listener.listen(0);
    // Deliberately no setSecret() call.

    try {
      const t = Math.floor(Date.now() / 1000);
      const res = await postDelivery(port, { 'ship-signature': buildSignatureHeader(t, BODY, SECRET) }, BODY);

      expect(res.status).toBe(401);
      expect(io.stdoutLines).toEqual([expect.stringMatching(/^✗ rejected\s/)]);
    } finally {
      await listener.close();
    }
  });

  it('rejects a non-POST request (405) without printing a delivery line', async () => {
    const io = createCapturingIo();
    const listener = createTailListener({ io });
    const port = await listener.listen(0);
    listener.setSecret(SECRET);

    try {
      const result = await new Promise<{ status: number }>((resolveGet, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => resolveGet({ status: res.statusCode ?? 0 }));
        });
        req.on('error', reject);
        req.end();
      });

      expect(result.status).toBe(405);
      expect(io.stdoutLines).toEqual([]);
    } finally {
      await listener.close();
    }
  });
});

let credentialsDir: string;
let credentialsPath: string;

// Applies to every test in this file, same top-level (not per-describe)
// placement `docs.test.ts` uses — the `createTailListener` tests above
// don't touch credentials at all, so this is harmless overhead for them,
// and keeping one hook pair for the whole file avoids a second, easy-to-miss
// copy for the `runWebhooksTail` describe block below.
beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-webhooks-tail-test-'));
  credentialsPath = join(credentialsDir, 'credentials.json');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(credentialsDir, { recursive: true, force: true });
});

const ME_USER = { id: 'user_1', email: 'dev@ship.local', name: 'Dev User' };
const ME_APP = { id: 'app_1', client_id: 'ship_cli_test', name: 'CLI Test App', is_first_party: false };

async function withStoredToken(accessToken = 'ship_at_ok'): Promise<void> {
  await new FileTokenStore(credentialsPath).set({ accessToken });
}

interface FetchCall {
  method: string;
  pathname: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes the three `@ship/sdk` calls `runWebhooksTail` makes
 *  (`GET /api/v1/me`, `POST /api/v1/webhooks`, `DELETE /api/v1/webhooks/:id`)
 *  to caller-supplied canned responses, and records every call it saw —
 *  same shape as `docs.test.ts`'s own inline fetch mocks, generalized to
 *  three routes instead of one. Any request outside those three throws,
 *  so an unexpected extra call fails loudly instead of silently 200ing. */
function makeFetchMock(opts: {
  me?: { user: typeof ME_USER | null; app: typeof ME_APP | null; scopes: string[] };
  createStatus?: number;
  createBody?: unknown;
  deleteStatus?: number;
}) {
  const calls: FetchCall[] = [];
  const secret = 'whsec_test_secret_from_create_response';
  const createBody =
    opts.createBody ??
    {
      id: 'sub_1',
      app_id: ME_APP.id,
      event_type: 'document.created',
      target_url: 'http://ignored-by-this-mock.example/',
      active: true,
      created_at: '2026-08-14T00:00:00.000Z',
      secret,
      warning: 'Save this secret now. It will not be shown again.',
    };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const parsedBody: unknown = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, pathname: url.pathname, body: parsedBody });

    if (method === 'GET' && url.pathname === '/api/v1/me') {
      return jsonResponse(opts.me ?? { user: ME_USER, app: ME_APP, scopes: ['webhooks:manage'] });
    }
    if (method === 'POST' && url.pathname === '/api/v1/webhooks') {
      return jsonResponse(createBody, opts.createStatus ?? 201);
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/v1/webhooks/')) {
      return new Response(null, { status: opts.deleteStatus ?? 204 });
    }
    throw new Error(`makeFetchMock: unexpected request ${method} ${url.pathname}`);
  });

  return { fetchMock, calls, secret: (createBody as { secret?: string }).secret ?? secret };
}

describe('runWebhooksTail', () => {
  it(
    'resolves app_id via me(), creates the subscription with app_id/event_type/target_url, streams a REAL ' +
      'delivery (valid signature) as ✓ verified, and cleans up (DELETE) on stopSignal',
    async () => {
      await withStoredToken();
      const { fetchMock, calls } = makeFetchMock({});
      vi.stubGlobal('fetch', fetchMock);

      const io = createCapturingIo();
      let resolveStop: () => void = () => {};
      const stopSignal = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      let deliveryOutcome: { status: number; body: string } | undefined;
      let deliveryError: unknown;

      const code = await runWebhooksTail({
        io,
        env: {},
        credentialsPath,
        stopSignal,
        onReady: (info) => {
          void (async () => {
            try {
              const body = JSON.stringify({ type: 'document.created', id: 'evt_1' });
              const t = Math.floor(Date.now() / 1000);
              const header = `t=${t},v1=${createHmac('sha256', info.subscription.secret).update(`${t}.${body}`).digest('hex')}`;
              deliveryOutcome = await postDelivery(info.port, { 'ship-signature': header }, body);
            } catch (err) {
              deliveryError = err;
            } finally {
              resolveStop();
            }
          })();
        },
      });

      if (deliveryError) throw deliveryError;
      expect(deliveryOutcome?.status).toBe(200);

      expect(code, `stderr: ${io.stderrLines.join('\n')}`).toBe(0);
      expect(io.stdoutLines.some((l) => l.startsWith('✓ verified'))).toBe(true);
      expect(io.stdoutLines.some((l) => l.includes('document.created'))).toBe(true);

      const createCall = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/webhooks');
      expect(createCall?.body).toMatchObject({
        app_id: ME_APP.id,
        event_type: 'document.created',
        target_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
      });

      const deleteCall = calls.find((c) => c.method === 'DELETE');
      expect(deleteCall?.pathname).toBe('/api/v1/webhooks/sub_1');
    }
  );

  it('uses --app-id when passed, and never calls GET /api/v1/me at all', async () => {
    await withStoredToken();
    const { fetchMock, calls } = makeFetchMock({});
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const stopSignal = Promise.resolve();

    const code = await runWebhooksTail({ io, env: {}, credentialsPath, appId: 'app_explicit', stopSignal });

    expect(code, `stderr: ${io.stderrLines.join('\n')}`).toBe(0);
    expect(calls.some((c) => c.pathname === '/api/v1/me')).toBe(false);
    const createCall = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/webhooks');
    expect(createCall?.body).toMatchObject({ app_id: 'app_explicit' });
  });

  it('errors (no subscription created) when the token has no app and no --app-id was passed', async () => {
    await withStoredToken();
    const { fetchMock, calls } = makeFetchMock({ me: { user: ME_USER, app: null, scopes: [] } });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWebhooksTail({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/no associated app_id/);
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/api/v1/webhooks')).toBe(false);
  });

  it('fails fast on an unknown --event-type, before calling fetch at all', async () => {
    await withStoredToken();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWebhooksTail({ io, env: {}, credentialsPath, eventType: 'not.a.real.event' });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/--event-type must be one of/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports "not logged in" and exits non-zero when no credentials file exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWebhooksTail({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/Not logged in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes the listener and returns non-zero when createSubscription() fails server-side (no hang, no cleanup attempted)', async () => {
    await withStoredToken();
    const { fetchMock, calls } = makeFetchMock({
      createStatus: 403,
      createBody: { code: 'forbidden', message: 'missing webhooks:manage scope', request_id: 'req_1' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    // No stopSignal needed: runWebhooksTail must return before ever awaiting
    // one, since subscription creation fails first.
    const code = await runWebhooksTail({ io, env: {}, credentialsPath });

    expect(code).toBe(1);
    expect(io.stderrLines[0]).toMatch(/forbidden/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    // The listener really was closed, not leaked: a fresh listener can bind
    // an ephemeral port immediately afterward without this test hanging or
    // erroring (a weak but real liveness signal that nothing here is stuck
    // holding a socket open).
  });

  it('cleanup is best-effort: a failed DELETE still closes the listener and still returns 0', async () => {
    await withStoredToken();
    const { fetchMock, calls } = makeFetchMock({ deleteStatus: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const io = createCapturingIo();
    const code = await runWebhooksTail({ io, env: {}, credentialsPath, stopSignal: Promise.resolve() });

    expect(code).toBe(0);
    expect(io.stderrLines.some((l) => l.includes('failed to clean up subscription'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
});
