/**
 * Regression tests for TRO-215 / audit finding A11Y-1.
 *
 * The workspace + private document sidebars declared `role="tree"` with
 * `role="treeitem"` children, but nothing implemented the tree keyboard
 * contract (no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`),
 * and the lists also contained bare `<li>` children (empty state, "N more...").
 * That produced axe Critical `aria-required-children` + Serious `listitem`.
 *
 * The fix is subtraction: keep the native `<ul>`/`<li>`/`<a>` structure and drop
 * the ARIA that promised a widget. These tests pin the native semantics so the
 * roles cannot be reintroduced without a keyboard model.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { WikiDocument } from '@/hooks/useDocumentsQuery';

vi.mock('@/contexts/DocumentsContext', () => ({
  useDocuments: () => ({
    documents: [],
    loading: false,
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }),
}));

// Imported after the mock so DocumentsTree picks up the stubbed context.
import { DocumentsTree } from './App';

function doc(overrides: Partial<WikiDocument> & { id: string; title: string }): WikiDocument {
  return {
    document_type: 'wiki',
    parent_id: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    visibility: 'workspace',
    ...overrides,
  };
}

function renderTree(documents: WikiDocument[], activeId?: string) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TooltipProvider>
          <DocumentsTree documents={documents} activeId={activeId} onSelect={() => {}} />
        </TooltipProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

const WORKSPACE_DOCS: WikiDocument[] = [
  doc({ id: 'w1', title: 'Project Overview', position: 0 }),
  doc({ id: 'w2', title: 'API Reference', parent_id: 'w1', position: 1 }),
  doc({ id: 'w3', title: 'Onboarding Guide', position: 2 }),
];

const PRIVATE_DOCS: WikiDocument[] = [
  doc({ id: 'p1', title: 'Personal Notes', visibility: 'private', position: 0 }),
];

describe('DocumentsTree — native list semantics (A11Y-1 / TRO-215)', () => {
  it('exposes the workspace sidebar as a list, not a tree', () => {
    renderTree(WORKSPACE_DOCS);

    const workspace = screen.getByRole('list', { name: 'Workspace documents' });
    expect(workspace).toBeInTheDocument();

    // Root-level documents are list items of that list.
    const items = within(workspace).getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves each document title as the accessible name of a link', () => {
    renderTree(WORKSPACE_DOCS);

    const workspace = screen.getByRole('list', { name: 'Workspace documents' });
    expect(
      within(workspace).getByRole('link', { name: 'Project Overview' })
    ).toHaveAttribute('href', '/documents/w1');
    expect(
      within(workspace).getByRole('link', { name: 'Onboarding Guide' })
    ).toHaveAttribute('href', '/documents/w3');
  });

  it('exposes the private sidebar as a list, not a tree', () => {
    renderTree([...WORKSPACE_DOCS, ...PRIVATE_DOCS]);

    const priv = screen.getByRole('list', { name: 'Private documents' });
    expect(
      within(priv).getByRole('link', { name: /Personal Notes/ })
    ).toHaveAttribute('href', '/documents/p1');
  });

  it('declares no tree or treeitem roles anywhere in the sidebar', () => {
    renderTree([...WORKSPACE_DOCS, ...PRIVATE_DOCS], 'w2');

    expect(screen.queryAllByRole('tree')).toHaveLength(0);
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('keeps nested children inside a real nested list', () => {
    // activeId is the child, which auto-expands its ancestor.
    renderTree(WORKSPACE_DOCS, 'w2');

    const child = screen.getByRole('link', { name: 'API Reference' });
    const nestedList = child.closest('ul');
    expect(nestedList).not.toBeNull();
    expect(nestedList).not.toHaveAttribute('role');
  });

  it('keeps aria-expanded on the expand/collapse button, not on the list item', () => {
    renderTree(WORKSPACE_DOCS, 'w2');

    // Auto-expanded because the active document is a descendant.
    const collapse = screen.getByRole('button', { name: 'Collapse', expanded: true });
    expect(collapse.tagName).toBe('BUTTON');

    // The <li> must not carry widget state.
    const item = collapse.closest('li');
    expect(item).not.toBeNull();
    expect(item).not.toHaveAttribute('aria-expanded');
    expect(item).not.toHaveAttribute('aria-selected');
  });

  // aria-live is deliberately RETAINED. It is the WCAG 4.1.3 announcement
  // mechanism for document create/delete and is asserted by
  // e2e/accessibility-remediation.spec.ts ("document tree updates are
  // announced"). Whether it is too verbose on expand/collapse is a question
  // only a human screen-reader pass can answer — see TRO-215 follow-up.
  it('keeps the polite live region that announces document create/delete', () => {
    renderTree([...WORKSPACE_DOCS, ...PRIVATE_DOCS]);

    expect(screen.getByRole('list', { name: 'Workspace documents' })).toHaveAttribute(
      'aria-live',
      'polite'
    );
    expect(screen.getByRole('list', { name: 'Private documents' })).toHaveAttribute(
      'aria-live',
      'polite'
    );
  });

  it('keeps the "N more..." overflow link inside a real list item', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      doc({ id: `m${i}`, title: `Doc ${i}`, position: i })
    );
    renderTree(many);

    const workspace = screen.getByRole('list', { name: 'Workspace documents' });
    // 10 documents shown + 1 overflow item.
    expect(within(workspace).getAllByRole('listitem')).toHaveLength(11);

    const more = within(workspace).getByRole('link', { name: '2 more...' });
    expect(more.closest('li')).toBeInTheDocument();
  });

  it('marks the active document with aria-current instead of aria-selected', () => {
    renderTree(WORKSPACE_DOCS, 'w3');

    expect(screen.getByRole('link', { name: 'Onboarding Guide' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('preserves the data-testid hooks the rest of the suite relies on', () => {
    renderTree(WORKSPACE_DOCS);

    expect(screen.getByTestId('document-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('doc-item').length).toBeGreaterThanOrEqual(2);
  });
});
