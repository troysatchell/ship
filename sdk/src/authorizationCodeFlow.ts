/**
 * Authorization Code + PKCE — browser client side (PF-404, PLUGFORGE.MD
 * §2.8's `ShipClient.authorizationCodeFlow`, "browser PKCE, no secret").
 * Talks to `api/src/routes/oauth-authorize.ts` (PF-103: `GET
 * /oauth/authorize` -> redirect through consent -> the registered
 * `redirect_uri` with `?code=&state=`) and the `authorization_code` branch of
 * `api/src/routes/oauth-token.ts` (PF-104) — both read directly before
 * writing this, not inferred from RFC prose alone; query-param names below
 * (`response_type`, `client_id`, `redirect_uri`, `code_challenge`,
 * `code_challenge_method`, `scope`, `state`) match
 * `oauth-authorize.ts`'s `validateAuthorizeRequest` exactly.
 *
 * ── Why this is ONE function covering both legs of the flow, not two ──
 *
 * §2.8's signature is `static authorizationCodeFlow(opts): Promise<ShipClient>`
 * — one call, one `Promise<ShipClient>`. A real browser PKCE flow is
 * necessarily two separate page loads (the app's own page, then — after a
 * full top-level navigation through Ship's `/oauth-authorize` ->
 * `/oauth-consent` -> back to the app's `redirect_uri` — a SECOND load of the
 * same page, now carrying `?code=&state=` in the URL). This module collapses
 * both into the one function the signature demands, the same pattern
 * widely-used browser OAuth SDKs use for an SPA's "handle redirect" step:
 * `run()` inspects `location.href` for `code`+`state` to tell which leg it's
 * on.
 *   - Leg 1 (no `code` in the URL): generates a fresh PKCE pair
 *     (`generatePkcePair`, `pkce.ts` — not reinvented here per this ticket's
 *     instruction), stores `code_verifier` keyed by a fresh `state` in
 *     `storage`, and navigates the browser to `/oauth/authorize` with the
 *     PKCE challenge. `location.assign()` tears down the current JS
 *     execution context in a real browser, so the returned promise
 *     deliberately never resolves on this leg — there is nothing further for
 *     THIS call to do. Testable because `location`/`storage` are injected
 *     (default to `window.location`/`window.sessionStorage`), so a test can
 *     assert the constructed URL and stored verifier without an actual
 *     navigation ever firing.
 *   - Leg 2 (`code`+`state` present, e.g. after the app's router re-invokes
 *     this on load): retrieves the matching stored `code_verifier` by
 *     `state`, exchanges `code` for tokens via `POST /oauth/token`, persists
 *     them to `tokenStore` if given, and resolves with a working
 *     `ShipClient`.
 *
 * `sessionStorage`, not `localStorage`, for the in-flight `code_verifier` —
 * it only needs to survive the one round trip to Ship's authorization server
 * and back, and clears itself if the tab is closed mid-flow rather than
 * leaking a stale, unusable verifier into persistent storage. `tokenStore`
 * (the caller's choice — PLUGFORGE.MD §2.8 names `localStorage` for the
 * browser demo specifically) is the durable store for the tokens THIS flow
 * produces, a different concern from the verifier.
 */

import { generatePkcePair } from './pkce.js';
import { ShipSdkError } from './errors.js';
import type { ITokenStore, TokenSet } from './tokenStore.js';

/** The subset of `window.location` this module needs — real
 * `window.location` satisfies it structurally; a test supplies a fake. */
export interface PkceLocation {
  readonly href: string;
  assign(url: string): void;
}

/** The subset of the Web Storage API (`sessionStorage`) this module needs. */
export interface PkceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthorizationCodeFlowOptions {
  baseUrl?: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  tokenStore?: ITokenStore;
  /** Defaults to `window.location`; throws if `window` doesn't exist and
   * this isn't supplied — this flow is browser-only by design (§2.8: "browser
   * PKCE, no secret"). */
  location?: PkceLocation;
  /** Defaults to `window.sessionStorage`. */
  storage?: PkceStorage;
}

const STORAGE_KEY_PREFIX = 'ship_sdk_pkce_';

/**
 * This package's `tsconfig.json` (root `tsconfig.json`, `"lib": ["ES2022"]`)
 * deliberately carries no `"dom"` lib — the SDK is Node-and-browser-neutral,
 * and pulling in `lib.dom.d.ts` would make every file in this package appear
 * to type-check against a `window`/`document` that only actually exists at
 * runtime in one of its two target environments. This ambient declaration is
 * MODULE-scoped (this file has `import`/`export`, so a bare `declare const`
 * here binds only within it, not globally — verified deliberately, not
 * assumed) and narrowed to exactly the two members this module reads. It
 * erases entirely at compile time (`declare` emits no JS); the runtime
 * `typeof window !== 'undefined'` check below is the same defensive,
 * feature-detecting pattern `client.ts`'s `resolveDefaultBaseUrl` already
 * uses for `typeof process !== 'undefined'` — `typeof` on an undeclared free
 * identifier is one of the few JS constructs that does NOT throw
 * `ReferenceError`, which is what makes this safe to evaluate in Node (no
 * real `window` global) without a guard around the `typeof` check itself.
 * A real browser's `Location`/`Storage` objects satisfy `PkceLocation`/
 * `PkceStorage` structurally, so no cast is needed at the call sites below.
 */
declare const window: { location: PkceLocation; sessionStorage: PkceStorage } | undefined;

function requireBrowserGlobal<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value;
  throw new ShipSdkError(
    'auth',
    `authorizationCodeFlow() has no ${name} available — pass one explicitly (this flow is browser-only; ` +
      `\`window\` was not found).`
  );
}

function defaultLocation(): PkceLocation | undefined {
  return typeof window !== 'undefined' ? window.location : undefined;
}

function defaultStorage(): PkceStorage | undefined {
  return typeof window !== 'undefined' ? window.sessionStorage : undefined;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  // Same WebCrypto guard as pkce.ts; a state param has no PKCE-strength
  // requirement (RFC 6749 §10.12 just wants it unguessable/unique per
  // request) but reusing WebCrypto keeps this module dependency-free too.
  if (typeof globalThis.crypto === 'undefined') {
    throw new ShipSdkError('auth', 'authorizationCodeFlow() requires the WebCrypto API (globalThis.crypto).');
  }
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface StoredPkceState {
  codeVerifier: string;
}

function isStoredPkceState(value: unknown): value is StoredPkceState {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).codeVerifier === 'string';
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

function isOAuthTokenResponse(data: unknown): data is OAuthTokenResponse {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).access_token === 'string';
}

interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

function isOAuthErrorBody(data: unknown): data is OAuthErrorBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).error === 'string';
}

async function exchangeCode(params: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('redirect_uri', params.redirectUri);
  body.set('client_id', params.clientId);
  body.set('code_verifier', params.codeVerifier);

  let res: Response;
  try {
    res = await fetch(`${params.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (cause) {
    throw ShipSdkError.fromNetworkError(cause);
  }

  const data: unknown = await res.json().catch(() => undefined);

  if (isOAuthTokenResponse(data)) {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };
  }

  const description = isOAuthErrorBody(data) ? (data.error_description ?? data.error) : `POST /oauth/token failed (HTTP ${res.status}).`;
  throw new ShipSdkError('auth', description, { httpStatus: res.status });
}

/** Result of running the flow — either the code was already present (leg 2,
 * tokens obtained) or the browser was just redirected (leg 1, nothing more
 * to do on this call). Exported so `client.ts`'s static wrapper can build a
 * `ShipClient` only in the `redeemed` case, matching the module header's
 * "leg 1 never resolves in a real browser" note — that "never resolves" is
 * enforced by the CALLER (client.ts) awaiting this and only ever seeing the
 * `redeemed` branch in practice, since a `redirected` result only occurs
 * when the injected `location.assign` is a test double that doesn't actually
 * navigate. */
export type AuthorizationCodeFlowResult = { kind: 'redirected' } | { kind: 'redeemed'; tokens: TokenSet };

/** The lower-level, directly-testable function — see this module's header
 * for the two-leg design. `client.ts`'s `ShipClient.authorizationCodeFlow`
 * wraps this into the exact `Promise<ShipClient>` §2.8 specifies. */
export async function runAuthorizationCodeFlow(
  opts: AuthorizationCodeFlowOptions,
  baseUrlResolved: string
): Promise<AuthorizationCodeFlowResult> {
  const location = requireBrowserGlobal(opts.location ?? defaultLocation(), 'window.location');
  const storage = requireBrowserGlobal(opts.storage ?? defaultStorage(), 'window.sessionStorage');

  const currentUrl = new URL(location.href);
  const code = currentUrl.searchParams.get('code');
  const state = currentUrl.searchParams.get('state');

  if (code !== null && state !== null) {
    const storageKey = `${STORAGE_KEY_PREFIX}${state}`;
    const raw = storage.getItem(storageKey);
    if (raw === null) {
      throw new ShipSdkError(
        'auth',
        'authorizationCodeFlow(): no matching PKCE state found in storage — the flow may have expired, ' +
          'been tampered with, or run in a different browser tab/session than it started in.'
      );
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch (cause) {
      throw new ShipSdkError('auth', 'authorizationCodeFlow(): stored PKCE state is corrupt.', { cause });
    }
    if (!isStoredPkceState(stored)) {
      throw new ShipSdkError('auth', 'authorizationCodeFlow(): stored PKCE state is malformed.');
    }
    storage.removeItem(storageKey);

    const tokens = await exchangeCode({
      baseUrl: baseUrlResolved,
      clientId: opts.clientId,
      redirectUri: opts.redirectUri,
      code,
      codeVerifier: stored.codeVerifier,
    });

    if (opts.tokenStore) {
      await opts.tokenStore.set(tokens);
    }

    return { kind: 'redeemed', tokens };
  }

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const newState = randomState();
  storage.setItem(`${STORAGE_KEY_PREFIX}${newState}`, JSON.stringify({ codeVerifier } satisfies StoredPkceState));

  const authorizeUrl = new URL('/oauth/authorize', baseUrlResolved);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', opts.clientId);
  authorizeUrl.searchParams.set('redirect_uri', opts.redirectUri);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', newState);
  if (opts.scope) authorizeUrl.searchParams.set('scope', opts.scope);

  location.assign(authorizeUrl.toString());

  return { kind: 'redirected' };
}
