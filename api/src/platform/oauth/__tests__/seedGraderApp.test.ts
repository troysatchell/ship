/**
 * Regression suite for TRO-441 / PF-907 (grader access — seeded read-only OAuth app).
 *
 * Test design source: Linear TRO-441 comment "Test design (pre-implementation —
 * ship-test-designer, 2026-08-10)", AC-1. That comment's suggested path
 * (`api/src/db/__tests__/seedGraderApp.test.ts`) assumed the seed module would live
 * alongside `db/seed.ts`; it was placed at `api/src/platform/oauth/seedGraderApp.ts`
 * instead (PF-102's app-registration/credentials machinery lives there, and this
 * module reuses `credentials.ts` directly), so the test sits next to it as
 * `__tests__/seedGraderApp.test.ts` — the same "utility tests live in `__tests__/` next
 * to the util" convention `app-registration.test.ts` already follows in this directory.
 * The test design comment explicitly allows this: "adjust to wherever the implementer
 * places the boot/migration seed, but it must land under `api/src/**\/*.test.ts`."
 *
 * Scope note (TRO-441 dispatch): only AC-1 (the seed itself) is in scope for this
 * ticket. AC-2 (`/api/v1/openapi.json` publicly resolvable) and the README
 * clean-machine-run / GitHub-visibility DoD items are explicitly out of this test's
 * scope — see CHANGES.md's TRO-441 entry for the full in-scope/deferred split.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import {
  seedGraderApp,
  GRADER_OAUTH_CLIENT_SECRET_ENV_VAR,
  GRADER_APP_NAME,
} from '../seedGraderApp.js';

describe('seedGraderApp (PF-907 / TRO-441)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testWorkspaceName = `Grader Seed Test ${testRunId}`;
  const testSecret = `test-grader-secret-${testRunId}`;

  let workspaceId: string;
  let originalEnvValue: string | undefined;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [testWorkspaceName]
    );
    workspaceId = workspaceResult.rows[0]!.id;

    originalEnvValue = process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
    process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR] = testSecret;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);

    if (originalEnvValue === undefined) {
      delete process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
    } else {
      process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR] = originalEnvValue;
    }
  });

  it('AC-1: seeding twice in sequence produces exactly one oauth_apps row (idempotent)', async () => {
    const first = await seedGraderApp(pool, workspaceId);
    expect(first.status).toBe('created');

    const second = await seedGraderApp(pool, workspaceId);
    expect(second.status).toBe('exists');
    if (first.status === 'created' && second.status === 'exists') {
      expect(second.clientId).toBe(first.clientId);
    }

    const rows = await pool.query(
      `SELECT * FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, GRADER_APP_NAME]
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('AC-1: the seeded row is first-party with exactly the read-only scopes, no write/manage scope', async () => {
    await seedGraderApp(pool, workspaceId);

    const result = await pool.query<{
      is_first_party: boolean;
      requested_scopes: string[];
      client_type: string;
    }>(
      `SELECT is_first_party, requested_scopes, client_type
       FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, GRADER_APP_NAME]
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row!.is_first_party).toBe(true);

    const scopes = row!.requested_scopes;
    expect(scopes).toEqual(
      expect.arrayContaining(['documents:read', 'issues:read', 'sprints:read'])
    );
    expect(scopes).toHaveLength(3);
    expect(scopes.some((s) => s.endsWith(':write'))).toBe(false);
    expect(scopes).not.toContain('webhooks:manage');
  });

  it('AC-1: client_secret_hash is present and is not the raw secret', async () => {
    await seedGraderApp(pool, workspaceId);

    const result = await pool.query<{ client_secret_hash: string | null }>(
      `SELECT client_secret_hash FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, GRADER_APP_NAME]
    );
    const hash = result.rows[0]?.client_secret_hash;
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe(testSecret);

    // Same hashing pattern as PF-102's credentials.ts / api_tokens.ts: SHA-256 hex digest.
    const expectedHash = crypto.createHash('sha256').update(testSecret).digest('hex');
    expect(hash).toBe(expectedHash);
  });

  it('AC-1: the raw secret is read from process.env via the module-exported env-var-name constant, never a hardcoded literal', async () => {
    // This assertion is structural, not behavioral: it proves the test (and
    // by extension, any caller) never has to know the literal string
    // "GRADER_OAUTH_CLIENT_SECRET" — only the module's own exported constant.
    // If PF-900's Terraform artifact ever renames the var, this test breaks
    // at the constant's definition, not silently here.
    expect(GRADER_OAUTH_CLIENT_SECRET_ENV_VAR).toBe('GRADER_OAUTH_CLIENT_SECRET');

    const distinctSecret = `${testSecret}-distinct`;
    const previous = process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
    process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR] = distinctSecret;
    try {
      // Fresh workspace so this doesn't collide with the already-seeded row above.
      const freshWorkspace = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
        [`${testWorkspaceName} distinct-secret`]
      );
      const freshWorkspaceId = freshWorkspace.rows[0]!.id;
      try {
        const seedResult = await seedGraderApp(pool, freshWorkspaceId);
        expect(seedResult.status).toBe('created');

        const row = await pool.query<{ client_secret_hash: string }>(
          `SELECT client_secret_hash FROM oauth_apps WHERE workspace_id = $1 AND name = $2`,
          [freshWorkspaceId, GRADER_APP_NAME]
        );
        const expectedHash = crypto.createHash('sha256').update(distinctSecret).digest('hex');
        expect(row.rows[0]!.client_secret_hash).toBe(expectedHash);
      } finally {
        await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [freshWorkspaceId]);
        await pool.query(`DELETE FROM workspaces WHERE id = $1`, [freshWorkspaceId]);
      }
    } finally {
      if (previous === undefined) delete process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
      else process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR] = previous;
    }
  });

  it('skips (does not throw, does not create a row) when the secret env var is unset — safe for a normal local db:seed run', async () => {
    const freshWorkspace = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`${testWorkspaceName} no-secret`]
    );
    const freshWorkspaceId = freshWorkspace.rows[0]!.id;
    const previous = process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
    delete process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
    try {
      const result = await seedGraderApp(pool, freshWorkspaceId);
      expect(result.status).toBe('skipped_no_secret');

      const rows = await pool.query(`SELECT id FROM oauth_apps WHERE workspace_id = $1`, [
        freshWorkspaceId,
      ]);
      expect(rows.rows).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
      else process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR] = previous;
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [freshWorkspaceId]);
    }
  });
});
