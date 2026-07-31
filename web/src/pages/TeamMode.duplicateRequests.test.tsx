import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Regression test for TRO-186 / audit finding DB-9.
 *
 * `TeamModePage` (the sprint board / allocation grid) loaded its three data
 * sources - `GET /api/team/grid`, `GET /api/team/projects` and
 * `GET /api/team/assignments` - from a bare `useEffect(() => { ... }, [])`
 * that called `apiGet` directly with no cleanup. React 18 `StrictMode`
 * mounts every component twice in development (setup, cleanup, setup again)
 * specifically to surface effects like this one that aren't safe to run
 * twice; because this effect had no cleanup, the discarded first mount's
 * three requests were never cancelled and the browser sent them anyway. The
 * db-query audit's Playwright trace against the real dev server
 * (`audit/db-query/raw/flow-requests.json`, "Load sprint board") caught
 * exactly this: all three endpoints hit twice per page load.
 *
 * This test does not merely mount the page once - a single, non-StrictMode
 * mount never exercised the bug (React only double-invokes effects under
 * StrictMode), so it would pass unchanged on the old code and prove nothing.
 * Wrapping in `<StrictMode>` reproduces the exact double-mount the audit's
 * browser trace hit.
 *
 * The mock below is signal-aware, mirroring real `fetch`: a call made with an
 * already-live `AbortSignal` schedules its response async, same as a real
 * network round trip; if that signal fires before the response would have
 * resolved, the mock rejects with `AbortError` instead of resolving - exactly
 * what a browser does when `AbortController.abort()` is called before a
 * request completes. That distinction is the whole fix (`TeamMode.tsx`'s
 * initial-load effect now creates an `AbortController` and aborts it on
 * cleanup), so a mock that ignored `signal` and always resolved would count
 * "2" both before and after the fix - the JS-level call still happens twice
 * under StrictMode either way, but only one of the two now reaches a
 * response. `settledCalls` counts only calls that actually got a real
 * response, which is the proxy for "reached the server and ran its DB
 * queries" that DB-9 cares about.
 */

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }),
}));

const GRID_RESPONSE = { users: [], weeks: [], currentSprintNumber: 1 };
const RESPONSES: Record<string, unknown> = {
  '/api/team/grid': GRID_RESPONSE,
  '/api/team/projects': [],
  '/api/team/assignments': {},
};

const initiatedCalls: string[] = [];
const settledCalls: string[] = [];
const abortedCalls: string[] = [];

/** Signal-aware stand-in for `apiGet` - see file docblock. */
const apiGetMock = vi.fn((endpoint: string, options?: { signal?: AbortSignal }) => {
  initiatedCalls.push(endpoint);
  const data = RESPONSES[endpoint];
  if (data === undefined) {
    throw new Error(`Unmocked apiGet endpoint in test: ${endpoint}`);
  }
  const signal = options?.signal;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      abortedCalls.push(endpoint);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const onAbort = () => {
      abortedCalls.push(endpoint);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);

    // Simulate a real async round trip so React's synchronous StrictMode
    // cleanup+remount (and its synchronous `controller.abort()`) has a
    // chance to fire before this "response" would land - exactly the race
    // a real browser request is in.
    queueMicrotask(() => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return; // onAbort already rejected this promise
      settledCalls.push(endpoint);
      resolve({ ok: true, json: () => Promise.resolve(data) });
    });
  });
});

vi.mock('@/lib/api', () => ({
  apiGet: (...args: [string, { signal?: AbortSignal }?]) => apiGetMock(...args),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

// Imported after the mocks so the page picks up the stubbed network layer.
import { TeamModePage } from './TeamMode';

function countOf(list: string[], endpoint: string): number {
  return list.filter((e) => e === endpoint).length;
}

const ENDPOINTS = ['/api/team/grid', '/api/team/projects', '/api/team/assignments'] as const;

describe('TeamModePage — sprint board fetches once per endpoint under StrictMode (TRO-186 / DB-9)', () => {
  beforeEach(() => {
    initiatedCalls.length = 0;
    settledCalls.length = 0;
    abortedCalls.length = 0;
    apiGetMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initiates each endpoint twice (StrictMode really double-mounted) but settles exactly one real response each', async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <TeamModePage />
        </MemoryRouter>
      </StrictMode>
    );

    await waitFor(() => {
      for (const endpoint of ENDPOINTS) {
        expect(countOf(settledCalls, endpoint)).toBeGreaterThan(0);
      }
    });

    for (const endpoint of ENDPOINTS) {
      // Sanity check: this test is actually exercising the StrictMode
      // double-mount, not silently degrading to a single mount.
      expect(countOf(initiatedCalls, endpoint)).toBe(2);
      // The discarded first mount's request was aborted...
      expect(countOf(abortedCalls, endpoint)).toBe(1);
      // ...so exactly one real response reaches the component - one request
      // that would have reached the server and run its DB queries, not two.
      expect(countOf(settledCalls, endpoint)).toBe(1);
    }
  });
});
