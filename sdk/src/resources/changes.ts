/**
 * `changes` resource client (PF-205, Linear TRO-414) — over
 * `/api/v1/changes` (`api/src/platform/api/v1/resources/changes.ts`), the
 * public, cursor-lagged change-feed contract.
 *
 * `list()` only — deliberately NO `iterate()`, unlike every other
 * list-capable client in this package. `iteratePages` (`internal/
 * pagination.ts`) assumes a `list({ cursor })` shape where an omitted
 * `cursor` means "first page" and a returned `next_cursor` is passed back
 * verbatim as the next call's `cursor` — this resource's query param is
 * `since`, REQUIRED on every call including the first, and its
 * `next_cursor` is an ISO 8601 timestamp meant to be passed back as the
 * NEXT `since`, not as a `cursor`. Wrapping that mismatch in the shared
 * generator would either silently rename a field (fragile) or need a
 * second, parallel pagination helper for one resource — not worth it for a
 * poll-style feed a caller is expected to call repeatedly with its own
 * stored `since` anyway, unlike a one-shot "walk everything" iterate().
 */
import type { RequestClient } from '../internal/requestClient.js';
import type { ChangesPage, GetChangesParams } from '../types.js';

const BASE_PATH = '/api/v1/changes';

export class ChangesClient {
  constructor(private readonly request: RequestClient) {}

  /**
   * `GET /api/v1/changes?since=&limit=` — one page. `since` is required;
   * pass the previous call's `next_cursor` on every subsequent poll. See
   * `ChangesPage`'s own doc comment for the cursor-lag mechanism.
   */
  async list(params: GetChangesParams): Promise<ChangesPage> {
    return this.request.get<ChangesPage>(BASE_PATH, {
      since: params.since,
      limit: params.limit,
    });
  }
}
