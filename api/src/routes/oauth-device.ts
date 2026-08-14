/**
 * `POST /oauth/device/code` + `POST /oauth/device/verify` — PF-106
 * (TRO-425, PLUGFORGE.MD §4: Device Authorization Grant, RFC 8628).
 * Mounted at `/oauth` in `api/src/app.ts`, alongside PF-103/PF-104's
 * routers — a third `app.use('/oauth', ...)` call, same reasoning as
 * `oauth-token.ts`'s header for why this isn't folded into
 * `createOAuthAuthorizeRouter`: distinct ticket, own module.
 *
 * Deliberately thin: every DB read/write and validation predicate lives in
 * `../platform/oauth/device.ts` (same split as every other OAuth ticket in
 * this codebase).
 *
 * ── `POST /oauth/device/code` (RFC 8628 §3.1/§3.2) ──
 * A device/CLI client's initial request. JSON response (device_code,
 * user_code, verification_uri, verification_uri_complete, expires_in,
 * interval) per §3.2 — same public, credential-less CORS policy as
 * `/oauth/token` (`app.ts`'s `createPublicApiCors()` on `['/api/v1',
 * '/oauth']`), since this is exactly the kind of caller that policy exists
 * for (a bearer/CLI client on no particular origin, never a cookied
 * browser).
 *
 * ── `POST /oauth/device/verify` (the verification page's Approve/Deny
 *    form target) ──
 * NOT `fetch()` from the web app — a plain HTML `<form>` POST, same choice
 * and same reasoning as `oauth-authorize.ts`'s `POST /oauth/authorize/
 * decision`: `/oauth` carries the public, credential-less CORS policy
 * (`credentials: false`), so a cross-origin `fetch(..., {credentials:
 * 'include'})` from the web app would be silently blocked from ever sending
 * the session cookie; a native top-level form navigation is not subject to
 * CORS at all and carries the cookie under ordinary SameSite rules. Also
 * carries no CSRF-synchronizer token for the identical reason
 * `oauth-authorize.ts` documents: a plain HTML form cannot set the
 * `x-csrf-token` header, and the session cookie is `sameSite: 'strict'`
 * (app.ts), which already blocks a cross-site forged form POST from
 * carrying it at all.
 *
 * The web-app PAGE that renders this form is NOT at `/oauth/device/verify`
 * — it is `/oauth-device-verify` (`web/src/pages/OAuthDeviceVerify.tsx`).
 * See that file's header for why: the dev/preview Vite proxy's `/oauth/`
 * key (trailing slash, `web/vite.config.ts`) forwards ANY `oauth/*` path to
 * this API, so a frontend SPA route actually AT `/oauth/device/verify`
 * would never reach React Router locally — the exact trap `oauth-authorize.
 * ts`'s own header already documents for why the consent page is
 * `/oauth-consent`, not `/oauth/consent`. This endpoint (the API decision
 * target) keeps the RFC-shaped `/oauth/device/verify` path since only the
 * FRONTEND route needed to move.
 *
 * OpenAPI registration: NOT registered here — same deferral PF-104's
 * `oauth-token.ts` states for `/oauth/token`. One correction to that
 * file's own reasoning, checked fresh for this ticket rather than copied
 * forward unread (CLAUDE.md's provenance rule): TRO-551 (merged to `main`
 * as PR #188, BEFORE PF-104's PR #189) already built the exact mechanism
 * that would be needed (`ROOT_SERVER`, a per-operation OpenAPI `servers`
 * override for routes mounted outside `/api`) — it is not still blocked on
 * anything. Registration is deferred here as a scope decision (this ticket
 * is about the device-grant flow itself; wiring three more non-`/api/v1`
 * schema files is a follow-up), not because the mechanism is missing. See
 * CHANGES.md (TRO-425) for the full account.
 */

import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';
import {
  createDeviceCode,
  decideDeviceCode,
  type CreateDeviceCodeResult,
} from '../platform/oauth/device.js';
import { getSessionPrincipal } from '../platform/oauth/authorize.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Frontend SPA route for the verification page — see this file's header
 * for why it is NOT `/oauth/device/verify` (the Vite dev/preview proxy
 * would swallow that path before React Router ever sees it). */
const VERIFY_PAGE_PATH = '/oauth-device-verify';

function sendDeviceCodeError(res: Response, status: number, result: Extract<CreateDeviceCodeResult, { ok: false }>): void {
  res.status(status).json({ error: result.error, error_description: result.errorDescription });
}

export function createOAuthDeviceRouter(webOrigin: string): RouterType {
  const router: RouterType = Router();

  // POST /oauth/device/code — RFC 8628 §3.1. `express.urlencoded()`/
  // `express.json()` are both already mounted app-wide (app.ts) ahead of
  // this router, so either a form-encoded or a JSON body lands in
  // `req.body` here.
  router.post('/device/code', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const clientId = asString(body.client_id);
      const scope = asString(body.scope);

      if (!clientId) {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required.' });
        return;
      }

      const result = await createDeviceCode({ clientId, scope });

      if (!result.ok) {
        const status = result.error === 'invalid_client' ? 401 : 400;
        sendDeviceCodeError(res, status, result);
        return;
      }

      const verificationUri = new URL(VERIFY_PAGE_PATH, webOrigin).toString();
      const verificationUriComplete = new URL(VERIFY_PAGE_PATH, webOrigin);
      verificationUriComplete.searchParams.set('user_code', result.userCode);

      // RFC 8628 §3.2 response shape.
      res.status(200).json({
        device_code: result.deviceCode,
        user_code: result.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete.toString(),
        expires_in: result.expiresIn,
        interval: result.interval,
      });
    } catch (error) {
      // Same catch convention as every other route in this codebase
      // (oauth-authorize.ts, oauth-token.ts): a transient DB error becomes
      // one failed request, not an unhandled rejection.
      console.error('POST /oauth/device/code error:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'server_error', error_description: 'Something went wrong. Please try again.' });
    }
  });

  // POST /oauth/device/verify — the verification page's Approve/Deny form
  // target. See file header for why this is a plain form POST, not fetch.
  router.post('/device/verify', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const userCodeInput = asString(body.user_code);
      const decision = asString(body.decision);

      const principal = await getSessionPrincipal(req);
      if (!principal) {
        const loginUrl = new URL('/login', webOrigin);
        const returnTo = new URL(VERIFY_PAGE_PATH, webOrigin);
        if (userCodeInput) returnTo.searchParams.set('user_code', userCodeInput);
        loginUrl.searchParams.set('returnTo', `${returnTo.pathname}${returnTo.search}`);
        res.redirect(303, loginUrl.toString());
        return;
      }

      if (!userCodeInput) {
        const target = new URL(VERIFY_PAGE_PATH, webOrigin);
        target.searchParams.set('error', 'invalid_code');
        res.redirect(303, target.toString());
        return;
      }

      if (decision !== 'approve' && decision !== 'deny') {
        const target = new URL(VERIFY_PAGE_PATH, webOrigin);
        target.searchParams.set('error', 'invalid_code');
        res.redirect(303, target.toString());
        return;
      }

      const result = await decideDeviceCode({
        userCodeInput,
        userId: principal.userId,
        decision,
      });

      const target = new URL(VERIFY_PAGE_PATH, webOrigin);
      if (!result.ok) {
        target.searchParams.set('error', result.reason);
        res.redirect(303, target.toString());
        return;
      }

      target.searchParams.set('result', result.decision === 'approve' ? 'approved' : 'denied');
      res.redirect(303, target.toString());
    } catch (error) {
      console.error('POST /oauth/device/verify error:', error instanceof Error ? error.message : error);
      const target = new URL(VERIFY_PAGE_PATH, webOrigin);
      target.searchParams.set('error', 'server_error');
      res.redirect(303, target.toString());
    }
  });

  return router;
}

export default createOAuthDeviceRouter;
