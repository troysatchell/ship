/**
 * TRO-445 / PF-800 — "the stolen-token story", narrated end-to-end: a real
 * browser drives login -> /oauth/authorize -> consent to obtain a genuine
 * authorization code, then real HTTP calls exchange it for a token pair,
 * rotate it once (the legitimate client refreshing, as it normally would),
 * and finally REPLAY the now-retired old refresh token — the shape of a
 * refresh token that leaked at some point in the past and gets used by
 * someone who is not the legitimate client, after the legitimate client has
 * already moved on to its next one.
 *
 * ── What this file is, and is not, proof of ──
 *
 * This is ADDITIVE coverage, per `ship-qa`/lessons.md §13: `e2e/*.spec.ts`
 * sits outside both vitest configs (`api/vitest.config.ts` pins
 * `include: ['src/**\/*.test.ts']`; `web`'s config resolves from `web/`), so
 * `gate.sh` never executes this file even though it counts toward the gate's
 * "regression test added" grep. The real, gate-executed proof for this
 * ticket is `api/src/platform/oauth/__tests__/refresh-rotation-stolen-token.test.ts`
 * (see that file's header for the red-before-green teeth-proof: the
 * family-revocation call was temporarily disabled and observed to fail the
 * "active session killed" assertion with a real `AssertionError`, then
 * restored). This file exists because the ticket's own AC asks for the
 * story to be provable end-to-end through real endpoints, not just at the
 * service layer, matching this repo's existing convention
 * (`e2e/oauth-pkce-chain.spec.ts`, TRO-597, is the closest precedent for a
 * narrated oauth e2e chain hitting real endpoints, and this file follows its
 * structure closely: browser-driven login/authorize/consent via `page`,
 * then `request` for the backend-to-backend token calls, which is what the
 * real OAuth protocol actually does at that step — never a browser UI
 * action).
 *
 * ── Determinism ──
 *
 * No real sleeps, no timing races: the "stolen" replay is a second, ordinary
 * HTTP call made immediately after the first rotation, not something that
 * depends on wall-clock expiry. (The refresh token's own 30-day TTL is a
 * SEPARATE, already-covered negative case —
 * `token.test.ts`'s "expired refresh_token -> 400 invalid_grant, and is NOT
 * treated as reuse" — deliberately out of scope for this story, which is
 * about REUSE detection, not expiry.)
 *
 * ── Fixture note ──
 *
 * `seedOAuthApp` is duplicated from `e2e/oauth-pkce-chain.spec.ts` rather
 * than imported — same trade-off that file's own header documents for why
 * it duplicates `e2e/oauth-authorize.spec.ts`'s helper of the same shape.
 */
import { test, expect } from './fixtures/isolated-env';
import type { Page } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'crypto';

async function seedOAuthApp(dbUrl: string, redirectUri: string): Promise<{ clientId: string }> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const workspaceResult = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`
    );
    const [workspace] = workspaceResult.rows;
    if (!workspace) throw new Error('seedMinimalTestData should have created a workspace');

    const clientId = `ship_app_e2e_stolen_${crypto.randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'TRO-445 E2E Stolen-Token Client', $2, 'public', $3, $4)`,
      [workspace.id, clientId, [redirectUri], ['documents:read']]
    );
    return { clientId };
  } finally {
    await pool.end();
  }
}

/** RFC 7636 §4.1 pair — identical construction to `token.test.ts`'s and
 * `oauth-pkce-chain.spec.ts`'s own `makePkcePair`. A real (not placeholder)
 * pair is required here: the token exchange below genuinely verifies it. */
function makePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

function requireCode(code: string | null): string {
  if (!code) {
    throw new Error('expected a real authorization `code` query param in the post-consent redirect URL');
  }
  return code;
}

/** Same helper shape as `oauth-pkce-chain.spec.ts`'s `loginAuthorizeAndConsent`
 * — login -> /oauth/authorize -> consent "Authorize" click -> redirect,
 * returning the real `code` captured from the final redirect URL. */
async function loginAuthorizeAndConsent(
  page: Page,
  apiServerUrl: string,
  params: { clientId: string; redirectUri: string; codeChallenge: string; state: string }
): Promise<string> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });

  const authorizeUrl = new URL('/oauth/authorize', apiServerUrl);
  authorizeUrl.searchParams.set('client_id', params.clientId);
  authorizeUrl.searchParams.set('redirect_uri', params.redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', params.codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', 'documents:read');
  authorizeUrl.searchParams.set('state', params.state);

  await page.goto(authorizeUrl.toString());
  await expect(page).toHaveURL(/\/oauth-consent/);

  await page.getByRole('button', { name: 'Authorize' }).click();
  await page.waitForURL(`${params.redirectUri}*`);

  const finalUrl = new URL(page.url());
  expect(finalUrl.searchParams.get('state'), 'state must round-trip unchanged').toBe(params.state);
  return requireCode(finalUrl.searchParams.get('code'));
}

interface TokenSuccessBody {
  access_token: string;
  refresh_token: string;
}

function requireTokenSuccessBody(bodyText: string): TokenSuccessBody {
  const b = JSON.parse(bodyText) as Record<string, unknown>;
  if (typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string') {
    throw new Error(`expected access_token and refresh_token strings, got: ${bodyText}`);
  }
  return { access_token: b.access_token, refresh_token: b.refresh_token };
}

interface TokenErrorBody {
  error: string;
  error_description: string;
}

function requireTokenErrorBody(bodyText: string): TokenErrorBody {
  const b = JSON.parse(bodyText) as Record<string, unknown>;
  if (typeof b.error !== 'string' || typeof b.error_description !== 'string') {
    throw new Error(`expected error and error_description strings, got: ${bodyText}`);
  }
  return { error: b.error, error_description: b.error_description };
}

test.describe('OAuth refresh-rotation stolen-token drill (TRO-445 / PF-800)', () => {
  test.describe.configure({ mode: 'serial' });

  test('rotate -> replay the old refresh token -> family invalidated, active session killed, distinguishable error', async ({
    page,
    request,
    apiServer,
    dbContainer,
    baseURL,
  }) => {
    const redirectUri = `${baseURL}/e2e-oauth-callback`;
    const { clientId } = await seedOAuthApp(dbContainer.getConnectionUri(), redirectUri);
    const { codeVerifier, codeChallenge } = makePkcePair();

    // ── Chapter 1: obtain tokens ──────────────────────────────────────────
    const code = await loginAuthorizeAndConsent(page, apiServer.url, {
      clientId,
      redirectUri,
      codeChallenge,
      state: 'e2e-stolen-token-state',
    });

    const initialTokenRes = await request.post(`${apiServer.url}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      },
    });
    const initialTokenBodyText = await initialTokenRes.text();
    expect(initialTokenRes.status(), initialTokenBodyText).toBe(200);
    const initial = requireTokenSuccessBody(initialTokenBodyText);

    // Sanity: the initial access token genuinely authenticates before any
    // rotation happens.
    const initialMeRes = await request.get(`${apiServer.url}/api/v1/me`, {
      headers: { Authorization: `Bearer ${initial.access_token}` },
    });
    expect(initialMeRes.status()).toBe(200);

    // ── Chapter 2: rotate (the legitimate client refreshing, as normal) ───
    const rotateRes = await request.post(`${apiServer.url}/oauth/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
        client_id: clientId,
      },
    });
    const rotateBodyText = await rotateRes.text();
    expect(rotateRes.status(), rotateBodyText).toBe(200);
    const rotated = requireTokenSuccessBody(rotateBodyText);
    expect(rotated.access_token).not.toBe(initial.access_token);
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);

    // The freshly-rotated access token is the "active session" this drill
    // is about to kill — confirmed working BEFORE the theft is replayed.
    const rotatedMeResBefore = await request.get(`${apiServer.url}/api/v1/me`, {
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    });
    expect(rotatedMeResBefore.status()).toBe(200);

    // ── Chapter 3: reuse the OLD refresh token ─────────────────────────────
    // `initial.refresh_token` was already retired by Chapter 2's rotation.
    // Presenting it again is the stolen-token shape: a value the legitimate
    // client no longer uses, replayed by whoever else has it.
    const reuseRes = await request.post(`${apiServer.url}/oauth/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
        client_id: clientId,
      },
    });
    const reuseBodyText = await reuseRes.text();

    // ── Chapter 4: assert the blast radius ────────────────────────────────

    // A distinguishable error: RFC 6749's `error` enum is closed
    // (`invalid_grant` covers every /oauth/token rejection this codebase
    // produces), so the reuse-specific signal is `error_description` — this
    // exact string, not the "unknown" or "expired" text a different failure
    // would carry. See the sibling vitest file's header for why extending
    // the `error` enum itself is out of this ticket's scope.
    expect(reuseRes.status(), reuseBodyText).toBe(400);
    const reuseError = requireTokenErrorBody(reuseBodyText);
    expect(reuseError.error).toBe('invalid_grant');
    expect(reuseError.error_description).toBe('Refresh token has already been used.');
    expect('access_token' in JSON.parse(reuseBodyText)).toBe(false);

    // Active sessions killed: the child access token that was live and
    // working one HTTP call ago (Chapter 2's rotation) no longer
    // authenticates anything.
    const rotatedMeResAfter = await request.get(`${apiServer.url}/api/v1/me`, {
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    });
    expect(rotatedMeResAfter.status()).toBe(401);

    // Whole family invalidated, not just the replayed row: the legitimate
    // client's own still-in-hand, never-leaked newest refresh token
    // (Chapter 2's) is dead too, forcing a fresh authorization rather than
    // leaving any member of this family usable.
    const legitimateFollowUpRes = await request.post(`${apiServer.url}/oauth/token`, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: rotated.refresh_token,
        client_id: clientId,
      },
    });
    const legitimateFollowUpBodyText = await legitimateFollowUpRes.text();
    expect(legitimateFollowUpRes.status(), legitimateFollowUpBodyText).toBe(400);
    expect(requireTokenErrorBody(legitimateFollowUpBodyText).error).toBe('invalid_grant');
  });
});
