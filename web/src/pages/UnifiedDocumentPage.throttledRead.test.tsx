/**
 * TRO-301 / ERR-17 — the top-level document-by-id query hardcoded
 * `retry: false`, overriding the shared `shouldRetryRequest`/`retryDelayMs`
 * policy every other query and mutation in the app gets for free from
 * `queryClient`'s `defaultOptions` (queryClient.ts, built for TRO-172/API-1).
 * A throttled (HTTP 429) read of a document therefore failed permanently on
 * the very first attempt instead of backing off across the server's
 * rate-limit window.
 *
 * Note on the ticket's original premise: the Linear ticket also described the
 * query's `queryFn` as throwing a plain `Error` with no `.status`. That part
 * was already fixed by PR #51 (TRO-290/ERR-14, commit 51f6c2e) - the thrown
 * error has carried `.status` since then. The only remaining defect, verified
 * by reading the current file before writing this test, is the `retry: false`
 * override. This test only proves that part.
 *
 * Like `UnifiedDocumentPage.deletedFocusRefetch.test.tsx`, this drives the
 * REAL app `queryClient` singleton (not a fresh test client) so the retry
 * policy under test is exactly what production runs, with real (unmocked)
 * timers so the actual backoff delay elapses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CurrentDocumentProvider } from '@/contexts/CurrentDocumentContext';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function docBody(id: string) {
  return {
    id,
    title: 'Untitled',
    document_type: 'wiki',
    properties: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'user-1',
    belongs_to: [],
  };
}

let docCallCount = 0;
let docResponses: Array<() => Promise<Response>> = [];

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn((endpoint: string) => {
    if (endpoint.startsWith('/api/documents/')) {
      docCallCount++;
      const next = docResponses[docCallCount - 1] ?? docResponses[docResponses.length - 1];
      if (!next) {
        throw new Error(`No mocked response configured for apiGet call #${docCallCount}`);
      }
      return next();
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

vi.mock('@/components/LazyEditor', () => ({
  LazyEditor: () => <div data-testid="editor-mounted">document content</div>,
}));

function renderPage(docId: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TooltipProvider>
          <CurrentDocumentProvider>
            <MemoryRouter initialEntries={[`/documents/${docId}`]}>
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

beforeEach(() => {
  docCallCount = 0;
  docResponses = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TRO-301 / ERR-17: document-by-id query retry policy', () => {
  it(
    'retries a throttled (429) read instead of failing permanently on the first attempt',
    async () => {
      const docId = 'wiki-tro301-429';
      // First attempt is throttled; the retry (backed off by the shared
      // policy) succeeds. On the unfixed `retry: false` code, docCallCount
      // never advances past 1 and the editor never mounts.
      docResponses = [
        () => jsonResponse({ error: 'Too Many Requests' }, 429),
        () => jsonResponse(docBody(docId)),
      ];

      renderPage(docId);

      // The shared retry policy's first 429 backoff is ~2-3s
      // (THROTTLE_RETRY_DELAYS_MS[0] = 2000ms + up to 50% jitter). Give the
      // real timer room to elapse.
      await waitFor(
        () => expect(screen.getByTestId('editor-mounted')).toBeInTheDocument(),
        { timeout: 8000 }
      );

      expect(docCallCount).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText(/document not found/i)).not.toBeInTheDocument();
    },
    12000
  );

  it('still routes a 404 straight to the deleted-document notice with no retry storm', async () => {
    const docId = 'wiki-tro301-404';
    docResponses = [() => jsonResponse({ error: 'Not found' }, 404)];

    renderPage(docId);

    await waitFor(() => expect(screen.getByText(/document not found/i)).toBeInTheDocument());
    expect(screen.queryByTestId('editor-mounted')).not.toBeInTheDocument();

    // Not a fixed wall-clock guess: shouldRetryRequest() (queryClient.ts:249-254)
    // returns false synchronously for any permanent 4xx, so a 404 never gets a
    // retry timer scheduled at all - there's no backoff window to out-wait here.
    // Flush the microtask/macrotask queue a bounded number of times instead, to
    // deterministically catch any stray refetch without depending on a duration.
    for (let flush = 0; flush < 5; flush++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(docCallCount).toBe(1);
  });
});
