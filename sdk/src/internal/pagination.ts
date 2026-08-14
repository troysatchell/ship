/**
 * `iteratePages` — the shared async-generator core behind every list-capable
 * resource client's `iterate()` method (PF-402, PLUGFORGE.MD §2.8:
 * `for await (const doc of client.documents.iterate()) { ... }`).
 *
 * WHY ONE HELPER, NOT THREE COPIES: `DocumentsClient.iterate()`,
 * `IssuesClient.iterate()`, and `SprintsClient.iterate()` all wrap the exact
 * same shape — a `list()` method returning `Promise<ListPage<T>>` (`../types.js`'s
 * `{ data, next_cursor }` envelope, shared verbatim across every `/api/v1`
 * list route, `pagination.ts`'s own doc comment on the server side). The only
 * thing that differs per resource is which `list()` to call and with what
 * params — that's a one-line closure at each call site (see
 * `resources/documents.ts` etc.), not a reason to duplicate the generator
 * logic itself.
 *
 * CURSORS ARE FULLY INTERNAL: this generator yields individual items of type
 * `T`, never a page and never a `next_cursor` value. A caller consuming
 * `iterate()` has no way to observe a cursor — the opaque string only ever
 * exists inside this closure's `cursor` variable and the `fetchPage` calls it
 * drives. A caller who wants raw pages (and does want to see cursors) still
 * has the resource's own unchanged `list()`.
 *
 * LAZINESS IS THE HARDER HALF OF THE AC ("early-break doesn't overfetch"): a
 * naive pagination helper might prefetch page N+1 while the caller is still
 * consuming page N, so a `break` partway through page N still costs a wasted
 * request. This doesn't: `fetchPage` is called exactly once per iteration of
 * the `while` loop below, and the `for...of` over that page's `data` array
 * `yield`s one item at a time — execution suspends AT the `yield`, mid-array,
 * every time, and only resumes (and only reaches the next `fetchPage` call)
 * when the caller asks this generator for another item. A `for await` loop
 * that `break`s — or a caller who just stops calling `.next()` — never
 * resumes execution past its last consumed item, so the `while` loop's next
 * turn (and the fetch it would make) simply never runs. Proven directly by
 * counting real HTTP requests in
 * `resources/__tests__/iterate.test.ts` (early-break case), not just argued
 * about here.
 */
import type { ListPage } from '../types.js';

/**
 * `fetchPage(cursor)` — `cursor` is `undefined` for the first page (mirrors
 * every `list()` method's own `params.cursor?: string` — an omitted cursor
 * produces the exact same first-page request `list()` without a cursor
 * already makes, verified by `internal/requestClient.ts`'s `buildUrl`, which
 * drops `undefined` query values entirely) and the previous page's
 * `next_cursor` (a non-null string — that's the whole contract this function
 * closes over) for every page after that.
 */
export type FetchPage<T> = (cursor: string | undefined) => Promise<ListPage<T>>;

export async function* iteratePages<T>(fetchPage: FetchPage<T>): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;

  while (true) {
    const page = await fetchPage(cursor);

    for (const item of page.data) {
      yield item;
    }

    if (page.next_cursor === null) return;
    cursor = page.next_cursor;
  }
}
