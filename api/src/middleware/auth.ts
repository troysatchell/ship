import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/client.js';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS, ERROR_CODES, HTTP_STATUS } from '@ship/shared';

// Extend Express Request to include session info
declare global {
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: string;
      workspaceId?: string;
      isSuperAdmin?: boolean;
      isApiToken?: boolean; // True when authenticated via API token
    }
  }
}

/**
 * A request that has passed through {@link authMiddleware}: `userId` and
 * `workspaceId` are guaranteed present, not optional.
 *
 * Both `sessions.workspace_id` (schema.sql) and `api_tokens.workspace_id`
 * (migrations/014_api_tokens.sql) are `NOT NULL` columns, and `authMiddleware`
 * always sets both fields together — the API-token branch at :118-119, the
 * session-cookie branch at :285-286 — before calling `next()`. So every request
 * that reaches a handler wrapped in {@link authed} already satisfies this shape;
 * this type documents a runtime guarantee that already existed, it does not add one.
 */
export interface AuthenticatedRequest extends Request {
  userId: string;
  workspaceId: string;
}

type AuthedRouteHandler = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

function isAuthenticatedRequest(req: Request): req is AuthenticatedRequest {
  return typeof req.userId === 'string' && typeof req.workspaceId === 'string';
}

/**
 * Wraps a route handler so `req.userId` / `req.workspaceId` are typed as required
 * `string`s rather than `string | undefined` — this is what retires the non-null
 * assertions on those two fields across the route files (TS-4 / TRO-209). Register
 * it AFTER `authMiddleware` (directly, or via a `router.use(authMiddleware, …)`
 * ahead of the route) — `authed()` does not authenticate the request itself, it
 * only narrows the type of an already authenticated one.
 *
 * The `isAuthenticatedRequest` check is a type guard, not a new authorization
 * decision: on every route in this codebase `authed()` sits downstream of
 * `authMiddleware`, which always populates both fields before calling `next()` (see
 * {@link AuthenticatedRequest}) — so the guard never rejects a real request today,
 * and observable behavior for every currently-registered route is unchanged. It
 * exists so a *future* route wired up without `authMiddleware` fails closed (401)
 * instead of silently forwarding `undefined` into a query — the exact hole TS-4
 * describes — where before this change it would instead type-check identically to
 * an authenticated route and forward `undefined` at runtime.
 */
export function authed(
  handler: AuthedRouteHandler
): (req: Request, res: Response, next: NextFunction) => void | Promise<void> {
  return (req, res, next) => {
    if (!isAuthenticatedRequest(req)) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: 'Authentication required',
        },
      });
      return;
    }
    return handler(req, res, next);
  };
}

/**
 * How often an authenticated request is allowed to rewrite `sessions.last_activity`.
 *
 * The sliding-cookie refresh below has always been throttled at this interval
 * ("throttled to avoid overhead"); the database write was not, so every read
 * dirtied the session row and generated WAL.
 */
export const SESSION_ACTIVITY_UPDATE_THRESHOLD_MS = 60 * 1000;

/**
 * The inactivity window actually enforced against the *recorded* `last_activity`.
 *
 * Because the write is throttled, the recorded value trails real request activity
 * by at most `SESSION_ACTIVITY_UPDATE_THRESHOLD_MS`. Comparing a lagging value
 * against a bare `SESSION_TIMEOUT_MS` would end sessions *early* — up to 60s before
 * the documented 15 minutes — and the web client runs its own 15-minute idle timer
 * off real user interaction (`web/src/hooks/useSessionTimeout.ts`), so an early
 * server-side expiry surfaces as an unexplained 401 while the client still believes
 * it is logged in.
 *
 * Carrying the throttle interval as grace makes the rounding error extend a session
 * instead of ending one: true idle logout lands in
 * [SESSION_TIMEOUT_MS, SESSION_TIMEOUT_MS + SESSION_ACTIVITY_UPDATE_THRESHOLD_MS].
 * The 12-hour absolute cap (`ABSOLUTE_SESSION_TIMEOUT_MS`) is unaffected.
 */
export const SESSION_INACTIVITY_LIMIT_MS =
  SESSION_TIMEOUT_MS + SESSION_ACTIVITY_UPDATE_THRESHOLD_MS;

// Hash a token for comparison
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Validate API token and return user info if valid
async function validateApiToken(token: string): Promise<{
  userId: string;
  workspaceId: string;
  isSuperAdmin: boolean;
  tokenId: string;
} | null> {
  const tokenHash = hashToken(token);

  const result = await pool.query(
    `SELECT t.id, t.user_id, t.workspace_id, t.expires_at, t.revoked_at, u.is_super_admin
     FROM api_tokens t
     JOIN users u ON t.user_id = u.id
     WHERE t.token_hash = $1`,
    [tokenHash]
  );

  const tokenRow = result.rows[0];

  if (!tokenRow) return null;

  // Check if revoked
  if (tokenRow.revoked_at) return null;

  // Check if expired
  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) return null;

  // Update last_used_at
  await pool.query(
    'UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1',
    [tokenRow.id]
  );

  return {
    userId: tokenRow.user_id,
    workspaceId: tokenRow.workspace_id,
    isSuperAdmin: tokenRow.is_super_admin,
    tokenId: tokenRow.id,
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Check for Bearer token first (API token auth)
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    try {
      const tokenData = await validateApiToken(token);

      if (!tokenData) {
        res.status(HTTP_STATUS.UNAUTHORIZED).json({
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: 'Invalid or expired API token',
          },
        });
        return;
      }

      // Attach token info to request
      req.userId = tokenData.userId;
      req.workspaceId = tokenData.workspaceId;
      req.isSuperAdmin = tokenData.isSuperAdmin;
      req.isApiToken = true;

      next();
      return;
    } catch (error) {
      console.error('API token auth error:', error);
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Authentication failed',
        },
      });
      return;
    }
  }

  // Fall back to session cookie auth
  const sessionId = req.cookies?.session_id;

  if (!sessionId) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'No session found',
      },
    });
    return;
  }

  try {
    // Get session and check if it's valid
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.workspace_id, s.expires_at, s.last_activity, s.created_at,
              u.is_super_admin
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1`,
      [sessionId]
    );

    const session = result.rows[0];

    if (!session) {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: 'Invalid session',
        },
      });
      return;
    }

    const now = new Date();
    const lastActivity = new Date(session.last_activity);
    const createdAt = new Date(session.created_at);
    const inactivityMs = now.getTime() - lastActivity.getTime();
    const sessionAgeMs = now.getTime() - createdAt.getTime();

    // Check 12-hour absolute session timeout (NIST SP 800-63B-4 AAL2)
    if (sessionAgeMs > ABSOLUTE_SESSION_TIMEOUT_MS) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.SESSION_EXPIRED,
          message: 'Session expired. Please log in again.',
        },
      });
      return;
    }

    // Check the inactivity timeout. Compared against SESSION_INACTIVITY_LIMIT_MS, not
    // SESSION_TIMEOUT_MS, because `last_activity` is written on a throttle below and so
    // trails real request activity by up to SESSION_ACTIVITY_UPDATE_THRESHOLD_MS. The
    // grace makes that lag extend a session rather than end one early.
    if (inactivityMs > SESSION_INACTIVITY_LIMIT_MS) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          code: ERROR_CODES.SESSION_EXPIRED,
          message: 'Session expired due to inactivity',
        },
      });
      return;
    }

    // Verify user still has access to the workspace (unless super-admin)
    if (session.workspace_id && !session.is_super_admin) {
      const membershipResult = await pool.query(
        'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [session.workspace_id, session.user_id]
      );

      if (!membershipResult.rows[0]) {
        // User no longer has access - delete session
        await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

        res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: {
            code: ERROR_CODES.FORBIDDEN,
            message: 'Access to this workspace has been revoked',
          },
        });
        return;
      }
    }

    // Refresh the session's sliding expiration — both halves of it, on one throttle.
    //
    // The cookie refresh was already throttled here "to avoid overhead"; the database
    // write was not, so every authenticated read issued
    // `UPDATE sessions SET last_activity` against the same row. One page load fires
    // 5-13 requests, so a read-only page produced 5-13 row-locking, WAL-generating
    // writes and 3 of every 4 statements on a document read were auth overhead
    // (DB-2 / TRO-179, API-6 / TRO-177).
    //
    // Skipping the write means `last_activity` trails real activity by at most
    // SESSION_ACTIVITY_UPDATE_THRESHOLD_MS, which is why the inactivity check above
    // carries the same interval as grace.
    if (inactivityMs > SESSION_ACTIVITY_UPDATE_THRESHOLD_MS) {
      // The throttle is expressed TWICE, deliberately, because the two placements buy
      // different things and neither one alone is sufficient:
      //
      //   - The check above uses the value this request already SELECTed, so when it says
      //     "not due" no statement is sent at all. That is what removes the query from
      //     the hot path (DB-2's headline metric was queries per request).
      //   - `AND last_activity < $3` re-checks the same predicate inside the database,
      //     because the value read above can already be stale. A page load fires 5-13
      //     requests in parallel; when the burst straddles the threshold they all SELECT
      //     the same pre-write `last_activity` and all conclude the write is due. Left
      //     unconditional, the burst degrades to one write per request — precisely the
      //     row-lock and WAL contention this change exists to remove. With the predicate,
      //     Postgres arbitrates: under READ COMMITTED the losers re-evaluate the
      //     qualification against the committed row version, fail it, and affect 0 rows.
      //
      // A no-op is the expected outcome under contention, so rowCount is not inspected.
      // `last_activity IS NULL` cannot reach here — the inactivity check above reads NULL
      // as the epoch and has already rejected the session.
      const activityCutoff = new Date(now.getTime() - SESSION_ACTIVITY_UPDATE_THRESHOLD_MS);
      await pool.query(
        'UPDATE sessions SET last_activity = $1 WHERE id = $2 AND last_activity < $3',
        [now, sessionId, activityCutoff]
      );

      res.cookie('session_id', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        // Matches the server-side window so the browser cannot drop the cookie
        // before the server would have rejected the session.
        maxAge: SESSION_INACTIVITY_LIMIT_MS,
        path: '/',
      });
    }

    // Attach session info to request
    req.sessionId = session.id;
    req.userId = session.user_id;
    req.workspaceId = session.workspace_id;
    req.isSuperAdmin = session.is_super_admin;

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authentication failed',
      },
    });
  }
}

// Middleware that requires super-admin access
export async function superAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.isSuperAdmin) {
    res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: {
        code: ERROR_CODES.FORBIDDEN,
        message: 'Super-admin access required',
      },
    });
    return;
  }

  next();
}

// Middleware that requires workspace admin access (or super-admin)
export async function workspaceAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Super-admins always have access
  if (req.isSuperAdmin) {
    next();
    return;
  }

  const workspaceId = req.params.id || req.workspaceId;

  if (!workspaceId) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Workspace ID required',
      },
    });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    const membership = result.rows[0];

    if (!membership || membership.role !== 'admin') {
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          code: ERROR_CODES.FORBIDDEN,
          message: 'Workspace admin access required',
        },
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Workspace admin middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authorization check failed',
      },
    });
  }
}

// Middleware that verifies access to a specific workspace
export async function workspaceAccessMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Super-admins always have access
  if (req.isSuperAdmin) {
    next();
    return;
  }

  const workspaceId = req.params.workspaceId || req.workspaceId;

  if (!workspaceId) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Workspace ID required',
      },
    });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    if (!result.rows[0]) {
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          code: ERROR_CODES.FORBIDDEN,
          message: 'Access denied to this workspace',
        },
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Workspace access middleware error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Authorization check failed',
      },
    });
  }
}
