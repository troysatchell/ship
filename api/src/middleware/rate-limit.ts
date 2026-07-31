/**
 * Rate limiting for `/api/*` — audit finding API-1 (TRO-172).
 *
 * The previous configuration was a single limiter: 100 requests per 60 s keyed
 * on the client IP. Two things made that bind on legitimate traffic:
 *
 *  1. **The unit was wrong.** The ceiling was sized as if one page view were one
 *     request. The audit's browser trace measured 63 `/api` requests across 8
 *     flows (login 16, dashboard 12, document view 10, sprint board 10), so a
 *     single user exhausted the window after ~6-10 navigations per minute.
 *  2. **The key was wrong.** In the deployed topology (CloudFront -> Elastic
 *     Beanstalk with `trust proxy 1`) every user behind one agency NAT egress
 *     resolves to the same IP, so a whole team shared one 100 req/min budget.
 *
 * The replacement is two chained limiters:
 *
 *  - `perSourceIpLimiter` — a coarse anti-flood ceiling per source IP. It has to
 *    survive a shared NAT egress, so it is sized well above realistic office
 *    traffic and well below what one Node process can serve; it exists so that
 *    the per-identity limiter below cannot be defeated by forging cookies.
 *  - `perIdentityLimiter` — the ceiling users actually feel, keyed on the
 *    session (or API token) that issued the request, falling back to the IP for
 *    unauthenticated traffic. This is what stops one user from consuming a
 *    colleague's budget.
 *
 * Order matters: the IP limiter runs first (cheap, no hashing) and the identity
 * limiter runs second so that the client-facing `RateLimit-*` headers describe
 * the per-identity budget rather than the flood ceiling.
 *
 * STORAGE (TRO-280 / API-7): both limiters above still use
 * `express-rate-limit`'s default `MemoryStore` unless `REDIS_URL` is
 * configured, and `MemoryStore` lives in one process's heap. Elastic
 * Beanstalk runs 1-4 instances of this API behind a load balancer with no
 * session affinity (`terraform/elastic-beanstalk.tf`), so every number in
 * this file was, until this ticket, actually "configured limit x however
 * many instances happen to be running" — a ceiling that moves under
 * autoscaling load, silently, in the direction that defeats the limiter
 * (more instances -> more real ceiling -> exactly when traffic is high
 * enough to need the limit). `createApiRateLimiters` now backs both limiters
 * with a Redis-shared store when `REDIS_URL` is set — see
 * `redis-rate-limit-store.ts` for the store, the atomicity argument, and the
 * documented fail-open behavior if Redis is configured but unreachable.
 */
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import {
  createRedisClientFromEnv,
  createRedisRateLimitStore,
  REDIS_KEY_PREFIX_IDENTITY,
  REDIS_KEY_PREFIX_SOURCE_IP,
} from './redis-rate-limit-store.js';

/** All `/api/` limits are evaluated over a rolling one-minute window. */
export const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Worst realistic single-user burst, from the audit's measurements: the
 * heaviest flow (login) costs 16 `/api` requests, and a user navigating every
 * 3 s performs 20 navigations per minute — 16 x 20 = 320 req/min.
 *
 * The production per-identity ceiling below is set to 600, ~1.9x that burst,
 * which still caps any single session at 10 req/s.
 */
export const MEASURED_WORST_CASE_BURST_PER_MINUTE = 320;

export interface RateLimitEnv {
  NODE_ENV?: string;
  E2E_TEST?: string;
  /**
   * Connection string for a Redis/Valkey instance (TRO-280 / API-7). When
   * set, `createApiRateLimiters` backs both limiters with a shared
   * `RedisStore` so the configured ceiling holds across every process
   * sharing that Redis instance, not per-process. Unset (the default in
   * local dev and this suite) keeps the previous per-process `MemoryStore`.
   */
  REDIS_URL?: string;
  // Index signature so `process.env` (NodeJS.ProcessEnv) is directly assignable
  // — without it TypeScript rejects it as a weak-type mismatch.
  [key: string]: string | undefined;
}

export interface ResolvedApiRateLimits {
  windowMs: number;
  /** Requests per window per session / API token / anonymous IP. */
  identityLimit: number;
  /** Requests per window per source IP, regardless of identity. */
  sourceIpLimit: number;
}

/**
 * Resolve the limits for an environment.
 *
 * Test and dev keep the permissive numbers they already had — they were never
 * the problem, and lowering them would break the e2e suite. Only production
 * moves: 100 -> 600 per identity, plus a 6,000/min per-IP flood ceiling.
 *
 * Justification for 600 (per identity, per minute):
 *   - 320 req/min is the worst measured burst for one user (see above).
 *   - 600 leaves ~1.9x headroom for react-query background refetches and the
 *     command palette, and still bounds one session to 10 req/s.
 *
 * Justification for 6,000 (per source IP, per minute = 100 req/s):
 *   - An agency NAT is a single IP. At the measured average of ~8 requests per
 *     flow and a realistic 4 navigations/min, that is ~32 req/min per active
 *     user, so 6,000 accommodates roughly 187 simultaneously-active users
 *     behind one egress (or ~37 sustaining the 320 req/min worst case).
 *   - It is still a real limit: the audit measured this API at 299-4,049 req/s,
 *     so a single-source flood is capped well below saturation.
 */
export function resolveApiRateLimits(env: RateLimitEnv = process.env): ResolvedApiRateLimits {
  const isTestEnv = env.NODE_ENV === 'test' || env.E2E_TEST === '1';
  const isDevEnv = env.NODE_ENV !== 'production';

  return {
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    identityLimit: isTestEnv ? 10000 : isDevEnv ? 1000 : 600,
    sourceIpLimit: isTestEnv ? 100000 : isDevEnv ? 10000 : 6000,
  };
}

/**
 * Session ids are 64 lowercase hex characters
 * (`crypto.randomBytes(32).toString('hex')` — see `api/src/routes/auth.ts`).
 *
 * Anything else is treated as absent and falls through to IP keying, so a
 * malformed or hand-crafted cookie cannot mint an arbitrary bucket shape.
 */
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Read `session_id` from a raw Cookie header.
 *
 * The limiter is mounted before `cookie-parser` (deliberately — throttled
 * requests should not pay for body/cookie parsing), so `req.cookies` is not
 * populated yet and the header is parsed here.
 */
export function readSessionIdCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;

  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== 'session_id') continue;

    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding — fall through to the shape check below.
    }
    return SESSION_ID_PATTERN.test(value) ? value : null;
  }

  return null;
}

/** Read the bearer token from an Authorization header, if present. */
export function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Hash the credential before using it as a bucket key. The rate-limit store is
 * long-lived, in-memory and surfaces in diagnostics; it should never hold a
 * live session id or API token verbatim.
 *
 * TRO-302 (API-8) profiled this specifically as the suspected cause of a
 * +12-18% P95 regression on cheap endpoints (`audit/api-perf/compare-phase2-jul30`).
 * Measured, not assumed to be cheap: a microbenchmark put the full cost of
 * `apiRateLimitKey()` (cookie parse + this hash) at ~650 ns/op — about 0.008%
 * of a 4 ms request — and a live `--cpu-prof` capture under the same c=25
 * autocannon load attributed ~0.15% of *active* (non-idle) CPU time to
 * anything hash/rate-limit-related, with the server otherwise >99% idle
 * (I/O-bound). A controlled live A/B (real hash vs. a no-op replacement vs.
 * the entire limiter chain removed, same server, same load, back-to-back)
 * showed no consistent directional difference — smaller than the rep-to-rep
 * noise of unmodified code alone. See `__tests__/rate-limit.test.ts`
 * ("TRO-302: fingerprint cost stays negligible") for the pinned cost/sync
 * guards, and CHANGES.md for the full writeup. This function was not changed:
 * the measurement acquitted it, so it stayed as-is rather than being
 * "fixed" to satisfy a hypothesis the numbers didn't support.
 */
function fingerprint(prefix: string, credential: string): string {
  const digest = crypto.createHash('sha256').update(credential).digest('base64url');
  return `${prefix}:${digest.slice(0, 22)}`;
}

/**
 * The exact shape `apiRateLimitKey` reads — nothing more. Express's `Request`
 * satisfies this structurally, so every production call site (the
 * `keyGenerator` below) needs no change, but a test can build a plain literal
 * that satisfies it directly, with no `as unknown as Request` cast (TS-8: a
 * cast like that decouples the test from the shape it claims to verify).
 */
export interface RateLimitKeyRequest {
  headers?: { cookie?: string; authorization?: string };
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Bucket key for the per-identity limiter.
 *
 * Session cookie -> API token -> source IP. Note that the session id is not
 * verified here (that costs a database round trip and the limiter runs before
 * auth), so a client that rotates forged cookies gets fresh buckets — which is
 * precisely what `perSourceIpLimiter` is for.
 */
export function apiRateLimitKey(req: RateLimitKeyRequest): string {
  const sessionId = readSessionIdCookie(req.headers?.cookie);
  if (sessionId) return fingerprint('s', sessionId);

  const token = readBearerToken(req.headers?.authorization);
  if (token) return fingerprint('t', token);

  return `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? '')}`;
}

/**
 * Build the `/api/` limiter chain. Mount with
 * `app.use('/api/', ...createApiRateLimiters())`.
 *
 * `redisClient` defaults to one built from `env.REDIS_URL` (production, once
 * `terraform/redis.tf` is applied and its endpoint is plumbed through SSM —
 * see `config/ssm.ts`'s `loadProductionSecrets`). Passing it explicitly is a
 * test seam: `__tests__/redis-rate-limit-store.test.ts` constructs two
 * independent clients pointed at the same Redis to prove counts are shared
 * across them, which two calls into the same in-process `MemoryStore` could
 * never prove.
 *
 * When neither is set, both limiters fall back to `express-rate-limit`'s
 * default `MemoryStore` — unchanged from before this ticket, and still what
 * local dev and every other test in this suite runs against.
 */
export function createApiRateLimiters(
  env: RateLimitEnv = process.env,
  redisClient: Redis | undefined = createRedisClientFromEnv(env)
): RequestHandler[] {
  const { windowMs, identityLimit, sourceIpLimit } = resolveApiRateLimits(env);

  const perSourceIpLimiter = rateLimit({
    windowMs,
    limit: sourceIpLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this network. Please slow down.' },
    ...(redisClient
      ? {
          store: createRedisRateLimitStore(redisClient, REDIS_KEY_PREFIX_SOURCE_IP),
          // Fail OPEN on a Redis-store error — see redis-rate-limit-store.ts's
          // top-of-file doc for the full reasoning (rule 7).
          passOnStoreError: true,
        }
      : {}),
  });

  const perIdentityLimiter = rateLimit({
    windowMs,
    limit: identityLimit,
    keyGenerator: apiRateLimitKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
    ...(redisClient
      ? {
          store: createRedisRateLimitStore(redisClient, REDIS_KEY_PREFIX_IDENTITY),
          passOnStoreError: true,
        }
      : {}),
  });

  return [perSourceIpLimiter, perIdentityLimiter];
}
