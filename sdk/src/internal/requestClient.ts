/**
 * `RequestClient` — the shared HTTP execution core behind every `@ship/sdk`
 * call: `ShipClient.me()` (PF-400) and every resource client's
 * `list()`/`get()`/`create()` (PF-401, PLUGFORGE.MD §2.8).
 *
 * Extracted out of `client.ts` (PF-400 built only `me()`, so the fetch
 * wrapper, `Authorization` header builder, and error-mapping path lived
 * inline there as private methods) so `DocumentsClient`/`IssuesClient`/
 * `SprintsClient`/`WebhooksClient` share exactly ONE copy of this logic —
 * never four independent copies that could drift on error handling. `logic`
 * itself is unchanged: same fetch call shape, same `Authorization: Bearer
 * <token>` header (omitted entirely when no token), same `ShipSdkError`
 * mapping for both a thrown `fetch()` (network) and a non-2xx response
 * (`ApiErrorBody` -> `ShipSdkError`, with the same defensive fallback for a
 * response body that isn't `/api/v1`'s contractual shape — see
 * `parseErrorBody`'s own comment, moved here verbatim from `client.ts`).
 *
 * Not exported from `index.ts` — this is `ShipClient`'s own internal
 * plumbing. `ShipClient` constructs exactly one `RequestClient` per instance
 * (from its already-resolved, already-trailing-slash-trimmed `baseUrl` and
 * `token`) and hands that single instance to each resource client's
 * constructor, so a `ShipClient`'s `baseUrl`/`token` can never disagree
 * between `.me()` and `.documents`/`.issues`/`.sprints`/`.webhooks`.
 */
import { ShipSdkError, type ApiErrorBody } from '../errors.js';

export interface RequestClientOptions {
  readonly baseUrl: string;
  readonly token: string | undefined;
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

export class RequestClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: RequestClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
  }

  private authHeaders(): Record<string, string> {
    return this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {};
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

  /** Issues a `GET`. Sends only the `Authorization` header (when a token is
   *  configured) — no `content-type`, matching `client.test.ts`'s existing
   *  assertion that a GET's `init.headers` is exactly `{}` or exactly
   *  `{ Authorization: ... }`, nothing more. */
  async get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.send<T>(this.buildUrl(path, query), {
      method: 'GET',
      headers: this.authHeaders(),
    });
  }

  /** Issues a `POST` with a JSON body. */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(this.buildUrl(path), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Issues a `DELETE`. No response body is parsed as JSON on success — most
   *  delete endpoints (including the webhooks subscription delete this
   *  client will call once PF-302 lands) return `204 No Content`, which has
   *  no body to parse; a caller that needs a typed body from a DELETE isn't
   *  one of this SDK's current methods. */
  async delete(path: string): Promise<void> {
    const url = this.buildUrl(path);
    let res: Response;
    try {
      res = await fetch(url, { method: 'DELETE', headers: this.authHeaders() });
    } catch (cause) {
      throw ShipSdkError.fromNetworkError(cause);
    }
    if (!res.ok) {
      throw ShipSdkError.fromApiErrorBody(await parseErrorBody(res), res.status);
    }
  }

  private async send<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
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
