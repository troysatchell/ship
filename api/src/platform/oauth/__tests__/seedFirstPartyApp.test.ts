/**
 * Regression suite for TRO-423 / PF-701 (seed first-party OAuth app
 * `ship_app_fleetgraph`).
 *
 * Test design source: Linear TRO-423 comment "Test design (pre-implementation
 * — ship-test-designer, 2026-08-10)". AC-1 covers the seed itself
 * (idempotency, shape, hashing, throw-on-missing-secret); AC-2 covers the
 * full `client_credentials` -> `/api/v1/me` proof the PRD's own AC sentence
 * names. Both are in scope here, unlike PF-907's sibling test (which scoped
 * AC-2-equivalent work out) — PF-104's `/oauth/token` and PF-201's
 * `/api/v1/me` are both already merged on `main` as of this ticket, so the
 * full path is real and testable, not stubbed.
 *
 * Placement matches the test design's suggested path exactly:
 * `api/src/platform/oauth/__tests__/seedFirstPartyApp.test.ts` — same
 * "utility tests live in `__tests__/` next to the util" convention
 * `seedGraderApp.test.ts` already follows in this directory.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import {
  seedFirstPartyApp,
  FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR,
  FLEETGRAPH_CLIENT_ID,
  FLEETGRAPH_APP_NAME,
  FLEETGRAPH_APP_SCOPES,
} from '../seedFirstPartyApp.js';

/** Destructure-and-assert instead of a non-null assertion (lessons.md rule 16 /
 * G7b): under `noUncheckedIndexedAccess`, `rows[0]` is `T | undefined`. */
function firstRowOrThrow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${context}: expected at least one row, got none`);
  }
  return row;
}

async function deleteFleetgraphApp(): Promise<void> {
  await pool.query(`DELETE FROM oauth_apps WHERE client_id = $1`, [FLEETGRAPH_CLIENT_ID]);
}

describe('seedFirstPartyApp (PF-701 / TRO-423)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testWorkspaceName = `FleetGraph Seed Test ${testRunId}`;
  const testSecret = `test-fleetgraph-secret-${testRunId}`;

  let workspaceId: string;
  let originalEnvValue: string | undefined;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    workspaceId = firstRowOrThrow(workspaceResult.rows, 'insert workspace').id;

    originalEnvValue = process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR];
  });

  afterAll(async () => {
    await deleteFleetgraphApp();
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);

    if (originalEnvValue === undefined) {
      delete process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR];
    } else {
      process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = originalEnvValue;
    }
  });

  describe('AC-1: idempotent boot/migration seed', () => {
    beforeAll(async () => {
      // Fixed client_id (module design point 1) means every test in this
      // file shares one row — clear it before this block's own assertions
      // so an earlier describe block's row (if vitest ever reorders) can't
      // mask a real bug.
      await deleteFleetgraphApp();
      process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = testSecret;
    });

    it('seeding twice in sequence produces exactly one oauth_apps row (idempotent)', async () => {
      const first = await seedFirstPartyApp(pool, workspaceId);
      expect(first.status).toBe('created');
      expect(first.clientId).toBe(FLEETGRAPH_CLIENT_ID);

      const second = await seedFirstPartyApp(pool, workspaceId);
      expect(second.status).toBe('exists');
      expect(second.clientId).toBe(FLEETGRAPH_CLIENT_ID);

      const rows = await pool.query(`SELECT * FROM oauth_apps WHERE client_id = $1`, [
        FLEETGRAPH_CLIENT_ID,
      ]);
      expect(rows.rows).toHaveLength(1);
    });

    it('concurrent seed calls converge to exactly one oauth_apps row (DB-enforced idempotency)', async () => {
      await deleteFleetgraphApp();

      const [a, b] = await Promise.all([
        seedFirstPartyApp(pool, workspaceId),
        seedFirstPartyApp(pool, workspaceId),
      ]);

      // Same reasoning as seedGraderApp.test.ts: the unique index on
      // oauth_apps.client_id is the real guarantee under a race, not the
      // SELECT-then-INSERT fast path. Both calls can legitimately report
      // 'created' if the loser's ON CONFLICT DO NOTHING affects 0 rows.
      expect(a.clientId).toBe(FLEETGRAPH_CLIENT_ID);
      expect(b.clientId).toBe(FLEETGRAPH_CLIENT_ID);

      const rows = await pool.query(`SELECT * FROM oauth_apps WHERE client_id = $1`, [
        FLEETGRAPH_CLIENT_ID,
      ]);
      expect(rows.rows).toHaveLength(1);
    });

    it('the seeded row is first-party, confidential, client_id ship_app_fleetgraph, exactly the read-only scopes', async () => {
      await deleteFleetgraphApp();
      await seedFirstPartyApp(pool, workspaceId);

      const result = await pool.query<{
        client_id: string;
        name: string;
        is_first_party: boolean;
        client_type: string;
        requested_scopes: string[];
      }>(
        `SELECT client_id, name, is_first_party, client_type, requested_scopes
         FROM oauth_apps WHERE client_id = $1`,
        [FLEETGRAPH_CLIENT_ID]
      );
      const row = firstRowOrThrow(result.rows, 'select fleetgraph oauth_apps row');

      expect(row.client_id).toBe('ship_app_fleetgraph');
      expect(row.client_id.startsWith('ship_app_')).toBe(true);
      expect(row.name).toBe(FLEETGRAPH_APP_NAME);
      expect(row.is_first_party).toBe(true);
      expect(row.client_type).toBe('confidential');

      const scopes = row.requested_scopes;
      expect(scopes).toEqual(expect.arrayContaining([...FLEETGRAPH_APP_SCOPES]));
      expect(scopes).toHaveLength(FLEETGRAPH_APP_SCOPES.length);
      expect(scopes.some((s) => s.endsWith(':write'))).toBe(false);
      expect(scopes).not.toContain('webhooks:manage');
    });

    it('client_secret_hash is a SHA-256 hex digest, not the raw secret', async () => {
      await deleteFleetgraphApp();
      await seedFirstPartyApp(pool, workspaceId);

      const result = await pool.query<{ client_secret_hash: string | null }>(
        `SELECT client_secret_hash FROM oauth_apps WHERE client_id = $1`,
        [FLEETGRAPH_CLIENT_ID]
      );
      const hash = result.rows[0]?.client_secret_hash;
      expect(typeof hash).toBe('string');
      expect(hash).not.toBe(testSecret);

      const expectedHash = crypto.createHash('sha256').update(testSecret).digest('hex');
      expect(hash).toBe(expectedHash);
    });

    it('the raw secret is read via the module-exported env-var-name constant, never a hardcoded literal', async () => {
      expect(FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR).toBe('FLEETGRAPH_OAUTH_CLIENT_SECRET');

      await deleteFleetgraphApp();
      const distinctSecret = `${testSecret}-distinct`;
      process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = distinctSecret;
      try {
        const result = await seedFirstPartyApp(pool, workspaceId);
        expect(result.status).toBe('created');

        const row = await pool.query<{ client_secret_hash: string }>(
          `SELECT client_secret_hash FROM oauth_apps WHERE client_id = $1`,
          [FLEETGRAPH_CLIENT_ID]
        );
        const expectedHash = crypto.createHash('sha256').update(distinctSecret).digest('hex');
        expect(firstRowOrThrow(row.rows, 'select fleetgraph client_secret_hash').client_secret_hash).toBe(
          expectedHash
        );
      } finally {
        process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = testSecret;
      }
    });

    it('with the env var unset, throws rather than falling back to a hardcoded default secret', async () => {
      await deleteFleetgraphApp();
      delete process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR];

      try {
        await expect(seedFirstPartyApp(pool, workspaceId)).rejects.toThrow(
          /FLEETGRAPH_OAUTH_CLIENT_SECRET/
        );

        // No row was created by the failed attempt.
        const rows = await pool.query(`SELECT id FROM oauth_apps WHERE client_id = $1`, [
          FLEETGRAPH_CLIENT_ID,
        ]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = testSecret;
      }
    });
  });

  describe('AC-2: client_credentials grant returns a token whose /api/v1/me shows app identity, null user', () => {
    const app: Express = createApp();

    beforeAll(async () => {
      await deleteFleetgraphApp();
      process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = testSecret;
      const result = await seedFirstPartyApp(pool, workspaceId);
      expect(result.status).toBe('created');
    });

    it('POST /oauth/token (client_credentials) -> GET /api/v1/me shows app identity, null user', async () => {
      const tokenRes = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: FLEETGRAPH_CLIENT_ID,
          client_secret: testSecret,
        });

      expect(tokenRes.status).toBe(200);
      const tokenBody = tokenRes.body as {
        access_token: string;
        token_type: string;
        scope?: string;
        refresh_token?: string;
      };
      expect(typeof tokenBody.access_token).toBe('string');
      expect(tokenBody.access_token.length).toBeGreaterThan(0);
      // Client Credentials mints no refresh token (§2.2) — same assertion
      // shape token.test.ts's own client_credentials describe block uses.
      expect(tokenBody.refresh_token).toBeUndefined();
      expect('refresh_token' in (tokenRes.body as Record<string, unknown>)).toBe(false);

      const meRes = await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${tokenBody.access_token}`);

      expect(meRes.status).toBe(200);
      const meBody = meRes.body as {
        user: unknown;
        app: { id: string; client_id: string; name: string; is_first_party: boolean } | null;
        scopes: string[];
      };

      expect(meBody.user).toBeNull();
      expect(meBody.app).not.toBeNull();
      expect(meBody.app?.client_id).toBe(FLEETGRAPH_CLIENT_ID);
      expect(meBody.app?.name).toBe(FLEETGRAPH_APP_NAME);
      expect(meBody.app?.is_first_party).toBe(true);
      expect(meBody.scopes).toEqual(expect.arrayContaining([...FLEETGRAPH_APP_SCOPES]));
      expect(meBody.scopes).toHaveLength(FLEETGRAPH_APP_SCOPES.length);
    });

    it('wrong client_secret -> 401 invalid_client, never reaches /api/v1/me', async () => {
      const tokenRes = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: FLEETGRAPH_CLIENT_ID,
          client_secret: 'definitely-not-the-real-secret',
        });

      expect(tokenRes.status).toBe(401);
      expect((tokenRes.body as { error: string }).error).toBe('invalid_client');
    });
  });
});
