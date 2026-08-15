#!/usr/bin/env node
/**
 * `pnpm drill ttfe` — the TTFE (Time To First Event) drill (TRO-455 /
 * PF-603, PLUGFORGE.MD §4/§5): a narrated, timed proof that a brand-new
 * developer can install `@ship/sdk`, log in via device flow, register a
 * webhook subscription, create a document, and verify the resulting signed
 * delivery — the exact "5-line story in a fresh terminal" PF-904's demo
 * script names — all inside one asserted time budget
 * (`scripts/drill/ttfe.config.json`, `totalBudgetMs`).
 *
 * Stages, in the PRD's own order, each independently timed and asserted
 * (`scripts/drill/thresholds.ts`):
 *   1. install_sdk      — pack the REAL, just-built `@ship/sdk` and
 *                          `npm install` it into a throwaway, empty
 *                          directory — proving it installs cleanly via npm
 *                          from a tarball, the way a real third-party
 *                          consumer would, not merely that the monorepo's
 *                          own workspace symlink resolves.
 *   2. device_login      — RFC 8628 device grant via `ShipClient.deviceLogin`,
 *                          auto-approved by a direct `POST /oauth/device/verify`
 *                          call carrying a real seeded session cookie (the
 *                          PRD's own "auto-approve via API in test"
 *                          instruction, same mechanism
 *                          `integrations/cli/src/__tests__/login.liveServer.test.ts`
 *                          already proves for `ship login`).
 *   3. webhook_create    — `client.webhooks.createSubscription(...)` against
 *                          a locally-bound target (this script's own tiny
 *                          capture listener).
 *   4. document_create   — `client.documents.create(...)`, which publishes
 *                          `document.created` through the SAME event bus the
 *                          real production `InMemoryWebhookDeliverer` (spawned
 *                          inside the real `api/src/index.ts` entrypoint this
 *                          script runs as a child process, not `createApp()`
 *                          in-process) subscribes to.
 *   5. wait_for_delivery — poll the capture listener until the real,
 *                          already-running deliverer's 1s poll loop
 *                          (`deliverer.ts`'s `DEFAULT_POLL_INTERVAL_MS`)
 *                          actually sends the signed POST.
 *   6. verify_webhook    — `verifyWebhook(headers, rawBody, secret)` against
 *                          the captured request, asserted `true`.
 *
 * ── DERIVED SCOPE DECISION (not literal PRD text — stated per this repo's
 *    claim-provenance rule): stages 2-6 import `@ship/sdk` from its OWN
 *    BUILT `dist/` output (`sdk/dist/index.js` / `sdk/dist/node.js`), the
 *    same import this repo's own `docs/submission/demo-webhook-listener.mjs`
 *    already uses — NOT from the throwaway directory stage 1 installs into.
 *    Both are the byte-identical build; stage 1 alone is what proves "does
 *    this install cleanly via npm," and folding stages 2-6 into a second,
 *    separately-spawned child process resolving through THAT directory's
 *    own node_modules would add real IPC complexity (stdout-marker
 *    protocols across a process boundary) for no additional proof of
 *    SDK-vs-server correctness — only of npm's own module resolution, which
 *    stage 1 already exercises end to end (a failed/incomplete install
 *    throws there, before stage 2 ever runs). ──
 *
 * ── Where Postgres comes from (verify-before-trusting a CI landmine) ──
 * `.gitlab-ci.yml`'s own `image-build`/`e2e-agent` job comments document,
 * in writing, that GitLab's shared runner on labs.gauntletai.com — THE
 * GRADED PLATFORM — cannot start a nested Docker daemon
 * ("mount: permission denied (are you root?)" starting `docker:27-dind`
 * privileged). `@testcontainers/postgresql` needs exactly that capability
 * (a Docker socket reachable from inside the job's own container) to start
 * ITS OWN Postgres container — the same requirement, not a different one.
 * `.gitlab-ci.yml` today has NO job anywhere that uses testcontainers for
 * exactly this reason (`e2e-agent` explicitly avoids
 * `e2e/fixtures/isolated-env.ts` and uses a plain `services:` Postgres
 * instead — see its own comment). Wiring this drill to REQUIRE
 * testcontainers in CI would repeat this project's own documented incident
 * (a GitLab job that never actually executes what it claims to). So: if
 * `DATABASE_URL` is already set (both this repo's `drill-ttfe` CI jobs set
 * it from a `services:`/service-container Postgres — GitLab's own proven
 * mechanism, matching `e2e-agent`'s job — and `.factory-env` sets it in a
 * factory worktree), this script reuses it and never touches Docker at all.
 * Only when NO `DATABASE_URL` is set (a genuine local "clean machine" run —
 * PLUGFORGE.MD §5's separate `TTFE clean-machine ≤ 30 min` target) does it
 * fall back to `@testcontainers/postgresql`, the same package and pattern
 * `e2e/fixtures/isolated-env.ts:119` already uses — genuinely
 * "containerized Ship (testcontainers, per repo pattern)" for that case,
 * exactly as the PRD names it.
 *
 * ── What is, and is not, inside the timed/asserted budget ──
 * Postgres startup + migrations + spawning the real api process (whichever
 * DB source above) run BEFORE stage timing begins — standing platform
 * infrastructure a real developer already has running, not part of "how
 * long does MY first event take." Only stage 1 onward counts toward
 * `totalBudgetMs`. Logged separately, clearly labeled, and explicitly never
 * asserted against a budget.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';

import { evaluateDrillStages, formatDrillEvaluation, type DrillThresholdConfig, type StageTiming } from './thresholds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SDK_DIR = join(REPO_ROOT, 'sdk');

// ── test-only override, mirroring sdk/scripts/measure-size.mjs's own
// `--threshold-kb` precedent: NEVER used for a real budget, only to prove
// the AC "regression past threshold fails the build" by inflating a
// recorded stage duration after the real work already completed (so the
// demonstration itself does not have to burn real wall-clock time). Format:
// `<stageName>=<extraMs>`, e.g. `DRILL_TTFE_SIMULATE_SLOW_MS=verify_webhook=65000`.
function parseSimulateSlowOverride(): { stage: string; extraMs: number } | null {
  const raw = process.env.DRILL_TTFE_SIMULATE_SLOW_MS;
  if (!raw) return null;
  const eq = raw.indexOf('=');
  if (eq === -1) return null;
  const stage = raw.slice(0, eq);
  const extraMs = Number(raw.slice(eq + 1));
  if (!stage || !Number.isFinite(extraMs)) return null;
  return { stage, extraMs };
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error('failed to acquire a free port')));
      }
    });
  });
}

/** Resolves once the child api process's stdout prints its real readiness
 *  line (`api/src/index.ts`'s own "API server running on ..."). Same
 *  observable-event pattern `integrations/cli/src/__tests__/login.liveServer.test.ts`'s
 *  `waitForReady` uses — never a fixed sleep (lessons.md rule 17). */
function waitForApiReady(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`api server did not report ready within ${timeoutMs}ms`));
    }, timeoutMs);

    let buffered = '';
    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffered += chunk.toString('utf8');
      if (buffered.includes('API server running on')) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveReady();
      }
    };
    child.stdout.on('data', onData);

    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`api server exited early with code ${exitCode} before reporting ready`));
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function spawnApiChild(databaseUrl: string, port: number, secretEncryptionKey: string): ChildProcessByStdio<null, Readable, Readable> {
  return spawn('pnpm', ['--filter', '@ship/api', 'exec', 'tsx', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      // See webhook-idempotency-key-drill.spec.ts's own fixture comment:
      // POST /api/v1/webhooks 500s (encryptSecret() throws) without this.
      SECRET_ENCRYPTION_KEY: secretEncryptionKey,
      // Never dialed by this drill (no browser involved) — just needs to be
      // a well-formed URL base, per app.ts's `new URL(path, webOrigin)`
      // (TRO-412's own documented '*' landmine).
      CORS_ORIGIN: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;
}

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

/** A minimal, single-request HTTP capture listener — this drill's own
 *  webhook "subscriber," deliberately simpler than
 *  `docs/submission/demo-webhook-listener.mjs`'s `createReferenceSubscriber`
 *  (no dedupe bookkeeping; TTFE cares about ONE fresh delivery, not replay
 *  semantics — that contract is PF-801's drill, not this one). Always
 *  answers 200 so the real deliverer records `status: 'success'`. */
function createCaptureListener(): {
  listen(): Promise<number>;
  captured: Promise<CapturedRequest>;
  close(): Promise<void>;
} {
  let resolveCaptured!: (value: CapturedRequest) => void;
  const captured = new Promise<CapturedRequest>((r) => {
    resolveCaptured = r;
  });
  let alreadyCaptured = false;

  const server = createHttpServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (!alreadyCaptured) {
        alreadyCaptured = true;
        resolveCaptured({ headers: req.headers, rawBody });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address() as AddressInfo;
          resolveListen(address.port);
        });
      });
    },
    captured,
    close(): Promise<void> {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

interface SeededPrincipal {
  workspaceId: string;
  userId: string;
  oauthAppId: string;
  clientId: string;
  sessionCookie: string;
}

/** Seeds the minimal principal this drill needs directly via SQL — a
 *  workspace, a user, a real session row (for the auto-approve POST's
 *  cookie), and a public OAuth app registered for BOTH scopes the drill's
 *  device-login flow requests. Same shape as
 *  `login.liveServer.test.ts`'s `beforeAll` and
 *  `e2e/webhook-idempotency-key-drill.spec.ts`'s `seedWebhookPrincipal`,
 *  merged into one seed since this drill needs both a session (device
 *  auto-approve) and an app that can create webhook subscriptions
 *  (documents:write + webhooks:manage). */
async function seedPrincipal(pool: pg.Pool, runId: string): Promise<SeededPrincipal> {
  const workspaceResult = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`TRO-455 TTFE drill ${runId}`]
  );
  const workspaceId = requireRow(workspaceResult.rows[0], 'workspace insert').id;

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, last_workspace_id)
     VALUES ($1, 'not-used', 'TTFE Drill User', $2) RETURNING id`,
    [`ttfe-drill-${runId}@ship.local`, workspaceId]
  );
  const userId = requireRow(userResult.rows[0], 'user insert').id;

  await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
    workspaceId,
    userId,
  ]);

  const sessionId = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
     VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
    [sessionId, userId, workspaceId]
  );

  const clientId = `ship_ttfe_drill_${runId}`;
  const appResult = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
     VALUES ($1, 'TRO-455 TTFE Drill App', $2, 'public', '{}', $3) RETURNING id`,
    [workspaceId, clientId, ['documents:write', 'webhooks:manage']]
  );
  const oauthAppId = requireRow(appResult.rows[0], 'oauth app insert').id;

  return { workspaceId, userId, oauthAppId, clientId, sessionCookie: `session_id=${sessionId}` };
}

async function cleanupPrincipal(pool: pg.Pool, principal: SeededPrincipal): Promise<void> {
  await pool.query(
    `DELETE FROM webhook_deliveries WHERE subscription_id IN
       (SELECT id FROM webhook_subscriptions WHERE app_id = $1)`,
    [principal.oauthAppId]
  );
  await pool.query(`DELETE FROM webhook_subscriptions WHERE app_id = $1`, [principal.oauthAppId]);
  await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [principal.workspaceId]);
  await pool.query(`DELETE FROM oauth_tokens WHERE app_id = $1`, [principal.oauthAppId]);
  await pool.query(`DELETE FROM oauth_device_codes WHERE app_id = $1`, [principal.oauthAppId]);
  await pool.query(`DELETE FROM oauth_apps WHERE id = $1`, [principal.oauthAppId]);
  await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [principal.userId]);
  await pool.query(`DELETE FROM workspace_memberships WHERE user_id = $1`, [principal.userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [principal.userId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [principal.workspaceId]);
}

function requireRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row;
}

/** Stage 1: pack the already-built `@ship/sdk` and `npm install` it into a
 *  fresh, empty directory. Returns that directory's path for the caller to
 *  clean up, and throws if the installed package is missing its built
 *  entry points (a real, actionable failure — not a silent no-op). */
async function installSdkInCleanDir(): Promise<string> {
  const packOutDir = await mkdtemp(join(tmpdir(), 'ttfe-drill-pack-'));
  const packJson = execFileSync('npm', ['pack', '--json', '--pack-destination', packOutDir], {
    cwd: SDK_DIR,
    encoding: 'utf8',
  });
  const packed = JSON.parse(packJson) as Array<{ filename: string }>;
  const tarballName = packed[0]?.filename;
  if (!tarballName) throw new Error(`npm pack produced no tarball (output: ${packJson})`);
  const tarballPath = join(packOutDir, tarballName);

  const installDir = await mkdtemp(join(tmpdir(), 'ttfe-drill-install-'));
  await writeFile(
    join(installDir, 'package.json'),
    JSON.stringify({ name: 'ttfe-drill-clean-install', private: true, version: '0.0.0' }, null, 2)
  );
  execFileSync('npm', ['install', tarballPath, '--no-audit', '--no-fund', '--silent'], {
    cwd: installDir,
    stdio: 'ignore',
  });

  const installedIndex = join(installDir, 'node_modules', '@ship', 'sdk', 'dist', 'index.js');
  const installedNode = join(installDir, 'node_modules', '@ship', 'sdk', 'dist', 'node.js');
  if (!existsSync(installedIndex) || !existsSync(installedNode)) {
    throw new Error(
      `npm install completed but the installed @ship/sdk is missing its built entry points ` +
        `(expected ${installedIndex} and ${installedNode})`
    );
  }

  await rm(packOutDir, { recursive: true, force: true });
  return installDir;
}

async function main(): Promise<void> {
  const configRaw = await readFile(join(__dirname, 'ttfe.config.json'), 'utf8');
  const config = JSON.parse(configRaw) as DrillThresholdConfig;

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const stages: StageTiming[] = [];

  console.log('=== TRO-455 / PF-603: TTFE drill ===');
  console.log('');

  // ── Untimed setup: Postgres + real api process ──
  const setupStart = Date.now();
  let ownedContainer: { stop(): Promise<void> } | null = null;
  let databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    console.log(`[setup] reusing ambient DATABASE_URL (CI service container / .factory-env) — no Docker touched`);
  } else {
    console.log('[setup] no DATABASE_URL set — starting a genuine testcontainers Postgres (local/clean-machine path)');
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:15')
      .withDatabase('ttfe_drill')
      .withUsername('ttfe')
      .withPassword('ttfe')
      .withStartupTimeout(120_000)
      .start();
    ownedContainer = {
      stop: async () => {
        await container.stop();
      },
    };
    databaseUrl = container.getConnectionUri();
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { runMigrations } = await import('../../api/src/db/migrationRunner.js');
  await runMigrations(pool, {
    schemaPath: join(REPO_ROOT, 'api/src/db/schema.sql'),
    migrationsDir: join(REPO_ROOT, 'api/src/db/migrations'),
    log: () => {},
  });

  const principal = await seedPrincipal(pool, runId);

  await execAsync('pnpm', ['build:shared'], REPO_ROOT);
  await execAsync('pnpm', ['build:sdk'], REPO_ROOT);

  const secretEncryptionKey = crypto.randomBytes(32).toString('hex');
  const apiPort = await getFreePort();
  const apiChild = spawnApiChild(databaseUrl, apiPort, secretEncryptionKey);
  apiChild.stderr.on('data', (chunk: Buffer) => {
    if (process.env.DEBUG) process.stderr.write(`[api] ${chunk}`);
  });
  await waitForApiReady(apiChild, 30_000);
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  console.log(`[setup] api ready at ${baseUrl} (${Date.now() - setupStart}ms — untimed, not part of totalBudgetMs)`);
  console.log('');

  let exitCode = 0;
  let installDir: string | undefined;
  try {
    // ── Stage 1: install_sdk ──
    let t0 = Date.now();
    installDir = await installSdkInCleanDir();
    stages.push({ name: 'install_sdk', ms: Date.now() - t0 });

    // The rest of the flow uses the SAME built dist this stage just proved
    // installs cleanly — see this file's header "DERIVED SCOPE DECISION".
    const sdkIndexUrl = new URL(`file://${join(SDK_DIR, 'dist', 'index.js')}`);
    const sdkNodeUrl = new URL(`file://${join(SDK_DIR, 'dist', 'node.js')}`);
    const { ShipClient } = (await import(sdkIndexUrl.href)) as typeof import('../../sdk/dist/index.js');
    const { verifyWebhook } = (await import(sdkNodeUrl.href)) as typeof import('../../sdk/dist/node.js');

    // ── Stage 2: device_login (auto-approve via a real API call) ──
    t0 = Date.now();
    let approvalFetch: Promise<Response> | undefined;
    const client = await ShipClient.deviceLogin({
      baseUrl,
      clientId: principal.clientId,
      scope: 'documents:write webhooks:manage',
      onUserCode: (userCode) => {
        approvalFetch = fetch(`${baseUrl}/oauth/device/verify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: principal.sessionCookie,
          },
          body: new URLSearchParams({ user_code: userCode, decision: 'approve' }).toString(),
          redirect: 'manual',
        });
      },
    });
    if (!approvalFetch) throw new Error('device login never reached onUserCode — no code to approve');
    const approvalResponse = await approvalFetch;
    if (approvalResponse.status !== 303) {
      throw new Error(`expected the device-verify approval to redirect (303), got ${approvalResponse.status}`);
    }
    stages.push({ name: 'device_login', ms: Date.now() - t0 });

    // ── Stage 3: webhook_create ──
    t0 = Date.now();
    const listener = createCaptureListener();
    const listenerPort = await listener.listen();
    let subscriptionId: string | undefined;
    try {
      const subscription = await client.webhooks.createSubscription({
        app_id: principal.oauthAppId,
        event_type: 'document.created',
        target_url: `http://127.0.0.1:${listenerPort}/`,
      });
      subscriptionId = subscription.id;
      stages.push({ name: 'webhook_create', ms: Date.now() - t0 });

      // ── Stage 4: document_create ──
      t0 = Date.now();
      await client.documents.create({ title: `TRO-455 TTFE drill ${runId}` });
      stages.push({ name: 'document_create', ms: Date.now() - t0 });

      // ── Stage 5: wait_for_delivery ──
      t0 = Date.now();
      const timeoutMs = config.stageBudgetsMs.wait_for_delivery ?? 15_000;
      const captured = await Promise.race([
        listener.captured,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`no webhook delivery received within ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      stages.push({ name: 'wait_for_delivery', ms: Date.now() - t0 });

      // ── Stage 6: verify_webhook ──
      t0 = Date.now();
      const verified = verifyWebhook(captured.headers, captured.rawBody, subscription.secret);
      const verifyElapsed = Date.now() - t0;
      stages.push({ name: 'verify_webhook', ms: verifyElapsed });
      if (!verified) {
        throw new Error('verifyWebhook() returned false for the real, freshly-delivered request — signature mismatch');
      }
    } finally {
      await listener.close();
      if (subscriptionId) {
        // Deactivate via the real client/route (same reasoning
        // e2e/webhook-idempotency-key-drill.spec.ts's own cleanup gives:
        // exercises the real deactivation path). Best-effort —
        // cleanupPrincipal() below deletes the row directly regardless, so a
        // failure here must never mask the drill's own real result.
        await client.webhooks.deleteSubscription(subscriptionId).catch(() => {});
      }
    }

    // ── Test-only: simulate a slow stage, per this ticket's own AC
    // ("regression past threshold fails the build (simulate, evidence,
    // revert)"). Applied AFTER every real measurement, never during. ──
    const override = parseSimulateSlowOverride();
    if (override) {
      const idx = stages.findIndex((s) => s.name === override.stage);
      if (idx !== -1) {
        const original = stages[idx];
        if (original) {
          stages[idx] = { name: original.name, ms: original.ms + override.extraMs };
          console.log(
            `[DRILL_TTFE_SIMULATE_SLOW_MS] inflated '${override.stage}' by +${override.extraMs}ms (test-only, never for real budgets)`
          );
        }
      } else {
        console.log(`[DRILL_TTFE_SIMULATE_SLOW_MS] stage '${override.stage}' not found — no-op`);
      }
    }

    const evaluation = evaluateDrillStages(stages, config);
    console.log(formatDrillEvaluation(stages, evaluation));
    exitCode = evaluation.pass ? 0 : 1;

    await cleanupPrincipal(pool, principal);
  } catch (error) {
    console.error('TTFE drill failed:', error instanceof Error ? error.message : error);
    exitCode = 1;
    // Best-effort cleanup even on failure — do not leak rows into a shared
    // factory database across repeated gate.sh runs.
    await cleanupPrincipal(pool, principal).catch(() => {});
  } finally {
    if (installDir) await rm(installDir, { recursive: true, force: true }).catch(() => {});
    apiChild.kill('SIGTERM');
    await new Promise<void>((resolveKill) => {
      if (apiChild.exitCode !== null) {
        resolveKill();
        return;
      }
      apiChild.once('exit', () => resolveKill());
    });
    await pool.end();
    if (ownedContainer) await ownedContainer.stop();
  }

  process.exitCode = exitCode;
}

function execAsync(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: process.env.DEBUG ? 'inherit' : 'ignore' });
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.once('error', reject);
  });
}

main().catch((error) => {
  console.error('TTFE drill: fatal error', error);
  process.exitCode = 1;
});
