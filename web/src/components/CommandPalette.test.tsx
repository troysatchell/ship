/**
 * TRO-175 / API-4 - the command palette re-downloaded the entire document
 * corpus on every ⌘K open.
 *
 * Root cause (confirmed by reading CommandPalette.tsx before the fix): the
 * document list lived in local `useState`, populated by a `useEffect` keyed
 * on `[open]` that called `apiGet('/api/documents')` directly - bypassing the
 * app's `queryClient` (staleTime 5 min / gcTime 24h) entirely. Every open was
 * a cold fetch, confirmed by the audit's browser trace showing exactly one
 * ~294 KB request per open.
 *
 * This test reproduces that: it renders the palette open, closes it, and
 * reopens it - all well inside the 5 minute staleTime window - and asserts
 * the document-list endpoint was hit exactly once. Run against the pre-fix
 * component (raw `apiGet` + `useState`), the second open issues a second
 * fetch and this test fails at the `expect(documentsFetchCount).toBe(1)`
 * after reopening. It drives the REAL app `queryClient` singleton (not a
 * fresh test client) so the assertion exercises the same staleTime production
 * uses, per the house pattern in
 * UnifiedDocumentPage.deletedFocusRefetch.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { TooltipProvider } from '@/components/ui/Tooltip';

// jsdom implements neither ResizeObserver nor Element.scrollIntoView, both of
// which cmdk uses internally (sizing the list, scrolling the active item
// into view) unrelated to anything this test asserts on. Stub them locally
// rather than touching the shared web/src/test/setup.ts, since CommandPalette
// is the first component under test that pulls in cmdk. Both are reverted in
// `afterAll` below so they don't leak into other test files run in the same
// worker.
const originalScrollIntoView = Element.prototype.scrollIntoView;
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollIntoView = vi.fn();

afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

let documentsFetchCount = 0;

interface SampleDocument {
  id: string;
  title: string;
  document_type: string;
  ticket_number: number | null;
}

const sampleDocuments: SampleDocument[] = [
  { id: 'issue-1', title: 'Fix the bug', document_type: 'issue', ticket_number: 7 },
  { id: 'wiki-1', title: 'Onboarding Guide', document_type: 'wiki', ticket_number: null },
];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

// Matches whichever endpoint the component under test actually calls: the
// pre-fix component hit the raw, unbounded `/api/documents` list; the fixed
// component hits `/api/search/documents` (routed through the search router,
// per TRO-175). Counting both keeps this test meaningful against either
// version - the thing under test is caching behavior across opens, not the
// specific URL.
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn((endpoint: string) => {
    if (endpoint === '/api/search/documents' || endpoint === '/api/documents') {
      documentsFetchCount++;
      return jsonResponse(sampleDocuments);
    }
    throw new Error(`Unmocked apiGet endpoint in test: ${endpoint}`);
  }),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

// Imported after the mock so the component picks up the stubbed network layer.
import { apiGet } from '@/lib/api';
import { CommandPalette } from './CommandPalette';

function paletteTree(open: boolean, onOpenChange: () => void = vi.fn()) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter>
          <CommandPalette open={open} onOpenChange={onOpenChange} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  documentsFetchCount = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  queryClient.removeQueries({ queryKey: ['command-palette-documents'] });
  vi.restoreAllMocks();
});

describe('TRO-175 / API-4: command palette document cache', () => {
  it('fetches the document list once on open, and issues zero additional requests on a second open within the cache window', async () => {
    const { rerender } = render(paletteTree(true));

    // Palette is open and showing documents from more than one type - the
    // "browse" view (no search text yet) must still work.
    expect(await screen.findByRole('option', { name: /onboarding guide/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /#7: fix the bug/i })).toBeInTheDocument();
    expect(documentsFetchCount).toBe(1);

    // Close the palette.
    rerender(paletteTree(false));

    // Reopen it - well within the 5 minute staleTime window. Before the fix
    // this re-ran the raw fetch unconditionally; after the fix, react-query
    // serves the cached list instead.
    rerender(paletteTree(true));

    expect(await screen.findByRole('option', { name: /onboarding guide/i })).toBeInTheDocument();
    expect(documentsFetchCount).toBe(1);
  });

  it('still filters the visible list by typed search text (client-side, no extra fetch)', async () => {
    render(paletteTree(true));

    await screen.findByRole('option', { name: /onboarding guide/i });
    expect(screen.getByRole('option', { name: /#7: fix the bug/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'onboarding' } });

    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /#7: fix the bug/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /onboarding guide/i })).toBeInTheDocument();
    // Typing filters the already-fetched list locally - it must not trigger
    // another network request.
    expect(documentsFetchCount).toBe(1);
  });

  // CodeRabbit review finding (TRO-175 / API-4): a failed fetch was
  // indistinguishable from a genuinely empty result - both rendered
  // "No results found." A 404 (not a 5xx) is used deliberately: it's a
  // permanent client error under this app's retry policy
  // (web/src/lib/queryClient.ts's shouldRetryRequest), so `isError` becomes
  // true after the first attempt instead of waiting through retry backoff.
  //
  // cmdk's <Command.Empty> only mounts when the *entire* registered item
  // count is zero - the static "Create"/"Navigate" commands always register,
  // so with no search text there's never an empty state to distinguish. A
  // non-matching search term is required to drive cmdk's own count to zero
  // and actually surface the message.
  it('shows a distinguishable error message when the fetch fails, not "No results found"', async () => {
    vi.mocked(apiGet).mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Failed to fetch documents' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    render(paletteTree(true));

    fireEvent.change(await screen.findByRole('combobox'), {
      target: { value: 'zzz-matches-nothing-zzz' },
    });

    expect(await screen.findByText(/failed to load documents/i)).toBeInTheDocument();
    expect(screen.queryByText(/no results found/i)).not.toBeInTheDocument();
  });
});
