/**
 * PF-401's own AC, verbatim: "integration tests for each client against a
 * test server." This file covers the three resource clients whose server
 * routes actually exist and were verified before writing this file —
 * `documents` (PF-200: `GET /`, `GET /:id`, `POST /`), `issues` (PF-201:
 * `GET /` only), `sprints` (PF-201: `GET /` only). `webhooks` has no server
 * route to integration-test against at all (PF-302/304/305/306 not yet
 * built — see `resources/webhooks.ts`'s header comment for the verification
 * and `resources/__tests__/webhooks.test.ts` for what IS tested there:
 * request-shape only, against a mocked `fetch`, explicitly not claimed as
 * integration coverage).
 *
 * Same technique as `client.liveServer.test.ts` (PF-400) — read that file's
 * header first, this one follows it exactly: a REAL `http` listener
 * wrapping the REAL `createApp()`, driven by a REAL `ShipClient` (and, new
 * in this ticket, its real `.documents`/`.issues`/`.sprints` resource
 * clients) — a genuine TCP round trip, not a mocked `fetch` and not an
 * in-process supertest binding. THE ONE DELIBERATE CROSS-PACKAGE IMPORT
 * exception `client.liveServer.test.ts` documents applies here too, for the
 * same reason.
 *
 * `sdk/tsconfig.json` excludes `src/__tests__/**` from `tsc`/`tsc --noEmit`
 * for the same rootDir reason `client.liveServer.test.ts`'s header explains
 * (this file imports `api/src/...`, outside this package's rootDir).
 * `sdk/vitest.config.ts`'s `include` glob (every `*.test.ts` file anywhere
 * under `src/`) still covers it.
 *
 * DB SAFETY: same as `client.liveServer.test.ts` — this file creates its
 * own isolated workspace/user/token/document rows in `beforeAll` and
 * deletes them in `afterAll`; it does not touch `pnpm db:seed`'s fixtures,
 * and does not share a Postgres pool or an http server with that file (each
 * vitest test file gets its own module instance — same isolation guarantee
 * that file's own `afterAll` comment documents).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// The one deliberate cross-package import in this package — see the header
// comment above, and client.liveServer.test.ts's own header, for why.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';

import { ShipClient } from '../client.js';
import { ShipSdkError } from '../errors.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Same defensive `RETURNING id` helper as `client.liveServer.test.ts` —
 *  see that file's header for why this is not a `!` assertion. */
function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe('PF-401: DocumentsClient/IssuesClient/SprintsClient against a real running Ship API + the seeded worktree DB', () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const BASE_MS = Date.parse('2026-02-01T00:00:00.000Z');

  // Same optional-until-beforeAll-completes pattern as client.liveServer.test.ts,
  // and for the same reason (afterAll must be able to tell "beforeAll ran to
  // completion" from "beforeAll threw partway through").
  let server: import('http').Server | undefined;
  let baseUrl: string;

  let workspaceId: string | undefined;
  let userId: string | undefined;
  let fullScopeToken: string;
  let seededIssueId: string;
  let seededSprintId: string;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`PF-401 sdk resources test ${runId}`]
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    const userEmail = `pf401-sdk-resources-${runId}@ship.local`;
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, 'test-hash', 'PF-401 SDK Resources Test User', $2) RETURNING id`,
      [userEmail, workspaceId]
    );
    userId = insertedId(userResult.rows, 'user');

    // One token, scoped to every read/write scope this file's three clients
    // exercise — real scope enforcement is already covered per-route by
    // api/src/platform/api/v1/resources/__tests__/{documents,issues,sprints}.test.ts;
    // this file's job is proving the SDK's own request/response wiring, not
    // re-testing bearerAuth/requireScope's behavior.
    const raw = `ship_${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        `PF-401 sdk resources token ${crypto.randomBytes(4).toString('hex')}`,
        sha256Hex(raw),
        raw.slice(0, 12),
        ['documents:read', 'documents:write', 'issues:read', 'sprints:read'],
      ]
    );
    fullScopeToken = raw;

    // Seed one issue and one sprint directly (no create() route exists for
    // either — see resources/issues.ts's and resources/sprints.ts's own
    // headers) — same fixture pattern as
    // api/src/platform/api/v1/resources/__tests__/{issues,sprints}.test.ts.
    const issueResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, properties, created_at, updated_at)
       VALUES ($1, $2, 'issue', $3, $4, $4) RETURNING id`,
      [
        workspaceId,
        `PF-401 seeded issue ${runId}`,
        JSON.stringify({ state: 'in_progress', priority: 'high', assignee_id: null }),
        new Date(BASE_MS),
      ]
    );
    seededIssueId = insertedId(issueResult.rows, 'issue');

    const sprintResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, title, document_type, properties, created_at, updated_at)
       VALUES ($1, $2, 'sprint', $3, $4, $4) RETURNING id`,
      [
        workspaceId,
        `PF-401 seeded sprint ${runId}`,
        JSON.stringify({ sprint_number: 7, status: 'active' }),
        new Date(BASE_MS + 1000),
      ]
    );
    seededSprintId = insertedId(sprintResult.rows, 'sprint');

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
          await pool.query('DELETE FROM api_tokens WHERE workspace_id = $1', [workspaceId]);
          await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
        }
        if (userId) {
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);

  // ─── documents: create -> list -> get, a real round trip ─────────────

  it('documents.create() POSTs a real document and returns the real typed response', async () => {
    const client = new ShipClient({ token: fullScopeToken, baseUrl });

    const created = await client.documents.create({
      title: `PF-401 created doc ${runId}`,
      document_type: 'wiki',
      properties: { note: 'created via DocumentsClient.create()' },
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe(`PF-401 created doc ${runId}`);
    expect(created.document_type).toBe('wiki');
    expect(created.properties).toEqual({ note: 'created via DocumentsClient.create()' });
    expect(typeof created.created_at).toBe('string');
    expect(typeof created.updated_at).toBe('string');

    // documents.get(): fetch the exact same document back over a fresh request.
    const fetched = await client.documents.get(created.id);
    expect(fetched).toEqual(created);

    // documents.list(): the created document appears, filtered by type.
    const page = await client.documents.list({ type: 'wiki', limit: 20 });
    expect(page.data.some((d) => d.id === created.id)).toBe(true);
    expect(page.next_cursor === null || typeof page.next_cursor === 'string').toBe(true);
  });

  it('documents.create() with an empty title maps to a ShipSdkError with kind "validation"', async () => {
    const client = new ShipClient({ token: fullScopeToken, baseUrl });

    // An empty string still satisfies this SDK's own `title: string` type —
    // it's the server's `CreateDocumentRequestSchema` (`z.string().min(1)`)
    // that rejects it, over the real TCP round trip. That's what's under
    // test here, not this file's own type-checking (`create()`'s required
    // `title` field already makes an omitted title a compile error, which
    // is exactly why this test can't omit it and still type-check).
    await expect(client.documents.create({ title: '', document_type: 'wiki' })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('documents.get() with a well-formed but nonexistent id maps to a ShipSdkError with kind "not_found"', async () => {
    const client = new ShipClient({ token: fullScopeToken, baseUrl });

    await expect(client.documents.get('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      kind: 'not_found',
      httpStatus: 404,
    });
    await expect(client.documents.get('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      ShipSdkError
    );
  });

  // ─── issues: real list() against a seeded issue row ───────────────────

  it('issues.list() returns the seeded issue with state/priority/assignee_id lifted to typed top-level fields', async () => {
    const client = new ShipClient({ token: fullScopeToken, baseUrl });

    const page = await client.issues.list();

    const found = page.data.find((issue) => issue.id === seededIssueId);
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      id: seededIssueId,
      document_type: 'issue',
      state: 'in_progress',
      priority: 'high',
      assignee_id: null,
    });
  });

  // ─── sprints: real list() against a seeded sprint row ──────────────────

  it('sprints.list() returns the seeded sprint with document_type "sprint" and its raw properties', async () => {
    const client = new ShipClient({ token: fullScopeToken, baseUrl });

    const page = await client.sprints.list();

    const found = page.data.find((sprint) => sprint.id === seededSprintId);
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      id: seededSprintId,
      document_type: 'sprint',
      properties: { sprint_number: 7, status: 'active' },
    });
  });
});
