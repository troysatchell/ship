/**
 * Regression test for TRO-282 (TEST-13).
 *
 * `ProgramWeeksTab` navigated to `/documents/:id/sprints/:sprintId` when a week
 * card was clicked, but commit 7713ef0 renamed the program tab's id to
 * `weeks` (web/src/lib/document-tabs.tsx). `UnifiedDocumentPage` treats any
 * URL tab segment that isn't in `tabConfig` as invalid and redirects to the
 * bare `/documents/:id` URL (see the effect around line 93-102). Because
 * `sprints` is not a valid tab id for a program document, clicking a week
 * card bounced the user back to the document root instead of opening the
 * week — losing the tab *and* the selected week.
 *
 * This test renders the real route tree (`documents/:id/*` -> UnifiedDocumentPage
 * -> the real program tab config -> the real ProgramWeeksTab/WeekTimeline),
 * clicks a week card exactly like a user would, and asserts where the browser
 * actually lands. Only the network layer (`@/lib/api`) and auth context are
 * stubbed; the navigation wiring under test is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CurrentDocumentProvider } from '@/contexts/CurrentDocumentContext';

const PROGRAM_ID = 'prog-1';
const SPRINT_ID = 'a1b2c3d4-1111-4a2b-8c3d-111122223333';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
  }),
}));

vi.mock('@/lib/api', () => {
  const jsonResponse = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

  return {
    apiGet: vi.fn((endpoint: string) => {
      if (endpoint === `/api/documents/${PROGRAM_ID}`) {
        return jsonResponse({
          id: PROGRAM_ID,
          title: 'Test Program',
          document_type: 'program',
          properties: {},
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          created_by: 'user-1',
          belongs_to: [],
        });
      }
      if (endpoint === `/api/programs/${PROGRAM_ID}/sprints`) {
        // 3 days ago -> getCurrentSprintNumber() resolves to sprint_number 1,
        // which keeps our one real sprint inside WeekTimeline's initial
        // rendered window (currentSprintNumber +/- 13).
        const workspaceStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        return jsonResponse({
          workspace_sprint_start_date: workspaceStart,
          weeks: [
            {
              id: SPRINT_ID,
              name: 'Week 1',
              sprint_number: 1,
              status: 'active',
              owner: null,
              issue_count: 3,
              completed_count: 1,
              started_count: 1,
            },
          ],
        });
      }
      if (endpoint === '/api/team/people') return jsonResponse([]);
      if (endpoint === '/api/programs') return jsonResponse([]);
      if (endpoint === '/api/projects') return jsonResponse([]);
      throw new Error(`Unmocked apiGet endpoint in test: ${endpoint}`);
    }),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

// Imported after the mocks so the page picks up the stubbed network layer.
import { UnifiedDocumentPage } from './UnifiedDocumentPage';

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAt(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TooltipProvider>
          <CurrentDocumentProvider>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="documents/:id/*" element={<UnifiedDocumentPage />} />
              </Routes>
              <LocationDisplay />
            </MemoryRouter>
          </CurrentDocumentProvider>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('Program Weeks tab navigation (TRO-282 / TEST-13)', () => {
  beforeEach(() => {
    // WeekDetailView (rendered once a week is selected) fetches with a raw
    // `fetch(...)` call, not `apiGet`. Stub it to a harmless 404 so the test
    // exercises real navigation without making a network call or leaving an
    // unhandled rejection in the console.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 404 })))
    );
  });

  it('clicking a week card lands on the week, not the document root', async () => {
    renderAt(`/documents/${PROGRAM_ID}/weeks`);

    // Wait for the real Weeks tab (lazy-loaded) and its timeline to render.
    const card = await screen.findByRole('button', { name: /Week of/i });

    fireEvent.click(card);

    // Before the fix: ProgramWeeksTab navigates to
    // `/documents/prog-1/sprints/<id>`, which UnifiedDocumentPage treats as an
    // invalid tab and redirects to `/documents/prog-1` — the bounce this
    // ticket is about. After the fix: it lands on the week under the current
    // `weeks` tab id.
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(
        `/documents/${PROGRAM_ID}/weeks/${SPRINT_ID}`
      );
    });
  });

  it('redirects a bookmarked legacy /sprints/ URL to the current /weeks/ URL instead of dropping it', async () => {
    renderAt(`/documents/${PROGRAM_ID}/sprints/${SPRINT_ID}`);

    // A stale bookmark or shared link from before the sprints->weeks rename
    // should land the user on the equivalent week, not bounce them to the
    // bare document URL with no tab and no week selected.
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(
        `/documents/${PROGRAM_ID}/weeks/${SPRINT_ID}`
      );
    });
  });
});
