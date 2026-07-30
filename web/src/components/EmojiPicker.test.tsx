import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { staticValueImports } from '@/test/sourceImports';
import { EmojiPickerPopover } from './EmojiPicker';

const here = dirname(fileURLToPath(import.meta.url));

// emoji-picker-react lazy-renders its emoji grid through IntersectionObserver,
// which jsdom does not implement. This is an environment shim, not a stub of
// the component under test — the real picker still renders and is queried
// through the accessibility tree below.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      root = null;
      rootMargin = '';
      thresholds: number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
});

/**
 * TRO-200 / BUN-4 — `emoji-picker-react` (186.4 kB raw / 39.1 kB gzip in the
 * entry chunk; 63.5 kB gzip once emitted on its own) was statically imported
 * by EmojiPicker.tsx and therefore downloaded on every page load, including
 * /login, to serve exactly one consumer: the project-icon PropertyRow in
 * ProjectSidebar.
 *
 * The fix moves the widget behind `React.lazy`. What that can break is the
 * interaction, not the bytes — the picker now arrives a tick after the click
 * instead of being already mounted. These are regression guards for that
 * interaction; they were *not* red before the fix, because the behaviour is
 * supposed to be unchanged. That is what they are for.
 */
describe('EmojiPickerPopover (TRO-200 / BUN-4)', () => {
  const openPicker = async () => {
    fireEvent.click(screen.getAllByRole('button')[0]);
    // findBy* waits out the dynamic import. If the lazy chunk never resolves,
    // or the module stops having a usable default export, this is where it
    // shows up.
    return screen.findByPlaceholderText('Search emoji...', undefined, { timeout: 10000 });
  };

  it('does not mount the picker until the trigger is clicked', () => {
    render(
      <EmojiPickerPopover value={null} onChange={vi.fn()}>
        <span>P</span>
      </EmojiPickerPopover>
    );
    expect(screen.queryByPlaceholderText('Search emoji...')).not.toBeInTheDocument();
    // Nor the Suspense fallback — the boundary is inside the open branch.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('opens the real picker on click', async () => {
    render(
      <EmojiPickerPopover value={null} onChange={vi.fn()}>
        <span>P</span>
      </EmojiPickerPopover>
    );
    expect(await openPicker()).toBeInTheDocument();
  });

  it('closes on Escape and keeps the trigger usable', async () => {
    render(
      <EmojiPickerPopover value={null} onChange={vi.fn()}>
        <span>P</span>
      </EmojiPickerPopover>
    );
    await openPicker();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Search emoji...')).not.toBeInTheDocument()
    );
    expect(screen.getAllByRole('button')[0]).toBeInTheDocument();
  });

  it('offers "Remove emoji" only when one is set, and clears through onChange', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EmojiPickerPopover value={null} onChange={onChange}>
        <span>P</span>
      </EmojiPickerPopover>
    );

    await openPicker();
    expect(screen.queryByRole('button', { name: /remove emoji/i })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    rerender(
      <EmojiPickerPopover value="🚢" onChange={onChange}>
        <span>🚢</span>
      </EmojiPickerPopover>
    );

    await openPicker();
    fireEvent.click(await screen.findByRole('button', { name: /remove emoji/i }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('keeps the package import out of EmojiPicker.tsx so the split boundary survives', () => {
    // The boundary is created by *where the import lives*. Naming
    // emoji-picker-react at value level in this module — for a `Theme` enum,
    // say — pulls all 186 kB back into the parent chunk while the
    // `React.lazy` call still looks correct.
    //
    // Detection is in src/test/sourceImports.ts, tested against every import
    // form. The regex previously inlined here only matched a single-quoted,
    // line-initial import, so a double-quoted or multi-line one would have
    // passed this guard with the bundle regression in place.
    const src = readFileSync(resolve(here, 'EmojiPicker.tsx'), 'utf8');
    expect(staticValueImports(src)).not.toContain('emoji-picker-react');
    expect(src).toContain("lazy(() => import('./EmojiPickerBody'))");

    // The body module is where it is allowed to live, and must.
    const body = readFileSync(resolve(here, 'EmojiPickerBody.tsx'), 'utf8');
    expect(staticValueImports(body)).toContain('emoji-picker-react');

    // And the fallback is sized to the picker (300x350) so the popover does
    // not resize under the cursor when the chunk lands.
    expect(src).toContain('height: 350');
    expect(src).toContain('width: 300');
  });
});
