/**
 * `ShipClient` — the core `@ship/sdk` client (PF-400 scaffold + `me()`;
 * PF-404, this ticket, adds `tokenStore`-backed auth, refresh-on-401 with a
 * single-flight mutex, and the two static flow constructors —
 * `deviceLogin`/`authorizationCodeFlow` — PLUGFORGE.MD §2.8).
 *
 * `documents`/`issues`/`sprints`/`webhooks` resource clients (PF-401) are
 * still a later ticket.
 */
import { ShipSdkError, type ApiErrorBody } from './errors.js';
import type { Me } from './types.js';
import type { ITokenStore, TokenSet } from './tokenStore.js';
import { runDeviceLoginFlow, type DeviceLoginFlowOptions } from './deviceLogin.js';
import { runAuthorizationCodeFlow, type AuthorizationCodeFlowOptions as PkceFlowOptions } from './authorizationCodeFlow.js';

/**
 * Established in `agent/src/config.ts` (`SHIP_API_BASE_URL`,
 * `DEFAULT_SHIP_API_BASE_URL = 'http://localhost:3000'`) — the one place in
 * this repo that already had to answer "what's Ship's API base URL when
 * nothing else says otherwise." Reused rather than inventing a second name:
 * `api/src/index.ts`'s own default listen port is also 3000
 * (`process.env.PORT || 3000`), so `http://localhost:3000` is genuinely where
 * a local `pnpm dev`/`pnpm dev:api` server answers by default.
 */
const DEFAULT_BASE_URL = 'http://localhost:3000';
const SHIP_API_BASE_URL_ENV_VAR = 'SHIP_API_BASE_URL';

/**
 * `process` does not exist in a browser bundle — PLUGFORGE.MD §2.8 names a
 * browser demo (`authorizationCodeFlow`'s PKCE flow, localStorage-backed
 * `ITokenStore`) as a real consumer of this package, so `new ShipClient()`
 * with `baseUrl` omitted must not throw there. Guarded, not assumed.
 */
function resolveDefaultBaseUrl(): string {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const fromEnv = env ? env[SHIP_API_BASE_URL_ENV_VAR] : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

/**
 * Removes trailing `/` characters — deliberately a plain loop, not
 * `.replace(/\/+$/, '')`. That regex is provably linear (a single unbounded
 * quantifier over one literal character, anchored at the end of string —
 * verified empirically before this rewrite: trimming 5,000,000 trailing
 * slashes took ~1.6ms, no polynomial/exponential blowup), but GitHub's
 * CodeQL `js/polynomial-redos` query still flags it here because `baseUrl`
 * is caller-supplied ("library input") and the query's static model can't
 * rule out worst-case behavior the way a direct measurement can. Rather than
 * argue with the analyzer on a public-facing check, this loop is exactly as
 * correct and exactly as fast, and leaves nothing for a regex-complexity
 * query to flag.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * `opts.tokenStore` was accepted-but-unused in the PF-400 scaffold (typed
 * `unknown`) — this ticket (PF-404) is what makes it do something. `clientId`
 * (+ optional `clientSecret`) is a genuine ADDITION beyond §2.8's one-line
 * constructor signature (`{ token?, baseUrl?, tokenStore? }`), the same kind
 * of elision that section's own class signature already makes for `baseUrl`
 * (present in `ShipClientOptions` since PF-400, absent from the doc's
 * abbreviated `constructor(opts: {...})` line). It's required here because
 * refresh-on-401 calls `POST /oauth/token` with `grant_type=refresh_token`,
 * and this repo's `rotateRefreshToken` (`api/src/platform/oauth/token.ts`)
 * requires `client_id` unconditionally (not just for confidential clients) —
 * see that function's own header. A `ShipClient` constructed with only
 * `{ token }` (the PF-400 shape) behaves EXACTLY as before: no `clientId`
 * means refresh-on-401 is simply never attempted, and a 401 propagates as
 * the same `ShipSdkError(kind: 'auth')` it always did (see
 * `client.test.ts`'s pre-existing "an invalid token maps to..." case, still
 * green, unmodified, after this ticket).
 */
export interface ShipClientOptions {
  token?: string;
  baseUrl?: string;
  tokenStore?: ITokenStore;
  /** OAuth `client_id` — required for automatic refresh-on-401 to have
   * anything to send `POST /oauth/token` as. Optional because a bare
   * `{ token }` caller (PF-400's own shape, and every non-OAuth personal-token
   * caller) has no refresh token to rotate in the first place. */
  clientId?: string;
  /** Only meaningful for a confidential OAuth app; the flows this ticket
   * builds (`deviceLogin`, `authorizationCodeFlow`) are both PUBLIC-client
   * flows (RFC 8628 has no client secret; PKCE is PF-104's substitute for
   * one) and never set this themselves. */
  clientSecret?: string;
}

/** RFC 6749 §5.2 error shape returned by `/oauth/token` — `{ error,
 * error_description }`, NOT `/api/v1`'s `ApiErrorBody` (`{ code, message,
 * request_id }`). `errors.ts`'s own header comment draws the identical
 * distinction for why `/api/v1` error parsing doesn't apply to `/oauth`
 * responses. */
interface OAuthTokenErrorBody {
  error: string;
  error_description?: string;
}

function isOAuthTokenErrorBody(data: unknown): data is OAuthTokenErrorBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).error === 'string';
}

interface OAuthTokenSuccessBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

function isOAuthTokenSuccessBody(data: unknown): data is OAuthTokenSuccessBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).access_token === 'string';
}

export class ShipClient {
  private readonly baseUrl: string;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly tokenStore: ITokenStore | undefined;

  // Mutable — an access/refresh token pair a running client rotates through
  // its own lifetime (refresh-on-401), unlike `baseUrl`/`clientId` above.
  private accessToken: string | undefined;
  private refreshToken: string | undefined;

  // Memoized promises, not booleans: every concurrent caller that arrives
  // while one is in flight must await the SAME promise rather than starting
  // its own — that's the single-flight mutex this ticket's AC requires for
  // refresh, and the same shape incidentally makes lazy tokenStore hydration
  // (below) safe under concurrent first calls too.
  private hydratePromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;

  /**
   * Cheap construction — no I/O. Required by PF-703 (the agent gate builds a
   * fresh `ShipClient` per human-token write); a constructor that made a
   * network call would make that prohibitively expensive there. This holds
   * for `tokenStore` too (PF-404): the constructor never calls
   * `tokenStore.get()` — see `hydrate()`, invoked lazily on first request.
   */
  constructor(opts: ShipClientOptions = {}) {
    this.accessToken = opts.token;
    this.baseUrl = stripTrailingSlashes(opts.baseUrl ?? resolveDefaultBaseUrl());
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenStore = opts.tokenStore;
  }

  /**
   * `GET /api/v1/me` — the calling principal's identity (§2.4). Throws a
   * `ShipSdkError` (see that class's own doc comment for the return-vs-throw
   * rationale) on any non-2xx response or network failure.
   */
  async me(): Promise<Me> {
    return this.getJson<Me>('/api/v1/me');
  }

  /**
   * RFC 8628 Device Authorization Grant (PF-106's server, PLUGFORGE.MD
   * §2.8). Displays a `user_code` + verification URL via `onUserCode`, polls
   * to completion, and resolves with a `ShipClient` already carrying the
   * resulting tokens. See `deviceLogin.ts`'s header for the full
   * request/response contract and for why `clientId`/`baseUrl` are named
   * explicitly here even though §2.8's own abbreviated signature omits them.
   */
  static async deviceLogin(
    opts: Omit<DeviceLoginFlowOptions, 'baseUrl'> & { baseUrl?: string; tokenStore?: ITokenStore }
  ): Promise<ShipClient> {
    const baseUrl = stripTrailingSlashes(opts.baseUrl ?? resolveDefaultBaseUrl());
    const tokens = await runDeviceLoginFlow({
      baseUrl,
      clientId: opts.clientId,
      scope: opts.scope,
      onUserCode: opts.onUserCode,
      now: opts.now,
      sleep: opts.sleep,
    });

    if (opts.tokenStore) {
      await opts.tokenStore.set(tokens);
    }

    return new ShipClient({
      token: tokens.accessToken,
      baseUrl,
      clientId: opts.clientId,
      tokenStore: opts.tokenStore,
    })._withRefreshToken(tokens.refreshToken);
  }

  /**
   * Authorization Code + PKCE, browser context, no client secret (PF-103's
   * `/oauth/authorize` + PF-104's `/oauth/token`, PLUGFORGE.MD §2.8). See
   * `authorizationCodeFlow.ts`'s header for the two-leg design: on the first
   * call (no `?code=` in the current URL) this redirects the browser and the
   * returned promise never resolves in a real browser; on the second call
   * (after the redirect back) it exchanges the code and resolves with a
   * working `ShipClient`.
   */
  static async authorizationCodeFlow(opts: PkceFlowOptions): Promise<ShipClient> {
    const baseUrl = stripTrailingSlashes(opts.baseUrl ?? resolveDefaultBaseUrl());
    const result = await runAuthorizationCodeFlow(opts, baseUrl);

    if (result.kind === 'redirected') {
      // Real browser: `location.assign()` already tore down this JS context,
      // so control never actually reaches here. A test-injected `location`
      // that doesn't really navigate CAN reach this branch — there is no
      // client to construct yet, so this intentionally never resolves,
      // mirroring what a real browser does.
      return new Promise<ShipClient>(() => {
        // Deliberately never settles — see comment above.
      });
    }

    return new ShipClient({
      token: result.tokens.accessToken,
      baseUrl,
      clientId: opts.clientId,
      tokenStore: opts.tokenStore,
    })._withRefreshToken(result.tokens.refreshToken);
  }

  /** Internal-only: seeds the in-memory refresh token right after
   * construction, for the two static flows above (both already hold the
   * freshly-minted refresh token from their own token exchange and would
   * otherwise have to round-trip it through `tokenStore.get()` — an
   * avoidable read of what was just written, and a no-op when no
   * `tokenStore` was given at all). Not part of `ShipClientOptions`: a
   * refresh token is never something a caller should hand-construct a client
   * with directly, only something a completed OAuth flow produces. */
  private _withRefreshToken(refreshToken: string | undefined): ShipClient {
    this.refreshToken = refreshToken;
    return this;
  }

  private authHeaders(): Record<string, string> {
    return this.accessToken !== undefined ? { Authorization: `Bearer ${this.accessToken}` } : {};
  }

  /**
   * Lazily loads a persisted token set from `tokenStore` on first use — kept
   * OUT of the constructor (see its own doc comment). Memoized: concurrent
   * first calls all await the same read rather than each hitting the store.
   * A no-op (resolves immediately, no I/O) when no `tokenStore` was
   * configured — the common case, and exactly PF-400's original behavior.
   */
  private hydrate(): Promise<void> {
    if (!this.tokenStore) return Promise.resolve();
    if (!this.hydratePromise) {
      const store = this.tokenStore;
      this.hydratePromise = store.get().then((tokens) => {
        if (!tokens) return;
        if (this.accessToken === undefined) this.accessToken = tokens.accessToken;
        if (this.refreshToken === undefined) this.refreshToken = tokens.refreshToken;
      });
    }
    return this.hydratePromise;
  }

  /**
   * `POST /oauth/token` with `grant_type=refresh_token` (PF-105's server).
   * SINGLE-FLIGHT (this ticket's AC): every caller — however many concurrent
   * requests independently hit a 401 — goes through `refreshOnce()` below,
   * which memoizes this promise so only ONE `fetch` to `/oauth/token` is ever
   * in flight at a time; everyone else awaits and reuses its result.
   * ROTATION (this ticket's other AC, "transparent to caller"): the server
   * rotates the refresh token on every use (`rotateRefreshToken`'s whole
   * point — the old one is now revoked) — this method overwrites
   * `this.refreshToken` with the NEW one from the response before resolving,
   * so a LATER, independent 401 can refresh again without the caller ever
   * having to know a rotation happened.
   */
  private async doRefresh(): Promise<void> {
    if (this.refreshToken === undefined || this.clientId === undefined) {
      throw new ShipSdkError('auth', 'No refresh token or client_id available to refresh an expired session.');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', this.refreshToken);
    body.set('client_id', this.clientId);
    if (this.clientSecret !== undefined) body.set('client_secret', this.clientSecret);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (cause) {
      throw ShipSdkError.fromNetworkError(cause);
    }

    const data: unknown = await res.json().catch(() => undefined);

    if (!res.ok || !isOAuthTokenSuccessBody(data)) {
      const description = isOAuthTokenErrorBody(data)
        ? (data.error_description ?? data.error)
        : `POST /oauth/token (refresh_token) failed (HTTP ${res.status}).`;
      throw new ShipSdkError('auth', description, { httpStatus: res.status });
    }

    this.accessToken = data.access_token;
    // Rotation may or may not issue a new refresh token depending on grant —
    // every grant this SDK's own flows use always does, but fall back to
    // keeping the current one rather than clearing it on an
    // absent/malformed field.
    if (typeof data.refresh_token === 'string') {
      this.refreshToken = data.refresh_token;
    }

    if (this.tokenStore) {
      const tokens: TokenSet = {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        scope: data.scope,
      };
      await this.tokenStore.set(tokens);
    }
  }

  private refreshOnce(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async doFetch(path: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
    } catch (cause) {
      throw ShipSdkError.fromNetworkError(cause);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.hydrate();

    let res = await this.doFetch(path);

    // Refresh-on-401: only attempted when there's something to refresh WITH
    // (a refresh token and a client_id — see `doRefresh`'s own guard, which
    // this mirrors so a client with neither behaves exactly as it did before
    // this ticket: the 401 falls straight through to the throw below).
    if (res.status === 401 && this.refreshToken !== undefined && this.clientId !== undefined) {
      await this.refreshOnce();
      res = await this.doFetch(path);
    }

    if (!res.ok) {
      throw ShipSdkError.fromApiErrorBody(await parseErrorBody(res), res.status);
    }

    return (await res.json()) as T;
  }
}

/**
 * A non-2xx `/api/v1` response is contractually `ApiErrorBody`
 * (`api/src/platform/api/v1/errors.ts`'s `errorMiddleware`), but this is the
 * network boundary — a proxy, load balancer, or an outage can put something
 * else on the wire. Falls back to a synthesized `server_error`-coded body
 * (carrying the real HTTP status through `ShipSdkError.fromApiErrorBody`'s
 * `httpStatus` parameter) rather than letting a `res.json()` parse failure
 * propagate as an unrelated, unhandled exception.
 */
async function parseErrorBody(res: Response): Promise<ApiErrorBody> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return fallbackErrorBody(res);
  }
  return isApiErrorBody(data) ? data : fallbackErrorBody(res);
}

function fallbackErrorBody(res: Response): ApiErrorBody {
  return {
    code: 'server_error',
    message: `Unexpected error response (HTTP ${res.status} ${res.statusText}).`,
    request_id: '',
  };
}

function isApiErrorBody(data: unknown): data is ApiErrorBody {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return typeof record.code === 'string' && typeof record.message === 'string' && typeof record.request_id === 'string';
}
