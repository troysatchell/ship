/**
 * RFC 6749 §4.4 Client Credentials Grant — client side (PF-702, TRO-428).
 *
 * PLUGFORGE.MD §1.4.4 / architect notes for PF-702 assumed this already
 * existed as one of "the SDK's own auth helpers from PF-404" — verified
 * false before writing this file: PF-404 built exactly two flows,
 * `deviceLogin` (RFC 8628) and `authorizationCodeFlow` (PKCE), both
 * PUBLIC-client, user-present flows (see `client.ts`'s own field docs).
 * Neither this file nor a `client_credentials` grant_type branch existed
 * anywhere under `sdk/src/` before this ticket (confirmed by grep before
 * writing this). This is a genuine, load-bearing gap PF-702 needs closed to
 * do its own job — an app-identity agent has no user to authenticate as, so
 * `deviceLogin`/`authorizationCodeFlow` are structurally the wrong shape —
 * not a silently-papered-over one: see CHANGES.md (TRO-428) for the finding.
 *
 * Talks to the exact server contract `api/src/platform/oauth/token.ts`'s
 * `issueClientCredentialsToken` implements (read in full before writing
 * this, not inferred from prose): `POST /oauth/token` with
 * `grant_type=client_credentials`, `client_id`, `client_secret` (a
 * confidential app is required — a public app 401s `invalid_client`), and
 * an optional `scope`. Success is the same `{ access_token, token_type,
 * expires_in, scope }` shape every other `/oauth/token` grant returns, but
 * — verified directly in `token.ts`'s `issueClientCredentialsToken` —
 * WITHOUT a `refresh_token` field at all (§4 architect note: "no refresh
 * token" — an app re-authenticates with its own stored secret instead of
 * rotating a token, see `requestClient.ts`'s `setReauthenticator` for how
 * that becomes transparent re-auth-on-401 without a refresh token to hold).
 */
import { ShipSdkError } from './errors.js';

export interface ClientCredentialsFlowOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scope list, e.g. `'documents:read issues:read'`. When
   *  omitted, the server grants every scope the app registered
   *  (`issueClientCredentialsToken`'s own `scopes = requestedScopes.length >
   *  0 ? requestedScopes : app.requested_scopes` fallback, verified). */
  scope?: string;
}

/** No `refreshToken` field (unlike `TokenSet`, `tokenStore.ts`) — Client
 *  Credentials never issues one. A `ClientCredentialsTokenSet` is not a
 *  `TokenSet` and is never persisted through `ITokenStore` for that reason:
 *  the thing that survives a restart is the `clientId`/`clientSecret` pair
 *  the caller already holds, not a token this flow could hand back. */
export interface ClientCredentialsTokenSet {
  accessToken: string;
  expiresIn: number;
  scope: string;
}

interface OAuthTokenSuccessBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

function isOAuthTokenSuccessBody(data: unknown): data is OAuthTokenSuccessBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).access_token === 'string';
}

/** RFC 6749 §5.2 error shape — matches `deviceLogin.ts`'s identical
 *  duplicate (see that file's header for why `/oauth/token` errors are not
 *  `/api/v1`'s `ApiErrorBody`). */
interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

function isOAuthErrorBody(data: unknown): data is OAuthErrorBody {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).error === 'string';
}

/**
 * `POST /oauth/token` with `grant_type=client_credentials`. Exported (unlike
 * `deviceLogin.ts`'s private `postForm`/`pollOnce` helpers) because
 * `RequestClient.setReauthenticator` (PF-702) needs to call this AGAIN on a
 * 401 — there being no refresh token to rotate, "refresh" for this grant
 * means "run the same client_credentials request again with the same
 * stored secret," not a different code path.
 */
export async function runClientCredentialsFlow(opts: ClientCredentialsFlowOptions): Promise<ClientCredentialsTokenSet> {
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', opts.clientId);
  body.set('client_secret', opts.clientSecret);
  if (opts.scope) body.set('scope', opts.scope);

  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (cause) {
    throw ShipSdkError.fromNetworkError(cause);
  }

  const data: unknown = await res.json().catch(() => undefined);

  if (!res.ok || !isOAuthTokenSuccessBody(data)) {
    const description = isOAuthErrorBody(data)
      ? (data.error_description ?? data.error)
      : `POST /oauth/token (client_credentials) failed (HTTP ${res.status}).`;
    throw new ShipSdkError('auth', description, { httpStatus: res.status });
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in, scope: data.scope };
}
