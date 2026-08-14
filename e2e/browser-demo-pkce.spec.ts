/**
 * TRO-449 / PF-802 — Browser SDK demo, full PKCE round trip driven through
 * the REAL demo SPA (not raw HTTP calls to /oauth/*, unlike
 * e2e/oauth-pkce-chain.spec.ts's API-level proof — this file's whole point
 * is proving @ship/sdk's authorizationCodeFlow() actually works as a real
 * browser dependency, end to end, through integrations/browser-demo).
 *
 * ── Why login still happens via a page.goto('/login'), same as the sibling
 *    PKCE spec ──
 *
 * A public OAuth client's authorize step still requires an existing Ship
 * session — a demo app can start the flow, but Ship still authenticates the
 * human. `localhost`'s session cookie is host-only but NOT port-scoped (RFC
 * 6265 cookies ignore port), so logging in once on the web app's origin
 * carries automatically to both the API's own port (`/oauth/authorize`) and
 * this demo's preview server's port — verified working by
 * oauth-pkce-chain.spec.ts's identical cross-port navigation, reused here.
 *
 * ── Why the demo's config is injected, not baked into its build ──
 *
 * See integrations/browser-demo/src/main.ts's header:
 * `window.__SHIP_DEMO_CONFIG__`, set here via `page.addInitScript()` before
 * any navigation, lets the one shared, globally-built `dist/` bundle
 * (e2e/fixtures/browser-demo-env.ts's `browserDemoServer` fixture) point at
 * THIS worker's own API server and freshly seeded OAuth app, with no
 * per-worker rebuild.
 */
import { test, expect, seedBrowserDemoOAuthApp } from './fixtures/browser-demo-env';
import type { Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });
}

test.describe('Browser SDK demo: authorizationCodeFlow() PKCE round trip (TRO-449/PF-802)', () => {
  test.describe.configure({ mode: 'serial' });

  test('Connect to Ship -> consent -> documents list, real browser round trip', async ({
    page,
    apiServer,
    dbContainer,
    browserDemoServer,
  }) => {
    const redirectUri = `${browserDemoServer.url}/`;
    const { clientId } = await seedBrowserDemoOAuthApp(dbContainer.getConnectionUri(), redirectUri);

    await login(page);

    await page.addInitScript(
      (config) => {
        window.__SHIP_DEMO_CONFIG__ = config;
      },
      { clientId, apiBaseUrl: apiServer.url, redirectUri, scope: 'documents:read' }
    );

    await page.goto(browserDemoServer.url);
    await expect(page.getByRole('button', { name: 'Connect to Ship' })).toBeVisible();

    // Round trip clock starts at the user's own click — the truest
    // end-to-end number for the demo's stated AC ("P95 < 3s"), not just the
    // authorize->token leg oauth-pkce-chain.spec.ts already measures.
    const roundTripStartMs = Date.now();
    await page.getByRole('button', { name: 'Connect to Ship' }).click();

    await expect(page).toHaveURL(/\/oauth-consent/, { timeout: 5000 });
    await page.getByRole('button', { name: 'Authorize' }).click();

    // Back on the demo's own origin, code exchanged, documents rendered.
    await expect(page).toHaveURL(`${redirectUri}`, { timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 5000 });
    const roundTripMs = Date.now() - roundTripStartMs;

    console.log(`[TRO-449] Browser demo PKCE round trip (click -> documents rendered): ${roundTripMs}ms`);
    expect(roundTripMs, `round trip was ${roundTripMs}ms, target <3000ms (PLUGFORGE.MD §4)`).toBeLessThan(3000);

    // documents.iterate() actually rendered real items — the seeded dev
    // workspace has hundreds of documents (audit's seed augmentation), so a
    // non-empty list confirms the async iterator, not just the auth chain.
    const items = page.locator('#documents li');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(0);

    // A reload with no ?code= in the URL should resume the session from
    // localStorage (LocalStorageTokenStore) rather than re-prompting login —
    // proves the token actually persisted, not just that leg 2 rendered once.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Connect to Ship' })).toHaveCount(0);
  });

  test('negative: unregistered redirect_uri never silently succeeds', async ({
    page,
    apiServer,
    dbContainer,
    browserDemoServer,
  }) => {
    // Seed the app with a DIFFERENT registered redirect_uri than the one
    // this test's config actually points the demo at — proves the server
    // rejects the mismatch rather than the demo just not asking for it.
    const registeredRedirectUri = `${browserDemoServer.url}/some-other-path`;
    const { clientId } = await seedBrowserDemoOAuthApp(dbContainer.getConnectionUri(), registeredRedirectUri);

    await login(page);

    await page.addInitScript(
      (config) => {
        window.__SHIP_DEMO_CONFIG__ = config;
      },
      { clientId, apiBaseUrl: apiServer.url, redirectUri: `${browserDemoServer.url}/`, scope: 'documents:read' }
    );

    await page.goto(browserDemoServer.url);
    await page.getByRole('button', { name: 'Connect to Ship' }).click();

    // Never redirected anywhere (open-redirect guard, oauth-authorize.ts's
    // sendUnsafeToRedirectError) — stays on the API's own /oauth/authorize,
    // renders a static error, never reaches consent or the demo's redirect.
    await expect(page).toHaveURL(/\/oauth\/authorize/, { timeout: 5000 });
    await expect(page.locator('h1')).toHaveText('Authorization error');
    expect(page.url()).not.toContain(browserDemoServer.url + '/?');
  });

  test('a failed leg-2 exchange clears the stale ?code= so retrying starts a fresh login', async ({
    page,
    apiServer,
    dbContainer,
    browserDemoServer,
  }) => {
    const redirectUri = `${browserDemoServer.url}/`;
    const { clientId } = await seedBrowserDemoOAuthApp(dbContainer.getConnectionUri(), redirectUri);

    // Logged in first, same as the other two tests — a real user retrying
    // "Connect to Ship" after a failed exchange already has a Ship session;
    // without one, the retry's redirect to /oauth/authorize itself bounces
    // to /login first, which would be true but not what this test is about.
    await login(page);

    await page.addInitScript(
      (config) => {
        window.__SHIP_DEMO_CONFIG__ = config;
      },
      { clientId, apiBaseUrl: apiServer.url, redirectUri, scope: 'documents:read' }
    );

    // No real authorize round trip: a fabricated ?code=&state= with no
    // matching PKCE verifier ever stored deterministically reproduces
    // authorizationCodeFlow()'s leg-2 failure ("no matching PKCE state found
    // in storage") without needing a real but-expired server-issued code.
    await page.goto(`${redirectUri}?code=fake-stale-code&state=fake-stale-state`);

    // Regression proof for main.ts's catch block: without clearing the URL
    // on a leg-2 failure, this second click would silently re-attempt the
    // exchange with the SAME stale params still in location.href instead of
    // starting a real redirect to /oauth/authorize.
    await expect(page.getByRole('button', { name: 'Connect to Ship' })).toBeVisible({ timeout: 5000 });
    expect(page.url()).toBe(redirectUri);

    await page.getByRole('button', { name: 'Connect to Ship' }).click();
    // A genuine fresh leg-1 redirect: /oauth/authorize validates a NEW
    // code_challenge/state (not the stale fake ones) and forwards to
    // consent — landing here (rather than stuck replaying the dead code)
    // is the actual proof the retry started clean.
    await expect(page).toHaveURL(/\/oauth-consent/, { timeout: 5000 });
  });
});
