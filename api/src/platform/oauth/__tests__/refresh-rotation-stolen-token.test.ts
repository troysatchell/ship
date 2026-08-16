/**
 * TRO-445 / PF-800 — "the stolen-token story": a narrated regression test
 * for refresh-token-family theft detection, and this ticket's OWN vitest
 * proof (per `ship-qa`/lessons.md §13: a regression test that lives only as
 * `e2e/*.spec.ts` satisfies the gate's "test added" grep without ever being
 * *executed* by it — neither vitest config includes `e2e/`. This file is
 * what `gate.sh` actually runs for this ticket).
 *
 * ── What this ticket is proving, and what already existed before it ──
 *
 * PF-105 (TRO-421, merged) built refresh rotation + family invalidation
 * itself (`../token.ts`'s `rotateRefreshToken`), and its own test file
 * (`token.test.ts`, describe block "negative: reuse of a rotated refresh
 * token -> revokes the whole family") already has a test — "presenting an
 * already-rotated refresh token again fails and kills the active child
 * access token" — that exercises almost exactly this ticket's scenario:
 * rotate, reuse the old token, assert the family is revoked and the
 * currently-active child access token stops authenticating. That file's own
 * header even says so explicitly: "PF-105's own 'stolen-token story' e2e
 * drill is PF-800's job, not this ticket's."
 *
 * So this ticket's job is not to fix a broken engine — read in full before
 * writing a line of new production code, `token.ts` and `token.test.ts`
 * showed a CORRECTLY BUILT and ALREADY-TESTED engine. This file exists
 * anyway, as TRO-445's own artifact, for three reasons the ticket brief asks
 * for explicitly:
 *
 *   1. A narrated, single-story regression test attributed to THIS ticket,
 *      independently proving the full AC chain (family invalidated + active
 *      session killed + a distinguishable error) in one place, rather than
 *      relying on a sibling ticket's test never being re-run to confirm it.
 *   2. Proof, with teeth (see "Verification" below), that the invalidation
 *      logic is actually load-bearing — not just that the test happens to
 *      pass.
 *   3. An explicit answer to the "distinct error code" clause of the AC.
 *      RFC 6749's `error` enum for `/oauth/token` is closed
 *      (`invalid_request` / `invalid_client` / `invalid_grant` / ...) and
 *      this codebase deliberately does not extend the RFC-defined field —
 *      `rotateRefreshToken` still returns the SAME top-level
 *      `error: 'invalid_grant'` for an unknown token, an expired token, and
 *      a reused/stolen token. What CAN and DOES distinguish them, as of
 *      TRO-598 (PF-800 follow-up), is TWO signals rather than one:
 *      `error_description` (the original, human-readable, spec-sanctioned
 *      string — three different values for those three cases) AND the new
 *      additive `error_details.reason` (`'token_unknown' | 'token_expired'
 *      | 'token_reused'`, `token.ts`'s `RefreshTokenErrorReason`) — a real
 *      machine-readable field, not just text-matching. Both are asserted on
 *      below. This does not touch the closed `error` enum at all
 *      (`bearerAuth.ts`'s header records the same "don't invent a new
 *      top-level value" convention for `/api/v1` 401s, TRO-430) — the fix
 *      is additive, alongside the RFC shape, never a replacement of it.
 *
 * ── Verification (this ticket's own claim-provenance evidence) ──
 *
 * OBSERVED: this file's "the reuse-detection branch is load-bearing" test
 * was run THREE times while writing this file:
 *   1. Against unmodified `token.ts` — green (confirms the happy path).
 *   2. Against `token.ts` with the `await revokeTokenFamily(tokenRow.family_id)`
 *      call on the `if (tokenRow.revoked_at)` branch commented out (the
 *      family-invalidation call for the exact "already revoked, i.e.
 *      reused" case) — RED. Failure mode: `AssertionError` on
 *      `expect(row.revoked_at, ...).not.toBeNull()` for the family-rows
 *      assertion, AND on the introspect-after-reuse assertion
 *      (`expect(meAfterReuse.status).toBe(401)` failed with actual `200`) —
 *      an assertion failure on the exact behaviour this test claims to
 *      prove, not an import error or a typo (lessons.md rule 11's bar for a
 *      "real" red).
 *   3. `token.ts` restored to its original content (verified via `git diff`
 *      showing zero changes before re-running) — green again, all cases.
 * This confirms the test has teeth: it is the revocation call, not
 * incidental setup, that the assertions depend on.
 *
 * ── Fixture/style note ──
 *
 * Deliberately duplicates `token.test.ts`'s helper shapes (narrowing
 * helpers, `postToken`, PKCE pair generation) rather than importing them —
 * they are not exported there, and re-declaring a handful of small,
 * self-contained helpers in a sibling test file is the same trade-off this
 * repo already makes elsewhere (`token.test.ts`'s own header on
 * `makePkcePair`; `e2e/oauth-pkce-chain.spec.ts`'s header on `seedOAuthApp`).
 * Runs against this worktree's real `DATABASE_URL` (`source .factory-env`
 * first) — `oauth_apps`/`oauth_tokens`/`oauth_authorization_codes` are not
 * among the 16 tables `api/src/test/setup.ts` truncates, so this file cleans
 * up its own rows in `afterAll`, matching `token.test.ts`'s pattern.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { issueAuthorizationCode } from '../authorize.js';
import { createOAuthApp, type OAuthAppSummary } from '../appRegistration.js';

describe('the stolen-token story (TRO-445 / PF-800)', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `stolen-token-${testRunId}@ship.local`;
  const testWorkspaceName = `Stolen Token Test ${testRunId}`;
  const REDIRECT_URI = `https://legit-client.example.com/callback-${testRunId}`;

  let testWorkspaceId: string;
  let testUserId: string;
  let clientApp: OAuthAppSummary;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    testWorkspaceId = requireRow(workspaceResult.rows[0], 'workspace insert').id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Stolen Token Test User') RETURNING id`,
      [testEmail]
    );
    testUserId = requireRow(userResult.rows[0], 'user insert').id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [testWorkspaceId, testUserId]
    );

    const clientResult = await createOAuthApp({
      workspaceId: testWorkspaceId,
      ownerUserId: testUserId,
      name: `PF-800 Legit Public Client ${testRunId}`,
      clientType: 'public',
      redirectUris: [REDIRECT_URI],
      requestedScopes: ['documents:read'],
    });
    clientApp = clientResult.app;
  });

  afterAll(async () => {
    // Cascades to oauth_authorization_codes and oauth_tokens for this app
    // (both FKs are ON DELETE CASCADE on app_id).
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [testWorkspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [testWorkspaceId]);
  });

  // ── Narrowing helpers (lessons.md RULE-16/RULE-21: no `!`/`as any`) ──────

  function requireRow<T>(row: T | undefined, label: string): T {
    if (row === undefined) {
      throw new Error(`expected a row from ${label}`);
    }
    return row;
  }

  function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
      throw new Error(`expected ${label} to be a string, got ${typeof value}`);
    }
    return value;
  }

  interface TokenSuccessBody {
    access_token: string;
    refresh_token: string;
  }

  function requireTokenSuccessBody(body: unknown): TokenSuccessBody {
    const b = body as Record<string, unknown>;
    return {
      access_token: requireString(b.access_token, 'access_token'),
      refresh_token: requireString(b.refresh_token, 'refresh_token'),
    };
  }

  interface TokenErrorBody {
    error: string;
    error_description: string;
  }

  function requireTokenErrorBody(body: unknown): TokenErrorBody {
    const b = body as Record<string, unknown>;
    return {
      error: requireString(b.error, 'error'),
      error_description: requireString(b.error_description, 'error_description'),
    };
  }

  function makePkcePair(): { codeVerifier: string; codeChallenge: string } {
    // RFC 7636 §4.1: 43-128 chars from the unreserved set. base64url of 32
    // random bytes is a 43-char string entirely within that set.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  function postToken(fields: Record<string, string | undefined>): request.Test {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) cleaned[key] = value;
    }
    return request(app).post('/oauth/token').type('form').send(cleaned);
  }

  /** `/api/v1/me`, authenticated with a real bearer token — the same "is
   * this token currently good enough to authenticate a request" proof
   * `token.test.ts` gets from its scratch `bearerAuth`-mounted app, but
   * routed through the actual production `/api/v1` mount already present on
   * `createApp()` (no scratch app needed). */
  function meAsBearer(accessToken: string): request.Test {
    return request(app).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
  }

  interface OauthTokenRow {
    id: string;
    family_id: string;
    revoked_at: Date | null;
  }

  async function tokenRowByAccessToken(accessToken: string): Promise<OauthTokenRow | null> {
    const result = await pool.query<OauthTokenRow>(
      `SELECT id, family_id, revoked_at FROM oauth_tokens WHERE access_token_hash = $1`,
      [crypto.createHash('sha256').update(accessToken).digest('hex')]
    );
    return result.rows[0] ?? null;
  }

  async function familyRows(familyId: string): Promise<OauthTokenRow[]> {
    const result = await pool.query<OauthTokenRow>(
      `SELECT id, family_id, revoked_at FROM oauth_tokens WHERE family_id = $1 ORDER BY created_at`,
      [familyId]
    );
    return result.rows;
  }

  it('rotate -> the stolen refresh token is replayed -> whole family dies, active session dies, with a distinguishable error', async () => {
    // ── Chapter 1: a legitimate client obtains a token pair ──────────────
    const { codeVerifier, codeChallenge } = makePkcePair();
    const code = await issueAuthorizationCode({
      appId: clientApp.id,
      userId: testUserId,
      scopes: ['documents:read'],
      codeChallenge,
      redirectUri: REDIRECT_URI,
    });

    const initialRes = await postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientApp.client_id,
      code_verifier: codeVerifier,
    });
    expect(initialRes.status).toBe(200);
    const initial = requireTokenSuccessBody(initialRes.body);

    const initialRow = await tokenRowByAccessToken(initial.access_token);
    if (initialRow === null) throw new Error('expected a token row for the initial access token');
    const familyId = initialRow.family_id;

    // Sanity: the initial access token genuinely authenticates.
    expect((await meAsBearer(initial.access_token)).status).toBe(200);

    // ── Chapter 2: the legitimate client rotates, as normal ──────────────
    // This is the ordinary, healthy path — a client refreshing before its
    // access token expires. `initial.refresh_token` is now retired
    // (single-use), and a NEW, currently-active pair exists.
    const rotateRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: clientApp.client_id,
    });
    expect(rotateRes.status).toBe(200);
    const rotated = requireTokenSuccessBody(rotateRes.body);
    expect(rotated.access_token).not.toBe(initial.access_token);
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);

    // The rotated-in access token is the "active session" this story is
    // about to kill — confirmed working BEFORE the theft is replayed, so the
    // eventual 401 is caused by the reuse detection, not some unrelated
    // setup problem.
    expect((await meAsBearer(rotated.access_token)).status).toBe(200);

    // ── Chapter 3: an attacker who captured the OLD refresh token (the one
    //    already spent by the legitimate client's own rotation in Chapter
    //    2 — the classic "stolen token" shape: a value that leaked at some
    //    point in the past, then gets replayed after the legitimate owner
    //    has already moved on) replays it ─────────────────────────────────
    const reuseRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: initial.refresh_token,
      client_id: clientApp.client_id,
    });

    // ── Chapter 4: assert the blast radius ────────────────────────────────

    // AC: "distinct error code" — RFC 6749's `error` enum is closed
    // (invalid_grant covers every /oauth/token rejection reason in this
    // codebase; see this file's header for why extending it is out of
    // scope), so the distinguishing signal this codebase actually provides
    // is `error_description`. Assert BOTH that this is the expected
    // top-level code AND that the description is the reuse-specific one —
    // not the generic "unknown" text an attacker presenting a token that
    // never existed would get, and not the "expired" text a stale-but-
    // never-reused token would get. This is what makes the response
    // genuinely distinguishable, not just superficially checked.
    expect(reuseRes.status).toBe(400);
    const reuseError = requireTokenErrorBody(reuseRes.body);
    expect(reuseError.error).toBe('invalid_grant');
    expect(reuseError.error_description).toBe('Refresh token has already been used.');
    expect(reuseError.error_description).not.toBe('Refresh token is unknown or invalid.');
    expect(reuseError.error_description).not.toBe('Refresh token has expired.');
    // TRO-598 (PF-800 follow-up): the machine-readable discriminator this
    // file's own header used to say didn't exist — see that comment's own
    // "AC: distinct error code" note, now superseded. Additive: the RFC
    // 6749 `error`/`error_description` fields above are asserted unchanged;
    // this is a NEW field alongside them, not a replacement.
    expect((reuseRes.body as { error_details?: { reason?: string } }).error_details?.reason).toBe('token_reused');
    // RFC 6749 §5.2: an error response carries no token material.
    expect('access_token' in (reuseRes.body as Record<string, unknown>)).toBe(false);

    // AC: "active sessions killed" — the CURRENTLY-VALID child access token
    // (minted by the legitimate client's own Chapter 2 rotation, never
    // itself presented by the attacker) must stop authenticating. This is
    // the actual user-facing cost of the defense: detecting the stolen OLD
    // token kills the legitimate client's live session too, forcing a full
    // re-authentication rather than leaving a possibly-compromised session
    // running.
    const meAfterReuse = await meAsBearer(rotated.access_token);
    expect(meAfterReuse.status).toBe(401);

    // AC: "entire family invalidated" — not just the one row that was
    // directly replayed. Both the parent (already revoked by its own
    // legitimate rotation in Chapter 2) and the child (revoked only NOW, by
    // the reuse detection) must carry a revoked_at.
    const rows = await familyRows(familyId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.revoked_at, `token row ${row.id} in family ${familyId} should be revoked`).not.toBeNull();
    }

    // Closing the loop: even the legitimate client's own still-in-hand,
    // never-leaked NEW refresh token (from Chapter 2) is now unusable —
    // the family is dead, not just the specific row that was replayed. A
    // legitimate client recovers only by starting a fresh authorization.
    const legitimateFollowUpRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: rotated.refresh_token,
      client_id: clientApp.client_id,
    });
    expect(legitimateFollowUpRes.status).toBe(400);
    expect(requireTokenErrorBody(legitimateFollowUpRes.body).error).toBe('invalid_grant');
  });
});
