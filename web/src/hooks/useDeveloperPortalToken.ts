import { useEffect, useRef, useState } from 'react';
import { ShipClient } from '@ship/sdk';
import { api, API_URL } from '@/lib/api';

/**
 * TRO-439 (PF-503) — the portal's token-minting-on-entry hook, per
 * PLUGFORGE.MD §2.9's binding architecture requirement: "on entry it mints
 * a short-lived scoped personal token via the `api_tokens` mechanism ...
 * session-authed, and uses it for `/api/v1` calls." The portal never calls
 * internal `/api/*` webhook/delivery routes directly — every webhook read/
 * write in this package goes through `@ship/sdk`'s `WebhooksClient` against
 * `/api/v1`, authenticated with the token this hook mints.
 *
 * Scope: `webhooks:manage` — the one scope `ScopeRegistry`
 * (`api/src/platform/scopes/registry.ts`) defines for every subscription/
 * delivery/replay route this portal's Deliveries and Subscriptions tabs
 * call (`api/src/platform/api/v1/resources/webhooks.ts` gates every route
 * behind `requireScope('webhooks:manage')`).
 *
 * Lifecycle: mint on mount (via the EXISTING session-authed
 * `POST /api/api-tokens` route, `api-tokens.ts` — the same mechanism a user
 * already uses for a Claude Code personal token, just scoped this time),
 * revoke on unmount. `expires_in_days: 1` is defense in depth for the case
 * a tab is closed without running the unmount cleanup (a hard refresh, the
 * browser crashing) — the "short-lived" half of the architecture note isn't
 * satisfied by revoke-on-unmount alone. A fresh, uniquely-named token is
 * minted on every visit rather than reused: `POST /api/api-tokens` 409s on
 * a duplicate NAME for the same user/workspace, and the plaintext token
 * value is only ever returned once (at creation) — there is no "read my
 * existing portal token back" endpoint to reuse across visits, and per
 * `api-tokens.ts`'s own migration-043 header this IS the intended shape for
 * a first-party surface like this one.
 */
export type DeveloperPortalTokenState =
  | { status: 'minting' }
  | { status: 'ready'; client: ShipClient }
  | { status: 'error'; message: string };

const PORTAL_TOKEN_SCOPES = ['webhooks:manage'];

export function useDeveloperPortalToken(): DeveloperPortalTokenState {
  const [state, setState] = useState<DeveloperPortalTokenState>({ status: 'minting' });
  // Guards the revoke-on-unmount call against firing for a token that was
  // never actually minted (e.g. the mint itself failed, or React 18
  // StrictMode's dev-only double-invoke unmounted the FIRST effect run
  // before its mint had resolved).
  const mintedTokenIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function mint() {
      try {
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const res = await api.apiTokens.create({
          name: `Developer Portal session ${uniqueSuffix}`,
          expires_in_days: 1,
          scopes: PORTAL_TOKEN_SCOPES,
        });

        if (cancelled) {
          // Unmounted while the mint was in flight — revoke immediately
          // rather than leaking a token nothing will ever use or clean up
          // later (StrictMode's double-invoke, or a very fast navigation
          // away).
          if (res.success && res.data) {
            api.apiTokens.revoke(res.data.id).catch(() => {
              // Best-effort — the 1-day expiry is the backstop.
            });
          }
          return;
        }

        if (!res.success || !res.data) {
          setState({ status: 'error', message: res.error?.message || 'Failed to mint a developer portal token' });
          return;
        }

        mintedTokenIdRef.current = res.data.id;
        const client = new ShipClient({ baseUrl: API_URL, token: res.data.token });
        setState({ status: 'ready', client });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to mint a developer portal token' });
      }
    }

    void mint();

    return () => {
      cancelled = true;
      const tokenId = mintedTokenIdRef.current;
      if (tokenId) {
        mintedTokenIdRef.current = null;
        api.apiTokens.revoke(tokenId).catch(() => {
          // Best-effort cleanup — the 1-day expiry is the backstop for a
          // revoke that fails (network blip, tab closed mid-request).
        });
      }
    };
  }, []);

  return state;
}
