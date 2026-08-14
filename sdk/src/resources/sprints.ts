/**
 * `sprints` resource client (PF-401, PLUGFORGE.MD §2.8) — over
 * `/api/v1/sprints` (PF-201, `api/src/platform/api/v1/resources/sprints.ts`).
 *
 * UPDATE — PF-205 (Linear TRO-414): `GET /api/v1/sprints/:id` (with
 * sprint_number/owner_id/status/cadence week-dates) now exists — added
 * below as `get()`. The header note this replaces (`list()` only, no `:id`
 * route) was true when PF-201 wrote it and is no longer true; left as
 * history in this ticket's own report rather than silently dropped.
 *
 * `iterate()` (PF-402) — async-iterator pagination over `list()`'s cursor,
 * same shared `iteratePages` helper `DocumentsClient`/`IssuesClient` use
 * (`resources/documents.ts`'s own header has the fuller mechanics writeup).
 */
import { iteratePages } from '../internal/pagination.js';
import type { RequestClient } from '../internal/requestClient.js';
import type { IterateSprintsParams, ListSprintsParams, Sprint, SprintDetail, SprintList } from '../types.js';

const BASE_PATH = '/api/v1/sprints';

export class SprintsClient {
  constructor(private readonly request: RequestClient) {}

  /**
   * `GET /api/v1/sprints` — one page. Deliberately un-typed beyond the
   * generic `{id, title, document_type, properties, created_at,
   * updated_at}` envelope (no field-lifting the way `issues.list()` has for
   * state/priority) — matches `serializeSprint()`'s own server-side scope
   * (`resources/sprints.ts`'s header comment).
   */
  async list(params: ListSprintsParams = {}): Promise<SprintList> {
    return this.request.get<SprintList>(BASE_PATH, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** `iterate()` (PF-402) — `for await (const sprint of client.sprints.iterate())`.
   *  Same params as `list()` minus `cursor`; see `DocumentsClient.iterate()`'s
   *  doc comment for the shared mechanics. */
  iterate(params: IterateSprintsParams = {}): AsyncGenerator<Sprint, void, undefined> {
    return iteratePages<Sprint>((cursor) => this.list({ ...params, cursor }));
  }

  /**
   * `GET /api/v1/sprints/:id` (PF-205, Linear TRO-414). A malformed or
   * non-existent `id` both produce a `not_found` `ShipSdkError` — matching
   * `resources/sprints.ts`'s own `GET /:id` handler, which follows
   * `documents.ts`'s identical AC-4 convention.
   */
  async get(id: string): Promise<SprintDetail> {
    return this.request.get<SprintDetail>(`${BASE_PATH}/${encodeURIComponent(id)}`);
  }
}
