/**
 * Ship API client for FleetGraph's proactive path (TRO-317 / FG-5).
 *
 * Every outbound call goes through the same `ResilientClient` FG-4
 * (TRO-315) built — see `resilientClient.ts`'s own docstring for why
 * (timeout + retry/backoff + circuit breaker + self-throttle, baked in
 * once, reused everywhere). This module never calls `fetch` directly; it
 * only adds base-URL joining, the `Authorization: Bearer` header Ship's
 * `authMiddleware` expects for API tokens (verified —
 * `api/src/middleware/auth.ts`: "Check for Bearer token first (API token
 * auth)"), and typed shapes for the three endpoints the proactive path
 * reads.
 *
 * Three endpoints, chosen after reading their actual server-side handlers
 * (not guessed from naming):
 *  - `GET /api/change-feed` (FG-1 / TRO-312) — the poll source.
 *  - `GET /api/documents/:id` (`api/src/routes/documents.ts`) — returns the
 *    RAW `documents` row (`SELECT d.*`), so `content`/`visibility`/
 *    `created_by`/`properties` all come back unmodified. Deliberately NOT
 *    `GET /api/weeks/:id`: that route's own top-level `owner_id` alias is
 *    computed from `assignee_ids[0]` (`LEFT JOIN users u ON
 *    (d.properties->'assignee_ids'->>0)::uuid = u.id`), which is a
 *    DIFFERENT value than `properties.owner_id` — the field
 *    `accountability.ts`, `seed.ts`, and `weeks.ts`'s own
 *    `getSprintOwnerReportsTo` all actually treat as the sprint owner.
 *    Reading raw `properties.owner_id` off `GET /api/documents/:id` avoids
 *    that trap entirely.
 *  - `GET /api/team/people` (`api/src/routes/team.ts`) — the people
 *    directory: person-document id, linked `user_id`, name, and
 *    `reportsTo` (verified as the manager's USER id, not a person-document
 *    id — `api/src/routes/reports-to.test.ts` sets it to `adminUserId`/
 *    `supervisorId` directly). One call covers mention resolution (person
 *    doc id -> user id) and approval-blocking's manager lookup.
 */

import type { ResilientClient } from './resilientClient.js';

export interface ChangeFeedDocument {
  id: string;
  document_type: string;
  title: string;
  updated_at: string;
  created_by: string | null;
  dedupe_key: string;
}

export interface ChangeFeedHistoryEntry {
  id: number;
  document_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  automated_by: string | null;
  created_at: string;
  dedupe_key: string;
}

export interface ChangeFeedComment {
  id: string;
  document_id: string;
  comment_id: string;
  parent_id: string | null;
  author_id: string | null;
  content: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  dedupe_key: string;
}

export interface ChangeFeedResponse {
  next_cursor: string;
  documents: ChangeFeedDocument[];
  documents_truncated: boolean;
  history: ChangeFeedHistoryEntry[];
  history_truncated: boolean;
  comments: ChangeFeedComment[];
  comments_truncated: boolean;
}

/** `ApprovalTracking` (shared/src/types/document.ts) as it round-trips
 * through `document_history.new_value` (a `TEXT` column holding
 * `JSON.stringify(newApproval)` — see `api/src/routes/weeks.ts`). */
export interface ApprovalTrackingLike {
  state: 'approved' | 'changes_requested' | 'changed_since_approved' | null;
  approved_by: string | null;
  approved_at: string | null;
  [key: string]: unknown;
}

export interface ShipDocument {
  id: string;
  document_type: string;
  title: string;
  content: unknown;
  visibility: string;
  created_by: string | null;
  properties: {
    owner_id?: string | null;
    plan_approval?: ApprovalTrackingLike | null;
    review_approval?: ApprovalTrackingLike | null;
    [key: string]: unknown;
  };
  /** Raw `documents.completed_at` column (`schema.sql:140`, "When issue
   * status first changed to done") — a real top-level column, not a
   * `properties` key. `GET /api/documents/:id` (`documents.ts`) returns it
   * unmodified via its own `{ ...doc, ... }` spread (verified by reading
   * that handler directly, TRO-335 / FG-17), so it round-trips here as an
   * ISO 8601 string or `null`. Optional/undefined for any document that
   * predates this field being read (every existing `ShipDocument` producer
   * in this file's test fixtures) — never fabricated when absent. */
  completed_at?: string | null;
}

export interface ShipPerson {
  /** Person DOCUMENT id — what a TipTap mention node's `attrs.id` and a
   * `/api/search/mentions` person result both carry. */
  id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  isArchived: boolean;
  isPending: boolean;
  /** The manager's USER id, or null if none is recorded — see module docstring. */
  reportsTo: string | null;
  role: string | null;
}

/** Thrown when Ship responds with a non-OK status that isn't already a
 * retry/breaker failure (i.e. anything `ResilientClient.checkedFetch`
 * doesn't itself throw for — see resilientClient.ts: only >=500 and 429 are
 * thrown there, so 404/403/etc. resolve normally and are surfaced here). */
export class ShipApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly status: number
  ) {
    super(`Ship API ${method} ${url} returned ${status}`);
    this.name = 'ShipApiError';
  }
}

/**
 * The narrow, testable surface of `ShipClient` — same pattern as
 * `health.ts`'s `ShipReadClient`. `ShipClient` itself has private fields, so
 * a plain-object test fake can never structurally satisfy the CLASS type;
 * every consumer (`proactive.ts`, `graph.ts`'s `ProactiveDeps`) depends on
 * this `Pick`-derived interface instead, so tests inject a stable fake
 * without constructing a real `ResilientClient`.
 */
export type ShipClientLike = Pick<ShipClient, 'getChangeFeed' | 'getDocument' | 'getPeople'>;

/**
 * An association edge as returned by `GET /api/documents/:id/associations`
 * (forward — `document_id` is the id you asked about, `related_id` is what
 * it points at). Deliberately does NOT declare `related_title`/
 * `related_document_type`, even though the route returns them: that route
 * checks access on the ANCHOR document only (`associations.ts`'s
 * `canAccessDocument(id, ...)`), never on each joined `related_id` — so a
 * private document's title can leak through this response. `expansion.ts`
 * never reads those fields for exactly that reason; every candidate is
 * re-fetched through `getDocument` (which DOES check per-document access)
 * before anything about it is trusted. `relationship_type` is kept as a
 * bare `string`, not narrowed to a literal union — this enum has already
 * grown once this sprint ('blocks', FG-15/TRO-333) and an agent-side literal
 * type would need editing every time it grows again.
 */
export interface AssociationForwardEdge {
  related_id: string;
  relationship_type: string;
}

/** Same shape, from `GET /api/documents/:id/reverse-associations` — rows
 * where `related_id` is the id you asked about and `document_id` is what
 * points AT it. Same title-leak caveat as `AssociationForwardEdge`. */
export interface AssociationReverseEdge {
  document_id: string;
  relationship_type: string;
}

/** `GET /api/documents/:id/backlinks` (`document_links`, FG-7/TRO-318) —
 * already visibility-filtered server-side (`backlinks.ts` joins
 * `VISIBILITY_FILTER_SQL` on the source document), unlike the associations
 * endpoints above. */
export interface BacklinkEntry {
  id: string;
  document_type: string;
  title: string;
  display_id?: string;
}

/** `GET /api/documents/:id/comments`. Only the fields the expansion walk
 * actually reads from a comment (content + who + when) — see
 * `comments.ts`'s route for the full response shape. */
export interface CommentEntry {
  id: string;
  content: string;
  author: { id: string; name: string; email: string | null };
  created_at: string;
  resolved_at: string | null;
}

/** One row of `GET /api/issues?assignee_id=...` — "the people and their
 * other work" (TRO-318's Scope section). Narrower than the route's full
 * `IssueListItem` response; only what `expansion.ts` reads. */
export interface AssigneeIssueSummary {
  id: string;
  title: string;
  state: string;
  updated_at: string;
}

/** One row of `GET /api/documents?type=...` (`documents.ts`'s list route) —
 * TRO-319 / FG-6's anchor lookup ("the most recent standup document by this
 * author"). Deliberately narrow: that route's SELECT never returns `content`
 * (see `documents.ts`'s own query — only `id, workspace_id, document_type,
 * title, parent_id, position, ticket_number, properties, created_at,
 * updated_at, created_by, visibility`), and this file only reads
 * `properties`/`created_at` off it (author id + recency), so nothing wider
 * is declared. */
export interface DocumentListItem {
  id: string;
  document_type: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Narrow response shape read off `GET /api/weeks/:id` (TRO-335 / FG-17) —
 * ONLY `workspace_sprint_start_date`, deliberately excluding every other
 * field that route returns. MOST IMPORTANTLY it excludes that route's own
 * `owner`/top-level `owner_id` (computed from `properties.assignee_ids[0]`
 * — `extractSprintFromRow`, `weeks.ts:499-503`/`weeks.ts:1222` — a DIFFERENT
 * value than `properties.owner_id`, this file's own module docstring's
 * documented trap). `retroDraft.ts`'s `gatherWeekDelivery` reads
 * `success_criteria`/`owner_id`/`sprint_number` from `getDocument`'s raw
 * `properties` instead, same as every trap-avoiding consumer of this file —
 * this type exists ONLY to reach the one fact `GET /api/documents/:id`
 * never returns: the workspace's own sprint-cadence anchor, needed to
 * compute which calendar days a given week actually spans. */
export interface ShipWeekDates {
  workspace_sprint_start_date: string;
}

/**
 * The on-demand expansion walk's own dependency surface (TRO-318 / FG-7) —
 * a STRICT ADDITION on top of `ShipClientLike`, not a widening of it.
 * `ShipClientLike` stays exactly as FG-5 left it (`getChangeFeed` /
 * `getDocument` / `getPeople`) deliberately: every existing proactive test
 * across this package builds its own local `ShipClientLike`-typed fake
 * object literal (`proactive.test.ts`, `proactivePoll.test.ts`,
 * `graph.test.ts`'s own proactive describe block), and widening that type
 * with new REQUIRED methods would break every one of them at compile time
 * for a capability the proactive path never uses. `OnDemandDeps.shipClient`
 * (`graph.ts`) depends on THIS type instead — `getDocument` plus the five
 * graph-walk reads FG-7 adds. Deliberately excludes `getChangeFeed`/
 * `getPeople`: the expansion walk never polls the change feed and never
 * needs the whole people directory (role-derivation via `roles.ts` was
 * considered and left out of this ticket's ranking — see graph.ts's
 * `buildCandidatesFromDocument` docstring).
 */
export type OnDemandShipClientLike = Pick<
  ShipClient,
  'getDocument' | 'getAssociations' | 'getReverseAssociations' | 'getBacklinks' | 'getComments' | 'getIssuesByAssignee'
>;

/**
 * The deep-tier draft composition's own dependency surface (TRO-319 / FG-6)
 * — a STRICT ADDITION, same pattern as `OnDemandShipClientLike`. Neither
 * `ShipClientLike` nor `OnDemandShipClientLike` alone covers what this path
 * needs: `getChangeFeed` (FG-5's, for state-change/comment activity since an
 * anchor) plus `getIssuesByAssignee`/`getAssociations`/`getDocument` (FG-7's,
 * for the person's current issue list, blocker edges, and a blocking issue's
 * title) plus `listDocuments` (new in this file, for the standup anchor
 * lookup) — no existing `Pick` union covers that combination, so this is its
 * own type rather than a widening of either existing one.
 *
 * `getPeople` added (TRO-346/TRO-337 / FG-19) — another STRICT ADDITION, same
 * reasoning: the blocker-escalation chain (`graph.ts`'s
 * `detectBlockerFanout`) reuses this exact deps shape (per that ticket's own
 * instruction to "use the existing ItemStore/DraftStore plumbing"), and it is
 * the one deep-tier consumer that needs the FULL people directory —
 * `roles.ts`'s `findLowestCommonManager` walks arbitrarily many blocked
 * people's manager chains, which needs every person's `reportsTo`, not one
 * person's issue list. No existing deep-tier node called this before, so
 * adding it here costs every other `DeepShipClientLike` consumer nothing.
 *
 * `getReverseAssociations` added (TRO-335 / FG-17) — another STRICT
 * ADDITION, identical reasoning to `getPeople` above: the retro delivery
 * chain (`graph.ts`'s `gatherRetroActivity`) needs every issue associated
 * TO a given week (`relationship_type: 'sprint'`, the reverse direction from
 * an issue's own forward `blocks`/`project` edges FG-19/FG-7 already read),
 * which only `getReverseAssociations` exposes — `getAssociations` walks
 * edges FROM a document, never edges pointing AT one. No existing deep-tier
 * consumer called this before, so adding it costs every other
 * `DeepShipClientLike` consumer nothing, same as every prior addition to
 * this type.
 *
 * `getWeekDates` added (TRO-335 / FG-17), same file, same reasoning again —
 * the retro delivery chain needs the workspace's sprint-cadence anchor to
 * compute a week's actual calendar window, which `getDocument` alone cannot
 * provide (verified directly, not assumed: `GET /api/documents/:id` never
 * joins `workspaces`). See `ShipWeekDates`'s own docstring for why this is
 * typed to expose only that one fact.
 *
 * Every method here is a READ. This is deliberate, not incidental: FG-6's
 * hard limits ("never applies an issue transition," "never creates ... any
 * document," "never writes anything that would read as though a person
 * wrote it") are enforced STRUCTURALLY by this type never exposing a write
 * method at all — the same posture FG-7 used for citations ("structural,
 * not a suffix"). A caller holding only a `DeepShipClientLike` cannot
 * accidentally call a Ship write endpoint; TypeScript has nothing to call.
 */
export type DeepShipClientLike = Pick<
  ShipClient,
  | 'getIssuesByAssignee'
  | 'getChangeFeed'
  | 'getAssociations'
  | 'getReverseAssociations'
  | 'getDocument'
  | 'listDocuments'
  | 'getPeople'
  | 'getWeekDates'
>;

export interface ShipClientOptions {
  baseUrl: string;
  token: string;
  /** Narrowed to just `.get` — every call this client makes is an
   * idempotent read, so only `ResilientClient.get` (timeout + retry +
   * breaker) is ever needed, never `.request`. */
  client: Pick<ResilientClient, 'get'>;
}

export class ShipClient {
  private readonly base: string;
  private readonly token: string;
  private readonly client: Pick<ResilientClient, 'get'>;

  constructor(options: ShipClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.client = options.client;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.client.get(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new ShipApiError('GET', url, res.status);
    }
    return (await res.json()) as T;
  }

  async getChangeFeed(since: string, limit?: number): Promise<ChangeFeedResponse> {
    const url = new URL(`${this.base}/api/change-feed`);
    url.searchParams.set('since', since);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<ChangeFeedResponse>(url.toString());
  }

  async getDocument(id: string): Promise<ShipDocument> {
    return this.getJson<ShipDocument>(`${this.base}/api/documents/${id}`);
  }

  async getPeople(): Promise<ShipPerson[]> {
    return this.getJson<ShipPerson[]>(`${this.base}/api/team/people`);
  }

  /** Forward associations FROM `documentId` (`associations.ts`'s
   * `GET /:id/associations`) — containment (parent/project/sprint/program)
   * plus `blocks` (FG-15/TRO-333), all in one generic surface since
   * `associations.ts` never filtered by type on this route unless asked. */
  async getAssociations(documentId: string, type?: string): Promise<AssociationForwardEdge[]> {
    const url = new URL(`${this.base}/api/documents/${documentId}/associations`);
    if (type !== undefined) {
      url.searchParams.set('type', type);
    }
    return this.getJson<AssociationForwardEdge[]>(url.toString());
  }

  /** Associations pointing AT `documentId` (`associations.ts`'s
   * `GET /:id/reverse-associations`) — e.g. every issue in a week, or every
   * issue that `blocks` this one. */
  async getReverseAssociations(documentId: string, type?: string): Promise<AssociationReverseEdge[]> {
    const url = new URL(`${this.base}/api/documents/${documentId}/reverse-associations`);
    if (type !== undefined) {
      url.searchParams.set('type', type);
    }
    return this.getJson<AssociationReverseEdge[]>(url.toString());
  }

  /** Documents that link to `documentId` (`backlinks.ts`'s `document_links`
   * table) — "documents that mention it" (TRO-318's Scope section). Already
   * visibility-filtered server-side. */
  async getBacklinks(documentId: string): Promise<BacklinkEntry[]> {
    return this.getJson<BacklinkEntry[]>(`${this.base}/api/documents/${documentId}/backlinks`);
  }

  /** Comments on `documentId` (`comments.ts`) — evidence text attached to a
   * document already pulled into context, never itself a walk edge to a
   * different document (a comment lives ON a document, it does not point at
   * one). */
  async getComments(documentId: string): Promise<CommentEntry[]> {
    return this.getJson<CommentEntry[]>(`${this.base}/api/documents/${documentId}/comments`);
  }

  /** Other issues assigned to `assigneeUserId` (`issues.ts`'s
   * `GET /api/issues?assignee_id=...`) — "the people and their other work."
   * `limit` keeps one prolific assignee from flooding a single hop's
   * candidate set; omitted = every matching issue (the route's own default). */
  async getIssuesByAssignee(assigneeUserId: string, limit?: number): Promise<AssigneeIssueSummary[]> {
    const url = new URL(`${this.base}/api/issues`);
    url.searchParams.set('assignee_id', assigneeUserId);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<AssigneeIssueSummary[]>(url.toString());
  }

  /** `GET /api/documents?type=...` (`documents.ts`) — workspace-wide, NOT
   * filtered by author. TRO-319 / FG-6 uses this for the standup anchor
   * lookup (`standupDraft.ts`'s `findStandupAnchor`), filtering the result
   * client-side to one author's `properties.author_id` — there is no
   * server-side "standups by author X" route usable here: `GET /api/standups`
   * (`standups.ts`) only ever returns the AUTHENTICATED caller's own
   * standups (`req.userId`, hardcoded), and this agent runs under one shared
   * token for the whole deep-tier pass (same posture FG-5's
   * `detectBlockingApprovals` already relies on — one token, many
   * recipients), not a distinct token per person. */
  async listDocuments(type: string, limit?: number): Promise<DocumentListItem[]> {
    const url = new URL(`${this.base}/api/documents`);
    url.searchParams.set('type', type);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<DocumentListItem[]>(url.toString());
  }

  /** `GET /api/weeks/:id` (`weeks.ts`), narrowed to ONLY
   * `workspace_sprint_start_date` at the type level — see `ShipWeekDates`'s
   * own docstring for why every other field this route returns (most
   * importantly its `owner`/`owner_id`) is deliberately excluded. TRO-335 /
   * FG-17's only consumer: `retroDraft.ts`'s `gatherWeekDelivery`, to
   * compute which calendar days a week actually spans. */
  async getWeekDates(weekId: string): Promise<ShipWeekDates> {
    return this.getJson<ShipWeekDates>(`${this.base}/api/weeks/${weekId}`);
  }
}

// =============================================================================
// The gate's write-capable client (TRO-321 / FG-8)
// =============================================================================
//
// Everything above this line is a READ, on `ShipClient` or one of its three
// `*Like` narrowings (`ShipClientLike`/`OnDemandShipClientLike`/
// `DeepShipClientLike`) — every one of them Pick<ShipClient, ...>, and
// `ShipClient` itself has no write method for any of them to accidentally
// expose. That is deliberate and load-bearing (see `DeepShipClientLike`'s own
// docstring): the proactive/on-demand/deep graph chains hold only these
// types, so there is nothing on them to call even by mistake.
//
// This ticket is the one place in the whole bundle that needs an actual
// write. `GateShipClient` is a SEPARATE class from `ShipClient`, not an
// extension of it, for a specific reason: `ShipClient` binds ONE token at
// construction time (`ShipClientOptions.token`) and the agent's production
// instance (`index.ts`) is constructed with the agent's OWN `SHIP_API_TOKEN`
// — reused for the whole process's lifetime, across every recipient a
// proactive/deep run ever touches. Bolting write methods onto that same class
// would put a write path one missed-parameter away from silently running
// under the agent's own identity, which is exactly the failure this ticket
// exists to prevent: "accepting is what performs the Ship write, under the
// accepting person's own API token, attributed to them" (TRO-321's Scope,
// verbatim) — not the agent's.
//
// `GateShipClient` holds NO token field at all. Every method takes `token` as
// an explicit, required per-call argument. There is no constructor argument
// or stored default to fall back to — a call site that forgets to pass one is
// a TypeScript compile error, not a silent runtime default to the wrong
// identity. This is the structural half of "MUST NOT use the agent's own
// token to perform a write": the class is not CAPABLE of using any token
// other than the one the caller hands it for that specific call.

/** Response shape of `POST /api/standups` and `PATCH /api/standups/:id`
 * (`standups.ts`) — both handlers return the same document shape. */
export interface CreatedStandup {
  id: string;
  title: string;
  document_type: string;
  content: unknown;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * The gate's own write-capable surface (TRO-321 / FG-8) — an ADDITIVE
 * interface, same pattern as `OnDemandShipClientLike`/`DeepShipClientLike`,
 * but the one exception to every one of those being read-only. Nothing in
 * `graph.ts` — or anywhere upstream of `gate.ts` — ever holds a value of this
 * type; see `graph.ts`'s module docstring and `agent/src/__tests__/
 * graphWriteBoundary.test.ts` for the proof that stays true.
 */
export interface GateShipClientLike {
  /** `POST /api/standups` (`standups.ts`) — idempotent per (author, date) on
   * Ship's own side (that route's existing-row check), attributed to
   * whichever user `token` belongs to: Ship's `authMiddleware` resolves
   * `req.userId` from the bearer token, and the route sets
   * `properties.author_id`/`created_by` directly from `req.userId` — verified
   * by reading the route, not assumed. Creates the document with Ship's own
   * blank template content; `setStandupContent` below is what puts the
   * drafted (and possibly person-edited) text into it. */
  postStandup(token: string, date: string): Promise<CreatedStandup>;
  /** `PATCH /api/standups/:id` (`standups.ts`) — sets a standup's content to
   * `text`, converted to the minimal TipTap doc shape every document type in
   * Ship stores (`plainTextToTipTapDoc`, `gate.ts`). Same attribution
   * mechanism as `postStandup`: the route only allows the standup's own
   * author (or an admin) to update it, checked against `token`'s resolved
   * `req.userId`. */
  setStandupContent(token: string, standupId: string, text: string): Promise<CreatedStandup>;
  /** `PATCH /api/issues/:id` (`issues.ts`) — the SAME route a person editing
   * the issue in Ship's own UI calls; this is not a special agent-only write
   * path. `changed_by` on the `document_history` row this produces is
   * `req.userId`, resolved from `token` — the agent identity never appears
   * there because it never authenticates this call under its own identity
   * (this method is the one exception to "every method in shipClient.ts is a
   * read"). `automated_by` is never sent: `updateIssueSchema` (`issues.ts`)
   * has no such field on the plain `state` path, only on the separate
   * `claude_metadata` one this call never uses. */
  applyIssueTransition(token: string, issueId: string, toState: string): Promise<void>;
}

/** Converts a plain-text draft (or person-edited text) into the minimal
 * TipTap `doc` JSON every document type in Ship stores in its `content`
 * column — one paragraph per line, matching the shape `standups.ts`'s own
 * default content and `api/src/db/seed.ts`'s standup fixtures already use.
 * Blank lines become empty paragraphs (TipTap's own convention for a blank
 * line, matching `standups.ts`'s default `{ type: 'paragraph' }` with no
 * `content` key) rather than being dropped, so the person's own paragraph
 * breaks survive the round trip. */
export function plainTextToTipTapDoc(text: string): { type: 'doc'; content: unknown[] } {
  const lines = text.split('\n');
  return {
    type: 'doc',
    content: lines.map((line) =>
      line.length === 0
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    ),
  };
}

export interface GateShipClientOptions {
  baseUrl: string;
  /** Narrowed to just `.request` — every call this client makes is a
   * non-idempotent write (POST/PATCH), so `ResilientClient.get`'s retry
   * behavior (built for idempotent reads only) is never appropriate here;
   * see `resilientClient.ts`'s own docstring for `request` vs `get`. */
  client: Pick<ResilientClient, 'request'>;
}

export class GateShipClient implements GateShipClientLike {
  private readonly base: string;
  private readonly client: Pick<ResilientClient, 'request'>;

  constructor(options: GateShipClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.client = options.client;
  }

  private authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  private async writeJson<T>(method: 'POST' | 'PATCH', url: string, token: string, body: unknown): Promise<T> {
    const res = await this.client.request(url, {
      method,
      headers: this.authHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ShipApiError(method, url, res.status);
    }
    return (await res.json()) as T;
  }

  async postStandup(token: string, date: string): Promise<CreatedStandup> {
    return this.writeJson<CreatedStandup>('POST', `${this.base}/api/standups`, token, { date });
  }

  async setStandupContent(token: string, standupId: string, text: string): Promise<CreatedStandup> {
    return this.writeJson<CreatedStandup>('PATCH', `${this.base}/api/standups/${standupId}`, token, {
      content: plainTextToTipTapDoc(text),
    });
  }

  async applyIssueTransition(token: string, issueId: string, toState: string): Promise<void> {
    await this.writeJson<unknown>('PATCH', `${this.base}/api/issues/${issueId}`, token, { state: toState });
  }
}
