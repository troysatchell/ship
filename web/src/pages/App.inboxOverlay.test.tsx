/**
 * Regression test for TRO-323/FG-10 follow-up (CodeRabbit review on PR #120):
 * `handleModeClick` (App.tsx) never reset `inboxOpen`, so clicking a normal
 * rail-mode icon (Dashboard/Docs/Programs/Projects/Team/Settings) while the
 * Inbox overlay was open left the Contextual Sidebar showing the Inbox
 * overlay AND the newly-selected mode as simultaneously "active" — the
 * sidebar header still read "Inbox" and `InboxSidebar` stayed mounted
 * instead of the mode's real content.
 *
 * Every rail-mode `RailIcon` (`onClick={() => handleModeClick(mode)}`) shares
 * the single `handleModeClick` function, so fixing it there closes the gap
 * for all of them — this test exercises one (Docs) as the representative
 * case, which is what CodeRabbit's comment on lines ~406-422 (the Inbox rail
 * icon sitting beside the other rail icons) and ~574-578 (the ternary that
 * renders `InboxSidebar` vs. the mode's real content, keyed off `inboxOpen`)
 * both reduce to: neither location has its own separate bug once
 * `inboxOpen` is actually reset at the one place that was missing it.
 *
 * Every data-fetching hook/context AppLayout depends on is mocked to a
 * stable, static value — this test is about `inboxOpen`/`activeMode`
 * interaction, never a real network call. `CurrentDocumentContext`,
 * `UploadContext`, `ToastProvider`, and `TooltipProvider` are real: none of
 * the four make a network call or fetch on mount, so mocking them would only
 * add risk of drifting from their real behavior for no benefit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

vi.mock('@/hooks/useActionItemsQuery', () => ({
  useActionItemsQuery: () => ({ data: { items: [] } }),
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

describe('AppLayout — Inbox overlay closes on rail-mode navigation (CodeRabbit review, PR #120)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('closes the Inbox overlay and shows only the newly-selected mode when a rail icon is clicked while Inbox is open', async () => {
    renderApp();

    // Open the Inbox overlay via its own rail toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));

    const sidebar = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(sidebar).getByText('Inbox')).toBeInTheDocument();

    // Click a normal rail-mode icon (Docs) while the overlay is open.
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));

    // The overlay must be gone: the Contextual Sidebar's header/aria-label
    // switch to the newly-selected mode, never staying on "Inbox".
    const modeSidebar = screen.getByRole('complementary', { name: 'Document list' });
    expect(within(modeSidebar).getByText('Docs')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Inbox' })).not.toBeInTheDocument();

    // The Inbox rail icon itself must no longer report as active/expanded.
    const inboxIconButton = screen.getByRole('button', { name: 'Inbox' });
    expect(inboxIconButton).toHaveAttribute('aria-expanded', 'false');
  });
});
