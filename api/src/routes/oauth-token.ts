/**
 * `POST /oauth/token` — PF-104 (TRO-416, PLUGFORGE.MD §4). Mounted at
 * `/oauth` in `api/src/app.ts`, alongside PF-103's authorize router — a
 * second `app.use('/oauth', ...)` call, not folded into
 * `createOAuthAuthorizeRouter`, because this endpoint needs none of that
 * router's `webOrigin` (it never redirects; every response is JSON, per
 * RFC 6749 §5.1/§5.2).
 *
 * Form-encoded body per RFC 6749 §4.1.3/§4.4.2 — `express.urlencoded()` is
 * already mounted app-wide (`app.ts`), ahead of this router, so `req.body`
 * is populated the same way `POST /oauth/authorize/decision` already
 * relies on.
 *
 * Deliberately thin: request-shape extraction and HTTP status/JSON-shape
 * mapping only. Every validation predicate, the PKCE check, single-use
 * enforcement, client authentication, and both grants' token issuance live
 * in `../platform/oauth/token.js` (same split as `oauth-authorize.ts`).
 *
 * A third grant branch, `grant_type=urn:ietf:params:oauth:grant-type:
 * device_code` (RFC 8628 §3.4, PF-106 / TRO-425), dispatches to
 * `../platform/oauth/device.js`'s `pollDeviceCode` — same thin-router, same
 * `TokenGrantResult`/`sendTokenResult` shape as the two grants above, so a
 * device-flow response is indistinguishable in shape from an
 * authorization_code response (`authorization_pending`/`slow_down`/
 * `expired_token`/`access_denied` just widen this file's existing
 * `TokenErrorCode` handling — see `token.ts`'s updated union).
 *
 * Response shape on error is RFC 6749 §5.2's `{ error, error_description }`
 * JSON body — NOT the `/api/v1` `ApiError` shape (`platform/oauth/apiError.ts`).
 * `/oauth/token` is a token endpoint per RFC 6749, not an `/api/v1` resource;
 * `oauth-authorize.ts`'s header comment makes the identical call for the
 * authorize endpoint's own error reporting.
 *
 * NOT rate-limited, same reasoning and same open gap as `oauth-authorize.ts`:
 * `/oauth` sits outside the `/api/` prefix the legacy per-source-IP/
 * per-identity limiters match, and PLUGFORGE.MD §2.7 assigns the public
 * surface's rate limiting to PF-004/PF-500 explicitly. Flagged, not fixed,
 * per that sequencing — see CHANGES.md.
 *
 * OpenAPI registration: NOT registered. See CHANGES.md (TRO-416) for the
 * TRO-551 blocker this shares with PF-103's `/oauth/authorize` (same
 * findings-read-judged-not-to-fix precedent, same underlying MCP-executor
 * gap — checked fresh for this ticket, not assumed still true).
 */

import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';
import {
  redeemAuthorizationCode,
  issueClientCredentialsToken,
  type TokenErrorCode,
  type TokenGrantResult,
} from '../platform/oauth/token.js';
import { pollDeviceCode } from '../platform/oauth/device.js';

/** RFC 8628 §3.4's grant_type URN for the device polling branch (PF-106,
 * TRO-425). Not a bare `'device_code'` — the URN is what RFC 8628 actually
 * specifies and what a real device-flow client sends. */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sendTokenError(res: Response, status: number, error: TokenErrorCode, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function sendTokenResult(res: Response, result: TokenGrantResult): void {
  if (!result.ok) {
    sendTokenError(res, result.status, result.error, result.errorDescription);
    return;
  }

  const body: Record<string, unknown> = {
    access_token: result.accessToken,
    token_type: 'Bearer',
    expires_in: result.expiresIn,
    scope: result.scopes.join(' '),
  };
  // Omit the field entirely when absent (Client Credentials) rather than
  // sending `refresh_token: null` — RFC 6749 §5.1 lists it as OPTIONAL.
  if (result.refreshToken) {
    body.refresh_token = result.refreshToken;
  }

  res.status(200).json(body);
}

export function createOAuthTokenRouter(): RouterType {
  const router: RouterType = Router();

  router.post('/token', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const grantType = asString(body.grant_type);

      if (!grantType) {
        sendTokenError(res, 400, 'invalid_request', 'grant_type is required.');
        return;
      }

      if (grantType === 'authorization_code') {
        const code = asString(body.code);
        const redirectUri = asString(body.redirect_uri);
        const clientId = asString(body.client_id);
        const codeVerifier = asString(body.code_verifier);
        const clientSecret = asString(body.client_secret);

        if (!code || !redirectUri || !clientId || !codeVerifier) {
          sendTokenError(
            res,
            400,
            'invalid_request',
            'code, redirect_uri, client_id, and code_verifier are required.'
          );
          return;
        }

        const result = await redeemAuthorizationCode({
          code,
          redirectUri,
          clientId,
          clientSecret,
          codeVerifier,
        });
        sendTokenResult(res, result);
        return;
      }

      if (grantType === 'client_credentials') {
        const clientId = asString(body.client_id);
        const clientSecret = asString(body.client_secret);
        const scope = asString(body.scope);

        if (!clientId) {
          sendTokenError(res, 400, 'invalid_request', 'client_id is required.');
          return;
        }

        const result = await issueClientCredentialsToken({ clientId, clientSecret, scope });
        sendTokenResult(res, result);
        return;
      }

      if (grantType === DEVICE_CODE_GRANT_TYPE) {
        const deviceCode = asString(body.device_code);

        if (!deviceCode) {
          sendTokenError(res, 400, 'invalid_request', 'device_code is required.');
          return;
        }

        const result = await pollDeviceCode({ deviceCode });
        sendTokenResult(res, result);
        return;
      }

      sendTokenError(res, 400, 'unsupported_grant_type', `grant_type '${grantType}' is not supported.`);
    } catch (error) {
      // Same catch convention as every other route in this codebase
      // (oauth-authorize.ts, oauth-apps.ts, api-tokens.ts) — a transient DB
      // error becomes one failed request, not an unhandled rejection.
      console.error('POST /oauth/token error:', error instanceof Error ? error.message : error);
      sendTokenError(res, 500, 'server_error', 'Something went wrong. Please try again.');
    }
  });

  return router;
}

export default createOAuthTokenRouter;
