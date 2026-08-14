/**
 * `sprints` resource client (PF-401, PLUGFORGE.MD §2.8) — over
 * `/api/v1/sprints` (PF-201, `api/src/platform/api/v1/resources/sprints.ts`).
 *
 * `list()` only, same reasoning as `resources/issues.ts` (see that file's
 * header for the fuller rationale): `resources/sprints.ts` (145 lines, read
 * in full) and `platform/openapi/schemas/sprints.ts` (read in full) both
 * confirm the server registers exactly one route, `GET /api/v1/sprints`. No
 * `GET /api/v1/sprints/:id`, no `POST /api/v1/sprints` today.
 *
 * `iterate()` (PF-402) — async-iterator pagination over `list()`'s cursor,
 * same shared `iteratePages` helper `DocumentsClient`/`IssuesClient` use
 * (`resources/documents.ts`'s own header has the fuller mechanics writeup).
 */
import { iteratePages } from '../internal/pagination.js';
import type { RequestClient } from '../internal/requestClient.js';
import type { IterateSprintsParams, ListSprintsParams, Sprint, SprintList } from '../types.js';

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
}
