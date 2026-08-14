/**
 * `issues` resource client (PF-401, PLUGFORGE.MD §2.8) — over
 * `/api/v1/issues` (PF-201, `api/src/platform/api/v1/resources/issues.ts`).
 *
 * `list()` only. **Deliberately no `get(id)` or `create(body)`** —
 * `resources/issues.ts` (194 lines, read in full) and its OpenAPI
 * registration (`platform/openapi/schemas/issues.ts`, read in full) were
 * both checked before writing this file: the server registers exactly one
 * route, `GET /api/v1/issues`. There is no `GET /api/v1/issues/:id` and no
 * `POST /api/v1/issues` today — PLUGFORGE.MD §2.9's own PF-201 AC is "issues
 * expose typed state/priority; sprints list," not create/get for either.
 * Adding client methods for routes that don't exist would be a call this
 * SDK could never complete successfully. When those routes land, adding
 * `get`/`create` here is additive — a new method, not a signature change to
 * this ticket's `list()`.
 */
import type { RequestClient } from '../internal/requestClient.js';
import type { IssueList, ListIssuesParams } from '../types.js';

const BASE_PATH = '/api/v1/issues';

export class IssuesClient {
  constructor(private readonly request: RequestClient) {}

  /**
   * `GET /api/v1/issues` — one page. `state`/`priority`/`assignee_id` are
   * already lifted to top-level typed fields by the server (no raw
   * `properties` blob on this response, unlike `documents`/`sprints`).
   */
  async list(params: ListIssuesParams = {}): Promise<IssueList> {
    return this.request.get<IssueList>(BASE_PATH, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }
}
