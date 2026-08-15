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
 *
 * PF-305 (Linear TRO-442) — `GET /api/v1/webhooks/deliveries`: the delivery
 * log, added at the bottom of this file. Deliveries are inserted directly via
 * `pool.query` (there is no route that creates them — PF-304's deliverer is
 * the only writer in production) so this test controls the exact row set
 * under test, same precedent as this file's own cross-tenant fixture rows
 * above.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { decryptSecret, encryptSecret, SECRET_ENCRYPTION_KEY_ENV } from '../../../../webhooks/secretEncryption.js';
import { sign, verify } from '../../../../webhooks/signer.js';
import { EVENT_TYPES } from '../../../../webhooks/events.js';
import { InMemoryWebhookDeliverer } from '../../../../webhooks/deliverer.js';
// ManualClock (TRO-603's new fix-proving test, below) — advances a deliverer
// instance's notion of "now" without a real setTimeout wait, same technique
// `deliverer.test.ts` already uses for its own retry-schedule assertions.
import { ManualClock } from '../../../../webhooks/clock.js';
// The reference-subscriber fixture (PF-801 / TRO-447) — see its own file
// header for why this is the SAME implementation the e2e drill
// (`e2e/webhook-idempotency-key-drill.spec.ts`) and the CLI demo both use,
// and why `verify` (signer.ts's, imported above) is injected here instead of
// the SDK's byte-identical `verifyWebhook()`: this file must never need
// `pnpm --filter @ship/sdk build` as a hidden prerequisite for `pnpm test`.
import { createReferenceSubscriber } from '../../../../../../../docs/submission/demo-webhook-listener.mjs';

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

/** `GET /api/v1/webhooks/deliveries` row shape — matches
 * `serializeDelivery()` in `../webhooks.ts` exactly. */
interface DeliveryBody {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  attempt_number: number;
  status: string;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  next_attempt_at: string | null;
  replayed_from_id: string | null;
  created_at: string;
}

interface DeliveryListResponseBody {
  data: DeliveryBody[];
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

  /** Inserts a `webhook_subscriptions` row directly (same shape the
   * cross-tenant fixture rows elsewhere in this file already use) — a
   * dedicated subscription per delivery-log test so its rows don't collide
   * with the CRUD-describe block's own subscriptions under the same `appId`. */
  async function insertSubscription(inAppId: string, eventType: string, targetUrl: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
       VALUES ($1, $2, $3, 'not-a-real-ciphertext', true) RETURNING id`,
      [inAppId, eventType, targetUrl]
    );
    return onlyRow(result.rows).id;
  }

  /** Same as `insertSubscription`, but with a REAL, decryptable
   * `signing_secret_ciphertext` (via `encryptSecret`) rather than the CRUD
   * fixtures' placeholder string — needed for the PF-306 replay describe
   * block below, whose calls go all the way through
   * `InMemoryWebhookDeliverer.attemptNow()` (real decrypt + sign), unlike
   * every other describe block in this file, which inserts
   * `webhook_deliveries` rows directly and never exercises the deliverer at
   * all (see this file's own header). */
  async function insertSubscriptionWithRealSecret(
    inAppId: string,
    eventType: string,
    targetUrl: string
  ): Promise<{ id: string; secret: string }> {
    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [inAppId, eventType, targetUrl, encryptSecret(secret)]
    );
    return { id: onlyRow(result.rows).id, secret };
  }

  /** Inserts a `webhook_deliveries` row directly — see this describe block's
   * own header for why (PF-304's deliverer is the only production writer,
   * and it does not run during this test). `createdAt` defaults to `now()`
   * only if omitted; the delivery-log tests below always pass an explicit,
   * distinct value so page ordering is deterministic regardless of what any
   * other test file's rows (a different workspace, excluded by the route's
   * own scoping) happen to contain. */
  async function insertDelivery(options: {
    subscriptionId: string;
    eventId?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    attemptNumber?: number;
    status?: string;
    responseStatus?: number | null;
    responseExcerpt?: string | null;
    latencyMs?: number | null;
    createdAt?: Date;
  }): Promise<{ id: string; createdAt: Date; eventId: string; idempotencyKey: string }> {
    const eventId = options.eventId ?? crypto.randomUUID();
    const eventType = options.eventType ?? 'document.created';
    const payload = options.payload ?? { hello: 'world' };
    const attemptNumber = options.attemptNumber ?? 1;
    const status = options.status ?? 'success';
    const responseStatus = options.responseStatus === undefined ? 200 : options.responseStatus;
    const responseExcerpt = options.responseExcerpt === undefined ? 'ok' : options.responseExcerpt;
    const latencyMs = options.latencyMs === undefined ? 42 : options.latencyMs;
    const createdAt = options.createdAt ?? new Date();
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();

    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status, response_status, response_excerpt, latency_ms, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, created_at`,
      [
        options.subscriptionId,
        eventId,
        eventType,
        JSON.stringify(payload),
        idempotencyKey,
        attemptNumber,
        status,
        responseStatus,
        responseExcerpt,
        latencyMs,
        createdAt.toISOString(),
      ]
    );
    const row = onlyRow(result.rows);
    return { id: row.id, createdAt: row.created_at, eventId, idempotencyKey };
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

  // ────────────────────────────────────────────────────────────────────────
  // PF-305 (Linear TRO-442) — GET /api/v1/webhooks/deliveries (delivery log)
  // ────────────────────────────────────────────────────────────────────────

  describe('PF-305: GET /api/v1/webhooks/deliveries (Linear TRO-442)', () => {
    let deliverySubscriptionId: string;
    let otherDeliverySubscriptionId: string;
    let otherWorkspaceDeliverySubscriptionId: string;

    // Fixed, deterministic, ordered timestamps — never `now()` — so page
    // boundaries never depend on real-clock resolution or on what any other
    // test file's rows happen to contain (the route's own workspace scoping
    // already isolates this describe block's rows from everything else).
    const T1 = new Date('2020-01-01T00:00:01.000Z'); // oldest
    const T2 = new Date('2020-01-01T00:00:02.000Z');
    const T3 = new Date('2020-01-01T00:00:03.000Z'); // newest
    const T_OTHER_SUB = new Date('2020-01-01T00:00:04.000Z');

    let row1Id: string; // attempt_number=1, status=success, T1
    let row2Id: string; // attempt_number=1, status=failed,  T2 (retried below)
    let row3Id: string; // attempt_number=2, status=success, T3 (retry of row2's event)

    beforeAll(async () => {
      deliverySubscriptionId = await insertSubscription(appId, 'document.created', 'https://example.com/deliveries-hook');
      otherDeliverySubscriptionId = await insertSubscription(appId, 'issue.created', 'https://example.com/deliveries-hook-2');
      otherWorkspaceDeliverySubscriptionId = await insertSubscription(
        otherWorkspaceAppId,
        'document.created',
        'https://example.com/other-ws-deliveries-hook'
      );

      const retriedEventId = crypto.randomUUID();

      const r1 = await insertDelivery({
        subscriptionId: deliverySubscriptionId,
        attemptNumber: 1,
        status: 'success',
        responseStatus: 200,
        latencyMs: 120,
        createdAt: T1,
      });
      row1Id = r1.id;

      const r2 = await insertDelivery({
        subscriptionId: deliverySubscriptionId,
        eventId: retriedEventId,
        attemptNumber: 1,
        status: 'failed',
        responseStatus: 503,
        latencyMs: 50,
        createdAt: T2,
      });
      row2Id = r2.id;

      // A real retry: same event_id as row2, attempt_number=2 — the literal
      // "every attempt visible" AC (migration 048's row-per-attempt design).
      const r3 = await insertDelivery({
        subscriptionId: deliverySubscriptionId,
        eventId: retriedEventId,
        attemptNumber: 2,
        status: 'success',
        responseStatus: 200,
        latencyMs: 80,
        createdAt: T3,
      });
      row3Id = r3.id;

      // A delivery under a DIFFERENT subscription in the SAME workspace —
      // must be excluded when filtering by `deliverySubscriptionId`, but
      // included when no subscription_id filter is given.
      await insertDelivery({
        subscriptionId: otherDeliverySubscriptionId,
        status: 'pending',
        responseStatus: null,
        latencyMs: null,
        createdAt: T2,
      });

      // A delivery under the OTHER WORKSPACE's subscription — must never
      // appear in any response in this describe block, regardless of filters.
      await insertDelivery({
        subscriptionId: otherWorkspaceDeliverySubscriptionId,
        status: 'success',
        responseStatus: 200,
        latencyMs: 10,
        createdAt: T_OTHER_SUB,
      });
    });

    it('requires a bearer token (401)', async () => {
      const res = await request(app).get('/api/v1/webhooks/deliveries');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });

    it('requires the webhooks:manage scope (403, names the missing scope)', async () => {
      const res = await request(app)
        .get('/api/v1/webhooks/deliveries')
        .set('Authorization', `Bearer ${noScopeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details?.missing_scope).toBe('webhooks:manage');
    });

    it('lists attempts for a subscription with attempt_number/response_status/latency_ms present, newest first', async () => {
      const res = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${deliverySubscriptionId}&limit=100`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(200);
      const body = res.body as DeliveryListResponseBody;
      expect(body.data.map((d) => d.id)).toEqual([row3Id, row2Id, row1Id]);

      const [three, two, one] = body.data;
      expect(three?.attempt_number).toBe(2);
      expect(three?.status).toBe('success');
      expect(three?.response_status).toBe(200);
      expect(three?.latency_ms).toBe(80);
      expect(three?.subscription_id).toBe(deliverySubscriptionId);

      expect(two?.attempt_number).toBe(1);
      expect(two?.status).toBe('failed');
      expect(two?.response_status).toBe(503);
      expect(two?.latency_ms).toBe(50);
      // row3 is the retry of row2's own event — proving BOTH attempts of the
      // same logical delivery are visible, not just the latest.
      expect(two?.event_id).toBe(three?.event_id);

      expect(one?.attempt_number).toBe(1);
      expect(one?.status).toBe('success');
      expect(one?.response_status).toBe(200);
      expect(one?.latency_ms).toBe(120);

      // Never leaks the other subscription's or the other workspace's rows.
      const ids = body.data.map((d) => d.id);
      expect(ids).not.toContain('');
      for (const item of body.data) {
        expect(item.subscription_id).toBe(deliverySubscriptionId);
      }
    });

    it('cursor-paginates across multiple pages in stable (created_at, id) DESC order', async () => {
      const page1 = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${deliverySubscriptionId}&limit=2`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(page1.status).toBe(200);
      const page1Body = page1.body as DeliveryListResponseBody;
      expect(page1Body.data.map((d) => d.id)).toEqual([row3Id, row2Id]);
      expect(page1Body.next_cursor).toBeTruthy();

      const page2 = await request(app)
        .get(
          `/api/v1/webhooks/deliveries?subscription_id=${deliverySubscriptionId}&limit=2&cursor=${encodeURIComponent(
            page1Body.next_cursor ?? ''
          )}`
        )
        .set('Authorization', `Bearer ${manageToken}`);
      expect(page2.status).toBe(200);
      const page2Body = page2.body as DeliveryListResponseBody;
      expect(page2Body.data.map((d) => d.id)).toEqual([row1Id]);
      expect(page2Body.next_cursor).toBeNull();
    });

    it('breaks a created_at tie using id DESC as the secondary sort key (CodeRabbit, this PR review)', async () => {
      // The previous test's three rows all have DISTINCT created_at values,
      // so it never actually exercises the keyset comparison's secondary
      // key — `(created_at, id) < (cursor.created_at, cursor.id)` degrades
      // to comparing created_at alone whenever every row's timestamp
      // differs. Two rows sharing the EXACT same created_at are the only
      // case that proves id is really part of the ordering, not just
      // present in the tuple.
      const tieSubscriptionId = await insertSubscription(
        appId,
        'document.updated',
        'https://example.com/deliveries-tie-hook'
      );
      const tiedCreatedAt = new Date('2020-01-01T00:00:05.000Z');

      const tiedA = await insertDelivery({ subscriptionId: tieSubscriptionId, status: 'success', createdAt: tiedCreatedAt });
      const tiedB = await insertDelivery({ subscriptionId: tieSubscriptionId, status: 'success', createdAt: tiedCreatedAt });

      // id DESC (string comparison agrees with Postgres's own uuid byte
      // comparison here: gen_random_uuid()'s canonical lowercase-hex text
      // form places hyphens at the same fixed positions in every value, so
      // comparing the two 36-character strings character-by-character is
      // equivalent to comparing the underlying 16 bytes).
      const expectedOrder = [tiedA.id, tiedB.id].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

      const page1 = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${tieSubscriptionId}&limit=1`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(page1.status).toBe(200);
      const page1Body = page1.body as DeliveryListResponseBody;
      expect(page1Body.data.map((d) => d.id)).toEqual([expectedOrder[0]]);
      expect(page1Body.next_cursor).toBeTruthy();

      const page2 = await request(app)
        .get(
          `/api/v1/webhooks/deliveries?subscription_id=${tieSubscriptionId}&limit=1&cursor=${encodeURIComponent(
            page1Body.next_cursor ?? ''
          )}`
        )
        .set('Authorization', `Bearer ${manageToken}`);
      expect(page2.status).toBe(200);
      const page2Body = page2.body as DeliveryListResponseBody;
      expect(page2Body.data.map((d) => d.id)).toEqual([expectedOrder[1]]);
      expect(page2Body.next_cursor).toBeNull();
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${deliverySubscriptionId}&status=failed&limit=100`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(200);
      const body = res.body as DeliveryListResponseBody;
      expect(body.data.map((d) => d.id)).toEqual([row2Id]);
      expect(body.data[0]?.status).toBe('failed');
    });

    it('filters by subscription_id, excluding another subscription in the same workspace', async () => {
      const res = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${otherDeliverySubscriptionId}&limit=100`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(200);
      const body = res.body as DeliveryListResponseBody;
      expect(body.data.length).toBe(1);
      expect(body.data[0]?.subscription_id).toBe(otherDeliverySubscriptionId);
      expect(body.data.map((d) => d.id)).not.toContain(row1Id);
      expect(body.data.map((d) => d.id)).not.toContain(row2Id);
      expect(body.data.map((d) => d.id)).not.toContain(row3Id);
    });

    it('never returns another workspace\'s delivery rows, with or without filters', async () => {
      const unfiltered = await request(app)
        .get('/api/v1/webhooks/deliveries?limit=100')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(unfiltered.status).toBe(200);
      const unfilteredBody = unfiltered.body as DeliveryListResponseBody;
      for (const item of unfilteredBody.data) {
        expect(item.subscription_id).not.toBe(otherWorkspaceDeliverySubscriptionId);
      }

      const filtered = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${otherWorkspaceDeliverySubscriptionId}&limit=100`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(filtered.status).toBe(200);
      // The caller's own credential resolves to `workspaceId`, not
      // `otherWorkspaceId` — the join through oauth_apps.workspace_id means
      // a subscription_id from a workspace this token can't see matches
      // nothing, not a leaked row.
      expect((filtered.body as DeliveryListResponseBody).data).toEqual([]);
    });

    it('rejects an invalid status filter (400 validation_failed)', async () => {
      const res = await request(app)
        .get('/api/v1/webhooks/deliveries?status=not-a-real-status')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details?.fieldErrors?.status).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // PF-306 (Linear TRO-446) — POST /api/v1/webhooks/deliveries/:id/replay
  // ────────────────────────────────────────────────────────────────────────

  describe('PF-306: POST /api/v1/webhooks/deliveries/:id/replay (Linear TRO-446)', () => {
    /** A `fetchImpl` double, explicitly typed as `typeof fetch` so every
     * call's arguments are inferred at the call site — no `as [string,
     * RequestInit]` cast needed to read them back out of `.mock.calls`. Same
     * helper `deliverer.test.ts` already establishes for the identical need;
     * duplicated here rather than imported, matching this file's own
     * `onlyRow` precedent of small per-file test helpers. */
    function fetchMockAlways(factory: () => Response) {
      return vi.fn<typeof fetch>(async () => factory());
    }

    /** Narrows `RequestInit['headers']` (the full fetch union: `Headers`,
     * `string[][]`, or a plain record) down to a single header's value,
     * without an `as Record<string, string>` cast past the non-record
     * shapes — same helper/rationale as `deliverer.test.ts`'s own. */
    function extractHeader(headers: RequestInit['headers'], name: string): string | undefined {
      if (!headers) return undefined;
      if (headers instanceof Headers) return headers.get(name) ?? undefined;
      if (Array.isArray(headers)) {
        const lowerName = name.toLowerCase();
        for (const pair of headers) {
          const key = pair[0];
          if (key !== undefined && key.toLowerCase() === lowerName) return pair[1];
        }
        return undefined;
      }
      const value = headers[name];
      if (value === undefined) return undefined;
      return typeof value === 'string' ? value : value.join(', ');
    }

    let replaySubscriptionId: string;
    let otherWorkspaceReplaySubscriptionId: string;

    beforeAll(async () => {
      const sub = await insertSubscriptionWithRealSecret(appId, 'document.created', 'https://example.com/replay-hook');
      replaySubscriptionId = sub.id;
      otherWorkspaceReplaySubscriptionId = await insertSubscription(
        otherWorkspaceAppId,
        'document.created',
        'https://example.com/other-ws-replay-hook'
      );
    });

    // `attemptNow()` really dispatches through global `fetch` — stubbed per
    // test, always undone (rule: a stubGlobal must be undone by
    // unstubAllGlobals, in afterEach so it runs even when an assertion
    // above it throws, never a bare mockRestore() as the test's own last
    // line).
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('requires a bearer token (401)', async () => {
      const res = await request(app).post(
        '/api/v1/webhooks/deliveries/00000000-0000-0000-0000-000000000000/replay'
      );
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });

    it('requires the webhooks:manage scope (403, names the missing scope)', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/deliveries/00000000-0000-0000-0000-000000000000/replay')
        .set('Authorization', `Bearer ${noScopeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details?.missing_scope).toBe('webhooks:manage');
    });

    it('404s for an unknown delivery id', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/deliveries/00000000-0000-0000-0000-000000000000/replay')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('404s for a malformed (non-UUID) delivery id', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/deliveries/not-a-uuid/replay')
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(404);
    });

    it('404s for a delivery belonging to another workspace\'s subscription', async () => {
      const crossTenant = await insertDelivery({
        subscriptionId: otherWorkspaceReplaySubscriptionId,
        status: 'success',
      });

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${crossTenant.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('404s for a delivery whose subscription was since deactivated — replay must not re-send to a webhook the owner turned off (CodeRabbit, this PR review)', async () => {
      const deactivatedSub = await insertSubscriptionWithRealSecret(
        appId,
        'document.created',
        'https://example.com/deactivated-replay-hook'
      );
      const original = await insertDelivery({
        subscriptionId: deactivatedSub.id,
        status: 'success',
      });

      // DELETE /:id deactivates (active = false) rather than a hard delete —
      // this file's own header. The delivery row survives (history stays
      // queryable via GET /deliveries), but replay must stop working the
      // moment the owner turns the subscription off.
      const deleteRes = await request(app)
        .delete(`/api/v1/webhooks/${deactivatedSub.id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(deleteRes.status).toBe(204);

      const fetchMock = fetchMockAlways(() => new Response('should never be called', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      // The strongest proof: no HTTP call was ever attempted.
      expect(fetchMock).not.toHaveBeenCalled();

      // Confirmed via the log route too: the original row is still visible
      // there (deactivation doesn't hide history), just not replayable.
      const listRes = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${deactivatedSub.id}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(listRes.status).toBe(200);
      expect((listRes.body as { data: Array<{ id: string }> }).data.map((d) => d.id)).toContain(original.id);
    });

    it('replays a successful delivery: reaches the subscriber with the ORIGINAL Idempotency-Key, records a NEW row, and leaves the original untouched', async () => {
      const originalPayload = { hello: 'replay-me' };
      const original = await insertDelivery({
        subscriptionId: replaySubscriptionId,
        payload: originalPayload,
        attemptNumber: 1,
        status: 'success',
        responseStatus: 200,
        responseExcerpt: 'original-ok',
        latencyMs: 11,
      });

      const fetchMock = fetchMockAlways(() => new Response('replayed-ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;

      // A NEW row — never the original's own id.
      expect(body.id).not.toBe(original.id);
      expect(body.subscription_id).toBe(replaySubscriptionId);
      // Same logical event as the original.
      expect(body.event_id).toBe(original.eventId);
      // THE core AC: the ORIGINAL Idempotency-Key, never a freshly generated
      // one — this is the subscriber-dedupe contract PF-801's e2e test
      // verifies end to end.
      expect(body.idempotency_key).toBe(original.idempotencyKey);
      // attempt_number continues the same event's series (original was 1).
      expect(body.attempt_number).toBe(2);
      expect(body.status).toBe('success');
      expect(body.response_status).toBe(200);
      // Linked back to the original it replayed.
      expect(body.replayed_from_id).toBe(original.id);

      // The deliverer actually dispatched ONE HTTP request, and it carried
      // the ORIGINAL idempotency key on the wire — not just a DB row
      // claiming it did.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error('expected the deliverer to call fetch');
      const [calledUrl, calledInit] = call;
      expect(calledUrl).toBe('https://example.com/replay-hook');
      if (!calledInit) throw new Error('expected the deliverer to pass a RequestInit to fetch');
      expect(extractHeader(calledInit.headers, 'Idempotency-Key')).toBe(original.idempotencyKey);
      expect(extractHeader(calledInit.headers, 'Ship-Signature')).toBeTruthy();
      expect(calledInit.body).toBe(JSON.stringify(originalPayload));

      // The original row is completely unchanged — a replay records, it
      // never mutates.
      const originalAfter = await pool.query<{
        status: string;
        response_status: number | null;
        response_excerpt: string | null;
        latency_ms: number | null;
        attempt_number: number;
        idempotency_key: string;
      }>(
        `SELECT status, response_status, response_excerpt, latency_ms, attempt_number, idempotency_key
         FROM webhook_deliveries WHERE id = $1`,
        [original.id]
      );
      const originalRow = onlyRow(originalAfter.rows);
      expect(originalRow.status).toBe('success');
      expect(originalRow.response_status).toBe(200);
      expect(originalRow.response_excerpt).toBe('original-ok');
      expect(originalRow.latency_ms).toBe(11);
      expect(originalRow.attempt_number).toBe(1);
      expect(originalRow.idempotency_key).toBe(original.idempotencyKey);

      // GET /deliveries (the list serializer, a separate code path from the
      // replay response above) exposes replayed_from_id too — not just the
      // POST /replay response (CodeRabbit, this PR review).
      const listRes = await request(app)
        .get(`/api/v1/webhooks/deliveries?subscription_id=${replaySubscriptionId}`)
        .set('Authorization', `Bearer ${manageToken}`);
      expect(listRes.status).toBe(200);
      const listedReplay = (listRes.body as { data: DeliveryBody[] }).data.find((d) => d.id === body.id);
      if (!listedReplay) throw new Error('expected the new replay row to appear in GET /deliveries');
      expect(listedReplay.replayed_from_id).toBe(original.id);
    });

    it('replays a dead (DLQ) delivery successfully — the graded replay-after-DLQ scenario', async () => {
      const original = await insertDelivery({
        subscriptionId: replaySubscriptionId,
        payload: { hello: 'dlq-replay' },
        attemptNumber: 6,
        status: 'dead',
        responseStatus: 503,
        responseExcerpt: 'gave up after 6 attempts',
        latencyMs: 99,
      });

      const fetchMock = fetchMockAlways(() => new Response('replayed-after-dlq', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;
      expect(body.id).not.toBe(original.id);
      expect(body.event_id).toBe(original.eventId);
      expect(body.idempotency_key).toBe(original.idempotencyKey);
      expect(body.attempt_number).toBe(7);
      expect(body.status).toBe('success');
      expect(body.replayed_from_id).toBe(original.id);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      if (!call) throw new Error('expected the deliverer to call fetch');
      const [, calledInit] = call;
      if (!calledInit) throw new Error('expected the deliverer to pass a RequestInit to fetch');
      expect(extractHeader(calledInit.headers, 'Idempotency-Key')).toBe(original.idempotencyKey);

      // The original DLQ row is still 'dead' — replay does not resurrect it,
      // it only ever creates a new row.
      const originalAfter = await pool.query<{ status: string; attempt_number: number }>(
        `SELECT status, attempt_number FROM webhook_deliveries WHERE id = $1`,
        [original.id]
      );
      const originalRow = onlyRow(originalAfter.rows);
      expect(originalRow.status).toBe('dead');
      expect(originalRow.attempt_number).toBe(6);
    });

    it('replaying a dead (DLQ) delivery that fails AGAIN with a 5xx goes straight back to dead — attempt_number continues past MAX_ATTEMPTS with no further retry scheduled (CodeRabbit, this PR review)', async () => {
      const original = await insertDelivery({
        subscriptionId: replaySubscriptionId,
        payload: { hello: 'dlq-replay-fails-again' },
        attemptNumber: 6,
        status: 'dead',
        responseStatus: 503,
        responseExcerpt: 'gave up after 6 attempts',
        latencyMs: 99,
      });

      const fetchMock = fetchMockAlways(() => new Response('still down', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;
      expect(body.attempt_number).toBe(7);
      // A 5xx is normally retryable — but attempt_number (7) is already
      // >= MAX_ATTEMPTS (6), so attempt()'s pre-existing exhaustion rule
      // applies exactly as it would to a 6th automatic attempt: dead
      // immediately, no retry sibling. Documented in this route's own file
      // header and in attemptNow()'s doc comment (deliverer.ts).
      expect(body.status).toBe('dead');
      expect(body.response_status).toBe(503);
      expect(body.replayed_from_id).toBe(original.id);

      // No THIRD row was created — exactly the replay row above, nothing
      // scheduled after it.
      const allRowsForEvent = await pool.query<{ id: string; attempt_number: number; status: string }>(
        `SELECT id, attempt_number, status FROM webhook_deliveries WHERE event_id = $1 ORDER BY attempt_number`,
        [original.eventId]
      );
      expect(allRowsForEvent.rows.map((r) => ({ attempt_number: r.attempt_number, status: r.status }))).toEqual([
        { attempt_number: 6, status: 'dead' },
        { attempt_number: 7, status: 'dead' },
      ]);
    });

    it('a retryable replay (attempt_number below MAX_ATTEMPTS) that fails again schedules a retry sibling that stays un-polled until a process restart — TRUE ONLY for the no-injection fallback path (TRO-603 fixes this when a shared deliverer is injected — see the next test)', async () => {
      // Below MAX_ATTEMPTS (6) — unlike the DLQ-exhaustion test above, this
      // replay's failure IS retryable per attempt()'s own backoff rule, so a
      // new 'pending' sibling row gets scheduled rather than going straight
      // to 'dead'.
      //
      // This test uses the file's own top-level `app` (`createApp()`, no
      // options — see this file's own `const app: Express = createApp();`)
      // — i.e. it exercises the FALLBACK path `resources/webhooks.ts`'s
      // `createWebhooksRouter()` still preserves for any caller that doesn't
      // inject a deliverer (every other test file in this repo that calls
      // `createApp()` with no options, and local `pnpm dev`). That fallback
      // is deliberately unchanged by TRO-603 — see the next test for the
      // FIXED path, which is identical in every way except which
      // `createApp()` instance the request goes through.
      const original = await insertDelivery({
        subscriptionId: replaySubscriptionId,
        payload: { hello: 'retryable-replay-schedules-orphaned-sibling' },
        attemptNumber: 2,
        status: 'failed',
        responseStatus: 503,
        responseExcerpt: 'transient failure',
        latencyMs: 88,
      });

      const fetchMock = fetchMockAlways(() => new Response('still down', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;
      expect(body.attempt_number).toBe(3);
      // Below MAX_ATTEMPTS: attempt() marks THIS replay row 'failed' (not
      // 'dead') and schedules a retry sibling, per its normal backoff rule.
      expect(body.status).toBe('failed');
      expect(body.replayed_from_id).toBe(original.id);

      // The sibling WAS created: a THIRD row, attempt_number 4, 'pending',
      // due for retry.
      const siblingResult = await pool.query<{
        id: string;
        attempt_number: number;
        status: string;
        next_attempt_at: Date | null;
      }>(
        `SELECT id, attempt_number, status, next_attempt_at FROM webhook_deliveries
         WHERE event_id = $1 AND attempt_number = 4`,
        [original.eventId]
      );
      expect(siblingResult.rows).toHaveLength(1);
      const sibling = siblingResult.rows[0];
      if (sibling === undefined) throw new Error('expected the sibling row to exist');
      expect(sibling.status).toBe('pending');
      expect(sibling.next_attempt_at).not.toBeNull();

      // The documented, still-live fallback behavior: that sibling is
      // durable in Postgres, proven above — but it was queued only on the
      // THROWAWAY `InMemoryWebhookDeliverer` this HTTP request's route
      // handler constructed (webhooks.ts, `injectedDeliverer ?? new
      // InMemoryWebhookDeliverer(pool)` — `app` here was built via
      // `createApp()` with no `webhookDeliverer` option, so
      // `injectedDeliverer` is `undefined`), which this test process
      // discards the moment the request above resolves. This test suite
      // never starts a production-shaped singleton's `processDue()` polling
      // loop against THIS throwaway instance — the sibling staying
      // 'pending' here is not a tautology, it is the same orphaning an
      // uninjected `createApp()` caller still produces after TRO-603,
      // reproduced under test rather than merely asserted in a comment. See
      // the next test for the fix.
    });

    it('TRO-603 FIX: when the app is built with its real, shared deliverer injected, a retryable replay\'s retry sibling is queued on THAT instance and gets drained by its own processDue() — no process restart required', async () => {
      // Identical scenario to the fallback-path test above (attempt_number
      // 2, 'failed', a 503 that stays retryable) — the only difference is
      // which deliverer instance the route handler uses. This test builds
      // its OWN `createApp()` instance via `CreateAppOptions.webhookDeliverer`
      // (`app.ts`), injecting an `InMemoryWebhookDeliverer` this test also
      // keeps a direct reference to — mirroring exactly what `index.ts` does
      // at boot (build the deliverer, then pass that same instance into
      // `createApp()`) — so it can call `processDue()` on that SAME instance
      // after the HTTP request completes, the same call `start()`'s real
      // `setInterval` makes on a 1-second cadence in production. A
      // `ManualClock` makes the retry-schedule wait (RETRY_SCHEDULE_MS[2] =
      // 16s, plus up to one more 16s of full jitter — see `attempt()`'s own
      // comment in deliverer.ts) instant rather than a real sleep.
      //
      // The fetch stub MUST be installed BEFORE `new InMemoryWebhookDeliverer(...)`
      // — its constructor reads `options.fetchImpl ?? fetch` once, eagerly,
      // and stores that reference (`deliverer.ts`'s own `this.fetchImpl =
      // options.fetchImpl ?? fetch`). Constructing first and stubbing after
      // (this test's own first draft) captures whatever global `fetch` was
      // at that moment instead of the mock — the fallback-path test above
      // never hits this because it constructs its throwaway deliverer
      // INSIDE the route handler, which only runs after this test's stub is
      // already in place.
      let fetchCallCount = 0;
      const fetchMock = vi.fn<typeof fetch>(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) return new Response('still down', { status: 503 });
        return new Response('recovered', { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const sharedClock = new ManualClock(Date.now());
      const sharedDeliverer = new InMemoryWebhookDeliverer(pool, sharedClock);
      const appWithSharedDeliverer = createApp('http://localhost:5173', {
        webhookDeliverer: sharedDeliverer,
      });

      const original = await insertDelivery({
        subscriptionId: replaySubscriptionId,
        payload: { hello: 'retryable-replay-fixed-by-injection' },
        attemptNumber: 2,
        status: 'failed',
        responseStatus: 503,
        responseExcerpt: 'transient failure',
        latencyMs: 88,
      });

      // First fetch call is the replay's own attempt (attempt_number 3):
      // still down, 503 — retryable, schedules a sibling, same as the
      // fallback-path test. The second call is whatever `processDue()`
      // below dispatches for that sibling (attempt_number 4): the
      // subscriber has recovered, 200 — so a definite 'success' outcome on
      // the sibling proves it was actually attempted, not just left
      // 'pending' for an unrelated reason.

      const res = await request(appWithSharedDeliverer)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;
      expect(body.attempt_number).toBe(3);
      expect(body.status).toBe('failed');
      expect(body.replayed_from_id).toBe(original.id);
      expect(fetchCallCount).toBe(1);

      // The sibling exists — durability was never the bug, exactly as the
      // fallback-path test above also proves.
      const siblingBefore = await pool.query<{ id: string; status: string; next_attempt_at: Date | null }>(
        `SELECT id, status, next_attempt_at FROM webhook_deliveries
         WHERE event_id = $1 AND attempt_number = 4`,
        [original.eventId]
      );
      expect(siblingBefore.rows).toHaveLength(1);
      const siblingRow = siblingBefore.rows[0];
      if (siblingRow === undefined) throw new Error('expected the sibling row to exist');
      expect(siblingRow.status).toBe('pending');
      expect(siblingRow.next_attempt_at).not.toBeNull();

      // THIS is the fix under test: the sibling above was queued in-memory
      // by the SAME `sharedDeliverer` instance the replay route just used
      // (because it was injected, not constructed fresh per-request).
      // Before TRO-603, this route always built its own throwaway instance,
      // whose queue this `processDue()` call could never have reached — see
      // the fallback-path test's own trailing comment for that still-true
      // behavior when nothing is injected.
      sharedClock.advance(40_000);
      const processedCount = await sharedDeliverer.processDue();
      expect(processedCount).toBe(1);
      expect(fetchCallCount).toBe(2);

      const siblingAfter = await pool.query<{ status: string; response_status: number | null }>(
        `SELECT status, response_status FROM webhook_deliveries WHERE id = $1`,
        [siblingRow.id]
      );
      const siblingAfterRow = onlyRow(siblingAfter.rows);
      expect(siblingAfterRow.status).toBe('success');
      expect(siblingAfterRow.response_status).toBe(200);
    });

    it('if attemptNow() itself fails to execute (a non-deterministic decrypt failure), the route still returns 201 with the row\'s actual (pending) state — never an opaque 500 (CodeRabbit, this PR review)', async () => {
      // A ciphertext that is the right LENGTH (so it is not the deterministic
      // MalformedCiphertextError case) but whose final byte is flipped —
      // decrypting it fails GCM auth-tag verification, which attempt() (per
      // its own doc comment) treats as a non-deterministic, process-level
      // failure and RETHROWS rather than dead-lettering. Same technique
      // deliverer.test.ts's own "GCM auth-tag mismatch ... treated as
      // TRANSIENT" case uses, duplicated here per this file's own small
      // per-file test-helper convention.
      function corruptedButCorrectlySizedCiphertext(secret: string): string {
        const valid = Buffer.from(encryptSecret(secret), 'base64');
        const tampered = Buffer.from(valid);
        const lastIndex = tampered.length - 1;
        const lastByte = tampered[lastIndex] ?? 0;
        tampered[lastIndex] = lastByte ^ 0xff;
        return tampered.toString('base64');
      }

      const brokenSubscription = await pool.query<{ id: string }>(
        `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [appId, 'document.created', 'https://example.com/replay-broken-hook', corruptedButCorrectlySizedCiphertext('whsec_test')]
      );
      const brokenSubscriptionId = onlyRow(brokenSubscription.rows).id;

      const original = await insertDelivery({
        subscriptionId: brokenSubscriptionId,
        payload: { hello: 'broken-secret-replay' },
        attemptNumber: 1,
        status: 'success',
        responseStatus: 200,
      });

      // fetch must never be reached — decrypt fails before any HTTP call.
      const fetchMock = fetchMockAlways(() => new Response('unreachable', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await request(app)
        .post(`/api/v1/webhooks/deliveries/${original.id}/replay`)
        .set('Authorization', `Bearer ${manageToken}`);

      // Not a 500 — the new row was genuinely created, so the response
      // reflects its real (pending) state rather than an opaque failure.
      expect(res.status).toBe(201);
      const body = res.body as DeliveryBody;
      expect(body.id).not.toBe(original.id);
      expect(body.replayed_from_id).toBe(original.id);
      expect(body.idempotency_key).toBe(original.idempotencyKey);
      expect(body.status).toBe('pending');
      expect(body.response_status).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      // Confirmed durable, not just reflected in this one response — a
      // fresh SELECT shows the same 'pending' state.
      const persisted = await pool.query<{ status: string }>(
        `SELECT status FROM webhook_deliveries WHERE id = $1`,
        [body.id]
      );
      expect(onlyRow(persisted.rows).status).toBe('pending');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // PF-801 (Linear TRO-447) — Idempotency-Key drill: proves the SAME key
  // travels on BOTH the fresh delivery's and the replay's real HTTP call,
  // against a real reference-subscriber double (not a fetch mock) — the
  // gate-executed vitest-level proof `ship-qa`'s own rule requires (an
  // e2e-only regression test passes the gate's "test added" grep without
  // ever being run by it; see e2e/webhook-idempotency-key-drill.spec.ts's
  // own header for the additive, real-browser/real-process version of this
  // same story).
  //
  // Distinct from the pre-existing "replays a successful delivery" test
  // above: that test stubs `fetch` and inserts the ORIGINAL delivery
  // directly via SQL, so it only ever captures ONE real HTTP call's headers
  // (the replay's) and compares them against a DB column — it never
  // dispatches a first HTTP call at all, so it cannot prove "the SAME key
  // was sent on both calls," only "the replay used the row's stored key."
  // This test dispatches BOTH the fresh delivery and the replay for real,
  // over an actual loopback socket, into a listener that independently
  // tracks what it received — the same reference-subscriber fixture the
  // e2e drill and the CLI demo also use.
  // ────────────────────────────────────────────────────────────────────────

  describe('PF-801: Idempotency-Key is stable across replay, and a reference subscriber dedupes on it (Linear TRO-447)', () => {
    it('a fresh delivery and its replay carry the SAME Idempotency-Key on the wire; the reference-subscriber fixture recognizes the second as a duplicate without reprocessing it', async () => {
      // A FULLY ISOLATED workspace/user/app/token for this one test, not the
      // shared `workspaceId`/`appId`/`manageToken` every other describe
      // block in this file uses. Reason (found the hard way, first draft of
      // this test): `InMemoryWebhookDeliverer.enqueueEvent()` matches EVERY
      // active subscription in the event's workspace with the same
      // event_type — and "every registered event_type is accepted" (the
      // CRUD describe block above) alone leaves one active 'document.created'
      // subscription behind under `appId`'s shared workspace, on top of
      // several more from other tests. Reusing that workspace would make
      // `deliverer.processDue()` below fan out REAL outbound HTTP attempts to
      // every one of those OTHER subscriptions' target_urls too (mostly
      // `https://example.com/...` placeholders) — slow, non-deterministic,
      // and liable to hang under a network-sandboxed CI runner. A workspace
      // this test owns exclusively guarantees exactly one match: itself.
      const isolatedWorkspaceResult = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
        [`PF-801 Test ${testRunId}`]
      );
      const isolatedWorkspaceId = onlyRow(isolatedWorkspaceResult.rows).id;

      // `resolvePrincipalWorkspaceId` resolves a personal token's workspace
      // via `users.last_workspace_id`, NOT `api_tokens.workspace_id` — see
      // that file's own header ("a DERIVED approximation ... via
      // last_workspace_id"). A dedicated user is therefore required too, not
      // just a dedicated token row.
      const isolatedUserResult = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, last_workspace_id)
         VALUES ($1, 'test-hash', 'PF-801 Test User', $2) RETURNING id`,
        [`pf801-${testRunId}@ship.local`, isolatedWorkspaceId]
      );
      const isolatedUserId = onlyRow(isolatedUserResult.rows).id;

      const isolatedAppId = await insertOauthApp(isolatedWorkspaceId, `PF-801 App ${testRunId}`);

      const isolatedTokenRaw = `ship_${crypto.randomBytes(24).toString('hex')}`;
      await pool.query(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          isolatedUserId,
          isolatedWorkspaceId,
          'PF-801 token',
          sha256Hex(isolatedTokenRaw),
          isolatedTokenRaw.slice(0, 12),
          ['webhooks:manage'],
        ]
      );

      // A secret THIS test generates itself, not insertSubscriptionWithRealSecret's
      // (that helper mints its own, but the reference subscriber has to be
      // constructed with the secret BEFORE the subscription row can
      // reference the subscriber's own listening port in target_url — a
      // chicken-and-egg insertSubscriptionWithRealSecret's own signature
      // can't resolve, so this test inserts the row itself, one level down).
      const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

      // signer.ts's OWN verify() (imported at the top of this file) — not
      // the SDK's verifyWebhook() — see the import comment above for why.
      const subscriber = createReferenceSubscriber({ secret, verify });
      const port = await subscriber.listen(0);

      try {
        const subResult = await pool.query<{ id: string }>(
          `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
           VALUES ($1, 'document.created', $2, $3, true) RETURNING id`,
          [isolatedAppId, `http://127.0.0.1:${port}/`, encryptSecret(secret)]
        );
        const subscriptionId = onlyRow(subResult.rows).id;

        // ── Fresh delivery: enqueue + dispatch for REAL, over a real
        // loopback socket, through the SAME InMemoryWebhookDeliverer
        // production code path production traffic uses — never a fetch
        // mock. ──
        const eventId = crypto.randomUUID();
        const deliverer = new InMemoryWebhookDeliverer(pool);
        const enqueuedCount = await deliverer.enqueueEvent({
          id: eventId,
          type: 'document.created',
          created_at: new Date().toISOString(),
          workspace_id: isolatedWorkspaceId,
          data: { id: crypto.randomUUID(), document_type: 'wiki', title: 'PF-801 drill doc', created_by: null },
        });
        // Exactly one match — this isolated workspace has exactly one active
        // subscription, the one created above.
        expect(enqueuedCount).toBe(1);
        await deliverer.processDue();

        const originalRow = onlyRow(
          (
            await pool.query<{ id: string; idempotency_key: string; status: string }>(
              `SELECT id, idempotency_key, status FROM webhook_deliveries
               WHERE subscription_id = $1 AND event_id = $2 AND attempt_number = 1`,
              [subscriptionId, eventId]
            )
          ).rows
        );
        expect(originalRow.status).toBe('success');
        const idempotencyKey = originalRow.idempotency_key;

        // The reference subscriber genuinely received it, over the real
        // socket, and did NOT see it as a duplicate the first time.
        expect(subscriber.wasProcessed(idempotencyKey)).toBe(true);
        expect(subscriber.wasDeduped(idempotencyKey)).toBe(false);
        expect(subscriber.deliveries.size).toBe(1);

        // ── Replay: through the REAL route, which reuses the ORIGINAL
        // idempotency_key (never regenerates one) — this ticket's own AC,
        // proved end to end this time via a live subscriber instead of a
        // DB-column comparison. ──
        const replayRes = await request(app)
          .post(`/api/v1/webhooks/deliveries/${originalRow.id}/replay`)
          .set('Authorization', `Bearer ${isolatedTokenRaw}`);
        expect(replayRes.status).toBe(201);
        const replayBody = replayRes.body as DeliveryBody;

        // THE core assertion: the SAME Idempotency-Key was sent on BOTH real
        // HTTP calls.
        expect(replayBody.idempotency_key).toBe(idempotencyKey);
        expect(replayBody.replayed_from_id).toBe(originalRow.id);
        expect(replayBody.status).toBe('success');

        // The reference-subscriber fixture is what a dedup check would key
        // on: it now recognizes this key as a duplicate, and never
        // reprocessed the second delivery as a separate logical event — only
        // ONE entry exists in its delivery map, with duplicateCount 1.
        expect(subscriber.wasDeduped(idempotencyKey)).toBe(true);
        expect(subscriber.deliveries.size).toBe(1);
        expect(subscriber.deliveries.get(idempotencyKey)?.duplicateCount).toBe(1);

        // The delivery log distinguishes fresh vs replayed keys via
        // replayed_from_id — TWO distinct rows for this event, even though
        // the subscriber only ever genuinely processed one of them.
        const logRes = await request(app)
          .get(`/api/v1/webhooks/deliveries?subscription_id=${subscriptionId}`)
          .set('Authorization', `Bearer ${isolatedTokenRaw}`);
        expect(logRes.status).toBe(200);
        const logBody = logRes.body as DeliveryListResponseBody;
        expect(logBody.data).toHaveLength(2);
        // By id, not array position (CodeRabbit, this ticket's review): both
        // rows can share a `created_at` timestamp (created milliseconds
        // apart within one test), so "newest first" is not a guaranteed
        // order to destructure against — the e2e drill already does this
        // lookup by id for the same reason.
        const replayedRow = logBody.data.find((d) => d.id === replayBody.id);
        const originalRowFromLog = logBody.data.find((d) => d.id === originalRow.id);
        if (!replayedRow || !originalRowFromLog) {
          throw new Error(`expected both the original and replay rows, got: ${JSON.stringify(logBody)}`);
        }
        expect(replayedRow.replayed_from_id).toBe(originalRow.id);
        expect(originalRowFromLog.replayed_from_id).toBeNull();
        expect(replayedRow.idempotency_key).toBe(idempotencyKey);
        expect(originalRowFromLog.idempotency_key).toBe(idempotencyKey);
      } finally {
        await subscriber.close();
        // Isolated rows this test owns exclusively — explicit order, same
        // FK-dependency shape the file's own top-level `afterAll` already
        // uses (webhook_subscriptions -> oauth_apps -> api_tokens -> users ->
        // workspaces).
        await pool.query('DELETE FROM webhook_subscriptions WHERE app_id = $1', [isolatedAppId]);
        await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [isolatedWorkspaceId]);
        await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [isolatedWorkspaceId]);
        await pool.query('DELETE FROM users WHERE id = $1', [isolatedUserId]);
        await pool.query('DELETE FROM workspaces WHERE id = $1', [isolatedWorkspaceId]);
      }
    });
  });
});
