import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Regression test for TRO-181 / TRO-176 (audit findings DB-4 / API-5).
 *
 * Dashboard.tsx used to fetch recent standups by mapping every active week
 * to its own `GET /api/weeks/{id}/standups` request inside a `Promise.all` -
 * one HTTP round trip (and, server-side, one full auth+access+query cycle)
 * per active week. The fix collapses that into a single
 * `GET /api/weeks/standups?week_ids=...` request.
 *
 * This test does not mock `@/hooks/useWeeksQuery` - it lets the real
 * `useActiveWeeksQuery` / `useRecentStandupsQuery` hooks run against a mocked
 * `global.fetch`, so it observes the actual number and shape of network
 * calls the dashboard issues. Any request matching the old per-week URL
 * shape is treated as a failure: that is exactly the fan-out this fix
 * removes.
 */

vi.mock('@/contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    loading: false,
  }),
}));

vi.mock('@/hooks/useDashboardActionItems', () => ({
  useDashboardActionItems: () => ({
    data: { action_items: [] },
    isLoading: false,
  }),
}));

// Imported after the mocks above so the page picks up the stubbed hooks/context.
import { DashboardPage } from './Dashboard';

const ACTIVE_WEEKS = Array.from({ length: 5 }, (_, i) => ({
  id: `week-${i + 1}`,
  name: `Week ${i + 1}`,
  sprint_number: i + 1,
  status: 'active' as const,
  owner: null,
  issue_count: 0,
  completed_count: 0,
  started_count: 0,
  program_id: 'program-1',
  program_name: 'Program A',
  days_remaining: 3,
}));

const realFetch = global.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  window.history.pushState({}, '', '?view=overview');
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

describe('Dashboard standups fetch - batched, not fanned out (TRO-181 / TRO-176)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('fetches standups for 5 active weeks with exactly one request, not one per week', async () => {
    const standupsCalls: string[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);

      if (url.includes('/api/weeks/standups')) {
        standupsCalls.push(url);
        return Promise.resolve(jsonResponse([]));
      }

      if (url.endsWith('/api/weeks')) {
        return Promise.resolve(jsonResponse({
          weeks: ACTIVE_WEEKS,
          current_sprint_number: 1,
          days_remaining: 3,
          sprint_start_date: '2026-01-01',
          sprint_end_date: '2026-01-07',
        }));
      }

      // The pre-fix code called exactly this shape once per active week.
      // A hit here means the client-side fan-out has come back.
      if (/\/api\/weeks\/[^/?]+\/standups/.test(url)) {
        return Promise.reject(new Error(`Unexpected per-week standups fan-out request: ${url}`));
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    global.fetch = fetchMock as typeof fetch;

    renderDashboard();

    await waitFor(() => {
      expect(standupsCalls.length).toBeGreaterThan(0);
    });

    // Exactly one batched request, regardless of the 5 active weeks above.
    expect(standupsCalls).toHaveLength(1);

    const requestedUrl = new URL(standupsCalls[0] ?? '', 'http://localhost');
    const requestedWeekIds = requestedUrl.searchParams.get('week_ids')?.split(',') ?? [];
    expect(new Set(requestedWeekIds)).toEqual(new Set(ACTIVE_WEEKS.map(week => week.id)));

    // Never fell back to the old per-week fan-out.
    const fanOutCalls = fetchMock.mock.calls
      .map(call => requestUrl(call[0]))
      .filter(url => /\/api\/weeks\/[^/?]+\/standups/.test(url));
    expect(fanOutCalls).toHaveLength(0);
  });
});
