import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SelectableList } from './SelectableList';

interface TestItem {
  id: string;
  name: string;
}

const items: TestItem[] = [
  { id: '1', name: 'First' },
  { id: '2', name: 'Second' },
];

/**
 * TRO-222 / A11Y-8 — axe's "issues menu open" scan on /issues reported a
 * Minor `empty-table-header` violation: `<th class="w-10 px-2 py-2"
 * aria-label="Selection"></th>` (audit/a11y/axe/issues_menu_expanded_state.json).
 * The header already carries `aria-label="Selection"`, but axe's
 * `empty-table-header` rule checks only the `has-visible-text` alternative
 * (axe-core 4.11.1 `axe.js`: `id: 'empty-table-header', any:
 * ['has-visible-text']` — no `aria-label`/`aria-labelledby` fallback), and
 * that check walks the rendered subtree text
 * (`hasTextContentEvaluate`/`subtree_text_default`), which an `aria-label`
 * alone never populates. The `<th>` needs actual (visually-hidden) text
 * content, not just an ARIA attribute.
 */
describe('SelectableList selection column header (TRO-222 / A11Y-8)', () => {
  it('gives the selection column header discernible text for screen readers', () => {
    render(
      <SelectableList
        items={items}
        selectable
        columns={[{ key: 'name', label: 'Name' }]}
        renderRow={(item) => <span>{item.name}</span>}
      />
    );

    const headerRow = screen.getAllByRole('row')[0];
    if (!headerRow) throw new Error('expected a header row to render');
    const selectionHeader = headerRow.querySelector('th');
    if (!selectionHeader) throw new Error('expected the selection column <th> to render');

    // axe's empty-table-header rule only credits actual subtree text, not
    // aria-label — assert on textContent directly so the test fails for the
    // same reason axe does, not merely on the accessible name.
    expect(selectionHeader.textContent?.trim()).not.toBe('');
  });
});
