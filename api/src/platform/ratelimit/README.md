# `platform/ratelimit/`

Token buckets (per-app, per-token) + `X-RateLimit-*` header middleware for
`/api/v1` (PLUGFORGE.MD §2.7, §2.1; Epic E5 — PF-500, Linear TRO-427). Not the
legacy `express-rate-limit` limiters in `api/src/middleware/rate-limit.ts` —
those stay mounted on `/api/` and, as of PF-004/TRO-401, exempt `/api/v1`
(`isLegacyLimiterExemptPath`) precisely so this directory's contents can
govern it instead.

- `tokenBucket.ts` — the pure `TokenBucket` primitive: continuous linear
  refill, injected `Clock` (real clock in production, fake clock in tests —
  no `setTimeout` waits for exhaustion/refill proof).
- `config.ts` — `resolveRateLimits(env)`. Reads `RATE_LIMIT_APP_RPM` /
  `RATE_LIMIT_TOKEN_RPM` (names ratified by `terraform/render/variables.tf`,
  defaults 120/60 per PLUGFORGE.MD §2.7).
- `middleware.ts` — two Express middlewares:
  - `rateLimitDefaults` — mounted globally on `v1Router`, before routing.
    Guarantees `X-RateLimit-*` on the responses `rateLimitBuckets` below
    never reaches (an unauthenticated 401, a 404, or a genuinely public
    route like `GET /health`).
  - `rateLimitBuckets` — mounted per-route, immediately after each route's
    own `bearerAuth`. Reads `req.principal`, checks/consumes the per-app
    (`principal.app.clientId`, skipped when `principal.app` is null) and
    per-token (hash of the raw bearer credential) buckets, and either
    forwards a `rate_limited` `ApiError` (429 + `Retry-After`) or lets the
    request through with real headers set.

See `middleware.ts`'s own doc comments for the full reasoning on mount order
and why two separate middlewares (not one) are needed for "headers on 100% of
`/api/v1` responses" to actually hold.
