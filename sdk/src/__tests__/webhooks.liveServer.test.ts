/**
 * TRO-599 — `WebhooksClient` against a real running Ship API + the seeded
 * worktree DB. The regression test this ticket's own brief asks for
 * explicitly: "a real HTTP round-trip test... asserting the response
 * object's actual keys/values match what the TypeScript type declares" —
 * the strongest form of proof available, since the whole bug class this
 * ticket fixes is exactly "the type lied about what you'd actually get
 * back."
 *
 * Same technique as `audit.liveServer.test.ts`/`resources.liveServer.test.ts`
 * (read either file's header first, this one follows it exactly): a REAL
 * `http` listener wrapping the REAL `createApp()`, driven by a REAL
 * `ShipClient` — a genuine TCP round trip, not a mocked `fetch` and not an
 * in-process supertest binding. The one deliberate cross-package import
 * exception those files document applies here too. Unlike them, this file
 * ALSO stands up a second, tiny local HTTP listener (`stubTarget` below) to
 * act as the webhook subscriber `replayDelivery()` actually POSTs to —
 * `POST /webhooks/deliveries/:id/replay` performs a REAL outbound HTTP
 * attempt (`platform/webhooks/deliverer.ts`'s `attemptNow()`), so proving
 * its response shape end-to-end means giving it something real, fast, and
 * deterministic to attempt against rather than reaching out to the network
 * (flaky, slow, and address-dependent) or mocking the attempt away
 * (which would stop this from being a genuine round trip).
 *
 * Every row this suite reads through the SDK is seeded directly via SQL —
 * `createSubscription()`'s own REQUEST body is a separate, disclosed,
 * NOT-fixed gap (`sdk/src/resources/webhooks.ts`'s header; out of TRO-599's
 * scope, which is the two RESPONSE types) that would 400 against this real
 * server if used, so seeding the row directly is what makes it possible to
 * prove the RESPONSE shapes (`listSubscriptions`/`getSubscription`/
 * `rotateSecret`/`listDeliveries`/`replayDelivery` — every read/action
 * method whose request needs no body beyond an id) without depending on the
 * one still-broken method.
 *
 * DB SAFETY: own isolated workspace/user/oauth_app/api_token/webhook rows in
 * `beforeAll`, deleted in `afterAll`; does not touch `pnpm db:seed`'s
 * fixtures or share a Postgres pool/http server with any other file (own
 * module instance, same isolation guarantee `client.liveServer.test.ts`'s
 * own header documents).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import — see this file's header.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';
import { encryptSecret, SECRET_ENCRYPTION_KEY_ENV } from '../../../api/src/platform/webhooks/secretEncryption.js';

import { ShipClient } from '../client.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Same defensive `RETURNING id` helper as `audit.liveServer.test.ts` — see
 *  that file's header for why this is not a `!` assertion. */
function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

function actualKeys(obj: object): string[] {
  return Object.keys(obj).sort();
}

// The exact real field sets, hand-mirrored from sdk/src/resources/webhooks.ts
// — this is the assertion the whole file exists to make: not "is a
// superset present" but "is this EXACTLY the real shape."
const WEBHOOK_SUBSCRIPTION_KEYS = ['id', 'app_id', 'event_type', 'target_url', 'active', 'created_at'].sort();
const CREATED_WEBHOOK_SUBSCRIPTION_KEYS = [...WEBHOOK_SUBSCRIPTION_KEYS, 'secret', 'warning'].sort();
const WEBHOOK_DELIVERY_KEYS = [
  'id',
  'subscription_id',
  'event_id',
  'event_type',
  'idempotency_key',
  'attempt_number',
  'status',
  'response_status',
  'response_excerpt',
  'latency_ms',
  'next_attempt_at',
  'replayed_from_id',
  'created_at',
].sort();

describe('TRO-599: WebhooksClient against a real running Ship API + the seeded worktree DB', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let server: import('http').Server | undefined;
  let stubTarget: http.Server | undefined;
  let baseUrl: string;
  let targetUrl: string;

  let originalEncryptionKey: string | undefined;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let oauthAppId: string | undefined;
  let token: string;
  let subscriptionId: string;
  /** Fully-populated 'success' row — every nullable field non-null — proves
   *  listDeliveries() surfaces ALL of them, not just the always-present ones. */
  let seededDeliveryId: string;
  /** A 'dead' row — proves the real status literal, catching exactly the
   *  'dead' vs the SDK's old guessed 'dead_letter' mismatch TRO-599 fixes. */
  let deadDeliveryId: string;
  /** A 'pending' row this suite actually REPLAYS live, over a real TCP round
   *  trip to `stubTarget` below. */
  let replaySourceDeliveryId: string;

  beforeAll(async () => {
    originalEncryptionKey = process.env[SECRET_ENCRYPTION_KEY_ENV];
    process.env[SECRET_ENCRYPTION_KEY_ENV] = crypto.randomBytes(32).toString('hex');

    // A tiny local HTTP target for replayDelivery()'s real outbound POST —
    // no external network dependency, deterministic, fast. Always answers
    // 200, so a replay against it always lands on 'success'.
    const stub = http.createServer((req, res) => {
      req.on('data', () => {
        // Drain the body; content is irrelevant to this stub.
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
    stubTarget = stub;
    const stubAddress = stub.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${stubAddress.port}/hook`;

    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`TRO-599 sdk webhooks test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'TRO-599 SDK Webhooks User', $2) RETURNING id`,
      [`tro599-sdk-webhooks-${runId}@ship.local`, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    const appResult = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, is_first_party)
       VALUES ($1, $2, $3, 'confidential', true) RETURNING id`,
      [workspaceId, `TRO-599 sdk webhooks app ${runId}`, `ship_app_tro599_${runId}`]
    );
    oauthAppId = insertedId(appResult.rows, 'oauth app');

    const rawToken = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `TRO-599 sdk webhooks token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(rawToken),
        rawToken.slice(0, 12),
        ['webhooks:manage'],
      ]
    );
    token = rawToken;

    const ciphertext = encryptSecret('whsec_tro599_test_secret');

    const subResult = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, event_type, target_url, signing_secret_ciphertext, active)
       VALUES ($1, 'document.created', $2, $3, true) RETURNING id`,
      [oauthAppId, targetUrl, ciphertext]
    );
    subscriptionId = insertedId(subResult.rows, 'webhook subscription');

    const successResult = await pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number,
          status, response_status, response_excerpt, latency_ms, next_attempt_at)
       VALUES ($1, gen_random_uuid(), 'document.created', $2::jsonb, $3, 1,
               'success', 200, 'ok', 42, NULL)
       RETURNING id`,
      [subscriptionId, JSON.stringify({ hello: 'world' }), `idem_${runId}_success`]
    );
    seededDeliveryId = insertedId(successResult.rows, 'success delivery');

    const deadResult = await pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number,
          status, response_status, response_excerpt, latency_ms, next_attempt_at)
       VALUES ($1, gen_random_uuid(), 'document.created', $2::jsonb, $3, 1,
               'dead', 410, 'gone', 12, NULL)
       RETURNING id`,
      [subscriptionId, JSON.stringify({ hello: 'world' }), `idem_${runId}_dead`]
    );
    deadDeliveryId = insertedId(deadResult.rows, 'dead delivery');

    const replaySourceResult = await pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status)
       VALUES ($1, gen_random_uuid(), 'document.created', $2::jsonb, $3, 1, 'pending')
       RETURNING id`,
      [subscriptionId, JSON.stringify({ hello: 'world' }), `idem_${runId}_replay_source`]
    );
    replaySourceDeliveryId = insertedId(replaySourceResult.rows, 'replay-source delivery');

    const app = createApp();
    const liveServer = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      liveServer.once('listening', () => resolve());
      liveServer.once('error', reject);
    });
    const port = (liveServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    server = liveServer;
  }, 30_000);

  afterAll(async () => {
    try {
      if (server) {
        const liveServer = server;
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
      if (stubTarget) {
        const stub = stubTarget;
        await new Promise<void>((resolve) => stub.close(() => resolve()));
      }
    } finally {
      try {
        if (subscriptionId) {
          await pool.query('DELETE FROM webhook_deliveries WHERE subscription_id = $1', [subscriptionId]);
          await pool.query('DELETE FROM webhook_subscriptions WHERE id = $1', [subscriptionId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
        }
        if (oauthAppId) {
          await pool.query('DELETE FROM oauth_apps WHERE id = $1', [oauthAppId]);
        }
        if (userId) {
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        if (originalEncryptionKey === undefined) {
          delete process.env[SECRET_ENCRYPTION_KEY_ENV];
        } else {
          process.env[SECRET_ENCRYPTION_KEY_ENV] = originalEncryptionKey;
        }
        await pool.end();
      }
    }
  }, 30_000);

  it("listSubscriptions() returns the seeded subscription with EXACTLY WebhookSubscription's real fields", async () => {
    const client = new ShipClient({ token, baseUrl });

    const page = await client.webhooks.listSubscriptions({ limit: 100 });
    const found = page.data.find((s) => s.id === subscriptionId);
    expect(found, 'seeded subscription not found in listSubscriptions() page').toBeDefined();
    if (!found) return;

    expect(actualKeys(found)).toEqual(WEBHOOK_SUBSCRIPTION_KEYS);
    expect(found).toMatchObject({
      id: subscriptionId,
      app_id: oauthAppId,
      event_type: 'document.created',
      target_url: targetUrl,
      active: true,
    });
    expect(typeof found.created_at).toBe('string');
  });

  it("getSubscription() returns EXACTLY WebhookSubscription's real fields, never a secret or updated_at", async () => {
    const client = new ShipClient({ token, baseUrl });

    const subscription = await client.webhooks.getSubscription(subscriptionId);

    expect(actualKeys(subscription)).toEqual(WEBHOOK_SUBSCRIPTION_KEYS);
    expect('secret' in subscription).toBe(false);
    expect('updated_at' in subscription).toBe(false);
    expect('url' in subscription).toBe(false);
    expect('events' in subscription).toBe(false);
  });

  it("rotateSecret() returns EXACTLY CreatedWebhookSubscription's real fields, including 'warning' (the second, unnamed field TRO-599 fixed)", async () => {
    const client = new ShipClient({ token, baseUrl });

    const rotated = await client.webhooks.rotateSecret(subscriptionId);

    expect(actualKeys(rotated)).toEqual(CREATED_WEBHOOK_SUBSCRIPTION_KEYS);
    expect(rotated.secret.startsWith('whsec_')).toBe(true);
    expect(typeof rotated.warning).toBe('string');
    expect(rotated.warning.length).toBeGreaterThan(0);
  });

  it("listDeliveries() returns EXACTLY WebhookDelivery's real fields, and the real 'dead' status literal (not the old guessed 'dead_letter')", async () => {
    const client = new ShipClient({ token, baseUrl });

    const page = await client.webhooks.listDeliveries({ subscription_id: subscriptionId, limit: 100 });

    const success = page.data.find((d) => d.id === seededDeliveryId);
    expect(success, 'seeded success delivery not found in listDeliveries() page').toBeDefined();
    if (success) {
      expect(actualKeys(success)).toEqual(WEBHOOK_DELIVERY_KEYS);
      expect(success).toMatchObject({
        subscription_id: subscriptionId,
        event_type: 'document.created',
        status: 'success',
        response_status: 200,
        response_excerpt: 'ok',
        latency_ms: 42,
        next_attempt_at: null,
        replayed_from_id: null,
      });
      expect(typeof success.event_id).toBe('string');
      expect(typeof success.idempotency_key).toBe('string');
    }

    const dead = page.data.find((d) => d.id === deadDeliveryId);
    expect(dead, 'seeded dead delivery not found in listDeliveries() page').toBeDefined();
    if (dead) {
      expect(actualKeys(dead)).toEqual(WEBHOOK_DELIVERY_KEYS);
      // The exact assertion TRO-599 exists to make: the real value is
      // 'dead'. A client built against the pre-fix SDK type, checking
      // `=== 'dead_letter'`, would never have matched this real row.
      expect(dead.status).toBe('dead');
    }
  });

  it("replayDelivery() re-runs a REAL HTTP attempt against a real local target and returns the new row with EXACTLY WebhookDelivery's real fields", async () => {
    const client = new ShipClient({ token, baseUrl });

    const replayed = await client.webhooks.replayDelivery(replaySourceDeliveryId);

    expect(actualKeys(replayed)).toEqual(WEBHOOK_DELIVERY_KEYS);
    expect(replayed.replayed_from_id).toBe(replaySourceDeliveryId);
    expect(replayed.subscription_id).toBe(subscriptionId);
    // The stub target (this file's own beforeAll) always answers 200, so a
    // real end-to-end attempt against it lands on 'success' — this is a
    // genuine round trip, not a fixture standing in for one.
    expect(replayed.status).toBe('success');
    expect(replayed.response_status).toBe(200);
    expect(typeof replayed.response_excerpt).toBe('string');
    expect(typeof replayed.latency_ms).toBe('number');
    expect(replayed.next_attempt_at).toBeNull();
  });

  it('a non-2xx response still maps to a ShipSdkError through webhooks, same as ShipClient.me() (missing scope)', async () => {
    const rawToken = `ship_${crypto.randomBytes(24).toString('hex')}`;
    const noScopeUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'TRO-599 SDK No-Scope User', $2) RETURNING id`,
      [`tro599-sdk-webhooks-noscope-${runId}@ship.local`, workspaceId]
    );
    const noScopeUserId = insertedId(noScopeUserResult.rows, 'no-scope user');
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        noScopeUserId,
        workspaceId,
        `TRO-599 sdk webhooks no-scope token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(rawToken),
        rawToken.slice(0, 12),
        [],
      ]
    );

    try {
      const client = new ShipClient({ token: rawToken, baseUrl });
      await expect(client.webhooks.listSubscriptions()).rejects.toMatchObject({
        kind: 'forbidden',
        httpStatus: 403,
      });
    } finally {
      await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [noScopeUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [noScopeUserId]);
    }
  });
});
