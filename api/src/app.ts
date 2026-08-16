import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { csrfSync } from 'csrf-sync';
import rateLimit from 'express-rate-limit';
import { createApiRateLimiters, createSpaStaticLimiter, createOAuthRateLimiter } from './middleware/rate-limit.js';
import {
  createRedisClientFromEnv,
  createRedisRateLimitStore,
  REDIS_KEY_PREFIX_LOGIN,
} from './middleware/redis-rate-limit-store.js';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import issuesRoutes from './routes/issues.js';
import feedbackRoutes, { publicFeedbackRouter } from './routes/feedback.js';
import programsRoutes from './routes/programs.js';
import projectsRoutes from './routes/projects.js';
import weeksRoutes from './routes/weeks.js';
import standupsRoutes from './routes/standups.js';
import iterationsRoutes from './routes/iterations.js';
import teamRoutes from './routes/team.js';
import workspacesRoutes from './routes/workspaces.js';
import adminRoutes from './routes/admin.js';
import invitesRoutes from './routes/invites.js';
import setupRoutes from './routes/setup.js';
import backlinksRoutes from './routes/backlinks.js';
import { searchRouter } from './routes/search.js';
import { filesRouter } from './routes/files.js';
import caiaAuthRoutes from './routes/caia-auth.js';
import { createOAuthAuthorizeRouter } from './routes/oauth-authorize.js';
import { createOAuthTokenRouter } from './routes/oauth-token.js';
import { createOAuthDeviceRouter } from './routes/oauth-device.js';
import apiTokensRoutes from './routes/api-tokens.js';
import oauthAppsRoutes from './routes/oauth-apps.js';
import adminCredentialsRoutes from './routes/admin-credentials.js';
import claudeRoutes from './routes/claude.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import associationsRoutes from './routes/associations.js';
import changeFeedRoutes from './routes/change-feed.js';
import accountabilityRoutes from './routes/accountability.js';
import aiRoutes from './routes/ai.js';
import agentRoutes from './routes/agent.js';
import weeklyPlansRoutes, { weeklyRetrosRouter } from './routes/weekly-plans.js';
import { documentCommentsRouter, commentsRouter } from './routes/comments.js';
import { setupSwagger } from './swagger.js';
import { initializeCAIA } from './services/caia.js';
import { v1Router, createV1Router } from './platform/api/v1/router.js';
import { createPublicApiCors } from './platform/publicCors.js';
import type { IWebhookDeliverer } from './platform/webhooks/deliverer.js';

// Validate SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';

// CSRF protection setup
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Conditional CSRF middleware - skip for API token auth (Bearer tokens are not vulnerable to CSRF)
import { Request, Response, NextFunction } from 'express';
const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Skip CSRF for API token requests - Bearer tokens are not auto-attached by browsers
    return next();
  }
  // Apply CSRF protection for session-based auth
  return csrfSynchronisedProtection(req, res, next);
};

// Rate limiting configurations
// In test/dev environment, use much higher limits to avoid issues
// Production limits: login=5/15min (failed only); see middleware/rate-limit.ts
// for the /api/ budgets and the reasoning behind the numbers (finding API-1).
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';

// TRO-280 / API-7: one Redis client (or none, if REDIS_URL is unset) shared by
// every limiter built in this file. See middleware/redis-rate-limit-store.ts
// for the per-process-vs-shared-store problem this solves, the atomicity
// argument, and the fail-open decision applied via `passOnStoreError` below.
const rateLimitRedisClient = createRedisClientFromEnv(process.env);

// Strict rate limit for login (5 failed attempts / 15 min) - brute force protection
// skipSuccessfulRequests: true means only failed attempts count toward the limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 1000 : 5, // High limit for tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true, // Only count failed login attempts
  ...(rateLimitRedisClient
    ? {
        store: createRedisRateLimitStore(rateLimitRedisClient, REDIS_KEY_PREFIX_LOGIN),
        passOnStoreError: true,
      }
    : {}),
});

// General API rate limiting: a coarse per-source-IP flood ceiling followed by a
// per-session/per-token budget. Keyed per identity so a shared agency NAT egress
// no longer collapses an entire team into one bucket (finding API-1 / TRO-172).
//
// TRO-307: destructured into two named consts and mounted below with two
// separate calls to `app.use`, one per limiter — not a single call spreading
// an array returned from `createApiRateLimiters`. Functionally identical —
// Express creates one middleware layer per handler function either way, so
// the request-handling behavior (order, path, both limiters applied to every
// `/api/*` route) is unchanged; verified unchanged by the full pre-existing
// `rate-limit.test.ts` suite passing byte-for-byte as before. The rewrite
// exists because CodeQL's `js/missing-rate-limiting` flags 352 open alerts
// across every route file mounted under `/api/` (api/src/routes/weekly-plans.ts,
// weeks.ts, admin.ts, search.ts, and ~26 others — TRO-307), despite every one
// of those routes already being covered by this exact chain: hammering
// `GET /api/weekly-plans` (one of the flagged lines) 601 times under a forced
// `NODE_ENV=production` returns HTTP 429 at request #601, exactly matching
// `identityLimit` (rate-limit.ts:118). That is DERIVED, not CodeQL-confirmed:
// this repo has no local CodeQL CLI to test against the actual query, so this
// is a reasoned best-effort fix for a plausible static-analysis blind spot (a
// `RequestHandler[]` built by a helper in another file, previously spread into
// a variadic call here), not a verified fix for the alert itself — see
// CHANGES.md (TRO-307) and `middleware/__tests__/rate-limit-coverage.test.ts`
// for the regression coverage and its limits.
const [perSourceIpLimiter, perIdentityLimiter] = createApiRateLimiters(process.env, rateLimitRedisClient);

// TRO-308 (js/missing-rate-limiting, app.ts:440 on main): a separate
// per-source-IP-only flood ceiling for the static SPA section below (the
// `if (existsSync(webDist))` block) — see `createSpaStaticLimiter`'s doc in
// middleware/rate-limit.ts for why that section had zero rate-limit coverage
// and why this is its own limiter rather than a reuse of
// perSourceIpLimiter/perIdentityLimiter.
const spaStaticLimiter = createSpaStaticLimiter(process.env, rateLimitRedisClient);

// TRO-588: `/oauth/*` (PF-103/104/106) has never had rate-limit coverage —
// see createOAuthRateLimiter's own doc for why the legacy /api/ limiters and
// PF-500's v1 buckets both miss it. Built here alongside the other limiters
// for the same shared-Redis-client reason as spaStaticLimiter; mounted below,
// directly ahead of the three /oauth-prefixed routers it protects.
const oauthRateLimiter = createOAuthRateLimiter(process.env, rateLimitRedisClient);


/**
 * The exclusions layered on top of `compression.filter`'s own mime-db lookup
 * (finding API-3 / TRO-174). Exported as a unit-test seam: both branches are
 * safety guards, and the octet-stream one is reachable by a client-declared
 * value, so it needs assertions rather than a hand-run matrix.
 *
 * `compression.filter` itself is already case-insensitive — verified against a
 * real server: `Application/JSON` compresses and `Image/PNG` does not, matching
 * their lower-case forms. So normalisation belongs here and NOT in the library
 * path; do not add it there.
 */
export function isCompressionExcluded(
  noCompressionHeader: string | string[] | undefined,
  contentTypeHeader: number | string | string[] | undefined,
): boolean {
  if (noCompressionHeader) return true;
  // RFC 9110 §8.3.1: media types are case-insensitive, so `Text/Event-Stream` and
  // `Application/Octet-Stream` are legitimate headers a client or proxy may send.
  // Compare against a normalised value — otherwise a client that declares a
  // mixed-case type chooses whether these guards apply to it.
  //
  // Compare by equality against the media type only, not `includes` on the whole
  // header: `Content-Type` can carry parameters after a `;` (charset, boundary,
  // an arbitrary caller-supplied note, ...), and a substring match over the full
  // header value lets a decoy in the *parameters* decide the outcome — e.g.
  // `text/plain; note="application/octet-stream"` is real `text/plain` and
  // should compress, but its parameter text contains the excluded media type
  // (CodeRabbit review on PR #20, api/src/app.ts:116).
  const headerValues = Array.isArray(contentTypeHeader)
    ? contentTypeHeader
    : [contentTypeHeader];
  const mediaTypes = headerValues.map((value) => {
    // Destructure with a default rather than indexing `[0]` directly: under
    // `noUncheckedIndexedAccess`, TS types a plain index as possibly `undefined`
    // even though `split` always returns at least one element.
    const [mediaType = ''] = String(value ?? '').split(';', 1);
    return mediaType.trim().toLowerCase();
  });
  return mediaTypes.some(
    (mediaType) => mediaType === 'text/event-stream' || mediaType === 'application/octet-stream'
  );
}

/**
 * Resolves the Express `trust proxy` hop count from `TRUST_PROXY_HOPS`
 * (finding TF-7 / TRO-278). `trust proxy` is a hop COUNT, not "trust the
 * header": with N trusted hops, `req.ip` (via `proxy-addr`) resolves to the
 * (N+1)-th `X-Forwarded-For` entry counting from the end, because each
 * honest proxy appends exactly one entry.
 *
 * A single hard-coded number cannot be correct for both of this repo's
 * deployment targets, which is why it moved out of the source file:
 *
 *   - **Render (the actual live deployment, maintainer-confirmed 2026-07-30)**
 *     and local dev: `client -> Render's proxy -> Express` — ONE hop.
 *     `TRUST_PROXY_HOPS` is unset there (see `terraform/render/web_service.tf`),
 *     so this defaults to **1**, preserving today's live behaviour exactly.
 *   - **AWS** (`terraform/s3-cloudfront.tf`'s `EB-API` custom origin behind
 *     CloudFront, then the ALB): `client -> CloudFront -> ALB -> here` — TWO
 *     hops. `terraform/elastic-beanstalk.tf` sets `TRUST_PROXY_HOPS = "2"` for
 *     that environment. Trusting 2 hops there is only safe paired with
 *     `terraform/security-groups.tf` restricting the ALB security group to
 *     CloudFront's origin-facing managed prefix list (same PR): with the ALB
 *     reachable only from CloudFront, hop 0 is always the ALB and hop 1 is
 *     always a genuine CloudFront edge node, so the remaining (3rd) entry is
 *     the real client IP. If the ALB were ever reachable directly, 2 would let
 *     a client's own forged `X-Forwarded-For` entry be trusted as though it
 *     were CloudFront's.
 *
 * An unset, empty, non-numeric, non-integer, or non-positive value falls back
 * to 1 (the safe, currently-live default) rather than crashing the process or
 * trusting an attacker-influenced hop count. See the regression tests in
 * `api/src/app.test.ts`.
 */
export function resolveTrustProxyHops(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === '') return 1;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `TRUST_PROXY_HOPS="${rawValue}" is not a positive integer; falling back to 1 (the Render/local-dev default).`,
    );
    return 1;
  }
  return parsed;
}

/**
 * Optional per-call dependencies for `createApp()` (TRO-603). Today the only
 * member is `webhookDeliverer` — the app's real, running
 * `IWebhookDeliverer` singleton, so `POST /api/v1/webhooks/deliveries/:id/replay`
 * can dispatch a replay through the SAME instance whose `processDue()`
 * polling loop is already running, instead of building a throwaway instance
 * per request (see `platform/api/v1/resources/webhooks.ts`'s
 * `createWebhooksRouter()` for the full before/after). `index.ts` is the only
 * caller that passes this — every other `createApp()` call site (dev,
 * every test file in this repo) omits it and gets the pre-existing
 * throwaway-instance fallback, unchanged.
 */
export interface CreateAppOptions {
  webhookDeliverer?: IWebhookDeliverer;
}

export function createApp(
  corsOrigin: string = 'http://localhost:5173',
  options: CreateAppOptions = {}
): express.Express {
  const app = express();

  // Trust proxy headers (CloudFront/Render) for secure cookies and correct
  // protocol detection. See `resolveTrustProxyHops` above for why the hop
  // count is environment-configurable rather than a hard-coded constant.
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS));

    // CloudFront with viewer_protocol_policy="redirect-to-https" always serves viewers over HTTPS.
    // However, CloudFront -> EB uses HTTP (origin_protocol_policy="http-only"), so CloudFront
    // sets X-Forwarded-Proto to "http". Override it to "https" when request comes via CloudFront.
    app.use((req, _res, next) => {
      // CloudFront adds Via header like "2.0 <id>.cloudfront.net (CloudFront)"
      const viaHeader = req.headers['via'] as string;
      if (viaHeader && viaHeader.includes('cloudfront')) {
        req.headers['x-forwarded-proto'] = 'https';
      }
      next();
    });
  }

  // ── Response compression (finding API-3 / TRO-174) ───────────────────────
  // Registered before every route so all response bodies pass through it: API
  // JSON, the Swagger UI, and the static SPA on single-origin deployments.
  //
  // Threshold is 1 KB — the library default, set explicitly to document it.
  // Below roughly one MTU there is nothing to win: the gzip framing plus the CPU
  // makes a small body marginally larger and slower.
  //
  // Compression level is left at zlib's default (6) rather than 9. Level 9 costs
  // substantially more CPU per response for a low-single-digit percentage of
  // extra size on JSON, and this runs on every list request.
  //
  // The filter delegates to compression.filter, which consults mime-db and so
  // already declines already-compressed types — the images, PDFs and archives
  // served by /api/files/:id keep their own encoding. Three additions on top:
  //   - the conventional `x-no-compression` request opt-out, for a client that
  //     needs an identity-encoded body;
  //   - an explicit text/event-stream guard. There is no SSE endpoint in this
  //     codebase today (verified by grep for text/event-stream and flushHeaders,
  //     2026-07-29); the guard is here because compression buffers, which would
  //     silently stall the first SSE endpoint someone adds.
  //   - an application/octet-stream guard. mime-db reports octet-stream as
  //     compressible, but it is the "unknown binary" fallback, and the one route
  //     that emits it is GET /api/files/:id, which echoes a client-declared
  //     mime_type verbatim (files.ts:309) for an upload validated only against a
  //     filename blocklist. Speculatively gzipping an arbitrary — and likely
  //     already-compressed — user binary on every download costs CPU for no
  //     benefit. Types mime-db can actually identify are unaffected: docx, xlsx,
  //     zip, gzip, 7z, pdf and webp already pass through, while svg, csv, plain
  //     text and xml still compress.
  //
  // The Yjs collaboration WebSocket is unaffected — `ws` handles the upgrade off
  // the HTTP response path, so this middleware never sees it.
  //
  // MEASUREMENT WARNING: this fix shows no latency win over loopback, and can
  // look marginally worse. Localhost transfer time is ~0, so all a local
  // benchmark can measure is the added compression CPU. It is a bytes-on-the-wire
  // fix; validate it by payload size or over a bandwidth-shaped link. See
  // CHANGES.md (TRO-174).
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      if (isCompressionExcluded(req.headers['x-no-compression'], res.getHeader('Content-Type'))) {
        return false;
      }
      return compression.filter(req, res);
    },
  }));

  // Middleware - Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow images to be loaded cross-origin
    // Content Security Policy - prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Admin credentials page uses inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // TipTap editor needs inline styles
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // WebSocket connections
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      }
    },
    // HTTP Strict Transport Security
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Body parsing (PF-200 / TRO-398 fix). MUST run before `/api/v1` mounts
  // below — Express dispatches app-level `app.use()` calls in registration
  // order, and a route handler that matches and responds never falls
  // through to a LATER middleware, so a body-parser registered after a
  // router's mount never runs for any request that router actually
  // handles. These two calls used to sit after the `/api/v1`/`/oauth`
  // mounts (and after the app-global CORS skip below), which meant no
  // `/api/v1` route has ever had a parsed `req.body` — invisible until now
  // because the only route that existed before this ticket was `GET
  // /api/v1/health`, which has no body to parse. PF-200's `POST
  // /api/v1/documents` is the first `/api/v1` route that reads `req.body`,
  // and it surfaced the gap directly: every field arrived as `undefined`,
  // so Zod's required `title` failed validation on a fully valid request
  // body. Moved here, before every router mount (including the pre-existing
  // internal `/api/*` ones further down this file) — internal routes are
  // unaffected because they only require `req.body` to be populated by the
  // time THEIR handler runs, not that parsing happen at any particular
  // point before it; nothing between the old position and this one reads
  // `req.body` (`perSourceIpLimiter`/`perIdentityLimiter` key on IP/session/
  // token, not body).
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions

  // Apply rate limiting to all API routes. Two explicit calls, not a spread of
  // the array `createApiRateLimiters` returns — see the TRO-307 comment above
  // `perSourceIpLimiter`/`perIdentityLimiter` for why. Order is unchanged: the
  // IP flood ceiling still runs before the per-identity budget.
  app.use('/api/', perSourceIpLimiter);
  app.use('/api/', perIdentityLimiter);

  // ── Platform layer: public API (PF-001, PLUGFORGE.MD §2.1/§4) ────────────
  // `/api/v1/*` and, once added, `/oauth`'s token/device endpoints share a
  // separate, credential-less CORS policy — NOT the app-global single-origin
  // `credentials: true` policy below, which cannot serve a cross-origin
  // bearer-token client (§2.1). Mounted here, before that global `cors()`
  // call, so this scoped policy's headers apply to `/api/v1` requests.
  //
  // This does NOT make the app-global `cors()` below a no-op for those paths.
  // `v1Router` only defines `GET /health` today (no 404 fallthrough — that's
  // PF-002), and `/oauth` now has two routers mounted below: PF-103/TRO-412's
  // (`GET /authorize`, `POST /authorize/decision`) and PF-104/TRO-416's
  // (`POST /token`) — an unmatched `/api/v1/*` path, or an `/oauth/*` path
  // neither router handles, still falls straight through with the response
  // open, and would
  // reach the app-global `cors()` next. `cors()` middleware runs — and sets
  // its headers — on every request that reaches it, matched route or not, so
  // it would overwrite `Access-Control-Allow-Origin` with the single-origin
  // value and add `Access-Control-Allow-Credentials: true` onto a response
  // already carrying the public, credential-less policy (CodeRabbit #1, PR
  // #170). Fixed by skipping the app-global `cors()` entirely for these
  // paths, rather than relying on the public router terminating every
  // request first — see the path-prefix check on `appGlobalCors` below.
  //
  // The legacy per-source-IP/per-identity limiters just above still MOUNT on
  // `/api/v1` by prefix (`/api/` matches `/api/v1/...`), but as of PF-004 /
  // TRO-401 both `skip` it: `isLegacyLimiterExemptPath` in `rate-limit.ts`
  // checks the mount-relative `/v1` shape those limiters actually see
  // (verified empirically — inside `app.use('/api/', <limiter>)`, `req.path`
  // for `/api/v1/health` is `/v1/health`, not the full `/api/v1/health`).
  // PF-500's per-app/per-token buckets are meant to govern `/api/v1` instead
  // (PLUGFORGE.MD §2.7); until that lands, the public router is unmetered by
  // this file. Every other `/api/*` route remains capped exactly as before.
  //
  // `/oauth`'s router was added by PF-103/TRO-412 (mounted below); listing
  // this prefix here meant that ticket only had to mount its router, not
  // also touch this CORS wiring. PF-104/TRO-416's token router (also mounted
  // below) gets the same benefit for free, for the identical reason.
  app.use(['/api/v1', '/oauth'], createPublicApiCors());
  // TRO-603: use the module-level default `v1Router` singleton unless this
  // call was given a real webhook deliverer to inject — in which case a
  // fresh `v1Router` is built via `createV1Router()` so its `/webhooks`
  // sub-router closes over that specific instance (see `router.ts`'s and
  // `resources/webhooks.ts`'s own doc comments for why this can't just be a
  // property set on the shared singleton). Every existing `createApp()` call
  // site — every test file in this repo, plus local `pnpm dev` — passes no
  // options and is unaffected: same singleton, same behavior as before.
  const mountedV1Router = options.webhookDeliverer
    ? createV1Router(options.webhookDeliverer).v1Router
    : v1Router;
  app.use('/api/v1', mountedV1Router);

  // Skip the app-global session CORS for the public-surface path prefixes —
  // they already received (or will receive) the public policy above, and
  // must never also pick up this single-origin/`credentials: true` policy
  // (CodeRabbit #1, PR #170; see the comment block above).
  const appGlobalCors = cors({
    origin: corsOrigin,
    credentials: true,
  });
  // Path-segment-boundary match, not a bare `startsWith` — a raw substring
  // check would also match `/api/v10`, `/api/v1foo`, or `/oauth2`, none of
  // which are the public surface (CodeRabbit, PR #170 gate run). Mirrors how
  // Express's own `app.use('/api/v1', ...)` mount above already matches:
  // exactly the prefix, or the prefix followed by `/`.
  const isPublicSurfacePath = (path: string): boolean =>
    ['/api/v1', '/oauth'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  app.use((req, res, next) => {
    if (isPublicSurfacePath(req.path)) {
      return next();
    }
    return appGlobalCors(req, res, next);
  });
  // Body parsing moved above (before the `/api/v1`/`/oauth` mounts) — see
  // the comment there. Left here would mean it never runs for a matched
  // `/api/v1` route handler.
  app.use(cookieParser(sessionSecret));

  // Session middleware for CSRF token storage
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  }));

  // CSRF token endpoint (must be before CSRF protection middleware)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ token: generateToken(req) });
  });

  // Health check (no CSRF needed)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // API documentation (no auth needed)
  setupSwagger(app);

  // Setup routes (CSRF protected - first-time setup only)
  app.use('/api/setup', conditionalCsrf, setupRoutes);

  // Public feedback routes - no auth or CSRF required (must be before protected routes)
  app.use('/api/feedback', publicFeedbackRouter);

  // Apply stricter rate limiting to login endpoint (brute force protection)
  app.use('/api/auth/login', loginLimiter);

  // Apply CSRF protection to all state-changing API routes
  app.use('/api/auth', conditionalCsrf, authRoutes);
  app.use('/api/documents', conditionalCsrf, documentsRoutes);
  app.use('/api/documents', conditionalCsrf, backlinksRoutes);
  app.use('/api/documents', conditionalCsrf, associationsRoutes);
  app.use('/api/issues', conditionalCsrf, issuesRoutes);
  app.use('/api/feedback', conditionalCsrf, feedbackRoutes);
  app.use('/api/programs', conditionalCsrf, programsRoutes);
  app.use('/api/projects', conditionalCsrf, projectsRoutes);
  app.use('/api/weeks', conditionalCsrf, weeksRoutes);
  app.use('/api/weeks', conditionalCsrf, iterationsRoutes);
  app.use('/api/standups', conditionalCsrf, standupsRoutes);
  app.use('/api/team', conditionalCsrf, teamRoutes);
  app.use('/api/workspaces', conditionalCsrf, workspacesRoutes);
  app.use('/api/admin', conditionalCsrf, adminRoutes);
  app.use('/api/invites', conditionalCsrf, invitesRoutes);
  app.use('/api/api-tokens', conditionalCsrf, apiTokensRoutes);
  app.use('/api/oauth-apps', conditionalCsrf, oauthAppsRoutes);

  // Claude context routes - read-only GET endpoints for Claude skills
  app.use('/api/claude', claudeRoutes);

  // Search routes are read-only GET endpoints - no CSRF needed
  app.use('/api/search', searchRouter);

  // Activity routes are read-only GET endpoints - no CSRF needed
  app.use('/api/activity', activityRoutes);

  // Dashboard routes are read-only GET endpoints - no CSRF needed
  app.use('/api/dashboard', dashboardRoutes);

  // Change feed - read-only GET endpoint, no CSRF needed (FG-1 / TRO-312)
  app.use('/api/change-feed', changeFeedRoutes);

  // Accountability routes - inference-based action items (read-only GET)
  app.use('/api/accountability', accountabilityRoutes);

  // AI analysis routes - plan and retro quality feedback (CSRF protected)
  app.use('/api/ai', conditionalCsrf, aiRoutes);

  // Agent chat proxy - forwards to the FleetGraph agent service (CSRF protected, TRO-320 / FG-9)
  app.use('/api/agent', conditionalCsrf, agentRoutes);

  // Weekly plans routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-plans', conditionalCsrf, weeklyPlansRoutes);

  // Weekly retros routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-retros', conditionalCsrf, weeklyRetrosRouter);

  // CAIA auth routes - no CSRF protection (OAuth flow with external callback)
  // This is the single identity provider for PIV authentication
  // Mount at both /caia and /piv paths - /piv/callback is registered with CAIA
  app.use('/api/auth/caia', caiaAuthRoutes);
  app.use('/api/auth/piv', caiaAuthRoutes);

  // TRO-588: per-source-IP flood ceiling for the whole /oauth prefix, ahead
  // of every /oauth-mounted router below — same "cheap, runs first" ordering
  // as perSourceIpLimiter/perIdentityLimiter above. See
  // createOAuthRateLimiter's doc (middleware/rate-limit.ts) for why this is
  // a separate limiter from both of those rather than a reuse.
  app.use('/oauth', oauthRateLimiter);

  // OAuth authorization endpoint + consent decision (PF-103, TRO-412) — no
  // CSRF protection, same OAuth-flow rationale as CAIA above (see the
  // module-level comment in oauth-authorize.ts for the full reasoning: a
  // native browser navigation/form POST, not `fetch()`, so this needs no
  // change to /oauth's already-mounted public CORS policy, above). Mounted
  // at the top-level `/oauth` prefix PF-001 already carved out and CORS'd
  // for this ticket (see the comment on `app.use(['/api/v1','/oauth'],
  // createPublicApiCors())` above) — not under `/api`, since this is the RFC
  // 6749 authorization endpoint, not a JSON API resource.
  app.use('/oauth', createOAuthAuthorizeRouter(corsOrigin));

  // OAuth token endpoint (PF-104, TRO-416) — a second `/oauth`-mounted
  // router, not folded into the one above: this endpoint needs no
  // `webOrigin` (JSON responses only, never a redirect) and is a distinct
  // ticket's own module (`routes/oauth-token.ts` -> `platform/oauth/token.ts`).
  // Falls through cleanly if unmatched — Express only calls `next()` past an
  // unmatched router, same as every other `/oauth`-prefixed mount here.
  // Already covered by the public, credential-less CORS policy mounted
  // above (`app.use(['/api/v1', '/oauth'], createPublicApiCors())`) — no
  // additional CORS wiring needed for this route.
  app.use('/oauth', createOAuthTokenRouter());

  // OAuth Device Authorization Grant (PF-106, TRO-425, RFC 8628) — a third
  // `/oauth`-mounted router: `POST /device/code` (public, needs no
  // `webOrigin`... except it DOES, to build `verification_uri`/
  // `verification_uri_complete` — same `webOrigin` PF-103's router already
  // takes) and `POST /device/verify` (the verification page's session-authed
  // Approve/Deny form target, same `webOrigin`-for-redirects need as
  // `/oauth/authorize/decision`). Already covered by the public,
  // credential-less CORS policy mounted above (`app.use(['/api/v1',
  // '/oauth'], createPublicApiCors())`) — no additional CORS wiring needed.
  app.use('/oauth', createOAuthDeviceRouter(corsOrigin));

  // Admin credentials management (CSRF protected, super-admin only)
  app.use('/api/admin/credentials', conditionalCsrf, adminCredentialsRoutes);

  // File upload routes (CSRF protected for POST endpoints)
  app.use('/api/files', conditionalCsrf, filesRouter);

  // Comments routes
  app.use('/api/documents', conditionalCsrf, documentCommentsRouter);
  app.use('/api/comments', conditionalCsrf, commentsRouter);

  // Initialize CAIA OAuth client at startup
  initializeCAIA().catch((err) => {
    console.warn('CAIA initialization failed:', err);
  });

  // ── Static SPA (single-origin deployments) ───────────────────────────────
  // Serves web/dist when it is present in the image. Absent in local dev and in
  // the AWS deployment, where CloudFront serves the SPA and proxies /api/* — so
  // this is a no-op there and only activates for single-service hosts.
  //
  // Must be registered after every /api route so it cannot shadow them.
  //
  // The extension test mirrors terraform/cloudfront-functions/spa-routing.js:
  // a path with a file extension resolves to a real asset (or 404s), anything
  // else falls through to index.html so react-router can handle it. Same-origin
  // is a requirement, not a preference — the session cookie is sameSite=strict
  // and the collaboration WebSocket URL is built from window.location.host.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    // TRO-308: this whole section sits outside the `/api/` prefix the
    // limiter chain above matches, so it had no rate-limit coverage at all
    // (CodeQL js/missing-rate-limiting, app.ts:440 on main — the app.get('*',
    // ...) line below). Mounted unconditionally (no path prefix) so it also
    // covers express.static's own file-serving, not just the catch-all.
    app.use(spaStaticLimiter);
    app.use(express.static(webDist, { index: false }));

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/collaboration')) return next();
      if (/\.[a-zA-Z0-9]+$/.test(req.path)) return next();
      res.sendFile(join(webDist, 'index.html'));
    });

    console.log(`Serving SPA from ${webDist}`);
  }

  return app;
}
