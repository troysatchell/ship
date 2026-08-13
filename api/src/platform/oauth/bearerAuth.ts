/**
 * `bearerAuth` — the v1 bearer-token middleware (PLUGFORGE.MD §4, PF-107).
 *
 * Accepts exactly two token classes and populates `req.principal = { app,
 * user, scopes }` on success (see `./principal.ts` for the shape):
 *
 *   1. An OAuth access token — looked up in `oauth_tokens` by
 *      `access_token_hash`. `app` is always present; `user` is `null` only
 *      for a Client Credentials token (§2.2: "nullable — null for Client
 *      Credentials").
 *   2. A scoped personal token — looked up in `api_tokens` by `token_hash`,
 *      but ONLY when `scopes IS NOT NULL`. A `NULL`-scopes row is the
 *      existing, pre-PlugForge unscoped internal token (`api_tokens` has
 *      always existed; migration 043 only added the `scopes` column) — §4's
 *      PF-107 block and this ticket's binding PM decision are explicit that
 *      such a row is NEVER valid at `/api/v1`, so it is rejected exactly
 *      like an unrecognized token, not silently upgraded to "all scopes" or
 *      "no scopes required".
 *
 * A raw bearer value is looked up in `oauth_tokens` first, then
 * `api_tokens` — two sequential queries rather than one `UNION ALL`, kept
 * simple because a request either presents a credential from one table or
 * the other, never both, and the hot-path cost either way is one indexed
 * lookup (`idx_oauth_tokens_access_token_hash`) or two.
 *
 * 401 reasons are a closed three-value enum (`missing_token` / `invalid_token`
 * / `expired_token`) — a binding PM triage decision on TRO-430
 * (2026-08-10): a revoked token reports `invalid_token` to the caller,
 * identically to an unrecognized one. Revocation IS distinguished server-side
 * (the `console.warn` calls below) — but not yet in a `public_api_audit` row,
 * because that table (migration 046, PF-501) has not landed as of this
 * ticket; noted as a gap in this ticket's final report, to be closed when
 * PF-501's audit middleware exists to write it.
 */

import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../../db/client.js';
import { unauthorizedError, serverError, type Unauthorized401Reason } from '../api/v1/errors.js';
import type { Principal } from './principal.js';
import './principal.js';

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface OauthTokenLookupRow {
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  app_id: string;
  app_client_id: string;
  app_name: string;
  app_is_first_party: boolean;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
}

interface PersonalTokenLookupRow {
  scopes: string[] | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  user_id: string;
  user_email: string;
  user_name: string;
}

async function lookupOauthToken(tokenHash: string): Promise<OauthTokenLookupRow | null> {
  const result = await pool.query<OauthTokenLookupRow>(
    `SELECT ot.scopes, ot.expires_at, ot.revoked_at,
            a.id AS app_id, a.client_id AS app_client_id, a.name AS app_name,
            a.is_first_party AS app_is_first_party,
            u.id AS user_id, u.email AS user_email, u.name AS user_name
     FROM oauth_tokens ot
     JOIN oauth_apps a ON a.id = ot.app_id
     LEFT JOIN users u ON u.id = ot.user_id
     WHERE ot.access_token_hash = $1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

async function lookupPersonalToken(tokenHash: string): Promise<PersonalTokenLookupRow | null> {
  const result = await pool.query<PersonalTokenLookupRow>(
    `SELECT t.scopes, t.expires_at, t.revoked_at,
            u.id AS user_id, u.email AS user_email, u.name AS user_name
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

/** Every rejection path funnels through here, so the response shape and the
 *  (optional) server-side log line are written in exactly one place. */
function reject(
  req: Request,
  res: Response,
  reason: Unauthorized401Reason,
  message: string,
  logNote?: string,
): void {
  if (logNote) {
    // Server-side-only distinction (revocation vs. "never existed") per the
    // binding PM decision — the response body/reason never varies by cause.
    console.warn(`[bearerAuth] ${logNote}`);
  }
  const err = unauthorizedError(req.requestId ?? '', reason, message);
  res.status(err.httpStatus).json(err.toJSON());
}

const INVALID_TOKEN_MESSAGE = 'Invalid or unknown access token.';

export async function bearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reject(req, res, 'missing_token', 'No access token provided.');
    return;
  }

  const rawToken = authHeader.slice('Bearer '.length).trim();
  if (rawToken.length === 0) {
    reject(req, res, 'missing_token', 'No access token provided.');
    return;
  }

  const tokenHash = hashToken(rawToken);

  try {
    const oauthRow = await lookupOauthToken(tokenHash);
    if (oauthRow) {
      if (oauthRow.revoked_at) {
        reject(
          req, res, 'invalid_token', INVALID_TOKEN_MESSAGE,
          'bearerAuth: rejected revoked oauth token',
        );
        return;
      }
      if (new Date(oauthRow.expires_at).getTime() < Date.now()) {
        reject(req, res, 'expired_token', 'Access token has expired.');
        return;
      }

      const principal: Principal = {
        app: {
          id: oauthRow.app_id,
          clientId: oauthRow.app_client_id,
          name: oauthRow.app_name,
          isFirstParty: oauthRow.app_is_first_party,
        },
        user:
          oauthRow.user_id && oauthRow.user_email && oauthRow.user_name
            ? { id: oauthRow.user_id, email: oauthRow.user_email, name: oauthRow.user_name }
            : null,
        scopes: oauthRow.scopes,
      };
      req.principal = principal;
      next();
      return;
    }

    const personalRow = await lookupPersonalToken(tokenHash);
    if (personalRow) {
      if (personalRow.revoked_at) {
        reject(
          req, res, 'invalid_token', INVALID_TOKEN_MESSAGE,
          'bearerAuth: rejected revoked personal token',
        );
        return;
      }
      if (personalRow.scopes === null) {
        // The landmine: a legacy unscoped internal token. Never valid here.
        reject(
          req, res, 'invalid_token', INVALID_TOKEN_MESSAGE,
          'bearerAuth: rejected legacy unscoped personal token (scopes IS NULL) at /api/v1',
        );
        return;
      }
      if (personalRow.expires_at && new Date(personalRow.expires_at).getTime() < Date.now()) {
        reject(req, res, 'expired_token', 'Access token has expired.');
        return;
      }

      req.principal = {
        app: null,
        user: { id: personalRow.user_id, email: personalRow.user_email, name: personalRow.user_name },
        scopes: personalRow.scopes,
      };
      next();
      return;
    }

    reject(req, res, 'invalid_token', INVALID_TOKEN_MESSAGE);
  } catch (error) {
    console.error('[bearerAuth] token lookup failed', error);
    const err = serverError(req.requestId ?? '', 'Authentication failed.');
    res.status(err.httpStatus).json(err.toJSON());
  }
}
