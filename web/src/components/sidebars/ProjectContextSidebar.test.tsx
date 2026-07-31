/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * ProjectContextSidebar declared two `role="tree"` lists with `role="treeitem"`
 * children and `role="group"` sublists, but implemented none of the tree
 * keyboard model. It also nested bare `<li>` elements inside `role="group"`,
 * which strips them of list semantics (axe Serious `listitem`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Real Response instances rather than object literals cast to Response.
// Audit finding TS-8 is precisely that `as any`-shaped mocks decouple a test
// from the contract it claims to verify — a hand-rolled stub cannot drift out
// of sync with the real thing if it IS the real thing.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PROJECT = { id: 'proj1', title: 'Ship Rebuild', color: '#6366f1' };

const ALLOCATION_GRID = {
  project: { id: 'proj1', title: 'Ship Rebuild' },
  people: [
    {
      id: 'person1',
      name: 'Ada Lovelace',
      weeks: [
        {
          week_number: 3,
          plan: { id: 'plan1', status: 'done' },
          retro: { id: 'retro1', status: 'due' },
        },
      ],
    },
    // A person with no weeks: nothing to expand.
    { id: 'person2', name: 'Grace Hopper', weeks: [] },
  ],
  weeks: [3],
};

const apiGet = vi.fn(async (path: string): Promise<Response> => {
  if (path.startsWith('/api/documents/')) {
    return jsonResponse(PROJECT);
  }
  if (path.startsWith('/api/weekly-plans/project-allocation-grid/')) {
    return jsonResponse(ALLOCATION_GRID);
  }
  return jsonResponse([]);
});

vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => apiGet(path),
}));

// Imported after the mock so the component's queries hit the stub.
import { ProjectContextSidebar } from './ProjectContextSidebar';

async function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ProjectContextSidebar projectId="proj1" />
      </QueryClientProvider>
    </MemoryRouter>
  );
  await screen.findByTestId('project-context-sidebar');
  return result;
}

describe('ProjectContextSidebar — native list semantics (A11Y-1 / TRO-215)', () => {
  beforeEach(() => {
    apiGet.mockClear();
  });

  it('declares no tree, treeitem or group roles', async () => {
    await renderSidebar();

    expect(screen.queryAllByRole('tree')).toHaveLength(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    // role="group" on the sublists also stripped their <li> children of list
    // semantics; the sublists are plain nested <ul> now.
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('exposes the project tabs as real list items', async () => {
    await renderSidebar();

    // Project root is expanded by default, so the four tabs are visible.
    const lists = screen.getAllByRole('list');
    expect(lists.length).toBeGreaterThan(0);

    for (const label of ['Details', 'Weeks', 'Issues', 'Retro']) {
      const link = screen.getByRole('link', { name: label });
      expect(link.closest('li')).toBeInTheDocument();
    }
  });

  it('carries aria-expanded on the disclosure buttons, not the list items', async () => {
    await renderSidebar();

    const projectToggle = screen.getByRole('button', { name: /Ship Rebuild/ });
    expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
    expect(projectToggle.closest('li')).not.toHaveAttribute('aria-expanded');

    const personToggle = screen.getByRole('button', { name: /Ada Lovelace/ });
    expect(personToggle).toHaveAttribute('aria-expanded', 'false');
    expect(personToggle.closest('li')).not.toHaveAttribute('aria-expanded');
  });

  // A person with no weeks has no collapsible content. aria-expanded on a
  // control that discloses nothing is a false promise, and a focusable button
  // whose click is a no-op is a phantom tab stop.
  it('renders a person with no weeks as plain text, not an empty disclosure', async () => {
    await renderSidebar();

    // Present and readable...
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    // ...but not a control, and carrying no expansion state.
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
    const row = screen.getByText('Grace Hopper').closest('li');
    if (row === null) {
      throw new Error('Expected the person row to be inside a list item');
    }
    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.querySelector('[aria-expanded]')).toBeNull();
  });

  it('keeps the weekly docs section reachable as a list', async () => {
    await renderSidebar();

    const person = screen.getByRole('button', { name: /Ada Lovelace/ });
    const item = person.closest('li');
    // Narrow rather than cast: `closest` is genuinely nullable, and an
    // unchecked assertion here would turn a structural regression into a
    // confusing "within(null)" crash instead of a clear failure.
    if (item === null) {
      throw new Error('Expected the person row to be inside a list item');
    }
    expect(within(item).getByText('Ada Lovelace')).toBeInTheDocument();
  });
});

/**
 * Regression tests for TRO-281 / audit finding A11Y-9.
 *
 * TRO-215 removed the `role="tree"` misuse in this file but left both
 * remaining lists with no accessible name at all — a naming gap axe does
 * not flag on a plain `<ul>`. Each list has a visible section heading right
 * next to it ("Weekly Docs", "Issues"); the fix wires that heading in via
 * `aria-labelledby` so the accessible name matches what's on screen.
 */
describe('ProjectContextSidebar — list accessible names (A11Y-9 / TRO-281)', () => {
  beforeEach(() => {
    apiGet.mockClear();
  });

  it('names the weekly docs list after its visible "Weekly Docs" heading', async () => {
    await renderSidebar();

    const list = screen.getByRole('list', { name: /weekly docs/i });
    expect(within(list).getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('names the issues list after its visible "Issues" toggle', async () => {
    await renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /^Issues$/i }));

    const list = await screen.findByRole('list', { name: /^Issues$/i });
    expect(list).toBeInTheDocument();
  });
});
