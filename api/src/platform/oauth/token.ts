/**
 * `POST /oauth/token` service logic — `authorization_code` (+ PKCE),
 * `client_credentials`, and `refresh_token` grants (PF-104/PF-105, TRO-416/
 * TRO-421, PLUGFORGE.MD §4).
 *
 * Owns reads against `oauth_apps` (migration 042) and `oauth_authorization_codes`
 * (migration 043), and reads/writes against `oauth_tokens` (migration 043,
 * `authorization_code_id` added by migration 044, `refresh_token_expires_at`
 * added by migration 045 — this ticket, PF-105). The route file
 * (`api/src/routes/oauth-token.ts`) is deliberately thin, same split as
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
 *
 * ── PF-105 addition: refresh rotation + family invalidation ──────────────
 *
 * `rotateRefreshToken` (below) implements `grant_type=refresh_token`
 * (PLUGFORGE.MD §4, PF-105, TRO-421). One-time-use refresh tokens: rotation
 * issues a child row in the same `family_id` with `parent_id` pointing at
 * the row being rotated; reuse of an already-rotated refresh token revokes
 * every un-revoked row sharing that `family_id` (RFC 6749 §10.4's
 * refresh-token-family stolen-token detection).
 *
 * ── Schema decision: no new "rotated"/"consumed" column ──
 *
 * `oauth_authorization_codes` has a dedicated `consumed_at` for its
 * single-use gate, separate from any "this code turned out to be stolen"
 * signal (it has none — a code is never reused legitimately, so consumed vs.
 * revoked was never a real distinction there). A refresh token is
 * different: normal, legitimate rotation ALSO needs a "this exact refresh
 * token is now spent" signal, distinct from "an attacker replayed it."
 * Migration 043's documented schema (PLUGFORGE.MD §2.2) and migration 044
 * both checked in full before adding anything — neither carries a
 * `rotated_at` column or equivalent. Rather than add one, this module reuses
 * the existing `revoked_at` for both purposes: rotation sets it on the
 * parent row being rotated (the "invalidates parent" AC), and a presented
 * refresh token whose row already has `revoked_at` set — for ANY reason,
 * including ordinary prior rotation — is treated as reuse and triggers
 * family-wide revocation, exactly mirroring how `redeemAuthorizationCode`
 * above cannot (and deliberately does not try to) distinguish "a live race"
 * from "a sequential replay" for authorization codes. Collapsing "rotated"
 * and "revoked" into one column is a deliberate simplification: it means a
 * row's access token also becomes unusable (`bearerAuth.ts` already rejects
 * on `revoked_at IS NOT NULL`) the moment ITS OWN refresh token is rotated
 * out, not just when the whole family is later killed. That is a real
 * behavioral choice — some OAuth implementations let the old access token
 * keep working until its own natural 1-hour expiry after a rotation — but
 * it is the schema-minimal, self-consistent one: one row is one token PAIR
 * minted together, and this module invalidates that pair as a unit, exactly
 * once, at the one moment (rotation) it is retired.
 *
 * `refresh_token_expires_at` (migration 045) is a genuinely new column: the
 * refresh token's own 30-day TTL (PLUGFORGE.MD §2.2/migration 043 header)
 * cannot reuse the row's existing `expires_at`, which `bearerAuth.ts` and
 * `redeemAuthorizationCode` above already read as the ACCESS token's 1-hour
 * expiry — reusing it for the refresh token's 30-day window would either
 * shorten the access token's own life or require every access-token expiry
 * check in the codebase to learn a second meaning for the same column. This
 * gap was flagged explicitly in PF-104's own CHANGES.md entry (TRO-416) for
 * whoever built this ticket to resolve; migration 045's header records the
 * same reasoning next to the column itself.
 *
 * ── Concurrency argument: two concurrent rotations of the same refresh
 *    token — same rigor, same pattern, as PF-104's above ──
 *
 * Single-use enforcement is the identical shape of atomic statement,
 * substituting `revoked_at` for `consumed_at` and `oauth_tokens` for
 * `oauth_authorization_codes`:
 *
 *   UPDATE oauth_tokens SET revoked_at = now()
 *   WHERE id = $1 AND revoked_at IS NULL RETURNING id
 *
 * run inside a transaction that also INSERTs the child token row and
 * COMMITs before releasing the row lock. Everything checked before this
 * statement (client authentication, the client_id-matches-app_id check,
 * scope narrowing) reads columns that never change after the row is
 * inserted — only `revoked_at` does, and this UPDATE is the only statement
 * in this function that ever changes it — so those earlier reads are safe
 * outside a transaction for the same reason `redeemAuthorizationCode`'s
 * pre-UPDATE reads are.
 *
 * Two concurrent transactions racing this UPDATE serialize at Postgres's row
 * lock exactly as described above for authorization codes: the winner
 * locks the row, flips `revoked_at`, INSERTs the child, and COMMITs; only
 * then is the lock released, and the loser's UPDATE — now unblocked —
 * re-evaluates `revoked_at IS NULL` against the committed row and matches
 * zero rows. The loser always gets `invalid_grant`, and per the same
 * reasoning as the authorization-code path above (this module cannot
 * reliably tell "a live race" apart from "a sequential replay" — the branch
 * a request lands in is not a trustworthy signal of real-world timing), the
 * loser's response ALSO revokes the entire family, including the row the
 * winner's own transaction just committed. A racing legitimate caller can
 * still receive a real, valid-shaped 200 (its transaction genuinely
 * committed) — but that new token is dead on arrival once the race is
 * detected, same fail-safe-under-ambiguity trade-off as PF-104, and the same
 * accepted cost (a well-behaved client does not rotate the same refresh
 * token twice concurrently).
 */

import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { hashAuthorizationCode, parseScopeParam } from './authorize.js';
import { verifyAppCredentials, type OAuthClientType } from './appRegistration.js';

/** Access tokens: 1 hour (migration 043 header comment, PLUGFORGE.MD §2.2). */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Refresh tokens: 30 days (migration 043 header comment, PLUGFORGE.MD §2.2),
 * tracked independently via `refresh_token_expires_at` (migration 045 —
 * PF-105). A rotated child gets a fresh 30-day window from the moment of
 * rotation, not the remainder of its parent's — simplest, most common
 * implementation choice, and stated here explicitly as a decision rather
 * than left implicit. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    // PF-105 (migration 045): the refresh token minted here gets its own
    // 30-day window, tracked independently of `expiresAt` above (which is
    // the access token's 1-hour expiry) — see this module's PF-105 header
    // section for why the two cannot share a column.
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO oauth_tokens
         (app_id, user_id, scopes, access_token_hash, refresh_token_hash, expires_at, refresh_token_expires_at, authorization_code_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        codeRow.app_id,
        codeRow.user_id,
        codeRow.scopes,
        hashToken(accessToken),
        hashToken(refreshToken),
        expiresAt,
        refreshExpiresAt,
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

// ── grant_type=refresh_token (PF-105, TRO-421) ──────────────────────────

/** Revokes every un-revoked token sharing `familyId` — the family-wide
 * stolen-refresh-token response (RFC 6749 §10.4). Idempotent by
 * construction (`WHERE revoked_at IS NULL`): calling this more than once for
 * the same family (e.g. two concurrent reuse attempts, or a sequential
 * replay following a lost race) is safe — later calls simply revoke zero
 * additional rows. Deliberately simpler than
 * `revokeTokensForAuthorizationCode` above (no subquery indirection) because
 * every caller here already has the `family_id` in hand from an earlier read
 * of the row being rotated. */
async function revokeTokenFamily(familyId: string): Promise<void> {
  await pool.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND family_id = $1`, [
    familyId,
  ]);
}

/** Row shape for the refresh-token lookup below — RULE-21 (lessons.md §21):
 * `pool.query` rows are `any` unless given an explicit interface. */
interface OAuthRefreshTokenRow {
  id: string;
  app_id: string;
  user_id: string | null;
  scopes: string[];
  family_id: string;
  refresh_token_expires_at: Date | null;
  revoked_at: Date | null;
}

async function lookupTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthRefreshTokenRow | null> {
  const result = await pool.query<OAuthRefreshTokenRow>(
    `SELECT id, app_id, user_id, scopes, family_id, refresh_token_expires_at, revoked_at
     FROM oauth_tokens WHERE refresh_token_hash = $1`,
    [refreshTokenHash]
  );
  return result.rows[0] ?? null;
}

export interface RotateRefreshTokenParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string | undefined;
  scope: string | undefined;
}

/**
 * `grant_type=refresh_token` (RFC 6749 §6). Negative cases, in the order
 * checked — same ordering discipline as `redeemAuthorizationCode` above:
 *   1. Unknown refresh token -> `invalid_grant`, nothing to revoke.
 *   2. Already revoked, observed on the FIRST read (this row was already
 *      rotated out by an earlier, sequential rotation, or an earlier reuse
 *      already killed the family) -> `invalid_grant`, revokes the family
 *      (idempotent — see `revokeTokenFamily`).
 *   3. `refresh_token_expires_at` is NULL or in the past -> `invalid_grant`.
 *      NULL covers both a genuinely-expired token AND a pre-migration-045
 *      row that never had this column populated (module header explains
 *      why treating both as "not refreshable" is the safe choice). Not a
 *      revocation trigger — an expired token is not evidence of theft, same
 *      reasoning as the authorization-code path's expiry check above.
 *   4. Client authentication failed -> `invalid_client`.
 *   5. Token belongs to a different app than the authenticated client ->
 *      `invalid_grant` (RFC 6749 §4.1.3's "issued to another client",
 *      applied here to the refresh grant).
 *   6. Requested `scope` exceeds the scope originally granted -> RFC 6749
 *      §6's own constraint ("MUST NOT include any scope not originally
 *      granted") -> `invalid_scope`.
 *   7. Lost the single-use race at the atomic UPDATE -> `invalid_grant`,
 *      revokes the family — same outward behavior as step 2, deliberately
 *      (see this module's PF-105 header section for why a live race and a
 *      sequential replay get the same fail-safe treatment).
 */
export async function rotateRefreshToken(params: RotateRefreshTokenParams): Promise<TokenGrantResult> {
  const refreshTokenHash = hashToken(params.refreshToken);
  const tokenRow = await lookupTokenByRefreshHash(refreshTokenHash);

  if (!tokenRow) {
    return invalidGrant('Refresh token is unknown or invalid.');
  }

  if (tokenRow.revoked_at) {
    await revokeTokenFamily(tokenRow.family_id);
    return invalidGrant('Refresh token has already been used.');
  }

  if (!tokenRow.refresh_token_expires_at || tokenRow.refresh_token_expires_at.getTime() < Date.now()) {
    return invalidGrant('Refresh token has expired.');
  }

  const authResult = await authenticateClient({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!authResult.ok) {
    return invalidClient('Client authentication failed.');
  }
  const app = authResult.app;

  if (tokenRow.app_id !== app.id) {
    return invalidGrant('Refresh token was not issued to this client.');
  }

  const requestedScopes = parseScopeParam(params.scope);
  const scopes = requestedScopes.length > 0 ? requestedScopes : tokenRow.scopes;
  if (!scopes.every((scope) => tokenRow.scopes.includes(scope))) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_scope',
      errorDescription: 'Requested scope exceeds the scope originally granted.',
    };
  }

  // Every check above read a snapshot that could, in principle, already be
  // stale by the time we reach here (a concurrent rotator racing us). The
  // UPDATE below is the actual decision point — see this module's PF-105
  // header section.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const consumeResult = await client.query<{ id: string }>(
      `UPDATE oauth_tokens SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tokenRow.id]
    );

    if (consumeResult.rows.length === 0) {
      // Lost the race: nothing was written by this transaction. Revoke the
      // family anyway — see the module header for why this branch
      // deliberately does not try to special-case "this was just a live
      // race" as safer than a sequential replay.
      await client.query('ROLLBACK');
      await revokeTokenFamily(tokenRow.family_id);
      return invalidGrant('Refresh token has already been used.');
    }

    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO oauth_tokens
         (app_id, user_id, scopes, access_token_hash, refresh_token_hash, expires_at, refresh_token_expires_at, family_id, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tokenRow.app_id,
        tokenRow.user_id,
        scopes,
        hashToken(accessToken),
        hashToken(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
        tokenRow.family_id,
        tokenRow.id,
      ]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      accessToken,
      refreshToken,
      scopes,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
