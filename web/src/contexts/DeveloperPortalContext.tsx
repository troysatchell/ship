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
  // Mint exactly once per provider instance. React.StrictMode (the `pnpm dev`
  // runtime) mounts → unmounts → re-mounts every effect in development but KEEPS
  // component state; an earlier version paired this ref with a `cancelled` flag
  // set in the cleanup, so the StrictMode re-run returned early (ref already set)
  // and the only in-flight mint discarded its own result → `loading` stayed true
  // forever ("Setting up developer session..." never resolved under `pnpm dev`,
  // while production/preview builds — no double-invoke — worked; observed
  // 2026-08-16). Fix: mint once, and let that mint's result land in state — the
  // fiber (and its state) survives StrictMode's simulated unmount, and React 18
  // no longer warns about setState on an unmounted component for the real case.
  // A second mint per mount would 409 (token names are unique per user+minute).
  const mintedRef = useRef(false);

  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;


    async function mint() {
      try {
        const res = await api.apiTokens.create({
          // Token names are unique per user (POST /api/api-tokens → 409 on a
          // duplicate active name). A minute-granular name meant a second portal
          // entry within the same minute — a plain page reload — 409'd and the
          // portal never got a token (observed 2026-08-16). Millisecond timestamp
          // + a random suffix keeps every entry unique.
          name: `Ship Developer Portal (${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)})`,
          expires_in_days: 1,
          scopes: PORTAL_TOKEN_SCOPES,
        });
        if (!res.success || !res.data) {
          setError(res.error?.message ?? 'Failed to mint a portal session token.');
          setLoading(false);
          return;
        }
        const mintedToken = res.data.token;
        setToken(mintedToken);

        const me = await v1Request<V1Principal>(mintedToken, '/me');
        if (me.ok) {
          setPrincipal(me.data);
        } else {
          // Non-fatal: the portal can still function for screens that don't
          // need the identity badge. Surfaced, not swallowed.
          setError(me.error.message);
        }
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start a developer portal session.');
        setLoading(false);
      }
    }

    void mint();
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
