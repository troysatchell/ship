/**
 * TRO-177 (API-6) — queries issued per authenticated `GET /api/documents/:id`.
 *
 * The audit measured this endpoint returning ~2.2 KB from one indexed primary-key
 * lookup while costing P50 2.6 ms / P95 4.8 ms at c=10. Most of that work was not the
 * document read: `authMiddleware` ran a session+user SELECT, a workspace-membership
 * SELECT, and an *unconditional* `UPDATE sessions SET last_activity` in front of every
 * request (TRO-179 / DB-2 measured the same statement from the SQL side).
 *
 * This is the HTTP-side pin: it counts the statements one repeat read actually issues.
 * A wiki document costs 2 statements of real work (visibility check + associations),
 * so anything above that is auth overhead. The unconditional write made it 3 statements
 * of overhead; the 60s throttle makes it 2.
 *
 * Conditions: NODE_ENV=test (set by api/src/test/setup.ts), vitest + supertest against
 * the worktree's own PostgreSQL, sequential (concurrency 1). This measures query COUNT,
 * not latency — reproducing the audit's c=10/c=50 latency numbers needs a running server
 * and a load generator, not the unit suite.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

/** Statements the document read itself needs: visibility check + belongs_to associations. */
const ROUTE_QUERIES = 2;
/** Session+user SELECT and workspace-membership SELECT. The third — the last_activity
 *  UPDATE — is what TRO-179/TRO-177 removed from the hot path. */
const AUTH_QUERIES = 2;
const EXPECTED_QUERIES_PER_READ = AUTH_QUERIES + ROUTE_QUERIES;

describe('GET /api/documents/:id query count (TRO-177 / API-6)', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let sessionCookie: string;
  let docId: string;

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Query Count Test ${testRunId}`]
    );
    const workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Query Count User') RETURNING id`,
      [`query-count-${testRunId}@ship.local`]
    );
    const userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    );

    const doc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
       VALUES ($1, 'wiki', 'Query Count Doc', $2, 'workspace') RETURNING id`,
      [workspaceId, userId]
    );
    docId = doc.rows[0].id;

    // last_activity defaults to now(), so the session starts inside the throttle window.
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId]
    );
    sessionCookie = `session_id=${sessionId}`;
  });

  /** Run one request with pool.query spied, returning the statements it issued. */
  async function statementsForOneRead(): Promise<string[]> {
    const spy = vi.spyOn(pool, 'query');
    try {
      const res = await request(app).get(`/api/documents/${docId}`).set('Cookie', sessionCookie);
      expect(res.status, 'the measured request must actually succeed').toBe(200);
      return spy.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
    } finally {
      spy.mockRestore();
    }
  }

  it('does not rewrite the session row on a repeat read inside the throttle window', async () => {
    // Warm-up: whatever the first request does, the second is inside the 60s window.
    await request(app).get(`/api/documents/${docId}`).set('Cookie', sessionCookie).expect(200);

    const sql = await statementsForOneRead();
    const sessionWrites = sql.filter((s) => s.startsWith('UPDATE sessions SET last_activity'));

    expect(
      sessionWrites,
      'a read must not dirty the shared session row — every page load fires 5-13 of these'
    ).toHaveLength(0);
  });

  it('costs the session+membership SELECTs and nothing more in the auth prelude', async () => {
    await request(app).get(`/api/documents/${docId}`).set('Cookie', sessionCookie).expect(200);

    const sql = await statementsForOneRead();
    // Everything the route itself does not need is auth overhead.
    const authStatements = sql.filter(
      (s) => !/FROM documents\b|FROM document_associations\b/.test(s)
    );

    expect(
      authStatements,
      `auth prelude should be ${AUTH_QUERIES} SELECTs, got: ${JSON.stringify(authStatements)}`
    ).toHaveLength(AUTH_QUERIES);
    expect(
      authStatements.every((s) => s.startsWith('SELECT')),
      'the auth prelude must be read-only on the hot path'
    ).toBe(true);
  });

  it(`issues ${EXPECTED_QUERIES_PER_READ} queries total for one authenticated wiki read`, async () => {
    await request(app).get(`/api/documents/${docId}`).set('Cookie', sessionCookie).expect(200);

    const sql = await statementsForOneRead();

    expect(
      sql,
      `one repeat read should cost ${EXPECTED_QUERIES_PER_READ} statements ` +
        `(${AUTH_QUERIES} auth + ${ROUTE_QUERIES} document); got:\n${sql.join('\n')}`
    ).toHaveLength(EXPECTED_QUERIES_PER_READ);
  });
});
