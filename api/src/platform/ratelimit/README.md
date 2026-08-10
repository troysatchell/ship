# `platform/ratelimit/`

Token buckets (per-app, per-token) + `X-RateLimit-*` header middleware for
`/api/v1` (PLUGFORGE.MD §2.7, §2.1; Epic E5 — PF-500). Not the legacy
`express-rate-limit` limiters in `api/src/middleware/rate-limit.ts` — those
stay mounted on `/api/` and today still match `/api/v1` by prefix too; they
will be exempted from `/api/v1` by PF-004, not replaced by this directory's
contents. Empty until PF-500 lands.
