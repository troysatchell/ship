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

  const app = createApp(CORS_ORIGIN);
  const server = createServer(app);

  // PF-304 (TRO-438) — webhook deliverer: subscribe to the domain event bus
  // and start the retry-schedule polling loop. Deliberately wired HERE, in
  // the real process entrypoint, and NOT inside `createApp()`/`app.ts` —
  // every test file in this repo calls `createApp()` directly, and a
  // background `setInterval` (or an eager DB query per test-file's
  // `documentService` writes) started from there would run during every
  // `pnpm test` invocation across the whole api suite, not just this
  // feature's own tests. `getEventBus()` is a process-wide module singleton
  // (`platform/webhooks/eventBus.ts`) shared with `documentService.ts`
  // regardless of where the subscription happens, so wiring it here reaches
  // the exact same bus `documentService.publish()` calls in production.
  const { getEventBus } = await import('./platform/webhooks/eventBus.js');
  const { InMemoryWebhookDeliverer, wireDelivererToEventBus } = await import('./platform/webhooks/deliverer.js');
  const { systemClock } = await import('./platform/webhooks/clock.js');
  const { pool } = await import('./db/client.js');

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
