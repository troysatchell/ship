/**
 * The authenticated identity behind a `/api/v1` bearer-token request
 * (PLUGFORGE.MD §4, PF-107): `req.principal = { app, user, scopes }`.
 *
 * Populated by `bearerAuth` (`./bearerAuth.ts`) from one of the two token
 * classes it accepts:
 *
 *   - An OAuth access token (`oauth_tokens`) — `app` is always present;
 *     `user` is present for every grant except Client Credentials, where the
 *     token has no acting user (§2.2: "nullable — null for Client
 *     Credentials").
 *   - A scoped personal token (`api_tokens.scopes IS NOT NULL`) — `user` is
 *     always present; `app` is always `null` (§4 PF-107: "user + scopes,
 *     `app` null").
 *
 * Every request that reaches a handler behind `bearerAuth` has `req.principal`
 * set to a non-null `Principal` — `bearerAuth` itself sends the 401 response
 * and never calls `next()` for any request it cannot resolve to one.
 */

export interface PrincipalApp {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly isFirstParty: boolean;
}

export interface PrincipalUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface Principal {
  readonly app: PrincipalApp | null;
  readonly user: PrincipalUser | null;
  readonly scopes: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by `bearerAuth` once a request's bearer token has been resolved
       * to either token class. Undefined on any request that never passed
       * through `bearerAuth` (e.g. an internal `/api/*` route).
       */
      principal?: Principal;
    }
  }
}
