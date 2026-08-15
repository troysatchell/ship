#!/usr/bin/env node
// Idempotent local-dev seed: registers a PUBLIC oauth_apps row for this demo
// (PF-802). Public clients never have a secret — PKCE is mandatory-and-
// sufficient (RFC 7636) — so there is no analogue to seedGraderApp.ts's
// GRADER_OAUTH_CLIENT_SECRET env-gated pattern here; this is safe to run
// against any local dev database, unconditionally, as many times as needed.
//
// Reads DATABASE_URL the same way `pnpm dev` sets it up (api/.env.local),
// so this only needs to be run once per worktree/database.
import { Client } from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(here, '../../../api/.env.local');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(envLocalPath)) {
    throw new Error(
      `DATABASE_URL not set and ${envLocalPath} does not exist. Run \`pnpm dev\` once first, or set DATABASE_URL yourself.`
    );
  }
  const contents = readFileSync(envLocalPath, 'utf8');
  const match = contents.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    throw new Error(`No DATABASE_URL line found in ${envLocalPath}.`);
  }
  return match[1].trim();
}

const PORT = process.env.BROWSER_DEMO_PORT ?? '5175';
const REDIRECT_URI = process.env.BROWSER_DEMO_REDIRECT_URI ?? `http://localhost:${PORT}/`;
export const BROWSER_DEMO_APP_NAME = 'Browser SDK Demo (PF-802, local dev)';
const CLIENT_ID_PREFIX = 'ship_app_browser_demo';

async function main() {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  try {
    const workspaceResult = await client.query(
      `SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) {
      throw new Error('No workspace found — run `pnpm db:seed` first.');
    }

    const existing = await client.query(
      `SELECT client_id, redirect_uris FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
      [workspace.id, BROWSER_DEMO_APP_NAME]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (!row.redirect_uris.includes(REDIRECT_URI)) {
        await client.query(
          `UPDATE oauth_apps SET redirect_uris = array_append(redirect_uris, $1) WHERE client_id = $2`,
          [REDIRECT_URI, row.client_id]
        );
        console.log(`Added redirect_uri ${REDIRECT_URI} to existing app ${row.client_id}`);
      } else {
        console.log(`Already seeded: client_id=${row.client_id}, redirect_uri=${REDIRECT_URI}`);
      }
      console.log(`\nVITE_SHIP_CLIENT_ID=${row.client_id}`);
      return;
    }

    const clientId = `${CLIENT_ID_PREFIX}_${Math.random().toString(16).slice(2, 10)}`;
    await client.query(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, redirect_uris, requested_scopes)
       VALUES ($1, $2, $3, 'public', $4, $5)`,
      [workspace.id, BROWSER_DEMO_APP_NAME, clientId, [REDIRECT_URI], ['documents:read']]
    );
    console.log(`✅ Created public OAuth app: client_id=${clientId}, redirect_uri=${REDIRECT_URI}`);
    console.log(`\nVITE_SHIP_CLIENT_ID=${clientId}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
