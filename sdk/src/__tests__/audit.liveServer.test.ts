/**
 * `AuditClient.list()` against a real running Ship API — the end-to-end
 * counterpart to `resources/__tests__/audit.test.ts`'s mocked-`fetch`
 * request-shape proof. Same technique as `resources.liveServer.test.ts`
 * (read that file's header first, this one follows it exactly): a REAL
 * `http` listener wrapping the REAL `createApp()`, driven by a REAL
 * `ShipClient` — a genuine TCP round trip, not a mocked `fetch` and not an
 * in-process supertest binding. The one deliberate cross-package import
 * exception documented there applies here too.
 *
 * Scope: proves the SDK's own request/response wiring for `audit.list()`
 * across the two ends of PF-501's authorization design (`api/src/platform/
 * api/v1/resources/audit.ts`'s own header has the full design) —
 * an "owner" (super-admin) success, and a plain member's 403 — not the
 * complete admin/owner/first-party matrix, which
 * `api/src/platform/api/v1/resources/__tests__/audit.test.ts` already
 * covers exhaustively server-side. Re-proving every branch here would
 * duplicate that file, not add coverage.
 *
 * DB SAFETY: own isolated workspace/user/token/audit rows in `beforeAll`,
 * deleted in `afterAll`; does not touch `pnpm db:seed`'s fixtures or share a
 * Postgres pool/http server with any other file (own module instance).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import — see this file's header.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';

import { ShipClient } from '../client.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe('PF-501: AuditClient against a real running Ship API + the seeded worktree DB', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let ownerUserId: string | undefined;
  let memberUserId: string | undefined;
  let ownerToken: string;
  let memberToken: string;
  let seededAuditRowId: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-501 sdk audit test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const ownerResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, is_super_admin, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-501 SDK Owner', true, $2) RETURNING id`,
      [`pf501-sdk-owner-${runId}@ship.local`, workspaceId]
    );
    ownerUserId = insertedId(ownerResult.rows, 'owner user');

    const memberResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-501 SDK Member', $2) RETURNING id`,
      [`pf501-sdk-member-${runId}@ship.local`, workspaceId]
    );
    memberUserId = insertedId(memberResult.rows, 'member user');

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, memberUserId]
    );

    async function insertToken(userId: string): Promise<string> {
      const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
      await pool.query(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          workspaceId,
          `PF-501 sdk audit token ${crypto.randomBytes(4).toString('hex')}`,
          sha256Hex(raw),
          raw.slice(0, 12),
          ['audit:read'],
        ]
      );
      return raw;
    }

    ownerToken = await insertToken(ownerUserId);
    memberToken = await insertToken(memberUserId);

    // A real /api/v1 call under the owner's own token would ALSO write this
    // row via auditLogMiddleware; seeding it directly keeps this test's
    // assertions independent of that async, fire-and-forget side effect.
    const auditRowResult = await pool.query<{ id: string }>(
      `INSERT INTO public_api_audit (request_id, app_client_id, user_id, method, route, scope_used, status, latency_ms)
       VALUES ($1, NULL, $2, 'GET', '/api/v1/documents', 'documents:read', 200, 7)
       RETURNING id`,
      [`pf501-sdk-seed-${runId}`, memberUserId]
    );
    seededAuditRowId = insertedId(auditRowResult.rows, 'audit row');

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
    try {
      if (server) {
        const liveServer = server;
        await new Promise<void>((resolve) => liveServer.close(() => resolve()));
      }
    } finally {
      try {
        if (workspaceId) {
          await pool.query('DELETE FROM public_api_audit WHERE user_id IN ($1, $2)', [ownerUserId, memberUserId]);
          await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
          await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
        }
        if (ownerUserId || memberUserId) {
          await pool.query('DELETE FROM users WHERE id = ANY($1)', [[ownerUserId, memberUserId].filter(Boolean)]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);

  it("audit.list() returns the seeded row for a super-admin ('owner') token", async () => {
    const client = new ShipClient({ token: ownerToken, baseUrl });

    const page = await client.audit.list({ limit: 100 });

    expect(page.data.some((r) => r.id === seededAuditRowId)).toBe(true);
    const found = page.data.find((r) => r.id === seededAuditRowId);
    expect(found).toMatchObject({
      user_id: memberUserId,
      app_client_id: null,
      method: 'GET',
      route: '/api/v1/documents',
      scope_used: 'documents:read',
      status: 200,
      latency_ms: 7,
    });
  });

  it('audit.list() rejects with kind "forbidden" for a plain workspace member (not admin/owner)', async () => {
    const client = new ShipClient({ token: memberToken, baseUrl });

    await expect(client.audit.list()).rejects.toMatchObject({ kind: 'forbidden', httpStatus: 403 });
  });
});
