/**
 * TRO-190 / ERR-3, TRO-191 / ERR-4 — this hook is the piece of `Editor.tsx`
 * that turns a settled document-write mutation into (a) the boolean the
 * indicator uses to stop claiming "Saved", and (b) the one-time "document is
 * gone" notice.
 *
 * There is no live app to fire a real 429/500/404 through the browser here
 * (that is what probe6.1/6.2/7a/4c did). These tests instead drive REAL
 * `useMutation` calls against the app's actual `queryClient` singleton - the
 * same one `queryClient.ts` wires the document-write-outcome bus into - so
 * the full mutation lifecycle (execution, settling, the cache's
 * onError/onSuccess) runs exactly as it does in the app. That proves this
 * hook reacts correctly to what the app's mutation cache actually emits; it
 * is mutation-layer proof, not a rerun of the original browser-level probes.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider, useMutation, type UseMutationResult } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { useDocumentWriteStatus, type UseDocumentWriteStatusResult } from './useDocumentWriteStatus';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

type ProbeOutcome = 'success' | number;

/**
 * A minimal write mutation tagged for one document - mirrors how
 * `UnifiedDocumentPage.tsx`'s real `updateMutation` attaches `.status` to its
 * thrown error and tags `meta.documentId`. `retry: false` overrides the
 * app's default retry policy (already covered by `queryClient.test.ts`) so
 * each `mutate()` here settles in one attempt.
 */
function useProbeWrite(documentId: string) {
  return useMutation<unknown, Error & { status?: number }, ProbeOutcome>({
    mutationFn: async (outcome: ProbeOutcome) => {
      if (outcome === 'success') return {};
      throw Object.assign(new Error(`HTTP ${outcome}`), { status: outcome });
    },
    retry: false,
    meta: { documentId },
  });
}

interface Harness {
  status: UseDocumentWriteStatusResult;
  probe: UseMutationResult<unknown, Error & { status?: number }, ProbeOutcome>;
  otherProbe: UseMutationResult<unknown, Error & { status?: number }, ProbeOutcome>;
}

function renderHarness(documentId: string, onGone: () => void) {
  return renderHook<Harness, { documentId: string }>(
    ({ documentId }) => ({
      status: useDocumentWriteStatus(documentId, onGone),
      probe: useProbeWrite('doc-1'),
      otherProbe: useProbeWrite('doc-2'),
    }),
    { wrapper, initialProps: { documentId } }
  );
}

async function fire(result: { current: Harness }, which: 'probe' | 'otherProbe', outcome: ProbeOutcome) {
  act(() => result.current[which].mutate(outcome));
  await waitFor(() => expect(result.current[which].isError || result.current[which].isSuccess).toBe(true));
}

beforeEach(() => {
  // The real mutationCache.onError also logs to console.error - expected
  // noise from deliberately firing failures through the real handler.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useDocumentWriteStatus (TRO-190 / ERR-3)', () => {
  it('flips hasFailedWrite when this document write fails (429 or 500)', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    expect(result.current.status.hasFailedWrite).toBe(false);

    await fire(result, 'probe', 429);

    expect(result.current.status.hasFailedWrite).toBe(true);
    expect(onGone, '429 is a rejected write, not a gone document').not.toHaveBeenCalled();
  });

  it('flips hasFailedWrite for a 500 the same as a 429', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 500);

    expect(result.current.status.hasFailedWrite).toBe(true);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('ignores write outcomes for a different document', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'otherProbe', 500);

    expect(result.current.status.hasFailedWrite).toBe(false);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('clears hasFailedWrite once a later write for the same document succeeds', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 500);
    expect(result.current.status.hasFailedWrite).toBe(true);

    await fire(result, 'probe', 'success');
    expect(result.current.status.hasFailedWrite).toBe(false);
  });
});

describe('useDocumentWriteStatus (TRO-191 / ERR-4)', () => {
  it('calls onDocumentGone when the write fails with 404', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 404);

    expect(onGone, 'a 404 write means the document is gone - probe4c').toHaveBeenCalledTimes(1);
    expect(result.current.status.hasFailedWrite).toBe(true);
  });

  it('calls onDocumentGone exactly once across repeated failed attempts', async () => {
    // probe7a observed 14 PATCH attempts for one logical edit (react-query's
    // own retries plus useAutoSave's outer retry loop). A blocking alert per
    // attempt would be a stack of native dialogs - the notice must be
    // one-shot per document, not per failed attempt.
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 404);
    await fire(result, 'probe', 404);
    await fire(result, 'probe', 404);

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(result.current.status.hasFailedWrite).toBe(true);
  });

  it('resets the gone-notice guard and hasFailedWrite when documentId changes', async () => {
    const onGone = vi.fn();
    const { result, rerender } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 404);
    expect(onGone).toHaveBeenCalledTimes(1);

    rerender({ documentId: 'doc-2' });
    expect(result.current.status.hasFailedWrite, 'a fresh document starts clean').toBe(false);

    await fire(result, 'otherProbe', 404);
    expect(onGone, 'the new document gets its own one-shot notice').toHaveBeenCalledTimes(2);
  });

  it('does not call onDocumentGone for a non-404 failure', async () => {
    const onGone = vi.fn();
    const { result } = renderHarness('doc-1', onGone);

    await fire(result, 'probe', 500);

    expect(onGone, 'a 500 is a rejected write, not proof the document is gone').not.toHaveBeenCalled();
  });
});
