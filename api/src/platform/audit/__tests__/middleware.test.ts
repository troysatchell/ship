/**
 * PF-501 (Linear TRO-432) — `auditLogMiddleware` / `writeAuditRow`.
 *
 * Two layers, matching the file header's own split:
 *   1. `writeAuditRow` — a pure DB-write unit test: exact columns, exact
 *      nullability.
 *   2. `auditLogMiddleware` wired into a real app — an HTTP round-trip
 *      proves the fire-and-forget write actually lands (polls the table
 *      rather than trusting the shape alone), for both a genuinely public
 *      route (no principal, no scope) and a route rejected before any
 *      scope check runs (401, scope_used stays null). The full
 *      admin/owner authorization matrix for `GET /api/v1/audit` itself is
 *      `resources/__tests__/audit.test.ts`'s job, not this file's — this
 *      file only needs to prove the MIDDLEWARE records what happened, not
 *      that authorization is correct.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { writeAuditRow } from '../middleware.js';

/** Narrows a supertest response header to a definite string, throwing loudly
 * rather than a cast — same "fail loudly at the call site" convention
 * `webhooks.test.ts`'s `onlyRow` uses (CodeRabbit precedent, that PR's
 * review), applied to a header lookup instead of a query-row lookup. */
function requireHeader(res: request.Response, name: string): string {
  const value: unknown = res.headers[name];
  if (typeof value !== 'string') {
    throw new Error(`Expected response header "${name}" to be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Polls `public_api_audit` for a row with this request_id. The write is
 * fire-and-forget (after `res.on('finish')`), so it can land a few event-
 * loop turns after the HTTP response returns — an observable condition to
 * poll for, not a fixed sleep (ship-qa / lessons.md rule 17). Bounded at
 * 1000ms total, well over what a single local INSERT ever takes. */
async function pollForAuditRow(requestId: string): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT * FROM public_api_audit WHERE request_id = $1', [requestId]);
    if (result.rows[0]) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

describe('PF-501: writeAuditRow (Linear TRO-432)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  afterAll(async () => {
    await pool.query(`DELETE FROM public_api_audit WHERE request_id LIKE $1`, [`unit-${testRunId}-%`]);
  });

  it('inserts a row with every column, including nullable ones populated', async () => {
    const requestId = `unit-${testRunId}-full`;
    await writeAuditRow({
      requestId,
      appClientId: 'ship_app_test',
      userId: null,
      method: 'GET',
      route: '/api/v1/webhooks',
      scopeUsed: 'webhooks:manage',
      status: 200,
      latencyMs: 42,
    });

    const result = await pool.query('SELECT * FROM public_api_audit WHERE request_id = $1', [requestId]);
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row.app_client_id).toBe('ship_app_test');
    expect(row.user_id).toBeNull();
    expect(row.method).toBe('GET');
    expect(row.route).toBe('/api/v1/webhooks');
    expect(row.scope_used).toBe('webhooks:manage');
    expect(row.status).toBe(200);
    expect(row.latency_ms).toBe(42);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('tolerates NULL app_client_id, user_id, and scope_used (an unauthenticated/public-route call)', async () => {
    const requestId = `unit-${testRunId}-nulls`;
    await writeAuditRow({
      requestId,
      appClientId: null,
      userId: null,
      method: 'GET',
      route: '/api/v1/health',
      scopeUsed: null,
      status: 200,
      latencyMs: 1,
    });

    const result = await pool.query('SELECT * FROM public_api_audit WHERE request_id = $1', [requestId]);
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row.app_client_id).toBeNull();
    expect(row.user_id).toBeNull();
    expect(row.scope_used).toBeNull();
  });
});

describe('PF-501: auditLogMiddleware wired into a real request (Linear TRO-432)', () => {
  const app: Express = createApp();

  afterAll(async () => {
    await pool.query(`DELETE FROM public_api_audit WHERE route IN ($1, $2)`, [
      '/api/v1/health',
      '/api/v1/webhooks',
    ]);
  });

  it('records a genuinely public route (GET /health): no principal, no scope, status 200', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    const requestId = requireHeader(res, 'x-request-id');

    const row = await pollForAuditRow(requestId);
    expect(row, 'expected a public_api_audit row to land for this request_id').not.toBeNull();
    expect(row?.method).toBe('GET');
    expect(row?.route).toBe('/api/v1/health');
    expect(row?.status).toBe(200);
    expect(row?.app_client_id).toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.scope_used).toBeNull();
    expect(typeof row?.latency_ms).toBe('number');
    expect(row?.latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('records a 401 rejected before any scope check runs: scope_used stays null', async () => {
    // GET /api/v1/webhooks has a requireScope('webhooks:manage') in its
    // chain, but bearerAuth runs first and rejects a missing token before
    // requireScope is ever reached — proving scope_used reflects what was
    // ACTUALLY checked for this request, not what the route would check on
    // a successful path.
    const res = await request(app).get('/api/v1/webhooks');
    expect(res.status).toBe(401);
    const requestId = requireHeader(res, 'x-request-id');

    const row = await pollForAuditRow(requestId);
    expect(row, 'expected a public_api_audit row to land for this 401').not.toBeNull();
    expect(row?.status).toBe(401);
    expect(row?.route).toBe('/api/v1/webhooks');
    expect(row?.scope_used).toBeNull();
    expect(row?.app_client_id).toBeNull();
    expect(row?.user_id).toBeNull();
  });
});
