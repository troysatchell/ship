/**
 * `RequestClient` — the shared HTTP execution core behind every `@ship/sdk`
 * call: `ShipClient.me()` (PF-400), every resource client's `list()`/
 * `get()`/`create()` (PF-401, PLUGFORGE.MD §2.8), and `ShipClient`'s
 * `tokenStore`-backed auth + refresh-on-401 with a single-flight mutex
 * (PF-404).
 *
 * PF-401 first extracted this out of `client.ts` (PF-400 built only `me()`,
 * so the fetch wrapper/auth-header builder/error-mapping lived inline
 * there) so every resource client could share one copy instead of four.
 * PF-404 landed concurrently and added `tokenStore` hydration, refresh-on-
 * 401, and the single-flight `refreshOnce()` mutex directly to `client.ts`
 * (that ticket predates this file's existence — see its own git history).
 * Reconciled here, in this one place, rather than in both: EVERY request
 * this SDK makes — `me()` and all four resource clients alike — now goes
 * through the same hydrate -> attempt -> refresh-on-401-once -> retry-once
 * -> map-non-2xx-to-ShipSdkError pipeline. Splitting that pipeline back
 * across `client.ts` (for `me()`) and this file (for resource clients)
 * would silently leave resource-client calls WITHOUT refresh-on-401 even
 * though `me()` has it — a real, user-visible behavioral gap, not a
 * cosmetic one, so it is not an option here.
 */
import { ShipSdkError, type ApiErrorBody } from '../errors.js';
import type { ITokenStore, TokenSet } from '../tokenStore.js';

export interface RequestClientOptions {
  readonly baseUrl: string;
  readonly token: string | undefined;
  /** OAuth `client_id` — required for automatic refresh-on-401 to have
   *  anything to send `POST /oauth/token` as (PF-404). Optional because a
   *  bare `{ token }` caller (PF-400's own shape, and every non-OAuth
   *  personal-token caller) has no refresh token to rotate in the first
   *  place — see `doRefresh`'s own guard below. */
  readonly clientId?: string;
  /** Only meaningful for a confidential OAuth app; `ShipClient`'s own
   *  `deviceLogin`/`authorizationCodeFlow` flows are both PUBLIC-client
   *  flows and never set this themselves. */
  readonly clientSecret?: string;
  readonly tokenStore?: ITokenStore;
}

/**
 * A GET request's query parameters. A `key` whose value is `undefined` is
 * omitted from the query string entirely (not serialized as the literal
 * string `"undefined"`) — an omitted optional param must produce the exact
 * same URL as never having named that key at all, matching every list
 * route's own Zod schema (`limit`/`cursor`/`type` etc. are all `.optional()`
 * server-side).
 */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/** RFC 6749 §5.2 error shape returned by `/oauth/token` — `{ error,
 *  error_description }`, NOT `/api/v1`'s `ApiErrorBody` (`{ code, message,
 *  request_id }`). `errors.ts`'s own header comment draws the identical
 *  distinction for why `/api/v1` error parsing doesn't apply to `/oauth`
 *  responses. Moved here verbatim from `client.ts` (PF-404) — `doRefresh`
 *  is this file's method now, so its two small body-shape guards move with
 *  it. */
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

export class RequestClient {
  private readonly baseUrl: string;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly tokenStore: ITokenStore | undefined;

  // Mutable — an access/refresh token pair a running client rotates through
  // its own lifetime (refresh-on-401), unlike baseUrl/clientId above.
  private accessToken: string | undefined;
  private refreshToken: string | undefined;

  // Memoized promises, not booleans: every concurrent caller that arrives
  // while one is in flight must await the SAME promise rather than starting
  // its own — the single-flight mutex PF-404's AC requires for refresh, and
  // the same shape incidentally makes lazy tokenStore hydration (below)
  // safe under concurrent first calls too.
  private hydratePromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;

  constructor(opts: RequestClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.accessToken = opts.token;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenStore = opts.tokenStore;
  }

  /** Internal-only: seeds the in-memory refresh token right after
   *  construction — `ShipClient`'s static `deviceLogin`/`authorizationCodeFlow`
   *  (PF-404) both already hold the freshly-minted refresh token from their
   *  own token exchange and would otherwise have to round-trip it through
   *  `tokenStore.get()`, an avoidable read of what was just written. Not
   *  part of `RequestClientOptions`: a refresh token is never something a
   *  caller should hand-construct a client with directly, only something a
   *  completed OAuth flow produces. */
  setRefreshToken(refreshToken: string | undefined): void {
    this.refreshToken = refreshToken;
  }

  private authHeaders(): Record<string, string> {
    return this.accessToken !== undefined ? { Authorization: `Bearer ${this.accessToken}` } : {};
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const base = `${this.baseUrl}${path}`;
    if (!query) return base;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return qs.length > 0 ? `${base}?${qs}` : base;
  }

  /**
   * Lazily loads a persisted token set from `tokenStore` on first use — kept
   * out of `ShipClient`'s constructor (PF-703 needs construction to stay
   * I/O-free). Memoized: concurrent first calls all await the same read
   * rather than each hitting the store. A no-op (resolves immediately, no
   * I/O) when no `tokenStore` was configured — the common case, and exactly
   * PF-400's original behavior.
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

  /** True when there is both a refresh token to use and a `client_id` to
   *  authenticate the refresh grant as — mirrors `doRefresh`'s own guard,
   *  so a client with neither behaves exactly as it did before PF-404: a
   *  401 falls straight through to `ShipSdkError` without ever attempting
   *  `/oauth/token`. */
  private isRefreshable(): boolean {
    return this.refreshToken !== undefined && this.clientId !== undefined;
  }

  /**
   * `POST /oauth/token` with `grant_type=refresh_token` (PF-105's server).
   * SINGLE-FLIGHT (PF-404's AC): every caller — however many concurrent
   * requests independently hit a 401 — goes through `refreshOnce()` below,
   * which memoizes this promise so only ONE `fetch` to `/oauth/token` is
   * ever in flight at a time; everyone else awaits and reuses its result.
   * ROTATION (PF-404's other AC, "transparent to caller"): the server
   * rotates the refresh token on every use (`rotateRefreshToken`'s whole
   * point — the old one is now revoked) — this method overwrites
   * `this.refreshToken` with the NEW one from the response before
   * resolving, so a LATER, independent 401 can refresh again without the
   * caller ever having to know a rotation happened.
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

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (cause) {
      throw ShipSdkError.fromNetworkError(cause);
    }
  }

  /**
   * The shared pipeline every `get`/`post`/`delete` call below goes
   * through: hydrate from `tokenStore` (no-op if none configured), attempt
   * the request, and on a 401 with something to refresh WITH, refresh once
   * (single-flight) and retry exactly once. `Authorization` is rebuilt
   * fresh on the retry (`authHeaders()` called again, not reused from the
   * first attempt) so it carries the just-rotated access token. Maps any
   * still-non-2xx response to a `ShipSdkError`; returns the raw `Response`
   * on success so each caller below decides how to parse the body (JSON
   * for GET/POST, nothing for DELETE's typical `204 No Content`).
   */
  private async execute(url: string, method: string, extraHeaders: Record<string, string>, body?: string): Promise<Response> {
    await this.hydrate();

    const attempt = () => this.rawFetch(url, { method, headers: { ...this.authHeaders(), ...extraHeaders }, body });

    let res = await attempt();

    if (res.status === 401 && this.isRefreshable()) {
      await this.refreshOnce();
      res = await attempt();
    }

    if (!res.ok) {
      throw ShipSdkError.fromApiErrorBody(await parseErrorBody(res), res.status);
    }

    return res;
  }

  /** Issues a `GET`. Sends only the `Authorization` header (when a token is
   *  configured) — no `content-type`, matching `client.test.ts`'s existing
   *  assertion that a GET's `init.headers` is exactly `{}` or exactly
   *  `{ Authorization: ... }`, nothing more. */
  async get<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.execute(this.buildUrl(path, query), 'GET', {});
    return (await res.json()) as T;
  }

  /** Issues a `POST` with a JSON body. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.execute(this.buildUrl(path), 'POST', { 'content-type': 'application/json' }, JSON.stringify(body));
    return (await res.json()) as T;
  }

  /** Issues a `DELETE`. No response body is parsed as JSON on success —
   *  most delete endpoints (including the webhooks subscription delete this
   *  client will call once PF-302 lands) return `204 No Content`, which has
   *  no body to parse. */
  async delete(path: string): Promise<void> {
    await this.execute(this.buildUrl(path), 'DELETE', {});
  }
}

/**
 * A non-2xx `/api/v1` response is contractually `ApiErrorBody`
 * (`api/src/platform/api/v1/errors.ts`'s `errorMiddleware`), but this is the
 * network boundary — a proxy, load balancer, or an outage can put something
 * else on the wire. Falls back to a synthesized `server_error`-coded body
 * (carrying the real HTTP status through `ShipSdkError.fromApiErrorBody`'s
 * `httpStatus` parameter) rather than letting a `res.json()` parse failure
 * propagate as an unrelated, unhandled exception. Moved verbatim from
 * `client.ts` (PF-400) — behavior unchanged.
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
