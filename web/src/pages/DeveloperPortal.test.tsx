/**
 * TRO-439 (PF-503) — the developer portal's Deliveries/DLQ + Subscriptions
 * pages. This is the vitest-tier regression test the factory gate actually
 * runs (`/ship-qa`: an e2e-only spec satisfies the gate's "test added" grep
 * without ever being EXECUTED by it — the real proof has to live here too).
 * `e2e/developer-portal-dlq-replay.spec.ts` covers the same story against a
 * real running server/browser, additively.
 *
 * Red-before-green provenance: this is greenfield feature work (no portal
 * UI existed at all before this ticket — confirmed by grepping `web/src`
 * for portal/DLQ/delivery-log/replay before starting, zero hits), so there
 * is no pre-existing buggy BEHAVIOR to assert against the way a bug-fix
 * regression test would. The legitimate form of "red" here is the one
 * `/ship-qa` names as disqualifying for a BUG FIX but is simply what
 * greenfield code looks like pre-implementation: run against a worktree
 * with `DeveloperPortal.tsx`/`useDeveloperPortalToken.ts` removed, this
 * file fails with "Failed to resolve import" — verified by hand before
 * writing the implementation (see this ticket's CHANGES.md entry). The
 * assertions themselves (idempotency-key preservation across replay, the
 * real `app_id`/`event_type`/`target_url` request body, the status-filter
 * query param) are what catch a FUTURE regression once this ticket merges.
 *
 * No real network: every `fetch` call this component chain makes — the
 * session-authed `POST /api/api-tokens` (token mint), `DELETE
 * /api/api-tokens/:id` (revoke on unmount), and the real `@ship/sdk`
 * `WebhooksClient`'s calls to `/api/v1/webhooks*` — goes through one stubbed
 * `global.fetch`, matched by URL/method. This exercises the REAL
 * `useDeveloperPortalToken` hook and the REAL `ShipClient`/`WebhooksClient`
 * code (not a mocked SDK), same "mock the network boundary, not our own
 * code" convention `CommandPalette.test.tsx` already establishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { clearCsrfToken } from '@/lib/api';
import { DeveloperPortalPage } from '@/pages/DeveloperPortal';

const DEAD_DELIVERY_ID = 'dd000000-0000-0000-0000-000000000006';
const IDEMPOTENCY_KEY = 'idem-key-original-0001';
const SUBSCRIPTION_ID = 'sub00000-0000-0000-0000-000000000001';
const APP_ID = 'app00000-0000-0000-0000-000000000001';
const REPLAYED_DELIVERY_ID = 'dd000000-0000-0000-0000-000000000007';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlPath(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, 'http://localhost');
  return url.pathname + url.search;
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

let tokenCounter = 0;

function installFetchMock() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = urlPath(input);

    if (path === '/api/csrf-token') {
      return jsonResponse({ token: 'test-csrf-token' });
    }

    if (path === '/api/api-tokens' && method === 'POST') {
      tokenCounter += 1;
      return jsonResponse(
        {
          success: true,
          data: {
            id: `minted-token-${tokenCounter}`,
            name: 'Developer Portal session',
            token: `ship_test_${tokenCounter}`,
            token_prefix: 'ship_test_',
            expires_at: null,
            created_at: '2026-08-15T00:00:00.000Z',
            scopes: ['webhooks:manage'],
            warning: 'Save this token now. It will not be shown again.',
          },
        },
        201
      );
    }

    if (path.startsWith('/api/api-tokens/') && method === 'DELETE') {
      return jsonResponse({ success: true, data: { message: 'API token revoked' } });
    }

    if (path.startsWith('/api/v1/webhooks/deliveries') && path.includes('/replay') && method === 'POST') {
      return jsonResponse(replayedDelivery, 201);
    }

    if (path.startsWith('/api/v1/webhooks/deliveries') && method === 'GET') {
      return jsonResponse({ data: [deadDelivery], next_cursor: null });
    }

    if (path === '/api/oauth-apps' && method === 'GET') {
      return jsonResponse({
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
    }

    if (path.startsWith('/api/v1/webhooks') && method === 'GET') {
      return jsonResponse({ data: [activeSubscription], next_cursor: null });
    }

    if (path === `/api/v1/webhooks/${SUBSCRIPTION_ID}` && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    if (path === '/api/v1/webhooks' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return jsonResponse(
        {
          id: 'sub00000-0000-0000-0000-000000000002',
          app_id: body.app_id,
          event_type: body.event_type,
          target_url: body.target_url,
          active: true,
          created_at: '2026-08-15T00:10:00.000Z',
          secret: 'whsec_test_secret_value',
          warning: 'Save this secret now. It will not be shown again.',
        },
        201
      );
    }

    throw new Error(`unexpected fetch: ${method} ${path}`);
  });
}

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/settings/developer']}>
      <ToastProvider>
        <DeveloperPortalPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('DeveloperPortalPage (TRO-439 / PF-503)', () => {
  beforeEach(() => {
    clearCsrfToken();
    tokenCounter = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a dead-lettered (DLQ) delivery and replaying it succeeds, preserving the original Idempotency-Key', async () => {
    const fetchSpy = installFetchMock();
    vi.stubGlobal('fetch', fetchSpy);

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
    const replayCall = fetchSpy.mock.calls.find(([input]) =>
      urlPath(input as string).includes(`/api/v1/webhooks/deliveries/${DEAD_DELIVERY_ID}/replay`)
    );
    expect(replayCall, 'expected a POST to the real replay route').toBeDefined();
  });

  it('filters the delivery log by status via a server-side query param', async () => {
    const fetchSpy = installFetchMock();
    vi.stubGlobal('fetch', fetchSpy);

    renderPortal();
    await screen.findByTestId('delivery-row');

    const filter = screen.getByLabelText(/filter by status/i);
    await act(async () => {
      fireEvent.change(filter, { target: { value: 'dead' } });
    });

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([input]) => urlPath(input as string).includes('status=dead'));
      expect(call, 'expected a request carrying status=dead').toBeDefined();
    });
  });

  it('paginates the delivery log server-side via the SDK cursor, not by fetching everything at once', async () => {
    const pageOneRow = { ...deadDelivery, id: 'dd000000-0000-0000-0000-0000000000p1', status: 'success', response_status: 200 };
    const pageTwoRow = { ...deadDelivery, id: 'dd000000-0000-0000-0000-0000000000p2', status: 'success', response_status: 200 };

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = urlPath(input);

      if (path === '/api/csrf-token') return jsonResponse({ token: 'test-csrf-token' });
      if (path === '/api/api-tokens' && method === 'POST') {
        return jsonResponse(
          {
            success: true,
            data: {
              id: 'minted-token-pagination',
              name: 'Developer Portal session',
              token: 'ship_test_pagination',
              token_prefix: 'ship_test_',
              expires_at: null,
              created_at: '2026-08-15T00:00:00.000Z',
              scopes: ['webhooks:manage'],
              warning: 'Save this token now. It will not be shown again.',
            },
          },
          201
        );
      }
      if (path.startsWith('/api/api-tokens/') && method === 'DELETE') {
        return jsonResponse({ success: true, data: { message: 'API token revoked' } });
      }
      if (path.startsWith('/api/v1/webhooks/deliveries') && method === 'GET') {
        // Second page is whatever request carries a `cursor` query param —
        // the SERVER-SIDE cursor `listDeliveries()` sends, not a client-side
        // slice of an already-fetched full list.
        if (path.includes('cursor=')) {
          return jsonResponse({ data: [pageTwoRow], next_cursor: null });
        }
        return jsonResponse({ data: [pageOneRow], next_cursor: 'opaque-cursor-1' });
      }

      throw new Error(`unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    renderPortal();

    await screen.findByTestId('delivery-row');
    expect(screen.getAllByTestId('delivery-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /replay delivery dd000000/i })).not.toBeNull();

    const loadMoreButton = screen.getByRole('button', { name: /load more/i });
    await act(async () => {
      fireEvent.click(loadMoreButton);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('delivery-row')).toHaveLength(2);
    });
    // The second page's request carried the cursor the first page returned.
    const secondPageCall = fetchSpy.mock.calls.find(([input]) => urlPath(input as string).includes('cursor=opaque-cursor-1'));
    expect(secondPageCall, 'expected the second request to carry the server cursor').toBeDefined();
    // "Load more" disappears once next_cursor comes back null.
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('creates a subscription with the real app_id/event_type/target_url request body and shows the secret once', async () => {
    const fetchSpy = installFetchMock();
    vi.stubGlobal('fetch', fetchSpy);

    renderPortal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /subscriptions/i }));
    });
    await screen.findByRole('button', { name: /create subscription/i });

    fireEvent.change(screen.getByLabelText(/target url/i), { target: { value: 'https://example.com/hook2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create subscription/i }));
    });

    const secretBanner = await screen.findByTestId('subscription-secret-banner');
    expect(secretBanner.textContent).toContain('whsec_test_secret_value');

    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) => urlPath(input as string) === '/api/v1/webhooks' && (init?.method ?? 'GET') === 'POST'
    );
    if (!createCall) throw new Error('expected a POST to /api/v1/webhooks');
    const [, init] = createCall;
    const sentBody = JSON.parse(String(init?.body ?? '{}'));
    // The real server schema (`CreateWebhookSubscriptionRequestSchema`) —
    // NOT the old, broken `{ url, events }` shape (TRO-439 fixed the SDK's
    // `CreateWebhookSubscriptionBody`; see sdk/src/resources/webhooks.ts).
    expect(sentBody).toEqual({
      app_id: APP_ID,
      event_type: 'document.created',
      target_url: 'https://example.com/hook2',
    });
  });

  it('deleting a subscription marks it Inactive rather than removing the row (matches the real DELETE route\'s deactivate semantics)', async () => {
    const fetchSpy = installFetchMock();
    vi.stubGlobal('fetch', fetchSpy);
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

    const deleteCall = fetchSpy.mock.calls.find(
      ([input, init]) => urlPath(input as string) === `/api/v1/webhooks/${SUBSCRIPTION_ID}` && (init?.method ?? 'GET') === 'DELETE'
    );
    expect(deleteCall, 'expected a DELETE to the real subscription route').toBeDefined();

    confirmSpy.mockRestore();
  });
});
