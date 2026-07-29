/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * ContextTreeNav declared `role="tree"` / `role="treeitem"` without any of the
 * keyboard model that role requires (no roving `tabIndex`, no `onKeyDown`, no
 * `aria-level`/`aria-setsize`/`aria-posinset`). The fix keeps the native
 * `<ul>`/`<li>`/`<a>` structure and drops the ARIA.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useDocumentContextQuery', () => ({
  useDocumentContextQuery: () => ({
    data: {
      current: { id: 'c1', title: 'API Reference', document_type: 'wiki' },
      ancestors: [
        { id: 'a1', title: 'Project Overview', document_type: 'project' },
      ],
      children: [
        { id: 'ch1', title: 'Auth Endpoints', document_type: 'wiki', child_count: 0 },
        { id: 'ch2', title: 'Rate Limits', document_type: 'wiki', child_count: 2 },
      ],
      belongs_to: [],
      breadcrumbs: [],
    },
    isLoading: false,
    error: null,
  }),
}));

// Imported after the mock so the component picks up the stubbed query.
import { ContextTreeNav } from './ContextTreeNav';

function renderNav() {
  return render(
    <MemoryRouter>
      <ContextTreeNav documentId="c1" documentType="wiki" />
    </MemoryRouter>
  );
}

describe('ContextTreeNav — native list semantics (A11Y-1 / TRO-215)', () => {
  it('exposes the context navigation as a list, not a tree', () => {
    renderNav();

    const list = screen.getByRole('list', { name: 'Document context' });
    // 1 ancestor + current document + 2 children
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });

  it('resolves each entry title as the accessible name of a link', () => {
    renderNav();

    const list = screen.getByRole('list', { name: 'Document context' });
    expect(within(list).getByRole('link', { name: /Project Overview/ })).toHaveAttribute(
      'href',
      '/projects/a1'
    );
    expect(within(list).getByRole('link', { name: /Auth Endpoints/ })).toHaveAttribute(
      'href',
      '/docs/ch1'
    );
  });

  it('declares no tree or treeitem roles', () => {
    renderNav();

    expect(screen.queryAllByRole('tree')).toHaveLength(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('keeps aria-current on the current document entry', () => {
    renderNav();

    const list = screen.getByRole('list', { name: 'Document context' });
    const current = within(list)
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('aria-current') === 'page');
    expect(current).toBeDefined();
    expect(current).toHaveTextContent('API Reference');
  });

  it('preserves the data-testid hook the rest of the suite relies on', () => {
    renderNav();
    expect(screen.getByTestId('context-tree-nav')).toBeInTheDocument();
  });
});
