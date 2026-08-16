/**
 * PF-502 (TRO-436) — Developer > Apps: list + registration.
 * `api.oauthApps.*` is mocked throughout; these are component tests against
 * a stable fake network layer, not real HTTP calls (same posture as
 * InboxSidebar.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DeveloperAppsPage } from './DeveloperApps';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    oauthApps: {
      list: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const mockList = vi.mocked(api.oauthApps.list);
const mockCreate = vi.mocked(api.oauthApps.create);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/developer/apps']}>
      <DeveloperAppsPage />
    </MemoryRouter>
  );
}

describe('DeveloperAppsPage', () => {
  it('renders the registered apps once the list loads', async () => {
    mockList.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'app-1',
          client_id: 'ship_app_acme',
          name: 'Acme Reporting Bot',
          client_type: 'confidential',
          redirect_uris: [],
          requested_scopes: ['documents:read'],
          is_first_party: false,
          created_at: '2026-08-01T00:00:00.000Z',
          revoked_at: null,
          has_secret: true,
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('Acme Reporting Bot')).toBeInTheDocument();
    expect(screen.getByText('ship_app_acme')).toBeInTheDocument();
  });

  it('shows an empty state when there are no apps', async () => {
    mockList.mockResolvedValue({ success: true, data: [] });
    renderPage();
    expect(await screen.findByText(/no oauth apps registered yet/i)).toBeInTheDocument();
  });

  it('registering a confidential app shows the shown-once secret modal', async () => {
    mockList.mockResolvedValue({ success: true, data: [] });
    mockCreate.mockResolvedValue({
      success: true,
      data: {
        id: 'app-2',
        client_id: 'ship_app_new',
        client_secret: 'ship_secret_raw_value',
        name: 'New Integration',
        client_type: 'confidential',
        redirect_uris: ['https://example.com/callback'],
        requested_scopes: ['documents:read'],
        is_first_party: false,
        created_at: '2026-08-16T00:00:00.000Z',
        revoked_at: null,
        has_secret: true,
        warning: 'Save this secret now. It will not be shown again.',
      },
    });

    renderPage();
    await screen.findByText(/no oauth apps registered yet/i);

    fireEvent.click(screen.getByRole('button', { name: /new app/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'New Integration' } });
    fireEvent.change(screen.getByLabelText(/redirect uris/i), {
      target: { value: 'https://example.com/callback' },
    });

    const form = screen.getByRole('button', { name: /register app/i }).closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'New Integration',
        client_type: 'confidential',
        redirect_uris: ['https://example.com/callback'],
        requested_scopes: [],
      });
    });

    expect(await screen.findByText('ship_secret_raw_value')).toBeInTheDocument();
    expect(screen.getByText(/save your client secret/i)).toBeInTheDocument();
  });

  it('registering a public client shows a non-secret notice instead of the modal', async () => {
    mockList.mockResolvedValue({ success: true, data: [] });
    mockCreate.mockResolvedValue({
      success: true,
      data: {
        id: 'app-3',
        client_id: 'ship_app_public',
        client_secret: null,
        name: 'Browser Demo',
        client_type: 'public',
        redirect_uris: ['https://demo.example.com/callback'],
        requested_scopes: [],
        is_first_party: false,
        created_at: '2026-08-16T00:00:00.000Z',
        revoked_at: null,
        has_secret: false,
      },
    });

    renderPage();
    await screen.findByText(/no oauth apps registered yet/i);

    fireEvent.click(screen.getByRole('button', { name: /new app/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Browser Demo' } });
    fireEvent.click(within(screen.getByText(/public \(browser/i).closest('label')!).getByRole('radio'));

    const form = screen.getByRole('button', { name: /register app/i }).closest('form')!;
    fireEvent.submit(form);

    expect(await screen.findByText(/registered as a public client/i)).toBeInTheDocument();
    expect(screen.queryByText(/save your client secret/i)).not.toBeInTheDocument();
  });

  it('surfaces a list-load error instead of failing silently', async () => {
    mockList.mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list OAuth apps' },
    });

    renderPage();

    expect(await screen.findByText('Failed to list OAuth apps')).toBeInTheDocument();
  });
});
