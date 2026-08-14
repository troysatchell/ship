/**
 * `ShipClient` — the core `@ship/sdk` client (PF-400/PF-401/PF-404,
 * PLUGFORGE.MD §2.8).
 *
 * PF-400 built the scaffold + `me()`. PF-401 (this file's resource-client
 * properties) adds `.documents`/`.issues`/`.sprints`/`.webhooks`. PF-404
 * (this file's `tokenStore`/`clientId`/`clientSecret` options and the two
 * static flow constructors) adds `tokenStore`-backed auth, refresh-on-401
 * with a single-flight mutex, and `deviceLogin`/`authorizationCodeFlow`.
 * PF-401 and PF-404 landed concurrently as separate PRs against the same
 * file — reconciled here: every request this SDK makes, `me()` and every
 * resource client alike, goes through the ONE shared `RequestClient`
 * (`internal/requestClient.ts`), which owns hydrate/refresh-on-401 as well
 * as the plain fetch/auth-header/error-mapping plumbing PF-400 started with.
 * See that module's header for why splitting refresh-on-401 back out to
 * only cover `me()` was rejected as a real behavioral gap, not a cosmetic
 * one.
 */
import { RequestClient } from './internal/requestClient.js';
import type { Me } from './types.js';
import { DocumentsClient } from './resources/documents.js';
import { IssuesClient } from './resources/issues.js';
import { SprintsClient } from './resources/sprints.js';
import { WebhooksClient } from './resources/webhooks.js';
import { AuditClient } from './resources/audit.js';
import type { ITokenStore } from './tokenStore.js';
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
 * `clientId` (+ optional `clientSecret`) is a genuine ADDITION beyond
 * §2.8's one-line constructor signature (`{ token?, baseUrl?, tokenStore?
 * }`), the same kind of elision that section's own class signature already
 * makes for `baseUrl` (present in `ShipClientOptions` since PF-400, absent
 * from the doc's abbreviated `constructor(opts: {...})` line). It's
 * required here because refresh-on-401 calls `POST /oauth/token` with
 * `grant_type=refresh_token`, and this repo's `rotateRefreshToken`
 * (`api/src/platform/oauth/token.ts`) requires `client_id` unconditionally
 * (not just for confidential clients) — see that function's own header. A
 * `ShipClient` constructed with only `{ token }` (the PF-400 shape) behaves
 * EXACTLY as before: no `clientId` means refresh-on-401 is simply never
 * attempted, and a 401 propagates as the same `ShipSdkError(kind: 'auth')`
 * it always did (see `client.test.ts`'s pre-existing "an invalid token
 * maps to..." case, still green, unmodified).
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

export class ShipClient {
  private readonly request: RequestClient;

  /** `documents.list/get/create/iterate` — `/api/v1/documents` (PF-200;
   *  `iterate()` is PF-402's async-iterator pagination over `list()`). */
  readonly documents: DocumentsClient;
  /** `issues.list/iterate` — `/api/v1/issues` (PF-201). No `get`/`create`: the
   *  server registers no such routes today — see `resources/issues.ts`'s
   *  header for the verification. */
  readonly issues: IssuesClient;
  /** `sprints.list/iterate` — `/api/v1/sprints` (PF-201). No `get`/`create`, same
   *  reason as `issues` above — see `resources/sprints.ts`'s header. */
  readonly sprints: SprintsClient;
  /** `webhooks.listSubscriptions/createSubscription/getSubscription/
   *  deleteSubscription/rotateSecret` — real, merged PF-302 routes
   *  (`/api/v1/webhooks*`). `webhooks.listDeliveries/replayDelivery` still
   *  target PF-305/PF-306 routes that do not exist yet — see
   *  `resources/webhooks.ts`'s header for the full verification and
   *  `sdk/src/__tests__/parity.test.ts` (PF-405) for how those two are
   *  carried as documented exemptions rather than silently untested. */
  readonly webhooks: WebhooksClient;
  /** `audit.list` — real, merged PF-501 route (`/api/v1/audit`). Requires
   *  `audit:read` plus an admin/owner/first-party caller — see
   *  `resources/audit.ts`'s header. */
  readonly audit: AuditClient;

  /**
   * Cheap construction — no I/O. Required by PF-703 (the agent gate builds a
   * fresh `ShipClient` per human-token write); a constructor that made a
   * network call would make that prohibitively expensive there. This holds
   * for `tokenStore` too (PF-404): the constructor never calls
   * `tokenStore.get()` — see `RequestClient.hydrate()`, invoked lazily on
   * first request.
   */
  constructor(opts: ShipClientOptions = {}) {
    const baseUrl = stripTrailingSlashes(opts.baseUrl ?? resolveDefaultBaseUrl());
    this.request = new RequestClient({
      baseUrl,
      token: opts.token,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      tokenStore: opts.tokenStore,
    });

    this.documents = new DocumentsClient(this.request);
    this.issues = new IssuesClient(this.request);
    this.sprints = new SprintsClient(this.request);
    this.webhooks = new WebhooksClient(this.request);
    this.audit = new AuditClient(this.request);
  }

  /**
   * `GET /api/v1/me` — the calling principal's identity (§2.4). Throws a
   * `ShipSdkError` (see that class's own doc comment for the return-vs-throw
   * rationale) on any non-2xx response or network failure.
   */
  async me(): Promise<Me> {
    return this.request.get<Me>('/api/v1/me');
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

    const client = new ShipClient({
      token: tokens.accessToken,
      baseUrl,
      clientId: opts.clientId,
      tokenStore: opts.tokenStore,
    });
    client.request.setRefreshToken(tokens.refreshToken);
    return client;
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

    const client = new ShipClient({
      token: result.tokens.accessToken,
      baseUrl,
      clientId: opts.clientId,
      tokenStore: opts.tokenStore,
    });
    client.request.setRefreshToken(result.tokens.refreshToken);
    return client;
  }
}
