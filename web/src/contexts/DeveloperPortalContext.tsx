import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, v1Request, type V1Result } from '@/lib/api';

/**
 * PF-502 (TRO-436) — the portal's own public-API identity.
 *
 * PLUGFORGE.MD §2.9: "on entry it mints a short-lived scoped personal token
 * via the api_tokens mechanism ... session-authed, and uses it for /api/v1
 * calls. The portal is a public-API client, dog-fooding is the point."
 *
 * Scope of what actually goes through /api/v1 vs. what stays internal
 * (documented once here rather than re-litigated per screen): OAuth *app*
 * registration/rotation (`DeveloperApps.tsx`) calls the existing internal
 * `/api/oauth-apps` admin endpoints (PF-102/TRO-408) — the public scope
 * model has no "manage my workspace's OAuth apps" scope, and inventing one
 * would duplicate already-reviewed backend work for no reason. What this
 * context provides IS genuinely used for /api/v1 traffic: the `GET /api/v1/me`
 * identity check below (network-tab evidence that the mechanism works), and
 * every future portal screen that reads real public-API resources — the
 * subscriptions/delivery-log/DLQ/replay screens (PF-503) are the ones that
 * actually spend this token on document data.
 *
 * Minted once per mount of the `/developer/*` route subtree (not per screen)
 * and held only in memory — never localStorage — matching "short-lived."
 */

const PORTAL_TOKEN_SCOPES = [
  'documents:read',
  'documents:write',
  'issues:read',
  'issues:write',
  'sprints:read',
  'sprints:write',
  'webhooks:manage',
  'audit:read',
];

interface V1Principal {
  user: { id: string; email: string; name: string } | null;
  app: { id: string; client_id: string; name: string } | null;
  scopes: string[];
}

interface DeveloperPortalValue {
  /** Null until minting completes; never persisted, never re-fetchable once cleared. */
  token: string | null;
  loading: boolean;
  error: string | null;
  principal: V1Principal | null;
  /** Bearer-authed call against /api/v1/*, using this session's minted token. */
  callV1: <T>(path: string, init?: RequestInit) => Promise<V1Result<T>>;
}

const DeveloperPortalContext = createContext<DeveloperPortalValue | null>(null);

export function DeveloperPortalProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<V1Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // StrictMode / route-remount guard: mint exactly once per provider lifetime,
  // not once per effect run.
  const mintedRef = useRef(false);

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;

    let cancelled = false;

    async function mint() {
      try {
        const res = await api.apiTokens.create({
          name: `Ship Developer Portal (${new Date().toISOString().slice(0, 16)})`,
          expires_in_days: 1,
          scopes: PORTAL_TOKEN_SCOPES,
        });
        if (cancelled) return;
        if (!res.success || !res.data) {
          setError(res.error?.message ?? 'Failed to mint a portal session token.');
          setLoading(false);
          return;
        }
        const mintedToken = res.data.token;
        setToken(mintedToken);

        const me = await v1Request<V1Principal>(mintedToken, '/me');
        if (cancelled) return;
        if (me.ok) {
          setPrincipal(me.data);
        } else {
          // Non-fatal: the portal can still function for screens that don't
          // need the identity badge. Surfaced, not swallowed.
          setError(me.error.message);
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to start a developer portal session.');
        setLoading(false);
      }
    }

    void mint();
    return () => {
      cancelled = true;
    };
  }, []);

  async function callV1<T>(path: string, init?: RequestInit): Promise<V1Result<T>> {
    if (!token) {
      return {
        ok: false,
        error: { code: 'unauthorized', message: 'No portal session token yet.', request_id: 'client-no-token' },
      };
    }
    return v1Request<T>(token, path, init);
  }

  return (
    <DeveloperPortalContext.Provider value={{ token, loading, error, principal, callV1 }}>
      {children}
    </DeveloperPortalContext.Provider>
  );
}

export function usePortalToken(): DeveloperPortalValue {
  const ctx = useContext(DeveloperPortalContext);
  if (!ctx) {
    throw new Error('usePortalToken must be used within a DeveloperPortalProvider');
  }
  return ctx;
}
