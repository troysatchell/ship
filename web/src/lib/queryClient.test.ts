/**
 * TRO-172 / audit finding API-1 — throttled requests must not be dropped.
 *
 * Both react-query retry predicates returned `false` for every status in
 * [400,500), so HTTP 429 was treated as permanent. `grep -rn "429" web/src`
 * returned zero matches. A throttled `PATCH` of document metadata (title,
 * state, priority, assignee) therefore failed for good with only a toast.
 *
 * 429 is the one 4xx that is transient: the request was never evaluated, and it
 * succeeds once the server's rate-limit window rolls over.
 *
 * These tests read the retry policy off the configured `queryClient` rather
 * than off the helper functions, so they assert what the app actually runs.
 */
import { describe, it, expect } from 'vitest';
import { queryClient } from './queryClient';

type RetryFn = (failureCount: number, error: unknown) => boolean;
type RetryDelayFn = (failureCount: number, error: unknown) => number;

/** Mirrors how every hook in `web/src/hooks` throws: `error.status = res.status`. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** `apiLimiter` window in `api/src/middleware/rate-limit.ts`. */
const SERVER_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const defaults = queryClient.getDefaultOptions();

function assertRetryPolicy(label: string, retry: unknown, retryDelay: unknown) {
  describe(label, () => {
    it('retries a throttled (429) request instead of dropping it', () => {
      expect(typeof retry).toBe('function');
      expect((retry as RetryFn)(0, httpError(429))).toBe(true);
    });

    it('still treats every other 4xx as permanent', () => {
      for (const status of [400, 401, 403, 404, 409, 422]) {
        expect((retry as RetryFn)(0, httpError(status)), `status ${status}`).toBe(false);
      }
    });

    it('still retries 5xx and errors with no status', () => {
      expect((retry as RetryFn)(0, httpError(500))).toBe(true);
      expect((retry as RetryFn)(0, new Error('Failed to fetch'))).toBe(true);
    });

    it('gives up on 429 eventually rather than retrying forever', () => {
      expect((retry as RetryFn)(50, httpError(429))).toBe(false);
    });

    it('backs off past the server rate-limit window before giving up', () => {
      expect(typeof retryDelay).toBe('function');

      let totalDelayMs = 0;
      let failureCount = 0;
      while ((retry as RetryFn)(failureCount, httpError(429)) && failureCount < 20) {
        const delay = (retryDelay as RetryDelayFn)(failureCount, httpError(429));
        expect(delay, `delay for attempt ${failureCount}`).toBeGreaterThan(0);
        totalDelayMs += delay;
        failureCount += 1;
      }

      // Retries that all land inside the window that rejected the request hit
      // the same exhausted bucket and are guaranteed to fail. The schedule must
      // outlast the window.
      expect(totalDelayMs).toBeGreaterThan(SERVER_RATE_LIMIT_WINDOW_MS);
    });
  });
}

describe('API-1 (TRO-172): queryClient retry policy', () => {
  assertRetryPolicy('queries', defaults.queries?.retry, defaults.queries?.retryDelay);
  assertRetryPolicy('mutations', defaults.mutations?.retry, defaults.mutations?.retryDelay);
});
