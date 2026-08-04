/**
 * TRO-321 / FG-8 proof #1 — the live-DB half.
 *
 * The ticket's own words: "there's no live 'agent service running against a
 * seeded Ship' harness in this test suite ... the most rigorous version you
 * can build is (a) a static/structural check [graphWriteBoundary.test.ts]
 * and (b) a live-against-your-local-worktree-database integration test that
 * runs FG-5's actual proactive nodes end-to-end against the seeded worktree
 * DB ... and asserts document_history row count and automated_by values are
 * unchanged before/after." This file is (b).
 *
 * WHY A CROSS-PACKAGE IMPORT: this file imports `createApp`/`pool` directly
 * from `api/src/...` — the only file in this whole bundle that does. That is
 * a deliberate, narrow exception, not a new convention: the proof this
 * ticket needs is that the REAL Ship API, talking to the REAL seeded
 * Postgres database, receives a full `proactive_fast` graph run and writes
 * NOTHING — a fake `ShipClientLike` (every other test in this package's own
 * convention) cannot prove that, because a fake has no database behind it to
 * accidentally write to in the first place. `api/src/routes/standups.test.ts`
 * already establishes the exact pattern this file reuses (`createApp()` +
 * a real `pool`, no mocks) — this file is that same pattern, run from the
 * agent package instead of the api package.
 *
 * SAFETY, verified before writing this (not assumed):
 *  - `api/src/db/envFile.ts`: under vitest, with no `api/.env.test` (checked
 *    — only `.env.test.example` exists in this worktree), `client.ts` loads
 *    NOTHING and defers entirely to `process.env.DATABASE_URL` — i.e.
 *    whatever `.factory-env` already exported for THIS worktree. There is no
 *    path by which importing `api/src/db/client.js` here could silently
 *    point at a different worktree's database.
 *  - This file creates its own isolated workspace/user/token/documents in
 *    `beforeAll` and deletes them in `afterAll` — it does not depend on, or
 *    disturb, `pnpm db:seed`'s FG-3 fixtures (which, verified directly
 *    against this worktree's database before writing this file, are not
 *    even present right now: `scripts/factory/gate.sh`'s own api test suite
 *    TRUNCATEs 16 tables in its `beforeAll`, and this worktree's DB had
 *    already been through at least one gate run since it was last seeded).
 *  - `conditionalCsrf` (`api/src/app.ts`) skips CSRF for Bearer/API-token
 *    auth — verified by reading it, not assumed — so the POST/PATCH calls
 *    below need no CSRF token, matching how a real API-token client
 *    (including the agent's own `ShipClient`) already works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Express } from 'express';

// The one deliberate cross-package import in this bundle — see this file's
// own module docstring for why.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';

import { buildGraph, type AnthropicModel } from '../graph.js';
import { ShipClient, GateShipClient } from '../shipClient.js';
import { InMemoryItemStore } from '../itemStore.js';
import { InMemoryDraftStore } from '../draftStore.js';
import { acceptDraft, acceptProposedTransition } from '../gate.js';
import { CircuitBreaker } from '../circuitBreaker.js';
import { ResilientClient } from '../resilientClient.js';

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// The model is never invoked by the proactive_fast chain this test runs
// (pollChangeFeed -> resolveMentions -> detectBlockingApprovals ->
// commitInboxItems has no node that calls `model.invoke`) — a fake that
// throws if it ever IS called makes that assumption verifiable rather than
// silent.
const neverCalledModel: AnthropicModel = {
  invoke: async () => {
    throw new Error('proactive_fast should never call the model');
  },
};

/** `RETURNING id` always returns exactly one row for a single-row INSERT —
 * but under `noUncheckedIndexedAccess` (lessons.md #16/#21, the same
 * "explicit runtime guard, not a `!` assertion" convention `graph.ts`'s
 * `expandFrontier` already uses) `rows[0]` is still typed possibly
 * `undefined`. Fails loudly with a clear label rather than asserting past it. */
function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

async function snapshotDbState() {
  const dh = await pool.query<{ count: string; max_id: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(MAX(id), 0)::text AS max_id FROM document_history`
  );
  const docs = await pool.query<{ count: string; max_updated: string | null }>(
    `SELECT COUNT(*)::text AS count, MAX(updated_at)::text AS max_updated FROM documents`
  );
  return {
    documentHistoryCount: Number(dh.rows[0]?.count),
    documentHistoryMaxId: Number(dh.rows[0]?.max_id),
    documentsCount: Number(docs.rows[0]?.count),
    documentsMaxUpdatedAt: docs.rows[0]?.max_updated ?? null,
  };
}

describe('the human-in-the-loop write boundary, against a real running Ship API + the seeded worktree DB (TRO-321 / FG-8)', () => {
  let workspaceId: string;
  let userId: string;
  let plainToken: string;
  let issueId: string;
  let sprintId: string;
  let app: Express;
  let server: Server;
  let baseUrl: string;
  let shipClient: ShipClient;
  let gateShipClient: GateShipClient;
  let itemStore: InMemoryItemStore;
  let draftStore: InMemoryDraftStore;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `FG-8 gate test ${RUN_ID}`,
    ]);
    workspaceId = insertedId(ws.rows, 'workspace');

    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', 'FG-8 Gate Test User') RETURNING id`,
      [`fg8-gate-test-${RUN_ID}@ship.local`]
    );
    userId = insertedId(user.rows, 'test user');

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userId,
    ]);

    plainToken = `fg8-gate-test-token-${RUN_ID}`;
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4, $5)`,
      [userId, workspaceId, 'FG-8 gate test token', tokenHash, plainToken.slice(0, 8)]
    );

    const issue = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
       VALUES ($1, 'issue', 'FG-8 gate test issue', $2, 1, $3) RETURNING id`,
      [workspaceId, JSON.stringify({ state: 'todo', assignee_id: userId }), userId]
    );
    issueId = insertedId(issue.rows, 'test issue');

    // A live blocking approval — makes the proactive_fast run below do real
    // work (a real document_history READ that produces a real in-memory
    // inbox item) rather than proving "nothing happens" only because there
    // was nothing to detect in the first place.
    const sprint = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
       VALUES ($1, 'sprint', 'FG-8 gate test sprint', $2, 2, $3) RETURNING id`,
      [
        workspaceId,
        JSON.stringify({ owner_id: userId, plan_approval: { state: 'changes_requested', approved_by: null, approved_at: null } }),
        userId,
      ]
    );
    sprintId = insertedId(sprint.rows, 'test sprint');

    await pool.query(
      `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by, automated_by, created_at)
       VALUES ($1, 'plan_approval', NULL, $2, $3, NULL, NOW() - INTERVAL '30 seconds')`,
      [sprintId, JSON.stringify({ state: 'changes_requested', approved_by: null, approved_at: null }), userId]
    );

    app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // A REAL ResilientClient (PR-B / TRO-315) — not a fake — talking to a
    // real ephemeral HTTP server. maxAttempts: 1 (no retry) keeps a genuine
    // failure fast rather than retried three times against localhost.
    const resilientClient = new ResilientClient({
      breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
      timeoutMs: 5_000,
      retry: { maxAttempts: 1, baseDelayMs: 100 },
    });

    shipClient = new ShipClient({ baseUrl, token: plainToken, client: resilientClient });
    gateShipClient = new GateShipClient({ baseUrl, client: resilientClient });
    itemStore = new InMemoryItemStore();
    draftStore = new InMemoryDraftStore();
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // document_history rows for issueId/sprintId cascade-delete with their
    // parent documents (schema.sql: document_id ... ON DELETE CASCADE).
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM api_tokens WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    // Nothing else in this agent test suite imports api/src/db/client.js —
    // ending the pool here does not affect any other test file (vitest
    // isolates modules per file by default).
    await pool.end();
  }, 30_000);

  it(
    'a full proactive_fast cycle against the live seeded DB writes NO document, approval state, or issue ' +
      'transition — document_history and documents are byte-for-byte unchanged before/after (proof #1)',
    async () => {
      const before = await snapshotDbState();

      const graph = buildGraph(neverCalledModel, {
        shipClient,
        itemStore,
        initialLookbackMs: 60 * 60 * 1000, // 1 hour — comfortably covers the fixture inserted 30s ago
      });
      const result = await graph.invoke({ trigger: 'proactive_fast', input: '' });

      // Sanity: this run did REAL work against the live DB — it is not a
      // no-op that writes nothing only because it also read nothing. The
      // blocking-approval fixture from beforeAll should have produced a
      // real in-memory inbox item, evidenced by the REAL document_history
      // row inserted above.
      expect(result.inboxItems.length).toBeGreaterThan(0);
      const blockingItem = itemStore.list(userId).find((i) => i.type === 'blocking_approval');
      expect(blockingItem?.evidence.documentId).toBe(sprintId);

      const after = await snapshotDbState();
      expect(after).toEqual(before);
    }
  );

  describe("control — a real accepted write DOES move these same counters (proves the assertion above isn't vacuous)", () => {
    it('acceptProposedTransition increases document_history by exactly one row, attributed to the ACCEPTING user, never the agent', async () => {
      const draftId = `standup-draft:${userId}:2026-08-04`;
      draftStore.upsert({
        id: draftId,
        personUserId: userId,
        windowDate: '2026-08-04',
        draftText: 'I moved "FG-8 gate test issue" to In Review.',
        proposedTransitions: [
          {
            issueId,
            issueTitle: 'FG-8 gate test issue',
            field: 'state',
            fromState: 'todo',
            toState: 'in_review',
            evidence: { kind: 'history', changedAt: new Date().toISOString(), changedBy: userId },
          },
        ],
      });

      const before = await snapshotDbState();

      await acceptProposedTransition({ shipClient: gateShipClient, itemStore, draftStore }, draftId, 0, plainToken);

      const after = await snapshotDbState();
      expect(after.documentHistoryCount).toBe(before.documentHistoryCount + 1);
      expect(after.documentHistoryMaxId).toBeGreaterThan(before.documentHistoryMaxId);
      expect(after.documentsCount).toBe(before.documentsCount); // a transition never creates/deletes a document

      const newRow = await pool.query<{ changed_by: string; automated_by: string | null }>(
        `SELECT changed_by, automated_by FROM document_history
         WHERE document_id = $1 AND field = 'state' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [issueId]
      );
      // Attributed to the ACCEPTING person — never the agent (there is no
      // "agent identity" token anywhere in this test; this row's changed_by
      // is the only identity this whole flow ever authenticated as).
      expect(newRow.rows[0]?.changed_by).toBe(userId);
      expect(newRow.rows[0]?.automated_by).toBeNull();

      const issueRow = await pool.query<{ state: string }>(
        `SELECT properties->>'state' AS state FROM documents WHERE id = $1`,
        [issueId]
      );
      expect(issueRow.rows[0]?.state).toBe('in_review');
    });

    it('acceptDraft posts a real standup document, attributed to the accepting user via their own token', async () => {
      const draftId = `standup-draft:${userId}:2026-08-05`;
      draftStore.upsert({
        id: draftId,
        personUserId: userId,
        windowDate: '2026-08-05',
        draftText: 'Posted via the FG-8 gate write-boundary test.',
        proposedTransitions: [],
      });

      const before = await snapshotDbState();

      const { standupId } = await acceptDraft({ shipClient: gateShipClient, itemStore, draftStore }, draftId, plainToken);

      const after = await snapshotDbState();
      expect(after.documentsCount).toBe(before.documentsCount + 1);

      const row = await pool.query<{ created_by: string; author_id: string | null; content: unknown }>(
        `SELECT created_by, properties->>'author_id' AS author_id, content FROM documents WHERE id = $1`,
        [standupId]
      );
      expect(row.rows[0]?.created_by).toBe(userId);
      expect(row.rows[0]?.author_id).toBe(userId);
      expect(JSON.stringify(row.rows[0]?.content)).toContain('Posted via the FG-8 gate write-boundary test.');

      expect(draftStore.get(draftId)?.status).toBe('posted');
    });
  });
});
