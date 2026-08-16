import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, OAuthApp } from '@/lib/api';
import { ShownOnceSecretModal } from '@/components/ShownOnceSecretModal';
import { cn } from '@/lib/cn';

/**
 * PF-502 (TRO-436) — Developer > Apps: registration + list.
 *
 * Calls the existing internal `/api/oauth-apps` admin endpoints
 * (PF-102/TRO-408, `api/src/routes/oauth-apps.ts`) rather than `/api/v1` —
 * see `DeveloperPortalContext.tsx`'s file header for why: registering an
 * OAuth app is a workspace-admin action with no equivalent in the public
 * scope model, exactly like personal API tokens (`api-tokens.ts`) already
 * work. The portal's /api/v1 traffic (this ticket's dog-fooding proof) is
 * the `/api/v1/me` identity check that context performs on mount, and every
 * future screen that reads real public-API resources.
 */

const REQUESTABLE_SCOPES = [
  'documents:read',
  'documents:write',
  'issues:read',
  'issues:write',
  'sprints:read',
  'sprints:write',
  'webhooks:manage',
];

export function DeveloperAppsPage() {
  const [apps, setApps] = useState<OAuthApp[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const [name, setName] = useState('');
  const [clientType, setClientType] = useState<'confidential' | 'public'>('confidential');
  const [redirectUris, setRedirectUris] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [publicClientNotice, setPublicClientNotice] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    const res = await api.oauthApps.list();
    if (res.success && res.data) {
      setApps(res.data);
      setListError(null);
    } else {
      setListError(res.error?.message ?? 'Failed to load OAuth apps.');
    }
  }, []);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const redirect_uris = redirectUris
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.oauthApps.create({
        name: name.trim(),
        client_type: clientType,
        redirect_uris,
        requested_scopes: scopes,
      });
      if (!res.success || !res.data) {
        setCreateError(res.error?.message ?? 'Failed to register the app.');
        return;
      }

      setName('');
      setRedirectUris('');
      setScopes([]);
      setFormOpen(false);
      await loadApps();

      if (res.data.client_secret) {
        setNewSecret(res.data.client_secret);
      } else {
        setPublicClientNotice(
          `"${res.data.name}" was registered as a public client — it authenticates with PKCE, not a secret.`
        );
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to register the app.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">OAuth apps</h1>
          <p className="mt-1 text-sm text-muted">
            Register an app to get a client ID and secret for the public API — everything a
            third-party integration uses is documented at{' '}
            <code className="font-mono">/api/v1/openapi.json</code>.
          </p>
        </div>
        <button
          onClick={() => setFormOpen((prev) => !prev)}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          aria-expanded={formOpen}
        >
          {formOpen ? 'Cancel' : 'New app'}
        </button>
      </div>

      {publicClientNotice && (
        <div className="mb-6 rounded-md border border-border bg-border/20 p-3 text-sm text-foreground">
          {publicClientNotice}
        </div>
      )}

      {formOpen && (
        <form
          onSubmit={(e) => {
            void handleCreate(e);
          }}
          className="mb-8 space-y-4 rounded-lg border border-border p-5"
        >
          <div>
            <label htmlFor="app-name" className="mb-1 block text-xs text-muted">
              Name
            </label>
            <input
              id="app-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Reporting Bot"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>

          <fieldset>
            <legend className="mb-1 block text-xs text-muted">Client type</legend>
            <div className="flex gap-4 text-sm text-foreground">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="client-type"
                  checked={clientType === 'confidential'}
                  onChange={() => setClientType('confidential')}
                />
                Confidential (server-side, gets a secret)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="client-type"
                  checked={clientType === 'public'}
                  onChange={() => setClientType('public')}
                />
                Public (browser/CLI, PKCE only)
              </label>
            </div>
          </fieldset>

          <div>
            <label htmlFor="app-redirects" className="mb-1 block text-xs text-muted">
              Redirect URIs (one per line)
            </label>
            <textarea
              id="app-redirects"
              value={redirectUris}
              onChange={(e) => setRedirectUris(e.target.value)}
              placeholder="https://example.com/oauth/callback"
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <fieldset>
            <legend className="mb-1 block text-xs text-muted">Requested scopes</legend>
            <div className="grid grid-cols-2 gap-2 text-sm text-foreground">
              {REQUESTABLE_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {createError && <p className="text-sm text-red-500">{createError}</p>}

          <button
            type="submit"
            disabled={creating || !name.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'Registering…' : 'Register app'}
          </button>
        </form>
      )}

      {listError && <p className="mb-4 text-sm text-red-500">{listError}</p>}

      {apps === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted">No OAuth apps registered yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="oauth-app-list">
          {apps.map((app) => (
            <li key={app.id}>
              <Link
                to={`/developer/apps/${app.id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-border/30"
              >
                <div>
                  <p className={cn('font-medium text-foreground', app.revoked_at && 'line-through opacity-60')}>
                    {app.name}
                  </p>
                  <p className="font-mono text-xs text-muted">{app.client_id}</p>
                </div>
                <span className="text-xs text-muted">
                  {app.revoked_at ? 'Revoked' : app.client_type === 'public' ? 'Public' : 'Confidential'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {newSecret && (
        <ShownOnceSecretModal
          open={true}
          title="Save your client secret"
          description="This is the only time the client secret will be shown. Store it in your app's secret manager — Ship never displays it again."
          secret={newSecret}
          onDismiss={() => setNewSecret(null)}
        />
      )}
    </div>
  );
}
