/**
 * `/api/v1` rate-limit headers + enforcement (PLUGFORGE.MD §2.7, PF-500,
 * Linear TRO-427). Two middlewares, both exported from here and wired into
 * two different places for two different reasons — see each one's own doc
 * comment below for exactly why.
 *
 * Not `api/src/middleware/rate-limit.ts` — that file is the legacy
 * `express-rate-limit` chain (IP/identity-keyed, `/api/` prefix) and, as of
 * PF-004/TRO-401, explicitly EXEMPTS `/api/v1` so this module can govern it
 * instead (see that file's `isLegacyLimiterExemptPath`). Nothing in this
 * file touches that one.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { TokenBucket, systemClock, type Clock, type BucketState } from './tokenBucket.js';
import { resolveRateLimits, type RateLimitEnv } from './config.js';
import { rateLimitedError } from '../api/v1/errors.js';
import '../oauth/principal.js';

export const RATE_LIMIT_HEADERS = {
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
} as const;

function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/**
 * Reads the raw bearer credential straight off the Authorization header — no
 * DB lookup, and deliberately independent of `bearerAuth.ts`'s own parsing
 * (this file must not import from there just to duplicate three lines).
 * `rateLimitBuckets` below only ever calls this AFTER `bearerAuth` has
 * already required exactly this shape to set `req.principal`, so a null
 * result at that point is unreachable in practice — handled defensively
 * anyway (see the comment at that call site).
 */
function rawBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Hashes a credential before using it as an in-memory bucket key, matching
 * `api/src/middleware/rate-limit.ts`'s `fingerprint` precedent (a live
 * bearer token should never sit in process memory verbatim, even in a
 * short-lived Map key).
 */
function hashCredential(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 22);
}

function setRateLimitHeaders(res: Response, state: BucketState): void {
  res.setHeader(RATE_LIMIT_HEADERS.limit, String(state.limit));
  res.setHeader(RATE_LIMIT_HEADERS.remaining, String(state.remaining));
  res.setHeader(RATE_LIMIT_HEADERS.reset, String(Math.ceil(state.resetAfterMs / 1000)));
}

/** Whichever of the two buckets is closer to exhaustion (smaller
 *  remaining/limit fraction) is the one actually governing what the caller
 *  can do next — that's the one reported in the headers. */
function moreRestrictive(a: BucketState, b: BucketState): BucketState {
  return a.remaining / a.limit <= b.remaining / b.limit ? a : b;
}

/** When at least one of the (up to two) buckets denies, pick the one whose
 *  denial the caller actually has to wait out — the larger `retryAfterMs` if
 *  both deny, otherwise whichever one actually denied. */
function pickDenied(appPeek: BucketState | null, tokenPeek: BucketState): BucketState {
  if (appPeek && !appPeek.allowed && !tokenPeek.allowed) {
    return appPeek.retryAfterMs >= tokenPeek.retryAfterMs ? appPeek : tokenPeek;
  }
  if (appPeek && !appPeek.allowed) return appPeek;
  return tokenPeek;
}

export interface RateLimitMiddlewares {
  rateLimitDefaults: RequestHandler;
  rateLimitBuckets: RequestHandler;
  /** Test seam only — lets a test drive the exact same buckets the
   *  middleware reads/writes (e.g. to pre-exhaust one before an HTTP call). */
  appBuckets: TokenBucket;
  tokenBuckets: TokenBucket;
}

/**
 * Builds the two `/api/v1` rate-limit middlewares plus the bucket stores
 * backing them. `env`/`clock` are DI seams — production uses the defaults
 * (`process.env`, the real clock) via the module-level singleton exported
 * below; tests construct their own instance with a small RPM and a fake
 * clock so exhaustion/refill is deterministic (`__tests__/middleware.test.ts`,
 * `__tests__/tokenBucket.test.ts`).
 */
export function createRateLimitMiddleware(
  env: RateLimitEnv = process.env,
  clock: Clock = systemClock
): RateLimitMiddlewares {
  const { windowMs, appRpm, tokenRpm } = resolveRateLimits(env);
  const appBuckets = new TokenBucket(appRpm, windowMs, clock);
  const tokenBuckets = new TokenBucket(tokenRpm, windowMs, clock);

  /**
   * Mounted GLOBALLY, first in the `/api/v1` middleware chain
   * (`platform/api/v1/router.ts`, right after `requestIdMiddleware` and
   * before `v1Routes`) — i.e. before any routing happens at all, including
   * `notFoundHandler`'s catch-all and a matched route's own `bearerAuth`.
   *
   * This is what makes "100% of `/api/v1` responses carry X-RateLimit-*"
   * (PLUGFORGE.MD §2.7) true for the responses `rateLimitBuckets` below
   * never reaches:
   *   - an unauthenticated 401 from `bearerAuth` itself (no `req.principal`
   *     exists yet — the per-app/per-token buckets need one to key on);
   *   - a 404 from an unmatched route or unsupported method;
   *   - every genuinely public, unauthenticated route (`GET /health`,
   *     `GET /openapi.json`).
   *
   * Deliberately NOT a real per-caller bucket: an unauthenticated request
   * carries no stable identity to key on yet (that's exactly what
   * `bearerAuth` is about to determine, one way or the other), so keying
   * anything here on a request-controlled value (IP, raw header, ...) would
   * let an attacker mint unlimited distinct Map entries for free, before
   * `bearerAuth` ever gets a chance to reject them — an unbounded-memory
   * vector. These headers are informational ("you have not spent anything
   * yet") and are OVERWRITTEN by `rateLimitBuckets` with real numbers the
   * moment a request actually authenticates.
   */
  const rateLimitDefaults: RequestHandler = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(RATE_LIMIT_HEADERS.limit, String(tokenRpm));
    res.setHeader(RATE_LIMIT_HEADERS.remaining, String(tokenRpm));
    res.setHeader(RATE_LIMIT_HEADERS.reset, String(Math.ceil(windowMs / 1000)));
    next();
  };

  /**
   * Mounted PER-ROUTE, immediately after `bearerAuth` (before `requireScope`
   * and the handler) on every protected `/api/v1` route — see each
   * `resources/*.ts` file's route arrays. By the time this runs,
   * `req.principal` is guaranteed set: `bearerAuth` never calls `next()`
   * without it.
   *
   * Two buckets, keyed independently (PLUGFORGE.MD §2.7):
   *  - per-APP, keyed by `principal.app.clientId`, default 120/min — SKIPPED
   *    entirely when `principal.app` is null (a scoped personal token;
   *    `Principal.app` is only ever set for an OAuth token —
   *    `platform/oauth/principal.ts`). A personal-token request is governed
   *    by the per-token bucket alone.
   *  - per-TOKEN, keyed by a hash of the RAW bearer credential actually
   *    presented (not the user/app id) — default 60/min. Two different
   *    tokens issued to the same identity get independent budgets, matching
   *    "per token" literally rather than "per identity".
   *
   * Both buckets are `peek`ed before either is `consume`d, so a request that
   * would exhaust the token bucket never partially debits the app bucket
   * first (no rollback needed — see `TokenBucket.peek` vs `.consume`).
   *
   * Running this BEFORE `requireScope` (not after) means it also governs
   * requests that end up 403 for insufficient scope — a caller hammering
   * with a valid-but-under-scoped token still spends real budget, rather
   * than getting a free unlimited-volume probe. And running it right after
   * `bearerAuth`, before any handler code, means the X-RateLimit-* headers
   * are already on the response by the time anything downstream (a handler
   * throwing a `not_found`/`validation_failed` ApiError, `requireScope`
   * throwing `forbidden`) reaches `errorMiddleware` — headers set via
   * `res.setHeader` persist through to whatever later calls
   * `res.status(...).json(...)`, so `errorMiddleware.ts` needed no change.
   */
  const rateLimitBuckets: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.principal;
    if (!principal) {
      // Unreachable in practice — every route that mounts this runs
      // bearerAuth first, and bearerAuth never calls next() without setting
      // req.principal (same defensive pattern as resources/me.ts and every
      // other v1 handler in this codebase). Skip rather than guess at a key.
      next();
      return;
    }

    const rawToken = rawBearerToken(req);
    if (!rawToken) {
      // Unreachable in practice — see rawBearerToken's doc comment: getting
      // this far already required an Authorization: Bearer <token> header.
      // Dropping enforcement on an otherwise-valid request is far safer than
      // 500ing it over a defensive-only branch.
      next();
      return;
    }

    const tokenKey = `t:${hashCredential(rawToken)}`;
    const appKey = principal.app ? `a:${principal.app.clientId}` : null;

    const tokenPeek = tokenBuckets.peek(tokenKey);
    const appPeek = appKey ? appBuckets.peek(appKey) : null;

    if (!tokenPeek.allowed || (appPeek && !appPeek.allowed)) {
      const binding = pickDenied(appPeek, tokenPeek);
      setRateLimitHeaders(res, binding);
      const retryAfterSeconds = Math.ceil(binding.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(
        rateLimitedError(requestIdOf(req), 'Too many requests. Please try again later.', {
          retry_after_seconds: retryAfterSeconds,
        })
      );
      return;
    }

    const tokenConsumed = tokenBuckets.consume(tokenKey);
    const appConsumed = appKey ? appBuckets.consume(appKey) : null;
    const binding = appConsumed ? moreRestrictive(appConsumed, tokenConsumed) : tokenConsumed;
    setRateLimitHeaders(res, binding);
    next();
  };

  return { rateLimitDefaults, rateLimitBuckets, appBuckets, tokenBuckets };
}

const singleton = createRateLimitMiddleware();

/** Mount globally on `v1Router`, before `v1Routes` — see the doc comment on
 *  the function that builds it, above. */
export const rateLimitDefaults: RequestHandler = singleton.rateLimitDefaults;

/** Mount per-route, immediately after `bearerAuth` — see the doc comment on
 *  the function that builds it, above. */
export const rateLimitBuckets: RequestHandler = singleton.rateLimitBuckets;
