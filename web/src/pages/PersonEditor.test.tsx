/**
 * TRO-289 / ERR-13 — `PersonEditorPage` saved title/property PATCHes through a
 * bare `apiPatch` call with no error handling at all: no `.status` on a
 * thrown error (there wasn't a thrown error - `apiPatch` never throws on a
 * non-ok response), no `useMutation`, and no tie into the write-outcome bus
 * that `Editor.tsx`'s `useDocumentWriteStatus` (TRO-190/ERR-3) already drives
 * the "Not saved" indicator from for every OTHER document type. A rejected
 * person-document write was invisible: the UI kept whatever it last painted
 * and the user had no way to know their change didn't persist.
 *
 * These tests render the real `PersonEditorPage` against the app's actual
 * `queryClient` singleton (mocking only the `@/lib/api` network boundary and
 * the lightweight context hooks the page pulls in), and pair it with a
 * `useDocumentWriteStatus` harness on the SAME queryClient - exactly the
 * technique `useDocumentWriteStatus.test.tsx` uses (real `useMutation` calls
 * against the real cache, not `queryClient.getMutationCache().config.onError`
 * invoked by hand - see commit 9510f8e) - to prove a failed person-document
 * write reaches the shared bus instead of vanishing.
 *
 * The property-save path (`onUpdateProperties`, captured off the real
 * `PersonSidebar` element `LazyEditor` receives) is used for the timing-
 * sensitive throttle-backoff assertion because it has no extra
 * `useAutoSave` throttle/trailing-save layer between the click and the
 * mutation - one call site, precise call counts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { useDocumentWriteStatus } from '@/hooks/useDocumentWriteStatus';

const PERSON_ID = 'person-tro289';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }),
}));
vi.mock('@/contexts/DocumentsContext', () => ({
  useDocuments: () => ({ createDocument: vi.fn() }),
}));
vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ isWorkspaceAdmin: true }),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

const apiPatchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn((endpoint: string) => {
    if (endpoint === `/api/documents/${PERSON_ID}`) {
      return jsonResponse({
        id: PERSON_ID,
        title: 'Grace Hopper',
        document_type: 'person',
        archived_at: null,
        properties: {},
      });
    }
    if (endpoint === `/api/team/people/${PERSON_ID}/sprint-metrics`) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
    if (endpoint === '/api/team/people') return jsonResponse([]);
    throw new Error(`Unmocked apiGet endpoint in test: ${endpoint}`);
  }),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
  apiDelete: vi.fn(),
}));

// Imported after the mocks so the page picks up the stubbed network layer.
import { PersonEditorPage } from './PersonEditor';

const editorProps = vi.fn();
vi.mock('@/components/LazyEditor', () => ({
  LazyEditor: (props: Record<string, unknown>) => {
    editorProps(props);
    return <div data-testid="editor-mounted" />;
  },
}));

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/team/${PERSON_ID}`]}>
        <Routes>
          <Route path="/team/:id" element={<PersonEditorPage />} />
        </Routes>
      </MemoryRouter>
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

/** Grab the real `onUpdateProperties` closure PersonEditorPage wired onto the
 * sidebar element it hands to `LazyEditor` - a captured prop, not a cast into
 * mutationCache internals. */
function latestOnUpdateProperties(): (updates: Record<string, unknown>) => Promise<void> {
  const props = editorProps.mock.calls.at(-1)?.[0] as
    | { sidebar?: { props: { onUpdateProperties: (u: Record<string, unknown>) => Promise<void> } } }
    | undefined;
  const fn = props?.sidebar?.props.onUpdateProperties;
  if (!fn) throw new Error('onUpdateProperties prop was not captured');
  return fn;
}

function latestOnTitleChange(): (title: string) => void {
  const props = editorProps.mock.calls.at(-1)?.[0] as { onTitleChange?: (t: string) => void } | undefined;
  if (!props?.onTitleChange) throw new Error('onTitleChange prop was not captured');
  return props.onTitleChange;
}

beforeEach(() => {
  apiPatchMock.mockReset();
  editorProps.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  queryClient.removeQueries({ queryKey: ['document', PERSON_ID] });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PersonEditorPage saves (TRO-289 / ERR-13)', () => {
  it('leaves the write-status bus clean after a successful property save', async () => {
    apiPatchMock.mockImplementation(() => jsonResponse({ id: PERSON_ID }));
    renderPage();
    await screen.findByTestId('editor-mounted');

    const { result: writeStatus } = renderWriteStatus(PERSON_ID, vi.fn());
    expect(writeStatus.current.hasFailedWrite).toBe(false);

    await act(async () => {
      await latestOnUpdateProperties()({ role: 'Staff Engineer' });
    });

    expect(apiPatchMock).toHaveBeenCalledWith(
      `/api/documents/${PERSON_ID}`,
      { properties: { role: 'Staff Engineer' } }
    );
    expect(writeStatus.current.hasFailedWrite).toBe(false);
  });

  it('flips hasFailedWrite - not "Saved" - when a property save is rejected, and the thrown error carries .status', async () => {
    // 400 (not 429, not 5xx) is a genuinely PERMANENT failure under
    // `shouldRetryRequest` (queryClient.ts) - react-query settles after the
    // first attempt with no internal retry, so this test isn't entangled
    // with the throttle-backoff timing the dedicated 429 test below covers.
    apiPatchMock.mockImplementation(() => jsonResponse({ error: 'bad request' }, 400));
    renderPage();
    await screen.findByTestId('editor-mounted');

    const { result: writeStatus } = renderWriteStatus(PERSON_ID, vi.fn());
    expect(writeStatus.current.hasFailedWrite).toBe(false);

    await act(async () => {
      await latestOnUpdateProperties()({ role: 'Will Not Save' });
    });

    // deriveSyncIndicator (SyncStatusIndicator.tsx) reads exactly this bit to
    // stop claiming "Saved" - this is the same assertion that component's
    // own tests make of `hasFailedWrite`.
    expect(writeStatus.current.hasFailedWrite).toBe(true);
  });

  it('flips hasFailedWrite when a title save is rejected (the useAutoSave-throttled path)', async () => {
    // A permanent 400, same reasoning as above. Fake timers are still needed
    // here (unlike the property-save tests) because `useAutoSave.save()`
    // retries blindly on ANY rejection - regardless of HTTP status - via its
    // own real `setTimeout`-based backoff (1s/2s/3s, independent of
    // react-query's policy; see useAutoSave.ts and the "14 PATCH attempts"
    // note in useDocumentWriteStatus.test.tsx). Draining it here keeps that
    // background retry chain from firing mid-way through a LATER test.
    apiPatchMock.mockImplementation(() => jsonResponse({ error: 'bad request' }, 400));
    renderPage();
    await screen.findByTestId('editor-mounted');

    const { result: writeStatus } = renderWriteStatus(PERSON_ID, vi.fn());
    expect(writeStatus.current.hasFailedWrite).toBe(false);

    vi.useFakeTimers();
    try {
      act(() => {
        latestOnTitleChange()('New Name The Save Will Reject');
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(apiPatchMock).toHaveBeenCalled();
      expect(writeStatus.current.hasFailedWrite).toBe(true);

      // Drain useAutoSave's outer retry loop (1s + 2s + 3s = 6s) so nothing
      // is left pending when this test ends.
      await vi.advanceTimersByTimeAsync(7000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 404 property-save reports the document gone through the shared bus, exactly like the write-path fix elsewhere', async () => {
    apiPatchMock.mockImplementation(() => jsonResponse({ error: 'gone' }, 404));
    renderPage();
    await screen.findByTestId('editor-mounted');

    const onGone = vi.fn();
    const { result: writeStatus } = renderWriteStatus(PERSON_ID, onGone);

    await act(async () => {
      await latestOnUpdateProperties()({ role: 'Ghost' });
    });

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(writeStatus.current.hasFailedWrite).toBe(true);
  });

  it('routes a 429 property-save through the throttle backoff (>= 2s before the first retry), not the ~1s generic-error schedule', async () => {
    apiPatchMock.mockImplementation(() => jsonResponse({ error: 'rate limited' }, 429));
    renderPage();
    await screen.findByTestId('editor-mounted');
    const onUpdateProperties = latestOnUpdateProperties();

    vi.useFakeTimers();
    try {
      // `mutateAsync` won't reject until every retry the shared policy
      // grants is exhausted - swallow that eventual rejection here so it
      // doesn't surface as an unhandled promise mid-test while fake timers
      // are still being advanced below.
      const settled = onUpdateProperties({ role: 'Throttled' }).catch(() => {});

      // Flush the initial attempt.
      await vi.advanceTimersByTimeAsync(0);
      expect(apiPatchMock).toHaveBeenCalledTimes(1);

      // A generic (non-429) retryable error backs off at
      // Math.min(1000 * 2**0, 30000) = 1000ms. If this mutation retried on
      // that schedule instead of the 429 one, a second call would already
      // have landed well before 2s.
      await vi.advanceTimersByTimeAsync(1500);
      expect(
        apiPatchMock,
        'THROTTLE_RETRY_DELAYS_MS[0] is 2000ms (+jitter) - a retry already landing by 1.5s means this used the generic schedule, not the throttle one'
      ).toHaveBeenCalledTimes(1);

      // THROTTLE_RETRY_DELAYS_MS[0] = 2000ms, with up to 50% jitter -> worst
      // case fires by 3000ms (1.5s already elapsed above).
      await vi.advanceTimersByTimeAsync(1500);
      expect(apiPatchMock).toHaveBeenCalledTimes(2);

      // Drain the REST of the shared retry policy's schedule
      // (THROTTLE_RETRY_DELAYS_MS = [2000, 8000, 20000, 45000], each with up
      // to 50% jitter, then one final permanent failure) so the mutation
      // fully settles and nothing is left pending in the background once
      // this test switches back to real timers.
      await vi.advanceTimersByTimeAsync(120_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
