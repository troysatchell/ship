import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { BacklinksPanel } from './BacklinksPanel';

/** Flushes the microtask queue without advancing any fake timer - same
 * technique as `BacklinksPanel.errorLogging.test.tsx`'s `flushMicrotasks`. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Regression test for TRO-186 / audit finding DB-9.
 *
 * `BacklinksPanel`'s mount effect calls `fetchBacklinks()` immediately and
 * again every 5s via `setInterval` (see `BacklinksPanel.errorLogging.test.tsx`
 * for the ERR-9/TRO-196 fix this predates and must not disturb). Under React
 * 18 `StrictMode`, that effect mounts twice (setup, cleanup, setup again);
 * before this fix the discarded first mount's `fetch` had nothing to cancel
 * it, so the browser sent it anyway. The db-query audit's Playwright trace
 * (`audit/db-query/raw/flow-requests.json`, "View a document") caught this
 * as `/api/documents/:id/backlinks` firing 3x per document view - 2x from
 * the StrictMode double-mount plus one legitimate 5s poll tick landing
 * inside the observation window.
 *
 * This test isolates the double-mount contribution specifically (fake timers
 * held at t=0, no poll tick fires), so it targets exactly what the fix
 * (`AbortController` created in the effect, aborted on cleanup) changes:
 * the discarded first mount's request no longer reaches a response. It does
 * not touch or re-assert the ERR-9 console-throttling behavior, which has
 * its own dedicated test file.
 *
 * The mock is signal-aware for the same reason as
 * `TeamMode.duplicateRequests.test.tsx`: a mock that always resolves
 * regardless of `signal` would report "2" whether or not the fix is present,
 * since the discarded mount's `fetchBacklinks()` call still happens either
 * way - only whether its request actually completes changes.
 */

const realFetch = global.fetch;

const initiatedRequests: number[] = [];
const settledRequests: number[] = [];
const abortedRequests: number[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  initiatedRequests.length = 0;
  settledRequests.length = 0;
  abortedRequests.length = 0;

  let seq = 0;
  global.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const id = ++seq;
    initiatedRequests.push(id);
    const signal = init?.signal;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        abortedRequests.push(id);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        abortedRequests.push(id);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort);

      queueMicrotask(() => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return;
        settledRequests.push(id);
        resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });
    });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPanel() {
  return render(
    <StrictMode>
      <MemoryRouter>
        <ToastProvider>
          <BacklinksPanel documentId="doc-1" />
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>
  );
}

describe('BacklinksPanel — no wasted duplicate request from StrictMode double-mount (TRO-186 / DB-9)', () => {
  it('initiates two requests on mount (StrictMode) but only one settles with a response', async () => {
    renderPanel();

    await flushMicrotasks();

    // Sanity check: StrictMode really did double-mount this effect.
    expect(initiatedRequests.length).toBe(2);
    // The discarded first mount's request was cancelled...
    expect(abortedRequests.length).toBe(1);
    // ...so only the real (second) mount's request ever reaches a response -
    // one request that would reach the server and run its DB queries, not two.
    expect(settledRequests.length).toBe(1);
  });
});
