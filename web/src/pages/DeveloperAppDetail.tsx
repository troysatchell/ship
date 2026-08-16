import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, OAuthApp } from '@/lib/api';
import { ShownOnceSecretModal } from '@/components/ShownOnceSecretModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * PF-502 (TRO-436) — Developer > Apps > detail: redirect URIs, scopes,
 * rotate (shown-once, per DeveloperApps.tsx's registration flow), revoke.
 * Same `/api/oauth-apps` internal admin surface as the list/registration
 * screen — see that file's header for the /api/v1 boundary rationale.
 */
export function DeveloperAppDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [app, setApp] = useState<OAuthApp | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const loadApp = useCallback(async () => {
    if (!id) return;
    const res = await api.oauthApps.get(id);
    if (res.success && res.data) {
      setApp(res.data);
      setLoadError(null);
    } else if (res.error?.code === 'NOT_FOUND') {
      setNotFound(true);
    } else {
      setLoadError(res.error?.message ?? 'Failed to load this app.');
    }
  }, [id]);

  useEffect(() => {
    void loadApp();
  }, [loadApp]);

  async function handleRotate() {
    if (!id) return;
    setRotating(true);
    setRotateError(null);
    try {
      const res = await api.oauthApps.rotateSecret(id);
      if (res.success && res.data) {
        setNewSecret(res.data.client_secret);
      } else {
        setRotateError(res.error?.message ?? 'Failed to rotate the client secret.');
      }
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate the client secret.');
    } finally {
      setRotating(false);
    }
  }

  async function handleRevoke() {
    if (!id) return;
    setRevoking(true);
    try {
      const res = await api.oauthApps.revoke(id);
      if (res.success) {
        setRevokeConfirmOpen(false);
        void navigate('/developer/apps');
      } else if (res.error?.message) {
        setRevokeConfirmOpen(false);
        setLoadError(res.error.message);
      }
    } finally {
      setRevoking(false);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <p className="text-sm text-muted">This app doesn't exist, or has been removed.</p>
        <Link to="/developer/apps" className="mt-2 inline-block text-sm text-accent hover:underline">
          &larr; Back to apps
        </Link>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        {loadError ? <p className="text-sm text-red-500">{loadError}</p> : <p className="text-sm text-muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link to="/developer/apps" className="mb-4 inline-block text-sm text-accent hover:underline">
        &larr; Back to apps
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{app.name}</h1>
          <p className="mt-1 font-mono text-sm text-muted">{app.client_id}</p>
        </div>
        <span className="rounded-full bg-border/40 px-2.5 py-1 text-xs text-foreground">
          {app.revoked_at ? 'Revoked' : app.client_type === 'public' ? 'Public client' : 'Confidential client'}
        </span>
      </div>

      <dl className="space-y-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Redirect URIs</dt>
          <dd className="mt-1">
            {app.redirect_uris.length === 0 ? (
              <span className="text-muted">None registered</span>
            ) : (
              <ul className="space-y-1 font-mono text-xs text-foreground">
                {app.redirect_uris.map((uri) => (
                  <li key={uri} className="break-all">{uri}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Requested scopes</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {app.requested_scopes.length === 0 ? (
              <span className="text-muted">None</span>
            ) : (
              app.requested_scopes.map((scope) => (
                <span key={scope} className="rounded bg-border/40 px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {scope}
                </span>
              ))
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Created</dt>
          <dd className="mt-1 text-foreground">{new Date(app.created_at).toLocaleString()}</dd>
        </div>
      </dl>

      {!app.revoked_at && (
        <div className="mt-8 space-y-3 border-t border-border pt-6">
          {app.client_type === 'confidential' && (
            <div>
              <button
                onClick={() => {
                  void handleRotate();
                }}
                disabled={rotating}
                className="rounded-md bg-border px-4 py-2 text-sm font-medium text-foreground hover:bg-border/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rotating ? 'Rotating…' : 'Rotate secret'}
              </button>
              <p className="mt-1 text-xs text-muted">
                The previous secret stops working immediately — there is no grace period.
              </p>
              {rotateError && <p className="mt-1 text-sm text-red-500">{rotateError}</p>}
            </div>
          )}

          <div>
            <button
              onClick={() => setRevokeConfirmOpen(true)}
              className="rounded-md bg-red-600/10 px-4 py-2 text-sm font-medium text-red-500 hover:bg-red-600/20"
            >
              Revoke app
            </button>
          </div>
        </div>
      )}

      {newSecret && (
        <ShownOnceSecretModal
          open={true}
          title="Save your new client secret"
          description="This is the only time the new client secret will be shown. Update your app's secret manager now — the previous secret no longer works."
          secret={newSecret}
          onDismiss={() => setNewSecret(null)}
        />
      )}

      <ConfirmDialog
        open={revokeConfirmOpen}
        title="Revoke this app?"
        description={`"${app.name}" will immediately lose access — any tokens it holds stop working. This cannot be undone.`}
        confirmLabel={revoking ? 'Revoking…' : 'Revoke'}
        variant="destructive"
        onConfirm={() => {
          void handleRevoke();
        }}
        onCancel={() => setRevokeConfirmOpen(false)}
      />
    </div>
  );
}
