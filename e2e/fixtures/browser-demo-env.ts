/**
 * Worker-scoped fixture: a `vite preview` server for `integrations/browser-
 * demo` (PF-802), layered on top of `./isolated-env`'s `apiServer`/
 * `dbContainer`/`webServer` fixtures the same way that file's own `webServer`
 * sits on `apiServer` — a sibling addition, not an edit to that shared file
 * (lower collision risk with concurrent factory lanes touching e2e
 * infrastructure this same week).
 *
 * Unlike `web/`, this demo's `dist/` is built ONCE (module-level guard, not
 * per-worker) because `src/main.ts` resolves its `client_id`/API base URL
 * from `window.__SHIP_DEMO_CONFIG__` at RUNTIME when present (see that
 * file's header) rather than baking them in at build time — so the same
 * static bundle can be pointed at any worker's per-run API server and
 * seeded OAuth app via `page.addInitScript()`, with no rebuild per worker.
 */
import { test as base } from './isolated-env.js';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import { rmSync } from 'fs';
import getPort from 'get-port';
import { Pool } from 'pg';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEMO_ROOT = path.join(PROJECT_ROOT, 'integrations/browser-demo');

let builtOnce = false;

/** Builds @ship/sdk (this demo's only runtime dependency) and the demo
 * bundle itself. Guarded module-level, not per-worker — every worker in one
 * Playwright run shares the same built output, matching `global-setup.ts`'s
 * "build once, many lightweight preview servers" convention for `web/`.
 *
 * ALWAYS rebuilds (does not skip when dist/ already exists) — an existing
 * `sdk/dist` on disk could be stale relative to the checked-out `sdk/src`
 * (e.g. left over from a prior branch, or from before a merge-forward
 * changed sdk/src), and this fixture has no way to tell "present" from
 * "current" without just rebuilding. Also clears `sdk/tsconfig.tsbuildinfo`
 * before rebuilding — a real bug hit once already while developing this
 * ticket: TS's incremental build cache left `dist/resources/issues.js` and
 * `dist/resources/webhooks.js` unemitted after an `rm -rf dist` without
 * also clearing it, and the resulting build looked successful (no error)
 * while silently missing files a later `import` would fail to resolve.
 * CodeRabbit review finding (TRO-449), fixed. */
function ensureBuilt(): void {
  if (builtOnce) return;
  rmSync(path.join(PROJECT_ROOT, 'sdk/tsconfig.tsbuildinfo'), { force: true });
  execSync('pnpm --filter @ship/sdk build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  execSync('pnpm --filter @ship/browser-demo build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  builtOnce = true;
}

/** Duplicated from `./isolated-env.js` (not exported there) — same
 * trade-off `e2e/oauth-pkce-chain.spec.ts`'s own header documents for why it
 * re-declares rather than imports a sibling file's private helper. */
async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 403) return;
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms. Last error: ${lastError?.message}`);
}

type BrowserDemoFixtures = {
  browserDemoServer: { url: string; process: ChildProcess };
};

/** Mirrors integrations/browser-demo/src/main.ts's own `ShipDemoConfig` +
 * `declare global` — a separate compilation project from this one (e2e/'s
 * own tsconfig), so this is a second, independent declaration of the same
 * shape rather than a shared import; see this file's header. */
export interface ShipDemoConfig {
  clientId: string;
  apiBaseUrl: string;
  redirectUri?: string;
  scope?: string;
}
declare global {
  interface Window {
    __SHIP_DEMO_CONFIG__?: ShipDemoConfig;
  }
}

export const test = base.extend<object, BrowserDemoFixtures>({
  browserDemoServer: [
    async ({}, use, workerInfo) => {
      ensureBuilt();
      const port = await getPort();
      const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
        cwd: DEMO_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        const debug = process.env.DEBUG === '1';
        const workerTag = `[Worker ${workerInfo.workerIndex}]`;
        proc.stdout?.on('data', (data) => {
          if (debug) console.log(`${workerTag} browser-demo: ${data.toString().trim()}`);
        });
        proc.stderr?.on('data', (data) => {
          if (debug) console.log(`${workerTag} browser-demo: ${data.toString().trim()}`);
        });

        const url = `http://localhost:${port}`;
        await waitForServer(url, 30000);
        await use({ url, process: proc });
      } finally {
        proc.kill('SIGTERM');
      }
    },
    { scope: 'worker' },
  ],
});

/** Seeds a PUBLIC `oauth_apps` row scoped to this test's redirect_uri — same
 * shape as `e2e/oauth-pkce-chain.spec.ts`'s `seedOAuthApp` (duplicated, not
 * imported, for the same reason that file gives). */
export async function seedBrowserDemoOAuthApp(
  dbUrl: string,
  redirectUri: string
): Promise<{ clientId: string }> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const workspaceResult = await pool.query<{ id: string }>(
      `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`
    );
    const [workspace] = workspaceResult.rows;
    if (!workspace) throw new Error('seedMinimalTestData should have created a workspace');

    const clientId = `ship_app_browser_demo_e2e_${Math.random().toString(16).slice(2, 10)}`;
    await pool.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, 'PF-802 Browser Demo E2E Client', $2, 'public', $3, $4)`,
      [workspace.id, clientId, [redirectUri], ['documents:read']]
    );
    return { clientId };
  } finally {
    await pool.end();
  }
}

export { expect } from '@playwright/test';
