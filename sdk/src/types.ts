/**
 * `@ship/sdk`'s wire-response types for `/api/v1` resources.
 *
 * `Me` mirrors `GET /api/v1/me`'s response body EXACTLY, field-for-field —
 * verified against the server's actual handler and its own doc comment
 * (`api/src/platform/api/v1/resources/me.ts`), not guessed from PLUGFORGE.MD's
 * prose alone. The nested shapes match `PrincipalApp`/`PrincipalUser`
 * (`api/src/platform/oauth/principal.ts`) as serialized by that handler.
 *
 * `user`/`app` are each independently nullable, NOT a two-way XOR — a CodeRabbit
 * review on this ticket (PR #TRO-405) proposed narrowing `Me` to a union of
 * exactly `{ user: MeUser; app: null }` | `{ user: null; app: MeApp }`.
 * Verified against `me.ts`'s own header comment before accepting or rejecting
 * that suggestion (this file's docstring itself used to claim "XOR", which was
 * the same error): there are THREE real shapes, not two — a personal-token
 * principal (`user` populated, `app` null), a Client-Credentials principal
 * (`user` null, `app` populated), AND an `authorization_code`-grant OAuth
 * principal, which has **both populated** (`app` always present for an OAuth
 * token; `user` present because that grant always has an acting user). The
 * suggested two-variant union would make that third, real, server-producible
 * shape a type error for every SDK consumer — rejected as a regression, not
 * applied. Both fields stay independently `T | null`.
 * `scopes` is always present, the token's actual granted scopes either way.
 */
export interface MeUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface MeApp {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly is_first_party: boolean;
}

export interface Me {
  readonly user: MeUser | null;
  readonly app: MeApp | null;
  readonly scopes: string[];
}
