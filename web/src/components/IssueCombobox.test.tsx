/**
 * Regression test for a CodeRabbit finding on PR #120 (TRO-334 / FG-16
 * follow-up): the `Command.Input` (the issue-search box rendered once the
 * "Add issue…" trigger is opened) had no accessible name — a screen-reader
 * user tabbing into it would hear nothing describing what to type.
 *
 * Note on the fix shape: setting `aria-label` directly on `Command.Input`
 * does NOT work, verified by reading cmdk's own source
 * (node_modules/cmdk/dist/index.mjs) and confirming empirically before
 * writing this test. `CommandInput` unconditionally sets
 * `aria-labelledby={<the Command root's own hidden label id>}` AFTER
 * spreading the caller's props, so any `aria-label` passed on `Command.Input`
 * itself is always shadowed by an `aria-labelledby` pointing at a
 * `position:absolute; clip:rect(0,0,0,0)` `<label>` — and per the accname
 * spec, `aria-labelledby` wins over `aria-label` even when what it points to
 * is present but empty, which is exactly what happens if that hidden
 * `<label>` has no content. cmdk's own supported mechanism for naming
 * `Command.Input` is the `label` prop on the `Command` root, which becomes
 * that hidden `<label>` element's text content — that's what
 * `IssueCombobox.tsx` now sets, and it renders with `role="combobox"` (not
 * `"textbox"` — also confirmed by reading cmdk's source; `CommandInput` sets
 * `role: "combobox"` explicitly), which is why the query below asks for that
 * role rather than `textbox`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { IssueCombobox } from './IssueCombobox';

// jsdom implements neither ResizeObserver nor Element.scrollIntoView, both
// used internally by cmdk — same shim as IssueBlockingSection.test.tsx /
// Combobox.test.tsx / CommandPalette.test.tsx.
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

async function openCombobox() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /add issue/i }));
  });
}

describe('IssueCombobox — search input accessible name (CodeRabbit review, PR #120)', () => {
  it('gives the search input an accessible name via getByRole so a screen reader announces what to type', async () => {
    render(
      <IssueCombobox
        options={[{ id: 'issue-1', title: 'Issue One', displayId: 'AUTH-1' }]}
        onSelect={() => {}}
        aria-label="Add issue this blocks"
      />
    );

    await openCombobox();

    // cmdk's CommandInput renders role="combobox", not "textbox" — verified
    // by reading cmdk's source before writing this assertion.
    const input = screen.getByRole('combobox', { name: /search issues/i });
    expect(input.tagName).toBe('INPUT');
  });

  it('lets the accessibly-named input actually filter the option list, so the name and the widget are the same element', async () => {
    render(
      <IssueCombobox
        options={[
          { id: 'issue-1', title: 'Issue One', displayId: 'AUTH-1' },
          { id: 'issue-2', title: 'Issue Two', displayId: 'AUTH-2' },
        ]}
        onSelect={() => {}}
        aria-label="Add issue this blocks"
      />
    );

    await openCombobox();

    const input = screen.getByRole('combobox', { name: /search issues/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'AUTH-2' } });
    });

    expect(await screen.findByRole('option', { name: /issue two/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /issue one/i })).not.toBeInTheDocument();
  });
});
