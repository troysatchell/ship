/**
 * TRO-439 (PF-503) — the developer portal's Deliveries/DLQ + Subscriptions
 * pages. This is the vitest-tier regression test the factory gate actually
 * runs (`/ship-qa`: an e2e-only spec satisfies the gate's "test added" grep
 * without ever being EXECUTED by it — the real proof has to live here too).
 * `e2e/developer-portal-dlq-replay.spec.ts` covers the same story against a
 * real running server/browser, additively.
 *
 * Reconciled onto TRO-436/PF-502's real `DeveloperPortalProvider`/
 * `usePortalToken()` shell (`@/contexts/DeveloperPortalContext`) once that
 * ticket merged — this file no longer drives the token-minting mechanism
 * itself (that has its own dedicated coverage,
 * `DeveloperPortalContext.test.tsx`) and instead mocks `usePortalToken()`
 * directly, same "test one thing" boundary `DeveloperApps.test.tsx`
 * establishes for the sibling `/developer/apps` screen. Only
 * `api.oauthApps.list()` (a real internal `/api/oauth-apps` GET, used by
 * the Subscriptions tab's app picker) still goes over a stubbed
 * `global.fetch` — everything `/api/v1` goes through the mocked `callV1`.
 *
 * Red-before-green provenance: this is greenfield feature work (no portal
 * UI existed at all before this ticket — confirmed by grepping `web/src`
 * for portal/DLQ/delivery-log/replay before starting, zero hits), so there
 * is no pre-existing buggy BEHAVIOR to assert against the way a bug-fix
 * regression test would. Verified by hand, twice: (1) with
 * `DeveloperPortal.tsx` temporarily removed, this file fails with "Failed
 * to resolve import"; (2) an early `handleDelete` filtered the deleted row
 * out of state instead of marking it Inactive, and the dedicated delete
 * test below failed with `Unable to find an element with the text:
 * Inactive` before that fix landed — see CHANGES.md's TRO-439 entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import type { V1Result } from '@/lib/api';
import { DeveloperPortalPage } from '@/pages/DeveloperPortal';

vi.mock('@/contexts/DeveloperPortalContext', () => ({
  usePortalToken: () => mockUsePortalToken(),
}));

const mockUsePortalToken = vi.fn();

const DEAD_DELIVERY_ID = 'dd000000-0000-0000-0000-000000000006';
const IDEMPOTENCY_KEY = 'idem-key-original-0001';
const SUBSCRIPTION_ID = 'sub00000-0000-0000-0000-000000000001';
const APP_ID = 'app00000-0000-0000-0000-000000000001';
const REPLAYED_DELIVERY_ID = 'dd000000-0000-0000-0000-000000000007';

function ok<T>(data: T): V1Result<T> {
  return { ok: true, data };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const deadDelivery = {
  id: DEAD_DELIVERY_ID,
  subscription_id: SUBSCRIPTION_ID,
  event_id: 'evt00000-0000-0000-0000-000000000001',
  event_type: 'document.created',
  idempotency_key: IDEMPOTENCY_KEY,
  attempt_number: 6,
  status: 'dead',
  response_status: 500,
  response_excerpt: 'Internal Server Error',
  latency_ms: 42,
  next_attempt_at: null,
  replayed_from_id: null,
  created_at: '2026-08-15T00:00:00.000Z',
};

const replayedDelivery = {
  ...deadDelivery,
  id: REPLAYED_DELIVERY_ID,
  attempt_number: 7,
  status: 'success',
  response_status: 200,
  response_excerpt: 'OK',
  replayed_from_id: DEAD_DELIVERY_ID,
  created_at: '2026-08-15T00:05:00.000Z',
};

const activeSubscription = {
  id: SUBSCRIPTION_ID,
  app_id: APP_ID,
  event_type: 'document.created',
  target_url: 'https://example.com/hook',
  active: true,
  created_at: '2026-08-14T00:00:00.000Z',
};

const oauthAppsResponse = jsonResponse({
  success: true,
  data: [
    {
      id: APP_ID,
      client_id: 'ship_app_test',
      name: 'Test App',
      client_type: 'confidential',
      redirect_uris: [],
      requested_scopes: [],
      is_first_party: false,
      created_at: '2026-08-14T00:00:00.000Z',
      revoked_at: null,
      has_secret: true,
    },
  ],
});

/** Stubs `global.fetch` for the one real HTTP call this page still makes
 *  directly: `api.oauthApps.list()` (`GET /api/oauth-apps`, internal, used
 *  by the Subscriptions tab's app picker). Everything `/api/v1` goes
 *  through the mocked `callV1` instead. */
function stubOauthAppsFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.includes('/api/oauth-apps')) return oauthAppsResponse.clone();
    throw new Error(`unexpected fetch: ${raw}`);
  });
}

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/developer/webhooks']}>
      <ToastProvider>
        <DeveloperPortalPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('DeveloperPortalPage (TRO-439 / PF-503)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', stubOauthAppsFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockUsePortalToken.mockReset();
  });

  it('shows a dead-lettered (DLQ) delivery and replaying it succeeds, preserving the original Idempotency-Key', async () => {
    const callV1 = vi.fn(async (path: string) => {
      if (path.includes('/replay')) return ok(replayedDelivery);
      if (path.startsWith('/webhooks/deliveries')) return ok({ data: [deadDelivery], next_cursor: null });
      throw new Error(`unexpected callV1: ${path}`);
    });
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });

    renderPortal();

    // Deliveries & DLQ is the default tab (architect's note: build this
    // before subscription CRUD).
    const row = await screen.findByTestId('delivery-row');
    expect(within(row).getByText('Dead (DLQ)')).toBeInTheDocument();
    expect(row.getAttribute('data-delivery-status')).toBe('dead');

    const replayButton = within(row).getByRole('button', { name: /replay/i });
    await act(async () => {
      fireEvent.click(replayButton);
    });

    // A new row for the replay appears, sharing the SAME idempotency key —
    // the ticket's own AC.
    await waitFor(() => {
      const rows = screen.getAllByTestId('delivery-row');
      expect(rows.length).toBe(2);
    });

    const rows = screen.getAllByTestId('delivery-row');
    const replayedRow = rows.find((r) => r.getAttribute('data-delivery-id') === REPLAYED_DELIVERY_ID);
    if (!replayedRow) throw new Error('expected the replayed row to appear');
    expect(within(replayedRow).getByText('Success')).toBeInTheDocument();

    const originalKeyCell = within(row).getByTitle(IDEMPOTENCY_KEY);
    const replayedKeyCell = within(replayedRow).getByTitle(IDEMPOTENCY_KEY);
    expect(originalKeyCell.textContent).toBe(replayedKeyCell.textContent);

    // The replay endpoint was actually called against the real route.
    const replayCall = callV1.mock.calls.find(([path]) => (path as string).includes(`/webhooks/deliveries/${DEAD_DELIVERY_ID}/replay`));
    expect(replayCall, 'expected a callV1 POST to the real replay route').toBeDefined();
  });

  it('filters the delivery log by status via a server-side query param', async () => {
    const callV1 = vi.fn(async (_path: string) => ok({ data: [deadDelivery], next_cursor: null }));
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });

    renderPortal();
    await screen.findByTestId('delivery-row');

    const filter = screen.getByLabelText(/filter by status/i);
    await act(async () => {
      fireEvent.change(filter, { target: { value: 'dead' } });
    });

    await waitFor(() => {
      const call = callV1.mock.calls.find(([path]) => (path as string).includes('status=dead'));
      expect(call, 'expected a callV1 request carrying status=dead').toBeDefined();
    });
  });

  it('paginates the delivery log server-side via callV1s own cursor, not by fetching everything at once', async () => {
    const pageOneRow = { ...deadDelivery, id: 'dd000000-0000-0000-0000-0000000000p1', status: 'success', response_status: 200 };
    const pageTwoRow = { ...deadDelivery, id: 'dd000000-0000-0000-0000-0000000000p2', status: 'success', response_status: 200 };

    const callV1 = vi.fn(async (path: string) => {
      if (path.startsWith('/webhooks/deliveries')) {
        // Second page is whatever request carries a `cursor` query param —
        // the SERVER-SIDE cursor, not a client-side slice of an
        // already-fetched full list.
        if (path.includes('cursor=')) return ok({ data: [pageTwoRow], next_cursor: null });
        return ok({ data: [pageOneRow], next_cursor: 'opaque-cursor-1' });
      }
      throw new Error(`unexpected callV1: ${path}`);
    });
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });

    renderPortal();

    await screen.findByTestId('delivery-row');
    expect(screen.getAllByTestId('delivery-row')).toHaveLength(1);

    const loadMoreButton = screen.getByRole('button', { name: /load more/i });
    await act(async () => {
      fireEvent.click(loadMoreButton);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('delivery-row')).toHaveLength(2);
    });
    // The second call carried the cursor the first page returned.
    const secondPageCall = callV1.mock.calls.find(([path]) => (path as string).includes('cursor=opaque-cursor-1'));
    expect(secondPageCall, 'expected the second callV1 call to carry the server cursor').toBeDefined();
    // "Load more" disappears once next_cursor comes back null.
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('creates a subscription with the real app_id/event_type/target_url request body and shows the secret once', async () => {
    const callV1 = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/webhooks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        return ok({
          id: 'sub00000-0000-0000-0000-000000000002',
          app_id: body.app_id,
          event_type: body.event_type,
          target_url: body.target_url,
          active: true,
          created_at: '2026-08-15T00:10:00.000Z',
          secret: 'whsec_test_secret_value',
          warning: 'Save this secret now. It will not be shown again.',
        });
      }
      if (path.startsWith('/webhooks/deliveries')) return ok({ data: [], next_cursor: null });
      if (path.startsWith('/webhooks')) return ok({ data: [activeSubscription], next_cursor: null });
      throw new Error(`unexpected callV1: ${path}`);
    });
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });

    renderPortal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /subscriptions/i }));
    });
    await screen.findByRole('button', { name: /create subscription/i });

    fireEvent.change(screen.getByLabelText(/target url/i), { target: { value: 'https://example.com/hook2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create subscription/i }));
    });

    // ShownOnceSecretModal (PF-502/TRO-436's shared component) — a Radix
    // dialog, not the page's own inline banner.
    await screen.findByText('Save your signing secret');
    expect(screen.getByText('whsec_test_secret_value')).toBeInTheDocument();

    const createCall = callV1.mock.calls.find(([path, init]) => path === '/webhooks' && (init as RequestInit | undefined)?.method === 'POST');
    if (!createCall) throw new Error('expected a callV1 POST to /webhooks');
    const [, init] = createCall;
    const sentBody = JSON.parse(String((init as RequestInit).body ?? '{}'));
    // The real server schema (`CreateWebhookSubscriptionRequestSchema`) —
    // NOT the old, broken `{ url, events }` shape (TRO-607/TRO-439 both
    // fixed this independently; see sdk/src/resources/webhooks.ts's header).
    expect(sentBody).toEqual({
      app_id: APP_ID,
      event_type: 'document.created',
      target_url: 'https://example.com/hook2',
    });
  });

  it('deleting a subscription marks it Inactive rather than removing the row (matches the real DELETE route\'s deactivate semantics)', async () => {
    const callV1 = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === `/webhooks/${SUBSCRIPTION_ID}` && init?.method === 'DELETE') return ok(null);
      if (path.startsWith('/webhooks/deliveries')) return ok({ data: [], next_cursor: null });
      if (path.startsWith('/webhooks')) return ok({ data: [activeSubscription], next_cursor: null });
      throw new Error(`unexpected callV1: ${path}`);
    });
    mockUsePortalToken.mockReturnValue({ callV1, loading: false, error: null, token: 'test-token', principal: null });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPortal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /subscriptions/i }));
    });

    const row = await screen.findByTestId('subscription-row');
    expect(within(row).getByText('Active')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: /delete/i }));
    });

    await waitFor(() => {
      expect(within(row).getByText('Inactive')).toBeInTheDocument();
    });
    // Row still present — not filtered out of the list.
    expect(screen.getAllByTestId('subscription-row')).toHaveLength(1);

    const deleteCall = callV1.mock.calls.find(([path, init]) => path === `/webhooks/${SUBSCRIPTION_ID}` && (init as RequestInit | undefined)?.method === 'DELETE');
    expect(deleteCall, 'expected a callV1 DELETE to the real subscription route').toBeDefined();

    confirmSpy.mockRestore();
  });

  it('surfaces a portal session error instead of rendering the tabs', () => {
    mockUsePortalToken.mockReturnValue({
      callV1: vi.fn(),
      loading: false,
      error: 'Failed to mint a portal session token.',
      token: null,
      principal: null,
    });

    renderPortal();

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to mint a portal session token.');
  });
});
