/**
 * TRO-194 / ERR-7 — under Fast 3G throttling the audit's own probe walked
 * `/my-week` (the app's landing route, per `App.tsx`'s `/` redirect) and
 * recorded `loadingAffordanceInFirst2s=false` with a 61s idle main page
 * (`audit/error-handling/baseline.md`). `MyWeekPage` already branched on
 * `useMyWeekQuery`'s `isLoading` before rendering anything else, but the
 * branch rendered plain, roleless text - nothing a screen reader would
 * announce, and (before the `web/index.html` app-shell fix, tested
 * separately in `appShellLoading.test.tsx`) nothing that could paint before
 * the JS bundle itself had finished loading.
 *
 * This test controls the mocked query's state directly (no timers, no
 * sleeps) and asserts the initial-loading branch renders an accessible
 * status affordance - queried by role, not by text or class, so the
 * assertion fails the same way an unreachable control would for a real
 * screen-reader user.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockUseMyWeekQuery = vi.fn();
vi.mock('@/hooks/useMyWeekQuery', () => ({
  useMyWeekQuery: (weekNumber?: number) => mockUseMyWeekQuery(weekNumber),
}));

// Imported after the mock so the page picks it up (matches the pattern in
// MyWeekPage.contrast.test.tsx).
const { MyWeekPage } = await import('./MyWeekPage');

describe('MyWeekPage loading affordance (TRO-194 / ERR-7)', () => {
  it('renders an accessible status while the initial fetch is in flight (isLoading, not isFetching)', () => {
    // A pending fetch that has not resolved yet: react-query's `isLoading`
    // (first-load) state, not a background `isFetching` refetch.
    mockUseMyWeekQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(
      <MemoryRouter>
        <MyWeekPage />
      </MemoryRouter>
    );

    const status = screen.getByRole('status');
    expect(status.textContent, 'must actually say something is loading').toMatch(/loading/i);
  });

  it('announces the loading state live, not just visually', () => {
    mockUseMyWeekQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(
      <MemoryRouter>
        <MyWeekPage />
      </MemoryRouter>
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not show the loading status once data has arrived', () => {
    mockUseMyWeekQuery.mockReturnValue({
      data: {
        person_id: 'p-1',
        person_name: 'Dev User',
        week: {
          week_number: 30,
          current_week_number: 30,
          start_date: '2026-07-20',
          end_date: '2026-07-26',
          is_current: true,
        },
        plan: null,
        retro: null,
        previous_retro: null,
        standups: [],
        projects: [],
      },
      isLoading: false,
      error: null,
    });

    render(
      <MemoryRouter>
        <MyWeekPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
