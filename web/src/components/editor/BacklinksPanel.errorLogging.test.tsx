/**
 * Regression test for TRO-196 / audit finding ERR-9.
 *
 * `BacklinksPanel` polls `/api/documents/:id/backlinks` every 5 seconds
 * (`BacklinksPanel.tsx`, the `setInterval(fetchBacklinks, 5000)` in the mount
 * effect) and, before this fix, called `console.error` unconditionally on
 * every failed poll — not once per outage, once per poll. The audit's raw
 * evidence (`audit/error-handling/raw/probe4-concurrency.json`,
 * `probe6-mixed.json`) shows exactly this: a deleted-document 404 and an
 * expired-session 401 both produced a repeating
 * `Error fetching backlinks: Error: Failed to fetch backlinks` line, one per
 * poll, for as long as the failure persisted (offline, deleted doc, expired
 * or revoked session). ERR-4's ghost-editor scenario produces the one signal
 * this storm was burying: a 404 flood is exactly what should stand out, not
 * blend into routine noise.
 *
 * Fix (`BacklinksPanel.tsx`): track the failure mode of the most recently
 * *logged* failure in a ref. A poll that fails the same way as the last
 * logged failure stays silent. 404 (document deleted elsewhere) and 401
 * (session expired/revoked) are additionally downgraded to `console.debug`
 * — they are expected states, not bugs. A successful fetch resets the
 * tracked mode, so a genuinely new failure (even the same status, after a
 * recovery) is logged again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { BacklinksPanel } from './BacklinksPanel';

const realFetch = global.fetch;

function renderPanel() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <BacklinksPanel documentId="doc-1" />
      </ToastProvider>
    </MemoryRouter>
  );
}

/** Flushes the microtask queue without advancing any fake timer. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advances fake timers by one poll interval and lets the resulting fetch settle. */
async function advanceOnePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BacklinksPanel — console.error storm on repeated failures (ERR-9 / TRO-196)', () => {
  it('never calls console.error for repeated 404s — downgraded to console.debug (deleted doc)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;

    renderPanel();
    await flushMicrotasks();
    await advanceOnePoll();
    await advanceOnePoll();

    // Initial fetch + two polls — the failure kept recurring, it just isn't a bug.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });

  it('never calls console.error for repeated 401s — downgraded to console.debug (expired/revoked session)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    global.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch;

    renderPanel();
    await flushMicrotasks();
    await advanceOnePoll();
    await advanceOnePoll();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });

  it('logs console.error at most once across repeated network failures, not once per poll (offline)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    renderPanel();
    await flushMicrotasks();
    await advanceOnePoll();
    await advanceOnePoll();

    // Three attempts, same failure mode each time.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs again after a genuinely new failure mode, or after a recovery — this is not a blanket log-once-ever suppression', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify([]), { status: 500 });
      if (call === 2) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify([]), { status: 500 });
    }) as typeof fetch;

    renderPanel();
    await flushMicrotasks(); // call 1: 500 -> logged (1st)
    await advanceOnePoll(); // call 2: 200 -> recovers, resets tracked mode
    await advanceOnePoll(); // call 3: 500 -> new failure streak -> logged again (2nd)

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
