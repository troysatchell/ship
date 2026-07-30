import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Combobox } from './Combobox';

// cmdk (the Command palette this popover renders) measures its list via
// ResizeObserver, which jsdom does not implement. This is an environment
// shim, not a stub of the component under test — the real Popover.Content
// and Command still render and are queried through the accessibility tree
// below. Same pattern as EmojiPicker.test.tsx's IntersectionObserver shim.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // cmdk also calls scrollIntoView on the active item, which jsdom doesn't
  // implement either.
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * TRO-218 / A11Y-4 — axe's "issues menu open" scan on /issues reported a
 * Serious `aria-dialog-name` violation: `<div ... role="dialog" ...
 * class="z-50 w-[var(--radix-...">` (audit/a11y/axe/issues_menu_expanded_state.json).
 * That `role="dialog"` is Radix's default for `Popover.Content`
 * (`@radix-ui/react-popover` dist/index.mjs:243) — this component renders it
 * with no `aria-label`/`aria-labelledby`, so it opens unnamed.
 *
 * `Combobox` is the shared wrapper: IssuesList's program/project/sprint
 * filters, DocumentListToolbar's sort dropdown (used on /issues, /projects,
 * /programs, /documents), IssueSidebar's assignee/week pickers, and
 * WeekSidebar's owner picker all render through this one component. Naming
 * the popover here clears the violation on every one of those surfaces at
 * once rather than patching each call site.
 */
describe('Combobox popover (TRO-218 / A11Y-4)', () => {
  it('gives the open popover dialog an accessible name', () => {
    render(
      <Combobox
        options={[{ value: 'a', label: 'Alpha' }]}
        value={null}
        onChange={vi.fn()}
        aria-label="Filter issues by program"
      />
    );

    fireEvent.click(screen.getByRole('combobox'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName();
  });

  it('falls back to the placeholder text when no aria-label is provided', () => {
    render(
      <Combobox
        options={[{ value: 'a', label: 'Alpha' }]}
        value={null}
        onChange={vi.fn()}
        placeholder="Sort by"
      />
    );

    fireEvent.click(screen.getByRole('combobox'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Sort by');
  });
});
