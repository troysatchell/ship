import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { V1Result } from '@/lib/api';
import { api, OAuthApp } from '@/lib/api';
import { usePortalToken } from '@/contexts/DeveloperPortalContext';
import { ShownOnceSecretModal } from '@/components/ShownOnceSecretModal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';

/**
 * TRO-439 (PF-503) — the developer portal's Deliveries/DLQ + Subscriptions
 * pages. Per the architect's note (Linear, TRO-443's written rationale):
 * build delivery log + DLQ + replay FIRST, subscription CRUD second — this
 * file follows that order (the `'deliveries'` tab is the default; the
 * component below it is `DeliveriesTab`, listed first).
 *
 * Mounted at `/developer/webhooks`, inside TRO-436/PF-502's real
 * `DeveloperPortalProvider` subtree (`main.tsx`) — a sibling of that
 * ticket's `apps`/`apps/:id` routes, reachable via `DeveloperSidebar.tsx`'s
 * `DEVELOPER_NAV` entry. This was originally built (before TRO-436 landed)
 * as a standalone `/settings/developer` placeholder with its own local
 * token-minting hook; reconciled once TRO-436 merged — see CHANGES.md's
 * TRO-439 entry for the history.
 *
 * Every webhook read/write below goes through `usePortalToken()`'s
 * `callV1<T>()` (`DeveloperPortalContext.tsx`) against `/api/v1`,
 * authenticated with the shared short-lived scoped personal token that
 * context mints once per mount of the whole `/developer/*` subtree —
 * PLUGFORGE.MD §2.9's binding requirement: "consumes the public API like
 * any other client." Nothing in this file calls an internal
 * `/api/webhooks*` route directly (no such route exists — PF-302/305/306
 * only ever registered under `/api/v1`). Response/request field shapes
 * below are declared locally (not imported from `@ship/sdk`) — this
 * codebase's own established convention for the `web`/`sdk` package
 * boundary (see `sdk/src/types.ts`'s header: "duplicated rather than
 * imported... zero-runtime/zero-workspace-dependency"), and consistent with
 * how `web/src/lib/api.ts` already declares its own `OAuthApp`/`ApiToken`
 * rather than importing `@ship/sdk`'s equivalents. Verified field-for-field
 * against `serializeSubscription()`/`serializeDelivery()`
 * (`api/src/platform/api/v1/resources/webhooks.ts`) — the same source of
 * truth `@ship/sdk`'s own `resources/webhooks.ts` verified against.
 */

export type WebhookEventType =
  | 'document.created'
  | 'document.updated'
  | 'document.deleted'
  | 'issue.created'
  | 'issue.assigned'
  | 'issue.status_changed'
  | 'sprint.started'
  | 'sprint.completed';

const EVENT_TYPES: readonly WebhookEventType[] = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
];

export interface WebhookSubscription {
  readonly id: string;
  readonly app_id: string;
  readonly event_type: WebhookEventType;
  readonly target_url: string;
  readonly active: boolean;
  readonly created_at: string;
}

export interface CreatedWebhookSubscription extends WebhookSubscription {
  readonly secret: string;
  readonly warning: string;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly subscription_id: string;
  readonly event_id: string;
  readonly event_type: WebhookEventType;
  readonly idempotency_key: string;
  readonly attempt_number: number;
  readonly status: 'pending' | 'success' | 'failed' | 'dead';
  readonly response_status: number | null;
  readonly response_excerpt: string | null;
  readonly latency_ms: number | null;
  readonly next_attempt_at: string | null;
  readonly replayed_from_id: string | null;
  readonly created_at: string;
}

interface ListPage<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
}

/** Builds a `?a=b&c=d` query string, omitting any `undefined`/empty value —
 *  same "an omitted optional param produces the exact same URL as never
 *  naming the key" convention `@ship/sdk`'s `RequestClient.buildUrl()`
 *  follows for the identical list endpoints. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

type CallV1 = <T>(path: string, init?: RequestInit) => Promise<V1Result<T>>;

type Tab = 'deliveries' | 'subscriptions';
const VALID_TABS: Tab[] = ['deliveries', 'subscriptions'];

const STATUS_FILTERS: Array<{ value: WebhookDelivery['status'] | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed (retrying)' },
  { value: 'dead', label: 'Dead (DLQ)' },
];

export function DeveloperPortalPage() {
  const { callV1, loading: tokenLoading, error: tokenError } = usePortalToken();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') as Tab | null;
  const activeTab: Tab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'deliveries';

  const handleTabChange = useCallback(
    (tab: Tab) => {
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams]
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <h1 className="text-lg font-semibold text-foreground">Webhooks</h1>
      </header>

      <div className="border-b border-border">
        <nav className="flex px-6">
          <TabButton active={activeTab === 'deliveries'} onClick={() => handleTabChange('deliveries')}>
            Deliveries &amp; DLQ
          </TabButton>
          <TabButton active={activeTab === 'subscriptions'} onClick={() => handleTabChange('subscriptions')}>
            Subscriptions
          </TabButton>
        </nav>
      </div>

      <main className="flex-1 overflow-auto p-6 pb-20">
        {tokenLoading && (
          <div className="flex items-center justify-center h-32 text-sm text-muted" role="status">
            Setting up developer session...
          </div>
        )}
        {!tokenLoading && tokenError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-500" role="alert">
            Could not start a developer session: {tokenError}
          </div>
        )}
        {!tokenLoading && !tokenError && (
          <>
            {activeTab === 'deliveries' && <DeliveriesTab callV1={callV1} />}
            {activeTab === 'subscriptions' && <SubscriptionsTab callV1={callV1} />}
          </>
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
        active ? 'border-accent text-foreground' : 'border-transparent text-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

const STATUS_BADGE_CLASSES: Record<WebhookDelivery['status'], string> = {
  pending: 'bg-blue-500/15 text-blue-500',
  success: 'bg-green-500/15 text-green-500',
  failed: 'bg-yellow-500/15 text-yellow-500',
  dead: 'bg-red-500/15 text-red-500',
};

const STATUS_BADGE_LABELS: Record<WebhookDelivery['status'], string> = {
  pending: 'Pending',
  success: 'Success',
  failed: 'Failed',
  dead: 'Dead (DLQ)',
};

function StatusBadge({ status }: { status: WebhookDelivery['status'] }) {
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', STATUS_BADGE_CLASSES[status])}>
      {STATUS_BADGE_LABELS[status]}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Deliveries & DLQ (priority 1 per the architect's note — see file header)
// ─────────────────────────────────────────────────────────────────────────

function DeliveriesTab({ callV1 }: { callV1: CallV1 }) {
  const { showToast } = useToast();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<WebhookDelivery['status'] | ''>('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const loadFirstPage = useCallback(
    async (status: WebhookDelivery['status'] | '') => {
      setLoading(true);
      try {
        const query = buildQuery({ limit: 20, status: status || undefined });
        const res = await callV1<ListPage<WebhookDelivery>>(`/webhooks/deliveries${query}`);
        if (res.ok) {
          setDeliveries([...res.data.data]);
          setNextCursor(res.data.next_cursor);
        } else {
          showToast(res.error.message, 'error');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to load deliveries', 'error');
      } finally {
        setLoading(false);
      }
    },
    [callV1, showToast]
  );

  useEffect(() => {
    void loadFirstPage(statusFilter);
  }, [loadFirstPage, statusFilter]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const query = buildQuery({ limit: 20, status: statusFilter || undefined, cursor: nextCursor });
      const res = await callV1<ListPage<WebhookDelivery>>(`/webhooks/deliveries${query}`);
      if (res.ok) {
        setDeliveries((prev) => [...prev, ...res.data.data]);
        setNextCursor(res.data.next_cursor);
      } else {
        showToast(res.error.message, 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load more deliveries', 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleReplay(delivery: WebhookDelivery) {
    setReplayingId(delivery.id);
    try {
      const res = await callV1<WebhookDelivery>(`/webhooks/deliveries/${encodeURIComponent(delivery.id)}/replay`, {
        method: 'POST',
      });
      if (res.ok) {
        // Prepend the new row — it shares this delivery's idempotency_key
        // (`res.data.idempotency_key === delivery.idempotency_key`, PF-306's
        // own contract) and links back via `replayed_from_id`.
        setDeliveries((prev) => [res.data, ...prev]);
        showToast(
          res.data.status === 'success'
            ? 'Replay succeeded'
            : `Replay recorded (status: ${STATUS_BADGE_LABELS[res.data.status]})`,
          res.data.status === 'success' ? 'success' : 'info'
        );
      } else {
        showToast(res.error.message, 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Replay failed', 'error');
    } finally {
      setReplayingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">Delivery log</h2>
          <p className="text-xs text-muted mt-0.5">
            One row per delivery attempt. Filter by status to find dead-lettered deliveries (the DLQ) and replay them.
          </p>
        </div>
        <div className="w-48">
          <label className="sr-only" htmlFor="delivery-status-filter">
            Filter by status
          </label>
          <select
            id="delivery-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as WebhookDelivery['status'] | '')}
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground"
          >
            {STATUS_FILTERS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32 text-sm text-muted" role="status">
          Loading deliveries...
        </div>
      ) : deliveries.length === 0 ? (
        <div className="text-muted text-sm">No deliveries match this filter.</div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full" data-testid="deliveries-table">
            <thead className="bg-border/30">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Event</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Attempt</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Response</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Idempotency key</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Replayed from</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Created</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <tr key={delivery.id} data-testid="delivery-row" data-delivery-id={delivery.id} data-delivery-status={delivery.status}>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">{delivery.event_type}</td>
                  <td className="px-4 py-3 text-sm text-muted">{delivery.attempt_number}</td>
                  <td className="px-4 py-3 text-sm text-muted">{delivery.response_status ?? '-'}</td>
                  <td className="px-4 py-3 text-sm text-muted font-mono" title={delivery.idempotency_key}>
                    {shortId(delivery.idempotency_key)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted font-mono">
                    {delivery.replayed_from_id ? shortId(delivery.replayed_from_id) : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                    {new Date(delivery.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => {
                        void handleReplay(delivery);
                      }}
                      disabled={replayingId === delivery.id}
                      className="text-sm text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
                      aria-label={`Replay delivery ${shortId(delivery.id)}`}
                    >
                      {replayingId === delivery.id ? 'Replaying...' : 'Replay'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <button
            onClick={() => {
              void handleLoadMore();
            }}
            disabled={loadingMore}
            className="px-4 py-2 text-sm text-foreground border border-border rounded-md hover:bg-border/30 disabled:opacity-50 transition-colors"
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Subscriptions CRUD (priority 2 per the architect's note)
// ─────────────────────────────────────────────────────────────────────────

function SubscriptionsTab({ callV1 }: { callV1: CallV1 }) {
  const { showToast } = useToast();
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [apps, setApps] = useState<OAuthApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [appId, setAppId] = useState('');
  const [eventType, setEventType] = useState<WebhookEventType>('document.created');
  const [targetUrl, setTargetUrl] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [subsRes, appsRes] = await Promise.all([
        callV1<ListPage<WebhookSubscription>>(`/webhooks${buildQuery({ limit: 50 })}`),
        api.oauthApps.list(),
      ]);
      if (subsRes.ok) {
        setSubscriptions([...subsRes.data.data]);
      } else {
        showToast(subsRes.error.message, 'error');
      }
      if (appsRes.success && appsRes.data) {
        setApps(appsRes.data);
        setAppId((prev) => prev || appsRes.data?.[0]?.id || '');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load subscriptions', 'error');
    } finally {
      setLoading(false);
    }
  }, [callV1, showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!appId || !targetUrl.trim()) return;

    setCreating(true);
    try {
      const res = await callV1<CreatedWebhookSubscription>('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ app_id: appId, event_type: eventType, target_url: targetUrl.trim() }),
      });
      if (res.ok) {
        setSubscriptions((prev) => [res.data, ...prev]);
        setNewSecret(res.data.secret);
        setTargetUrl('');
        showToast('Subscription created', 'success');
      } else {
        showToast(res.error.message, 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create subscription', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this webhook subscription? This cannot be undone.')) return;
    try {
      const res = await callV1<null>(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast(res.error.message, 'error');
        return;
      }
      // The real `DELETE /:id` route DEACTIVATES (`active = false`) rather
      // than hard-deleting (`webhooks.ts`'s own header) — history stays
      // queryable for the delivery log/DLQ. Mirror that here: mark the row
      // inactive rather than removing it from the list, same as
      // `WorkspaceSettings.tsx`'s `ApiTokensTab` keeping a revoked token
      // visible with a "Revoked" badge instead of dropping the row. An
      // earlier version of this handler filtered the row out entirely,
      // which disagreed with this component's own `sub.active` rendering
      // below and failed `e2e/developer-portal-dlq-replay.spec.ts`'s CRUD
      // test (caught red before merge).
      setSubscriptions((prev) => prev.map((s) => (s.id === id ? { ...s, active: false } : s)));
      showToast('Subscription deleted', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete subscription', 'error');
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-foreground mb-1">Create subscription</h3>
          <p className="text-xs text-muted">
            Register a new webhook subscription for one of your workspace&apos;s apps.
          </p>
        </div>

        {apps.length === 0 && !loading ? (
          <p className="text-xs text-muted">
            No apps registered in this workspace yet. <a href="/developer/apps" className="text-accent underline">Register an app</a> before creating a subscription.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              void handleCreate(e);
            }}
            className="flex flex-wrap gap-3 items-end"
          >
            <div className="w-56">
              <label className="block text-xs text-muted mb-1" htmlFor="subscription-app">
                App
              </label>
              <select
                id="subscription-app"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground"
                required
              >
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-56">
              <label className="block text-xs text-muted mb-1" htmlFor="subscription-event-type">
                Event type
              </label>
              <select
                id="subscription-event-type"
                value={eventType}
                onChange={(e) => setEventType(e.target.value as WebhookEventType)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground"
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-64">
              <label className="block text-xs text-muted mb-1" htmlFor="subscription-target-url">
                Target URL
              </label>
              <input
                id="subscription-target-url"
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://example.com/webhooks/ship"
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                required
              />
            </div>
            <button
              type="submit"
              disabled={creating || !appId || !targetUrl.trim()}
              className="px-4 py-2 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating...' : 'Create subscription'}
            </button>
          </form>
        )}
      </div>

      {/* Shared shown-once secret UX (PF-502/TRO-436) — same component
        * app registration/secret rotation use, so this signing secret gets
        * the identical warn-before-close treatment. */}
      <ShownOnceSecretModal
        open={newSecret !== null}
        title="Save your signing secret"
        description="This is the only time this webhook subscription's signing secret will be shown."
        secret={newSecret ?? ''}
        onDismiss={() => setNewSecret(null)}
      />

      {loading ? (
        <div className="flex items-center justify-center h-32 text-sm text-muted" role="status">
          Loading subscriptions...
        </div>
      ) : subscriptions.length === 0 ? (
        <div className="text-muted text-sm">No webhook subscriptions yet</div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full" data-testid="subscriptions-table">
            <thead className="bg-border/30">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Event type</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Target URL</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted">Created</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {subscriptions.map((sub) => (
                <tr key={sub.id} data-testid="subscription-row" className={sub.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3 text-sm text-foreground">{sub.event_type}</td>
                  <td className="px-4 py-3 text-sm text-muted font-mono truncate max-w-xs" title={sub.target_url}>
                    {sub.target_url}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {sub.active ? (
                      <span className="text-green-500">Active</span>
                    ) : (
                      <span className="text-muted">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                    {new Date(sub.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {sub.active && (
                      <button
                        onClick={() => {
                          void handleDelete(sub.id);
                        }}
                        className="text-sm text-red-500 hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
