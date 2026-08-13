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
 * NOT run to completion in this worktree. Confirmed, not assumed: attempted
 * once via a scoped single-spec run (`playwright test oauth-authorize.spec.ts`,
 * output to a file, never `pnpm test:e2e` per this repo's binding rule) and
 * it failed at the seed step with `relation "oauth_apps" does not exist`.
 * Root-caused to a PRE-EXISTING gap unrelated to this ticket's code:
 * `e2e/fixtures/isolated-env.ts`'s `runMigrations()` does not execute
 * migration files' SQL at all — it applies `api/src/db/schema.sql` and then
 * marks every file in `api/src/db/migrations/` as already-applied in
 * `schema_migrations` (comment: "schema.sql includes all table definitions
 * from all migrations"). That was true through migration 041
 * (`grep -c blocks_relationship api/src/db/schema.sql` finds 4 matches,
 * confirming 040/041 WERE folded back into schema.sql) but migrations 042
 * `oauth_apps` and 043 `oauth_authorization_codes` (PF-101/TRO-406,
 * 2026-08-10) never were (`grep oauth_apps api/src/db/schema.sql` — no
 * match). The isolated-env testcontainers database therefore has no
 * `oauth_apps`/`oauth_authorization_codes` tables at all, while
 * `schema_migrations` falsely claims both versions are applied — every
 * future e2e spec touching ANY table from PF-101 onward (this one, PF-104's,
 * the portal's) will hit the identical failure until schema.sql is synced.
 * Reported as a new problem in this ticket's final report (out of scope to
 * fix here — schema.sql is shared infrastructure, not owned by PF-103).
 *
 * The assertions below are real (no `test.fixme()`), written to prove the
 * same three ACs the vitest suite proves plus the CSP header (AC-4, which
 * has no vitest case — see that test file's header for why), through an
 * actual browser session. CI, or a worktree with the schema.sql gap fixed,
 * is what will actually execute them.
 */
import { test, expect } from './fixtures/isolated-env';
import { Pool } from 'pg';
import crypto from 'crypto';

const REDIRECT_URI = 'https://oauth-demo-client.example.test/callback';

async function seedOAuthApp(dbUrl: string): Promise<{ clientId: string }> {
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
      [workspace.id, clientId, [REDIRECT_URI], ['documents:read']]
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
  }) => {
    const { clientId } = await seedOAuthApp(dbContainer.getConnectionUri());

    // Intercept the demo client's callback — no real third-party server
    // exists in this environment; Playwright fulfills the navigation
    // directly so the final `code=` param is observable without one.
    await page.route(`${REDIRECT_URI}*`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
    );

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
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
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

    await expect(page.getByRole('heading', { name: /Authorize PF-103 E2E Demo Client/i })).toBeVisible();

    // Step 3: approve.
    await page.getByRole('button', { name: 'Authorize' }).click();
    await page.waitForURL(`${REDIRECT_URI}*`);
    const finalUrl = new URL(page.url());
    expect(finalUrl.origin + finalUrl.pathname).toBe(new URL(REDIRECT_URI).origin + new URL(REDIRECT_URI).pathname);
    expect(finalUrl.searchParams.get('code')).toBeTruthy();
    expect(finalUrl.searchParams.get('state')).toBe('e2e-state-1');
  });

  test('deny path redirects with error=access_denied', async ({ page, apiServer, dbContainer }) => {
    const { clientId } = await seedOAuthApp(dbContainer.getConnectionUri());

    await page.route(`${REDIRECT_URI}*`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
    );

    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });

    const authorizeUrl = new URL('/oauth/authorize', apiServer.url);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge', 'e2e-test-challenge-value-2');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    await page.goto(authorizeUrl.toString());
    await expect(page).toHaveURL(/\/oauth-consent/);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForURL(`${REDIRECT_URI}*`);
    const finalUrl = new URL(page.url());
    expect(finalUrl.searchParams.get('error')).toBe('access_denied');
    expect(finalUrl.searchParams.has('code')).toBe(false);
  });
});
