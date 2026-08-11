/**
 * `/oauth/authorize` service logic — PKCE authorization-code issuance
 * (PF-103, TRO-412, PLUGFORGE.MD §4).
 *
 * Owns reads against `oauth_apps` (migration 042, PF-101) and writes to
 * `oauth_authorization_codes` (migration 043, PF-101). The route file
 * (`api/src/routes/oauth-authorize.ts`) is deliberately thin, same split as
 * PF-102's `oauth-apps.ts` / `appRegistration.ts`.
 *
 * PROVENANCE NOTE (read before assuming this duplicates PF-102): PF-102 (app
 * registration, PR #177) merged to GitHub `main` on 2026-08-10, but this
 * worktree branched from GitLab-mirrored `main`, which had not yet been
 * re-synced from GitHub as of this ticket — confirmed by `git merge-base
 * --is-ancestor` against both remotes, not assumed. PF-102's actual
 * `appRegistration.ts`/`credentials.ts` are therefore not importable from
 * this branch. This file talks to `oauth_apps` directly (the table itself
 * *is* available — migration 042 landed earlier, under PF-101/TRO-406, which
 * genuinely is on this branch) and duplicates the small SHA-256 hashing
 * convention rather than importing it from code that doesn't exist here yet.
 * See CHANGES.md (TRO-412) for the full account.
 */

import crypto from 'crypto';
import type { Request } from 'express';
import { pool } from '../../db/client.js';
import { SESSION_INACTIVITY_LIMIT_MS } from '../../middleware/auth.js';
import { ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

/** Row shape for the `oauth_apps` lookup below — named per lessons.md RULE-21
 * (`pool.query` rows are `any` unless given an explicit interface). */
export interface OAuthAppLookupRow {
  id: string;
  workspace_id: string;
  client_id: string;
  name: string;
  redirect_uris: string[];
  requested_scopes: string[];
  revoked_at: Date | null;
}

/** Auth codes are single-use and short-lived (§2.2: "10 minutes"). */
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

/** Look up a registered OAuth app by its public `client_id`. Returns `null`
 * for an unknown OR revoked app — callers must not distinguish the two in
 * their response (an attacker probing `client_id`s should not learn which
 * case applied). */
export async function getOAuthAppByClientId(clientId: string): Promise<OAuthAppLookupRow | null> {
  const result = await pool.query<OAuthAppLookupRow>(
    `SELECT id, workspace_id, client_id, name, redirect_uris, requested_scopes, revoked_at
     FROM oauth_apps
     WHERE client_id = $1`,
    [clientId]
  );
  const app = result.rows[0];
  if (!app || app.revoked_at) return null;
  return app;
}

/**
 * Exact string match ONLY — the ticket's own AC and its test-design comment
 * both explicitly reject normalizing or prefix-matching (a trailing-slash
 * variant, or a case-different host, must be REJECTED, not "helpfully"
 * accepted). This is the open-redirect guard: a caller that cannot prove its
 * `redirect_uri` is the exact one the app registered must never be trusted
 * with a redirect at all.
 */
export function redirectUriIsRegistered(app: OAuthAppLookupRow, redirectUri: string): boolean {
  return app.redirect_uris.some((registered) => registered === redirectUri);
}

/**
 * Every requested scope must be one the app itself registered
 * (`oauth_apps.requested_scopes`) — otherwise a client (or a forged
 * request) could ask for `admin:write` on an app that only ever declared
 * `documents:read`, and the consent screen the user actually saw would say
 * something narrower than what got persisted onto the issued code (and, via
 * PF-104, the token). CodeRabbit review finding, TRO-412 — the scope
 * parameter reached `issueAuthorizationCode` completely unvalidated before
 * this existed.
 */
export function scopesAreRegistered(app: OAuthAppLookupRow, scopes: string[]): boolean {
  return scopes.every((scope) => app.requested_scopes.includes(scope));
}

/**
 * The consenting user's own workspace must be the one that registered the
 * app. Without this, any authenticated user in ANY workspace could consent
 * to an app registered by a different tenant and hand it access to their
 * own account/data — a cross-tenant boundary violation. CodeRabbit review
 * finding, TRO-412.
 */
export function principalOwnsAppWorkspace(app: OAuthAppLookupRow, workspaceId: string): boolean {
  return app.workspace_id === workspaceId;
}

/** SHA-256 hex digest — same hashing pattern as `api-tokens.ts`'s
 * `hashToken`/PF-102's `hashClientSecret` (see the provenance note above for
 * why this is a small local duplicate rather than a shared import). */
export function hashAuthorizationCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Cryptographically random, unprefixed (short-lived, single-use, never
 * displayed as a long-term credential — unlike `ship_app_…`/`ship_appsec_…`,
 * an auth code has no reason to be identifiable at a glance). */
export function generateAuthorizationCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** RFC 6749 §3.3: `scope` is a space-delimited list. Empty/absent -> []. */
export function parseScopeParam(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.split(' ').filter(Boolean);
}

export interface IssueAuthorizationCodeParams {
  appId: string;
  userId: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
}

/**
 * Issues a single-use authorization code: hashed at rest (never the
 * plaintext — only `code_hash` is a column on `oauth_authorization_codes`),
 * 10-minute expiry, `consumed_at` left NULL (unconsumed; PF-104's `/oauth/
 * token` is what sets it). `code_challenge_method` is hardcoded to `'S256'`
 * here, not passed in — the CHECK constraint on migration 043's column
 * already enforces S256-only at the database level, and the caller (the
 * route) rejects anything else before this function is ever called, so
 * threading a value through that could only ever legally be `'S256'` would
 * just be another place for that invariant to silently drift.
 *
 * Returns the raw code. Only the caller's redirect response ever sees it —
 * nothing here logs it or stores it anywhere but this one hashed column.
 */
export async function issueAuthorizationCode(
  params: IssueAuthorizationCodeParams
): Promise<string> {
  const code = generateAuthorizationCode();
  const codeHash = hashAuthorizationCode(code);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS);

  await pool.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, app_id, user_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'S256', $6, $7)`,
    [
      codeHash,
      params.appId,
      params.userId,
      params.scopes,
      params.codeChallenge,
      params.redirectUri,
      expiresAt,
    ]
  );

  return code;
}

export interface SessionPrincipal {
  userId: string;
  workspaceId: string;
}

interface SessionLookupRow {
  user_id: string;
  workspace_id: string;
  last_activity: Date;
  created_at: Date;
}

/**
 * Read-only session validity check, deliberately NOT a call into
 * `authMiddleware` (`api/src/middleware/auth.ts`) — that function writes its
 * own JSON 401 response directly, which is wrong for `/oauth/authorize`: a
 * browser top-level navigation needs a redirect to `/login`, not a JSON
 * body. Session/CSRF/cookie semantics are a stop-for-human zone
 * (`/ship-backend`), so rather than editing that file this duplicates only
 * the two READ checks it performs (inactivity + absolute age), importing
 * the same constants it exports (`SESSION_INACTIVITY_LIMIT_MS` from
 * `auth.ts`, `ABSOLUTE_SESSION_TIMEOUT_MS` from `@ship/shared`) so the
 * validity window can never drift out of sync with the real middleware.
 *
 * Deliberately does NOT replicate the sliding-window `last_activity`
 * UPDATE or the expired-session `DELETE` — this is a one-shot, infrequent
 * OAuth action, not a general-purpose auth gate, and skipping the write
 * avoids a second, independently-reasoned-about write path onto the
 * `sessions` table. One documented behavior difference: visiting
 * `/oauth/authorize` does not reset the user's idle timer the way an
 * `/api/*` call would.
 */
export async function getSessionPrincipal(req: Request): Promise<SessionPrincipal | null> {
  const sessionId = req.cookies?.session_id;
  if (!sessionId || typeof sessionId !== 'string') return null;

  const result = await pool.query<SessionLookupRow>(
    `SELECT user_id, workspace_id, last_activity, created_at FROM sessions WHERE id = $1`,
    [sessionId]
  );
  const session = result.rows[0];
  if (!session) return null;

  const now = Date.now();
  const inactivityMs = now - new Date(session.last_activity).getTime();
  const sessionAgeMs = now - new Date(session.created_at).getTime();
  if (inactivityMs > SESSION_INACTIVITY_LIMIT_MS || sessionAgeMs > ABSOLUTE_SESSION_TIMEOUT_MS) {
    return null;
  }

  return { userId: session.user_id, workspaceId: session.workspace_id };
}
