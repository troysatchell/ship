/**
 * Env resolution for PF-500's `/api/v1` token buckets (PLUGFORGE.MD §2.7,
 * Linear TRO-427).
 *
 * `RATE_LIMIT_APP_RPM` / `RATE_LIMIT_TOKEN_RPM` are not new names invented by
 * this ticket — they are already ratified in `terraform/render/variables.tf`
 * (`rate_limit_app_rpm` / `rate_limit_token_rpm`, both `default = 120` /
 * `default = 60` there, "read by PF-500 once built") and wired through to the
 * Render env (`terraform/render/web_service.tf`'s `RATE_LIMIT_APP_RPM` /
 * `RATE_LIMIT_TOKEN_RPM` block). This file reads what Terraform already
 * decided to call them; it does not decide the names itself.
 *
 * Every Render-deployed environment therefore sets both vars explicitly. Only
 * an environment with neither var set — local dev, `pnpm test`, CI — falls
 * through to the literal PLUGFORGE.MD §2.7 defaults below. That fallback is
 * deliberately NOT tiered by `NODE_ENV` the way the legacy `/api/`
 * limiters are (`api/src/middleware/rate-limit.ts`'s `resolveApiRateLimits`):
 * this repo's `/api/v1` test suite was checked before choosing this — the
 * heaviest reuse of one bearer token in one test file is
 * `webhooks.test.ts`'s `manageToken` at 24 requests, and every bucket here
 * STARTS at full capacity, so a flat 60/min (or 120/min) default absorbs
 * that with no dependency on how fast the test machine is. If a future test
 * file needs more than ~60 sequential requests on one reused credential, add
 * more fixture tokens/apps there rather than reaching for a hidden
 * NODE_ENV-tiered default here — the whole point of this file is that
 * "the limit" means the same thing in every environment unless the env var
 * itself says otherwise.
 */

export interface RateLimitEnv {
  RATE_LIMIT_APP_RPM?: string;
  RATE_LIMIT_TOKEN_RPM?: string;
  // Index signature so `process.env` (NodeJS.ProcessEnv) is directly
  // assignable — without it TypeScript rejects it as a weak-type mismatch
  // (same reason `api/src/middleware/rate-limit.ts`'s `RateLimitEnv` has one).
  [key: string]: string | undefined;
}

/** PLUGFORGE.MD §2.7, verbatim: "Per-app... (default 120 req/min) and per
 *  token (default 60 req/min)". */
export const DEFAULT_APP_RPM = 120;
export const DEFAULT_TOKEN_RPM = 60;

/** Both env vars are named "...RPM" — requests per MINUTE — so every bucket
 *  in this module refills over a rolling one-minute window. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

function parsePositiveInt(raw: string | undefined, varName: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${varName} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export interface ResolvedRateLimits {
  windowMs: number;
  /** Requests per window per app (`principal.app.clientId`). */
  appRpm: number;
  /** Requests per window per bearer credential. */
  tokenRpm: number;
}

export function resolveRateLimits(env: RateLimitEnv = process.env): ResolvedRateLimits {
  return {
    windowMs: RATE_LIMIT_WINDOW_MS,
    appRpm: parsePositiveInt(env.RATE_LIMIT_APP_RPM, 'RATE_LIMIT_APP_RPM') ?? DEFAULT_APP_RPM,
    tokenRpm: parsePositiveInt(env.RATE_LIMIT_TOKEN_RPM, 'RATE_LIMIT_TOKEN_RPM') ?? DEFAULT_TOKEN_RPM,
  };
}
