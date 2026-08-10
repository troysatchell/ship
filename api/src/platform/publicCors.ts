import cors from 'cors';
import type { RequestHandler } from 'express';
import { resolvePublicApiCorsOrigin, PUBLIC_API_CORS_ORIGIN_ENV } from './config.js';

/**
 * Permissive, credential-less CORS policy for the public API surface
 * (`/api/v1/*`) and, once added, the OAuth token/device endpoints. Separate
 * from the app-global `cors()` in `api/src/app.ts`, which is single-origin
 * with `credentials: true` and backs the cookie-authenticated SPA — a policy
 * that cannot serve a cross-origin bearer-token client (§2.1, PLUGFORGE.MD).
 *
 * `credentials: false` is deliberate, not an oversight: the public API never
 * reads cookies, so there is nothing here for `Access-Control-Allow-
 * Credentials` to protect, and turning it on would misstate what this layer
 * authenticates with.
 *
 * Reads `PUBLIC_API_CORS_ORIGIN` at call time (not module load) so tests can
 * set the env var per-case without reloading the module.
 */
export function createPublicApiCors(): RequestHandler {
  return cors({
    origin: resolvePublicApiCorsOrigin(process.env[PUBLIC_API_CORS_ORIGIN_ENV]),
    credentials: false,
  });
}
