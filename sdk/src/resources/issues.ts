/**
 * `issues` resource client (PF-401, PLUGFORGE.MD §2.8) — over
 * `/api/v1/issues` (PF-201, `api/src/platform/api/v1/resources/issues.ts`).
 *
 * `list()`/`update()`. **Still deliberately no `get(id)` or `create(body)`**
 * — `resources/issues.ts` registers no `GET /:id` or `POST /` today
 * (PLUGFORGE.MD §2.9's own PF-201 AC is "issues expose typed state/
 * priority; sprints list," not create/get for either). Adding client
 * methods for routes that don't exist would be a call this SDK could never
 * complete successfully; when those routes land, adding `get`/`create` here
 * is additive.
 *
 * `update()` (PF-703, TRO-435) — `PATCH /api/v1/issues/:id`, `state` only.
 * Built for the agent gate's sdk-mode `applyIssueTransition` write; see
 * `UpdateIssueBody`'s own doc comment for the deliberate scope narrowing
 * (this is not a general-purpose issue-update method).
 *
 * `iterate()` (PF-402) — async-iterator pagination over `list()`'s cursor,
 * same shared `iteratePages` helper `DocumentsClient`/`SprintsClient` use
 * (`resources/documents.ts`'s own header has the fuller mechanics writeup).
 */
import { iteratePages } from '../internal/pagination.js';
import type { RequestClient } from '../internal/requestClient.js';
import type { IssueList, IterateIssuesParams, ListIssuesParams, Issue, UpdateIssueBody } from '../types.js';

const BASE_PATH = '/api/v1/issues';

export class IssuesClient {
  constructor(private readonly request: RequestClient) {}

  /**
   * `GET /api/v1/issues` — one page. `state`/`priority`/`assignee_id` are
   * already lifted to top-level typed fields by the server (no raw
   * `properties` blob on this response, unlike `documents`/`sprints`).
   *
   * `assignee_id` (PF-702, TRO-428) — forwarded as a query filter now; see
   * `ListIssuesParams`'s own doc comment for the gap this closes.
   */
  async list(params: ListIssuesParams = {}): Promise<IssueList> {
    return this.request.get<IssueList>(BASE_PATH, {
      limit: params.limit,
      cursor: params.cursor,
      assignee_id: params.assignee_id,
    });
  }

  /** `iterate()` (PF-402) — `for await (const issue of client.issues.iterate())`.
   *  Same params as `list()` minus `cursor`; see `DocumentsClient.iterate()`'s
   *  doc comment for the shared mechanics. */
  iterate(params: IterateIssuesParams = {}): AsyncGenerator<Issue, void, undefined> {
    return iteratePages<Issue>((cursor) => this.list({ ...params, cursor }));
  }

  /**
   * `PATCH /api/v1/issues/:id` (PF-703, TRO-435) — applies a `state`
   * transition. Built for the agent gate's sdk-mode `applyIssueTransition`
   * write (`agent/src/shipClient.ts`'s `GateShipClient`) — see
   * `UpdateIssueBody`'s own doc comment for the deliberate scope narrowing.
   */
  async update(id: string, body: UpdateIssueBody): Promise<Issue> {
    return this.request.patch<Issue>(`${BASE_PATH}/${encodeURIComponent(id)}`, body);
  }
}
