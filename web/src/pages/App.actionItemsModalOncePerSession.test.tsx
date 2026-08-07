/**
 * Regression test for the Action Items modal re-ambush (found live during
 * Early Submission demo prep, 2026-08-06): `actionItemsModalShownOnLoad` was
 * plain component state, so every FULL page load (login redirect, refresh,
 * opening a shared/direct link) remounted AppLayout, reset the guard, and
 * auto-opened the modal again. The modal is a Radix Dialog whose backdrop
 * blocks the entire app — with pending items present, every fresh page load
 * required dismissing it before anything (including the FleetGraph pill
 * underneath it) was clickable. The e2e suite never saw this because its
 * fixtures set `ship:disableActionItemsModal` (isolated-env.ts) — real users
 * have no such flag.
 *
 * The fix backs the guard with sessionStorage: auto-open once per browser
 * session, with the accountability banner remaining as the always-available
 * reopen path. Two AppLayout mounts in one test = two full page loads in one
 * browser session (jsdom sessionStorage persists across unmount/remount,
 * exactly like a real tab).
 *
 * Harness copied from App.inboxOverlay.test.tsx: every data-fetching
 * hook/context AppLayout depends on is mocked to a stable static value,
 * except useActionItemsQuery which returns one overdue item so the modal has
 * a reason to auto-open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CurrentDocumentProvider } from '@/contexts/CurrentDocumentContext';
import { UploadProvider } from '@/contexts/UploadContext';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    logout: vi.fn(),
    isSuperAdmin: false,
    impersonating: null,
    endImpersonation: vi.fn(),
  }),
}));

vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 'ws-1', name: 'Test Workspace' },
    workspaces: [],
    switchWorkspace: vi.fn(),
  }),
}));

vi.mock('@/contexts/DocumentsContext', () => ({
  useDocuments: () => ({
    documents: [],
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }),
}));

vi.mock('@/contexts/ProgramsContext', () => ({
  usePrograms: () => ({
    programs: [],
    updateProgram: vi.fn(),
  }),
}));

vi.mock('@/contexts/IssuesContext', () => ({
  useIssues: () => ({
    issues: [],
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
  }),
}));

vi.mock('@/contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    createProject: vi.fn(),
    updateProject: vi.fn(),
  }),
}));

vi.mock('@/hooks/useStandupStatusQuery', () => ({
  useStandupStatusQuery: () => ({ data: { due: false } }),
}));

const overdueItem = {
  id: 'ai-1',
  title: 'Post standup for Week 15',
  state: 'todo',
  priority: 'high',
  ticket_number: 1,
  display_id: 'ACC-1',
  due_date: '2026-08-06',
  is_system_generated: true,
  accountability_type: 'standup',
  accountability_target_id: 'week-15',
  target_title: 'Week 15',
  days_overdue: 1,
};

vi.mock('@/hooks/useActionItemsQuery', () => ({
  useActionItemsQuery: () => ({
    data: { items: [overdueItem], total: 1, has_overdue: true, has_due_today: false },
  }),
  actionItemsKeys: { all: ['action-items'] },
}));

vi.mock('@/hooks/useTeamMembersQuery', () => ({
  useTeamMembersQuery: () => ({ data: [] }),
}));

vi.mock('@/hooks/useSessionTimeout', () => ({
  useSessionTimeout: () => ({
    showWarning: false,
    timeRemaining: 0,
    warningType: null,
    resetTimer: vi.fn(),
  }),
}));

vi.mock('@/hooks/useRealtimeEvents', () => ({
  useRealtimeEvent: vi.fn(),
}));

vi.mock('@/hooks/useFocusOnNavigate', () => ({
  useFocusOnNavigate: vi.fn(),
}));

vi.mock('@/hooks/useInboxQuery', () => ({
  useInboxQuery: () => ({
    data: { status: 'ok', items: [] },
  }),
}));

// Imported after the mocks so AppLayout picks up the stubbed hooks/contexts.
import { AppLayout } from './App';

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TooltipProvider>
          <UploadProvider>
            <CurrentDocumentProvider>
              <MemoryRouter initialEntries={['/docs']}>
                <AppLayout />
              </MemoryRouter>
            </CurrentDocumentProvider>
          </UploadProvider>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('AppLayout — Action Items modal auto-opens once per session, not once per page load', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('auto-opens on the first mount, stays closed on a remount in the same session, and still opens from the banner', () => {
    // First mount = first full page load of the session: auto-opens.
    const first = renderApp();
    expect(screen.getByRole('dialog', { name: /action items/i })).toBeInTheDocument();
    first.unmount();

    // Second mount = the user refreshed / followed a redirect / opened a
    // direct link in the same tab. Must NOT auto-open again.
    const second = renderApp();
    expect(screen.queryByRole('dialog', { name: /action items/i })).not.toBeInTheDocument();

    // The banner remains the deliberate reopen path.
    fireEvent.click(screen.getByRole('button', { name: /view items/i }));
    expect(screen.getByRole('dialog', { name: /action items/i })).toBeInTheDocument();
    second.unmount();
  });

  it('still respects the e2e kill switch on a fresh session', () => {
    localStorage.setItem('ship:disableActionItemsModal', 'true');
    renderApp();
    expect(screen.queryByRole('dialog', { name: /action items/i })).not.toBeInTheDocument();
  });
});
