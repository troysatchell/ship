/**
 * PF-400's own AC, verbatim: "`new ShipClient({opts:{token}}).me()` returns
 * the typed user against a running server (the MVP gate check)." A test that
 * only mocks `fetch` does not satisfy this — this file binds a REAL `http`
 * listener wrapping the REAL `createApp()` and drives it with the REAL
 * `ShipClient.me()`, i.e. a real TCP round trip, not an in-process call.
 *
 * THE ONE DELIBERATE CROSS-PACKAGE IMPORT IN THIS PACKAGE: this file imports
 * `createApp`/`pool` directly from `api/src/...`, the same narrow exception
 * `agent/src/__tests__/gateWriteBoundary.dbRoundTrip.test.ts` already makes
 * (see that file's own header) and for the same reason — proving "a real
 * client, talking to the real server, backed by the real seeded database"
 * needs the real app and the real pool; a fake has no server or database
 * behind it to prove anything against. `agent/package.json` establishes that
 * this cross-import needs no extra dependency declared here either: Node
 * resolves `api/src/db/client.ts`'s own `pg` import from THAT file's physical
 * location (api/node_modules, already installed by the workspace `pnpm
 * install`), not from this package's package.json — verified by `agent`
 * doing exactly this today with no `pg` dependency of its own.
 *
 * `sdk/tsconfig.json` excludes `src/__tests__/**` from `tsc`/`tsc --noEmit`
 * (same reason agent's tsconfig excludes its own `src/__tests__/**` — these
 * files sit outside the package's `rootDir`) — see that file's own comment.
 * `sdk/vitest.config.ts`'s `include` still covers this file, so it runs and
 * asserts real behavior; it just isn't part of `pnpm --filter @ship/sdk
 * type-check`.
 *
 * DB SAFETY (verified before writing this, not assumed): under vitest with no
 * `api/.env.test` present in this worktree (checked — only
 * `.env.test.example` exists), `api/src/db/client.ts` loads nothing itself
 * and defers entirely to whatever `DATABASE_URL` the process already has —
 * i.e. this worktree's own factory-provisioned database (`.factory-env`).
 * This file creates its own isolated workspace/user/token rows in `beforeAll`
 * and deletes them in `afterAll`; it does not touch `pnpm db:seed`'s
 * fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import in this package — see the header
// comment above for why.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';

import { ShipClient } from '../client.js';
import { ShipSdkError } from '../errors.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** `RETURNING id` always returns exactly one row for a single-row INSERT, but
 *  under `noUncheckedIndexedAccess` `rows[0]` is still typed possibly
 *  `undefined` — fail loudly with a clear label instead of a `!` assertion
 *  (this repo's convention; see e.g. gateWriteBoundary.dbRoundTrip.test.ts's
 *  own `insertedId` helper). */
function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe('PF-400: ShipClient against a real running Ship API + the seeded worktree DB (MVP gate check)', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // `server`/`workspaceId`/`userId` are optional (not just "assigned in
  // beforeAll") so `afterAll` can tell "beforeAll ran to completion" from
  // "beforeAll threw partway through" and clean up only what actually got
  // created, instead of a bare `server.close(...)` throwing its own
  // "Cannot read properties of undefined" and masking the real setup error
  // (CodeRabbit finding, PR #TRO-405 — verified as a real gap: vitest still
  // runs `afterAll` after a throwing `beforeAll`).
  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let userId: string | undefined;
  let userEmail: string;
  let personalToken: string;
  let personalTokenScopes: string[];

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-400 sdk me() test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    userEmail = `pf400-sdk-me-${runId}@ship.local`;
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-400 SDK Me Test User', $2) RETURNING id`,
      [userEmail, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    // A scoped personal token — the token class bearerAuth actually accepts
    // at /api/v1 (a NULL-scopes row, the legacy unscoped internal token, is
    // rejected there — api/src/platform/oauth/bearerAuth.ts's own header
    // comment). Same fixture shape as
    // api/src/platform/api/v1/resources/__tests__/me.test.ts.
    personalTokenScopes = ['issues:read'];
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-400 sdk me() token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        personalTokenScopes,
      ]
    );
    personalToken = raw;

    // Real http.Server, real ephemeral TCP port — not supertest's in-memory
    // app binding. `server.address()` after 'listening' gives back the OS's
    // actually-assigned port.
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    // Nested try/finally so a failure at any one step (server close, a
    // DELETE, ...) still lets later cleanup steps run — most importantly
    // `pool.end()`, which must fire even if `beforeAll` died before creating
    // any DB rows or the server at all.
    try {
      if (server) {
        const liveServer = server;
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
    } finally {
      try {
        if (workspaceId) {
          await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
        }
        if (userId) {
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        // Nothing else in sdk's own test suite imports api/src/db/client.js —
        // ending the pool here does not affect any other test file (vitest
        // isolates modules per file by default; same reasoning
        // gateWriteBoundary.dbRoundTrip.test.ts's own afterAll documents).
        await pool.end();
      }
    }
  }, 30_000);

  it('new ShipClient({ token, baseUrl }).me() returns the typed user for a real bearer token, over a real TCP round trip', async () => {
    const client = new ShipClient({ token: personalToken, baseUrl });

    const me = await client.me();

    expect(me.app).toBeNull();
    expect(me.user).toEqual({ id: userId, email: userEmail, name: 'PF-400 SDK Me Test User' });
    expect(me.scopes).toEqual(personalTokenScopes);
  });

  it('an invalid token maps to a ShipSdkError with kind "auth" (unauthorized -> auth), still over a real TCP round trip', async () => {
    const client = new ShipClient({ token: 'not-a-real-token', baseUrl });

    await expect(client.me()).rejects.toMatchObject({
      kind: 'auth',
      httpStatus: 401,
    });
    await expect(client.me()).rejects.toBeInstanceOf(ShipSdkError);
  });

  it('a request to a baseUrl nothing is listening on throws a ShipSdkError with kind "network"', async () => {
    // Port 1 is a privileged, essentially-never-bound port — a real network
    // path with nothing listening, unlike a made-up hostname (which could
    // resolve to a captive portal in some environments).
    const client = new ShipClient({ token: personalToken, baseUrl: 'http://127.0.0.1:1' });

    await expect(client.me()).rejects.toMatchObject({ kind: 'network' });
  });
});
