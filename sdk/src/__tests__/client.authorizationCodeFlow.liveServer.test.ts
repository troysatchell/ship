/**
 * `ShipClient.authorizationCodeFlow()`'s redemption leg, proven against a
 * REAL running Ship API + the seeded worktree DB — same shape and same
 * cross-package-import rationale as `client.liveServer.test.ts` /
 * `client.deviceLogin.liveServer.test.ts` (see either file's header).
 *
 * The browser-navigation leg (leg 1: redirect to `/oauth/authorize`) and the
 * consent-screen hop in between are already proven elsewhere at the right
 * layer: `e2e/oauth-authorize.spec.ts` (PF-103) and
 * `e2e/oauth-pkce-chain.spec.ts` (TRO-597) drive a REAL browser through
 * login -> `/oauth/authorize` -> consent -> redirect-with-code, real Chromium,
 * via Playwright — a vitest unit/integration file has no browser to do that
 * with, and re-implementing a fake one here would prove nothing a mocked
 * `location`/`storage` (`authorizationCodeFlow.test.ts`, this package's own
 * unit suite) doesn't already cover for the CLIENT half of that hop. What
 * this file adds: `issueAuthorizationCode` (`api/src/platform/oauth/
 * authorize.js`, the exact function PF-103's own consent-approval route
 * calls) mints a REAL, single-use authorization code tied to a REAL PKCE
 * challenge, and this SDK's OWN token-exchange code (`exchangeCode` inside
 * `authorizationCodeFlow.ts`, reached via `runAuthorizationCodeFlow`'s "leg
 * 2") redeems it over a REAL HTTP round trip to `/oauth/token` — proving the
 * SDK's request shape, not just the server's, and proving both the
 * right-verifier success path and the mandatory wrong-verifier negative case
 * (this ticket's own instruction: "the mandatory negative case").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import in this package — see
// `client.liveServer.test.ts`'s header for why this exception exists.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';
import { issueAuthorizationCode } from '../../../api/src/platform/oauth/authorize.js';

import { generatePkcePair } from '../pkce.js';
import { runAuthorizationCodeFlow, type PkceLocation, type PkceStorage } from '../authorizationCodeFlow.js';
import { ShipSdkError } from '../errors.js';

class FakeStorage implements PkceStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class FakeLocation implements PkceLocation {
  constructor(public href: string) {}
  assign(url: string): void {
    this.href = url; // unused by leg 2, kept for interface completeness
  }
}

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

const REDIRECT_URI = 'https://client.example/callback';

describe('PF-404: authorizationCodeFlow() PKCE redemption end-to-end against a real running Ship API + the seeded worktree DB', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let userId: string | undefined;
  let appId: string;
  let clientId: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-404 authCodeFlow test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-404 AuthCodeFlow Test User', $2) RETURNING id`,
      [`pf404-authcodeflow-${runId}@ship.local`, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    clientId = `ship_app_pf404_pkce_${runId}`;
    const appResult = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'PF-404 PKCE Test Client', $2, 'public', $3, $4) RETURNING id`,
      [workspaceId, clientId, [REDIRECT_URI], ['documents:read']]
    );
    appId = insertedId(appResult.rows, 'oauth app');

    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    try {
      if (server) {
        const liveServer = server;
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
    } finally {
      try {
        if (workspaceId) {
          await pool.query(
            'DELETE FROM oauth_tokens WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query(
            'DELETE FROM oauth_authorization_codes WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [workspaceId]);
        }
        if (userId) {
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);

  it('redeems a real authorization code with the matching PKCE verifier and returns working, scoped tokens', async () => {
    const currentUserId = userId;
    if (!currentUserId) throw new Error('beforeAll should have set userId');

    const { codeVerifier, codeChallenge } = await generatePkcePair();

    const code = await issueAuthorizationCode({
      appId,
      userId: currentUserId,
      scopes: ['documents:read'],
      codeChallenge,
      redirectUri: REDIRECT_URI,
    });

    const storage = new FakeStorage();
    const state = 'live-server-state';
    storage.setItem(`ship_sdk_pkce_${state}`, JSON.stringify({ codeVerifier }));
    const location = new FakeLocation(`${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${state}`);

    const result = await runAuthorizationCodeFlow(
      { clientId, redirectUri: REDIRECT_URI, location, storage },
      baseUrl
    );

    expect(result.kind).toBe('redeemed');
    if (result.kind !== 'redeemed') throw new Error('expected redeemed');
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(result.tokens.scope).toBe('documents:read');

    // The token this SDK obtained actually works against a real protected
    // endpoint — not just "the server returned 200 with a plausible body."
    const meRes = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${result.tokens.accessToken}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { id: string } | null; scopes: string[] };
    expect(me.user?.id).toBe(currentUserId);
    expect(me.scopes).toEqual(['documents:read']);
  });

  // This ticket's own instruction: "the mandatory negative case" (mirroring
  // PLUGFORGE.MD §5's graded scenario, "PKCE e2e via Playwright + wrong-
  // verifier negative").
  it('a WRONG code_verifier is rejected with invalid_grant — the real server, not a stub, makes this call', async () => {
    const currentUserId = userId;
    if (!currentUserId) throw new Error('beforeAll should have set userId');

    const { codeChallenge } = await generatePkcePair();
    const { codeVerifier: wrongVerifier } = await generatePkcePair(); // a DIFFERENT, non-matching pair

    const code = await issueAuthorizationCode({
      appId,
      userId: currentUserId,
      scopes: ['documents:read'],
      codeChallenge,
      redirectUri: REDIRECT_URI,
    });

    const storage = new FakeStorage();
    const state = 'live-server-wrong-verifier-state';
    storage.setItem(`ship_sdk_pkce_${state}`, JSON.stringify({ codeVerifier: wrongVerifier }));
    const location = new FakeLocation(`${REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${state}`);

    const rejection = runAuthorizationCodeFlow({ clientId, redirectUri: REDIRECT_URI, location, storage }, baseUrl);
    await expect(rejection).rejects.toBeInstanceOf(ShipSdkError);
    await expect(rejection).rejects.toMatchObject({ kind: 'auth', httpStatus: 400 });
  });
});
