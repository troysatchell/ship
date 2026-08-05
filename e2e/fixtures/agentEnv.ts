/**
 * FleetGraph agent E2E environment (TRO-322 / FG-12).
 *
 * A second, lightweight sibling to `isolated-env.ts` — same idea (spin up
 * real api/web/agent processes against a real, freshly-migrated database),
 * deliberately NOT the same mechanism. `isolated-env.ts` starts its own
 * Postgres via `@testcontainers/postgresql`, which needs a Docker daemon
 * reachable from inside the test process. That works on GitHub Actions'
 * `ubuntu-latest` runner, but this repo's GitLab CI cannot do it: the
 * shared runner's own `docker:27-dind` service fails to start privileged
 * ("mount: permission denied (are you root?)"), documented in
 * `.gitlab-ci.yml`'s `image-build` job comment as a runner-registration
 * limitation this project cannot change. Testcontainers hits the identical
 * wall — it is a second consumer of the same nested-Docker capability.
 *
 * This fixture sidesteps that entirely by never starting its own Postgres
 * container. It expects a Postgres instance to already exist (from a
 * `DATABASE_URL`/`E2E_AGENT_DATABASE_URL` env var) — in CI that is a plain
 * `services:` block (GitHub Actions) / `services:` entry (GitLab CI), the
 * SAME native mechanism `ci.yml`'s and `.gitlab-ci.yml`'s existing `verify`
 * job already uses successfully on both platforms for unit tests. A
 * `services:` container needs no privileged/nested-Docker access at all —
 * it is the runner starting a sibling container, not the job's own
 * container starting Docker inside itself — which is exactly why it already
 * works on GitLab where `dind` does not.
 *
 * Seeds the identical baseline `isolated-env.ts` uses
 * (`seedMinimalTestData`/`runMigrations`, exported from that file for this
 * reason) plus one small fixture document of this file's own, then mints a
 * real per-user Ship API token for the seeded dev user (CSRF -> login ->
 * `POST /api/api-tokens`, the same sequence this repo's own
 * `memory-bank/progress.md` already used by hand to stand up a local agent
 * environment) — the agent has no service account by design
 * (FLEETGRAPH.MD's "Deployment model"), so it needs a real token to read
 * Ship at all.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import path from 'path';
import getPort from 'get-port';
import { runMigrations } from './isolated-env.js';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

export interface AgentShipEnv {
  apiUrl: string;
  webUrl: string;
  agentUrl: string;
  /** Shared secret the agent's /chat and /inbox require on X-Internal-Secret
   * — matches what api/'s AGENT_INTERNAL_SECRET is set to for this env, so
   * a spec driving the real UI never needs to know it directly. */
  internalSecret: string;
  /** A real, freshly-created issue every spec can comment on / chat about —
   * created once per worker, not per test, so tests that only read it can
   * run in any order; a spec that mutates it (posts a comment) does not
   * invalidate the ones that only ask about it. */
  probeDocumentId: string;
  probeDocumentTitle: string;
  /** Bob Martinez's user id — seedMinimalTestData's own fixture person,
   * already the convention `agent/src/scripts/trace-invoke-proactive.ts`
   * uses for the literal `@Full Name` mention text `mentions.ts` resolves. */
  bobUserId: string;
  devUserEmail: string;
  devUserPassword: string;
  /** A real, non-expiring Ship API token for `dev@ship.local` (the same one
   * `SHIP_API_TOKEN` was set to when the agent process was spawned — reused
   * here rather than minting a second one) — for specs that call Ship's own
   * API directly (e.g. posting a comment as the "event enters Ship" half of
   * a proactive test) rather than through the browser. */
  devApiToken: string;
  /** A real, non-expiring Ship API token for `bob.martinez@ship.local` —
   * needed because `GET /api/agent/inbox` (api/src/routes/agent.ts) always
   * resolves `recipientUserId` from the AUTHENTICATED caller, never a query
   * param, so reading Bob's own inbox requires being authenticated as Bob. */
  bobApiToken: string;
}

type WorkerFixtures = { agentShip: AgentShipEnv };

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 403 || res.status === 503) {
        // 503 counts as "up" here deliberately — the agent's own /health is
        // always 200, but during the brief startup window before its first
        // event loop tick some environments observe a connection refusal
        // rather than a real HTTP response; once ANY HTTP response arrives
        // the process is listening, which is all this waits for.
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms. Last error: ${String(lastError)}`);
}

/** Merges one or more raw `Set-Cookie` header values into a single `Cookie`
 * request-header string, later values overriding earlier same-named ones —
 * enough of a cookie jar for a linear login sequence with no concurrency,
 * without pulling in a dependency neither this package nor the root already
 * has for it. */
function mergeCookies(existing: string, setCookieValues: readonly string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const raw of setCookieValues) {
    const firstPair = raw.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eq = firstPair.indexOf('=');
    if (eq > 0) jar.set(firstPair.slice(0, eq), firstPair.slice(eq + 1));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Node's `fetch` `Headers` only exposes multiple `Set-Cookie` values via
 * `getSetCookie()` (Node >= 18.14) — `.get('set-cookie')` on a real
 * multi-cookie response silently joins them with `, `, which breaks
 * cookie-attribute parsing. Falls back to a single-value array when
 * `getSetCookie` is unavailable, which is enough for this login sequence's
 * actual responses (one cookie per response, verified against
 * `api/src/app.ts`'s session/CSRF middleware). */
function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

async function fetchCsrfToken(apiUrl: string, cookie: string): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${apiUrl}/api/csrf-token`, { headers: cookie ? { Cookie: cookie } : {} });
  if (!res.ok) throw new Error(`GET /api/csrf-token failed: ${res.status} ${await res.text()}`);
  const nextCookie = mergeCookies(cookie, getSetCookies(res));
  const body = (await res.json()) as { token: string };
  return { token: body.token, cookie: nextCookie };
}

/**
 * The real CSRF -> login -> mint-token sequence, against a real running api
 * server. Mints a NAMED, non-expiring token for `email` — the agent's own
 * per-user-token design (FLEETGRAPH.MD: "no service account").
 */
export async function mintApiToken(apiUrl: string, email: string, password: string): Promise<string> {
  let { token: csrfToken, cookie } = await fetchCsrfToken(apiUrl, '');

  const loginRes = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error(`POST /api/auth/login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  cookie = mergeCookies(cookie, getSetCookies(loginRes));

  // A fresh CSRF token bound to the now-authenticated session — the token
  // fetched pre-login is bound to the anonymous session and is not
  // guaranteed to validate against the session csrf-sync now tracks.
  ({ token: csrfToken, cookie } = await fetchCsrfToken(apiUrl, cookie));

  const tokenRes = await fetch(`${apiUrl}/api/api-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: `e2e-agent-fixture-${Date.now()}` }),
  });
  if (!tokenRes.ok) {
    throw new Error(`POST /api/api-tokens failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const body = (await tokenRes.json()) as { data: { token: string } };
  return body.data.token;
}

const SAFE_DB_NAME = /^[a-z0-9_]+$/;

/**
 * Creates a fresh, randomly-named scratch database on the same Postgres
 * server `baseUrl` points at, and returns a connection string to it —
 * never writes into whatever database `baseUrl` itself names.
 *
 * In CI, `baseUrl` already names an empty, job-private `services:` postgres
 * (ci.yml/.gitlab-ci.yml's `e2e-agent` job) — this still isolates within
 * it, at negligible cost, rather than special-casing "CI vs local." Locally,
 * `baseUrl` is very likely a worktree's real, shared dev database
 * (`.factory-env`'s `DATABASE_URL`) — writing this fixture's seed rows
 * directly into it would risk a duplicate-key failure on `dev@ship.local`
 * (already a real row there) on the very first run, and pollute it
 * permanently on every run after. Matches lessons.md's own rule: "Derive
 * database names from randomBytes, never a deterministic string."
 */
async function createScratchDatabase(baseUrl: string): Promise<{ url: string; dbName: string; adminUrl: string }> {
  const parsed = new URL(baseUrl);
  const dbName = `ship_e2e_agent_${randomBytes(6).toString('hex')}`;
  if (!SAFE_DB_NAME.test(dbName)) {
    // Unreachable given the generator above, but this value is about to be
    // interpolated into a raw SQL identifier (Postgres does not support
    // parameter binding for CREATE DATABASE's name) — validate explicitly
    // rather than trust that fact silently (lessons.md: "anything
    // interpolated into a psql command must be validated first").
    throw new Error(`createScratchDatabase: generated an unsafe database name "${dbName}"`);
  }

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  const scratchUrl = new URL(baseUrl);
  scratchUrl.pathname = `/${dbName}`;
  return { url: scratchUrl.toString(), dbName, adminUrl: adminUrl.toString() };
}

async function dropScratchDatabase(adminUrl: string, dbName: string): Promise<void> {
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    // No FORCE — lessons.md's own warning: FORCE converts "something is
    // still connected" into a silent disconnect rather than a visible
    // failure. A leftover scratch database from a process that failed to
    // exit cleanly is a cheap, visible cleanup task, not a data-loss risk.
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (err) {
    console.warn(`[agentEnv] failed to drop scratch database "${dbName}" (leaving it behind): ${String(err)}`);
  } finally {
    await adminPool.end();
  }
}

async function setUpDatabase(databaseUrl: string): Promise<{ probeDocumentId: string; probeDocumentTitle: string; bobUserId: string }> {
  await runMigrations(databaseUrl); // schema + migrations table + seedMinimalTestData, all in one (isolated-env.ts)

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const workspaceRes = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE name = 'Test Workspace' LIMIT 1`
    );
    const workspaceId = workspaceRes.rows[0]?.id;
    if (!workspaceId) throw new Error('setUpDatabase: seeded "Test Workspace" not found — seedMinimalTestData may have changed shape.');

    const devRes = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'dev@ship.local'`);
    const devUserId = devRes.rows[0]?.id;
    if (!devUserId) throw new Error('setUpDatabase: seeded dev@ship.local user not found.');

    const bobRes = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob.martinez@ship.local'`);
    const bobUserId = bobRes.rows[0]?.id;
    if (!bobUserId) throw new Error('setUpDatabase: seeded bob.martinez@ship.local user not found.');

    // Deliberately does NOT contain the word "FleetGraph" — the chat pill's
    // own accessible name is "FleetGraph" (AgentPill.tsx), and
    // `agent-chat-grounded-response.spec.ts` locates it with
    // `getByRole('button', { name: /FleetGraph/ })`. An earlier version of
    // this title ("FleetGraph E2E Probe Issue") collided with that regex via
    // the UNRELATED per-row "Actions for <title>" button every document row
    // renders, producing a strict-mode "resolved to 2 elements" failure that
    // had nothing to do with the chat panel itself. Named for what it does,
    // not for the product testing it.
    const probeDocumentTitle = 'TRO-322 E2E Probe Issue';
    const probeRes = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
       VALUES ($1, 'issue', $2, $3, $4) RETURNING id`,
      [
        workspaceId,
        probeDocumentTitle,
        JSON.stringify({ state: 'todo', priority: 'medium', source: 'internal', assignee_id: devUserId }),
        devUserId,
      ]
    );
    const probeDocumentId = probeRes.rows[0]?.id;
    if (!probeDocumentId) throw new Error('setUpDatabase: failed to create the probe issue.');

    return { probeDocumentId, probeDocumentTitle, bobUserId };
  } finally {
    await pool.end();
  }
}

export const test = base.extend<{ agentShip: AgentShipEnv }, WorkerFixtures>({
  // Same override isolated-env.ts's own `context` fixture applies, and for
  // the identical reason: without it, the Action Items modal opens over
  // every page on load and covers the FleetGraph pill entirely — confirmed
  // directly (not guessed) by a real failed run whose captured accessibility
  // snapshot showed `dialog "Action Items"` on top of a `button ... FleetGraph`
  // that genuinely existed in the DOM the whole time.
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      localStorage.setItem('ship:disableActionItemsModal', 'true');
    });
    await use(context);
  },

  agentShip: [
    async ({}, use, workerInfo) => {
      const baseDatabaseUrl = process.env.E2E_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
      if (!baseDatabaseUrl) {
        throw new Error(
          'agentEnv fixture requires E2E_AGENT_DATABASE_URL or DATABASE_URL, pointed at a reachable ' +
            'Postgres server — CI sets this to a freshly-started postgres service (see ci.yml/' +
            '.gitlab-ci.yml\'s "e2e-agent" job); locally, source .factory-env. The fixture creates its ' +
            'OWN randomly-named scratch database on that server (never writes into the database this ' +
            'URL itself names) — see createScratchDatabase\'s own comment for why.'
        );
      }
      const debug = process.env.DEBUG === '1';
      const tag = `[agentEnv worker ${workerInfo.workerIndex}]`;

      const scratch = await createScratchDatabase(baseDatabaseUrl);
      const databaseUrl = scratch.url;
      if (debug) console.log(`${tag} created scratch database ${scratch.dbName}`);

      const seedResult = await setUpDatabase(databaseUrl);
      if (debug) console.log(`${tag} seeded — probe issue ${seedResult.probeDocumentId}, Bob ${seedResult.bobUserId}`);

      const devUserEmail = 'dev@ship.local';
      const devUserPassword = 'admin123';

      // Reserved up front, before either process starts: api/'s own agent
      // proxy (api/src/routes/agent.ts) reads AGENT_API_BASE_URL and
      // AGENT_INTERNAL_SECRET from its OWN env at module load, so both must
      // be known and correct at api's spawn time, not discovered afterward.
      const apiPort = await getPort();
      const apiUrl = `http://localhost:${apiPort}`;
      const agentPort = await getPort();
      const agentUrl = `http://localhost:${agentPort}`;
      const internalSecret = `e2e-fixture-secret-${workerInfo.workerIndex}`;

      const apiProc: ChildProcess = spawn('node', ['dist/index.js'], {
        cwd: path.join(PROJECT_ROOT, 'api'),
        env: {
          ...process.env,
          PORT: String(apiPort),
          DATABASE_URL: databaseUrl,
          CORS_ORIGIN: '*',
          NODE_ENV: 'test',
          AGENT_API_BASE_URL: agentUrl,
          AGENT_INTERNAL_SECRET: internalSecret,
          DOTENV_CONFIG_PATH: '/dev/null',
        },
        stdio: debug ? 'inherit' : 'pipe',
      });
      apiProc.stderr?.on('data', (d) => console.error(`${tag} api: ${d.toString().trim()}`));
      await waitForServer(`${apiUrl}/health`, 30_000);
      if (debug) console.log(`${tag} api ready at ${apiUrl}`);

      const shipApiToken = await mintApiToken(apiUrl, devUserEmail, devUserPassword);
      if (debug) console.log(`${tag} minted Ship API token for ${devUserEmail}`);

      const agentProc: ChildProcess = spawn('node', ['dist/scripts/e2e-server.js'], {
        cwd: path.join(PROJECT_ROOT, 'agent'),
        env: {
          ...process.env,
          PORT: String(agentPort),
          // Never a real key — e2e-server.ts's fake model never constructs a
          // real ChatAnthropic client, so this value is never read or billed.
          ANTHROPIC_API_KEY: 'e2e-placeholder-not-a-real-key',
          SHIP_API_BASE_URL: apiUrl,
          SHIP_API_TOKEN: shipApiToken,
          AGENT_INTERNAL_SECRET: internalSecret,
          // Short — the detection-latency spec needs the real production
          // poll loop to complete within a CI-sized test timeout. Still an
          // order of magnitude above change-feed.ts's own 5000ms
          // CHANGE_FEED_LAG_MS safety margin, so a poll never races ahead of
          // data that is real but still within Ship's deliberate lag window.
          PROACTIVE_POLL_INTERVAL_MS: '3000',
          SHIP_REQUEST_TIMEOUT_MS: '5000',
          DOTENV_CONFIG_PATH: '/dev/null',
        },
        stdio: debug ? 'inherit' : 'pipe',
      });
      agentProc.stderr?.on('data', (d) => console.error(`${tag} agent: ${d.toString().trim()}`));
      await waitForServer(`${agentUrl}/health`, 30_000);
      if (debug) console.log(`${tag} agent ready at ${agentUrl}`);

      const webPort = await getPort();
      const webUrl = `http://localhost:${webPort}`;
      const webProc: ChildProcess = spawn('npx', ['vite', 'preview', '--port', String(webPort), '--strictPort'], {
        cwd: path.join(PROJECT_ROOT, 'web'),
        env: {
          ...process.env,
          // vite.config.ts's preview proxy reads this to forward /api/* to
          // the real api process — the browser only ever talks to webUrl.
          API_PORT: String(apiPort),
        },
        stdio: debug ? 'inherit' : 'pipe',
      });
      webProc.stderr?.on('data', (d) => {
        if (debug) console.log(`${tag} web: ${d.toString().trim()}`);
      });
      await waitForServer(webUrl, 30_000);
      if (debug) console.log(`${tag} web ready at ${webUrl}`);

      // A second real token, this time for Bob — GET /api/agent/inbox always
      // resolves `recipientUserId` from whoever is authenticated (never a
      // caller-supplied param, api/src/routes/agent.ts), so reading Bob's
      // own ranked inbox requires being authenticated AS Bob, not merely
      // knowing his user id.
      const bobApiToken = await mintApiToken(apiUrl, 'bob.martinez@ship.local', 'admin123');
      if (debug) console.log(`${tag} minted Ship API token for bob.martinez@ship.local`);

      await use({
        apiUrl,
        webUrl,
        agentUrl,
        internalSecret,
        probeDocumentId: seedResult.probeDocumentId,
        probeDocumentTitle: seedResult.probeDocumentTitle,
        bobUserId: seedResult.bobUserId,
        devUserEmail,
        devUserPassword,
        devApiToken: shipApiToken,
        bobApiToken,
      });

      webProc.kill('SIGTERM');
      agentProc.kill('SIGTERM');
      apiProc.kill('SIGTERM');
      await dropScratchDatabase(scratch.adminUrl, scratch.dbName);
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ agentShip }, use) => {
    await use(agentShip.webUrl);
  },
});

/** Logs `page` in as the seeded dev user through the real UI — the exact
 * selector sequence `e2e/accountability-owner-change.spec.ts` already
 * established (`#email`/`#password`/"Sign in" button), reused rather than
 * reinvented. */
export async function loginAsDevUser(page: Page, env: AgentShipEnv): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(env.devUserEmail);
  await page.locator('#password').fill(env.devUserPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 10_000 });
}

/**
 * API-only login (CSRF -> POST /api/auth/login), for specs whose subject is
 * backend timing/behavior rather than the login UI itself — the
 * detection-latency spec logs in as two different people in one test (the
 * comment's author, then its recipient, to read THEIR inbox — `GET
 * /api/agent/inbox` always resolves to the session's own user, by design,
 * `api/src/routes/agent.ts`) and a full page navigation per login would add
 * unrelated UI latency to a test that is timing something else entirely.
 * `page.request` shares the browser context's cookie jar with `page` itself,
 * so a later `page.goto()` in the same test is authenticated as whoever
 * logged in last via this helper — no manual cookie handling needed here,
 * unlike the worker fixture's own `mintApiToken`, which has no browser
 * context to share.
 */
export async function loginViaApi(page: Page, apiUrl: string, email: string, password: string): Promise<void> {
  const csrfRes = await page.request.get(`${apiUrl}/api/csrf-token`);
  expect(csrfRes.ok(), await csrfRes.text()).toBe(true);
  const { token } = (await csrfRes.json()) as { token: string };

  const loginRes = await page.request.post(`${apiUrl}/api/auth/login`, {
    headers: { 'x-csrf-token': token },
    data: { email, password },
  });
  expect(loginRes.ok(), await loginRes.text()).toBe(true);
}

export { expect };
