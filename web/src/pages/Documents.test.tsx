/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * The /docs tree view wrapped DocumentTreeItem in `<ul role="tree">`. Once the
 * items stop declaring `role="treeitem"`, a leftover `role="tree"` here would be
 * a *new* axe Critical (`aria-required-children`: a tree with no treeitem
 * children), so the container and the items have to move together.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { WikiDocument } from '@/hooks/useDocumentsQuery';

const DOCUMENTS: WikiDocument[] = [
  {
    id: 'w1',
    title: 'Project Overview',
    document_type: 'wiki',
    parent_id: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    visibility: 'workspace',
  },
  {
    id: 'w2',
    title: 'API Reference',
    document_type: 'wiki',
    parent_id: null,
    position: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    visibility: 'workspace',
  },
];

vi.mock('@/contexts/DocumentsContext', () => ({
  useDocuments: () => ({
    documents: DOCUMENTS,
    loading: false,
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }),
}));

// Imported after the mock so the page picks up the stubbed context.
import { DocumentsPage } from './Documents';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <DocumentsPage />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('DocumentsPage tree view — native list semantics (A11Y-1 / TRO-215)', () => {
  beforeEach(() => {
    // useListFilters persists the view mode; tree is the page default.
    localStorage.setItem('documents-view-mode', 'tree');
  });

  it('exposes the document tree as a list, not a tree', () => {
    renderPage();

    const list = screen.getByRole('list', { name: 'Documents' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryAllByRole('tree')).toHaveLength(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('resolves each document title as the accessible name of a link', () => {
    renderPage();

    const list = screen.getByRole('list', { name: 'Documents' });
    expect(within(list).getByRole('link', { name: 'Project Overview' })).toHaveAttribute(
      'href',
      '/documents/w1'
    );
    expect(within(list).getByRole('link', { name: 'API Reference' })).toHaveAttribute(
      'href',
      '/documents/w2'
    );
  });
});
