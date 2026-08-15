/**
 * `runLogin` unit tests — `fetch` is fully mocked (no real network, no real
 * server), and `sleep`/`now` are injected no-ops so the polling loop below
 * runs with zero real wall-clock time. This is what proves the CLI's OWN
 * wiring (prints exactly the AC's user_code + verify URL, persists via
 * `FileTokenStore` at 0600, renders each failure path, returns the right
 * exit code) — `@ship/sdk`'s own `deviceLogin.test.ts` already proves RFC
 * 8628 protocol correctness (slow_down backoff, expiry, etc.) at the SDK
 * layer, so this file does not re-prove that; it proves the CLI does the
 * right thing GIVEN a device flow that succeeds, is denied, expires, or
 * never reaches the server. `src/__tests__/login.liveServer.test.ts`
 * additionally proves this command works against a REAL server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from './login.js';
import { createCapturingIo } from '../io.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DEVICE_CODE_BODY = {
  device_code: 'devc_abc123',
  user_code: 'BDWJ-KXQT',
  verification_uri: 'http://example.com/oauth-device-verify',
  verification_uri_complete: 'http://example.com/oauth-device-verify?user_code=BDWJ-KXQT',
  expires_in: 600,
  interval: 5,
};

const TOKEN_SUCCESS_BODY = {
  access_token: 'ship_at_xyz',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'documents:read',
  refresh_token: 'ship_rt_xyz',
};

const ME_BODY = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' },
  app: { id: 'app1', client_id: 'ship_cli_test', name: 'Ship CLI', is_first_party: true },
  scopes: ['documents:read'],
};

let credentialsDir: string;
let credentialsPath: string;

beforeEach(async () => {
  credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-login-test-'));
  credentialsPath = join(credentialsDir, 'nested', 'credentials.json');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(credentialsDir, { recursive: true, force: true });
});

// `io` is deliberately excluded from `overrides`'s type (every call site
// wants its OWN fresh capturing `Io` to assert against, never a caller-
// supplied one) — spreading a `Partial<RunLoginOptions>` that COULD include
// `io` after an explicit `io: createCapturingIo()` widens the inferred
// property type to `Io | (Io & {stdoutLines, stderrLines})`, and property
// access on that union loses `stdoutLines`/`stderrLines` under `tsc`
// (verified: this exact shape failed `pnpm --filter @ship/cli type-check`
// before this comment was written).
function baseOpts(
  overrides: Partial<Omit<Parameters<typeof runLogin>[0], 'io'>> = {}
): Parameters<typeof runLogin>[0] & { io: ReturnType<typeof createCapturingIo> } {
  return {
    io: createCapturingIo(),
    env: { SHIP_CLI_CLIENT_ID: 'ship_cli_test' },
    credentialsPath,
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runLogin', () => {
  it('prints the user_code and verification URL, polls through authorization_pending, then persists tokens at 0600', async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      if (pathname === '/oauth/token') {
        pollCount += 1;
        // Auto-approved on the SECOND poll — proves the loop actually polls
        // more than once (mirrors the repo's established "auto-approve via
        // API" test convention: the server approves mid-flight, not on the
        // very first request).
        if (pollCount < 2) return jsonResponse({ error: 'authorization_pending' }, 400);
        return jsonResponse(TOKEN_SUCCESS_BODY);
      }
      if (pathname === '/api/v1/me') return jsonResponse(ME_BODY);
      throw new Error(`unexpected fetch to ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const opts = baseOpts();
    const code = await runLogin(opts);

    expect(code).toBe(0);
    expect(opts.io.stdoutLines).toEqual([
      'To authorize this CLI, open: http://example.com/oauth-device-verify',
      'And enter the code: BDWJ-KXQT',
      'Waiting for authorization...',
      'Logged in as Ada Lovelace <ada@example.com> via app "Ship CLI" (ship_cli_test) — scopes: documents:read.',
      `Credentials saved to ${credentialsPath}.`,
    ]);
    expect(opts.io.stderrLines).toEqual([]);
    expect(pollCount).toBe(2);
    // `sleep` was injected as a no-op, so the loop above ran with no real
    // wall-clock wait — this test asserts that happened at all, not just
    // that it eventually would.
    expect(opts.sleep).toHaveBeenCalled();

    const raw = await readFile(credentialsPath, 'utf8');
    const persisted: unknown = JSON.parse(raw);
    expect(persisted).toMatchObject({ accessToken: 'ship_at_xyz', refreshToken: 'ship_rt_xyz' });

    // The mode-bit assertion this ticket's own instructions require be
    // tested for real, not asserted decoratively: read the actual mode back
    // off disk and check the low 9 bits are exactly rw for owner, nothing
    // for group/other.
    const stats = await stat(credentialsPath);
    expect((stats.mode & 0o777).toString(8)).toBe('600');
  });

  it('fails fast with no OAuth client id configured (before ever calling fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const opts = baseOpts({ env: {}, clientId: undefined });
    const code = await runLogin(opts);

    expect(code).toBe(1);
    expect(opts.io.stderrLines).toHaveLength(1);
    expect(opts.io.stderrLines[0]).toMatch(/SHIP_CLI_CLIENT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(stat(credentialsPath)).rejects.toThrow();
  });

  it('renders access_denied (a human declined the request) as a non-zero exit with no credentials written', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'access_denied', error_description: 'The user denied the request.' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    const opts = baseOpts();
    const code = await runLogin(opts);

    expect(code).toBe(1);
    expect(opts.io.stderrLines).toEqual(['Error [auth]: The user denied the request.']);
    await expect(stat(credentialsPath)).rejects.toThrow();
  });

  it('renders expired_token as a non-zero exit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/oauth/device/code') return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'expired_token', error_description: 'The device code has expired.' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    const code = await runLogin(baseOpts());
    expect(code).toBe(1);
  });

  it('renders a network failure (fetch throws) as a non-zero exit with a "network" kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const opts = baseOpts();
    const code = await runLogin(opts);

    expect(code).toBe(1);
    expect(opts.io.stderrLines).toEqual(['Error [network]: fetch failed']);
  });
});
