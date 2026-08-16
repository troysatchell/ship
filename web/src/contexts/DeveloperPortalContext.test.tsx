/**
 * PF-502 (TRO-436) — the portal mints its own scoped personal token on
 * entry and proves the mechanism against /api/v1/me. `api.apiTokens.create`
 * and `v1Request` (both from '@/lib/api') are mocked; no real network call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DeveloperPortalProvider, usePortalToken } from './DeveloperPortalContext';
import { api, v1Request } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { apiTokens: { create: vi.fn() } },
  v1Request: vi.fn(),
}));

const mockCreate = vi.mocked(api.apiTokens.create);
const mockV1Request = vi.mocked(v1Request);

function Probe() {
  const { token, loading, error, principal } = usePortalToken();
  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error}</div>;
  return (
    <div>
      <div>Token: {token}</div>
      <div>Connected as: {principal?.app?.name ?? principal?.user?.name ?? 'unknown'}</div>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeveloperPortalProvider / usePortalToken', () => {
  it('mints a scoped token on mount and calls /api/v1/me for identity', async () => {
    mockCreate.mockResolvedValue({
      success: true,
      data: {
        id: 'tok-1',
        name: 'Ship Developer Portal',
        token: 'ship_minted_token',
        token_prefix: 'ship_minte',
        last_used_at: null,
        expires_at: '2026-08-17T00:00:00.000Z',
        is_active: true,
        revoked_at: null,
        created_at: '2026-08-16T00:00:00.000Z',
        scopes: ['documents:read'],
        warning: 'Save this token now.',
      },
    });
    mockV1Request.mockResolvedValue({
      ok: true,
      data: { user: { id: 'u1', email: 'a@b.com', name: 'Alice' }, app: null, scopes: ['documents:read'] },
    });

    render(
      <DeveloperPortalProvider>
        <Probe />
      </DeveloperPortalProvider>
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ expires_in_days: 1, scopes: expect.arrayContaining(['documents:read', 'webhooks:manage']) })
    );

    await waitFor(() => {
      expect(screen.getByText('Token: ship_minted_token')).toBeInTheDocument();
    });
    expect(mockV1Request).toHaveBeenCalledWith('ship_minted_token', '/me');
    expect(screen.getByText('Connected as: Alice')).toBeInTheDocument();
  });

  it('surfaces a mint failure instead of hanging in the loading state', async () => {
    mockCreate.mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create API token' },
    });

    render(
      <DeveloperPortalProvider>
        <Probe />
      </DeveloperPortalProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Error: Failed to create API token')).toBeInTheDocument();
    });
  });

  it('usePortalToken throws when used outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow('usePortalToken must be used within a DeveloperPortalProvider');
    consoleError.mockRestore();
  });
});
