/**
 * Platform-wide configuration for `api/src/platform/`.
 *
 * Currently holds only the public-CORS origin resolution (PF-001). Later
 * platform tickets (OAuth TTLs, rate-limit budgets, `SECRET_ENCRYPTION_KEY`)
 * belong here too rather than scattered `process.env` reads — see
 * `PLUGFORGE.MD` §2.10 for the full env-var inventory this module will grow
 * into.
 */

/**
 * `PUBLIC_API_CORS_ORIGIN` — the origin(s) allowed to make credential-less
 * cross-origin requests to the public API surface (`/api/v1/*`) and the
 * OAuth token/device endpoints (`/oauth/token`, `/oauth/device/*`, added by a
 * later ticket). Documented in `api/src/platform/README.md`.
 *
 * Unlike the app-global `cors()` in `api/src/app.ts` (single-origin,
 * `credentials: true`, backs the session-cookie-authenticated SPA), the
 * public API is bearer-token authenticated and has no cookies to protect —
 * so a different, permissive, `credentials: false` origin policy is both
 * safe and necessary (§2.1, PLUGFORGE.MD).
 */
export const PUBLIC_API_CORS_ORIGIN_ENV = 'PUBLIC_API_CORS_ORIGIN';

/**
 * Parses `PUBLIC_API_CORS_ORIGIN` into a value the `cors` package accepts
 * directly as its `origin` option.
 *
 * - unset / empty string / literal `"*"` -> `'*'` (any origin). This is the
 *   default: local dev, CI, and the TTFE drill's throwaway containers have no
 *   fixed origin to allow ahead of time.
 * - a comma-separated list -> a trimmed, non-empty `string[]` allowlist. The
 *   `cors` package reflects the matching request `Origin` for an array value
 *   and omits the header entirely for a non-matching one.
 */
export function resolvePublicApiCorsOrigin(rawValue: string | undefined): string[] | '*' {
  const trimmed = (rawValue ?? '').trim();
  if (trimmed === '' || trimmed === '*') return '*';
  const origins = trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : '*';
}
