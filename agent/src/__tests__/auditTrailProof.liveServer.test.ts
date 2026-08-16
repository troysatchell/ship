/**
 * TRO-440 (PF-704) — the Epic 7 submission proof: a real agent turn in
 * `sdk` mode, against a real running Ship API + the real seeded worktree
 * DB, proving every action it took went through `/api/v1` — reads under
 * `ship_app_fleetgraph`'s own Client Credentials identity, the one accepted
 * write under the acting human's identity — and that the rate-limit
 * headers PF-500 requires on every `/api/v1` response were actually present
 * on the credentials this turn used.
 *
 * WHAT THIS FILE ADDS ON TOP OF EXISTING COVERAGE (not a duplicate):
 *  - `gateWriteBoundary.dbRoundTrip.test.ts` (PF-703) already proves a write
 *    attributes to the human in both internal and sdk mode, and
 *    `shipClientParity.liveServer.test.ts` (PF-702) already proves read
 *    PARITY between the two modes per method — but neither uses a real
 *    seeded `ship_app_fleetgraph` app or a real Client Credentials grant.
 *    Both mint an ad-hoc personal `api_tokens` row for every read, which is
 *    a legitimate parity check but never actually exercises "the agent
 *    authenticates AS ITSELF" — the specific claim this ticket's AC is
 *    about. This file is the first to seed the real app (via
 *    `seedFirstPartyApp`, PF-701's own function) and mint a real
 *    `POST /oauth/token` (grant_type=client_credentials) token against it,
 *    exactly as `index.ts`'s real boot path does (PF-702, `index.ts:216-221`).
 *  - Rate-limit headers: `@ship/sdk`'s `RequestClient` does not expose
 *    response headers to callers (verified by reading
 *    `sdk/src/internal/requestClient.ts` — its methods return only the
 *    parsed JSON body), so the app-identity read the agent's own SDK client
 *    performs cannot observe them directly. This file makes one additional,
 *    independent raw `fetch()` call with the SAME app-identity bearer token
 *    immediately after, to observe headers on that credential's traffic —
 *    the header behavior itself is a property of the server's
 *    `rateLimitBuckets` middleware (already exhaustively proven for every
 *    `/api/v1` route by `route-fitness.test.ts`'s check (e), agnostic to
 *    which caller holds the token), so this is a confirmatory observation
 *    of THIS credential specifically, not a re-proof of the general rule.
 *
 * "ONE ACCEPTED DRAFT WRITE": calls `GateShipClient.postStandup()` +
 * `.setStandupContent()` directly (the same pair `gate.ts`'s `acceptDraft`
 * calls internally) rather than driving the full draft-lifecycle wrapper —
 * `acceptDraft` itself, and its full accept/reject orchestration, is
 * already covered by `gateWriteBoundary.dbRoundTrip.test.ts`. What this
 * file needs is the write itself landing under the human's identity via the
 * real sdk-mode wire path, which calling the same two methods directly
 * proves identically.
 *
 * PROOF ARTIFACT (this ticket's own AC — "the audit rows themselves,
 * attach query + output to ticket/PR"): the final `it()` below logs the
 * exact SQL query and its result rows to stdout specifically so a captured
 * CI log or a local run's output can be pasted into the PR/ticket verbatim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Express } from 'express';

// Same deliberate cross-package exception gateWriteBoundary.dbRoundTrip.test.ts
// and shipClientParity.liveServer.test.ts already establish — see either
// file's own header for the full safety verification.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';
import { seedFirstPartyApp, FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR } from '../../../api/src/platform/oauth/seedFirstPartyApp.js';

import { GateShipClient } from '../shipClient.js';
import { FLEETGRAPH_CLIENT_ID, FLEETGRAPH_APP_SCOPES } from '../config.js';
import { ResilientClient } from '../resilientClient.js';
import { CircuitBreaker } from '../circuitBreaker.js';
import { ShipClient as SdkShipClient } from '@ship/sdk';

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Same shape `gateWriteBoundary.dbRoundTrip.test.ts`'s own `AuditRow`
 *  declares — matches `platform/audit/__tests__/middleware.test.ts`'s
 *  `AuditDbRow`, narrowed to what this file asserts on. */
interface AuditRow {
  id: string;
  user_id: string | null;
  app_client_id: string | null;
  route: string;
  method: string;
  scope_used: string | null;
  status: number;
  created_at: string;
}

/** Mirrors `gateWriteBoundary.dbRoundTrip.test.ts`'s own `pollForAuditRow` —
 *  the audit write is fire-and-forget (started inside `res.on('finish')`
 *  after the response the caller already resolved on), so it can land a few
 *  event-loop turns later than the `await` that triggered it. Polls an
 *  observable DB condition rather than a fixed sleep (lessons.md rule 17). */
async function pollForAuditRows(
  route: string,
  method: string,
  matchColumn: 'app_client_id' | 'user_id',
  matchValue: string,
  minCount: number
): Promise<AuditRow[]> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await pool.query<AuditRow>(
      `SELECT id, user_id, app_client_id, route, method, scope_used, status, created_at
       FROM public_api_audit
       WHERE route = $1 AND method = $2 AND ${matchColumn} = $3
       ORDER BY created_at ASC`,
      [route, method, matchValue]
    );
    if (result.rows.length >= minCount) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = await pool.query<AuditRow>(
    `SELECT id, user_id, app_client_id, route, method, scope_used, status, created_at
     FROM public_api_audit
     WHERE route = $1 AND method = $2 AND ${matchColumn} = $3
     ORDER BY created_at ASC`,
    [route, method, matchValue]
  );
  return result.rows;
}

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

describe(
  'TRO-440 (PF-704): a real sdk-mode agent turn (app-identity reads + one human-identity write) leaves an ' +
    'audit trail proving every action went through /api/v1, against a real running Ship API + the seeded worktree DB',
  () => {
    let workspaceId: string;
    let userId: string;
    let scopedWriteToken: string;
    let app: Express;
    let server: Server;
    let baseUrl: string;
    let appIdentityClient: SdkShipClient;
    let appIdentityAccessToken: string;
    let gateShipClient: GateShipClient;
    const standupDate = new Date().toISOString().slice(0, 10);

    beforeAll(async () => {
      const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        `TRO-440 audit-trail proof ${RUN_ID}`,
      ]);
      workspaceId = insertedId(ws.rows, 'workspace');

      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, last_workspace_id) VALUES ($1, 'not-a-real-hash', 'TRO-440 Test Human', $2) RETURNING id`,
        [`tro440-test-${RUN_ID}@ship.local`, workspaceId]
      );
      userId = insertedId(user.rows, 'test user');

      await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
        workspaceId,
        userId,
      ]);

      // Real scope shape PF-703's own accept-draft mint uses
      // (api/src/routes/agent.ts's mintEphemeralAgentToken) — a short-lived
      // scoped personal token, never the app's own Client Credentials
      // token, matching the PRD's decided semantics ("the human's write
      // token ... attribute to the human user").
      scopedWriteToken = `tro440-write-token-${RUN_ID}`;
      const scopedTokenHash = crypto.createHash('sha256').update(scopedWriteToken).digest('hex');
      await pool.query(
        `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          workspaceId,
          'TRO-440 accept-draft write token',
          scopedTokenHash,
          scopedWriteToken.slice(0, 8),
          ['documents:write', 'issues:write'],
        ]
      );

      // A real document for the app-identity read to actually find — a
      // zero-result read would prove the audit ROW exists but not that it
      // reflects genuine work.
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
         VALUES ($1, 'issue', 'TRO-440 fixture issue', $2, 1, $3)`,
        [workspaceId, JSON.stringify({ state: 'todo', assignee_id: userId }), userId]
      );

      app = createApp();
      server = app.listen(0);
      await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve());
        server.once('error', reject);
      });
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;

      // The real seed function PF-701 ships, PF-702's boot path calls this
      // exact function (index.ts:102) — not a hand-rolled fixture.
      process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR] = `tro440-fleetgraph-secret-${RUN_ID}`;
      await seedFirstPartyApp(pool, workspaceId);

      // The real Client Credentials grant (PF-104's issueClientCredentialsToken,
      // reached via /oauth/token) — exactly what index.ts:216-221 does at
      // real boot, not a stand-in personal token.
      appIdentityClient = await SdkShipClient.clientCredentials({
        baseUrl,
        clientId: FLEETGRAPH_CLIENT_ID,
        clientSecret: process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR]!,
        scope: FLEETGRAPH_APP_SCOPES.join(' '),
      });
      // The access token itself, for the one raw fetch() header-observation
      // probe below — @ship/sdk's ShipClient never exposes it (by design),
      // so a fresh, independent grant against the same app+secret mints an
      // equivalent one for that single, separate observation.
      const rawTokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: FLEETGRAPH_CLIENT_ID,
          client_secret: process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR]!,
          scope: FLEETGRAPH_APP_SCOPES.join(' '),
        }).toString(),
      });
      const rawTokenBody = (await rawTokenResponse.json()) as { access_token: string };
      appIdentityAccessToken = rawTokenBody.access_token;

      const resilientClient = new ResilientClient({
        breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, baseDelayMs: 100 },
      });
      gateShipClient = new GateShipClient({
        baseUrl,
        client: resilientClient,
        sdkClientFactory: (token: string) => new SdkShipClient({ token, baseUrl }),
      });
    }, 30_000);

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM api_tokens WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM oauth_apps WHERE client_id = $1`, [FLEETGRAPH_CLIENT_ID]);
      await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
      delete process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR];
      await pool.end();
    }, 30_000);

    it(
      'read-heavy turn: app-identity Client Credentials reads (documents/issues/sprints) each land an audit ' +
        'row attributed to ship_app_fleetgraph, never to any user',
      async () => {
        // The "read-heavy chat" half of the agent turn this ticket's AC
        // names — three real reads via the app's own identity, mirroring
        // the exact client sharedSdkClient in index.ts:216-221 is.
        await appIdentityClient.documents.list();
        await appIdentityClient.issues.list();
        await appIdentityClient.sprints.list();

        const docsAudit = await pollForAuditRows('/api/v1/documents', 'GET', 'app_client_id', FLEETGRAPH_CLIENT_ID, 1);
        const issuesAudit = await pollForAuditRows('/api/v1/issues', 'GET', 'app_client_id', FLEETGRAPH_CLIENT_ID, 1);
        const sprintsAudit = await pollForAuditRows('/api/v1/sprints', 'GET', 'app_client_id', FLEETGRAPH_CLIENT_ID, 1);

        for (const rows of [docsAudit, issuesAudit, sprintsAudit]) {
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.app_client_id).toBe(FLEETGRAPH_CLIENT_ID);
            // The whole point: an app-identity call has NO acting user.
            expect(row.user_id).toBeNull();
            expect(row.status).toBe(200);
          }
        }
      },
      15_000
    );

    it(
      'one accepted draft write: the human write token lands an audit row attributed to the human user, ' +
        'never to ship_app_fleetgraph',
      async () => {
        // Same two calls gate.ts's acceptDraft makes internally
        // (postStandup then setStandupContent) — see this file's own
        // header for why calling them directly here is equivalent proof.
        const created = await gateShipClient.postStandup(scopedWriteToken, standupDate);
        await gateShipClient.setStandupContent(scopedWriteToken, created.id, 'TRO-440 audit-trail proof standup');

        const createAudit = await pollForAuditRows('/api/v1/documents', 'POST', 'user_id', userId, 1);
        expect(createAudit.length).toBeGreaterThan(0);
        const writeRow = createAudit[createAudit.length - 1];
        expect(writeRow).toBeDefined();
        expect(writeRow!.user_id).toBe(userId);
        // The negative half of the claim: attributed to the human, NOT the app.
        expect(writeRow!.app_client_id).toBeNull();
        expect(writeRow!.status).toBeGreaterThanOrEqual(200);
        expect(writeRow!.status).toBeLessThan(300);
      },
      15_000
    );

    it('rate-limit headers were present on the app-identity credential this turn used', async () => {
      // See this file's own header for why a raw fetch(), not the SDK, is
      // what can observe response headers at all.
      const res = await fetch(`${baseUrl}/api/v1/documents`, {
        headers: { Authorization: `Bearer ${appIdentityAccessToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).not.toBeNull();
      expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull();
      expect(res.headers.get('x-ratelimit-reset')).not.toBeNull();
    });

    it('PROOF ARTIFACT: the audit rows themselves, printed for the ticket/PR (this ticket\'s own AC)', async () => {
      const proof = await pool.query<AuditRow>(
        `SELECT id, user_id, app_client_id, route, method, scope_used, status, created_at
         FROM public_api_audit
         WHERE (app_client_id = $1 OR user_id = $2)
           AND created_at > NOW() - INTERVAL '1 minute'
         ORDER BY created_at ASC`,
        [FLEETGRAPH_CLIENT_ID, userId]
      );
      // eslint-disable-next-line no-console
      console.log(
        '[TRO-440/PF-704] Epic 7 submission proof — public_api_audit rows for this agent turn:\n' +
          "SELECT id, user_id, app_client_id, route, method, scope_used, status, created_at FROM public_api_audit " +
          `WHERE (app_client_id = '${FLEETGRAPH_CLIENT_ID}' OR user_id = '${userId}') ORDER BY created_at ASC;\n` +
          JSON.stringify(proof.rows, null, 2)
      );
      // Read-heavy (>=3, one per resource) + exactly the write's own rows,
      // all real, all in the last minute of this test run.
      expect(proof.rows.length).toBeGreaterThanOrEqual(4);
      const appRows = proof.rows.filter((r) => r.app_client_id === FLEETGRAPH_CLIENT_ID);
      const userRows = proof.rows.filter((r) => r.user_id === userId);
      expect(appRows.length).toBeGreaterThanOrEqual(3);
      expect(userRows.length).toBeGreaterThanOrEqual(1);
      // No row is ever attributed to both — app-identity and human-identity
      // calls are mutually exclusive by construction (bearerAuth.ts sets
      // exactly one principal shape per request).
      for (const row of proof.rows) {
        expect(row.app_client_id === null || row.user_id === null).toBe(true);
      }
    });
  }
);
