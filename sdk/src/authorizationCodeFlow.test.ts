/**
 * `runAuthorizationCodeFlow` (PF-404, RFC 7636/6749 PKCE). Pure unit tests
 * with injected `location`/`storage` doubles — no real browser, no real
 * network for the redirect leg. The redemption leg's real HTTP exchange
 * against a genuinely running server is proven separately in
 * `__tests__/client.authorizationCodeFlow.liveServer.test.ts` (mints a real
 * authorization code via `issueAuthorizationCode`, same as PF-103/PF-104's
 * own backend tests) — this file is what proves the CLIENT-side mechanics:
 * URL construction, PKCE storage/retrieval keyed by `state`, and the
 * two-leg dispatch logic itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAuthorizationCodeFlow, type PkceLocation, type PkceStorage } from './authorizationCodeFlow.js';
import { ShipSdkError } from './errors.js';

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
  get size(): number {
    return this.data.size;
  }
}

class FakeLocation implements PkceLocation {
  href: string;
  readonly assigned: string[] = [];
  constructor(href: string) {
    this.href = href;
  }
  assign(url: string): void {
    this.assigned.push(url);
    // Deliberately does NOT actually navigate — a real browser would tear
    // down the JS context here; this double lets the test observe what
    // would have happened instead.
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('runAuthorizationCodeFlow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('leg 1 — no code in the current URL', () => {
    it('generates a PKCE pair, stores the verifier keyed by a fresh state, and redirects to /oauth/authorize with the right query params', async () => {
      const location = new FakeLocation('https://app.example/callback');
      const storage = new FakeStorage();

      const result = await runAuthorizationCodeFlow(
        {
          clientId: 'ship_app_demo',
          redirectUri: 'https://app.example/callback',
          scope: 'documents:read issues:read',
          location,
          storage,
        },
        'http://api.example'
      );

      expect(result.kind).toBe('redirected');
      expect(location.assigned).toHaveLength(1);

      const assignedUrl = new URL(location.assigned[0] ?? '');
      expect(assignedUrl.origin + assignedUrl.pathname).toBe('http://api.example/oauth/authorize');
      expect(assignedUrl.searchParams.get('response_type')).toBe('code');
      expect(assignedUrl.searchParams.get('client_id')).toBe('ship_app_demo');
      expect(assignedUrl.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
      expect(assignedUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(assignedUrl.searchParams.get('scope')).toBe('documents:read issues:read');

      const state = assignedUrl.searchParams.get('state');
      const codeChallenge = assignedUrl.searchParams.get('code_challenge');
      expect(state).toBeTruthy();
      expect(codeChallenge).toBeTruthy();

      // The verifier was stored under a key derivable from `state`, and
      // never appears in the URL itself (only its S256 challenge does).
      expect(storage.size).toBe(1);
    });

    it('never resolves synchronously in a way a caller could mistake for success — the ShipClient static wrapper depends on this never settling in a real browser', async () => {
      const location = new FakeLocation('https://app.example/callback');
      const storage = new FakeStorage();

      const result = await runAuthorizationCodeFlow(
        { clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback', location, storage },
        'http://api.example'
      );

      // In THIS test we await the promise (the double doesn't hang forever
      // the way a real `location.assign` navigation would) — asserting the
      // discriminated result instead is what proves the two-leg contract.
      expect(result.kind).toBe('redirected');
    });
  });

  describe('leg 2 — code + state present in the current URL', () => {
    it('exchanges the code using the stored verifier and resolves with tokens', async () => {
      const storage = new FakeStorage();
      storage.setItem('ship_sdk_pkce_teststate', JSON.stringify({ codeVerifier: 'stored-verifier-value' }));
      const location = new FakeLocation('https://app.example/callback?code=authcode123&state=teststate');

      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('authcode123');
        expect(body.get('code_verifier')).toBe('stored-verifier-value');
        expect(body.get('client_id')).toBe('ship_app_demo');
        expect(body.get('redirect_uri')).toBe('https://app.example/callback');
        return jsonResponse({
          access_token: 'ship_at_pkce',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'documents:read',
          refresh_token: 'ship_rt_pkce',
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await runAuthorizationCodeFlow(
        { clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback', location, storage },
        'http://api.example'
      );

      expect(result.kind).toBe('redeemed');
      if (result.kind !== 'redeemed') throw new Error('expected redeemed');
      expect(result.tokens.accessToken).toBe('ship_at_pkce');
      expect(result.tokens.refreshToken).toBe('ship_rt_pkce');

      // The one-time verifier is consumed — a second exchange attempt with
      // the same state must not find it again.
      expect(storage.getItem('ship_sdk_pkce_teststate')).toBeNull();
    });

    it('persists the redeemed tokens to tokenStore when one is provided', async () => {
      const storage = new FakeStorage();
      storage.setItem('ship_sdk_pkce_teststate', JSON.stringify({ codeVerifier: 'v' }));
      const location = new FakeLocation('https://app.example/callback?code=authcode123&state=teststate');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({ access_token: 'ship_at_pkce', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read' })
        )
      );

      const setCalls: unknown[] = [];
      const tokenStore = {
        get: async () => null,
        set: async (tokens: unknown) => {
          setCalls.push(tokens);
        },
        clear: async () => {},
      };

      await runAuthorizationCodeFlow(
        { clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback', location, storage, tokenStore },
        'http://api.example'
      );

      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]).toMatchObject({ accessToken: 'ship_at_pkce' });
    });

    it('rejects with a ShipSdkError when no matching stored verifier is found for the state (expired/tampered flow)', async () => {
      const storage = new FakeStorage();
      const location = new FakeLocation('https://app.example/callback?code=authcode123&state=unknownstate');

      await expect(
        runAuthorizationCodeFlow(
          { clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback', location, storage },
          'http://api.example'
        )
      ).rejects.toBeInstanceOf(ShipSdkError);
    });

    it('surfaces a wrong-verifier server rejection (invalid_grant) as a ShipSdkError', async () => {
      const storage = new FakeStorage();
      storage.setItem('ship_sdk_pkce_teststate', JSON.stringify({ codeVerifier: 'wrong-verifier' }));
      const location = new FakeLocation('https://app.example/callback?code=authcode123&state=teststate');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ error: 'invalid_grant', error_description: 'code_verifier does not match' }, 400))
      );

      await expect(
        runAuthorizationCodeFlow(
          { clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback', location, storage },
          'http://api.example'
        )
      ).rejects.toMatchObject({ kind: 'auth', httpStatus: 400 });
    });
  });

  it('throws a clear error when no location/storage is available and none was injected (non-browser environment)', async () => {
    await expect(
      runAuthorizationCodeFlow({ clientId: 'ship_app_demo', redirectUri: 'https://app.example/callback' }, 'http://api.example')
    ).rejects.toBeInstanceOf(ShipSdkError);
  });
});
