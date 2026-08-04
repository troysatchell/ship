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
}
