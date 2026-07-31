/**
 * TRO-290 / ERR-14 — reproduced, then fixed.
 *
 * The ticket's hypothesis: `UnifiedDocumentPage`'s top-level
 * `useQuery(['document', id])` doesn't override `refetchOnWindowFocus`, so
 * every query gets the default background refetch on window focus. If
 * another user deletes the document while this tab is open, that refetch
 * 404s - and the render used `if (error || !document)`, which trips on
 * `error` alone even though `document` (react-query's cached `data`) is
 * still the last good snapshot. That unmounts the editor and discards
 * whatever the user was mid-typing.
 *
 * REPRODUCED before the fix: this exact test, run against the pre-fix
 * `UnifiedDocumentPage.tsx`, found `editor-mounted` gone and "Document not
 * found" on screen after the focus-triggered 404 (`docCallCount` reaching 2).
 * See the PR description / CHANGES.md for the transcript.
 *
 * This drives the REAL app `queryClient` singleton (not a fresh test
 * client), so `staleTime` (5 min) and the default retry policy are exactly
 * what production uses. The query is marked stale via `invalidateQueries({
 * refetchType: 'none' })` - which does NOT itself trigger a refetch - so the
 * subsequent real `visibilitychange` event on `window` is what causes
 * react-query's own `focusManager` to decide to refetch, exactly as it would
 * in the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { useDocumentWriteStatus } from '@/hooks/useDocumentWriteStatus';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CurrentDocumentProvider } from '@/contexts/CurrentDocumentContext';

const DOC_ID = 'wiki-tro290';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }),
}));

let docCallCount = 0;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn((endpoint: string) => {
    if (endpoint === `/api/documents/${DOC_ID}`) {
      docCallCount++;
      if (docCallCount === 1) {
        return jsonResponse({
          id: DOC_ID,
          title: 'Untitled',
          document_type: 'wiki',
          properties: {},
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          created_by: 'user-1',
          belongs_to: [],
        });
      }
      // Second call = the focus-triggered refetch: another user deleted it.
      return jsonResponse({ error: 'Not found' }, 404);
    }
    if (endpoint === '/api/team/people') return jsonResponse([]);
    if (endpoint === '/api/programs') return jsonResponse([]);
    if (endpoint === '/api/projects') return jsonResponse([]);
    throw new Error(`Unmocked apiGet endpoint in test: ${endpoint}`);
  }),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

// Imported after the mocks so the page picks up the stubbed network layer.
import { UnifiedDocumentPage } from './UnifiedDocumentPage';

const editorProps = vi.fn();
vi.mock('@/components/LazyEditor', () => ({
  LazyEditor: (props: Record<string, unknown>) => {
    editorProps(props);
    return <div data-testid="editor-mounted">draft text the user has not saved yet</div>;
  },
}));

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TooltipProvider>
          <CurrentDocumentProvider>
            <MemoryRouter initialEntries={[`/documents/${DOC_ID}`]}>
              <Routes>
                <Route path="documents/:id/*" element={<UnifiedDocumentPage />} />
              </Routes>
            </MemoryRouter>
          </CurrentDocumentProvider>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function renderWriteStatus(documentId: string, onGone: () => void) {
  return renderHook(() => useDocumentWriteStatus(documentId, onGone), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  docCallCount = 0;
  editorProps.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  queryClient.removeQueries({ queryKey: ['document', DOC_ID] });
  vi.restoreAllMocks();
});

describe('TRO-290 / ERR-14: window-focus refetch on a deleted document', () => {
  it('keeps the editor mounted (does not discard in-progress text) and raises the deletion notice via the shared bus', async () => {
    // A second, independent subscriber to the SAME bus Editor.tsx's
    // useDocumentWriteStatus uses - proves the read-path 404 was routed
    // through the one deletion story rather than a second, ad hoc channel.
    const onGone = vi.fn();
    const { result: writeStatus } = renderWriteStatus(DOC_ID, onGone);

    renderPage();

    // Editor is mounted with the document's real content.
    expect(await screen.findByTestId('editor-mounted')).toBeInTheDocument();
    expect(docCallCount).toBe(1);
    expect(writeStatus.current.hasFailedWrite).toBe(false);

    // Mark the query stale WITHOUT triggering a refetch yet - isolates the
    // focus event as the actual trigger under test. `refetchType: 'none'` means
    // this resolves without any network activity; awaiting it just ensures the
    // stale-marking itself has completed before we move on.
    await queryClient.invalidateQueries({ queryKey: ['document', DOC_ID], refetchType: 'none' });

    // The real trigger: react-query's focusManager listens for this exact
    // event on `window` (see @tanstack/query-core's focusManager.ts).
    window.dispatchEvent(new Event('visibilitychange'));

    // Wait for the second (now-404) fetch to land.
    await waitFor(() => expect(docCallCount).toBe(2));

    // The deletion notice fired through the shared bus...
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
    expect(writeStatus.current.hasFailedWrite).toBe(true);

    // ...and the editor - with its in-progress, unsaved text - is still here.
    // Before the fix, `if (error || !document)` unmounted it instead.
    expect(screen.getByTestId('editor-mounted')).toHaveTextContent(
      'draft text the user has not saved yet'
    );
    expect(screen.queryByText(/document not found/i)).not.toBeInTheDocument();
    // Only ever fetched twice: the initial load and the one focus refetch -
    // no retry storm and no re-render loop re-firing the notice.
    expect(docCallCount).toBe(2);
  });

  it('still shows the "not found" screen on a hard 404 with no cached document at all', async () => {
    docCallCount = 1; // skip straight to the 404 branch on first fetch
    renderPage();

    await waitFor(() => expect(screen.getByText(/document not found/i)).toBeInTheDocument());
    expect(screen.queryByTestId('editor-mounted')).not.toBeInTheDocument();
  });
});
