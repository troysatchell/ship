/**
 * PF-404's own AC, verbatim: "device login e2e against local server." Same
 * shape as PF-400's `client.liveServer.test.ts` — a REAL `http` listener
 * wrapping the REAL `createApp()`, driven by the REAL
 * `ShipClient.deviceLogin()`, i.e. a real TCP round trip end to end
 * (`POST /oauth/device/code` -> a real user approving via
 * `decideDeviceCode` -> polling `POST /oauth/token` -> a working
 * `ShipClient`), not anything mocked. See that file's header for the
 * cross-package-import rationale and DB-safety notes, which apply
 * identically here (same file, same worktree database).
 *
 * The one deliberate real wait in this suite: the server enforces a REAL
 * `interval_seconds` throttle against wall-clock time
 * (`api/src/platform/oauth/device.ts`'s `pollDeviceCode` — `last_polled_at`
 * is compared against `Date.now()`/`now()`, not an injectable clock at the
 * HTTP layer). This SDK's own `deviceLogin()` polls once immediately, then
 * waits the server-advertised interval (5s) before polling again — so
 * proving the SECOND poll lands on an already-decided code genuinely takes
 * that ~5s to elapse. Bounded, deliberate, and the only way to prove the
 * REAL server's REAL timing without weakening what's being proven —
 * `deviceLogin.test.ts` (this package's own unit suite) already covers the
 * `slow_down` backoff logic itself with a fully mocked clock/wait; this file
 * is deliberately not a duplicate of that, it's the "does it actually work
 * against the real thing" proof, kept to two cases (approve, deny) to bound
 * the real wall-clock cost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import in this package — see
// `client.liveServer.test.ts`'s header for why this exception exists.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';
import { decideDeviceCode } from '../../../api/src/platform/oauth/device.js';

import { ShipClient } from '../client.js';
import { MemoryTokenStore } from '../tokenStore.js';
import { ShipSdkError } from '../errors.js';

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe('PF-404: ShipClient.deviceLogin() end-to-end against a real running Ship API + the seeded worktree DB', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let userId: string | undefined;
  let clientId: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-404 deviceLogin test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-404 deviceLogin Test User', $2) RETURNING id`,
      [`pf404-devicelogin-${runId}@ship.local`, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    // A public OAuth app — RFC 8628 device clients hold no secret (same
    // posture as `createDeviceCode`'s own header comment).
    clientId = `ship_app_pf404_device_${runId}`;
    await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'PF-404 Device Login Test Client', $2, 'public', '{}', $3)`,
      [workspaceId, clientId, ['documents:read', 'issues:read']]
    );

    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    try {
      if (server) {
        const liveServer = server;
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
    } finally {
      try {
        if (workspaceId) {
          await pool.query(
            'DELETE FROM oauth_tokens WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query(
            'DELETE FROM oauth_device_codes WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [workspaceId]);
        }
        if (userId) {
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);

  it(
    'full RFC 8628 round trip: device code issued -> onUserCode fires -> approved mid-flight -> polling succeeds -> ' +
      'the returned ShipClient works against /api/v1/me, and its tokens (incl. a real refresh token) reach the supplied tokenStore',
    async () => {
      const currentUserId = userId;
      if (!currentUserId) throw new Error('beforeAll should have set userId');

      let capturedUserCode: string | undefined;
      let capturedVerificationUri: string | undefined;
      let sawOnUserCode = false;

      const tokenStore = new MemoryTokenStore();

      const client = await ShipClient.deviceLogin({
        baseUrl,
        clientId,
        tokenStore,
        onUserCode: (userCode, verificationUri) => {
          sawOnUserCode = true;
          capturedUserCode = userCode;
          capturedVerificationUri = verificationUri;

          // Simulates the human: opens `verificationUri`, types `userCode`,
          // clicks Approve. Calling `decideDeviceCode` directly (rather than
          // driving a real browser through the consent UI) mirrors this
          // package's own `client.liveServer.test.ts` precedent of seeding
          // DB-level state directly rather than re-proving a UI flow another
          // ticket's own e2e suite already owns (PF-106's
          // `device.test.ts` covers the approve/deny HTTP endpoint itself).
          // Fires immediately — well before the poller's ~5s second poll —
          // so this test genuinely exercises "poll #1 sees pending, poll #2
          // (after the real interval) sees approved", not an instant
          // same-tick approval.
          void decideDeviceCode({ userCodeInput: userCode, userId: currentUserId, decision: 'approve' });
        },
      });

      expect(sawOnUserCode).toBe(true);
      expect(capturedUserCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(capturedVerificationUri).toContain('/oauth-device-verify');

      const me = await client.me();
      expect(me.user).toEqual(
        expect.objectContaining({ id: userId, email: expect.stringContaining('pf404-devicelogin') })
      );
      expect(me.app).toEqual(expect.objectContaining({ client_id: clientId }));
      expect(me.scopes.slice().sort()).toEqual(['documents:read', 'issues:read']);

      const stored = await tokenStore.get();
      expect(stored).not.toBeNull();
      expect(stored?.accessToken).toBeTruthy();
      expect(stored?.refreshToken).toBeTruthy();
    },
    20_000
  );

  it('a denied device code rejects deviceLogin() with a ShipSdkError, never resolving to a client', async () => {
    const currentUserId = userId;
    if (!currentUserId) throw new Error('beforeAll should have set userId');

    const loginPromise = ShipClient.deviceLogin({
      baseUrl,
      clientId,
      onUserCode: (userCode) => {
        void decideDeviceCode({ userCodeInput: userCode, userId: currentUserId, decision: 'deny' });
      },
    });

    await expect(loginPromise).rejects.toBeInstanceOf(ShipSdkError);
  }, 15_000);
});
