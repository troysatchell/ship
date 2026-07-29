/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * ProjectContextSidebar declared two `role="tree"` lists with `role="treeitem"`
 * children and `role="group"` sublists, but implemented none of the tree
 * keyboard model. It also nested bare `<li>` elements inside `role="group"`,
 * which strips them of list semantics (axe Serious `listitem`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn(async (path: string) => {
  if (path.startsWith('/api/documents/')) {
    return {
      ok: true,
      json: async () => ({ id: 'proj1', title: 'Ship Rebuild', color: '#6366f1' }),
    } as unknown as Response;
  }
  if (path.startsWith('/api/weekly-plans/project-allocation-grid/')) {
    return {
      ok: true,
      json: async () => ({
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
        ],
        weeks: [3],
      }),
    } as unknown as Response;
  }
  return { ok: true, json: async () => [] } as unknown as Response;
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

  it('keeps the weekly docs section reachable as a list', async () => {
    await renderSidebar();

    const person = screen.getByRole('button', { name: /Ada Lovelace/ });
    const item = person.closest('li');
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).getByText('Ada Lovelace')).toBeInTheDocument();
  });
});
