/**
 * PF-103 (TRO-412) — additive Playwright e2e for `/oauth/authorize` +
 * the consent screen. Per the ticket's own NOTE and this repo's
 * `/ship-qa` skill: this spec is ADDITIVE coverage, never the factory-gate
 * proof — `e2e/*.spec.ts` is outside both vitest configs
 * (`api/vitest.config.ts` pins `include: ['src/**\/*.test.ts']`; `web`'s
 * config resolves from `web/`), so `gate.sh` never executes this file even
 * though it counts toward the gate's "regression test added" grep. The real
 * proof is `api/src/platform/oauth/__tests__/authorize.test.ts` (13 cases,
 * seen red-before-green — see CHANGES.md TRO-412).
 *
 * ── Execution status (read before trusting this file) ──
 *
 * RUNS, and both tests pass — first real, completed execution this session
 * (`pnpm exec playwright test e2e/oauth-authorize.spec.ts --workers=1`, 2
 * passed in ~22s). The migration gap that previously blocked every spec
 * touching `oauth_apps` (TRO-430: `runMigrations()` marked migrations
 * "applied" without executing their SQL) was fixed on this branch's history
 * before this spec was re-attempted — `pnpm db:migrate`'s real runner is now
 * what this fixture delegates to (see `e2e/fixtures/isolated-env.ts`'s
 * `runMigrations`).
 *
 * Getting from "runs" to "passes" took four defects, each trace-verified
 * (Playwright trace / `page.goto` network log), not re-diagnosed by
 * inspection alone:
 *  1. Neither test set `response_type=code` on the authorize URL, so the API
 *     correctly 302'd with `error=unsupported_response_type` before either
 *     test ever legitimately reached consent. Fixed: both tests set it.
 *  2. `REDIRECT_URI` was a non-existent external domain
 *     (`https://oauth-demo-client.example.test/callback`), and the spec
 *     tried to intercept it with `page.route()`. A server-issued 302 is a
 *     real browser navigation, which `page.route()` cannot fulfill —
 *     Chromium died with `ERR_NAME_NOT_RESOLVED`. Fixed: `redirectUri` is
 *     now `${baseURL}/e2e-oauth-callback`, a path on this worker's OWN web
 *     origin that no app route matches (the SPA's catch-all,
 *     `web/src/main.tsx`'s `path="*"` -> `NotFoundPage`, renders in place
 *     without changing the URL), so the final navigation actually commits
 *     and `page.url()` can be asserted on directly. `seedOAuthApp` now takes
 *     this as a parameter instead of a hardcoded constant — it must stay
 *     EXACTLY equal to what's passed as `redirect_uri` on the authorize URL,
 *     since the API enforces an exact match (AC-2, the open-redirect guard).
 *  3. `e2e/fixtures/isolated-env.ts` spawned the api with `CORS_ORIGIN: '*'`.
 *     `api/src/app.ts` threads that into
 *     `createOAuthAuthorizeRouter(corsOrigin)` as `webOrigin`
 *     (`api/src/routes/oauth-authorize.ts`), which builds absolute
 *     `/login`/`/oauth-consent` redirects via `new URL(path, webOrigin)` —
 *     `'*'` is not a valid URL base and that throws, 500ing every
 *     consent/login redirect. Fixed: the api now gets a real
 *     `http://localhost:<webPort>` origin, reserved before the api process
 *     spawns (see that fixture's `apiServer`/`webServer` comments for how
 *     the port is shared instead of independently recomputed).
 *  4. Undiagnosed until this session's first real run: with defects 1-3
 *     fixed, clicking "Authorize" hung until the 60s test timeout. Trace
 *     showed why: `POST /oauth/authorize/decision` came back `404`.
 *     `OAuthConsentPage`'s form posts to a relative path (`API_URL` is
 *     deliberately baked to `''` at build time, `web/package.json`'s
 *     `build` script), which resolves against the WEB origin — but
 *     `web/vite.config.ts`'s dev/preview proxy only forwarded `/api`,
 *     `/collaboration`, `/events` to the api, not `/oauth`. Fixed by adding
 *     an `/oauth/` (trailing slash load-bearing — see that file's comment)
 *     proxy entry. This is the local analog of a gap this ticket's own
 *     CHANGES.md entry already flags for production CloudFront (no
 *     `/oauth/*` `ordered_cache_behavior`) — still open there, terraform is
 *     out of scope for this spec fix.
 *
 * The assertions below are real (no `test.fixme()`), and prove the same
 * three ACs the vitest suite proves plus the CSP header (AC-4, which has no
 * vitest case — see that test file's header for why), through an actual
 * browser session — this file's own header no longer just claims that, it
 * now runs and is green.
 */
import { test, expect } from './fixtures/isolated-env';
import { Pool } from 'pg';
import crypto from 'crypto';

// `redirectUri` is derived per-test from the worker's `baseURL` (see each
// test body) rather than a module constant — see this file's header for why.
async function seedOAuthApp(dbUrl: string, redirectUri: string): Promise<{ clientId: string }> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const workspaceResult = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`
    );
    const [workspace] = workspaceResult.rows;
    if (!workspace) throw new Error('seedMinimalTestData should have created a workspace');

    const clientId = `ship_app_e2e_${crypto.randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'PF-103 E2E Demo Client', $2, 'public', $3, $4)`,
      [workspace.id, clientId, [redirectUri], ['documents:read']]
    );
    return { clientId };
  } finally {
    await pool.end();
  }
}

test.describe('OAuth authorize + consent (PF-103)', () => {
  test.describe.configure({ mode: 'serial' });

  test('login -> authorize -> consent -> redirect with code (graded PKCE scenario, first half)', async ({
    page,
    apiServer,
    dbContainer,
    baseURL,
  }) => {
    // A path on this worker's OWN web origin that no route matches — the
    // SPA's catch-all (`web/src/main.tsx`'s `path="*"` -> `NotFoundPage`)
    // renders in place without changing the URL, so the navigation commits
    // and `page.url()` carries the real `code=`/`state=` query params. Must
    // stay EXACTLY equal to what `seedOAuthApp` registers below — the API
    // enforces an exact `redirect_uri` match (AC-2, the open-redirect guard).
    const redirectUri = `${baseURL}/e2e-oauth-callback`;
    const { clientId } = await seedOAuthApp(dbContainer.getConnectionUri(), redirectUri);

    // Step 1: log in (dev seed user, matching e2e/auth.spec.ts's pattern).
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });

    // Step 2: navigate directly to the API's own authorization endpoint —
    // this is what a real third-party OAuth client redirects the browser
    // to. Already authenticated, so this should land on the consent page.
    const authorizeUrl = new URL('/oauth/authorize', apiServer.url);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', 'e2e-test-challenge-value');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'documents:read');
    authorizeUrl.searchParams.set('state', 'e2e-state-1');

    const consentResponse = await page.goto(authorizeUrl.toString());
    await expect(page).toHaveURL(/\/oauth-consent/);

    // AC-4: frame-ancestors 'none' on whatever response carries the consent
    // UI. Best-effort here — see this repo's vite.config.ts (PF-103 /
    // oauth-consent-csp plugin) for the mechanism and its own "not verified
    // for production" caveat. Hard assert that navigation produced a
    // response at all (rather than silently skipping the check when it
    // didn't) — CodeRabbit review finding, TRO-412.
    expect(consentResponse, 'page.goto should return a Response for a same-tab navigation').not.toBeNull();
    const csp = consentResponse?.headers()['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'none'");

    // PM-triaged review finding (TRO-412, security interim fix): the
    // consent screen no longer renders the caller-supplied `app_name` query
    // param (never bound to the validated `client_id`, so it was
    // spoofable) — the heading is now always generic, and the validated
    // `client_id`/`redirect_uri` are shown instead so the user can verify
    // what they're actually authorizing.
    await expect(page.getByRole('heading', { name: /Authorize This application/i })).toBeVisible();
    await expect(page.getByText(clientId)).toBeVisible();
    await expect(page.getByText(redirectUri)).toBeVisible();

    // Step 3: approve.
    await page.getByRole('button', { name: 'Authorize' }).click();
    await page.waitForURL(`${redirectUri}*`);
    const finalUrl = new URL(page.url());
    expect(finalUrl.origin + finalUrl.pathname).toBe(new URL(redirectUri).origin + new URL(redirectUri).pathname);
    expect(finalUrl.searchParams.get('code')).toBeTruthy();
    expect(finalUrl.searchParams.get('state')).toBe('e2e-state-1');
  });

  test('deny path redirects with error=access_denied', async ({ page, apiServer, dbContainer, baseURL }) => {
    // See the first test's comment on `redirectUri` — must exactly match
    // what's registered below (AC-2, the open-redirect guard).
    const redirectUri = `${baseURL}/e2e-oauth-callback`;
    const { clientId } = await seedOAuthApp(dbContainer.getConnectionUri(), redirectUri);

    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });

    const authorizeUrl = new URL('/oauth/authorize', apiServer.url);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', 'e2e-test-challenge-value-2');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    await page.goto(authorizeUrl.toString());
    await expect(page).toHaveURL(/\/oauth-consent/);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForURL(`${redirectUri}*`);
    const finalUrl = new URL(page.url());
    expect(finalUrl.searchParams.get('error')).toBe('access_denied');
    expect(finalUrl.searchParams.has('code')).toBe(false);
  });
});
