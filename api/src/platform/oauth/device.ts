/**
 * `/oauth/device/*` service logic — RFC 8628 Device Authorization Grant
 * (PF-106, TRO-425, PLUGFORGE.MD §4: "this is `ship login`'s engine").
 *
 * Owns reads/writes against `oauth_device_codes` (migration 043, PF-101;
 * `last_polled_at`/`token_issued_at` added by migration 046, this ticket
 * (originally numbered 045; renumbered because TRO-421/PF-105 independently
 * claimed 045 for its own refresh-rotation migration first) — checked first,
 * per this ticket's own instructions, and neither column existed before). The
 * two route files that call this
 * (`routes/oauth-device.ts` for code issuance + the verify decision,
 * `routes/oauth-token.ts` for the polling branch) are deliberately thin,
 * same split as every other OAuth ticket in this codebase (PF-102/103/104).
 *
 * Reuses PF-104's `token.ts` for the actual token-minting primitives
 * (`generateAccessToken`/`generateRefreshToken`/`hashToken`,
 * `ACCESS_TOKEN_TTL_MS`) and PF-103's `authorize.ts` for app lookup/scope
 * validation (`getOAuthAppByClientId`, `scopesAreRegistered`,
 * `parseScopeParam`) — this is a new "how did the client get authorized"
 * path feeding the same token-minting logic, not a wholesale
 * reimplementation (ticket instruction).
 *
 * ── Time, made injectable (lessons.md rule 17 / this ticket's explicit AC:
 *    "integration test polling to approval with injected clock, no real
 *    waits") ──
 *
 * Every function below that reasons about elapsed time takes an optional
 * `now: () => Date` (default `() => new Date()`), the same shape
 * `utils/circuitBreaker.ts` already uses in this codebase (`now?: () =>
 * number`, defaulting to `Date.now`) for an identical reason: a cooldown/
 * interval check that must be provably testable without a real sleep. The
 * regression suite (`__tests__/device.test.ts`) additionally drives the full
 * HTTP stack with `vi.useFakeTimers({ toFake: ['Date'] })` +
 * `vi.setSystemTime()` (the pattern `routes/change-feed.test.ts` already
 * established for a real supertest+DB integration test) for the paths that
 * go through the Express routes rather than calling these functions
 * directly — both mechanisms exist so either call style is provably
 * time-controlled, never a fixed `setTimeout`/sleep.
 *
 * ── The `slow_down` interval increase is real server state, not just a
 *    returned error code ──
 *
 * RFC 8628 §3.5: "the client MUST increase the interval by 5 seconds for
 * this and all subsequent requests." This module additionally *enforces*
 * that increase server-side (the ticket's own AC: "the interval must
 * ACTUALLY increase server-side... not just return the error") — a poll that
 * arrives before `interval_seconds` have elapsed since the last poll gets
 * `slow_down` AND has `oauth_device_codes.interval_seconds` incremented by
 * `DEVICE_SLOW_DOWN_INCREMENT_SECONDS`, so the NEXT early poll is measured
 * against the new, larger interval. A well-behaved client would never
 * trigger this twice in a row (it already increased its own local interval
 * per the RFC), but a misbehaving/naive one that keeps polling at the
 * original cadence keeps getting pushed back further, rather than being
 * `slow_down`-ed at a fixed, gameable rate forever.
 *
 * ── Why no revoke-on-reuse for a device_code, unlike `token.ts`'s
 *    authorization_code path ──
 *
 * `redeemAuthorizationCode` (`token.ts`) revokes the whole token family when
 * a code is redeemed twice, because RFC 6749 §4.1.2 explicitly calls that
 * out (a reused code strongly suggests the code leaked via the redirect_uri
 * — a network-observable value). RFC 8628 defines no equivalent requirement
 * for `device_code`, and the leak model is different: the device_code is
 * never transmitted through a redirect or a URL a network intermediary would
 * see — the client holds it from the moment `POST /oauth/device/code`
 * returns it, over the same channel it will poll on. A second poll finding
 * `token_issued_at` already set is therefore treated as a client-side bug
 * (double-poll after a success it already received), not a signal of theft,
 * and simply gets `invalid_grant` with no revocation. Extending this to
 * mirror `token.ts`'s revoke-on-reuse would be a small, structurally similar
 * change (a `device_code_id` FK on `oauth_tokens`, mirroring migration 044's
 * `authorization_code_id`) if a future finding decides the stricter posture
 * is worth it — not done here to keep this ticket scoped to the RFC 8628 AC.
 */

import crypto from 'crypto';
import { pool } from '../../db/client.js';
import {
  ACCESS_TOKEN_TTL_MS,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  type TokenGrantResult,
} from './token.js';
import { getOAuthAppByClientId, scopesAreRegistered, parseScopeParam } from './authorize.js';

/** Device codes: chosen at 10 minutes — the same order of magnitude as
 * `authorize.ts`'s `AUTHORIZATION_CODE_TTL_MS` (10 min), but this is a
 * DERIVED-not-specified choice: neither PLUGFORGE.MD §2.2's `oauth_device_codes`
 * row nor the ticket body states a TTL number for this table (unlike auth
 * codes, which are explicitly "10 minutes" in the migration 043 header).
 * RFC 8628 itself only requires the server state *a* value via `expires_in`
 * (§3.2) — 600s is within the RFC's own worked example range (1800s) while
 * staying short enough that a human can plausibly complete "read a code off
 * a screen, open a browser, type it in" without the window feeling
 * indefinite. Stated explicitly here, not left implicit, per this ticket's
 * claim-provenance instructions. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;

/** RFC 8628 §3.2: "the minimum amount of time in seconds that the client
 * SHOULD wait between polling requests... If no value is provided, clients
 * MUST use 5 as the default." Matches `oauth_device_codes.interval_seconds`
 * DEFAULT 5 (migration 043) — stated explicitly per this ticket's
 * instructions ("RFC 8628 default 5s is reasonable — state your choice"). */
export const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 §3.5: "the client MUST increase the interval by 5 seconds." */
export const DEVICE_SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Unambiguous charset: uppercase letters minus `I`/`O`, digits minus
 * `0`/`1` — exactly the four characters the ticket names ("no 0/O/1/I").
 * 32 symbols, 8-character code (`XXXX-XXXX`) -> 32^8 ≈ 1.1 * 10^12 possible
 * codes. No collision-retry loop on insert (same posture as
 * `credentials.ts`'s `generateClientId`, 128 bits of entropy with no retry
 * either): the realistic number of simultaneously PENDING device codes in
 * this app is in the tens, nowhere near where a birthday-bound collision
 * against 10^12 becomes a real risk. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomAlphabetChar(): string {
  const alphabetChar = USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)];
  if (alphabetChar === undefined) {
    // Unreachable: crypto.randomInt(0, N) always returns an index in
    // [0, N). Guards `noUncheckedIndexedAccess` without an `as string`
    // (lessons.md RULE-16).
    throw new Error('user-code alphabet indexing produced no character');
  }
  return alphabetChar;
}

/** Human-typable, e.g. `BDWJ-KXQT` (the ticket's own example format). */
export function generateUserCode(): string {
  const part = (length: number): string =>
    Array.from({ length }, () => randomAlphabetChar()).join('');
  return `${part(4)}-${part(4)}`;
}

/** Uppercases and strips everything but the alphabet characters, then
 * re-inserts the canonical `XXXX-XXXX` hyphen — so a user who types
 * lowercase, omits the hyphen, or pastes stray whitespace still matches the
 * stored code. Returns `null` when normalization can't produce an 8-char
 * code (too short/long/wrong charset after stripping) — callers treat that
 * as "unknown code" rather than querying with a value that could never
 * match. */
export function normalizeUserCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== 8) return null;
  for (const char of stripped) {
    if (!USER_CODE_ALPHABET.includes(char)) return null;
  }
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/** Long-lived secret the polling client holds — same shape/entropy as
 * `authorize.ts`'s `generateAuthorizationCode` (32 random bytes, hex,
 * unprefixed: short-lived-relative-to-a-refresh-token, never displayed to a
 * human, no reason to be identifiable at a glance). */
function generateDeviceCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashDeviceCode(raw: string): string {
  return hashToken(raw);
}

export interface CreateDeviceCodeParams {
  clientId: string;
  scope: string | undefined;
  now?: () => Date;
}

export type CreateDeviceCodeResult =
  | {
      ok: true;
      deviceCode: string;
      userCode: string;
      scopes: string[];
      expiresIn: number;
      interval: number;
    }
  | { ok: false; error: 'invalid_client' | 'invalid_scope'; errorDescription: string };

/** `POST /oauth/device/code` — RFC 8628 §3.1/§3.2. No client secret is
 * checked (device-flow clients are, per RFC 8628 §1, inherently unable to
 * hold one safely — `ship login`'s CLI is exactly this shape, PLUGFORGE.MD
 * §4 PF-600); the app still has to exist, be unrevoked, and have every
 * requested scope actually registered — same posture `authorize.ts`'s
 * `validateAuthorizeRequest` already applies to `GET /oauth/authorize`. */
export async function createDeviceCode(params: CreateDeviceCodeParams): Promise<CreateDeviceCodeResult> {
  const app = await getOAuthAppByClientId(params.clientId);
  if (!app) {
    return { ok: false, error: 'invalid_client', errorDescription: 'Unknown or revoked client_id.' };
  }

  const requestedScopes = parseScopeParam(params.scope);
  if (requestedScopes.length > 0 && !scopesAreRegistered(app, requestedScopes)) {
    return {
      ok: false,
      error: 'invalid_scope',
      errorDescription: 'Requested scope exceeds what this application registered.',
    };
  }
  const scopes = requestedScopes.length > 0 ? requestedScopes : app.requested_scopes;

  const now = params.now ?? (() => new Date());
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const expiresAt = new Date(now().getTime() + DEVICE_CODE_TTL_MS);

  await pool.query(
    `INSERT INTO oauth_device_codes
       (device_code_hash, user_code, app_id, scopes, interval_seconds, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashDeviceCode(deviceCode), userCode, app.id, scopes, DEFAULT_DEVICE_POLL_INTERVAL_SECONDS, expiresAt]
  );

  return {
    ok: true,
    deviceCode,
    userCode,
    scopes,
    expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
  };
}

/** Row shape for `oauth_device_codes` (migration 043 + 046) — RULE-21
 * (lessons.md §21): `pool.query` rows are `any` unless given an explicit
 * interface. */
interface DeviceCodeRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  app_id: string;
  scopes: string[];
  interval_seconds: number;
  expires_at: Date;
  user_id: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  last_polled_at: Date | null;
  token_issued_at: Date | null;
}

const DEVICE_CODE_COLUMNS = `id, device_code_hash, user_code, app_id, scopes, interval_seconds,
       expires_at, user_id, status, last_polled_at, token_issued_at`;

async function lookupDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `SELECT ${DEVICE_CODE_COLUMNS} FROM oauth_device_codes WHERE user_code = $1`,
    [userCode]
  );
  return result.rows[0] ?? null;
}

async function lookupDeviceCodeByHash(deviceCodeHash: string): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `SELECT ${DEVICE_CODE_COLUMNS} FROM oauth_device_codes WHERE device_code_hash = $1`,
    [deviceCodeHash]
  );
  return result.rows[0] ?? null;
}

/** Lazily transitions a still-'pending' row to 'expired' once its
 * `expires_at` has passed — same lazy-transition shape migration 043's own
 * header comment describes. Idempotent (`WHERE status = 'pending'`): a
 * second caller finding it already flipped just does nothing. Returns
 * `true` when the row is expired (whether this call flipped it or it was
 * already flipped/otherwise decided-but-past-expiry), matching the
 * ticket-stated rule that `expires_at` is the deadline for the WHOLE flow —
 * an already-'approved' row past its `expires_at` is still reported as
 * expired to the polling client (the exchange window closed, even though a
 * human did act in time). */
async function expireIfPast(row: DeviceCodeRow, nowMs: number): Promise<boolean> {
  if (row.expires_at.getTime() >= nowMs) return false;
  if (row.status === 'pending') {
    await pool.query(
      `UPDATE oauth_device_codes SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
      [row.id]
    );
  }
  return true;
}

export interface DecideDeviceCodeParams {
  userCodeInput: string;
  userId: string;
  decision: 'approve' | 'deny';
  now?: () => Date;
}

export type DecideDeviceCodeResult =
  | { ok: true; decision: 'approve' | 'deny' }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_decided' };

/** The verify page's Approve/Deny submission (`POST /oauth/device/verify`).
 * Atomic per decision (`UPDATE ... WHERE status = 'pending' RETURNING id`) —
 * two concurrent decisions on the same code (a genuine double-submit, or a
 * second browser tab) can only have one of them actually apply; the loser
 * gets `already_decided`, never a silently-overwritten decision. */
export async function decideDeviceCode(params: DecideDeviceCodeParams): Promise<DecideDeviceCodeResult> {
  const userCode = normalizeUserCode(params.userCodeInput);
  if (!userCode) return { ok: false, reason: 'not_found' };

  const row = await lookupDeviceCodeByUserCode(userCode);
  if (!row) return { ok: false, reason: 'not_found' };

  const now = params.now ?? (() => new Date());
  const nowMs = now().getTime();

  if (await expireIfPast(row, nowMs)) {
    return { ok: false, reason: 'expired' };
  }

  if (row.status !== 'pending') {
    return { ok: false, reason: 'already_decided' };
  }

  const newStatus = params.decision === 'approve' ? 'approved' : 'denied';
  const result = await pool.query<{ id: string }>(
    `UPDATE oauth_device_codes SET status = $1, user_id = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING id`,
    [newStatus, params.userId, row.id]
  );

  if (result.rows.length === 0) {
    // Lost a race against a concurrent decision on the same row.
    return { ok: false, reason: 'already_decided' };
  }

  return { ok: true, decision: params.decision };
}

export interface PollDeviceCodeParams {
  deviceCode: string;
  now?: () => Date;
}

function invalidGrant(description: string): TokenGrantResult {
  return { ok: false, status: 400, error: 'invalid_grant', errorDescription: description };
}

/**
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code` — the polling
 * branch of `POST /oauth/token` (RFC 8628 §3.4/§3.5). Check order, each
 * terminal except the last two:
 *   1. Unknown device_code -> `invalid_grant`.
 *   2. Past `expires_at` -> `expired_token` (flips 'pending' to 'expired').
 *   3. `status === 'denied'` -> `access_denied`.
 *   4. Already redeemed (`token_issued_at` set) -> `invalid_grant` (see
 *      module header for why this doesn't revoke, unlike `token.ts`'s
 *      authorization_code reuse path).
 *   5. Polled again before `interval_seconds` elapsed since the last poll
 *      -> `slow_down`, AND `interval_seconds` is incremented by
 *      `DEVICE_SLOW_DOWN_INCREMENT_SECONDS` server-side (the ticket's own
 *      AC: this must be real, not just the returned error code).
 *   6. `status === 'pending'` -> `authorization_pending`.
 *   7. `status === 'approved'` (and not yet redeemed, not throttled) ->
 *      mints and returns a real token pair, same shape
 *      `redeemAuthorizationCode` returns, via an atomic
 *      `UPDATE ... WHERE token_issued_at IS NULL RETURNING ...` claim so two
 *      concurrent polls after approval can mint at most one token pair
 *      (same single-writer-wins shape as `token.ts`'s `consumed_at` claim).
 */
export async function pollDeviceCode(params: PollDeviceCodeParams): Promise<TokenGrantResult> {
  const deviceCodeHash = hashDeviceCode(params.deviceCode);
  const row = await lookupDeviceCodeByHash(deviceCodeHash);

  if (!row) {
    return invalidGrant('device_code is unknown or invalid.');
  }

  const now = params.now ?? (() => new Date());
  const nowMs = now().getTime();

  if (await expireIfPast(row, nowMs)) {
    return { ok: false, status: 400, error: 'expired_token', errorDescription: 'The device code has expired.' };
  }

  if (row.status === 'denied') {
    return { ok: false, status: 400, error: 'access_denied', errorDescription: 'The user denied the request.' };
  }

  if (row.status === 'approved' && row.token_issued_at !== null) {
    return invalidGrant('device_code has already been redeemed.');
  }

  // Throttle: applies to every still-actionable poll (pending, or approved
  // but not yet redeemed) — terminal states above already returned.
  if (row.last_polled_at !== null) {
    const elapsedMs = nowMs - row.last_polled_at.getTime();
    if (elapsedMs < row.interval_seconds * 1000) {
      const newInterval = row.interval_seconds + DEVICE_SLOW_DOWN_INCREMENT_SECONDS;
      await pool.query(
        `UPDATE oauth_device_codes SET interval_seconds = $1, last_polled_at = $2 WHERE id = $3`,
        [newInterval, now(), row.id]
      );
      return {
        ok: false,
        status: 400,
        error: 'slow_down',
        errorDescription: `Polled before the ${row.interval_seconds}s interval elapsed; interval is now ${newInterval}s.`,
      };
    }
  }

  if (row.status === 'pending') {
    await pool.query(`UPDATE oauth_device_codes SET last_polled_at = $1 WHERE id = $2`, [now(), row.id]);
    return {
      ok: false,
      status: 400,
      error: 'authorization_pending',
      errorDescription: 'The user has not yet completed authorization.',
    };
  }

  // row.status === 'approved' && row.token_issued_at === null: the
  // redemption poll. Atomic claim first — the SELECT above could already be
  // stale against a concurrent redeemer (same "read a snapshot, decide at
  // the UPDATE" shape token.ts's own header documents for authorization
  // codes).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claim = await client.query<{ id: string; user_id: string | null }>(
      `UPDATE oauth_device_codes SET token_issued_at = $1, last_polled_at = $1
       WHERE id = $2 AND token_issued_at IS NULL
       RETURNING id, user_id`,
      [now(), row.id]
    );

    const claimedRow = claim.rows[0];
    if (!claimedRow) {
      // Lost the race: another poll already redeemed this code.
      await client.query('ROLLBACK');
      return invalidGrant('device_code has already been redeemed.');
    }

    if (claimedRow.user_id === null) {
      // Structurally shouldn't happen — `decideDeviceCode` always sets
      // user_id in the same UPDATE that sets status = 'approved' — but
      // guarded rather than assumed (lessons.md RULE-16: no `!`/`as`).
      await client.query('ROLLBACK');
      throw new Error('oauth_device_codes row is approved with no user_id');
    }

    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(nowMs + ACCESS_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO oauth_tokens (app_id, user_id, scopes, access_token_hash, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.app_id, claimedRow.user_id, row.scopes, hashToken(accessToken), hashToken(refreshToken), expiresAt]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      accessToken,
      refreshToken,
      scopes: row.scopes,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
