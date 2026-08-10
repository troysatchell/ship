import cors from 'cors';
import type { RequestHandler } from 'express';
import { resolvePublicApiCorsOrigin, PUBLIC_API_CORS_ORIGIN_ENV } from './config.js';
import { REQUEST_ID_HEADER } from './api/v1/requestId.js';

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
    // Without this, `X-Request-Id` is set on the response but invisible to
    // cross-origin JS: the CORS spec hides all response headers from
    // `fetch`/`XHR` except the small always-allowed set unless the server
    // lists them in `Access-Control-Expose-Headers` (finding #4, PR #170
    // review). A same-origin caller (curl, server-to-server) was never
    // affected — this only unblocks the browser case.
    exposedHeaders: [REQUEST_ID_HEADER],
  });
}
