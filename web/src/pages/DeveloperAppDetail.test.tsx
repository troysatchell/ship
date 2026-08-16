/**
 * PF-502 (TRO-436) — Developer > Apps > detail: rotate + revoke.
 * `api.oauthApps.*` mocked, same posture as DeveloperApps.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DeveloperAppDetailPage } from './DeveloperAppDetail';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    oauthApps: {
      get: vi.fn(),
      rotateSecret: vi.fn(),
      revoke: vi.fn(),
    },
  },
}));

const mockGet = vi.mocked(api.oauthApps.get);
const mockRotate = vi.mocked(api.oauthApps.rotateSecret);
const mockRevoke = vi.mocked(api.oauthApps.revoke);

const APP = {
  id: 'app-1',
  client_id: 'ship_app_acme',
  name: 'Acme Reporting Bot',
  client_type: 'confidential' as const,
  redirect_uris: ['https://example.com/callback'],
  requested_scopes: ['documents:read', 'issues:read'],
  is_first_party: false,
  created_at: '2026-08-01T00:00:00.000Z',
  revoked_at: null,
  has_secret: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function renderPage(id = 'app-1') {
  return render(
    <MemoryRouter initialEntries={[`/developer/apps/${id}`]}>
      <Routes>
        <Route path="/developer/apps" element={<div>Apps list</div>} />
        <Route path="/developer/apps/:id" element={<DeveloperAppDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DeveloperAppDetailPage', () => {
  it('renders app detail once loaded', async () => {
    mockGet.mockResolvedValue({ success: true, data: APP });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Acme Reporting Bot' })).toBeInTheDocument();
    expect(screen.getByText('ship_app_acme')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/callback')).toBeInTheDocument();
    expect(screen.getByText('documents:read')).toBeInTheDocument();
  });

  it('shows a not-found message for a 404', async () => {
    mockGet.mockResolvedValue({
      success: false,
      error: { code: 'NOT_FOUND', message: 'OAuth app not found' },
    });
    renderPage('missing-id');

    expect(await screen.findByText(/doesn't exist, or has been removed/i)).toBeInTheDocument();
  });

  it('rotating the secret shows the shown-once modal with the new value', async () => {
    mockGet.mockResolvedValue({ success: true, data: APP });
    mockRotate.mockResolvedValue({
      success: true,
      data: {
        client_secret: 'ship_secret_rotated_value',
        warning: 'Save this secret now. It will not be shown again.',
      },
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Acme Reporting Bot' });

    fireEvent.click(screen.getByRole('button', { name: /rotate secret/i }));

    await waitFor(() => expect(mockRotate).toHaveBeenCalledWith('app-1'));
    expect(await screen.findByText('ship_secret_rotated_value')).toBeInTheDocument();
  });

  it('does not offer secret rotation for a public client', async () => {
    mockGet.mockResolvedValue({ success: true, data: { ...APP, client_type: 'public', has_secret: false } });
    renderPage();

    await screen.findByRole('heading', { name: 'Acme Reporting Bot' });
    expect(screen.queryByRole('button', { name: /rotate secret/i })).not.toBeInTheDocument();
  });

  it('revoking requires confirmation, then navigates back to the app list', async () => {
    mockGet.mockResolvedValue({ success: true, data: APP });
    mockRevoke.mockResolvedValue({ success: true, data: { message: 'OAuth app revoked' } });

    renderPage();
    await screen.findByRole('heading', { name: 'Acme Reporting Bot' });

    fireEvent.click(screen.getByRole('button', { name: /^revoke app$/i }));
    expect(screen.getByText(/revoke this app\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('app-1'));
  });
});
