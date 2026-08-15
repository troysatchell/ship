/**
 * `@ship/sdk`'s wire-response types for `/api/v1` resources.
 *
 * `Me` mirrors `GET /api/v1/me`'s response body EXACTLY, field-for-field —
 * verified against the server's actual handler and its own doc comment
 * (`api/src/platform/api/v1/resources/me.ts`), not guessed from PLUGFORGE.MD's
 * prose alone. The nested shapes match `PrincipalApp`/`PrincipalUser`
 * (`api/src/platform/oauth/principal.ts`) as serialized by that handler.
 *
 * `user`/`app` are each independently nullable, NOT a two-way XOR — a CodeRabbit
 * review on this ticket (PR #TRO-405) proposed narrowing `Me` to a union of
 * exactly `{ user: MeUser; app: null }` | `{ user: null; app: MeApp }`.
 * Verified against `me.ts`'s own header comment before accepting or rejecting
 * that suggestion (this file's docstring itself used to claim "XOR", which was
 * the same error): there are THREE real shapes, not two — a personal-token
 * principal (`user` populated, `app` null), a Client-Credentials principal
 * (`user` null, `app` populated), AND an `authorization_code`-grant OAuth
 * principal, which has **both populated** (`app` always present for an OAuth
 * token; `user` present because that grant always has an acting user). The
 * suggested two-variant union would make that third, real, server-producible
 * shape a type error for every SDK consumer — rejected as a regression, not
 * applied. Both fields stay independently `T | null`.
 * `scopes` is always present, the token's actual granted scopes either way.
 */
export interface MeUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface MeApp {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly is_first_party: boolean;
}

export interface Me {
  readonly user: MeUser | null;
  readonly app: MeApp | null;
  readonly scopes: string[];
}

/**
 * The `{ data, next_cursor }` envelope every `/api/v1` list route returns —
 * `api/src/platform/api/v1/pagination.ts`'s keyset-cursor contract, shared
 * verbatim across `documents`/`issues`/`sprints` (and every future list
 * resource). `next_cursor` is `null` on the last page; otherwise it's an
 * opaque string to pass back as `?cursor=` — this SDK does not decode it
 * (`pagination.ts`'s own doc comment: "deliberately opaque to callers").
 * `list()` here returns one raw page; wrapping this in an async iterator
 * (`for await (const x of client.documents.iterate())`) is PF-402
 * (`internal/pagination.ts`'s `iteratePages` helper, shared by every
 * `iterate()` method below) — this shape is exactly what that ticket built
 * on, unchanged.
 */
export interface ListPage<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
}

/**
 * `schema.sql:100`'s `document_type` enum, verbatim — mirrors
 * `DocumentTypeSchema` in `api/src/platform/api/v1/resources/documents.ts`.
 * Duplicated here rather than imported from `@ship/shared` or `api/`:
 * `sdk/package.json` declares zero runtime dependencies and no workspace
 * dependency on either package (PLUGFORGE.MD §2.8: "Zero runtime
 * dependencies (native `fetch`)" — the <250 KB min+gz budget PF-405 checks
 * depends on that staying true), so every wire type this package exposes is
 * its own independently-verified copy of the server's real shape, not an
 * import of it.
 */
export type DocumentType =
  | 'wiki'
  | 'issue'
  | 'program'
  | 'project'
  | 'sprint'
  | 'person'
  | 'weekly_plan'
  | 'weekly_retro'
  | 'standup'
  | 'weekly_review';

/**
 * Matches `serializeDocument()`'s actual return shape
 * (`api/src/platform/api/v1/resources/documents.ts:108-117`) field-for-field
 * — verified by reading that function before writing this, not guessed from
 * PLUGFORGE.MD's prose. `properties` is always an object (defaulted to `{}`
 * server-side), never `null`.
 */
export interface Document {
  readonly id: string;
  readonly title: string;
  readonly document_type: DocumentType;
  readonly properties: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

export type DocumentList = ListPage<Document>;

/** `GET /api/v1/documents` query params — mirrors `ListDocumentsQuerySchema`
 *  (`resources/documents.ts`): `limit` 1-100 (server defaults to 20 when
 *  omitted), opaque `cursor`, optional `type` filter. */
export interface ListDocumentsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly type?: DocumentType;
}

/** `documents.iterate()`'s params (PF-402) — everything `ListDocumentsParams`
 *  above has EXCEPT `cursor`: `iterate()` manages the cursor internally, so
 *  it is dropped from the type a caller can pass, not just left optional.
 *  Passing `cursor` in an object literal here is a compile-time excess-
 *  property error, matching the ticket's "cursors fully internal" AC at the
 *  type level, not only at runtime. */
export type IterateDocumentsParams = Omit<ListDocumentsParams, 'cursor'>;

/** `POST /api/v1/documents` request body — mirrors
 *  `CreateDocumentRequestSchema` (`resources/documents.ts`). `title` is
 *  required at this public surface (no "Untitled" default here — that's the
 *  internal API's own behavior, per that schema's own doc comment). */
export interface CreateDocumentBody {
  readonly title: string;
  readonly document_type?: DocumentType;
  readonly properties?: Record<string, unknown>;
}

/** `PATCH /api/v1/documents/:id` request body (PF-703, TRO-435) — mirrors
 *  `UpdateDocumentRequestSchema` (`resources/documents.ts`). Deliberately
 *  `content` only — see that schema's own doc comment for the scope
 *  narrowing (built for the agent gate's `setStandupContent` write, not a
 *  general-purpose document PATCH). */
export interface UpdateDocumentBody {
  readonly content: Record<string, unknown>;
}

/**
 * `shared/src/types/document.ts`'s `IssueState`/`IssuePriority` unions,
 * verbatim — same provenance `api/src/platform/api/v1/resources/issues.ts`'s
 * own header comment cites, and the same values
 * `platform/openapi/schemas/issues.ts`'s `IssueStateSchema`/
 * `IssuePrioritySchema` register. Duplicated here for the same
 * zero-dependency reason `DocumentType` above is.
 */
export type IssueState = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';

/** Matches `serializeIssue()`'s actual return shape
 *  (`api/src/platform/api/v1/resources/issues.ts:96-108`) field-for-field. */
export interface Issue {
  readonly id: string;
  readonly title: string;
  readonly document_type: 'issue';
  readonly state: IssueState;
  readonly priority: IssuePriority;
  readonly assignee_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type IssueList = ListPage<Issue>;

/** `GET /api/v1/issues` query params — mirrors `ListIssuesQuerySchema`
 *  (`resources/issues.ts`). No `type` filter here (fixed to `'issue'`
 *  server-side, unlike `documents`'s list).
 *
 *  `assignee_id` (PF-702, TRO-428) — the server (`ListIssuesQuerySchema`,
 *  `resources/issues.ts`) has accepted this query param since PF-205 landed
 *  it ("mirrors `getIssuesByAssignee()` -> internal `GET
 *  /api/issues?assignee_id=...`" — that file's own header comment), but this
 *  type and `IssuesClient.list()` never forwarded it — a real, confirmed gap
 *  found while wiring the agent's `getIssuesByAssignee` through this SDK
 *  (CHANGES.md, TRO-428), not a guess. A plain equality filter on a UUID —
 *  see `ListIssuesQuerySchema`'s own comment for why this deliberately does
 *  NOT replicate the internal route's `'null'`/`'unassigned'` sentinel
 *  strings. */
export interface ListIssuesParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly assignee_id?: string;
}

/** `issues.iterate()`'s params (PF-402) — same reasoning as
 *  `IterateDocumentsParams` above. */
export type IterateIssuesParams = Omit<ListIssuesParams, 'cursor'>;

/** `PATCH /api/v1/issues/:id` request body (PF-703, TRO-435) — mirrors
 *  `UpdateIssueRequestSchema` (`resources/issues.ts`). Deliberately `state`
 *  only — see that schema's own doc comment for the scope narrowing (built
 *  for the agent gate's `applyIssueTransition` write, not a general-purpose
 *  issue PATCH). */
export interface UpdateIssueBody {
  readonly state: IssueState;
}

/** Matches `serializeSprint()`'s actual return shape
 *  (`api/src/platform/api/v1/resources/sprints.ts:57-66`) field-for-field —
 *  structurally identical to `Document` (this resource is deliberately left
 *  un-typed beyond the generic envelope; see that file's own header for
 *  why), but kept as its own named type (`document_type: 'sprint'` fixed)
 *  rather than reusing `Document` — a `Sprint` and a `Document` are
 *  different resources at this SDK's surface even though their wire shapes
 *  currently coincide, and PF-402's `iterate()` needs a stable per-resource
 *  element type to be generic over. */
export interface Sprint {
  readonly id: string;
  readonly title: string;
  readonly document_type: 'sprint';
  readonly properties: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

export type SprintList = ListPage<Sprint>;

/** `GET /api/v1/sprints` query params — mirrors `ListSprintsQuerySchema`
 *  (`resources/sprints.ts`). */
export interface ListSprintsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/** `sprints.iterate()`'s params (PF-402) — same reasoning as
 *  `IterateDocumentsParams` above. */
export type IterateSprintsParams = Omit<ListSprintsParams, 'cursor'>;

// ─── PF-205 (Linear TRO-414) additions ─────────────────────────────────────
// The agent's remaining reads (agent/src/shipClient.ts:360-455), given typed
// SDK methods per PF-405's parity fitness test (sdk/src/__tests__/
// parity.test.ts) — every new /api/v1 operation needs a corresponding
// method, or that suite fails on this ticket's own diff.

/** Matches the server's GET /api/v1/sprints/{id} response
 *  (`api/src/platform/api/v1/resources/sprints.ts`'s `GET /:id` handler) —
 *  `Sprint`'s envelope plus the cadence/week-dates fields that route adds.
 *  `owner_id`/`status` are `null` when absent from `properties`; `start_date`/
 *  `end_date`/`workspace_sprint_start_date` are `YYYY-MM-DD` strings. */
export interface SprintDetail extends Sprint {
  readonly sprint_number: number;
  readonly owner_id: string | null;
  readonly status: string | null;
  readonly workspace_sprint_start_date: string;
  readonly start_date: string;
  readonly end_date: string;
}

/**
 * One forward/reverse association edge — matches
 * `platform/api/v1/resources/documents.ts`'s `/:id/associations` and
 * `/:id/reverse-associations` handlers' identical response shape
 * field-for-field. Deliberately has NO joined title/type field: the server
 * omits it too, on purpose (a visibility-leak avoidance — see that file's
 * own header comment).
 */
export interface AssociationEdge {
  readonly id: string;
  readonly document_id: string;
  readonly related_id: string;
  readonly relationship_type: string;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

export type AssociationEdgeList = ListPage<AssociationEdge>;

/** `GET /:id/associations` and `GET /:id/reverse-associations` query
 *  params — limit/cursor only, same shape as every other v1 list route. */
export interface ListAssociationsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A document that links to the anchor document — matches
 * `platform/api/v1/resources/documents.ts`'s `/:id/backlinks` handler's
 * response shape. `display_id` is `'#<ticket_number>'` for an issue source,
 * `null` for every other document type.
 */
export interface Backlink {
  readonly id: string;
  readonly document_type: DocumentType;
  readonly title: string;
  readonly display_id: string | null;
}

export type BacklinkList = ListPage<Backlink>;

export interface ListBacklinksParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A comment on a document — matches `platform/api/v1/resources/
 * documents.ts`'s `/:id/comments` handler's response shape. Named
 * `DocumentComment`, not `Comment`: this package's own convention names
 * every wire type after its resource (`Document`, `Issue`, `Sprint`), and a
 * bare `Comment` would read as belonging to a `comments` top-level resource
 * this SDK does not have (comments are only ever fetched scoped to a
 * document, matching the server's own route shape).
 */
export interface DocumentComment {
  readonly id: string;
  readonly document_id: string;
  readonly comment_id: string;
  readonly parent_id: string | null;
  readonly content: string;
  readonly resolved_at: string | null;
  readonly author: { readonly id: string; readonly name: string | null; readonly email: string | null } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type DocumentCommentList = ListPage<DocumentComment>;

export interface ListDocumentCommentsParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Matches `platform/api/v1/resources/people.ts`'s `serializePerson()`
 * return shape field-for-field. `name` (not `title`) — the server's own
 * deliberate naming for this resource, unlike `Document`/`Issue`/`Sprint`,
 * which all use `title`.
 */
export interface Person {
  readonly id: string;
  readonly name: string;
  readonly document_type: 'person';
  readonly user_id: string | null;
  readonly email: string | null;
  readonly is_archived: boolean;
  readonly is_pending: boolean;
  readonly reports_to: string | null;
  readonly role: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type PersonList = ListPage<Person>;

/** `GET /api/v1/people` query params — limit/cursor only. */
export interface ListPeopleParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/** `people.iterate()`'s params (PF-402-style) — same reasoning as
 *  `IterateDocumentsParams` above. */
export type IteratePeopleParams = Omit<ListPeopleParams, 'cursor'>;

/**
 * One entry in the public change feed — matches
 * `platform/api/v1/resources/changes.ts`'s three row shapes, tagged with
 * the `resource` discriminator that file's response actually returns (see
 * that file's header for why this is a merged, discriminated-union `data`
 * array rather than three parallel arrays). `history.id` is a plain
 * `number` (Postgres `document_history.id` is a SERIAL, not a UUID) —
 * every other resource's `id` in this package is a UUID string.
 */
export interface ChangedDocumentEntry {
  readonly resource: 'document';
  readonly dedupe_key: string;
  readonly id: string;
  readonly document_type: DocumentType;
  readonly title: string;
  readonly updated_at: string;
  readonly created_by: string | null;
}

export interface ChangedHistoryEntry {
  readonly resource: 'document_history';
  readonly dedupe_key: string;
  readonly id: number;
  readonly document_id: string;
  readonly field: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly changed_by: string | null;
  readonly automated_by: string | null;
  readonly created_at: string;
}

export interface ChangedCommentEntry {
  readonly resource: 'comment';
  readonly dedupe_key: string;
  readonly id: string;
  readonly document_id: string;
  readonly comment_id: string;
  readonly parent_id: string | null;
  readonly author_id: string | null;
  readonly content: string;
  readonly resolved_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type ChangeEntry = ChangedDocumentEntry | ChangedHistoryEntry | ChangedCommentEntry;

/**
 * `GET /api/v1/changes`'s response shape — NOT `ListPage<ChangeEntry>`,
 * despite also having a `data`/`next_cursor` pair: this resource's
 * `next_cursor` is an ISO 8601 timestamp to pass back as the next `since`
 * (cursor-lagged, per `resources/changes.ts`'s header), never an opaque
 * keyset cursor to pass back as `?cursor=` the way every other list
 * resource's `next_cursor` is — reusing `ListPage<T>` here would say the
 * two are interchangeable when they are not. `truncated` has no analogue on
 * any other resource: it names which of the three underlying categories hit
 * the per-poll limit, so a caller re-polling from the same `next_cursor`
 * knows the response's own `data` array may not be the whole gap.
 */
export interface ChangesPage {
  readonly data: readonly ChangeEntry[];
  readonly next_cursor: string;
  readonly truncated: {
    readonly documents: boolean;
    readonly document_history: boolean;
    readonly comments: boolean;
  };
}

/** `GET /api/v1/changes` query params — mirrors `GetChangesQuerySchema`
 *  (`resources/changes.ts`). `since` is REQUIRED (unlike every other list
 *  resource's optional `cursor`) — this endpoint has no "first page,
 *  omit the param" case; a caller always names a starting point. */
export interface GetChangesParams {
  readonly since: string;
  readonly limit?: number;
}
