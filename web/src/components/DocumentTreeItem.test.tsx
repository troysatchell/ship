/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * The shared DocumentTreeItem (rendered by the /docs tree view) carried
 * `role="treeitem"`, `aria-expanded` and `aria-selected` on its `<li>` with no
 * `tabIndex` and no `onKeyDown` anywhere in the file — an unfocusable treeitem
 * inside a tree with no keyboard model. The fix keeps native list semantics.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { DocumentTreeItem } from './DocumentTreeItem';
import type { DocumentTreeNode } from '@/lib/documentTree';

function node(
  overrides: Partial<DocumentTreeNode> & { id: string; title: string }
): DocumentTreeNode {
  return {
    document_type: 'wiki',
    parent_id: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    visibility: 'workspace',
    children: [],
    ...overrides,
  };
}

const PARENT = node({
  id: 'w1',
  title: 'Project Overview',
  children: [node({ id: 'w2', title: 'API Reference', parent_id: 'w1' })],
});

function renderItem(doc: DocumentTreeNode = PARENT, activeDocumentId?: string) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        {/* Mirrors the production container in Documents.tsx */}
        <ul aria-label="Documents">
          <DocumentTreeItem
            document={doc}
            activeDocumentId={activeDocumentId}
            onCreateChild={vi.fn()}
            onDelete={vi.fn()}
          />
        </ul>
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('DocumentTreeItem — native list semantics (A11Y-1 / TRO-215)', () => {
  it('renders as a list item, not a treeitem', () => {
    renderItem();

    const list = screen.getByRole('list', { name: 'Documents' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('resolves the document title as the accessible name of a link', () => {
    renderItem();

    expect(screen.getByRole('link', { name: 'Project Overview' })).toHaveAttribute(
      'href',
      '/documents/w1'
    );
  });

  it('carries aria-expanded on the disclosure button rather than the list item', () => {
    renderItem();

    const expand = screen.getByRole('button', { name: 'Expand', expanded: false });
    const item = expand.closest('li');
    expect(item).not.toBeNull();
    expect(item).not.toHaveAttribute('aria-expanded');
    expect(item).not.toHaveAttribute('aria-selected');

    fireEvent.click(expand);

    expect(screen.getByRole('button', { name: 'Collapse', expanded: true })).toBeInTheDocument();
    // Children now render in a plain nested list.
    const child = screen.getByRole('link', { name: 'API Reference' });
    const nested = child.closest('ul');
    expect(nested).not.toBeNull();
    expect(nested).not.toHaveAttribute('role');
  });

  it('marks the active document with aria-current instead of aria-selected', () => {
    renderItem(PARENT, 'w1');

    expect(screen.getByRole('link', { name: 'Project Overview' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('preserves the data-testid hooks the rest of the suite relies on', () => {
    renderItem();

    expect(screen.getByTestId('doc-item')).toBeInTheDocument();
    expect(screen.getByTestId('delete-document-button')).toBeInTheDocument();
  });
});
