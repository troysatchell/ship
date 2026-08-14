/**
 * `documents` resource client (PF-401, PLUGFORGE.MD §2.8) — `list`/`get`/
 * `create` over `/api/v1/documents`, the one resource with all three
 * verified server routes: `GET /`, `GET /:id`, `POST /` (PF-200,
 * `api/src/platform/api/v1/resources/documents.ts`, read in full before
 * writing this file — its exported `ListDocumentsQuerySchema`/
 * `CreateDocumentRequestSchema` and `serializeDocument()`'s actual return
 * shape are this file's and `../types.ts`'s source of truth, not
 * PLUGFORGE.MD's prose alone).
 *
 * `iterate()` (async-iterator pagination over `list()`'s cursor) is PF-402,
 * a separate ticket — `list()` here returns one raw `{ data, next_cursor }`
 * page, deliberately not wrapped, so PF-402 can add `iterate()` as a new
 * method without changing this one's signature or return type.
 */
import type { RequestClient } from '../internal/requestClient.js';
import type { CreateDocumentBody, Document, DocumentList, ListDocumentsParams } from '../types.js';

const BASE_PATH = '/api/v1/documents';

export class DocumentsClient {
  constructor(private readonly request: RequestClient) {}

  /**
   * `GET /api/v1/documents` — one page. `params` mirrors
   * `ListDocumentsQuerySchema` server-side: `limit` (1-100, server defaults
   * to 20 when omitted), opaque `cursor` from a previous page's
   * `next_cursor`, optional `type` filter.
   */
  async list(params: ListDocumentsParams = {}): Promise<DocumentList> {
    return this.request.get<DocumentList>(BASE_PATH, {
      limit: params.limit,
      cursor: params.cursor,
      type: params.type,
    });
  }

  /**
   * `GET /api/v1/documents/:id`. A malformed or non-existent `id` both
   * produce a `not_found` `ShipSdkError` — never `validation` — matching
   * the server's own documented AC-4 behavior (`resources/documents.ts`'s
   * header comment).
   */
  async get(id: string): Promise<Document> {
    return this.request.get<Document>(`${BASE_PATH}/${encodeURIComponent(id)}`);
  }

  /**
   * `POST /api/v1/documents`. `title` is required at this public surface —
   * a missing/empty `title` produces a `validation` `ShipSdkError` (no
   * "Untitled" default here, unlike the internal API — see
   * `CreateDocumentRequestSchema`'s own doc comment for why that's a
   * deliberate, distinct-from-internal decision).
   */
  async create(body: CreateDocumentBody): Promise<Document> {
    return this.request.post<Document>(BASE_PATH, body);
  }
}
