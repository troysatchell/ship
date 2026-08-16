/**
 * Coverage for TEST-8 / TRO-230.
 *
 * `OrgChartPage` (`/team/org-chart`, wired in `web/src/main.tsx`) had zero test
 * coverage of any kind before this file: no `.test.tsx` anywhere under
 * `web/src` and no e2e spec referencing `org-chart`/`orgchart`.
 *
 * Scope note: TEST-8 also names `/dashboard` as zero-coverage. That half is
 * already closed — `web/src/pages/Dashboard.test.tsx` exists and TEST-1
 * (TRO-223) fixed the root `pnpm test` invocation that used to skip it, so
 * `pnpm --filter @ship/web test` already runs it today (confirmed: 7/7 pass).
 * This file's entire scope is `OrgChartPage`.
 *
 * Real `Response` instances, not object literals cast to `Response` — TS-8
 * is precisely that an `as any`-shaped mock can drift out of sync with the
 * contract it claims to verify.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const apiGet = vi.fn<(path: string) => Promise<Response>>();
const apiPatch = vi.fn<(path: string, body: object) => Promise<Response>>(async () =>
  jsonResponse({}),
);

vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => apiGet(path),
  apiPatch: (path: string, body: object) => apiPatch(path, body),
}));

const mockUseWorkspace = vi.fn();
vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspace: () => mockUseWorkspace(),
}));

// Imported after the mocks so the page's `apiGet`/`useWorkspace` calls hit the stubs.
import { OrgChartPage } from './OrgChartPage';

interface Person {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  role?: string | null;
  reportsTo?: string | null;
}

// Two roots plus one report, so the test exercises actual tree-building
// (buildTree/flattenTree), not just "a list of names rendered somewhere".
const PEOPLE: Person[] = [
  {
    id: 'p-ada',
    user_id: 'u-ada',
    name: 'Ada Lovelace',
    email: 'ada@ship.dev',
    role: 'Engineering Lead',
    reportsTo: null,
  },
  {
    id: 'p-bob',
    user_id: 'u-bob',
    name: 'Bob Chen',
    email: 'bob@ship.dev',
    role: 'Designer',
    reportsTo: null,
  },
  {
    id: 'p-grace',
    user_id: 'u-grace',
    name: 'Grace Hopper',
    email: 'grace@ship.dev',
    role: 'Senior Engineer',
    reportsTo: 'u-ada',
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <OrgChartPage />
    </MemoryRouter>,
  );
}

describe('OrgChartPage (TEST-8 / TRO-230)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPatch.mockClear();
    // Non-admin by default: keeps the DndContext branch out of scope for
    // these tests (drag-and-drop reordering is a separate concern from
    // "does the hierarchy render", and dnd-kit's pointer sensors are not
    // exercised here).
    mockUseWorkspace.mockReturnValue({ isWorkspaceAdmin: false });
  });

  it('shows a loading state before the fetch resolves, then renders the hierarchy', async () => {
    let resolveFetch: ((res: Response) => void) | undefined;
    apiGet.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    renderPage();

    // Synchronous initial render, before the in-flight fetch resolves.
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();

    if (!resolveFetch) throw new Error('Fetch resolver was not initialized');
    resolveFetch(jsonResponse(PEOPLE));

    const tree = await screen.findByRole('tree', { name: 'Organization chart' });
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('renders each person by accessible role/name, with the reporting hierarchy reflected in aria-level', async () => {
    apiGet.mockResolvedValueOnce(jsonResponse(PEOPLE));

    renderPage();

    const tree = await screen.findByRole('tree', { name: 'Organization chart' });

    // TRO-614: the tree renders collapsed on its first paint (`expandedIds`
    // starts empty) and only auto-expands in a SECOND useEffect once the
    // fetched data settles. `findByRole('tree', ...)` above can resolve on
    // that first, collapsed render — before React flushes the auto-expand
    // effect — so a synchronous query for a nested row can race it. Grace
    // is the deepest node under test, so awaiting her presence here proves
    // the auto-expand effect has already flushed before the rest of this
    // test's synchronous assertions run.
    const grace = await within(tree).findByRole('treeitem', { name: /Grace Hopper/ });

    const ada = within(tree).getByRole('treeitem', { name: /Ada Lovelace/ });
    const bob = within(tree).getByRole('treeitem', { name: /Bob Chen/ });

    // Roots render at depth 1 (aria-level is 1-based: depth 0 -> level 1).
    expect(ada).toHaveAttribute('aria-level', '1');
    expect(bob).toHaveAttribute('aria-level', '1');
    // Grace reports to Ada (matched via user_id, not the raw person id), so
    // she nests one level deeper. This is the actual tree-building logic
    // under test, not just "the name string appears in the document".
    expect(grace).toHaveAttribute('aria-level', '2');

    // aria-level alone proves depth, not which root Grace nests under — a
    // regression that attached her to Bob instead of Ada would still pass
    // the two checks above. OrgChartPage renders a FLAT <li> list (no DOM
    // nesting between parent/child rows), and flattenTree() is depth-first
    // pre-order: a node's children are spliced in immediately after it,
    // before the next sibling. So the real parent-child relation is provable
    // from row ORDER — Grace must appear directly after Ada, before Bob —
    // which a wrong-parent regression (Grace under Bob) would break.
    const names = within(tree)
      .getAllByRole('treeitem')
      .map((el) => el.textContent);
    const adaIndex = names.findIndex((t) => t?.includes('Ada Lovelace'));
    const bobIndex = names.findIndex((t) => t?.includes('Bob Chen'));
    const graceIndex = names.findIndex((t) => t?.includes('Grace Hopper'));
    expect(graceIndex).toBe(adaIndex + 1);
    expect(graceIndex).toBeLessThan(bobIndex);

    // Role and email are rendered content, not just present in the DOM tree.
    expect(within(ada).getByText('Engineering Lead')).toBeInTheDocument();
    expect(within(ada).getByText('ada@ship.dev')).toBeInTheDocument();

    // Header reflects the fetched count.
    expect(screen.getByText('3 people')).toBeInTheDocument();
  });

  it('shows the empty-hierarchy message when no people are returned', async () => {
    apiGet.mockResolvedValueOnce(jsonResponse([]));

    renderPage();

    expect(await screen.findByText('No reporting hierarchy configured')).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.getByText('0 people')).toBeInTheDocument();
  });

  it('degrades to the empty state instead of hanging or crashing when the fetch rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      apiGet.mockRejectedValueOnce(new Error('network offline'));

      renderPage();

      // Must not get stuck on the loading branch forever (the `finally` in
      // fetchPeople is what clears it on the error path, not just the happy path).
      expect(await screen.findByText('No reporting hierarchy configured')).toBeInTheDocument();
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('degrades to the empty state when the API responds but not with ok:true', async () => {
    apiGet.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, { status: 403 }));

    renderPage();

    expect(await screen.findByText('No reporting hierarchy configured')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });
});
