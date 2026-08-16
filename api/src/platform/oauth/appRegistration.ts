/**
 * OAuth app registration, rotation, revocation, and credential verification
 * (PF-102, PLUGFORGE.MD §4 "App registration").
 *
 * Owns all reads/writes against `oauth_apps` (migration 042). The route file
 * (`api/src/routes/oauth-apps.ts`) is deliberately thin — it validates the
 * request, calls one function here, and maps the result to an HTTP response.
 *
 * PM triage amendment (2026-08-10, TRO-408 comments): registration takes
 * `client_type` ('confidential' | 'public'). Public apps never get a secret
 * — there is nothing to show once, and rotation is a 400 for them. This
 * module makes that a structural guarantee: `createOAuthApp` only ever
 * generates a secret when `clientType === 'confidential'`, and
 * `rotateOAuthAppSecret` refuses (rather than silently minting one) for a
 * public app.
 *
 * `verifyAppCredentials` is not itself a PF-102 acceptance criterion — it
 * exists because AC-4 (rotation invalidates the old secret immediately) and
 * AC-5 (revocation blocks auth) are only provable against a real credential
 * check, and no such check exists yet (`/oauth/token` is PF-104, not built by
 * this ticket). This is the minimal, reusable primitive PF-104 will call for
 * confidential-client auth at the token endpoint — built here because the
 * acceptance tests need it now, not scope creep into PF-104's endpoint work.
 */

import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { generateClientId, generateClientSecret, hashClientSecret } from './credentials.js';

export type OAuthClientType = 'confidential' | 'public';

/** Row shape for `oauth_apps` (migration 042) — named per RULE-21 (lessons.md
 * §21): `pool.query` rows are `any` unless given an explicit interface. */
export interface OAuthAppRow {
  id: string;
  workspace_id: string;
  name: string;
  client_id: string;
  client_type: OAuthClientType;
  client_secret_hash: string | null;
  redirect_uris: string[];
  requested_scopes: string[];
  owner_user_id: string | null;
  is_first_party: boolean;
  created_at: Date;
  revoked_at: Date | null;
}

const APP_COLUMNS = `id, workspace_id, name, client_id, client_type, client_secret_hash,
       redirect_uris, requested_scopes, owner_user_id, is_first_party, created_at, revoked_at`;

/**
 * The response-safe projection of an `oauth_apps` row — every field an API
 * response may ever include. `client_secret_hash` is deliberately absent
 * (never `has_secret: true` alone would leak nothing, but keeping the hash
 * itself out of this type means no future call site can serialize it by
 * accident): AC-3 (raw secret absent from any subsequent response).
 */
export interface OAuthAppSummary {
  id: string;
  name: string;
  client_id: string;
  client_type: OAuthClientType;
  redirect_uris: string[];
  requested_scopes: string[];
  is_first_party: boolean;
  created_at: Date;
  revoked_at: Date | null;
  /** Whether a confidential-client secret is configured. Never the secret
   * itself, or its hash — just the boolean the portal needs to decide
   * whether to show a "rotate" affordance. */
  has_secret: boolean;
}

function toSummary(app: OAuthAppRow): OAuthAppSummary {
  return {
    id: app.id,
    name: app.name,
    client_id: app.client_id,
    client_type: app.client_type,
    redirect_uris: app.redirect_uris,
    requested_scopes: app.requested_scopes,
    is_first_party: app.is_first_party,
    created_at: app.created_at,
    revoked_at: app.revoked_at,
    has_secret: app.client_secret_hash !== null,
  };
}

export interface CreateOAuthAppParams {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  clientType: OAuthClientType;
  redirectUris?: string[];
  requestedScopes?: string[];
}

export interface CreateOAuthAppResult {
  app: OAuthAppSummary;
  /** Raw, unhashed secret — present only when `clientType === 'confidential'`.
   * This is the ONLY place the raw value exists outside the caller's own
   * response body; it is never logged and never persisted. */
  clientSecret: string | null;
}

/** AC-1 / AC-2: creates the app, returns `client_id` + raw secret exactly
 * once (confidential only), stores only the SHA-256 hash. */
export async function createOAuthApp(params: CreateOAuthAppParams): Promise<CreateOAuthAppResult> {
  const clientId = generateClientId();
  const rawSecret = params.clientType === 'confidential' ? generateClientSecret() : null;
  const secretHash = rawSecret ? hashClientSecret(rawSecret) : null;

  const result = await pool.query<OAuthAppRow>(
    `INSERT INTO oauth_apps
       (workspace_id, name, client_id, client_type, client_secret_hash, redirect_uris, requested_scopes, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${APP_COLUMNS}`,
    [
      params.workspaceId,
      params.name,
      clientId,
      params.clientType,
      secretHash,
      params.redirectUris ?? [],
      params.requestedScopes ?? [],
      params.ownerUserId,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('oauth_apps insert returned no row');
  }

  return { app: toSummary(row), clientSecret: rawSecret };
}

export async function listOAuthApps(workspaceId: string): Promise<OAuthAppSummary[]> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId]
  );
  return result.rows.map(toSummary);
}

export async function getOAuthApp(appId: string, workspaceId: string): Promise<OAuthAppSummary | null> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE id = $1 AND workspace_id = $2`,
    [appId, workspaceId]
  );
  const row = result.rows[0];
  return row ? toSummary(row) : null;
}

export type RotateOAuthAppSecretError = 'not_found' | 'revoked' | 'public_client_no_secret' | 'conflict';

export type RotateOAuthAppSecretResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: RotateOAuthAppSecretError };

/**
 * AC-4: rotates a confidential app's secret. The old secret is invalid
 * immediately — this UPDATEs `client_secret_hash` in place, so the very next
 * `verifyAppCredentials` call (or the next `/oauth/token` client-auth check,
 * once PF-104 exists) that hashes the old raw value finds no match. There is
 * deliberately no grace period: no second "still valid" hash is kept, no
 * overlap window. (PM triage / PRD §4: "document the no-grace-period
 * choice" — this is that choice, enforced by construction rather than by a
 * comment, because a single-column UPDATE has nowhere to keep an old value
 * even if a future change wanted to.)
 *
 * PM triage (this ticket's comments): public apps get NO secret, so rotation
 * for one is a 400 with a clear message, not a 404 or a silently-minted
 * secret.
 *
 * TRO-492 (CodeRabbit on PR #177, triaged, then independently re-verified
 * against this file as it exists now — not assumed from the ticket text):
 * the `revoked_at IS NULL` guard below closes the revoke-vs-rotate race (a
 * revoke that wins between the SELECT above and this UPDATE makes the
 * UPDATE match zero rows — same "push the predicate into the WHERE clause"
 * reasoning as the CodeRabbit comment on it already explains) but does NOT
 * close rotate-vs-rotate. Rotation never touches `revoked_at`, so two
 * concurrent rotations of the same app both see `revoked_at IS NULL` hold
 * true through both UPDATEs — without a further guard, both statements
 * would match, the second to actually commit would silently overwrite the
 * first's hash, and BOTH callers would get `ok: true` even though only one
 * returned secret still authenticates. That is a lost update, not a
 * cross-tenant leak: verified (by reading this function as written) that
 * every predicate here — before and after this fix — already scopes by
 * `workspace_id` via the SELECT above, so this race can only ever discard a
 * caller's own legitimate rotation, never hand a secret across workspaces.
 *
 * Also verified directly against this file, not assumed from the ticket
 * text: `workspace_id` was in fact missing from the UPDATE's own WHERE
 * clause (the SELECT above scoped the lookup, but the UPDATE below relied on
 * `app.id` alone) — restored below as defense-in-depth, so the write
 * statement itself is workspace-scoped rather than only the read that fed
 * it.
 *
 * Fixed the same way `token.ts`'s `redeemAuthorizationCode` /
 * `rotateRefreshToken` close their own concurrent-redemption /
 * concurrent-rotation races: an atomic `UPDATE ... WHERE <predicate on the
 * value just read> ... RETURNING`, with Postgres's row lock — and READ
 * COMMITTED's EvalPlanQual re-check of the WHERE clause against the
 * just-committed row once that lock is released — doing the actual
 * serialization, not application code. Unlike those two callers, rotation
 * has no natural "already consumed" flag to gate on (an app can be rotated
 * any number of times), so the optimistic-concurrency guard here instead
 * compares `client_secret_hash` against the exact value this call's own
 * SELECT observed (`client_secret_hash IS NOT DISTINCT FROM $4`). If a
 * concurrent rotation's UPDATE has already landed by the time this one is
 * unblocked, the hash it reads back is no longer the value this call
 * started from, the predicate fails, and 0 rows match — the loser gets
 * `conflict`, a defined, retry-able error, never a 200 wrapping a secret
 * that's already dead on arrival.
 */
export async function rotateOAuthAppSecret(params: {
  appId: string;
  workspaceId: string;
}): Promise<RotateOAuthAppSecretResult> {
  const lookup = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE id = $1 AND workspace_id = $2`,
    [params.appId, params.workspaceId]
  );
  const app = lookup.rows[0];
  if (!app) return { ok: false, error: 'not_found' };
  if (app.revoked_at) return { ok: false, error: 'revoked' };
  if (app.client_type === 'public') return { ok: false, error: 'public_client_no_secret' };

  const rawSecret = generateClientSecret();
  const secretHash = hashClientSecret(rawSecret);

  // CodeRabbit (TRO-408 review): the `revoked_at`/`client_type` checks above
  // are read-then-act — a concurrent revoke between that SELECT and this
  // UPDATE would otherwise still "succeed" and hand out a working secret for
  // an app that's supposed to be dead. Pushing `revoked_at IS NULL` into the
  // WHERE clause makes the database the one deciding, not application code
  // (lessons.md rule 18: "push the predicate into the WHERE clause"). If a
  // revoke won the race, 0 rows match.
  //
  // TRO-492: `workspace_id` restored to this predicate (was missing —
  // verified by reading this function, not assumed), and
  // `client_secret_hash IS NOT DISTINCT FROM $4` added as an optimistic-
  // concurrency guard against a second, concurrent rotation — see the
  // module comment above `rotateOAuthAppSecret` for the full race argument.
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE oauth_apps SET client_secret_hash = $1
     WHERE id = $2 AND workspace_id = $3 AND revoked_at IS NULL
       AND client_secret_hash IS NOT DISTINCT FROM $4
     RETURNING id`,
    [secretHash, app.id, params.workspaceId, app.client_secret_hash]
  );
  if (updateResult.rows.length === 0) {
    // Zero rows matched for one of two distinct reasons — re-read rather
    // than guessing, so the caller gets the right error: a revoke that won
    // the race (pre-existing protection, above), or a concurrent rotation
    // that landed first (the race this ticket closes). Both are real
    // outcomes a caller needs to distinguish: `revoked` is terminal,
    // `conflict` is retry-able.
    const recheck = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM oauth_apps WHERE id = $1 AND workspace_id = $2`,
      [app.id, params.workspaceId]
    );
    const current = recheck.rows[0];
    if (!current) return { ok: false, error: 'not_found' };
    if (current.revoked_at) return { ok: false, error: 'revoked' };
    return { ok: false, error: 'conflict' };
  }

  return { ok: true, clientSecret: rawSecret };
}

export type RevokeOAuthAppError = 'not_found' | 'already_revoked';

export type RevokeOAuthAppResult = { ok: true } | { ok: false; error: RevokeOAuthAppError };

/** AC-5: sets `revoked_at`. The `WHERE revoked_at IS NULL` guard makes this
 * idempotent-safe at the SQL level — a second revoke call cannot stomp an
 * earlier timestamp — and lets the caller distinguish "already revoked" from
 * "never existed" for a clearer error message. */
export async function revokeOAuthApp(params: {
  appId: string;
  workspaceId: string;
}): Promise<RevokeOAuthAppResult> {
  const result = await pool.query<{ id: string }>(
    `UPDATE oauth_apps SET revoked_at = now()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [params.appId, params.workspaceId]
  );
  if (result.rows.length > 0) return { ok: true };

  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM oauth_apps WHERE id = $1 AND workspace_id = $2`,
    [params.appId, params.workspaceId]
  );
  if (exists.rows.length === 0) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'already_revoked' };
}

export type VerifyAppCredentialsFailureReason =
  | 'not_found'
  | 'revoked'
  | 'no_secret_configured'
  | 'invalid_secret';

export type VerifyAppCredentialsResult =
  | { ok: true; app: OAuthAppSummary }
  | { ok: false; reason: VerifyAppCredentialsFailureReason };

/**
 * Verifies a `client_id` + raw `client_secret` pair against `oauth_apps` —
 * the same hash-then-compare shape as `auth.ts`'s `validateApiToken`
 * (`WHERE token_hash = $1`), adapted to look up by `client_id` first because
 * a client presents both values together rather than one opaque bearer
 * string. Revoked apps and public apps (no secret to check) both fail
 * closed. Proves AC-4 (old secret fails / new secret succeeds immediately
 * after rotation) and AC-5 (revoked app's secret no longer authenticates).
 */
export async function verifyAppCredentials(params: {
  clientId: string;
  clientSecret: string;
}): Promise<VerifyAppCredentialsResult> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT ${APP_COLUMNS} FROM oauth_apps WHERE client_id = $1`,
    [params.clientId]
  );
  const app = result.rows[0];
  if (!app) return { ok: false, reason: 'not_found' };
  if (app.revoked_at) return { ok: false, reason: 'revoked' };
  if (!app.client_secret_hash) return { ok: false, reason: 'no_secret_configured' };

  // Constant-time compare (same defensive pattern as PF-303's
  // `webhooks/signer.ts`): length-check first, since `timingSafeEqual`
  // throws rather than returning `false` on unequal-length buffers, then
  // compare. Both operands are hex-encoded SHA-256 digests (64 chars) here,
  // so length mismatch alone is already conclusive.
  const providedHash = hashClientSecret(params.clientSecret);
  const providedBuf = Buffer.from(providedHash, 'hex');
  const storedBuf = Buffer.from(app.client_secret_hash, 'hex');
  const matches =
    providedBuf.length === storedBuf.length && crypto.timingSafeEqual(providedBuf, storedBuf);
  if (!matches) return { ok: false, reason: 'invalid_secret' };

  return { ok: true, app: toSummary(app) };
}
