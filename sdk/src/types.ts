/**
 * `@ship/sdk`'s wire-response types for `/api/v1` resources.
 *
 * `Me` mirrors `GET /api/v1/me`'s response body EXACTLY, field-for-field —
 * verified against the server's actual handler and its own doc comment
 * (`api/src/platform/api/v1/resources/me.ts`), not guessed from PLUGFORGE.MD's
 * prose alone. The nested shapes match `PrincipalApp`/`PrincipalUser`
 * (`api/src/platform/oauth/principal.ts`) as serialized by that handler:
 * `user`/`app` are each populated XOR null depending on which of the two
 * bearer-token classes authenticated the request (personal token vs. OAuth
 * Client Credentials) — see that file's header comment for the full matrix.
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
