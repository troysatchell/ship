/**
 * `ShipClient` — the core `@ship/sdk` client (PF-400, PLUGFORGE.MD §2.8).
 *
 * This ticket builds ONLY the scaffold + `me()`. `documents`/`issues`/
 * `sprints`/`webhooks` resource clients (PF-401), `tokenStore`-backed auth
 * and `authorizationCodeFlow`/`deviceLogin` (PF-404) are later tickets — the
 * constructor's option shape below already has room for `tokenStore` so
 * adding it later is additive, not a breaking change to this one.
 */
import { ShipSdkError, type ApiErrorBody } from './errors.js';
import type { Me } from './types.js';

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
 * `opts.tokenStore` is accepted in the type today (per PLUGFORGE.MD §2.8's
 * full constructor signature) but not read or used by this ticket's
 * implementation — PF-404 wires it up. Declaring the field now, unused,
 * means PF-404 extends this constructor's behavior rather than changing its
 * public shape.
 */
export interface ShipClientOptions {
  token?: string;
  baseUrl?: string;
  tokenStore?: unknown;
}

export class ShipClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;

  /**
   * Cheap construction — no I/O. Required by PF-703 (the agent gate builds a
   * fresh `ShipClient` per human-token write); a constructor that made a
   * network call would make that prohibitively expensive there.
   */
  constructor(opts: ShipClientOptions = {}) {
    this.token = opts.token;
    this.baseUrl = stripTrailingSlashes(opts.baseUrl ?? resolveDefaultBaseUrl());
  }

  /**
   * `GET /api/v1/me` — the calling principal's identity (§2.4). Throws a
   * `ShipSdkError` (see that class's own doc comment for the return-vs-throw
   * rationale) on any non-2xx response or network failure.
   */
  async me(): Promise<Me> {
    return this.getJson<Me>('/api/v1/me');
  }

  private authHeaders(): Record<string, string> {
    return this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async getJson<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
    } catch (cause) {
      throw ShipSdkError.fromNetworkError(cause);
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
