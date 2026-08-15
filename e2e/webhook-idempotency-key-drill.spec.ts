/**
 * TRO-447 / PF-801 — the Idempotency-Key drill, narrated end-to-end: deliver
 * a real webhook -> replay it via the real API -> a real reference
 * subscriber (a small, standalone HTTP listener, not a mocked `fetch`)
 * recognizes the replay's `Idempotency-Key` as the SAME one the original
 * delivery carried and dedupes it -> the delivery log shows two distinct
 * rows for one logical delivery.
 *
 * ── What already existed, and what this file proves ──
 *
 * TRO-442/PF-305 (delivery log, `GET /api/v1/webhooks/deliveries`) and
 * TRO-446/PF-306 (replay, `POST /api/v1/webhooks/deliveries/:id/replay`) are
 * both already merged and already covered at the vitest/supertest tier
 * (`api/src/platform/api/v1/resources/__tests__/webhooks.test.ts`) — that
 * file's own "replays a successful delivery" test already proves the replay
 * route reuses the original `idempotency_key` at the DB-column level. What
 * had never been proven, before this ticket: that a REAL subscriber process,
 * listening on a REAL socket, receiving the ACTUAL wire traffic the real
 * deliverer sends (not a stubbed `fetch`), sees the identical key twice and
 * genuinely dedupes on it — the literal "reference subscriber (test
 * fixture) dedupes on the key" AC. That gap is what this file closes.
 *
 * ── What this file is, and is not, proof of ──
 *
 * Per `ship-qa`/lessons.md rule 13: `e2e/*.spec.ts` sits outside both
 * vitest configs (`api/vitest.config.ts` pins `include: ['src/**\/*.test.ts']`),
 * so `gate.sh` never EXECUTES this file even though it counts toward the
 * gate's "regression test added" grep. The gate-executed proof for this
 * ticket is the "PF-801" describe block appended to
 * `webhooks.test.ts` above — same reference-subscriber fixture, same core
 * assertion (the SAME Idempotency-Key on both real HTTP calls), exercised at
 * the tier the gate actually runs. This file is ADDITIVE, real-browser,
 * real-process coverage of the identical story, matching this repo's
 * existing convention for a narrated end-to-end "drill"
 * (`e2e/oauth-pkce-chain.spec.ts`, `e2e/oauth-refresh-rotation-stolen-token.spec.ts`
 * — this file follows their structure closely: real login via `page`, real
 * HTTP calls via `page.request` for the backend-to-backend hops, no mocking
 * anywhere in the chain).
 *
 * ── The reference subscriber ──
 *
 * `createReferenceSubscriber()` (`docs/submission/demo-webhook-listener.mjs`)
 * is a genuine, standalone, copyable reference implementation of the
 * subscriber-dedupe contract documented in `docs/architecture.md` — the SAME
 * function this repo's CLI demo script and its own vitest coverage both use,
 * not a one-off test double reinvented here. It verifies `Ship-Signature`
 * via `signer.ts`'s real `verify()` (byte-identical to the SDK's
 * `verifyWebhook()` the CLI demo injects instead — see that file's own
 * header for why both exist) and tracks every `Idempotency-Key` it has seen,
 * in memory, for the lifetime of this one test.
 *
 * ── Determinism ──
 *
 * No real sleeps. The fresh delivery is genuinely asynchronous — the
 * production deliverer's polling loop (`InMemoryWebhookDeliverer.start()`,
 * wired only from `api/src/index.ts`, the real entrypoint `apiServer`
 * spawns as `dist/index.js`) ticks on a real 1s interval — so this test
 * awaits the OBSERVABLE event (the reference subscriber actually having
 * recorded a delivery, and the delivery log actually showing the row) via
 * `expect.poll`, the same pattern `e2e/features-real.spec.ts` already
 * establishes in this repo, never `page.waitForTimeout()`.
 */
import { test, expect } from './fixtures/isolated-env';
import { Pool } from 'pg';
import crypto from 'crypto';
import getPort from 'get-port';
// The reference-subscriber fixture (PF-801 / TRO-447) — see this file's own
// header, and that module's own header, for why this is the SAME
// implementation the CLI demo and the vitest coverage both use.
//
// Loaded via a runtime `import()` (below, inside the test body) rather than
// a static top-level `import` — this repo's root `package.json` has no
// `"type": "module"`, so Playwright's own transform loads a `.spec.ts` file
// via `require()` and runs every statically-imported module (including a
// genuine `.mjs` one) through its CJS-oriented babel/pirates hook, which
// mismatches with real ESM `export` syntax and crashes with `ReferenceError:
// exports is not defined`. A genuine dynamic `import()` bypasses that hook
// entirely (Node's own loader, not pirates' `require()` interception) and
// loads the real ESM module correctly. Confirmed the hard way: the first
// version of this file used a static top-level import here and failed with
// exactly that error on every run.
import type { createReferenceSubscriber as CreateReferenceSubscriberType } from '../docs/submission/demo-webhook-listener.d.mts';
// signer.ts's OWN verify() — not the SDK's verifyWebhook() — so this suite
// never needs `pnpm --filter @ship/sdk build` as a hidden prerequisite (see
// demo-webhook-listener.mjs's own header for why both exist and are
// byte-identical).
import { verify } from '../api/src/platform/webhooks/signer.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface SeededPrincipal {
  workspaceId: string;
  appId: string;
  bearerToken: string;
}

/** Seeds an oauth app + a `webhooks:manage`-scoped personal token, both
 * bound to the SAME workspace the seeded `dev@ship.local` admin user
 * belongs to — the document creation this test triggers below publishes
 * `document.created` for THAT workspace, so the subscription's own
 * `oauth_apps.workspace_id` has to match it for `enqueueEvent()`'s matcher
 * to find it (`platform/webhooks/deliverer.ts`'s own `WHERE ... a.workspace_id
 * = $2` join). Personal-token workspace resolution reads
 * `users.last_workspace_id` (`workspaceContext.ts`'s own header), which
 * `seedMinimalTestData` already sets for `dev@ship.local` — no separate user
 * needs seeding here, unlike the vitest describe block's own isolated-user
 * setup (that file's DB is shared across many describe blocks in one
 * process; this test's Postgres container is this worker's alone). */
async function seedWebhookPrincipal(dbUrl: string): Promise<SeededPrincipal> {
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

    const clientId = `ship_app_e2e_idem_${crypto.randomBytes(6).toString('hex')}`;
    const appResult = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type)
       VALUES ($1, 'TRO-447 E2E Idempotency-Key Drill App', $2, 'confidential') RETURNING id`,
      [workspace.id, clientId]
    );
    const [app] = appResult.rows;
    if (!app) throw new Error('seed insertOauthApp produced no row');

    const rawToken = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, workspace.id, 'TRO-447 E2E token', sha256Hex(rawToken), rawToken.slice(0, 12), ['webhooks:manage']]
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

interface DeliveryBody {
  id: string;
  idempotency_key: string;
  status: string;
  replayed_from_id: string | null;
}

interface DeliveryListBody {
  data: DeliveryBody[];
}

function requireDeliveryBody(body: unknown): DeliveryBody {
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || typeof b.idempotency_key !== 'string' || typeof b.status !== 'string') {
    throw new Error(`expected a delivery row, got: ${JSON.stringify(body)}`);
  }
  return {
    id: b.id,
    idempotency_key: b.idempotency_key,
    status: b.status,
    replayed_from_id: typeof b.replayed_from_id === 'string' ? b.replayed_from_id : null,
  };
}

function requireDeliveryListBody(body: unknown): DeliveryListBody {
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.data)) {
    throw new Error(`expected { data: [...] } from GET /api/v1/webhooks/deliveries, got: ${JSON.stringify(body)}`);
  }
  // Validated per-element via requireDeliveryBody (CodeRabbit, this ticket's
  // review) — the previous `as DeliveryBody[]` cast declared a shape the
  // code never checked, so a changed API response would surface later as a
  // confusing assertion failure on an undefined field instead of a clear
  // parse error here.
  return { data: b.data.map(requireDeliveryBody) };
}

test.describe('Webhook Idempotency-Key drill (TRO-447 / PF-801)', () => {
  test('deliver -> replay via API -> reference subscriber dedupes on the key; delivery log distinguishes fresh vs replayed', async ({
    page,
    apiServer,
    dbContainer,
  }) => {
    // Dynamic import — see this file's own import-comment above for why a
    // static import of this `.mjs` module crashes under Playwright's loader.
    const { createReferenceSubscriber }: { createReferenceSubscriber: typeof CreateReferenceSubscriberType } =
      await import('../docs/submission/demo-webhook-listener.mjs');

    const { appId, bearerToken } = await seedWebhookPrincipal(dbContainer.getConnectionUri());

    // Reserve a port BEFORE creating the subscription — target_url has to
    // name it, and the API returns the signing secret only once, so the
    // subscription has to be created before the reference subscriber (which
    // needs that secret) can be constructed. Bind the subscriber to this
    // exact port afterward.
    const port = await getPort();

    // ── Chapter 1: create the subscription via the real API, capturing the
    // plaintext secret (shown exactly once, per POST /api/v1/webhooks's own
    // contract) ──
    const createRes = await page.request.post(`${apiServer.url}/api/v1/webhooks`, {
      headers: { authorization: `Bearer ${bearerToken}` },
      data: { app_id: appId, event_type: 'document.created', target_url: `http://127.0.0.1:${port}/` },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = requireWebhookSubscriptionCreateBody(await createRes.json());
    const subscriptionId = created.id;

    // ── Start the reference subscriber — a REAL, standalone HTTP listener,
    // not a mocked fetch. See this file's own header for what it is and why
    // it's the same fixture the CLI demo and the vitest coverage use. ──
    const subscriber = createReferenceSubscriber({ secret: created.secret, verify });
    const boundPort = await subscriber.listen(port);
    expect(boundPort).toBe(port);

    try {
      // ── Chapter 2: log in as the real seeded admin, then trigger a REAL
      // delivery (a fresh Idempotency-Key) by creating a document through
      // the real app — this is what publishes `document.created`, which the
      // real, already-running deliverer picks up and sends, over a real
      // socket, to the reference subscriber above. ──
      await page.goto('/login');
      // Accessible role locators (CodeRabbit, this ticket's review) — both
      // inputs have a real, associated `<label>` (Login.tsx: "Email
      // address" / "Password", screen-reader-only but still exposed to the
      // accessibility tree), matching this repo's own coding guideline of
      // preferring getByRole/getByLabel over CSS id selectors.
      await page.getByLabel('Email address').fill('dev@ship.local');
      await page.getByLabel('Password').fill('admin123');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).not.toHaveURL('/login', { timeout: 5000 });

      const csrfRes = await page.request.get(`${apiServer.url}/api/csrf-token`);
      expect(csrfRes.ok(), await csrfRes.text()).toBe(true);
      const csrfBody = (await csrfRes.json()) as Record<string, unknown>;
      if (typeof csrfBody.token !== 'string') {
        throw new Error(`expected { token } from GET /api/csrf-token, got: ${JSON.stringify(csrfBody)}`);
      }
      const csrfToken = csrfBody.token;

      // Empty body -> document_type 'wiki', title 'Untitled' (this repo's
      // own default-title convention) — this test only needs the event to
      // fire, not any particular document content.
      const docRes = await page.request.post(`${apiServer.url}/api/documents`, {
        headers: { 'x-csrf-token': csrfToken },
        data: {},
      });
      expect(docRes.status(), await docRes.text()).toBe(201);

      // ── Confirm the reference subscriber actually processed it — a fresh
      // key, not a duplicate. Real async delivery: poll for the observable
      // event, never a fixed sleep (per this repo's own e2e conventions,
      // `e2e/AGENTS.md`). ──
      await expect
        .poll(() => subscriber.deliveries.size, { timeout: 15000, intervals: [200, 500, 1000] })
        .toBeGreaterThanOrEqual(1);
      expect(subscriber.deliveries.size, 'expected exactly one delivery for this fresh subscription').toBe(1);
      const [freshKey] = [...subscriber.deliveries.keys()];
      if (!freshKey) throw new Error('expected the reference subscriber to have recorded a delivery key');
      expect(subscriber.wasDeduped(freshKey), 'the FIRST delivery of a key must never be seen as a duplicate').toBe(
        false
      );

      // ── Confirm via GET /deliveries that the delivery log shows the fresh
      // row, with the SAME key the reference subscriber saw. ──
      let originalDelivery: DeliveryBody | undefined;
      await expect
        .poll(
          async () => {
            const res = await page.request.get(
              `${apiServer.url}/api/v1/webhooks/deliveries?subscription_id=${subscriptionId}`,
              { headers: { authorization: `Bearer ${bearerToken}` } }
            );
            expect(res.ok(), await res.text()).toBe(true);
            const listBody = requireDeliveryListBody(await res.json());
            originalDelivery = listBody.data[0];
            return listBody.data.length;
          },
          { timeout: 15000, intervals: [200, 500, 1000] }
        )
        .toBe(1);
      if (!originalDelivery) throw new Error('expected the delivery log to show the fresh delivery');
      expect(originalDelivery.idempotency_key).toBe(freshKey);
      expect(originalDelivery.status).toBe('success');
      expect(originalDelivery.replayed_from_id).toBeNull();

      // ── Chapter 3: replay it via the real API. The route reuses the
      // ORIGINAL idempotency_key — never a freshly generated one. ──
      const replayRes = await page.request.post(
        `${apiServer.url}/api/v1/webhooks/deliveries/${originalDelivery.id}/replay`,
        { headers: { authorization: `Bearer ${bearerToken}` } }
      );
      expect(replayRes.status(), await replayRes.text()).toBe(201);
      const replayBody = requireDeliveryBody(await replayRes.json());
      expect(replayBody.idempotency_key, 'replay must carry the SAME Idempotency-Key, never a fresh one').toBe(
        freshKey
      );
      expect(replayBody.replayed_from_id).toBe(originalDelivery.id);
      expect(replayBody.status).toBe('success');

      // ── Confirm the reference subscriber recognized the SAME key and
      // deduped it — the second real HTTP call, into the same listener,
      // carrying the same header value, was recognized as a duplicate and
      // not reprocessed as a distinct logical delivery. ──
      expect(subscriber.deliveries.size, 'the replay must not create a NEW logical delivery in the subscriber').toBe(
        1
      );
      expect(subscriber.wasDeduped(freshKey)).toBe(true);
      expect(subscriber.deliveries.get(freshKey)?.duplicateCount).toBe(1);

      // ── Confirm via GET /deliveries: TWO distinct rows for this one
      // logical delivery — original and replay, linked via
      // replayed_from_id — even though the reference subscriber only ever
      // genuinely processed one of them. ──
      const finalListRes = await page.request.get(
        `${apiServer.url}/api/v1/webhooks/deliveries?subscription_id=${subscriptionId}`,
        { headers: { authorization: `Bearer ${bearerToken}` } }
      );
      expect(finalListRes.ok(), await finalListRes.text()).toBe(true);
      const finalListBody = requireDeliveryListBody(await finalListRes.json());
      expect(finalListBody.data).toHaveLength(2);

      const replayedRow = finalListBody.data.find((d) => d.id === replayBody.id);
      const originalRow = finalListBody.data.find((d) => d.id === originalDelivery?.id);
      if (!replayedRow || !originalRow) {
        throw new Error(`expected both the original and replay rows in the delivery log, got: ${JSON.stringify(finalListBody)}`);
      }
      expect(replayedRow.replayed_from_id).toBe(originalDelivery.id);
      expect(originalRow.replayed_from_id).toBeNull();
      expect(replayedRow.idempotency_key).toBe(freshKey);
      expect(originalRow.idempotency_key).toBe(freshKey);
    } finally {
      await subscriber.close();
      // Deactivate the subscription (CodeRabbit, this ticket's review) — the
      // production deliverer keeps polling for the rest of this worker's
      // lifetime (it is a real, long-running process, not scoped to this one
      // test), and a still-active subscription pointing at this now-closed
      // port would make any LATER `document.created` event in this same
      // worker fire a real, doomed outbound HTTP attempt at a dead
      // localhost port. The real `DELETE /:id` route, not a raw SQL
      // statement — same reason `TRO-446`'s own regression test uses it:
      // exercises the real deactivation path, not just a DB shortcut.
      await page.request.delete(`${apiServer.url}/api/v1/webhooks/${subscriptionId}`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
    }
  });
});
