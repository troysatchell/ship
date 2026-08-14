/**
 * PF-302 (Linear TRO-431) — `/api/v1/webhooks`: CRUD, secret non-recoverability,
 * and rotation invalidation.
 *
 * Mirrors `documents.test.ts`'s fixture/token shape (personal tokens via
 * `api_tokens.scopes`, `last_workspace_id`-based workspace resolution) — the
 * same workspace-scoping note in `../workspaceContext.ts`'s header applies
 * here.
 *
 * AC (this ticket's own brief, PLUGFORGE.MD §4 PF-302): "CRUD tests; secret
 * non-recoverable via API after creation; rotation endpoint" — the three
 * describe blocks below map directly onto that list. The rotation-invalidates
 * proof is a crypto-level proxy (decrypt the stored ciphertext before/after
 * rotation, and prove a signature computed under the OLD secret no longer
 * verifies against whatever secret a delivery would fetch post-rotation) —
 * PF-304 (the actual deliverer) does not exist yet, so there is no live HTTP
 * delivery to assert against; this is the closest verifiable proxy, as the
 * ticket brief itself anticipates.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { decryptSecret, SECRET_ENCRYPTION_KEY_ENV } from '../../../../webhooks/secretEncryption.js';
import { sign, verify } from '../../../../webhooks/signer.js';
import { EVENT_TYPES } from '../../../../webhooks/events.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface SubscriptionBody {
  id: string;
  app_id: string;
  event_type: string;
  target_url: string;
  active: boolean;
  created_at: string;
  secret?: string;
  warning?: string;
  signing_secret_ciphertext?: string;
}

interface ListResponseBody {
  data: SubscriptionBody[];
  next_cursor: string | null;
}

describe('PF-302: /api/v1/webhooks (Linear TRO-431)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let appId: string; // oauth_apps row in `workspaceId`
  let otherWorkspaceAppId: string; // oauth_apps row in `otherWorkspaceId`
  let originalSecretEncryptionKey: string | undefined;

  /** scopes = ['webhooks:manage']. */
  let manageToken: string;
  /** scopes = ['documents:read'] — lacks webhooks:manage, for the 403 case. */
  let noScopeToken: string;

  /** Narrows a possibly-empty pg result to its single row, throwing loudly
   * rather than silently defaulting to `''` — same helper/rationale as
   * `db/__tests__/migrations-042-043.test.ts`'s `onlyRow`, and the same
   * throw-on-missing-row shape `insertOauthApp` below already uses; applied
   * here too (CodeRabbit, this PR review) so a broken seed insert fails
   * loudly at its own call site instead of producing a silently-empty id
   * that fails confusingly three calls later. */
  function onlyRow<T>(rows: T[]): T {
    const [row] = rows;
    if (row === undefined) {
      throw new Error(`Expected exactly one row, got ${rows.length}.`);
    }
    return row;
  }

  async function insertPersonalToken(scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-302 token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        scopes,
      ]
    );
    return raw;
  }

  async function insertOauthApp(inWorkspaceId: string, name: string): Promise<string> {
    const clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type)
       VALUES ($1, $2, $3, 'confidential') RETURNING id`,
      [inWorkspaceId, name, clientId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('seed insertOauthApp produced no row');
    return row.id;
  }

  /** Reads back `signing_secret_ciphertext` for one subscription, throwing
   * loudly rather than narrowing with `?? undefined` + `as string`
   * (CodeRabbit, this PR review) — a missing row here means the test itself
   * is broken (wrong id, or the INSERT never committed), which should fail
   * at this call site with a clear message, not three lines later against
   * `decryptSecret(undefined as unknown as string)`. */
  async function fetchCiphertext(subscriptionId: string): Promise<string> {
    const result = await pool.query<{ signing_secret_ciphertext: string }>(
      `SELECT signing_secret_ciphertext FROM webhook_subscriptions WHERE id = $1`,
      [subscriptionId]
    );
    return onlyRow(result.rows).signing_secret_ciphertext;
  }

  beforeAll(async () => {
    // A real 32-byte key for this whole file — same pattern as
    // secretEncryption.test.ts, just file-scoped rather than per-test since
    // this file never needs to exercise the "unset/malformed key" paths.
    // Save/restore rather than unconditionally delete (CodeRabbit, this PR
    // review) — same pattern secretEncryption.test.ts uses per-test: a
    // sibling suite in the same vitest process may have set a real value
    // this file has no business clobbering on exit.
    originalSecretEncryptionKey = process.env[SECRET_ENCRYPTION_KEY_ENV];
    process.env[SECRET_ENCRYPTION_KEY_ENV] = crypto.randomBytes(32).toString('hex');

    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-302 Test ${testRunId}`]
    );
    workspaceId = onlyRow(workspaceResult.rows).id;

    const otherWorkspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-302 Other Test ${testRunId}`]
    );
    otherWorkspaceId = onlyRow(otherWorkspaceResult.rows).id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-302 Test User', $2) RETURNING id`,
      [`pf302-${testRunId}@ship.local`, workspaceId]
    );
    userId = onlyRow(userResult.rows).id;

    appId = await insertOauthApp(workspaceId, `PF-302 App ${testRunId}`);
    otherWorkspaceAppId = await insertOauthApp(otherWorkspaceId, `PF-302 Other App ${testRunId}`);

    manageToken = await insertPersonalToken(['webhooks:manage']);
    noScopeToken = await insertPersonalToken(['documents:read']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM webhook_subscriptions WHERE app_id IN ($1, $2)', [appId, otherWorkspaceAppId]);
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
    if (originalSecretEncryptionKey === undefined) {
      delete process.env[SECRET_ENCRYPTION_KEY_ENV];
    } else {
      process.env[SECRET_ENCRYPTION_KEY_ENV] = originalSecretEncryptionKey;
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // CRUD tests
  // ────────────────────────────────────────────────────────────────────────

  describe('CRUD', () => {
    it('POST / requires a bearer token (401)', async () => {
      const res = await request(app).post('/api/v1/webhooks').send({
        app_id: appId,
        event_type: 'document.created',
        target_url: 'https://example.com/hook',
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });

    it('POST / requires the webhooks:manage scope (403, names the missing scope)', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${noScopeToken}`)
        .send({ app_id: appId, event_type: 'document.created', target_url: 'https://example.com/hook' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details?.missing_scope).toBe('webhooks:manage');
    });

    it('POST / rejects a missing/invalid body (400 validation_failed)', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'not.a.real.event', target_url: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details?.fieldErrors?.event_type).toBeTruthy();
      expect(res.body.details?.fieldErrors?.target_url).toBeTruthy();
    });

    it('POST / rejects an app_id that does not belong to the caller\'s workspace (400 validation_failed)', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({
          app_id: otherWorkspaceAppId,
          event_type: 'document.created',
          target_url: 'https://example.com/hook',
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details?.fieldErrors?.app_id).toBeTruthy();
    });

    it('POST / creates a subscription, returns the plaintext secret once, and encrypts it at rest', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'document.created', target_url: 'https://example.com/hook-create' });

      expect(res.status).toBe(201);
      const body = res.body as SubscriptionBody;
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.app_id).toBe(appId);
      expect(body.event_type).toBe('document.created');
      expect(body.target_url).toBe('https://example.com/hook-create');
      expect(body.active).toBe(true);
      expect(typeof body.secret).toBe('string');
      expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect(body.warning).toContain('will not be shown again');

      const ciphertext = await fetchCiphertext(body.id);
      expect(ciphertext).toBeTruthy();
      // The stored value is NOT the plaintext secret in any form.
      expect(ciphertext).not.toBe(body.secret);
      expect(ciphertext).not.toContain(body.secret ?? ' never-matches');
      // But it decrypts back to exactly the plaintext that was returned.
      expect(decryptSecret(ciphertext)).toBe(body.secret);
    });

    it('every registered event_type is accepted', async () => {
      for (const eventType of EVENT_TYPES) {
        const res = await request(app)
          .post('/api/v1/webhooks')
          .set('Authorization', `Bearer ${manageToken}`)
          .send({
            app_id: appId,
            event_type: eventType,
            target_url: `https://example.com/hook-${eventType}`,
          });
        expect(res.status, `event_type=${eventType} should be accepted`).toBe(201);
      }
    });

    it('GET / lists this workspace\'s subscriptions, cursor-paginated, and excludes another workspace\'s', async () => {
      // A subscription under THIS workspace's app — the most-recently-created
      // row for `appId` at this point in the file, so (ORDER BY created_at
      // DESC) it is guaranteed to be page 1's first item regardless of how
      // many earlier CRUD-describe tests already created rows for `appId`.
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'sprint.started', target_url: 'https://example.com/hook-list-a' });
      expect(created.status).toBe(201);
      const createdId = (created.body as SubscriptionBody).id;

      // A subscription under the OTHER workspace's app — must never appear.
      await pool.query(
        `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
         VALUES ($1, 'sprint.completed', 'https://example.com/other-ws-hook', 'not-a-real-ciphertext', true)`,
        [otherWorkspaceAppId]
      );

      const res = await request(app)
        .get('/api/v1/webhooks?limit=2')
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeLessThanOrEqual(2);
      for (const item of body.data) {
        expect(item.secret).toBeUndefined();
        expect(item.signing_secret_ciphertext).toBeUndefined();
      }
      expect('next_cursor' in body).toBe(true);

      // The subscription just created is actually IN the returned page — not
      // just "the response has the right shape" (CodeRabbit, this PR review:
      // the original version of this test never asserted this).
      expect(body.data.map((item) => item.id)).toContain(createdId);

      // None of this workspace's page items belong to the other workspace's app.
      const otherWsRow = await pool.query(
        `SELECT id FROM webhook_subscriptions WHERE app_id = $1`,
        [otherWorkspaceAppId]
      );
      const otherWsIds = new Set(otherWsRow.rows.map((r: { id: string }) => r.id));
      for (const item of body.data) {
        expect(otherWsIds.has(item.id)).toBe(false);
      }
    });

    it('GET /:id fetches a single subscription, 404s for a nonexistent or cross-workspace id', async () => {
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'issue.created', target_url: 'https://example.com/hook-get' });
      const { id } = created.body as SubscriptionBody;

      const ok = await request(app)
        .get(`/api/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.id).toBe(id);
      expect(ok.body.secret).toBeUndefined();

      const missing = await request(app)
        .get('/api/v1/webhooks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('not_found');

      const malformed = await request(app)
        .get('/api/v1/webhooks/not-a-uuid')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(malformed.status).toBe(404);

      // Belongs to the other workspace's app — must 404, not 200.
      const crossTenant = await pool.query<{ id: string }>(
        `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
         VALUES ($1, 'issue.assigned', 'https://example.com/cross-tenant', 'not-a-real-ciphertext', true)
         RETURNING id`,
        [otherWorkspaceAppId]
      );
      const crossTenantId = crossTenant.rows[0]?.id;
      const crossTenantRes = await request(app)
        .get(`/api/v1/webhooks/${crossTenantId}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(crossTenantRes.status).toBe(404);
    });

    it('DELETE /:id deactivates (idempotently), and 404s for an id outside the workspace', async () => {
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'issue.status_changed', target_url: 'https://example.com/hook-delete' });
      const { id } = created.body as SubscriptionBody;

      const first = await request(app)
        .delete(`/api/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(first.status).toBe(204);

      const afterDelete = await request(app)
        .get(`/api/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(afterDelete.status).toBe(200);
      expect(afterDelete.body.active).toBe(false);

      // Idempotent: deleting again is still 204, not a 4xx.
      const second = await request(app)
        .delete(`/api/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(second.status).toBe(204);

      const notFound = await request(app)
        .delete('/api/v1/webhooks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(notFound.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Secret non-recoverable via any API call after creation
  // ────────────────────────────────────────────────────────────────────────

  describe('AC: secret non-recoverable via any API call after creation', () => {
    it('list/get responses never carry the secret, in any form, after the create response is gone', async () => {
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'sprint.completed', target_url: 'https://example.com/hook-secret-proof' });
      const createdBody = created.body as SubscriptionBody;
      const { id } = createdBody;
      const plaintextSecret = createdBody.secret;
      if (plaintextSecret === undefined) {
        throw new Error('POST / response did not include a secret');
      }
      expect(plaintextSecret).toMatch(/^whsec_/);

      const getRes = await request(app)
        .get(`/api/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(getRes.status).toBe(200);
      expect('secret' in getRes.body).toBe(false);
      expect('signing_secret_ciphertext' in getRes.body).toBe(false);
      expect(JSON.stringify(getRes.body)).not.toContain(plaintextSecret);

      const listRes = await request(app)
        .get('/api/v1/webhooks?limit=100')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(listRes.status).toBe(200);
      expect(JSON.stringify(listRes.body)).not.toContain(plaintextSecret);
      const listedIds = (listRes.body as ListResponseBody).data.map((s) => s.id);
      expect(listedIds).toContain(id);
      for (const item of (listRes.body as ListResponseBody).data) {
        expect('secret' in item).toBe(false);
        expect('signing_secret_ciphertext' in item).toBe(false);
      }

      // There is no reveal endpoint: neither of the two other verbs this
      // resource registers for /:id (DELETE, and POST /:id/rotate, which
      // MINTS A NEW secret rather than revealing the old one) can produce the
      // original plaintext again. Confirmed structurally by this file's own
      // rotate test below returning a DIFFERENT secret, never this one.
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Rotation invalidates the old secret
  // ────────────────────────────────────────────────────────────────────────

  describe('AC: rotation invalidates the old secret for future signature verification', () => {
    it('POST /:id/rotate returns a new plaintext secret, once, distinct from the original', async () => {
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({ app_id: appId, event_type: 'document.updated', target_url: 'https://example.com/hook-rotate' });
      const createdBody = created.body as SubscriptionBody;
      const { id } = createdBody;
      const originalSecret = createdBody.secret;
      if (originalSecret === undefined) {
        throw new Error('POST / response did not include a secret');
      }

      const rotated = await request(app)
        .post(`/api/v1/webhooks/${id}/rotate`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(rotated.status).toBe(200);
      expect(rotated.body.id).toBe(id);
      expect(typeof rotated.body.secret).toBe('string');
      expect(rotated.body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
      expect(rotated.body.secret).not.toBe(originalSecret);

      // No auth / wrong scope still gated the same as every other route.
      const unauth = await request(app).post(`/api/v1/webhooks/${id}/rotate`);
      expect(unauth.status).toBe(401);
      const forbidden = await request(app)
        .post(`/api/v1/webhooks/${id}/rotate`)
        .set('Authorization', `Bearer ${noScopeToken}`);
      expect(forbidden.status).toBe(403);

      const notFound = await request(app)
        .post('/api/v1/webhooks/00000000-0000-0000-0000-000000000000/rotate')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(notFound.status).toBe(404);
    });

    it('the stored ciphertext changes on rotation, and a signature made under the OLD secret no longer verifies under whatever a future delivery would fetch', async () => {
      const created = await request(app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${manageToken}`)
        .send({
          app_id: appId,
          event_type: 'issue.status_changed',
          target_url: 'https://example.com/hook-rotate-invalidate',
        });
      const createdBody = created.body as SubscriptionBody;
      const id = createdBody.id;
      const oldSecret = createdBody.secret;
      if (oldSecret === undefined) {
        throw new Error('POST / response did not include a secret');
      }

      const oldCiphertext = await fetchCiphertext(id);
      expect(decryptSecret(oldCiphertext)).toBe(oldSecret);

      // A signature the deliverer would have produced under the OLD secret,
      // for a delivery that (in the real PF-304 pipeline) would be sent AFTER
      // this point in time — deterministic clock, same pattern signer.test.ts
      // uses.
      const rawBody = JSON.stringify({ hello: 'world' });
      const clockAtSignTime = () => 1_700_000_100;
      const signatureUnderOldSecret = sign(rawBody, oldSecret, clockAtSignTime);

      const rotateRes = await request(app)
        .post(`/api/v1/webhooks/${id}/rotate`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(rotateRes.status).toBe(200);
      const rotatedBody = rotateRes.body as SubscriptionBody;
      const newSecret = rotatedBody.secret;
      if (newSecret === undefined) {
        throw new Error('POST /:id/rotate response did not include a secret');
      }
      expect(newSecret).not.toBe(oldSecret);

      const newCiphertext = await fetchCiphertext(id);

      // The stored ciphertext itself changed...
      expect(newCiphertext).not.toBe(oldCiphertext);
      // ...and decrypts to the new secret, never the old one — this is what
      // "invalidates the old secret for future deliveries" means at rest:
      // whatever secret a future delivery attempt decrypts and signs with is
      // provably not the one an attacker (or a stale subscriber) who captured
      // the old secret still holds.
      const decryptedNewSecret = decryptSecret(newCiphertext);
      expect(decryptedNewSecret).toBe(newSecret);
      expect(decryptedNewSecret).not.toBe(oldSecret);

      // A signature computed under the OLD secret does not verify against
      // the NEW (post-rotation) secret — the exact "old signatures stop
      // being valid for new deliveries after rotation" AC, checked through
      // PF-303's own verify() at whatever clock time.
      const clockAtVerifyTime = () => 1_700_000_100;
      expect(verify(signatureUnderOldSecret, rawBody, decryptedNewSecret, 300, clockAtVerifyTime)).toBe(false);
      // Sanity: the same signature DOES verify under the secret it was
      // actually signed with, proving the negative result above is about the
      // rotation, not a broken signer/verify pairing.
      expect(verify(signatureUnderOldSecret, rawBody, oldSecret, 300, clockAtVerifyTime)).toBe(true);
    });
  });
});
