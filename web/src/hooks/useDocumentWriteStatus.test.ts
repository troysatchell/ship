/**
 * TRO-190 / ERR-3, TRO-191 / ERR-4 — this hook is the piece of `Editor.tsx`
 * that turns a settled document-write mutation into (a) the boolean the
 * indicator uses to stop claiming "Saved", and (b) the one-time "document is
 * gone" notice.
 *
 * There is no live app to fire a real 429/500/404 through the browser here
 * (that is what probe6.1/6.2/7a/4c did), so these tests exercise the actual
 * production wiring at the mutation layer instead: they call the REAL
 * `queryClient`'s `MutationCache.onError`/`onSuccess` handlers directly - the
 * same technique `MutationErrorToast.test.tsx` uses - rather than a stand-in.
 * That proves this hook reacts correctly to what the app's mutation cache
 * actually emits; it does not reproduce the original browser-level probes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { queryClient } from '@/lib/queryClient';
import { useDocumentWriteStatus } from './useDocumentWriteStatus';

type MutationCacheHandler = (
  error: unknown,
  variables: unknown,
  context: unknown,
  mutation: { options: { meta?: Record<string, unknown> } }
) => void;

function mutationWithDocumentId(documentId: string) {
  return { options: { meta: { documentId } } };
}

/** Fire the same callback the mutationCache fires when a mutation finally fails. */
function emitError(documentId: string, status: number) {
  const onError = queryClient.getMutationCache().config.onError as unknown as
    | MutationCacheHandler
    | undefined;
  if (!onError) throw new Error('queryClient has no mutationCache onError handler');
  const error = Object.assign(new Error(`HTTP ${status}`), { status });
  onError(error, undefined, undefined, mutationWithDocumentId(documentId));
}

/** Fire the same callback the mutationCache fires when a mutation succeeds. */
function emitSuccess(documentId: string) {
  const onSuccess = queryClient.getMutationCache().config.onSuccess as unknown as
    | MutationCacheHandler
    | undefined;
  if (!onSuccess) throw new Error('queryClient has no mutationCache onSuccess handler');
  onSuccess(undefined, undefined, undefined, mutationWithDocumentId(documentId));
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
  it('flips hasFailedWrite when this document write fails (429 or 500)', () => {
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    expect(result.current.hasFailedWrite).toBe(false);

    act(() => emitError('doc-1', 429));
    expect(result.current.hasFailedWrite).toBe(true);
    expect(onGone, '429 is a rejected write, not a gone document').not.toHaveBeenCalled();
  });

  it('flips hasFailedWrite for a 500 the same as a 429', () => {
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => emitError('doc-1', 500));
    expect(result.current.hasFailedWrite).toBe(true);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('ignores write outcomes for a different document', () => {
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => emitError('doc-2', 500));
    expect(result.current.hasFailedWrite).toBe(false);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('clears hasFailedWrite once a later write for the same document succeeds', () => {
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => emitError('doc-1', 500));
    expect(result.current.hasFailedWrite).toBe(true);

    act(() => emitSuccess('doc-1'));
    expect(result.current.hasFailedWrite).toBe(false);
  });
});

describe('useDocumentWriteStatus (TRO-191 / ERR-4)', () => {
  it('calls onDocumentGone when the write fails with 404', () => {
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => emitError('doc-1', 404));

    expect(onGone, 'a 404 write means the document is gone - probe4c').toHaveBeenCalledTimes(1);
    expect(result.current.hasFailedWrite).toBe(true);
  });

  it('calls onDocumentGone exactly once across repeated failed attempts', () => {
    // probe7a observed 14 PATCH attempts for one logical edit (react-query's
    // own retries plus useAutoSave's outer retry loop). A blocking alert per
    // attempt would be a stack of native dialogs - the notice must be
    // one-shot per document, not per failed attempt.
    const onGone = vi.fn();
    const { result } = renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => {
      emitError('doc-1', 404);
      emitError('doc-1', 404);
      emitError('doc-1', 404);
    });

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(result.current.hasFailedWrite).toBe(true);
  });

  it('resets the gone-notice guard and hasFailedWrite when documentId changes', () => {
    const onGone = vi.fn();
    const { result, rerender } = renderHook(
      ({ documentId }) => useDocumentWriteStatus(documentId, onGone),
      { initialProps: { documentId: 'doc-1' } }
    );

    act(() => emitError('doc-1', 404));
    expect(onGone).toHaveBeenCalledTimes(1);

    rerender({ documentId: 'doc-2' });
    expect(result.current.hasFailedWrite, 'a fresh document starts clean').toBe(false);

    act(() => emitError('doc-2', 404));
    expect(onGone, 'the new document gets its own one-shot notice').toHaveBeenCalledTimes(2);
  });

  it('does not call onDocumentGone for a non-404 failure', () => {
    const onGone = vi.fn();
    renderHook(() => useDocumentWriteStatus('doc-1', onGone));

    act(() => emitError('doc-1', 500));

    expect(onGone, 'a 500 is a rejected write, not proof the document is gone').not.toHaveBeenCalled();
  });
});
