/**
 * `GET /oauth/authorize` + `POST /oauth/authorize/decision` — PF-103
 * (TRO-412, PLUGFORGE.MD §4). Mounted at `/oauth` in `api/src/app.ts`, NOT
 * under `/api` — this is the RFC 6749 authorization endpoint, a top-level
 * browser-navigated surface, not a JSON API resource. Per the PM triage
 * comment on this ticket: failures follow RFC 6749 §4.1.2.1 (redirect query
 * params), never the `ApiError` shape — that contract governs `/api/v1`
 * only.
 *
 * Deliberately thin: every DB read/write and the actual validation
 * predicates live in `../platform/oauth/authorize.js` (same split as
 * PF-102's `oauth-apps.ts` / `appRegistration.ts`). This file only shapes
 * HTTP requests into calls on that module and HTTP responses out of the
 * result.
 *
 * ── Why two real HTTP round trips instead of one, and why both end in a
 *    real 3xx rather than JSON ──
 *
 * The consent screen is a dedicated web-app route (`/oauth-consent`,
 * `web/src/pages/OAuthConsent.tsx`), not server-rendered here — see
 * CHANGES.md (TRO-412) for the full reasoning on that call, made explicit
 * because the ticket's own test-design comment flagged it as ambiguous.
 * Both endpoints below are reached by a real browser navigation or a plain
 * HTML `<form>` submission — never `fetch()` — specifically so:
 *   - Cookies flow on the well-understood SameSite/top-level-navigation
 *     rules, not on CORS. `/oauth` carries the *public*, credential-less
 *     CORS policy (`createPublicApiCors()`, app.ts) for the bearer-token
 *     surface (`/oauth/token` et al) — a `fetch()` with `credentials:
 *     'include'` from a cross-origin web app would be silently blocked by
 *     that policy. A native navigation/form is not subject to CORS at all,
 *     so this needs no change to that shared CORS wiring.
 *   - A literal `Location` header is exactly what `supertest` (and a real
 *     browser) can observe directly, matching the ticket's test-design
 *     comment ("response redirects to the registered redirect_uri").
 *
 * `POST /oauth/authorize/decision` carries no CSRF-synchronizer token
 * (`x-csrf-token`) — a plain HTML form cannot set a custom header, and
 * widening `csrfSync`'s `getTokenFromRequest` (app.ts) to also read a form
 * field would be a change to shared CSRF wiring, which `/ship-backend`
 * flags as a stop-for-human zone. This mirrors the codebase's own existing
 * precedent for an OAuth-shaped route (`caia-auth.ts`: "no CSRF protection
 * (OAuth flow with external callback)"). The session cookie is
 * `sameSite: 'strict'` (set in `caia-auth.ts`/`auth.ts` callers), which
 * already blocks a cross-site form POST from carrying it at all — a
 * forged submission from another site arrives with no session and is
 * rejected the same way an anonymous request is, before it can reach the
 * decision logic. Documented here, and in the PR body, for review.
 */

import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';
import {
  getOAuthAppByClientId,
  redirectUriIsRegistered,
  issueAuthorizationCode,
  parseScopeParam,
  getSessionPrincipal,
  type OAuthAppLookupRow,
} from '../platform/oauth/authorize.js';

const router: RouterType = Router();

/** The frontend's own origin — same env var the app-global session CORS
 * policy already uses (`corsOrigin` param to `createApp()`, app.ts). Needed
 * here because, unlike every other value on this router, `/login` and
 * `/oauth-consent` are pages the WEB app serves, not this API — a request
 * that lands directly on this API's own `/oauth/authorize` URL (the RFC
 * 6749 authorization endpoint, which is this API, not the web app) has to
 * be sent to a *different* origin to reach either of them. */
function webAppOrigin(): string {
  return process.env.CORS_ORIGIN || 'http://localhost:5173';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Open-redirect guard path: the request's `redirect_uri` could not be
 * verified against the app's registered list (or the app/client_id itself
 * is unknown), so this response must never redirect anywhere — including to
 * the caller-supplied `redirect_uri` itself. Renders a minimal, static
 * error page; no request-supplied value is ever interpolated into the HTML,
 * so there is nothing here to escape. */
function sendUnsafeToRedirectError(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html><head><title>Authorization error</title></head>` +
        `<body><h1>Authorization error</h1><p>${message}</p></body></html>`
    );
}

/** Once `redirect_uri` is verified against the app's registered list, RFC
 * 6749 §4.1.2.1 wants further errors reported back to the client via
 * redirect, not shown in Ship's own UI (PM triage comment #1 on this
 * ticket). */
function redirectWithOAuthError(
  res: Response,
  redirectUri: string,
  error: string,
  state: string | undefined,
  status = 302
): void {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (state !== undefined) target.searchParams.set('state', state);
  res.redirect(status, target.toString());
}

/** Shared validation for both endpoints below: resolve the app, verify
 * `redirect_uri` is exactly registered, and verify `code_challenge`/method.
 * Returns either the validated app + fields, or a discriminated failure the
 * caller renders. Re-run in full by BOTH the GET and the POST — the POST
 * never trusts a client-resubmitted `client_id`/`redirect_uri` pair without
 * re-checking it, since nothing server-side ties the two requests together
 * (see the module doc: no server-side "pending request" storage exists in
 * this MVP-gate ticket, by design — the consent page resubmits the fields
 * the GET already validated once). */
type ValidationResult =
  | {
      ok: true;
      app: OAuthAppLookupRow;
      redirectUri: string;
      codeChallenge: string;
      scope: string | undefined;
      state: string | undefined;
    }
  | { ok: false; kind: 'unsafe'; message: string }
  | { ok: false; kind: 'oauth-error'; redirectUri: string; error: string; state: string | undefined };

function validateAuthorizeRequest(query: Record<string, unknown>, app: OAuthAppLookupRow | null): ValidationResult {
  const redirectUri = asString(query.redirect_uri);
  const codeChallenge = asString(query.code_challenge);
  const codeChallengeMethod = asString(query.code_challenge_method);
  const scope = asString(query.scope);
  const state = asString(query.state);

  if (!redirectUri) {
    return { ok: false, kind: 'unsafe', message: 'redirect_uri is required.' };
  }

  if (!app) {
    // Unknown or revoked client_id — cannot trust ANY redirect_uri for a
    // client we could not resolve, registered-looking or not.
    return { ok: false, kind: 'unsafe', message: 'Unknown or revoked client_id.' };
  }

  if (!redirectUriIsRegistered(app, redirectUri)) {
    // Exact-match failure — the open-redirect guard. Never redirect to this
    // value, even to report the error (test-design comment, AC-2).
    return { ok: false, kind: 'unsafe', message: 'redirect_uri is not registered for this application.' };
  }

  // From here on, redirect_uri is trusted: report the rest via redirect.
  if (!codeChallenge) {
    return { ok: false, kind: 'oauth-error', redirectUri, error: 'invalid_request', state };
  }

  if (codeChallengeMethod !== 'S256') {
    // S256-only (PLUGFORGE.MD §2.2, §7 risk table: "no plain PKCE, S256
    // only"). `plain` and anything else are rejected here.
    return { ok: false, kind: 'oauth-error', redirectUri, error: 'invalid_request', state };
  }

  return { ok: true, app, redirectUri, codeChallenge, scope, state };
}

// GET /oauth/authorize — the RFC 6749 authorization endpoint. A third-party
// OAuth client (or, per the graded scenario, the browser under test)
// navigates the user's browser here directly.
router.get('/authorize', async (req: Request, res: Response): Promise<void> => {
  const clientId = asString(req.query.client_id);

  if (!clientId) {
    sendUnsafeToRedirectError(res, 400, 'client_id is required.');
    return;
  }

  const app = await getOAuthAppByClientId(clientId);
  const validation = validateAuthorizeRequest(req.query as Record<string, unknown>, app);

  if (!validation.ok) {
    if (validation.kind === 'unsafe') {
      sendUnsafeToRedirectError(res, 400, validation.message);
      return;
    }
    redirectWithOAuthError(res, validation.redirectUri, validation.error, validation.state);
    return;
  }

  // Everything about the request itself checks out. Build the web app's
  // consent-page path — carrying the now-validated fields forward, plus the
  // app's display name so the consent page needs no extra round trip.
  const consentPath = buildConsentPath(validation);

  const principal = await getSessionPrincipal(req);
  if (!principal) {
    const loginUrl = new URL('/login', webAppOrigin());
    loginUrl.searchParams.set('returnTo', consentPath);
    res.redirect(loginUrl.toString());
    return;
  }

  res.redirect(new URL(consentPath, webAppOrigin()).toString());
});

function buildConsentPath(validation: Extract<ValidationResult, { ok: true }>): string {
  // Built from a relative base so `URLSearchParams` alone is enough — no
  // origin needed yet (the two call sites above each resolve it against
  // their own target: `/login`'s `returnTo`, or `webAppOrigin()` directly).
  const params = new URLSearchParams();
  params.set('client_id', validation.app.client_id);
  params.set('redirect_uri', validation.redirectUri);
  params.set('code_challenge', validation.codeChallenge);
  params.set('code_challenge_method', 'S256');
  params.set('app_name', validation.app.name);
  if (validation.scope) params.set('scope', validation.scope);
  if (validation.state) params.set('state', validation.state);
  return `/oauth-consent?${params.toString()}`;
}

// POST /oauth/authorize/decision — the consent page's Approve/Deny form
// target. `express.urlencoded()` is already mounted app-wide (app.ts), so a
// standard HTML form POST lands in `req.body` here without further setup.
router.post('/authorize/decision', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const clientId = asString(body.client_id);
  const decision = asString(body.decision);

  if (!clientId) {
    sendUnsafeToRedirectError(res, 400, 'client_id is required.');
    return;
  }

  const app = await getOAuthAppByClientId(clientId);
  const validation = validateAuthorizeRequest(body, app);

  if (!validation.ok) {
    if (validation.kind === 'unsafe') {
      sendUnsafeToRedirectError(res, 400, validation.message);
      return;
    }
    redirectWithOAuthError(res, validation.redirectUri, validation.error, validation.state);
    return;
  }

  const principal = await getSessionPrincipal(req);
  if (!principal) {
    const loginUrl = new URL('/login', webAppOrigin());
    loginUrl.searchParams.set('returnTo', buildConsentPath(validation));
    res.redirect(303, loginUrl.toString());
    return;
  }

  if (decision === 'deny') {
    // AC-3: redirect to the registered redirect_uri with error=access_denied
    // and no code param, and — implicitly, by never calling
    // issueAuthorizationCode — no oauth_authorization_codes row.
    redirectWithOAuthError(res, validation.redirectUri, 'access_denied', validation.state, 303);
    return;
  }

  if (decision !== 'approve') {
    sendUnsafeToRedirectError(res, 400, 'decision must be "approve" or "deny".');
    return;
  }

  const scopes = parseScopeParam(validation.scope);
  const code = await issueAuthorizationCode({
    appId: validation.app.id,
    userId: principal.userId,
    scopes: scopes.length > 0 ? scopes : validation.app.requested_scopes,
    codeChallenge: validation.codeChallenge,
    redirectUri: validation.redirectUri,
  });

  const target = new URL(validation.redirectUri);
  target.searchParams.set('code', code);
  if (validation.state !== undefined) target.searchParams.set('state', validation.state);
  res.redirect(303, target.toString());
});

export default router;
