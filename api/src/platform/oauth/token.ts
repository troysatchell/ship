/**
 * `POST /oauth/token` service logic — `authorization_code` (+ PKCE) and
 * `client_credentials` grants (PF-104, TRO-416, PLUGFORGE.MD §4).
 *
 * Owns reads against `oauth_apps` (migration 042) and `oauth_authorization_codes`
 * (migration 043), and reads/writes against `oauth_tokens` (migration 043,
 * `authorization_code_id` added by migration 044 — this ticket). The route
 * file (`api/src/routes/oauth-token.ts`) is deliberately thin, same split as
 * PF-102's `oauth-apps.ts`/`appRegistration.ts` and PF-103's
 * `oauth-authorize.ts`/`authorize.ts`.
 *
 * Reuses PF-102's `verifyAppCredentials` (`appRegistration.ts`) for
 * confidential-client secret checks and PF-103's `hashAuthorizationCode`/
 * `parseScopeParam` (`authorize.ts`) rather than duplicating either — both
 * modules are genuinely importable from this branch (unlike PF-103's own
 * situation, where PF-102 hadn't reached the worktree yet — see that
 * ticket's CHANGES.md entry).
 *
 * ── Concurrency argument: two concurrent redemptions of the same code ──
 *
 * Single-use enforcement is NOT the application-level "read consumed_at,
 * then decide" sequence lessons.md rule 18 warns about — the actual gate is
 * one atomic statement:
 *
 *   UPDATE oauth_authorization_codes SET consumed_at = now()
 *   WHERE id = $1 AND consumed_at IS NULL RETURNING id
 *
 * run inside a transaction that also INSERTs the token row and COMMITs
 * before releasing the row lock. Everything before this statement (the
 * earlier plain SELECT that reads `code_challenge`/`redirect_uri`/`app_id`
 * for validation) is safe to read outside a transaction precisely because
 * those columns are write-once at code creation — only `consumed_at` ever
 * changes after the row exists, and this UPDATE is the only statement in
 * the whole module that ever changes it.
 *
 * Postgres decides who wins, not this code: two concurrent transactions
 * both running that UPDATE against the same row serialize at the row lock.
 * The first to arrive locks the row, flips `consumed_at`, INSERTs the token,
 * and COMMITs — only then is the lock released. The second's UPDATE was
 * blocked on that lock; once unblocked, Postgres re-evaluates the WHERE
 * clause against the now-current (committed) row under READ COMMITTED's
 * EvalPlanQual behavior — `consumed_at IS NULL` no longer holds, so it
 * matches zero rows. The loser always gets `invalid_grant` — the single-use
 * invariant itself is never in doubt, and there is never a window where
 * BOTH concurrent requests can walk away with a live token from one code.
 *
 * ── Why the loser ALSO revokes, deliberately, even though its own
 *    request never "should" have raced a legitimate one ──
 *
 * An earlier version of this module tried to special-case this: revoke on a
 * genuine prior/sequential reuse, but NOT when the "already consumed" signal
 * came from losing a live UPDATE race, on the theory that only the
 * legitimate client can ever produce the correct `code_verifier`, so a live
 * race must be the client's own benign double-submit, not an attacker.
 *
 * A real concurrent-redemption test (`token.test.ts`, "genuine concurrent
 * redemption of the same code", fired via `Promise.all`) falsified the
 * premise that special case depended on: the branch a request lands in
 * (`codeRow.consumed_at` already truthy on its OWN first read, vs. losing
 * the atomic UPDATE) is **not a reliable signal of real-world concurrency**.
 * Two requests dispatched together can still fully serialize in execution
 * order — connection-pool acquisition and event-loop scheduling can let one
 * request's entire transaction (SELECT through COMMIT) finish before the
 * other's first SELECT ever runs — so a "loser" observed via either code
 * path is equally consistent with a truly simultaneous race OR a
 * millisecond-later, fully sequential replay. There is no signal available
 * to this module that distinguishes "the legitimate client itself
 * double-sent" from "someone else who also had the correct `code_verifier`
 * got here first" — and the latter is exactly the scenario revocation
 * exists to contain (RFC 6749 §4.1.2's "SHOULD revoke... all tokens
 * previously issued based on that authorization code" draws no exception
 * for how close together the two presentations were).
 *
 * So this module does the simpler, uniformly safe thing: ANY redemption
 * attempt that finds the code already consumed — whether via the first
 * plain SELECT or via losing the atomic UPDATE — revokes every un-revoked
 * token traceable to this code, including one this exact request pair just
 * minted. A racing legitimate client's request can still receive a real,
 * valid-shaped 200 response (the transaction that won genuinely committed),
 * but that token is dead on arrival once a race is detected: the whole
 * grant becomes unusable, and the client must restart the authorization
 * flow. That is a real UX cost for what should be a rare, arguably
 * client-side-buggy shape of request (a well-behaved client does not
 * redeem the same code twice concurrently) — accepted here because it is
 * strictly safer than the alternative (a request that raced a genuine
 * attacker keeping its token alive because it happened to win).
 */

import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { hashAuthorizationCode, parseScopeParam } from './authorize.js';
import { verifyAppCredentials, type OAuthClientType } from './appRegistration.js';

/** Access tokens: 1 hour (migration 043 header comment, PLUGFORGE.MD §2.2). */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Distinguishing prefixes, same reasoning as `credentials.ts`'s
 * `ship_app_`/`ship_appsec_` split and `api-tokens.ts`'s `ship_` prefix — a
 * leaked value should be identifiable as "an OAuth access/refresh token" at
 * a glance. */
const ACCESS_TOKEN_PREFIX = 'ship_at_';
const REFRESH_TOKEN_PREFIX = 'ship_rt_';

// Exported (PF-106 / TRO-425): the device authorization grant
// (`platform/oauth/device.ts`) mints the exact same token shape once a
// device_code is approved — "a new 'how did the client get authorized'
// path feeding the same token-minting logic, not a wholesale
// reimplementation" (ticket instruction). Reusing these three rather than
// re-deriving the prefix/hash convention a third time.
export function generateAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

export function generateRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

/** Same SHA-256-at-rest pattern as every other credential in this codebase
 * (`api-tokens.ts`'s `hashToken`, `credentials.ts`'s `hashClientSecret`,
 * `authorize.ts`'s `hashAuthorizationCode`). */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * RFC 7636 §4.6: `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))` compared
 * against the stored `code_challenge`. `timingSafeEqual` (same defensive
 * posture as `appRegistration.ts`'s `verifyAppCredentials`) rather than
 * `===` — the practical risk is low (an attacker without the code itself,
 * 256 bits of entropy, gets nowhere), but there's no reason to prefer a
 * variable-time compare when a constant-time one is one line away.
 */
function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const computedBuf = Buffer.from(computed);
  const challengeBuf = Buffer.from(codeChallenge);
  return computedBuf.length === challengeBuf.length && crypto.timingSafeEqual(computedBuf, challengeBuf);
}

/** RFC 6749 §5.2's closed `error` enum for `/oauth/token`, restricted to the
 * values this module actually produces (plus `server_error`, which the RFC
 * doesn't formally define but which every real-world implementation —
 * including this codebase's own `apiError.ts` — adds for the unexpected
 * case; see that file's identical reasoning), PLUS RFC 8628 §3.5's four
 * device-flow polling codes (`authorization_pending`, `slow_down`,
 * `access_denied`, `expired_token`) — added here rather than as a second,
 * device-only union so `sendTokenResult`/`sendTokenError`
 * (`routes/oauth-token.ts`) stay the single, ungrown dispatch for every
 * grant type's error shape (PF-106 / TRO-425). */
export type TokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'server_error'
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token';

export type TokenGrantResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken?: string;
      scopes: string[];
      expiresIn: number;
    }
  | {
      ok: false;
      status: number;
      error: TokenErrorCode;
      errorDescription: string;
    };

function invalidGrant(description: string): TokenGrantResult {
  return { ok: false, status: 400, error: 'invalid_grant', errorDescription: description };
}

function invalidClient(description: string): TokenGrantResult {
  return { ok: false, status: 401, error: 'invalid_client', errorDescription: description };
}

/** Row shape for the `oauth_apps` lookup below — RULE-21 (lessons.md §21):
 * `pool.query` rows are `any` unless given an explicit interface. Distinct
 * from `authorize.ts`'s `OAuthAppLookupRow` because this endpoint also
 * needs `client_type`/`client_secret_hash` for client authentication,
 * neither of which that lookup selects. */
interface OAuthAppTokenRow {
  id: string;
  workspace_id: string;
  client_id: string;
  client_type: OAuthClientType;
  client_secret_hash: string | null;
  redirect_uris: string[];
  requested_scopes: string[];
  revoked_at: Date | null;
}

async function getOAuthAppForToken(clientId: string): Promise<OAuthAppTokenRow | null> {
  const result = await pool.query<OAuthAppTokenRow>(
    `SELECT id, workspace_id, client_id, client_type, client_secret_hash, redirect_uris, requested_scopes, revoked_at
     FROM oauth_apps WHERE client_id = $1`,
    [clientId]
  );
  const app = result.rows[0];
  if (!app || app.revoked_at) return null;
  return app;
}

/**
 * Client authentication, shared by both grants below. For a `confidential`
 * app, a matching `client_secret` is required (`verifyAppCredentials`, the
 * same primitive PF-102 built and reserved explicitly for this ticket — see
 * that module's header). For a `public` app, no secret is checked here —
 * for the `authorization_code` grant, PKCE (`verifyPkce`, called separately
 * by the caller) is the client's proof of legitimacy; `client_credentials`
 * callers must separately reject a non-confidential app (below), since
 * PKCE has no meaning for that grant.
 */
async function authenticateClient(params: {
  clientId: string;
  clientSecret: string | undefined;
}): Promise<{ ok: true; app: OAuthAppTokenRow } | { ok: false }> {
  const app = await getOAuthAppForToken(params.clientId);
  if (!app) return { ok: false };

  if (app.client_type === 'confidential') {
    if (!params.clientSecret) return { ok: false };
    const verified = await verifyAppCredentials({
      clientId: params.clientId,
      clientSecret: params.clientSecret,
    });
    if (!verified.ok) return { ok: false };
  }

  return { ok: true, app };
}

/** Revokes every un-revoked token whose `family_id` traces back to a token
 * minted from this authorization code — the same family-wide revocation
 * shape migration 043 documents for stolen-refresh-token detection, reused
 * here for stolen/replayed-code detection. A single UPDATE, idempotent by
 * construction (`WHERE revoked_at IS NULL`): calling this twice for the
 * same code (e.g. two concurrent reuse attempts) is safe — the second call
 * simply revokes zero additional rows. */
async function revokeTokensForAuthorizationCode(authorizationCodeId: string): Promise<void> {
  await pool.query(
    `UPDATE oauth_tokens SET revoked_at = now()
     WHERE revoked_at IS NULL
       AND family_id IN (
         SELECT family_id FROM oauth_tokens WHERE authorization_code_id = $1
       )`,
    [authorizationCodeId]
  );
}

interface AuthorizationCodeRow {
  id: string;
  app_id: string;
  user_id: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: Date;
  consumed_at: Date | null;
}

async function lookupAuthorizationCodeByHash(codeHash: string): Promise<AuthorizationCodeRow | null> {
  const result = await pool.query<AuthorizationCodeRow>(
    `SELECT id, app_id, user_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at, consumed_at
     FROM oauth_authorization_codes WHERE code_hash = $1`,
    [codeHash]
  );
  return result.rows[0] ?? null;
}

export interface RedeemAuthorizationCodeParams {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | undefined;
  codeVerifier: string;
}

/**
 * `grant_type=authorization_code`. Negative cases, in the order checked:
 *   1. Unknown code -> `invalid_grant`.
 *   2. Already consumed, observed on the FIRST read -> `invalid_grant`,
 *      revokes the code's token family (see module header for why this
 *      revokes unconditionally, the same as step 8 below).
 *   3. Expired -> `invalid_grant`.
 *   4. Client authentication failed -> `invalid_client`.
 *   5. Code was issued to a different client -> `invalid_grant`.
 *   6. `redirect_uri` does not exactly match the one on the code ->
 *      `invalid_grant`.
 *   7. `code_verifier` does not hash to the stored `code_challenge` ->
 *      `invalid_grant`.
 *   8. Lost the single-use race at the atomic UPDATE -> `invalid_grant`,
 *      revokes the code's token family — same outward behavior as step 2,
 *      and deliberately so (see module header: this module cannot reliably
 *      tell a live race apart from a sequential replay, so both are treated
 *      as "reuse").
 */
export async function redeemAuthorizationCode(
  params: RedeemAuthorizationCodeParams
): Promise<TokenGrantResult> {
  const codeHash = hashAuthorizationCode(params.code);
  const codeRow = await lookupAuthorizationCodeByHash(codeHash);

  if (!codeRow) {
    return invalidGrant('Authorization code is unknown or invalid.');
  }

  if (codeRow.consumed_at) {
    await revokeTokensForAuthorizationCode(codeRow.id);
    return invalidGrant('Authorization code has already been used.');
  }

  if (codeRow.expires_at.getTime() < Date.now()) {
    return invalidGrant('Authorization code has expired.');
  }

  const authResult = await authenticateClient({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!authResult.ok) {
    return invalidClient('Client authentication failed.');
  }
  const app = authResult.app;

  if (codeRow.app_id !== app.id) {
    // RFC 6749 §4.1.3: "was issued to another client."
    return invalidGrant('Authorization code was not issued to this client.');
  }

  if (codeRow.redirect_uri !== params.redirectUri) {
    return invalidGrant('redirect_uri does not match the authorization request.');
  }

  if (codeRow.code_challenge_method !== 'S256' || !verifyPkce(params.codeVerifier, codeRow.code_challenge)) {
    return invalidGrant('code_verifier does not match the authorization request.');
  }

  // Every check above read a snapshot that could, in principle, already be
  // stale by the time we reach here (a concurrent redeemer racing us). The
  // UPDATE below is the actual decision point — see the module header.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const consumeResult = await client.query<{ id: string }>(
      `UPDATE oauth_authorization_codes SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL
       RETURNING id`,
      [codeRow.id]
    );

    if (consumeResult.rows.length === 0) {
      // Lost the race: nothing was written by this transaction. Revoke
      // anyway — see the module header for why this branch deliberately
      // does NOT try to special-case "this was just a live race" as safer
      // than a sequential replay; the two are not reliably distinguishable
      // here, and the whole point of revoking is to fail safe under that
      // ambiguity.
      await client.query('ROLLBACK');
      await revokeTokensForAuthorizationCode(codeRow.id);
      return invalidGrant('Authorization code has already been used.');
    }

    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO oauth_tokens
         (app_id, user_id, scopes, access_token_hash, refresh_token_hash, expires_at, authorization_code_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        codeRow.app_id,
        codeRow.user_id,
        codeRow.scopes,
        hashToken(accessToken),
        hashToken(refreshToken),
        expiresAt,
        codeRow.id,
      ]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      accessToken,
      refreshToken,
      scopes: codeRow.scopes,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface ClientCredentialsParams {
  clientId: string;
  clientSecret: string | undefined;
  scope: string | undefined;
}

/**
 * `grant_type=client_credentials` (architect addition, §1.4.4: app-identity
 * reads via Client Credentials — PF-701 consumes it). No user, no PKCE, no
 * refresh token — an app authenticating as itself, not on behalf of anyone.
 * `user_id` is left NULL on the inserted row (§2.2: "nullable — null for
 * Client Credentials", already how `bearerAuth.ts` interprets it: a NULL
 * `user_id` on an `oauth_tokens` row is exactly what makes `principal.user`
 * come back `null`).
 */
export async function issueClientCredentialsToken(
  params: ClientCredentialsParams
): Promise<TokenGrantResult> {
  const authResult = await authenticateClient({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!authResult.ok) {
    return invalidClient('Client authentication failed.');
  }
  const app = authResult.app;

  // authenticateClient only verifies a secret for a confidential app; a
  // public app (no secret configured, PKCE-only by design) is NOT a valid
  // Client Credentials caller — that grant has no PKCE step to substitute
  // for the missing proof of possession. Reject explicitly rather than
  // silently trusting an unauthenticated public client with an app-identity
  // token.
  if (app.client_type !== 'confidential') {
    return invalidClient('Client Credentials requires a confidential client.');
  }

  const requestedScopes = parseScopeParam(params.scope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : app.requested_scopes;
  if (!scopes.every((scope) => app.requested_scopes.includes(scope))) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_scope',
      errorDescription: 'Requested scope exceeds what this application registered.',
    };
  }

  const accessToken = generateAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);

  await pool.query(
    `INSERT INTO oauth_tokens (app_id, user_id, scopes, access_token_hash, refresh_token_hash, expires_at)
     VALUES ($1, NULL, $2, $3, NULL, $4)`,
    [app.id, scopes, hashToken(accessToken), expiresAt]
  );

  return {
    ok: true,
    accessToken,
    // No refresh_token field at all for Client Credentials (§4 architect
    // note: "no refresh token") — `undefined` here means the route layer
    // omits the field entirely rather than sending `refresh_token: null`.
    refreshToken: undefined,
    scopes,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}
