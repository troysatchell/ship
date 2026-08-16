/**
 * PF-702 (TRO-428) — the ticket's core proof: a behavior-parity test PER
 * READ METHOD, same fixtures, `internal` mode vs `sdk` mode, against a REAL
 * running Ship API (both `/api/*` and `/api/v1/*` mounted on the SAME
 * `createApp()`) and the REAL seeded worktree database — not mocked, not
 * guessed. Same cross-package-import exception and DB-safety posture as
 * `gateWriteBoundary.dbRoundTrip.test.ts` (read that file's header first;
 * this mirrors its fixture/teardown pattern) and `sdk/src/__tests__/
 * resources.liveServer.test.ts`.
 *
 * ONE seeded `api_tokens` row authenticates BOTH surfaces: internal routes
 * accept a Bearer API token via `authMiddleware` (verified —
 * `shipClient.ts`'s own module docstring cites this), and v1 routes accept
 * the same table's rows via `bearerAuth` + `requireScope`. The row is seeded
 * with `documents:read`/`issues:read`/`sprints:read` scopes so both paths
 * succeed against the identical credential.
 *
 * `internal`-mode `ShipClient` uses a REAL `ResilientClient` (real fetch,
 * `maxAttempts: 1`, same pattern `gateWriteBoundary.dbRoundTrip.test.ts`
 * already established) — never a mock — so this is a genuine two-surface
 * comparison, not two hand-written fixtures asserted against each other.
 *
 * `getDocument()` IS asserted as fully field-identical between modes as of
 * TRO-620 — TRO-605 widened `GET /api/v1/documents/:id` to carry
 * `content`/`visibility`/`created_by`/`completed_at`, and `shipClient.ts`'s
 * `getDocumentViaSdk` now passes them through (see its module docstring,
 * "Fields that CANNOT carry over"). Before TRO-620 this file's `getDocument`
 * case asserted parity on id/document_type/title/properties only and
 * asserted the (then-real) divergence explicitly; it now asserts equality
 * on every `ShipDocument` field, and sanity-checks the internal side's real
 * values so the equalities cannot pass vacuously on null === null.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Express } from 'express';

// The one deliberate cross-package import in this file — see the module
// docstring above, and gateWriteBoundary.dbRoundTrip.test.ts's own header,
// for why.
import { createApp } from '../../../api/src/app.js';
import { pool } from '../../../api/src/db/client.js';

import { ShipClient } from '../shipClient.js';
import { ResilientClient } from '../resilientClient.js';
import { CircuitBreaker } from '../circuitBreaker.js';
import { ShipClient as SdkShipClient } from '@ship/sdk';

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
// Fixed, well-in-the-past timestamps — the change-feed's own safe-cutoff
// window (CHANGE_FEED_LAG_MS = 5s) means anything within the last few
// seconds of "now" can be legitimately withheld by either surface; seeding
// everything comfortably in the past avoids that entirely, rather than
// racing the test against a live clock.
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

function insertedId(rows: readonly { id: string }[], label: string): string {
  const row = rows[0];
  if (!row) throw new Error(`INSERT ... RETURNING id for ${label} returned no row`);
  return row.id;
}

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Several internal routes' handlers `res.json(result.rows)` the FULL raw SQL
 * row (verified by reading `api/src/routes/associations.ts`,
 * `api/src/routes/issues.ts`, `api/src/routes/documents.ts`,
 * `api/src/routes/weeks.ts` directly) — wider than the narrow interface
 * `agent/src/shipClient.ts` declares for that method's return type
 * (`AssociationForwardEdge`/`AssociationReverseEdge`/`AssigneeIssueSummary`/
 * `DocumentListItem`/`ShipWeekDates`). `getJson<T>()`'s `as T` cast is a
 * compile-time-only narrowing — it does not strip fields at runtime — so
 * `internal`-mode's ACTUAL response carries extra fields nothing in
 * `agent/src` ever reads. "Equivalent outputs" for this ticket's AC means
 * equivalent on the fields the agent's own types declare and its own code
 * consumes, not byte-identical raw wire payloads (which were never true
 * even within a single mode) — this helper projects both sides onto exactly
 * those fields before comparing, the same discipline `sdk`-mode's own
 * `ViaSdk` methods already apply when mapping a wider SDK type down to the
 * agent's narrower one.
 */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    result[key] = obj[key];
  }
  return result;
}

describe('PF-702: ShipClient parity — internal mode vs sdk mode, same fixtures, real server + real DB', () => {
  let server: Server | undefined;
  let baseUrl: string;

  let workspaceId: string;
  let userId: string;
  let assigneeUserId: string;
  let personUserId: string;
  let managerUserId: string;
  let plainToken: string;

  let weekDocId: string;
  let issueDocId: string;
  let personDocId: string;
  let anchorDocId: string;
  let reverseSourceDocId: string;

  let internalClient: ShipClient;
  let sdkClient: ShipClient;

  beforeAll(async () => {
    const workspaceResult = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, $2) RETURNING id`,
      [`PF-702 parity test ${RUN_ID}`, '2025-12-29']
    );
    workspaceId = insertedId(workspaceResult.rows, 'workspace');

    // last_workspace_id, not just workspace_memberships: v1's
    // resolvePrincipalWorkspaceId (workspaceContext.ts) resolves a
    // PERSONAL-token principal's workspace from users.last_workspace_id —
    // NOT from api_tokens.workspace_id (that file's own doc comment names
    // this as a deliberate, documented approximation/gap). Internal routes
    // use req.workspaceId from the SESSION/token row directly and never
    // consult last_workspace_id, so this only matters for the v1 side —
    // but it must be set for ANY v1 read in this file to resolve a
    // workspace at all, real code path, not a workaround.
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, last_workspace_id) VALUES ($1, 'not-a-real-hash', 'PF-702 Parity Test User', $2) RETURNING id`,
      [`pf702-parity-${RUN_ID}@ship.local`, workspaceId]
    );
    userId = insertedId(userResult.rows, 'test user');
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userId,
    ]);

    const assigneeResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', 'PF-702 Assignee') RETURNING id`,
      [`pf702-assignee-${RUN_ID}@ship.local`]
    );
    assigneeUserId = insertedId(assigneeResult.rows, 'assignee user');

    const personUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', 'PF-702 Person') RETURNING id`,
      [`pf702-person-${RUN_ID}@ship.local`]
    );
    personUserId = insertedId(personUserResult.rows, 'person user');

    const managerResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', 'PF-702 Manager') RETURNING id`,
      [`pf702-manager-${RUN_ID}@ship.local`]
    );
    managerUserId = insertedId(managerResult.rows, 'manager user');

    plainToken = `pf702-parity-token-${RUN_ID}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        workspaceId,
        'PF-702 parity test token',
        sha256Hex(plainToken),
        plainToken.slice(0, 8),
        ['documents:read', 'issues:read', 'sprints:read'],
      ]
    );

    // The "week" (a sprint document type internally).
    const weekResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_at, updated_at)
       VALUES ($1, 'sprint', $2, $3, $4, $4) RETURNING id`,
      [workspaceId, `PF-702 parity week ${RUN_ID}`, JSON.stringify({ sprint_number: 1, status: 'active' }), new Date(BASE_MS)]
    );
    weekDocId = insertedId(weekResult.rows, 'week document');

    // The issue getIssuesByAssignee reads.
    const issueResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_at, updated_at)
       VALUES ($1, 'issue', $2, $3, 501, $4, $4) RETURNING id`,
      [
        workspaceId,
        `PF-702 parity issue ${RUN_ID}`,
        JSON.stringify({ state: 'in_progress', priority: 'high', assignee_id: assigneeUserId }),
        new Date(BASE_MS + 1000),
      ]
    );
    issueDocId = insertedId(issueResult.rows, 'issue document');

    // The person getPeople reads.
    const personResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_at, updated_at)
       VALUES ($1, 'person', $2, $3, $4, $4) RETURNING id`,
      [
        workspaceId,
        `PF-702 Parity Person ${RUN_ID}`,
        JSON.stringify({ user_id: personUserId, email: `pf702-person-${RUN_ID}@ship.local`, reports_to: managerUserId, role: 'engineer' }),
        new Date(BASE_MS + 2000),
      ]
    );
    personDocId = insertedId(personResult.rows, 'person document');

    // The anchor document — getDocument/getAssociations/getReverseAssociations/
    // getBacklinks/getComments all read this one.
    const anchorResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by, visibility, created_at, updated_at)
       VALUES ($1, 'wiki', $2, $3, $4, 'workspace', $5, $5) RETURNING id`,
      [workspaceId, `PF-702 parity anchor ${RUN_ID}`, JSON.stringify({ note: 'anchor doc' }), userId, new Date(BASE_MS + 3000)]
    );
    anchorDocId = insertedId(anchorResult.rows, 'anchor document');

    // Forward association: anchor -> issue, relationship_type 'blocks'.
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type, created_at)
       VALUES ($1, $2, 'blocks', $3)`,
      [anchorDocId, issueDocId, new Date(BASE_MS + 4000)]
    );

    // Reverse association: reverseSourceDoc -> anchor, relationship_type 'sprint'.
    const reverseSourceResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_at, updated_at)
       VALUES ($1, 'wiki', $2, '{}', $3, $3) RETURNING id`,
      [workspaceId, `PF-702 parity reverse-source ${RUN_ID}`, new Date(BASE_MS + 5000)]
    );
    reverseSourceDocId = insertedId(reverseSourceResult.rows, 'reverse-source document');
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type, created_at)
       VALUES ($1, $2, 'sprint', $3)`,
      [reverseSourceDocId, anchorDocId, new Date(BASE_MS + 6000)]
    );

    // Backlink: a document that links TO the anchor (document_links.target_id
    // = anchor, source_id = the linking doc).
    const linkingDocResult = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_at, updated_at)
       VALUES ($1, 'issue', $2, '{}', 502, $3, $3) RETURNING id`,
      [workspaceId, `PF-702 parity linking issue ${RUN_ID}`, new Date(BASE_MS + 7000)]
    );
    const linkingDocId = insertedId(linkingDocResult.rows, 'linking document');
    await pool.query(`INSERT INTO document_links (source_id, target_id, created_at) VALUES ($1, $2, $3)`, [
      linkingDocId,
      anchorDocId,
      new Date(BASE_MS + 8000),
    ]);

    // Two comments on the anchor.
    await pool.query(
      `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content, created_at, updated_at)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $5)`,
      [anchorDocId, userId, workspaceId, 'PF-702 parity comment one', new Date(BASE_MS + 9000)]
    );
    await pool.query(
      `INSERT INTO comments (document_id, comment_id, author_id, workspace_id, content, created_at, updated_at)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $5)`,
      [anchorDocId, userId, workspaceId, 'PF-702 parity comment two', new Date(BASE_MS + 9500)]
    );

    // A document_history row on the anchor, for the change-feed.
    await pool.query(
      `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by, created_at)
       VALUES ($1, 'title', 'old title', 'new title', $2, $3)`,
      [anchorDocId, userId, new Date(BASE_MS + 10000)]
    );

    const app: Express = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      const s = server;
      if (!s) return reject(new Error('server was not assigned'));
      s.once('listening', () => resolve());
      s.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // internal mode: a REAL ResilientClient (real fetch), same pattern
    // gateWriteBoundary.dbRoundTrip.test.ts already established.
    const resilientClient = new ResilientClient({
      breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
      timeoutMs: 5_000,
      retry: { maxAttempts: 1, baseDelayMs: 100 },
    });
    internalClient = new ShipClient({ baseUrl, token: plainToken, client: resilientClient });

    // sdk mode: a REAL @ship/sdk ShipClient talking to the same server, same
    // credential.
    const sdk = new SdkShipClient({ token: plainToken, baseUrl });
    sdkClient = new ShipClient({ baseUrl, token: plainToken, client: resilientClient, sdk });
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
          await pool.query('DELETE FROM comments WHERE workspace_id = $1', [workspaceId]);
          await pool.query('DELETE FROM document_history WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [
            workspaceId,
          ]);
          await pool.query('DELETE FROM document_links WHERE source_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [
            workspaceId,
          ]);
          await pool.query(
            'DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)',
            [workspaceId]
          );
          await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
          await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
        }
        for (const uid of [userId, assigneeUserId, personUserId, managerUserId]) {
          if (uid) await pool.query('DELETE FROM users WHERE id = $1', [uid]);
        }
        if (workspaceId) {
          await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);

  // ─── 1. getDocument ──────────────────────────────────────────────────
  //
  // TRO-620: since TRO-605 widened `GET /api/v1/documents/:id` to carry
  // `content`/`visibility`/`created_by`/`completed_at`, sdk mode passes them
  // through and this case asserts FULL parity on every `ShipDocument` field
  // (before TRO-620 the sdk side returned `content: null`, a synthesized
  // `visibility`, `created_by: null`, `completed_at: undefined` — the
  // divergence this same case used to assert as "documented").
  it('getDocument(): full parity on id/document_type/title/properties/content/visibility/created_by/completed_at', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getDocument(anchorDocId),
      sdkClient.getDocument(anchorDocId),
    ]);

    expect(viaSdk.id).toBe(viaInternal.id);
    expect(viaSdk.document_type).toBe(viaInternal.document_type);
    expect(viaSdk.title).toBe(viaInternal.title);
    expect(viaSdk.properties).toEqual(viaInternal.properties);

    // The internal surface carries real values (sanity-check the fixture so
    // the equality assertions below cannot pass vacuously on null === null).
    expect(viaInternal.content).not.toBeNull();
    expect(viaInternal.visibility).toBe('workspace');
    expect(viaInternal.created_by).toBe(userId);
    expect(viaInternal.completed_at).toBeNull();

    // TRO-620: the sdk surface now carries the SAME values (TRO-605 widened
    // the v1 serializer) — no more synthesized/absent fields.
    expect(viaSdk.content).toEqual(viaInternal.content);
    expect(viaSdk.visibility).toBe(viaInternal.visibility);
    expect(viaSdk.created_by).toBe(viaInternal.created_by);
    expect(viaSdk.completed_at).toBe(viaInternal.completed_at);
  });

  // ─── 2. getPeople ────────────────────────────────────────────────────
  it('getPeople(): identical people arrays (field-renamed camelCase, same values)', async () => {
    const [viaInternal, viaSdk] = await Promise.all([internalClient.getPeople(), sdkClient.getPeople()]);

    const internalPerson = viaInternal.find((p) => p.id === personDocId);
    const sdkPerson = viaSdk.find((p) => p.id === personDocId);
    expect(internalPerson).toBeDefined();
    expect(sdkPerson).toBeDefined();
    expect(sdkPerson).toEqual(internalPerson);
    expect(sdkPerson).toMatchObject({
      id: personDocId,
      user_id: personUserId,
      name: `PF-702 Parity Person ${RUN_ID}`,
      reportsTo: managerUserId,
      role: 'engineer',
      isArchived: false,
      isPending: false,
    });
  });

  // ─── 3. getAssociations ──────────────────────────────────────────────
  it('getAssociations(): identical forward edges, with and without a type filter', async () => {
    const [viaInternalAll, viaSdkAll] = await Promise.all([
      internalClient.getAssociations(anchorDocId),
      sdkClient.getAssociations(anchorDocId),
    ]);
    const pickFwd = (rows: typeof viaInternalAll) => rows.map((r) => pick(r, ['related_id', 'relationship_type']));
    expect(pickFwd(viaSdkAll)).toEqual(pickFwd(viaInternalAll));
    expect(pickFwd(viaSdkAll)).toEqual([{ related_id: issueDocId, relationship_type: 'blocks' }]);

    const [viaInternalTyped, viaSdkTyped] = await Promise.all([
      internalClient.getAssociations(anchorDocId, 'blocks'),
      sdkClient.getAssociations(anchorDocId, 'blocks'),
    ]);
    expect(pickFwd(viaSdkTyped)).toEqual(pickFwd(viaInternalTyped));

    const [viaInternalNoMatch, viaSdkNoMatch] = await Promise.all([
      internalClient.getAssociations(anchorDocId, 'project'),
      sdkClient.getAssociations(anchorDocId, 'project'),
    ]);
    expect(viaSdkNoMatch).toEqual(viaInternalNoMatch);
    expect(viaSdkNoMatch).toEqual([]);
  });

  // ─── 4. getReverseAssociations ───────────────────────────────────────
  it('getReverseAssociations(): identical reverse edges, with and without a type filter', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getReverseAssociations(anchorDocId, 'sprint'),
      sdkClient.getReverseAssociations(anchorDocId, 'sprint'),
    ]);
    const pickRev = (rows: typeof viaInternal) => rows.map((r) => pick(r, ['document_id', 'relationship_type']));
    expect(pickRev(viaSdk)).toEqual(pickRev(viaInternal));
    expect(pickRev(viaSdk)).toEqual([{ document_id: reverseSourceDocId, relationship_type: 'sprint' }]);
  });

  // ─── 5. getBacklinks ─────────────────────────────────────────────────
  it('getBacklinks(): identical backlink entries, including display_id for the linking issue', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getBacklinks(anchorDocId),
      sdkClient.getBacklinks(anchorDocId),
    ]);
    const pickBacklink = (rows: typeof viaInternal) => rows.map((r) => pick(r, ['id', 'document_type', 'title', 'display_id']));
    expect(pickBacklink(viaSdk)).toEqual(pickBacklink(viaInternal));
    expect(viaSdk).toHaveLength(1);
    expect(viaSdk[0]).toMatchObject({ document_type: 'issue', display_id: '#502' });
  });

  // ─── 6. getComments ──────────────────────────────────────────────────
  it('getComments(): identical comment entries (id/content/author/timestamps), order-independent', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getComments(anchorDocId),
      sdkClient.getComments(anchorDocId),
    ]);
    const fields = ['id', 'content', 'author', 'created_at', 'resolved_at'] as const;
    const byId = (rows: typeof viaInternal) =>
      rows
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => pick(r, fields));
    expect(byId(viaSdk)).toEqual(byId(viaInternal));
    expect(viaSdk).toHaveLength(2);
    expect(viaSdk.map((c) => c.content).sort()).toEqual(['PF-702 parity comment one', 'PF-702 parity comment two']);
  });

  // ─── 7. getIssuesByAssignee ──────────────────────────────────────────
  it('getIssuesByAssignee(): identical issue summaries for the seeded assignee', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getIssuesByAssignee(assigneeUserId),
      sdkClient.getIssuesByAssignee(assigneeUserId),
    ]);
    const pickIssue = (rows: typeof viaInternal) => rows.map((r) => pick(r, ['id', 'title', 'state', 'updated_at']));
    // Cross-mode equality (above real proof for updated_at parity, since a
    // hardcoded expected value here would be self-referential — CodeRabbit
    // finding, TRO-428) plus a fixed-field check against the seeded fixture
    // for everything EXCEPT updated_at.
    expect(pickIssue(viaSdk)).toEqual(pickIssue(viaInternal));
    expect(pickIssue(viaSdk).map(({ id, title, state }) => ({ id, title, state }))).toEqual([
      { id: issueDocId, title: `PF-702 parity issue ${RUN_ID}`, state: 'in_progress' },
    ]);
  });

  // ─── 8. listDocuments ────────────────────────────────────────────────
  it('listDocuments(): identical document-list items for type "person"', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.listDocuments('person'),
      sdkClient.listDocuments('person'),
    ]);
    const internalMatch = viaInternal.find((d) => d.id === personDocId);
    const sdkMatch = viaSdk.find((d) => d.id === personDocId);
    expect(internalMatch).toBeDefined();
    expect(sdkMatch).toBeDefined();
    const fields = ['id', 'document_type', 'properties', 'created_at', 'updated_at'] as const;
    expect(sdkMatch && pick(sdkMatch, fields)).toEqual(internalMatch && pick(internalMatch, fields));
    expect(sdkMatch).toMatchObject({ id: personDocId, document_type: 'person' });
  });

  // ─── 9. getWeekDates ─────────────────────────────────────────────────
  it('getWeekDates(): identical calendar date (internal returns a full ISO datetime, v1 a bare YYYY-MM-DD — see module docstring in shipClient.ts; the only real consumer, retroDraft.ts\'s computeWeekWindow, already slices to the first 10 chars, so this is a disclosed, functionally-inert format difference)', async () => {
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getWeekDates(weekDocId),
      sdkClient.getWeekDates(weekDocId),
    ]);
    const datePart = (s: string) => s.slice(0, 10);
    expect(datePart(viaSdk.workspace_sprint_start_date)).toBe(datePart(viaInternal.workspace_sprint_start_date));
    expect(datePart(viaSdk.workspace_sprint_start_date)).toBe('2025-12-29');
  });

  // ─── 10. getChangeFeed ───────────────────────────────────────────────
  it('getChangeFeed(): identical documents/history/comments entries for the seeded fixtures (both re-tag the same three arrays from different wire shapes)', async () => {
    const since = new Date(BASE_MS - 1000).toISOString();
    const [viaInternal, viaSdk] = await Promise.all([
      internalClient.getChangeFeed(since, 500),
      sdkClient.getChangeFeed(since, 500),
    ]);

    const filterOwn = (feed: typeof viaInternal) => ({
      documents: feed.documents.filter((d) => d.id === anchorDocId),
      history: feed.history.filter((h) => h.document_id === anchorDocId),
      comments: feed.comments.filter((c) => c.document_id === anchorDocId),
    });

    expect(filterOwn(viaSdk)).toEqual(filterOwn(viaInternal));
    const own = filterOwn(viaSdk);
    expect(own.documents).toHaveLength(1);
    expect(own.history).toHaveLength(1);
    expect(own.comments).toHaveLength(2);
  });
});
