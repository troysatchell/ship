/**
 * TRO-616 — Developer > Audit: `public_api_audit` queryable in the portal.
 *
 * Vitest-tier regression test the factory gate actually runs. Mirrors
 * `DeveloperPortal.test.tsx`'s boundary: `usePortalToken()` is mocked so
 * every `/api/v1/audit` call goes through a fake `callV1`; the one internal
 * call (`api.oauthApps.list()`, the app filter's option source) goes over a
 * stubbed `global.fetch`.
 *
 * Red-before-green: this file was run before `DeveloperAudit.tsx` existed
 * and failed with "Failed to resolve import '@/pages/DeveloperAudit'" (see
 * CHANGES.md's TRO-616 entry for the quoted output).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { V1Result } from '@/lib/api';
import { DeveloperAuditPage } from '@/pages/DeveloperAudit';

vi.mock('@/contexts/DeveloperPortalContext', () => ({
  usePortalToken: () => mockUsePortalToken(),
}));

const mockUsePortalToken = vi.fn();

function ok<T>(data: T): V1Result<T> {
  return { ok: true, data };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const APP_CLIENT_ID = 'ship_app_acme';

const oauthAppsBody = {
  success: true,
  data: [
    {
      id: 'app00000-0000-0000-0000-000000000001',
      client_id: APP_CLIENT_ID,
      name: 'Acme Reporting Bot',
      client_type: 'confidential',
      redirect_uris: [],
      requested_scopes: [],
      is_first_party: false,
      created_at: '2026-08-14T00:00:00.000Z',
      revoked_at: null,
      has_secret: true,
    },
  ],
};

function auditRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'aud00000-0000-0000-0000-000000000001',
    request_id: 'req-0001',
    app_client_id: APP_CLIENT_ID,
    user_id: 'user0000-0000-0000-0000-000000000001',
    method: 'GET',
    route: '/api/v1/documents',
    scope_used: 'documents:read',
    status: 200,
    latency_ms: 12,
    created_at: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

function stubOauthAppsFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.includes('/api/oauth-apps')) return jsonResponse(oauthAppsBody);
    throw new Error(`unexpected fetch: ${raw}`);
  });
}

function mockPortal(callV1: (path: string, init?: RequestInit) => Promise<V1Result<unknown>>) {
  mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/developer/audit']}>
      <DeveloperAuditPage />
    </MemoryRouter>
  );
}

describe('DeveloperAuditPage (TRO-616)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', stubOauthAppsFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockUsePortalToken.mockReset();
    vi.restoreAllMocks();
  });

  it('renders audit rows from GET /api/v1/audit in an accessible table', async () => {
    const callV1 = vi.fn(async (path: string) => {
      if (path.startsWith('/audit')) return ok({ data: [auditRow()], next_cursor: null });
      throw new Error(`unexpected callV1: ${path}`);
    });
    mockPortal(callV1);

    renderPage();

    const row = await screen.findByTestId('audit-row');
    expect(within(row).getByText('GET')).toBeInTheDocument();
    expect(within(row).getByText('/api/v1/documents')).toBeInTheDocument();
    expect(within(row).getByText('200')).toBeInTheDocument();
    expect(within(row).getByText('12 ms')).toBeInTheDocument();
    expect(within(row).getByText(APP_CLIENT_ID)).toBeInTheDocument();
    expect(within(row).getByText('documents:read')).toBeInTheDocument();
    expect(within(row).getByText('req-0001')).toBeInTheDocument();

    // First request carries the page size and nothing else (no cursor, no filter).
    expect(callV1.mock.calls[0]?.[0]).toBe('/audit?limit=50');

    // Accessible table: caption + column headers with scope="col".
    const table = screen.getByRole('table', { name: /public api audit log/i });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.length).toBe(9);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
  });

  it('shows an empty state when no rows come back', async () => {
    mockPortal(vi.fn(async () => ok({ data: [], next_cursor: null })));
    renderPage();
    expect(await screen.findByText(/no api calls recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument();
  });

  it('"Load more" requests the server-side next_cursor and appends the page', async () => {
    const pageOne = auditRow({ id: 'aud00000-0000-0000-0000-0000000000p1', request_id: 'req-p1' });
    const pageTwo = auditRow({ id: 'aud00000-0000-0000-0000-0000000000p2', request_id: 'req-p2' });
    const callV1 = vi.fn(async (path: string) => {
      if (path.includes('cursor=')) return ok({ data: [pageTwo], next_cursor: null });
      return ok({ data: [pageOne], next_cursor: 'cursor-abc' });
    });
    mockPortal(callV1);

    renderPage();
    await screen.findByTestId('audit-row');
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);

    const loadMore = screen.getByRole('button', { name: /load more/i });
    await act(async () => {
      fireEvent.click(loadMore);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(2);
    });
    const ids = screen.getAllByTestId('audit-row').map((r) => r.getAttribute('data-audit-id'));
    expect(ids).toEqual([pageOne.id, pageTwo.id]);

    const cursorCall = callV1.mock.calls.find(([path]) => path.includes('cursor=cursor-abc'));
    expect(cursorCall, 'expected a callV1 request carrying the server-issued cursor').toBeDefined();
    // Last page: the button is gone.
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('changing the app filter re-requests with app_client_id (server-side, from page one)', async () => {
    const callV1 = vi.fn(async (_path: string) => ok({ data: [auditRow()], next_cursor: null }));
    mockPortal(callV1);

    renderPage();
    await screen.findByTestId('audit-row');

    // The option list is populated from the internal /api/oauth-apps route.
    const filter = screen.getByLabelText(/filter by app/i);
    await screen.findByRole('option', { name: 'Acme Reporting Bot' });

    await act(async () => {
      fireEvent.change(filter, { target: { value: APP_CLIENT_ID } });
    });

    await waitFor(() => {
      const call = callV1.mock.calls.find(([path]) => path.includes(`app_client_id=${APP_CLIENT_ID}`));
      expect(call, 'expected a callV1 request carrying app_client_id').toBeDefined();
    });
    const filtered = callV1.mock.calls.find(([path]) => path.includes('app_client_id='));
    expect(filtered?.[0]).not.toContain('cursor=');
  });

  it('renders the API error message when /api/v1/audit fails', async () => {
    const callV1 = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'forbidden' as const,
        message: 'Requires a workspace admin, a platform super-admin, or a first-party app credential.',
        request_id: 'req-forbidden',
      },
    }));
    mockPortal(callV1);

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Requires a workspace admin');
    expect(screen.queryByTestId('audit-table')).not.toBeInTheDocument();
  });

  it('surfaces a portal-session error instead of querying', async () => {
    const callV1 = vi.fn();
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: 'mint failed', token: null, principal: null });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not start a developer session: mint failed/i);
    expect(callV1).not.toHaveBeenCalled();
  });
});
