/**
 * TRO-439 / PF-503 — the developer portal's Deliveries & DLQ view + replay
 * button, narrated end-to-end. This is the ticket's own literal AC:
 * "Playwright: force a failure, see it in DLQ, replay against healthy
 * target, watch it succeed." A second test in this file covers subscription
 * CRUD (create/list/delete), the architect note's lower-priority half.
 *
 * ── Forcing 6 consecutive failures without real wall-clock retries ──
 *
 * `api/src/platform/webhooks/deliverer.ts`'s real retry schedule is 1s, 4s,
 * 16s, 1m, 5m — driving 6 attempts through that schedule for real would make
 * this test take minutes and depend on the production polling loop's exact
 * timing, which is what this ticket's own brief explicitly says not to rely
 * on ("reuse or adapt the existing deterministic-failure test mechanism,
 * don't rely on real wall-clock retries"). The deliverer's own retry/backoff
 * math is ALREADY proven correct at the unit tier
 * (`api/src/platform/webhooks/__tests__/deliverer.test.ts`, injected-clock
 * `advance()`/`processDue()` loop) — this test's job is different: prove the
 * PORTAL shows a dead-lettered delivery and that clicking Replay in the real
 * UI drives a real HTTP round trip through the real replay route and real
 * deliverer. So the 6-row attempt chain is seeded directly via SQL, in the
 * exact shape `webhook_deliveries`' row-per-attempt schema documents
 * (migration 048's own header) — the same "seed directly, prove the
 * DOWNSTREAM behavior for real" split
 * `sdk/src/__tests__/webhooks.liveServer.test.ts` already uses for the
 * identical reason (see that file's own header).
 *
 * ── The reference subscriber ──
 *
 * `createReferenceSubscriber()` (`docs/submission/demo-webhook-listener.mjs`)
 * — the SAME real, standalone, signature-verifying HTTP listener
 * `e2e/webhook-idempotency-key-drill.spec.ts` uses, not a one-off double.
 * It always answers 2xx, so it plays the "now-healthy target" the replay
 * step needs. Real socket, real HMAC verification, real Idempotency-Key
 * header inspection — not a mocked fetch.
 *
 * ── Determinism ──
 *
 * No real sleeps anywhere in this file. The seed is synchronous SQL, and
 * every UI assertion below is an auto-retrying Playwright `expect(...)`,
 * per `e2e/AGENTS.md`.
 */
import { test, expect } from './fixtures/isolated-env';
import { Pool } from 'pg';
import crypto from 'crypto';
import getPort from 'get-port';
import type { createReferenceSubscriber as CreateReferenceSubscriberType } from '../docs/submission/demo-webhook-listener.d.mts';
import { verify } from '../api/src/platform/webhooks/signer.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface SeededPrincipal {
  workspaceId: string;
  appId: string;
  bearerToken: string;
}

/** Same shape as `webhook-idempotency-key-drill.spec.ts`'s own
 * `seedWebhookPrincipal` (that file's own comment explains the
 * `users.last_workspace_id` resolution this relies on) — duplicated locally
 * rather than imported, since that file exports nothing and this repo's
 * e2e specs don't share test-only helper modules across files beyond
 * `fixtures/test-helpers.ts`. `namePrefix` keeps each test's app uniquely
 * named/findable when this worker's DB is reused across tests in this file. */
async function seedWebhookPrincipal(dbUrl: string, namePrefix: string): Promise<SeededPrincipal> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const workspaceResult = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`
    );
    const [workspace] = workspaceResult.rows;
    if (!workspace) throw new Error('seedMinimalTestData should have created a workspace');

    const userResult = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'dev@ship.local'`);
    const [user] = userResult.rows;
    if (!user) throw new Error('seedMinimalTestData should have created dev@ship.local');

    const clientId = `ship_app_e2e_${namePrefix}_${crypto.randomBytes(6).toString('hex')}`;
    const appResult = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type)
       VALUES ($1, $2, $3, 'confidential') RETURNING id`,
      [workspace.id, `TRO-439 E2E ${namePrefix} App`, clientId]
    );
    const [app] = appResult.rows;
    if (!app) throw new Error('seed insertOauthApp produced no row');

    const rawToken = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, workspace.id, `TRO-439 E2E ${namePrefix} token`, sha256Hex(rawToken), rawToken.slice(0, 12), ['webhooks:manage']]
    );

    return { workspaceId: workspace.id, appId: app.id, bearerToken: rawToken };
  } finally {
    await pool.end();
  }
}

interface WebhookSubscriptionCreateBody {
  id: string;
  secret: string;
}

function requireWebhookSubscriptionCreateBody(body: unknown): WebhookSubscriptionCreateBody {
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.secret !== 'string') {
    throw new Error(`expected { id, secret } from POST /api/v1/webhooks, got: ${JSON.stringify(body)}`);
  }
  return { id: b.id, secret: b.secret };
}

/** Seeds a 6-row dead-lettered delivery chain directly against
 * `webhook_deliveries` (migration 048), matching the exact terminal-row
 * shape `deliverer.ts`'s own `attempt()` produces for a retryable failure
 * (`status='failed'`, `response_status=500`) followed by the 6th attempt's
 * DLQ outcome (`status='dead'`, no `next_attempt_at`) — see this file's own
 * header for why this is seeded rather than driven through real retries.
 * Every row shares one `event_id`/`idempotency_key` — the real deliverer's
 * own row-per-attempt contract for a single logical delivery. */
async function seedDeadLetteredDeliveryChain(
  dbUrl: string,
  subscriptionId: string
): Promise<{ deadDeliveryId: string; idempotencyKey: string }> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const eventId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    let deadDeliveryId = '';

    for (let attemptNumber = 1; attemptNumber <= 6; attemptNumber++) {
      const isFinal = attemptNumber === 6;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO webhook_deliveries
           (subscription_id, event_id, event_type, payload, idempotency_key, attempt_number, status, response_status, response_excerpt, latency_ms, next_attempt_at)
         VALUES ($1, $2, 'document.created', $3::jsonb, $4, $5, $6, 500, 'Internal Server Error', 12, NULL)
         RETURNING id`,
        [
          subscriptionId,
          eventId,
          JSON.stringify({ type: 'document.created', data: { id: crypto.randomUUID() } }),
          idempotencyKey,
          attemptNumber,
          isFinal ? 'dead' : 'failed',
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error(`seed failed to insert attempt ${attemptNumber}`);
      if (isFinal) deadDeliveryId = row.id;
    }

    return { deadDeliveryId, idempotencyKey };
  } finally {
    await pool.end();
  }
}

async function loginAsDevAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill('dev@ship.local');
  await page.getByLabel('Password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });
}

test.describe('Developer portal — Deliveries/DLQ + replay (TRO-439 / PF-503)', () => {
  test('a delivery dead-lettered after 6 attempts is visible in the DLQ view; replay against a healthy target succeeds and preserves the Idempotency-Key', async ({
    page,
    apiServer,
    dbContainer,
  }) => {
    const { createReferenceSubscriber }: { createReferenceSubscriber: typeof CreateReferenceSubscriberType } =
      await import('../docs/submission/demo-webhook-listener.mjs');

    const { appId, bearerToken } = await seedWebhookPrincipal(dbContainer.getConnectionUri(), 'dlq');
    const port = await getPort();

    const createRes = await page.request.post(`${apiServer.url}/api/v1/webhooks`, {
      headers: { authorization: `Bearer ${bearerToken}` },
      data: { app_id: appId, event_type: 'document.created', target_url: `http://127.0.0.1:${port}/` },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = requireWebhookSubscriptionCreateBody(await createRes.json());

    // The reference subscriber is bound now and stays healthy (always 2xx)
    // for the whole test — it plays the "now-healthy target" the replay
    // step sends to. Nothing before the replay click ever hits it (the DLQ
    // chain below is seeded directly, not delivered for real).
    const subscriber = createReferenceSubscriber({ secret: created.secret, verify });
    const boundPort = await subscriber.listen(port);
    expect(boundPort).toBe(port);

    try {
      const { deadDeliveryId, idempotencyKey } = await seedDeadLetteredDeliveryChain(
        dbContainer.getConnectionUri(),
        created.id
      );

      await loginAsDevAdmin(page);
      await page.goto('/developer/webhooks');

      // Deliveries & DLQ is the default tab (architect's note: build this
      // before subscription CRUD).
      await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();

      // Filter to the DLQ (status = dead) and find THIS test's row by id —
      // asserting presence, not an exact total count, since this worker's
      // DB is shared across tests/files (per isolated-env.ts's worker-scoped
      // fixtures).
      await page.getByLabel(/filter by status/i).selectOption('dead');
      const dlqRow = page.locator(`[data-testid="delivery-row"][data-delivery-id="${deadDeliveryId}"]`);
      await expect(dlqRow).toBeVisible({ timeout: 15000 });
      await expect(dlqRow.getByText('Dead (DLQ)')).toBeVisible();
      await expect(dlqRow).toHaveAttribute('data-delivery-status', 'dead');

      // ── Replay against the now-healthy target ──
      await dlqRow.getByRole('button', { name: /replay/i }).click();

      // A NEW row appears — the replay's own delivery row, status success,
      // sharing the SAME idempotency key as the original (this ticket's own
      // AC: "original Idempotency-Key preserved").
      const successRow = page.locator('[data-testid="delivery-row"]', { hasText: 'Success' }).filter({
        has: page.locator(`[title="${idempotencyKey}"]`),
      });
      await expect(successRow.first()).toBeVisible({ timeout: 15000 });
      await expect(successRow.first()).toHaveAttribute('data-delivery-status', 'success');

      // Both rows show the identical idempotency key text in the UI.
      const originalKeyText = await dlqRow.locator(`[title="${idempotencyKey}"]`).textContent();
      const replayedKeyText = await successRow.first().locator(`[title="${idempotencyKey}"]`).textContent();
      expect(originalKeyText).toBe(replayedKeyText);

      // ── Confirm it's a real HTTP round trip, not just a DB-status flip:
      // the reference subscriber actually received it, with the ORIGINAL
      // Idempotency-Key header, verified via the real Ship-Signature check. ──
      await expect.poll(() => subscriber.wasProcessed(idempotencyKey), { timeout: 15000, intervals: [200, 500, 1000] }).toBe(
        true
      );
      expect(subscriber.deliveries.get(idempotencyKey)).toBeDefined();
    } finally {
      await subscriber.close();
      await page.request.delete(`${apiServer.url}/api/v1/webhooks/${created.id}`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
    }
  });

  test('subscription CRUD from the portal UI: create, list, delete', async ({ page, apiServer, dbContainer }) => {
    const { appId } = await seedWebhookPrincipal(dbContainer.getConnectionUri(), 'crud');
    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    const targetUrl = `https://example.com/hook-${uniqueSuffix}`;

    await loginAsDevAdmin(page);
    await page.goto('/developer/webhooks');
    await page.getByRole('button', { name: /subscriptions/i }).click();

    // The app seeded above is selectable in the picker (reads the real,
    // existing `GET /api/oauth-apps` — TRO-436/PF-502's own app-registration
    // UI is not required for this to work, only for CREATING new apps).
    await expect(page.getByLabel(/^app$/i)).toBeVisible({ timeout: 15000 });
    await page.getByLabel(/^app$/i).selectOption({ label: 'TRO-439 E2E crud App' });
    await page.getByLabel(/event type/i).selectOption('issue.created');
    await page.getByLabel(/target url/i).fill(targetUrl);
    await page.getByRole('button', { name: /create subscription/i }).click();

    // The secret is shown exactly once — real `POST /api/v1/webhooks`
    // contract — through the shared `ShownOnceSecretModal` (PF-502/TRO-436),
    // the same shown-once UX app registration/secret rotation use.
    await expect(page.getByText('Save your signing secret')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/^whsec_/)).toBeVisible();
    // Close it — EVERY dismissal path on this shared modal (including this
    // button) routes through a second "Close without saving?" confirmation
    // by design (`ShownOnceSecretModal.tsx`'s own header: "warn before close
    // unconditionally"), so a real close is two clicks, not one. The modal's
    // overlay blocks interaction with the row underneath until dismissed.
    await page.getByRole('button', { name: /I've saved it/i }).click();
    await expect(page.getByText('Close without saving?')).toBeVisible();
    await page.getByRole('button', { name: /close anyway/i }).click();
    await expect(page.getByText('Save your signing secret')).not.toBeVisible();

    // It appears in the list.
    const row = page.locator('[data-testid="subscription-row"]', { hasText: targetUrl });
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    // Delete it — the real DELETE /:id route (deactivates, per that route's
    // own documented semantics), and the row reflects Inactive rather than
    // disappearing (matches `serializeSubscription`'s own soft-delete
    // contract, same as `WorkspaceSettings.tsx`'s API tokens table showing
    // revoked tokens instead of removing them).
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await row.getByRole('button', { name: /delete/i }).click();
    await expect(row.getByText('Inactive')).toBeVisible({ timeout: 15000 });
  });

});
