import { createServer } from 'http';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables (.env.local takes precedence)
config({ path: join(__dirname, '../.env.local') });
config({ path: join(__dirname, '../.env') });

async function main() {
  // Load secrets from SSM in production (before importing app)
  if (process.env.NODE_ENV === 'production') {
    const { loadProductionSecrets } = await import('./config/ssm.js');
    await loadProductionSecrets();
  }

  // Now import app after secrets are loaded
  const { createApp } = await import('./app.js');
  const { setupCollaboration } = await import('./collaboration/index.js');
  const { installProcessSafetyNet } = await import('./process-safety.js');

  const PORT = process.env.PORT || 3000;
  const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

  // PF-304 (TRO-438) — webhook deliverer: subscribe to the domain event bus
  // and start the retry-schedule polling loop. Deliberately constructed HERE,
  // in the real process entrypoint, and NOT inside `createApp()`/`app.ts` —
  // every test file in this repo calls `createApp()` directly, and a
  // background `setInterval` (or an eager DB query per test-file's
  // `documentService` writes) started from there would run during every
  // `pnpm test` invocation across the whole api suite, not just this
  // feature's own tests. `getEventBus()` is a process-wide module singleton
  // (`platform/webhooks/eventBus.ts`) shared with `documentService.ts`
  // regardless of where the subscription happens, so wiring it here reaches
  // the exact same bus `documentService.publish()` calls in production.
  //
  // TRO-603: moved earlier in this file (used to sit after `createApp()`/
  // `createServer()` below) so the already-constructed, already-`.start()`'d
  // instance can be PASSED INTO `createApp()` a few lines down, instead of
  // each `POST /webhooks/deliveries/:id/replay` request building its own
  // throwaway `InMemoryWebhookDeliverer` whose retry-sibling rows this
  // process's own polling loop could never see (see
  // `app.ts`'s `CreateAppOptions` and `platform/api/v1/resources/webhooks.ts`'s
  // `createWebhooksRouter()` for the full mechanism). Nothing in this block
  // depends on `app`/`server`, so reordering it ahead of them changes nothing
  // else about when it runs.
  const { getEventBus } = await import('./platform/webhooks/eventBus.js');
  const { InMemoryWebhookDeliverer, wireDelivererToEventBus } = await import('./platform/webhooks/deliverer.js');
  const { systemClock } = await import('./platform/webhooks/clock.js');
  const { pool } = await import('./db/client.js');

  // PF-701 (TRO-423) — boot check: guarantee the first-party
  // ship_app_fleetgraph OAuth app exists in a deployed environment, per the
  // PRD's "seeding guaranteed in deployed env (terraform env var + boot
  // check)". Production-only (same NODE_ENV gate as `loadProductionSecrets`
  // above and `app.ts`'s SESSION_SECRET check) — local `pnpm dev` never has
  // FLEETGRAPH_OAUTH_CLIENT_SECRET set, and this must not add log noise or
  // a startup dependency to every engineer's ordinary dev loop.
  //
  // Two states this handles differently, both without ever taking the
  // whole API down:
  //
  // - No workspace exists yet (schema/migrations applied, but `pnpm
  //   db:seed` has never run against this database) — the legitimate
  //   pre-first-seed state on a genuinely fresh database, since the
  //   Docker image's own CMD (`migrate.js && index.js`) never runs
  //   `db:seed` automatically (confirmed: `db:seed` is a separate,
  //   operator-run step per `terraform/render/README.md`'s adoption memo).
  //   Logs an informational line and continues; not an error.
  // - A workspace exists but `seedFirstPartyApp` throws (secret unset) —
  //   this is a REAL misconfiguration: `terraform/render/variables.tf`'s
  //   `fleetgraph_oauth_client_secret` has no default, so `terraform
  //   apply` forces the operator to supply it, meaning the only way to
  //   reach this branch in a real deployment is if the value was removed
  //   from Render's env config after the fact. "Fails loudly" here means
  //   an unmissable `console.error` — deliberately NOT `process.exit`:
  //   crash-looping the entire API (every document, every issue, the
  //   whole web app) over one first-party OAuth app's missing row would be
  //   a strictly worse outcome than a broken agent-identity flow alone,
  //   the same fail-partial-not-fail-total posture `routes/agent.ts`
  //   already takes for its own missing `AGENT_INTERNAL_SECRET` (503s the
  //   agent-proxy routes only, never refuses to boot). The loud log is
  //   what makes this visible to Render's dashboard/logs and to PF-901's
  //   deploy-verification step, without introducing a new single point of
  //   failure for the whole service.
  if (process.env.NODE_ENV === 'production') {
    try {
      const { seedFirstPartyApp } = await import('./platform/oauth/seedFirstPartyApp.js');
      const workspaceResult = await pool.query<{ id: string }>(
        'SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1'
      );
      const workspaceRow = workspaceResult.rows[0];
      if (!workspaceRow) {
        console.log(
          'ship_app_fleetgraph boot check: no workspace exists yet — skipping until the ' +
            'initial `pnpm db:seed` has run.'
        );
      } else {
        const result = await seedFirstPartyApp(pool, workspaceRow.id);
        console.log(
          `ship_app_fleetgraph boot check: ${result.status} (client_id: ${result.clientId})`
        );
      }
    } catch (error) {
      console.error(
        'ship_app_fleetgraph boot check FAILED — the first-party FleetGraph OAuth app could not ' +
          'be seeded/verified. The rest of the API will continue starting, but PF-702+ agent-as-' +
          'platform-citizen reads (Client Credentials grant) will not work until this is fixed. ' +
          'Most likely cause: FLEETGRAPH_OAUTH_CLIENT_SECRET is unset in this environment — check ' +
          'terraform/render/variables.tf\'s `fleetgraph_oauth_client_secret` is actually applied. ' +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const webhookDeliverer = new InMemoryWebhookDeliverer(pool, systemClock);
  // Boot-time crash recovery (docs/architecture.md's "Deliverer crash"
  // section) — restore any attempt that was scheduled but never executed
  // before a prior process exit, before this instance starts serving. A
  // failed recovery scan (e.g. the database is briefly unreachable right at
  // boot) must not prevent the API from starting at all (CodeRabbit, this PR
  // review) — every already-persisted `webhook_deliveries` row survives
  // regardless, and the next successful `rehydrate()` (a future restart)
  // picks up whatever this one missed.
  try {
    const restoredCount = await webhookDeliverer.rehydrate();
    console.log(`webhook deliverer: rehydrated ${restoredCount} pending attempt(s)`);
  } catch (error) {
    console.error('webhook deliverer: rehydrate() failed at boot; continuing without recovery', error);
  }
  wireDelivererToEventBus(webhookDeliverer, getEventBus());
  webhookDeliverer.start();

  // PF-804 (TRO-453, STRETCH) — GitHub App integration. Both directions are
  // OPT-IN via env var: a deployment that has not had a human register a real
  // GitHub App (see `platform/github/README.md` for exactly what that
  // requires) simply doesn't get the route mounted / the outbound subscriber
  // wired, rather than booting into a broken or unsafe default. Same
  // fail-partial posture `routes/agent.ts`'s `AGENT_INTERNAL_SECRET` check
  // and the `ship_app_fleetgraph` boot check above already establish: a
  // missing third-party integration credential narrows what works, it never
  // takes down the rest of the API.
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const githubShipWorkspaceId = process.env.GITHUB_SHIP_WORKSPACE_ID;
  const githubAppOptions =
    githubWebhookSecret && githubShipWorkspaceId
      ? { webhookSecret: githubWebhookSecret, shipWorkspaceId: githubShipWorkspaceId }
      : undefined;
  if (!githubAppOptions) {
    console.log(
      'github integration: GITHUB_WEBHOOK_SECRET / GITHUB_SHIP_WORKSPACE_ID not set — ' +
        'POST /api/github/webhook is not mounted (see api/src/platform/github/README.md).'
    );
  }

  const githubAppId = process.env.GITHUB_APP_ID;
  const githubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (githubAppId && githubPrivateKey) {
    const { wireGithubPostBack } = await import('./platform/github/wirePostBack.js');
    wireGithubPostBack(getEventBus(), pool, { appId: githubAppId, privateKey: githubPrivateKey });
    console.log('github integration: issue.status_changed -> GitHub PR comment post-back wired.');
  } else {
    console.log(
      'github integration: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set — status-change ' +
        'post-back to linked GitHub PRs is disabled (see api/src/platform/github/README.md).'
    );
  }

  // TRO-603: pass the real, already-`.start()`'d singleton into `createApp()`
  // — see the long comment on the deliverer construction above for why this
  // whole block now runs before `createApp()`/`createServer()` rather than
  // after them.
  const app = createApp(CORS_ORIGIN, { webhookDeliverer, github: githubAppOptions });
  const server = createServer(app);

  // Stop the deliverer's polling loop on shutdown (CodeRabbit, this PR
  // review) — without this, `webhookDeliverer.start()`'s `setInterval` could
  // fire and begin a new delivery attempt after the process has already
  // decided to exit. Scoped deliberately to just the deliverer: this
  // codebase has no broader graceful-shutdown sequence anywhere today (no
  // existing SIGTERM/SIGINT handler, no HTTP-server drain) for this to slot
  // into, and building one is a separate, much larger concern than this
  // ticket's own scope.
  const stopWebhookDeliverer = (signal: NodeJS.Signals) => {
    console.log(`${signal} received: stopping webhook deliverer polling loop`);
    webhookDeliverer.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stopWebhookDeliverer);
  process.on('SIGINT', stopWebhookDeliverer);

  // TRO-276 / ERR-10: last resort for anything that escapes every guard. Installed
  // in the entrypoint, not in a library module, so importing the app (tests, the
  // MCP server) never hijacks the host process's error handling. See
  // process-safety.ts for why this exits rather than continuing.
  installProcessSafetyNet({ server });

  // DDoS protection: Set server-wide timeouts to prevent slow-read attacks (Slowloris)
  server.timeout = 60000; // 60 seconds max request duration
  server.keepAliveTimeout = 65000; // 65 seconds (slightly longer than timeout)
  server.headersTimeout = 66000; // 66 seconds (slightly longer than keepAlive)

  // Setup WebSocket collaboration server
  setupCollaboration(server);

  // Start server
  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
