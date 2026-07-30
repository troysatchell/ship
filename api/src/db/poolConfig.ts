/**
 * Pool sizing and connection-timeout policy for the application's `pg.Pool`
 * (TRO-248 / RULE-7).
 *
 * FAILURE MODE THIS PROTECTS AGAINST: `connectionTimeoutMillis` bounds how
 * long a single connection attempt waits before `pg` gives up and rejects.
 * `ssl.ts`'s file header already documents what a *fixed* 2000ms value does
 * against a managed Postgres with a slow cold start (a paused serverless
 * instance, a cross-region hop, a VPC endpoint warming up): every connection
 * attempt in that window fails, `pool.query` rejects immediately, and under
 * restart-on-crash (ECS/EB/systemd) the process crash-loops before the
 * database is ever actually reachable — rather than waiting the extra few
 * seconds it needed. The fix here is not a different fixed number (any fixed
 * number can still be wrong for some provider) but making the number
 * operator-tunable without a code change, with today's values kept as the
 * defaults so behaviour is unchanged until someone opts in.
 *
 * `max` (pool size) has the same "one hardcoded guess" shape for a different
 * reason: the right pool size depends on the deployment's DB connection
 * limit and instance count, which this code cannot know statically.
 *
 * `statement_timeout` is deliberately NOT made configurable here — it is a
 * DDoS/runaway-query protection value (like `index.ts`'s server timeouts),
 * not a "waiting on a dependency that might be slow to answer" value, so the
 * same tunability argument doesn't apply to it.
 */

export interface PoolTimingConfig {
  /** Milliseconds to wait for a new connection before giving up. */
  connectionTimeoutMillis: number;
  /** Maximum number of pooled connections. */
  max: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 2000;
const DEFAULT_POOL_MAX_PRODUCTION = 20;
const DEFAULT_POOL_MAX_DEV = 10;

/**
 * Parses a positive integer from an env var, falling back to `fallback` for
 * anything that isn't one — unset, empty, non-numeric, zero, or negative.
 *
 * Validated rather than a bare `Number(...)`: a malformed override (unset,
 * empty, non-numeric, zero, negative, or fractional — `DB_POOL_MAX="1.5"` is
 * not a valid connection count any more than `"abc"` is) would otherwise
 * produce `NaN` or a value neither `pg.Pool` nor a millisecond timeout is
 * specified against — falling back keeps the value a sane, exact integer
 * either way.
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface PoolTimingEnv {
  DB_POOL_CONNECTION_TIMEOUT_MS?: string;
  DB_POOL_MAX?: string;
  DB_POOL_MAX_DEV?: string;
  NODE_ENV?: string;
  // Index signature so `process.env` (whose declared type carries no named
  // keys of its own beyond a few Node built-ins) is structurally assignable
  // here without TS2559 ("no properties in common") — it genuinely does
  // hold arbitrary string keys at runtime.
  [key: string]: string | undefined;
}

/** Resolves pool timing/sizing from the environment, defaults unchanged from before this ticket. */
export function resolvePoolTiming(env: PoolTimingEnv): PoolTimingConfig {
  const isProduction = env.NODE_ENV === 'production';
  const maxOverride = isProduction ? env.DB_POOL_MAX : env.DB_POOL_MAX_DEV;
  const maxDefault = isProduction ? DEFAULT_POOL_MAX_PRODUCTION : DEFAULT_POOL_MAX_DEV;

  return {
    connectionTimeoutMillis: parsePositiveInt(
      env.DB_POOL_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS
    ),
    max: parsePositiveInt(maxOverride, maxDefault),
  };
}
