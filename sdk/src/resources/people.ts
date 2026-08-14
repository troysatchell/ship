/**
 * `people` resource client (PF-205, Linear TRO-414) — over
 * `/api/v1/people` (`api/src/platform/api/v1/resources/people.ts`), the
 * team directory as typed person-documents.
 *
 * `list()`/`iterate()` only — the server registers exactly one route,
 * `GET /api/v1/people` (verified by reading that file in full before
 * writing this one; no `:id`/`POST` exists). Same shape as
 * `IssuesClient`/`SprintsClient` (a single-route resource client), and the
 * same `iteratePages` helper every other list-capable client shares.
 */
import { iteratePages } from '../internal/pagination.js';
import type { RequestClient } from '../internal/requestClient.js';
import type { IteratePeopleParams, ListPeopleParams, Person, PersonList } from '../types.js';

const BASE_PATH = '/api/v1/people';

export class PeopleClient {
  constructor(private readonly request: RequestClient) {}

  /** `GET /api/v1/people` — one page. */
  async list(params: ListPeopleParams = {}): Promise<PersonList> {
    return this.request.get<PersonList>(BASE_PATH, {
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** `iterate()` — `for await (const person of client.people.iterate())`.
   *  Same params as `list()` minus `cursor`; see `DocumentsClient.iterate()`'s
   *  doc comment for the shared mechanics. */
  iterate(params: IteratePeopleParams = {}): AsyncGenerator<Person, void, undefined> {
    return iteratePages<Person>((cursor) => this.list({ ...params, cursor }));
  }
}
