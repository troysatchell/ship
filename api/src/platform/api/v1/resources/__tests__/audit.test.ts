/**
 * PF-501 (Linear TRO-432) — `/api/v1/audit`: the admin/owner-scoped
 * authorization matrix, workspace isolation, the app_client_id filter, and
 * cursor pagination.
 *
 * Mirrors `webhooks.test.ts`'s fixture/token shape (personal tokens via
 * `api_tokens.scopes`, `oauth_apps`/`oauth_tokens` for Client Credentials
 * principals) — see `resources/audit.ts`'s file header for the full
 * "admin/owner-scoped" design this matrix proves.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

interface AuditRowBody {
  id: string;
  request_id: string;
  app_client_id: string | null;
  user_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
  created_at: string;
}

interface ListResponseBody {
  data: AuditRowBody[];
  next_cursor: string | null;
}

describe('PF-501: /api/v1/audit (Linear TRO-432)', () => {
  const app: Express = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let otherWorkspaceId: string;

  let superAdminUserId: string;
  let adminUserId: string;
  let memberUserId: string;

  let firstPartyAppClientId: string;
  let firstPartyAppId: string;
  let thirdPartyAppClientId: string;
  let thirdPartyAppId: string;
  let otherWorkspaceAppClientId: string;

  /** scopes = ['audit:read'], user is_super_admin = true. */
  let ownerToken: string;
  /** scopes = ['audit:read'], user has workspace_memberships.role = 'admin' in workspaceId. */
  let adminToken: string;
  /** scopes = ['audit:read'], user has workspace_memberships.role = 'member' in workspaceId — holds the scope but not authorized. */
  let memberToken: string;
  /** scopes = ['documents:read'] only — the generic missing-scope 403 case. */
  let noScopeToken: string;
  /** Client Credentials, firstPartyAppId, scopes = ['audit:read']. */
  let firstPartyAppToken: string;
  /** Client Credentials, thirdPartyAppId, scopes = ['audit:read'] — held but not first-party. */
  let thirdPartyAppToken: string;

  function onlyRow<T>(rows: T[]): T {
    const [row] = rows;
    if (row === undefined) {
      throw new Error(`Expected exactly one row, got ${rows.length}.`);
    }
    return row;
  }

  async function insertPersonalToken(userId: string, wsId: string, scopes: string[]): Promise<string> {
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, wsId, `PF-501 token ${crypto.randomBytes(4).toString('hex')}`, sha256Hex(raw), raw.slice(0, 12), scopes]
    );
    return raw;
  }

  async function insertOauthApp(
    inWorkspaceId: string,
    name: string,
    isFirstParty: boolean
  ): Promise<{ id: string; clientId: string }> {
    const clientId = `ship_app_${crypto.randomBytes(8).toString('hex')}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (workspace_id, name, client_id, client_type, is_first_party)
       VALUES ($1, $2, $3, 'confidential', $4) RETURNING id`,
      [inWorkspaceId, name, clientId, isFirstParty]
    );
    return { id: onlyRow(result.rows).id, clientId };
  }

  async function insertOauthClientCredentialsToken(appId: string, scopes: string[]): Promise<string> {
    const raw = `oauth_at_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO oauth_tokens (app_id, user_id, scopes, access_token_hash, expires_at)
       VALUES ($1, NULL, $2, $3, now() + interval '1 hour')`,
      [appId, scopes, sha256Hex(raw)]
    );
    return raw;
  }

  async function insertAuditRow(opts: {
    appClientId: string | null;
    userId: string | null;
    route: string;
    status?: number;
    /** Explicit created_at, for the pagination test below — see that
     *  test's own comment for why relying on natural insert-order timing
     *  is not safe for THIS table specifically. Omitted elsewhere;
     *  defaults to `now()`. */
    createdAt?: Date;
  }): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public_api_audit (request_id, app_client_id, user_id, method, route, scope_used, status, latency_ms, created_at)
       VALUES ($1, $2, $3, 'GET', $4, 'documents:read', $5, 5, COALESCE($6, now()))
       RETURNING id`,
      [
        `seed-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
        opts.appClientId,
        opts.userId,
        opts.route,
        opts.status ?? 200,
        opts.createdAt ?? null,
      ]
    );
    return onlyRow(result.rows).id;
  }

  beforeAll(async () => {
    const wsResult = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `PF-501 Test ${testRunId}`,
    ]);
    workspaceId = onlyRow(wsResult.rows).id;

    const otherWsResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-501 Other Test ${testRunId}`]
    );
    otherWorkspaceId = onlyRow(otherWsResult.rows).id;

    async function insertUser(label: string, isSuperAdmin: boolean, lastWorkspaceId: string): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, is_super_admin, last_workspace_id)
         VALUES ($1, 'test-hash', $2, $3, $4) RETURNING id`,
        [`pf501-${label}-${testRunId}@ship.local`, `PF-501 ${label}`, isSuperAdmin, lastWorkspaceId]
      );
      return onlyRow(result.rows).id;
    }

    superAdminUserId = await insertUser('owner', true, workspaceId);
    adminUserId = await insertUser('admin', false, workspaceId);
    memberUserId = await insertUser('member', false, workspaceId);

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES
         ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member')`,
      [workspaceId, superAdminUserId, adminUserId, memberUserId]
    );

    const firstPartyApp = await insertOauthApp(workspaceId, `PF-501 First-Party ${testRunId}`, true);
    firstPartyAppId = firstPartyApp.id;
    firstPartyAppClientId = firstPartyApp.clientId;

    const thirdPartyApp = await insertOauthApp(workspaceId, `PF-501 Third-Party ${testRunId}`, false);
    thirdPartyAppId = thirdPartyApp.id;
    thirdPartyAppClientId = thirdPartyApp.clientId;

    const otherWorkspaceApp = await insertOauthApp(otherWorkspaceId, `PF-501 Other Workspace App ${testRunId}`, true);
    otherWorkspaceAppClientId = otherWorkspaceApp.clientId;

    ownerToken = await insertPersonalToken(superAdminUserId, workspaceId, ['audit:read']);
    adminToken = await insertPersonalToken(adminUserId, workspaceId, ['audit:read']);
    memberToken = await insertPersonalToken(memberUserId, workspaceId, ['audit:read']);
    noScopeToken = await insertPersonalToken(adminUserId, workspaceId, ['documents:read']);
    firstPartyAppToken = await insertOauthClientCredentialsToken(firstPartyAppId, ['audit:read']);
    thirdPartyAppToken = await insertOauthClientCredentialsToken(thirdPartyAppId, ['audit:read']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM public_api_audit WHERE app_client_id IN ($1, $2, $3) OR user_id IN ($4, $5, $6)', [
      firstPartyAppClientId,
      thirdPartyAppClientId,
      otherWorkspaceAppClientId,
      superAdminUserId,
      adminUserId,
      memberUserId,
    ]);
    await pool.query('DELETE FROM oauth_tokens WHERE app_id IN ($1, $2)', [firstPartyAppId, thirdPartyAppId]);
    await pool.query('DELETE FROM oauth_apps WHERE workspace_id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
    await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2, $3)', [superAdminUserId, adminUserId, memberUserId]);
    await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [workspaceId, otherWorkspaceId]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Auth failure shapes
  // ────────────────────────────────────────────────────────────────────────

  describe('auth failures', () => {
    it('401s with no bearer token', async () => {
      const res = await request(app).get('/api/v1/audit');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });

    it('403s a token missing the audit:read scope (generic requireScope rejection)', async () => {
      const res = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${noScopeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details?.missing_scope).toBe('audit:read');
    });

    it('403s a token that HOLDS audit:read but belongs to a plain workspace member (not admin/owner)', async () => {
      const res = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details?.reason).toBe('admin_or_owner_required');
    });

    it('403s a third-party app credential even though it holds audit:read — first-party is required', async () => {
      const res = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${thirdPartyAppToken}`);
      expect(res.status).toBe(403);
      expect(res.body.details?.reason).toBe('admin_or_owner_required');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Workspace isolation + owner-tier global visibility
  // ────────────────────────────────────────────────────────────────────────

  describe('workspace scoping', () => {
    let rowInWorkspaceViaApp: string;
    let rowInWorkspaceViaMember: string;
    let rowInOtherWorkspace: string;

    beforeAll(async () => {
      rowInWorkspaceViaApp = await insertAuditRow({
        appClientId: firstPartyAppClientId,
        userId: null,
        route: '/api/v1/documents',
      });
      rowInWorkspaceViaMember = await insertAuditRow({
        appClientId: null,
        userId: memberUserId,
        route: '/api/v1/issues',
      });
      rowInOtherWorkspace = await insertAuditRow({
        appClientId: otherWorkspaceAppClientId,
        userId: null,
        route: '/api/v1/sprints',
      });
    });

    it('an admin sees rows scoped to their own workspace (via app AND via a member\'s personal-token call), never another workspace\'s', async () => {
      const res = await request(app).get('/api/v1/audit?limit=100').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((r) => r.id);
      expect(ids).toContain(rowInWorkspaceViaApp);
      expect(ids).toContain(rowInWorkspaceViaMember);
      expect(ids).not.toContain(rowInOtherWorkspace);
    });

    it('a super-admin ("owner") sees rows across every workspace, unscoped', async () => {
      const res = await request(app).get('/api/v1/audit?limit=100').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((r) => r.id);
      expect(ids).toContain(rowInWorkspaceViaApp);
      expect(ids).toContain(rowInWorkspaceViaMember);
      expect(ids).toContain(rowInOtherWorkspace);
    });

    it('a first-party app credential sees rows scoped to its OWN workspace, never another workspace\'s', async () => {
      const res = await request(app).get('/api/v1/audit?limit=100').set('Authorization', `Bearer ${firstPartyAppToken}`);
      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((r) => r.id);
      expect(ids).toContain(rowInWorkspaceViaApp);
      expect(ids).not.toContain(rowInOtherWorkspace);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // app_client_id filter (AC: "queryable per app")
  // ────────────────────────────────────────────────────────────────────────

  describe('?app_client_id= filter', () => {
    let firstPartyRowId: string;
    let thirdPartyRowId: string;

    beforeAll(async () => {
      firstPartyRowId = await insertAuditRow({
        appClientId: firstPartyAppClientId,
        userId: null,
        route: '/api/v1/webhooks',
      });
      thirdPartyRowId = await insertAuditRow({
        appClientId: thirdPartyAppClientId,
        userId: null,
        route: '/api/v1/webhooks',
      });
    });

    it('narrows the result set to exactly one app, within the caller\'s already-authorized scope', async () => {
      const res = await request(app)
        .get(`/api/v1/audit?limit=100&app_client_id=${encodeURIComponent(firstPartyAppClientId)}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const body = res.body as ListResponseBody;
      const ids = body.data.map((r) => r.id);
      expect(ids).toContain(firstPartyRowId);
      expect(ids).not.toContain(thirdPartyRowId);
      for (const row of body.data) {
        expect(row.app_client_id).toBe(firstPartyAppClientId);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cursor pagination
  // ────────────────────────────────────────────────────────────────────────

  describe('cursor pagination', () => {
    const seededIds: string[] = [];

    beforeAll(async () => {
      // Explicit, second-spaced created_at values — NOT natural insert-order
      // timing. `pagination.ts`'s `encodeCursor` serializes via
      // `Date#toISOString()`, which is MILLISECOND precision, while
      // Postgres's own `timestamptz` column retains microseconds — two rows
      // landing in the same millisecond (reliably reproducible against this
      // ticket's fast local Docker Postgres: sequential awaited inserts here
      // measured under 1ms apart) can then fall on the wrong side of a
      // truncated cursor boundary and be silently, permanently dropped from
      // later pages. Confirmed as a genuine defect in the SHARED
      // `platform/api/v1/pagination.ts` mechanism (affects every /api/v1
      // list route — documents, issues, sprints, webhooks, and this one),
      // not specific to this test or this resource — out of scope to fix
      // under PF-501/TRO-432 (shared infra, needs its own regression tests
      // across every consuming resource); reported as a follow-up finding
      // in this ticket's final report instead. This test seeds rows a full
      // second apart specifically so IT verifies audit.ts's own pagination
      // wiring (the WHERE/ORDER BY/cursor plumbing) without tripping over
      // that separate, pre-existing precision bug.
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        const id = await insertAuditRow({
          appClientId: firstPartyAppClientId,
          userId: null,
          route: `/api/v1/pagination-probe-${i}`,
          createdAt: new Date(base + i * 1000),
        });
        seededIds.push(id);
      }
    });

    it('paginates with a stable cursor across pages, visiting every seeded row exactly once', async () => {
      const visited = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      do {
        const qs = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
        const res: request.Response = await request(app)
          .get(`/api/v1/audit?${qs}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        const body = res.body as ListResponseBody;
        expect(body.data.length).toBeLessThanOrEqual(2);
        for (const row of body.data) {
          expect(visited.has(row.id), `row ${row.id} was returned on more than one page`).toBe(false);
          visited.add(row.id);
        }
        cursor = body.next_cursor;
        pages++;
        expect(pages, 'pagination did not terminate within a sane number of pages').toBeLessThan(20);
      } while (cursor !== null);

      for (const id of seededIds) {
        expect(visited.has(id), `seeded row ${id} was never visited across any page`).toBe(true);
      }
    });

    it('400s an invalid cursor', async () => {
      const res = await request(app)
        .get('/api/v1/audit?cursor=not-a-valid-cursor')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // The middleware's own scope_used recording, proven end-to-end here
  // ────────────────────────────────────────────────────────────────────────

  it('the request that just listed the audit trail is itself audited, with scope_used = audit:read', async () => {
    const res = await request(app).get('/api/v1/audit').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');

    const deadline = Date.now() + 1000;
    let row: { scope_used: string | null; user_id: string | null; app_client_id: string | null } | undefined;
    while (Date.now() < deadline) {
      const result = await pool.query<{ scope_used: string | null; user_id: string | null; app_client_id: string | null }>(
        'SELECT scope_used, user_id, app_client_id FROM public_api_audit WHERE request_id = $1',
        [requestId]
      );
      row = result.rows[0];
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(row, 'expected the audit endpoint\'s own call to be recorded').toBeDefined();
    expect(row?.scope_used).toBe('audit:read');
    expect(row?.user_id).toBe(adminUserId);
    expect(row?.app_client_id).toBeNull();
  });
});
