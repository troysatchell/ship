import { useCallback, useEffect, useState } from 'react';
import type { V1Result } from '@/lib/api';
import { api, OAuthApp } from '@/lib/api';
import { usePortalToken } from '@/contexts/DeveloperPortalContext';

/**
 * TRO-616 — Developer > Audit: the public-API audit trail, queryable in the
 * portal (brief p.4: "Every public API call recorded ... Queryable in the
 * developer portal").
 *
 * Reads `GET /api/v1/audit` (`api/src/platform/api/v1/resources/audit.ts`,
 * PF-501/TRO-432) through `usePortalToken()`'s `callV1<T>()` — the portal's
 * own short-lived scoped personal token, which already carries `audit:read`
 * (`DeveloperPortalContext.tsx`'s `PORTAL_TOKEN_SCOPES`). Same "consume the
 * public API like any other client" posture as `DeveloperPortal.tsx`'s
 * delivery log, whose loading/empty/error/"Load more" patterns this file
 * copies deliberately so the two screens read as one portal.
 *
 * The app filter's option list comes from the internal `/api/oauth-apps`
 * route via `api.oauthApps.list()` (session auth) — the same source
 * `DeveloperApps.tsx` and `DeveloperPortal.tsx`'s Subscriptions tab use;
 * there is no public-scope equivalent for "list my workspace's OAuth apps"
 * (see `DeveloperPortalContext.tsx`'s header). The chosen app's `client_id`
 * is forwarded server-side as `?app_client_id=` — the route's own "queryable
 * per app" filter — never filtered client-side.
 *
 * Row shape is declared locally, verified field-for-field against
 * `serializeAuditRow()` in `resources/audit.ts` (same `web`/`sdk` boundary
 * convention `DeveloperPortal.tsx` documents).
 *
 * Note on who can see rows: `GET /api/v1/audit` is admin/owner-scoped on the
 * server (workspace admin, super-admin, or first-party app). A workspace
 * member holding `audit:read` gets a `forbidden` error, which this page
 * surfaces verbatim in its error state rather than hiding the nav entry —
 * the server's message says exactly what's required.
 */

export interface AuditRow {
  readonly id: string;
  readonly request_id: string;
  readonly app_client_id: string | null;
  readonly user_id: string | null;
  readonly method: string;
  readonly route: string;
  readonly scope_used: string | null;
  readonly status: number;
  readonly latency_ms: number;
  readonly created_at: string;
}

interface ListPage<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
}

const PAGE_SIZE = 50;

/** Same omit-empty query builder as `DeveloperPortal.tsx` — an unset filter
 *  produces the exact same URL as never naming the key. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

type CallV1 = <T>(path: string, init?: RequestInit) => Promise<V1Result<T>>;

export function DeveloperAuditPage() {
  const { callV1, loading: tokenLoading, error: tokenError } = usePortalToken();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <h1 className="text-lg font-semibold text-foreground">Audit</h1>
      </header>

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
        {!tokenLoading && !tokenError && <AuditLog callV1={callV1} />}
      </main>
    </div>
  );
}

function statusClass(status: number): string {
  if (status >= 500) return 'text-red-500';
  if (status >= 400) return 'text-yellow-500';
  return 'text-green-500';
}

function AuditLog({ callV1 }: { callV1: CallV1 }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [apps, setApps] = useState<OAuthApp[]>([]);
  const [appFilter, setAppFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // App picker options — internal session-authed route, same as
  // DeveloperApps.tsx. A failure here only degrades the filter (the option
  // list stays empty); it never blocks the audit table itself.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.oauthApps.list();
        if (!cancelled && res.success && res.data) setApps(res.data);
      } catch {
        // Filter degrades to "All apps" only — audit rows still load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadFirstPage = useCallback(
    async (appClientId: string) => {
      setLoading(true);
      setError(null);
      try {
        const query = buildQuery({ limit: PAGE_SIZE, app_client_id: appClientId || undefined });
        const res = await callV1<ListPage<AuditRow>>(`/audit${query}`);
        if (res.ok) {
          setRows([...res.data.data]);
          setNextCursor(res.data.next_cursor);
        } else {
          setRows([]);
          setNextCursor(null);
          setError(res.error.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit log');
      } finally {
        setLoading(false);
      }
    },
    [callV1]
  );

  useEffect(() => {
    void loadFirstPage(appFilter);
  }, [loadFirstPage, appFilter]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const query = buildQuery({ limit: PAGE_SIZE, app_client_id: appFilter || undefined, cursor: nextCursor });
      const res = await callV1<ListPage<AuditRow>>(`/audit${query}`);
      if (res.ok) {
        setRows((prev) => [...prev, ...res.data.data]);
        setNextCursor(res.data.next_cursor);
      } else {
        setError(res.error.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more audit rows');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">Public API audit log</h2>
          <p className="text-xs text-muted mt-0.5">
            One row per <code className="font-mono">/api/v1</code> call, newest first. Filter by app to see
            exactly what one integration did.
          </p>
        </div>
        <div className="w-56">
          <label className="sr-only" htmlFor="audit-app-filter">
            Filter by app
          </label>
          <select
            id="audit-app-filter"
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground"
          >
            <option value="">All apps</option>
            {apps.map((app) => (
              <option key={app.id} value={app.client_id}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-500" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-32 text-sm text-muted" role="status">
          Loading audit log...
        </div>
      ) : rows.length === 0 ? (
        !error && <div className="text-muted text-sm">No API calls recorded yet.</div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full" data-testid="audit-table">
            <caption className="sr-only">Public API audit log, newest first</caption>
            <thead className="bg-border/30">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Time</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Method</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Route</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Status</th>
                <th scope="col" className="px-4 py-3 text-right text-sm font-medium text-muted">Latency</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">App</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">User</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Scope</th>
                <th scope="col" className="px-4 py-3 text-left text-sm font-medium text-muted">Request ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} data-testid="audit-row" data-audit-id={row.id}>
                  <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground font-mono">{row.method}</td>
                  <td className="px-4 py-3 text-sm text-foreground font-mono">{row.route}</td>
                  <td className={`px-4 py-3 text-sm font-mono ${statusClass(row.status)}`}>{row.status}</td>
                  <td className="px-4 py-3 text-sm text-muted text-right whitespace-nowrap">{row.latency_ms} ms</td>
                  <td className="px-4 py-3 text-sm text-muted font-mono">{row.app_client_id ?? '-'}</td>
                  <td className="px-4 py-3 text-sm text-muted font-mono" title={row.user_id ?? undefined}>
                    {row.user_id ?? '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted font-mono">{row.scope_used ?? '-'}</td>
                  <td className="px-4 py-3 text-sm text-muted font-mono">{row.request_id}</td>
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
