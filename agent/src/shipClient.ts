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
import type { ShipClient as SdkShipClient, DocumentType as SdkDocumentType, IssueState as SdkIssueState } from '@ship/sdk';

/**
 * PF-702 (TRO-428) — `AGENT_PLATFORM_MODE=sdk` mode. When `ShipClientOptions
 * .sdk` is set, each of the 10 read methods below delegates to `@ship/sdk`'s
 * typed `/api/v1/*` resource clients instead of calling Ship's internal
 * `/api/*` routes directly. Every method is split into a `ViaInternal`/
 * `ViaSdk` pair, kept immediately adjacent so the two are easy to diff
 * against each other — the public method just dispatches on `this.sdk`.
 * `agent/` is a permitted `@ship/sdk` workspace consumer per PLUGFORGE.MD
 * §2.1/§1.3 (documented in `api/src/platform/README.md`'s boundary-rules
 * section, and deliberately excluded from `scripts/check-integration-deps
 * .mjs`'s enforcement — see that script's own header).
 *
 * ── Fields that CANNOT carry over from internal to sdk mode (verified, not
 *    guessed — CLAUDE.md's claim-provenance rule) ──
 *
 * `getDocument()`: `GET /api/v1/documents/:id`'s own doc comment states it
 * plainly — "Deliberately narrower than the full internal `documents` row
 * (no `content`, `yjs_state`, `visibility`, etc.)" — confirmed by reading
 * `DocumentRow`/`serializeDocument()` in
 * `api/src/platform/api/v1/resources/documents.ts` directly. `content` and
 * `completed_at` are absent from the v1 response; `visibility`/`created_by`
 * are absent too. The last two are not cosmetic: `visibility.ts`'s
 * `isDocumentVisibleTo` — FleetGraph's own "never surface a document the
 * recipient can't see" security check — REQUIRES real `visibility`/
 * `created_by` values. `getDocumentViaSdk` below synthesizes values that
 * make that check FAIL CLOSED (never treated as visible) rather than
 * fabricating `'workspace'`/a matching `created_by`, which would silently
 * WIDEN who a private document gets surfaced to — the same "wrong direction
 * to be wrong in" posture `visibility.ts`'s own docstring already states for
 * its missing-admin-check case. This is a real, disclosed behavioral
 * difference in `sdk` mode, not a silent gap — see CHANGES.md (TRO-428) and
 * the parity test's own `getDocument` case for exactly what is and is not
 * proven equivalent.
 *
 * `getAssociations()`/`getReverseAssociations()`: the internal route's
 * `?type=` filter (e.g. `'blocks'`, `'project'`, `'sprint'` — actively used
 * by `standupDraft.ts`/`blockerFanout.ts`/`retroDraft.ts`) has no server-side
 * equivalent on the v1 sub-resource (`SubResourceListQuerySchema` is
 * `limit`/`cursor` only — verified by reading
 * `api/src/platform/api/v1/resources/documents.ts` directly). `ViaSdk` below
 * fetches every page (bounded, see `collectAllPages`) and filters by `type`
 * client-side instead — correct for the association counts this codebase
 * actually has (a handful per document), but more round trips than the
 * internal route's single filtered query. Also a real, disclosed gap, not
 * silently absorbed.
 */
const SDK_MODE_DOCUMENT_VISIBILITY_UNKNOWN = 'sdk_mode_unknown';

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
  /** PF-702 (TRO-428) — `AGENT_PLATFORM_MODE=sdk`. When set, every read
   * method below delegates to this `@ship/sdk` client's `/api/v1/*`
   * resource methods instead of `client.get` against internal `/api/*`
   * routes. `token`/`client` above stay required (unchanged contract for
   * every existing caller) even when `sdk` is set — they simply go unused
   * for that instance's reads. The bearer token actually used for `sdk`
   * requests is whatever this `SdkShipClient` was itself constructed with
   * (a personal token for the on-demand per-asker factory, or an app
   * Client Credentials token for the shared/proactive instance — see
   * `index.ts` for which) — this class never re-derives or overrides it. */
  sdk?: SdkShipClient;
}

export class ShipClient {
  private readonly base: string;
  private readonly token: string;
  private readonly client: Pick<ResilientClient, 'get'>;
  private readonly sdk: SdkShipClient | undefined;

  constructor(options: ShipClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.client = options.client;
    this.sdk = options.sdk;
  }

  /**
   * Walks every page of a v1 list sub-resource up to `maxPages` (default 20
   * pages, i.e. up to 2,000 items at the server's own 100-per-page cap) —
   * used by the `ViaSdk` methods below whose internal counterpart returns
   * the WHOLE collection in one call (no `limit` parameter on the agent's
   * own method signature: `getAssociations`/`getReverseAssociations`/
   * `getBacklinks`/`getComments`), unlike `documents`/`issues`/`sprints`/
   * `people`, which already have a real `iterate()` on the SDK. Bounded
   * rather than unbounded so a pathological document can never hang a read
   * — matches this file's own existing pattern of capping unbounded internal
   * reads (`listDocuments`'s own default-everything internal route, capped
   * only by the caller's `limit` argument when one is passed).
   */
  private async collectAllPages<T>(
    fetchPage: (cursor?: string) => Promise<{ data: readonly T[]; next_cursor: string | null }>,
    maxPages = 20
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await fetchPage(cursor);
      items.push(...result.data);
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
      // CodeRabbit finding (TRO-428): make a truncated collection
      // observable rather than silently returning fewer items than
      // internal mode's own return-everything behavior would. Only fires
      // on the LAST allowed page when more data genuinely remains.
      if (page === maxPages - 1) {
        console.warn(
          `[shipClient] collectAllPages hit the ${maxPages}-page bound with a next_cursor still set; result is truncated at ${items.length} item(s)`
        );
      }
    }
    return items;
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
    const sdk = this.sdk;
    return sdk ? this.getChangeFeedViaSdk(sdk, since, limit) : this.getChangeFeedViaInternal(since, limit);
  }

  private async getChangeFeedViaInternal(since: string, limit?: number): Promise<ChangeFeedResponse> {
    const url = new URL(`${this.base}/api/change-feed`);
    url.searchParams.set('since', since);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<ChangeFeedResponse>(url.toString());
  }

  /** `GET /api/v1/changes` (PF-205) — a single tagged `data[]` array
   *  (`resource: 'document' | 'document_history' | 'comment'`), not three
   *  parallel arrays. Every field the internal shape needs (including
   *  `dedupe_key`) survives on the matching `data` entry — verified by
   *  reading `resources/changes.ts` directly, not guessed — so this is a
   *  lossless reassembly, partitioning by `.resource` and rebuilding the
   *  three `*_truncated` flags from `page.truncated`. */
  private async getChangeFeedViaSdk(sdk: SdkShipClient, since: string, limit?: number): Promise<ChangeFeedResponse> {
    const page = await sdk.changes.list({ since, limit });
    const documents: ChangeFeedDocument[] = [];
    const history: ChangeFeedHistoryEntry[] = [];
    const comments: ChangeFeedComment[] = [];

    for (const entry of page.data) {
      if (entry.resource === 'document') {
        documents.push({
          id: entry.id,
          document_type: entry.document_type,
          title: entry.title,
          updated_at: entry.updated_at,
          created_by: entry.created_by,
          dedupe_key: entry.dedupe_key,
        });
      } else if (entry.resource === 'document_history') {
        history.push({
          id: entry.id,
          document_id: entry.document_id,
          field: entry.field,
          old_value: entry.old_value,
          new_value: entry.new_value,
          changed_by: entry.changed_by,
          automated_by: entry.automated_by,
          created_at: entry.created_at,
          dedupe_key: entry.dedupe_key,
        });
      } else {
        comments.push({
          id: entry.id,
          document_id: entry.document_id,
          comment_id: entry.comment_id,
          parent_id: entry.parent_id,
          author_id: entry.author_id,
          content: entry.content,
          resolved_at: entry.resolved_at,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
          dedupe_key: entry.dedupe_key,
        });
      }
    }

    return {
      next_cursor: page.next_cursor,
      documents,
      documents_truncated: page.truncated.documents,
      history,
      history_truncated: page.truncated.document_history,
      comments,
      comments_truncated: page.truncated.comments,
    };
  }

  async getDocument(id: string): Promise<ShipDocument> {
    const sdk = this.sdk;
    return sdk ? this.getDocumentViaSdk(sdk, id) : this.getDocumentViaInternal(id);
  }

  private async getDocumentViaInternal(id: string): Promise<ShipDocument> {
    return this.getJson<ShipDocument>(`${this.base}/api/documents/${id}`);
  }

  /** See this file's module docstring ("Fields that CANNOT carry over") for
   *  the full, verified explanation of why `content`/`completed_at` are
   *  `null`/`undefined` and `visibility`/`created_by` are synthesized to
   *  fail `isDocumentVisibleTo` closed rather than open. */
  private async getDocumentViaSdk(sdk: SdkShipClient, id: string): Promise<ShipDocument> {
    const doc = await sdk.documents.get(id);
    return {
      id: doc.id,
      document_type: doc.document_type,
      title: doc.title,
      content: null,
      visibility: SDK_MODE_DOCUMENT_VISIBILITY_UNKNOWN,
      created_by: null,
      // No cast needed (CodeRabbit finding, TRO-428): `doc.properties` is
      // `Record<string, unknown>`, and `ShipDocument['properties']`'s own
      // index signature (`[key: string]: unknown`) already makes every
      // named field structurally optional-and-compatible — a plain
      // `Record<string, unknown>` satisfies it without narrowing.
      properties: doc.properties,
      completed_at: undefined,
    };
  }

  async getPeople(): Promise<ShipPerson[]> {
    const sdk = this.sdk;
    return sdk ? this.getPeopleViaSdk(sdk) : this.getPeopleViaInternal();
  }

  private async getPeopleViaInternal(): Promise<ShipPerson[]> {
    return this.getJson<ShipPerson[]>(`${this.base}/api/team/people`);
  }

  /** `GET /api/v1/people` (PF-205) is paginated; the internal route returns
   *  the whole directory in one call. `people.iterate()` (the SDK's own
   *  async-iterator pagination, PF-402) walks every page transparently. */
  private async getPeopleViaSdk(sdk: SdkShipClient): Promise<ShipPerson[]> {
    const people: ShipPerson[] = [];
    for await (const person of sdk.people.iterate()) {
      people.push({
        id: person.id,
        user_id: person.user_id,
        name: person.name,
        email: person.email,
        isArchived: person.is_archived,
        isPending: person.is_pending,
        reportsTo: person.reports_to,
        role: person.role,
      });
    }
    return people;
  }

  /** Forward associations FROM `documentId` (`associations.ts`'s
   * `GET /:id/associations`) — containment (parent/project/sprint/program)
   * plus `blocks` (FG-15/TRO-333), all in one generic surface since
   * `associations.ts` never filtered by type on this route unless asked. */
  async getAssociations(documentId: string, type?: string): Promise<AssociationForwardEdge[]> {
    const sdk = this.sdk;
    return sdk ? this.getAssociationsViaSdk(sdk, documentId, type) : this.getAssociationsViaInternal(documentId, type);
  }

  private async getAssociationsViaInternal(documentId: string, type?: string): Promise<AssociationForwardEdge[]> {
    const url = new URL(`${this.base}/api/documents/${documentId}/associations`);
    if (type !== undefined) {
      url.searchParams.set('type', type);
    }
    return this.getJson<AssociationForwardEdge[]>(url.toString());
  }

  /** `GET /api/v1/documents/:id/associations` has no `?type=` filter (see
   *  module docstring) — fetches every page (`collectAllPages`) and filters
   *  by `type` client-side instead. */
  private async getAssociationsViaSdk(sdk: SdkShipClient, documentId: string, type?: string): Promise<AssociationForwardEdge[]> {
    const edges = await this.collectAllPages((cursor) =>
      sdk.documents.getAssociations(documentId, { limit: 100, cursor })
    );
    return edges
      .filter((edge) => type === undefined || edge.relationship_type === type)
      .map((edge) => ({ related_id: edge.related_id, relationship_type: edge.relationship_type }));
  }

  /** Associations pointing AT `documentId` (`associations.ts`'s
   * `GET /:id/reverse-associations`) — e.g. every issue in a week, or every
   * issue that `blocks` this one. */
  async getReverseAssociations(documentId: string, type?: string): Promise<AssociationReverseEdge[]> {
    const sdk = this.sdk;
    return sdk
      ? this.getReverseAssociationsViaSdk(sdk, documentId, type)
      : this.getReverseAssociationsViaInternal(documentId, type);
  }

  private async getReverseAssociationsViaInternal(documentId: string, type?: string): Promise<AssociationReverseEdge[]> {
    const url = new URL(`${this.base}/api/documents/${documentId}/reverse-associations`);
    if (type !== undefined) {
      url.searchParams.set('type', type);
    }
    return this.getJson<AssociationReverseEdge[]>(url.toString());
  }

  /** Same "no server-side type filter" gap as `getAssociationsViaSdk` above
   *  — see module docstring. */
  private async getReverseAssociationsViaSdk(
    sdk: SdkShipClient,
    documentId: string,
    type?: string
  ): Promise<AssociationReverseEdge[]> {
    const edges = await this.collectAllPages((cursor) =>
      sdk.documents.getReverseAssociations(documentId, { limit: 100, cursor })
    );
    return edges
      .filter((edge) => type === undefined || edge.relationship_type === type)
      .map((edge) => ({ document_id: edge.document_id, relationship_type: edge.relationship_type }));
  }

  /** Documents that link to `documentId` (`backlinks.ts`'s `document_links`
   * table) — "documents that mention it" (TRO-318's Scope section). Already
   * visibility-filtered server-side. */
  async getBacklinks(documentId: string): Promise<BacklinkEntry[]> {
    const sdk = this.sdk;
    return sdk ? this.getBacklinksViaSdk(sdk, documentId) : this.getBacklinksViaInternal(documentId);
  }

  private async getBacklinksViaInternal(documentId: string): Promise<BacklinkEntry[]> {
    return this.getJson<BacklinkEntry[]>(`${this.base}/api/documents/${documentId}/backlinks`);
  }

  /** `GET /api/v1/documents/:id/backlinks` (PF-205) is paginated; the
   *  internal route returns every backlink in one call — `collectAllPages`
   *  walks every page to match. `display_id: string | null` (v1) narrows
   *  cleanly to `BacklinkEntry.display_id?: string` by omitting the key when
   *  `null` (v1 uses `null` for "no ticket number"; the agent's own type
   *  already treats "absent" and a former `undefined` the same way). */
  private async getBacklinksViaSdk(sdk: SdkShipClient, documentId: string): Promise<BacklinkEntry[]> {
    const backlinks = await this.collectAllPages((cursor) => sdk.documents.getBacklinks(documentId, { limit: 100, cursor }));
    return backlinks.map((b) => ({
      id: b.id,
      document_type: b.document_type,
      title: b.title,
      ...(b.display_id !== null ? { display_id: b.display_id } : {}),
    }));
  }

  /** Comments on `documentId` (`comments.ts`) — evidence text attached to a
   * document already pulled into context, never itself a walk edge to a
   * different document (a comment lives ON a document, it does not point at
   * one). */
  async getComments(documentId: string): Promise<CommentEntry[]> {
    const sdk = this.sdk;
    return sdk ? this.getCommentsViaSdk(sdk, documentId) : this.getCommentsViaInternal(documentId);
  }

  private async getCommentsViaInternal(documentId: string): Promise<CommentEntry[]> {
    return this.getJson<CommentEntry[]>(`${this.base}/api/documents/${documentId}/comments`);
  }

  /** `GET /api/v1/documents/:id/comments` (PF-205) is paginated (walked via
   *  `collectAllPages` to match the internal route's return-everything
   *  shape) and, verified by reading the handler directly, LEFT JOINs the
   *  author (`author: null` when the author's user row is gone) where the
   *  internal route INNER JOINs — a comment with no resolvable author is
   *  simply ABSENT from the internal route's results, never returned with a
   *  placeholder. CodeRabbit finding (TRO-428): an earlier version of this
   *  method fabricated a `'(unknown)'` author to satisfy `CommentEntry`'s
   *  non-null `author` field, which is a WORSE parity mismatch than dropping
   *  the row — filtering matches the internal route's actual behavior
   *  exactly, rather than inventing a value it would never produce. */
  private async getCommentsViaSdk(sdk: SdkShipClient, documentId: string): Promise<CommentEntry[]> {
    const comments = await this.collectAllPages((cursor) => sdk.documents.getComments(documentId, { limit: 100, cursor }));
    return comments
      .filter((c): c is typeof c & { author: NonNullable<typeof c.author> } => c.author !== null)
      .map((c) => ({
        id: c.id,
        content: c.content,
        // `author.name` is independently `string | null` in the SDK's own
        // type even once `author` itself is non-null (a real user row with
        // no name recorded) — `users.name` is NOT NULL in this repo's
        // schema, so the internal route's own `author.name` is never
        // actually null in practice, but the fallback keeps this method
        // honest about what the SDK's type actually allows rather than
        // asserting it away.
        author: { id: c.author.id, name: c.author.name ?? '(unknown)', email: c.author.email },
        created_at: c.created_at,
        resolved_at: c.resolved_at,
      }));
  }

  /** Other issues assigned to `assigneeUserId` (`issues.ts`'s
   * `GET /api/issues?assignee_id=...`) — "the people and their other work."
   * `limit` keeps one prolific assignee from flooding a single hop's
   * candidate set; omitted = every matching issue (the route's own default). */
  async getIssuesByAssignee(assigneeUserId: string, limit?: number): Promise<AssigneeIssueSummary[]> {
    const sdk = this.sdk;
    return sdk
      ? this.getIssuesByAssigneeViaSdk(sdk, assigneeUserId, limit)
      : this.getIssuesByAssigneeViaInternal(assigneeUserId, limit);
  }

  private async getIssuesByAssigneeViaInternal(assigneeUserId: string, limit?: number): Promise<AssigneeIssueSummary[]> {
    const url = new URL(`${this.base}/api/issues`);
    url.searchParams.set('assignee_id', assigneeUserId);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<AssigneeIssueSummary[]>(url.toString());
  }

  /** `GET /api/v1/issues?assignee_id=` (PF-702 fix — `IssuesClient.list()`
   *  did not forward `assignee_id` before this ticket; see `sdk/src/types
   *  .ts`'s `ListIssuesParams` doc comment and CHANGES.md for the finding).
   *  `omitted limit` (internal's own default = every matching issue) maps to
   *  `collectAllPages` walking every page; a real `limit` maps to a single
   *  page request at that size, matching the internal route's own "limit
   *  caps the whole result, not a page" semantics for this method. */
  private async getIssuesByAssigneeViaSdk(
    sdk: SdkShipClient,
    assigneeUserId: string,
    limit?: number
  ): Promise<AssigneeIssueSummary[]> {
    const issues =
      limit === undefined
        ? await this.collectAllPages((cursor) => sdk.issues.list({ assignee_id: assigneeUserId, limit: 100, cursor }))
        : (await sdk.issues.list({ assignee_id: assigneeUserId, limit })).data;
    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      state: issue.state,
      updated_at: issue.updated_at,
    }));
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
    const sdk = this.sdk;
    return sdk ? this.listDocumentsViaSdk(sdk, type, limit) : this.listDocumentsViaInternal(type, limit);
  }

  private async listDocumentsViaInternal(type: string, limit?: number): Promise<DocumentListItem[]> {
    const url = new URL(`${this.base}/api/documents`);
    url.searchParams.set('type', type);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }
    return this.getJson<DocumentListItem[]>(url.toString());
  }

  /** `GET /api/v1/documents?type=` — a full field superset of
   *  `DocumentListItem` (adds `title`, dropped here). Same "no limit ==
   *  every matching row" vs "a real limit == one page" split as
   *  `getIssuesByAssigneeViaSdk` above, for the identical reason
   *  (`listDocuments`'s own internal route has no page concept either). */
  private async listDocumentsViaSdk(sdk: SdkShipClient, type: string, limit?: number): Promise<DocumentListItem[]> {
    // `listDocuments(type: string, ...)` takes a plain string (every call
    // site passes a real document_type literal — 'standup' etc.); the SDK's
    // `ListDocumentsParams.type` narrows to `DocumentType`. Not `as any`/`as
    // unknown as` (review-patterns.mjs / lessons.md rule 16) — a direct
    // narrowing cast to a specific literal union, the same shape this file's
    // other `ViaSdk` methods use implicitly via object-literal field access.
    const docType = type as SdkDocumentType;
    const docs =
      limit === undefined
        ? await this.collectAllPages((cursor) => sdk.documents.list({ type: docType, limit: 100, cursor }))
        : (await sdk.documents.list({ type: docType, limit })).data;
    return docs.map((doc) => ({
      id: doc.id,
      document_type: doc.document_type,
      properties: doc.properties,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }));
  }

  /** `GET /api/weeks/:id` (`weeks.ts`), narrowed to ONLY
   * `workspace_sprint_start_date` at the type level — see `ShipWeekDates`'s
   * own docstring for why every other field this route returns (most
   * importantly its `owner`/`owner_id`) is deliberately excluded. TRO-335 /
   * FG-17's only consumer: `retroDraft.ts`'s `gatherWeekDelivery`, to
   * compute which calendar days a week actually spans. */
  async getWeekDates(weekId: string): Promise<ShipWeekDates> {
    const sdk = this.sdk;
    return sdk ? this.getWeekDatesViaSdk(sdk, weekId) : this.getWeekDatesViaInternal(weekId);
  }

  private async getWeekDatesViaInternal(weekId: string): Promise<ShipWeekDates> {
    return this.getJson<ShipWeekDates>(`${this.base}/api/weeks/${weekId}`);
  }

  /** `GET /api/v1/sprints/:id` (PF-205) — a "week" internally is a `sprint`
   *  document type; `SprintDetail.workspace_sprint_start_date` is exactly
   *  the one fact `ShipWeekDates` needs (verified against
   *  `resources/sprints.ts`'s `GET /:id` handler directly). */
  private async getWeekDatesViaSdk(sdk: SdkShipClient, weekId: string): Promise<ShipWeekDates> {
    const sprint = await sdk.sprints.get(weekId);
    return { workspace_sprint_start_date: sprint.workspace_sprint_start_date };
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

/**
 * The narrow slice of `@ship/sdk`'s `ShipClient` that `GateShipClient`'s
 * sdk-mode writes below actually call (PF-703, TRO-435) — same "Pick, not
 * the whole class" convention this file already uses for `ShipClientLike`/
 * `OnDemandShipClientLike`/`DeepShipClientLike`. A real `SdkShipClient`
 * instance structurally satisfies this (its `.documents`/`.issues` fields
 * have strictly MORE methods than these `Pick`s require); test doubles
 * build a plain object literal instead — the same "fake, not a mock of the
 * real class" convention `fakeRequestClient` already uses one layer down,
 * in `shipClient.test.ts`, for internal mode.
 */
export interface GateSdkClientLike {
  me: SdkShipClient['me'];
  documents: Pick<SdkShipClient['documents'], 'create' | 'update'>;
  issues: Pick<SdkShipClient['issues'], 'update'>;
}

const SDK_ISSUE_STATES: ReadonlySet<string> = new Set([
  'triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled',
]);

/**
 * `applyIssueTransition`'s `toState` is a plain `string` at this file's own
 * `GateShipClientLike` boundary (unchanged by this ticket — every existing
 * caller, `gate.ts`'s `acceptProposedTransition`, already passes a string).
 * sdk mode's `issues.update()` (`@ship/sdk`) requires the narrower
 * `IssueState` literal union. Guarded, not asserted blind (lessons.md #16):
 * an unrecognized value throws HERE, in this process, with a clear message
 * naming the bad value — never a silent `as SdkIssueState` past a value the
 * server's own `UpdateIssueRequestSchema` would reject anyway with a less
 * specific 400. */
function assertSdkIssueState(value: string): SdkIssueState {
  if (!SDK_ISSUE_STATES.has(value)) {
    throw new Error(`GateShipClient.applyIssueTransition: "${value}" is not a recognized issue state`);
  }
  return value as SdkIssueState;
}

/**
 * Same weekday/month-day title format the internal `POST /api/standups`
 * route computes (`api/src/routes/standups.ts`) — reproduced here, not
 * imported: `agent/` cannot reach into `api/src/...` (this file's own
 * established convention; see `config.ts`'s `FLEETGRAPH_CLIENT_ID` doc
 * comment for the identical "independently-verified copy" reasoning).
 * Needed because sdk mode's `POST /api/v1/documents` has no server-side
 * title default the way the internal route does — `title` is REQUIRED at
 * that public surface (`resources/documents.ts`'s `CreateDocumentRequestSchema`
 * own doc comment: "no 'Untitled' default here, unlike the internal API").
 */
function standupTitleForDate(date: string): string {
  const dateObj = new Date(`${date}T00:00:00Z`);
  const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const monthDay = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${dayName} ${monthDay} Standup`;
}

export interface GateShipClientOptions {
  baseUrl: string;
  /** Narrowed to just `.request` — every INTERNAL-mode call this client
   * makes is a non-idempotent write (POST/PATCH), so `ResilientClient.get`'s
   * retry behavior (built for idempotent reads only) is never appropriate
   * here; see `resilientClient.ts`'s own docstring for `request` vs `get`. */
  client: Pick<ResilientClient, 'request'>;
  /**
   * PF-703 (TRO-435) — when provided, sdk mode: each of the three write
   * methods below calls `sdkClientFactory(token)` to build a FRESH
   * `@ship/sdk` `ShipClient` bound to THAT call's own acting-human token
   * (never a stored one — `GateShipClient` still holds no token field of
   * its own; see this file's "gate's write-capable client" section above),
   * and routes the write through `/api/v1/*` instead of `this.client
   * .request` against the internal `/api/*` route. Constructing a client
   * per call is cheap by design — `@ship/sdk`'s `ShipClient` constructor
   * docstring states this explicitly: "Required by PF-703 (the agent gate
   * builds a fresh ShipClient per human-token write); a constructor that
   * made a network call would be prohibitively expensive there" — so a
   * fresh instance per call is the intended pattern, not a perf concern.
   *
   * `undefined` (the default): internal mode, byte-for-byte unchanged from
   * before this ticket — every write still goes straight to Ship's own
   * internal API via `this.client.request`.
   *
   * Built EXTERNALLY (`index.ts`), mirroring `ShipClientOptions.sdk`'s own
   * "constructed once, outside this file" convention for the read path —
   * this file never needs to import `@ship/sdk`'s `ShipClient` as a VALUE,
   * only as the type `GateSdkClientLike` above borrows method signatures
   * from. `index.ts` mints a scoped personal token per accepted write
   * (`api/src/routes/agent.ts`'s `POST /accept-draft` -> `mintEphemeralAgentToken`
   * with `documents:write`/`issues:write` scopes, PF-703) and passes IT as
   * `accepterToken` — this factory just decides which wire protocol that
   * token authenticates against, not where the token itself comes from. */
  sdkClientFactory?: (token: string) => GateSdkClientLike;
}

export class GateShipClient implements GateShipClientLike {
  private readonly base: string;
  private readonly client: Pick<ResilientClient, 'request'>;
  private readonly sdkClientFactory: ((token: string) => GateSdkClientLike) | undefined;

  constructor(options: GateShipClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.client = options.client;
    this.sdkClientFactory = options.sdkClientFactory;
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
    const factory = this.sdkClientFactory;
    return factory ? this.postStandupViaSdk(factory(token), date) : this.postStandupViaInternal(token, date);
  }

  private async postStandupViaInternal(token: string, date: string): Promise<CreatedStandup> {
    return this.writeJson<CreatedStandup>('POST', `${this.base}/api/standups`, token, { date });
  }

  /**
   * `POST /api/v1/documents` (`documents:write` scope) with
   * `document_type: 'standup'`. Two disclosed differences from internal
   * mode (CHANGES.md, TRO-435 — same "disclosed limitation" posture PF-702
   * used for sdk-mode `getDocument()`, not a silent gap):
   *  - No idempotency check: the internal route returns the EXISTING
   *    standup for this (author, date) if one already exists; this always
   *    creates a new document. The one real call site
   *    (`gate.ts`'s `acceptDraft`) never retries a successful accept, so
   *    this is a real but narrow gap, not a correctness bug in the
   *    happy path.
   *  - `content` on the returned object is always `null` — the public
   *    `GET/POST /api/v1/documents` route never returns `content`
   *    (`resources/documents.ts`'s `serializeDocument()`, deliberately
   *    narrower than the internal row). Harmless for the one real caller:
   *    `acceptDraft` only reads `created.id` off this return value, never
   *    `.content`.
   * `properties.author_id` IS still set correctly — via one extra `me()`
   * call to resolve the acting human's own id from their token (this
   * client holds no user-id field, only the token) — so standup ownership
   * (`GET /standups?date_from&date_to`'s own filter) keeps working the same
   * as internal mode for anything created this way.
   */
  private async postStandupViaSdk(sdk: GateSdkClientLike, date: string): Promise<CreatedStandup> {
    const me = await sdk.me();
    const created = await sdk.documents.create({
      title: standupTitleForDate(date),
      document_type: 'standup',
      properties: { author_id: me.user?.id ?? null, date },
    });
    return { ...created, content: null };
  }

  async setStandupContent(token: string, standupId: string, text: string): Promise<CreatedStandup> {
    const factory = this.sdkClientFactory;
    return factory
      ? this.setStandupContentViaSdk(factory(token), standupId, text)
      : this.setStandupContentViaInternal(token, standupId, text);
  }

  private async setStandupContentViaInternal(token: string, standupId: string, text: string): Promise<CreatedStandup> {
    return this.writeJson<CreatedStandup>('PATCH', `${this.base}/api/standups/${standupId}`, token, {
      content: plainTextToTipTapDoc(text),
    });
  }

  /** `PATCH /api/v1/documents/:id` (`documents:write` scope), `content`
   *  only. The response `content` is the exact TipTap doc this call just
   *  sent — the public PATCH route doesn't echo `content` back either
   *  (same `serializeDocument()` narrowing `postStandupViaSdk` documents),
   *  but this is not a gap the way that one is: it is guaranteed accurate,
   *  since it's the literal value this same call just wrote. */
  private async setStandupContentViaSdk(sdk: GateSdkClientLike, standupId: string, text: string): Promise<CreatedStandup> {
    const content = plainTextToTipTapDoc(text);
    const updated = await sdk.documents.update(standupId, { content });
    return { ...updated, content };
  }

  async applyIssueTransition(token: string, issueId: string, toState: string): Promise<void> {
    const factory = this.sdkClientFactory;
    if (factory) {
      await this.applyIssueTransitionViaSdk(factory(token), issueId, toState);
      return;
    }
    await this.applyIssueTransitionViaInternal(token, issueId, toState);
  }

  private async applyIssueTransitionViaInternal(token: string, issueId: string, toState: string): Promise<void> {
    await this.writeJson<unknown>('PATCH', `${this.base}/api/issues/${issueId}`, token, { state: toState });
  }

  /** `PATCH /api/v1/issues/:id` (`issues:write` scope), `state` only —
   *  see `platform/api/v1/resources/issues.ts`'s `UpdateIssueRequestSchema`
   *  doc comment for the disclosed narrower-than-internal scope (no
   *  title/priority/assignee_id/belongs_to, no "incomplete children" gate)
   *  — irrelevant to this caller, which only ever sends `state`. */
  private async applyIssueTransitionViaSdk(sdk: GateSdkClientLike, issueId: string, toState: string): Promise<void> {
    await sdk.issues.update(issueId, { state: assertSdkIssueState(toState) });
  }
}
