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
 * (`for await (const x of client.documents.iterate())`) is PF-402, a
 * separate ticket — this shape is exactly what that ticket needs to build
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

/** `POST /api/v1/documents` request body — mirrors
 *  `CreateDocumentRequestSchema` (`resources/documents.ts`). `title` is
 *  required at this public surface (no "Untitled" default here — that's the
 *  internal API's own behavior, per that schema's own doc comment). */
export interface CreateDocumentBody {
  readonly title: string;
  readonly document_type?: DocumentType;
  readonly properties?: Record<string, unknown>;
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
 *  server-side, unlike `documents`'s list). */
export interface ListIssuesParams {
  readonly limit?: number;
  readonly cursor?: string;
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
