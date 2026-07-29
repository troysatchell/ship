/**
 * TRO-172 / audit finding API-1 — a write the server threw away must leave a
 * failure state the user can actually see.
 *
 * A throttled mutation that reaches this listener has already exhausted its
 * backoff retries, so the change really is lost. Before the fix it produced the
 * same generic three-second toast as any other error, which is a silent drop in
 * everything but name.
 *
 * The error is dispatched through the real `MutationCache.onError` configured in
 * `queryClient.ts`, so this exercises the wiring the app uses rather than a
 * stand-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { ToastProvider } from './ui/Toast';
import { MutationErrorToast } from './MutationErrorToast';
import { queryClient } from '@/lib/queryClient';

type MutationErrorDispatcher = (
  error: Error,
  variables: unknown,
  context: unknown,
  mutation: { options: { meta?: { operation?: string } } }
) => void;

/** Fire the same callback the mutationCache fires when a mutation finally fails. */
function emitMutationError(error: Error, operation?: string) {
  const onError = queryClient.getMutationCache().config.onError as unknown as
    | MutationErrorDispatcher
    | undefined;
  if (!onError) throw new Error('queryClient has no mutationCache onError handler');
  onError(error, undefined, undefined, { options: { meta: { operation } } });
}

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function renderToaster() {
  render(
    <ToastProvider>
      <MutationErrorToast />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('API-1 (TRO-172): MutationErrorToast', () => {
  it('keeps a throttled write on screen and names the cause', () => {
    renderToaster();

    act(() => {
      emitMutationError(httpError('Failed to update issue', 429), 'update issue');
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/rate limiting/i);
    expect(alert.textContent).toMatch(/not saved/i);

    // Ordinary error toasts self-dismiss after 3s. A write that was thrown away
    // must stay until the user acknowledges it.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByRole('alert').textContent).toMatch(/rate limiting/i);
  });

  it('leaves ordinary mutation errors on the transient toast', () => {
    renderToaster();

    act(() => {
      emitMutationError(httpError('Server exploded', 500), 'update issue');
    });

    expect(screen.getByRole('alert').textContent).toContain('Failed to update issue');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
