/**
 * PF-600's own AC, end to end against a REAL running Ship API — not
 * `api/src`'s `createApp()` called in-process (the exception `sdk/`'s and
 * `agent/`'s own liveServer suites document for themselves), but the actual
 * `api/` package spawned as a SEPARATE OS process via `pnpm --filter
 * @ship/api exec tsx src/index.ts`, exactly the way a human runs `pnpm
 * dev:api`. This is the one file in this package that talks to a live
 * server; everything else (`commands/login.test.ts`, `commands/whoami.test.ts`)
 * fully mocks `fetch`.
 *
 * WHY A SUBPROCESS AND NOT AN IMPORT (this package's whole reason for
 * existing, PLUGFORGE.MD §2.1 / PF-003): `integrations/cli` may depend on
 * `@ship/sdk` and nothing else — never `api/src`, in source OR in tests.
 * `sdk/src/__tests__/client.liveServer.test.ts` and
 * `client.deviceLogin.liveServer.test.ts` both document a "one deliberate
 * cross-package import" exception for themselves, because `@ship/sdk` is
 * the platform SDK authoring the wire contract those tests prove. This
 * package is a downstream integration — the SAME posture any real
 * third-party CLI author has — so it earns its end-to-end proof the way a
 * real third party would: a real HTTP round trip against a real running
 * server, a raw `pg` connection for fixture setup (a devDependency, not a
 * runtime one — `check-integration-deps.mjs` only inspects `dependencies`),
 * and nothing imported from `api/src` at all.
 *
 * "Auto-approve via API in test" (this ticket's own instruction, pointing at
 * PF-104/PF-106's precedent): `device.test.ts`'s `submitVerifyDecision`
 * helper posts to the real `POST /oauth/device/verify` HTTP endpoint with a
 * session cookie — this file does the exact same POST, over a real TCP
 * connection instead of supertest, the moment it observes the CLI's own
 * printed user_code (via a wrapped `Io`, not a special test-only hook in
 * production code).
 *
 * REAL WAIT, bounded and deliberate (same trade-off
 * `client.deviceLogin.liveServer.test.ts` documents for itself): the server
 * throttles polls against wall-clock time
 * (`api/src/platform/oauth/device.ts`'s `interval_seconds`, 5s default), so
 * proving the SECOND poll lands on an already-approved code genuinely takes
 * ~5s. `commands/login.test.ts` already covers the polling LOGIC with an
 * injected no-op `sleep`; this file is the "does it actually work against
 * the real thing" proof, kept to one case to bound the real wall-clock cost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { runLogin } from '../commands/login.js';
import { runWhoami } from '../commands/whoami.js';
import { createCapturingIo } from '../io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/__tests__ -> src -> cli -> integrations -> repo root.
const REPO_ROOT = resolve(__dirname, '../../../..');

function requireRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row;
}

/** Asks the OS for an unused ephemeral port. Same technique
 *  `e2e/fixtures/isolated-env.ts` uses via the `get-port` package — this
 *  package doesn't depend on that (it would be a runtime-adjacent
 *  devDependency this one test alone needs), so it's inlined directly with
 *  plain `node:net` rather than adding a dependency for one call site. */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
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

/** Resolves once the child's stdout has printed `index.ts`'s own readiness
 *  line — an observable event, not a fixed sleep (this repo's own
 *  convention, lessons.md rule 17). Rejects on early exit/error or a bounded
 *  timeout so a broken server fails this test fast instead of hanging the
 *  whole suite. */
function waitForReady(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`api server did not report ready within ${timeoutMs}ms`));
    }, timeoutMs);

    // Accumulate across chunks rather than testing each in isolation — Node
    // can split "API server running on ..." across two 'data' events, and a
    // per-chunk check would miss that split and wait out the full timeout
    // with a misleading "did not report ready" error (CodeRabbit caught
    // this).
    let buffered = '';
    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffered += chunk.toString('utf8');
      if (buffered.includes('API server running on')) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolvePromise();
      }
    };
    child.stdout.on('data', onData);

    child.once('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`api server exited early with code ${exitCode} before reporting ready`));
    });

    // A spawn-level failure (e.g. `pnpm` not on PATH, ENOENT) fires 'error',
    // not 'exit' — without this, such a failure would silently wait out the
    // full timeout instead of rejecting immediately with the real cause.
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Spawns the real `api/` package bound to a fresh ephemeral port, retrying
 *  with a NEW port if it loses the TOCTOU race between `getFreePort()`
 *  closing its probe socket and the child actually binding — a real, if
 *  low-probability, gap CodeRabbit caught. Only retries when the child's own
 *  stderr names `EADDRINUSE`; any other early exit rethrows immediately on
 *  the first attempt, so a genuine startup bug still fails fast instead of
 *  being masked behind retries. */
async function spawnApiChild(
  databaseUrl: string,
  onStderr: (chunk: Buffer) => void
): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; port: number }> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await getFreePort();
    const attemptStderr: Buffer[] = [];
    const child = spawn('pnpm', ['--filter', '@ship/api', 'exec', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PORT: String(port),
        DATABASE_URL: databaseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      attemptStderr.push(chunk);
      onStderr(chunk);
    });

    try {
      await waitForReady(child, 30_000);
      return { child, port };
    } catch (err) {
      // Every failure path below rethrows or moves to a new attempt — either
      // way this attempt's child must not be left running. Missing this on
      // the non-retryable and final-attempt paths (fixed here) would leak a
      // still-listening process per failed attempt.
      if (child.exitCode === null) {
        await new Promise<void>((resolveKill) => {
          child.once('exit', () => resolveKill());
          child.kill('SIGTERM');
        });
      }
      const isPortRace = Buffer.concat(attemptStderr).toString('utf8').includes('EADDRINUSE');
      if (!isPortRace || attempt === MAX_ATTEMPTS) throw err;
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new Error('spawnApiChild: exhausted retries without returning or throwing');
}

describe('PF-600: ship login / ship whoami end-to-end against a real running Ship API', () => {
  const databaseUrl = process.env.DATABASE_URL;

  let pool: pg.Pool | undefined;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let credentialsDir: string;
  let credentialsPath: string;
  let baseUrl: string;
  let clientId: string;
  let sessionCookie: string;
  let workspaceId: string | undefined;
  let userId: string | undefined;

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const childStderrChunks: Buffer[] = [];

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL must be set to run this live-server test — source .factory-env in this worktree first.'
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });

    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-600 CLI live-server test ${runId}`]
    );
    workspaceId = requireRow(workspaceResult.rows[0], 'workspace insert').id;

    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'CLI Live Server Test User') RETURNING id`,
      [`pf600-cli-${runId}@ship.local`]
    );
    userId = requireRow(userResult.rows[0], 'user insert').id;

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userId,
    ]);

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, userId, workspaceId]
    );
    sessionCookie = `session_id=${sessionId}`;

    // A public OAuth app — RFC 8628 device clients hold no secret, same as
    // every other device-flow fixture in this repo (device.test.ts,
    // client.deviceLogin.liveServer.test.ts).
    clientId = `ship_cli_test_${runId}`;
    await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'PF-600 CLI Live Server Test Client', $2, 'public', '{}', $3)`,
      [workspaceId, clientId, ['documents:read']]
    );

    // The real api/ package, as a separate process — see this file's header
    // for why this is a subprocess and not an import. DATABASE_URL is passed
    // explicitly rather than left to `api/.env.local` (index.ts's own dotenv
    // `override: false` load order would otherwise supply it) because that
    // file only exists in a factory worktree — CI has no `.env.local` at all
    // (`api/.env.test.example`'s own header), so relying on it would make
    // this test pass locally and fail (child can't reach the DB, or worse,
    // silently connects to whatever `pg`'s own unspecified defaults resolve
    // to) the moment it runs in ci.yml/.gitlab-ci.yml. SESSION_SECRET/
    // CORS_ORIGIN both have safe hardcoded fallbacks in app.ts/index.ts when
    // unset, so only DATABASE_URL and PORT need to be explicit here.
    // `spawnApiChild` retries with a fresh port on EADDRINUSE — see its own
    // header for why.
    const started = await spawnApiChild(databaseUrl, (chunk) => childStderrChunks.push(chunk));
    child = started.child;
    baseUrl = `http://127.0.0.1:${started.port}`;

    credentialsDir = await mkdtemp(join(tmpdir(), 'ship-cli-liveserver-test-'));
    credentialsPath = join(credentialsDir, 'credentials.json');
  }, 45_000);

  afterAll(async () => {
    try {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolvePromise) => child?.once('exit', () => resolvePromise()));
        child.kill('SIGTERM');
        await exited;
      }
    } finally {
      try {
        if (pool && workspaceId) {
          await pool.query(
            'DELETE FROM oauth_tokens WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query(
            'DELETE FROM oauth_device_codes WHERE app_id IN (SELECT id FROM oauth_apps WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query('DELETE FROM oauth_apps WHERE workspace_id = $1', [workspaceId]);
        }
        if (pool && userId) {
          await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (pool && workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool?.end();
        if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it(
    'ship login prints the user_code + verify URL, polls to success once approved via the real /oauth/device/verify endpoint, ' +
      'persists credentials at 0600, and ship whoami then reports the same identity',
    async () => {
      const loginIo = createCapturingIo();
      // Wraps the CLI's own real stdout writer: the moment `ship login`
      // prints the user_code (this ticket's own AC), react to it exactly
      // like a human would — open the verify endpoint and approve. Fired
      // Fired from inside the `onUserCode` callback (still called from a
      // stdout event, not from top-level test code), same "kick it off from
      // the callback" shape `client.deviceLogin.liveServer.test.ts`'s own
      // `onUserCode` uses, except this approves over a REAL HTTP POST to
      // `/oauth/device/verify` (this ticket's own "auto-approve via API in
      // test" instruction) instead of an in-process function call. Unlike
      // that file's `void decideDeviceCode(...)`, the promise is RETAINED
      // here (not `void`-discarded) so it can be awaited and asserted after
      // `runLogin` resolves — a fire-and-forget POST that silently 500s
      // would otherwise only surface as `runLogin`'s own confusing
      // poll-timeout failure, with no signal pointing at the approval step
      // itself.
      let approvalFetch: Promise<Response> | undefined;
      const wrappedIo = {
        stdout: (line: string) => {
          loginIo.stdout(line);
          const match = /And enter the code: (\S+)/.exec(line);
          if (match) {
            const userCode = match[1];
            // `redirect: 'manual'` matters here, not just stylistically: a
            // successful approve responds 303 to `verification_uri`
            // (`http://localhost:5609/oauth-device-verify?result=approved` —
            // the WEB origin, nothing listening on it in this test). Fetch's
            // DEFAULT is `redirect: 'follow'`, and an auto-followed redirect
            // to a dead port becomes an ECONNREFUSED — confirmed by
            // reproducing it standalone before writing this comment. This
            // call only needs the 303 itself (proof the decision landed),
            // never the page it points to.
            approvalFetch = fetch(`${baseUrl}/oauth/device/verify`, {
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: sessionCookie,
              },
              body: new URLSearchParams({ user_code: userCode ?? '', decision: 'approve' }).toString(),
              redirect: 'manual',
            });
          }
        },
        stderr: loginIo.stderr,
      };

      const loginCode = await runLogin({
        io: wrappedIo,
        env: {},
        clientId,
        baseUrl,
        scope: 'documents:read',
        credentialsPath,
      });

      // Awaited AFTER runLogin resolves (the approval POST races the CLI's
      // own poll — either can land first), not before — awaiting earlier
      // would deadlock: this POST is issued synchronously from inside the
      // stdout handler that runLogin's own poll loop triggers.
      const approval = approvalFetch;
      if (!approval) {
        throw new Error('approval POST was never issued — user_code line never matched');
      }
      const approvalResponse = await approval;
      expect(approvalResponse.status).toBe(303);

      expect(loginCode, `stderr: ${loginIo.stderrLines.join('\n')}`).toBe(0);
      expect(loginIo.stdoutLines.some((l) => l.startsWith('To authorize this CLI, open:'))).toBe(true);
      expect(loginIo.stdoutLines.some((l) => /^And enter the code: [A-Z0-9]{4}-[A-Z0-9]{4}$/.test(l))).toBe(true);
      expect(loginIo.stdoutLines.some((l) => l.includes('CLI Live Server Test User'))).toBe(true);

      const stats = await stat(credentialsPath);
      expect((stats.mode & 0o777).toString(8)).toBe('600');

      const whoamiIo = createCapturingIo();
      const whoamiCode = await runWhoami({ io: whoamiIo, env: {}, clientId, baseUrl, credentialsPath });

      expect(whoamiCode, `stderr: ${whoamiIo.stderrLines.join('\n')}`).toBe(0);
      expect(whoamiIo.stdoutLines).toHaveLength(1);
      expect(whoamiIo.stdoutLines[0]).toContain('CLI Live Server Test User');
      expect(whoamiIo.stdoutLines[0]).toContain('documents:read');
    },
    30_000
  );
});
