/**
 * TRO-194 / ERR-7 — the audit's Fast-3G walk included "Dashboard" among the
 * flows that measured `loadingAffordanceInFirst2s=false`
 * (audit/error-handling/baseline.md). `DashboardPage` already branched on
 * `weeksLoading || projectsLoading` before rendering anything, but the
 * branch was plain, roleless text.
 *
 * This test controls the mocked hooks' loading state directly (no timers,
 * no sleeps) and asserts the branch renders an accessible status affordance,
 * queried by role rather than text or class.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/hooks/useWeeksQuery', () => ({
  // isLoading: true — react-query's initial-fetch state, not a background
  // isFetching refetch.
  useActiveWeeksQuery: () => ({ data: undefined, isLoading: true }),
  useRecentStandupsQuery: () => ({ data: undefined, isLoading: true }),
}));

vi.mock('@/contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], loading: true }),
}));

vi.mock('@/hooks/useDashboardActionItems', () => ({
  useDashboardActionItems: () => ({ data: { action_items: [] }, isLoading: false }),
}));

import { DashboardPage } from './Dashboard';

function renderWithRouter(ui: React.ReactElement) {
  window.history.pushState({}, '', '?view=overview');
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

describe('DashboardPage loading affordance (TRO-194 / ERR-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible status while weeks/projects are still loading', () => {
    renderWithRouter(<DashboardPage />);

    const status = screen.getByRole('status');
    expect(status.textContent, 'must actually say something is loading').toMatch(/loading/i);
  });

  it('announces the loading state live, not just visually', () => {
    renderWithRouter(<DashboardPage />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not render the rest of the dashboard while loading', () => {
    renderWithRouter(<DashboardPage />);

    // The real content (header, stat cards) must not appear alongside the
    // loading status — otherwise this isn't a loading affordance, it's decor.
    expect(screen.queryByText('Cross-program overview of work transparency')).not.toBeInTheDocument();
  });
});
