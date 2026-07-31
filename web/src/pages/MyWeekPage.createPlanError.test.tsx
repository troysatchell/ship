/**
 * TRO-306 (TS-10 follow-up) regression test.
 *
 * `MyWeekPage`'s handleCreatePlan/handleCreateRetro/handleCreateStandup used
 * to be `try { ... } finally { setCreating(null); }` with NO `catch` and no
 * `else` on a non-ok response: a rejected `apiPost` (or a 4xx/5xx response)
 * silently reset the "Creating..." button back to its idle label with zero
 * feedback - the create action failed and nothing in the UI said so. That
 * was also a floating promise: `navigate(...)` was called unconditionally in
 * a fire-and-forget style with no rejection handling anywhere in the chain.
 *
 * This test drives the plan-creation failure path end to end: it mocks
 * `apiPost` to reject (a network failure, the same shape `api.ts`'s
 * `request()` layer produces when `fetch` itself throws), clicks "+ Create
 * plan for this week", and asserts:
 *   1. The button returns to its idle label instead of being stuck on
 *      "Creating..." forever.
 *   2. An accessible `role="alert"` error message appears saying the create
 *      failed - this element and its message did not exist before this fix.
 *
 * Confirmed red-for-the-right-reason: reverting MyWeekPage.tsx's
 * handleCreatePlan to the pre-fix `try { ... } finally { ... }` (no catch,
 * no else) makes assertion (2) fail with "Unable to find an element with the
 * text: /failed to create weekly plan/i" - the banner never renders because
 * nothing ever calls `setActionError`. The promise rejection instead surfaces
 * as an unhandled rejection in the test's stderr, which is exactly the
 * silent-failure defect this ticket describes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MyWeekResponse } from '@/hooks/useMyWeekQuery';

const mockUseMyWeekQuery = vi.fn();
vi.mock('@/hooks/useMyWeekQuery', () => ({
  useMyWeekQuery: (weekNumber?: number) => mockUseMyWeekQuery(weekNumber),
}));

const apiPostMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}));

// Imported after the mocks so the page picks them up (matches the pattern in
// MyWeekPage.contrast.test.tsx / MyWeekPage.loadingAffordance.test.tsx).
const { MyWeekPage } = await import('./MyWeekPage');

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function weekData(): MyWeekResponse {
  return {
    person_id: 'p-1',
    person_name: 'Dev User',
    week: {
      week_number: 30,
      current_week_number: 30,
      start_date: isoDate(-2),
      end_date: isoDate(4),
      is_current: true,
    },
    plan: null,
    retro: null,
    previous_retro: null,
    standups: [],
    // Empty projects keeps `isDue` false, so the button reads a plain
    // "+ Create plan for this week" rather than a "Due today" variant -
    // irrelevant to this test, just keeps the query simple.
    projects: [],
  };
}

describe('MyWeekPage create-plan failure surfacing (TRO-306 / TS-10 follow-up)', () => {
  it('shows an error and un-sticks the button when creating a plan fails', async () => {
    mockUseMyWeekQuery.mockReturnValue({ data: weekData(), isLoading: false, error: null });
    apiPostMock.mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter>
        <MyWeekPage />
      </MemoryRouter>
    );

    const createButton = screen.getByRole('button', { name: /create plan for this week/i });
    fireEvent.click(createButton);

    // Immediately after the click, the button reflects the in-flight state.
    expect(await screen.findByRole('button', { name: /creating/i })).toBeInTheDocument();

    // Once the rejected apiPost settles, the failure must be visible...
    const alert = await screen.findByRole('alert');
    expect(alert.textContent, 'the create-plan failure must be announced, not swallowed').toMatch(
      /failed to create weekly plan/i
    );

    // ...and the button must return to its idle, retryable label rather than
    // being stuck on "Creating..." forever.
    expect(
      await screen.findByRole('button', { name: /create plan for this week/i }),
      'the button must recover from "Creating..." once the failure is handled'
    ).toBeInTheDocument();

    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/weekly-plans',
      expect.objectContaining({ person_id: 'p-1', week_number: 30 })
    );
  });

  it('does not navigate away when the create fails', async () => {
    mockUseMyWeekQuery.mockReturnValue({ data: weekData(), isLoading: false, error: null });
    apiPostMock.mockRejectedValue(new Error('network down'));

    render(
      <MemoryRouter initialEntries={['/my-week']}>
        <MyWeekPage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /create plan for this week/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // The page itself is still mounted and showing the week heading - a
    // successful navigate() would have unmounted it (MemoryRouter has no
    // /documents/:id route registered, so a stray navigate would blank the
    // page instead).
    expect(screen.getByText(/week 30/i)).toBeInTheDocument();
  });
});
