/**
 * `ShipClient.clientCredentials()` (PF-702, TRO-428) against a REAL running
 * Ship API + a REAL confidential OAuth app — genuine TCP round trip, not a
 * mocked `fetch`. Same technique and same "one deliberate cross-package
 * import" exception as `client.liveServer.test.ts` (read that file's header
 * first) and `resources.liveServer.test.ts`.
 *
 * DB SAFETY: creates its own isolated workspace/user/app rows in `beforeAll`
 * and deletes them in `afterAll` — does not touch `pnpm db:seed`'s fixtures
 * or `ship_app_fleetgraph` itself (a fresh, ticket-scoped confidential app is
 * created here instead, same pattern `token.test.ts` uses for its own
 * `client_credentials` grant tests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import in this package — see this file's
// header, and client.liveServer.test.ts's own header, for why.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';
import { createOAuthApp } from '../../../api/src/platform/oauth/appRegistration.js';

import { ShipClient } from '../client.js';
import { ShipSdkError } from '../errors.js';

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe('PF-702: ShipClient.clientCredentials() against a real running Ship API', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let userId: string | undefined;
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-702 sdk clientCredentials test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const userEmail = `pf702-sdk-cc-${runId}@ship.local`;
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-702 SDK ClientCredentials Test User', $2) RETURNING id`,
      [userEmail, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    const created = await createOAuthApp({
      workspaceId,
      ownerUserId: userId,
      name: `PF-702 sdk cc test app ${runId}`,
      clientType: 'confidential',
      requestedScopes: ['documents:read', 'issues:read'],
    });
    clientId = created.app.client_id;
    if (!created.clientSecret) throw new Error('confidential app creation did not return a client secret');
    clientSecret = created.clientSecret;

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
          await pool.query('DELETE FROM oauth_tokens WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)', [workspaceId]);
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

  it('mints a real app-identity token and a real /api/v1/me call resolves user: null, app: populated', async () => {
    const client = await ShipClient.clientCredentials({
      baseUrl,
      clientId,
      clientSecret,
      scope: 'documents:read',
    });

    const me = await client.me();

    expect(me.user).toBeNull();
    expect(me.app?.client_id).toBe(clientId);
    expect(me.scopes).toEqual(['documents:read']);
  });

  it('a wrong client secret maps to a ShipSdkError with kind "auth"', async () => {
    await expect(
      ShipClient.clientCredentials({ baseUrl, clientId, clientSecret: 'definitely-wrong' })
    ).rejects.toBeInstanceOf(ShipSdkError);
    await expect(
      ShipClient.clientCredentials({ baseUrl, clientId, clientSecret: 'definitely-wrong' })
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('the minted token can actually read through a real resource client (documents.list)', async () => {
    const client = await ShipClient.clientCredentials({ baseUrl, clientId, clientSecret, scope: 'documents:read' });

    const page = await client.documents.list({ limit: 5 });

    expect(Array.isArray(page.data)).toBe(true);
  });
});
