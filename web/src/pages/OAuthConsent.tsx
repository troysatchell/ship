import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';

const API_URL = import.meta.env.VITE_API_URL ?? '';

const GENERIC_APP_NAME = 'This application';

type AppInfoState =
  | { status: 'loading' }
  | { status: 'loaded'; name: string }
  | { status: 'error' };

/**
 * `/oauth-consent` — PF-103 (TRO-412, PLUGFORGE.MD §4), app-name lookup
 * TRO-550.
 *
 * A dedicated, minimal, standalone route — deliberately NOT nested inside
 * `AppLayout` (see `main.tsx`: registered alongside `/setup`/`/invite/:token`,
 * not inside the `/` `ProtectedRoute`+`AppLayout` subtree). This is not a
 * document editor and carries no properties sidebar, so the 4-panel layout
 * (`/ship-philosophy-reviewer`'s usual check) does not apply — the PRD text
 * itself calls for a "dedicated minimal route", matching this codebase's own
 * existing pattern for auth-adjacent, non-document pages.
 *
 * Session-authed via `ProtectedRoute` at the route registration in
 * `main.tsx` (bounces to `/login?returnTo=...` and back — existing,
 * untouched machinery; see that file). The actual authorization decision
 * (issuing a code, validating client_id/redirect_uri/code_challenge again
 * from scratch) is server-side in `api/src/routes/oauth-authorize.ts`; this
 * component only displays what `GET /oauth/authorize` already validated
 * (carried here as query params) and submits the human's decision.
 *
 * Submission is a plain HTML `<form>` POST, not `fetch()` — see the header
 * comment in `oauth-authorize.ts` for the full reasoning (avoids both a CORS
 * change to `/oauth`'s public, credential-less policy, and the
 * fetch-follows-redirect / opaque-redirect problem for a cross-origin
 * `redirect_uri`). The browser's own top-level navigation is what lands the
 * user on the third-party `redirect_uri` with `?code=...` or
 * `?error=access_denied`.
 *
 * ── App name: TRO-550 ──
 *
 * This page is directly reachable with attacker-chosen query params — it is
 * a client-side SPA route with no server-side re-validation of its own, so
 * `client_id`/`redirect_uri` here may not have gone through `GET
 * /oauth/authorize` at all (a hand-crafted link can point straight at
 * `/oauth-consent?...`). A display name taken from the query string is
 * therefore not bound to the actual `client_id` — a crafted link could set
 * `app_name` to anything, spoofing a trusted app's name. PR #183 (TRO-412
 * PM-triaged review finding) fixed that by dropping the query param and
 * showing generic "This application" copy. This restores a real name
 * *safely*: `GET /oauth/app-info?client_id=...` (`oauth-authorize.ts`) looks
 * the name up server-side against `oauth_apps` and is the ONLY source of
 * truth for what's rendered below — there is deliberately no `app_name`
 * read from `useSearchParams()` anywhere in this file, and none should ever
 * be reintroduced. On any lookup failure (unknown/revoked client_id,
 * network error) this falls back to the same generic copy PR #183 used —
 * never to a client-supplied string.
 *
 * A bare `fetch()`, not `credentials: 'include'`: `/oauth` carries the
 * public, credential-less CORS policy (`createPublicApiCors()`, app.ts) —
 * see `oauth-authorize.ts`'s module header for why a credentialed fetch to
 * `/oauth/*` would be silently blocked. No session is needed for this
 * lookup anyway: `client_id` is already a public, URL-visible identifier,
 * and the name returned is exactly what's about to be shown to this same
 * user before they decide anything.
 */
export function OAuthConsentPage() {
  const [searchParams] = useSearchParams();

  const clientId = searchParams.get('client_id');
  const redirectUri = searchParams.get('redirect_uri');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method') || 'S256';
  // GET /oauth/authorize only ever redirects here with response_type=code
  // (anything else is rejected before this page is reached) — carried
  // through anyway so the decision POST's re-validation has it, rather than
  // hardcoding 'code' in two places that could drift apart.
  const responseType = searchParams.get('response_type') || 'code';
  const scope = searchParams.get('scope') || '';
  const state = searchParams.get('state') || '';

  const [appInfo, setAppInfo] = useState<AppInfoState>({ status: 'loading' });

  useEffect(() => {
    if (!clientId) {
      setAppInfo({ status: 'error' });
      return;
    }

    let cancelled = false;
    const query = new URLSearchParams({ client_id: clientId });

    fetch(`${API_URL}/oauth/app-info?${query.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /oauth/app-info failed: ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        // CodeRabbit review finding, TRO-550: don't trust the response shape
        // just because the status was 200 — require a real, non-empty
        // string `name` before treating it as loaded. A malformed/empty
        // value falls through to the same generic-copy catch below rather
        // than rendering blank/undefined/non-string content.
        const name =
          typeof data === 'object' && data !== null && 'name' in data
            ? (data as { name: unknown }).name
            : undefined;
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('GET /oauth/app-info returned a malformed body');
        }
        if (!cancelled) setAppInfo({ status: 'loaded', name });
      })
      .catch(() => {
        // Unknown/revoked client_id, network failure, or a malformed
        // response: fall back to generic copy. Never fabricate a name from
        // anything client-supplied — the Approve/Deny form below still
        // re-validates client_id/redirect_uri server-side regardless (see
        // oauth-authorize.ts), so this only affects what's displayed.
        if (!cancelled) setAppInfo({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // The ONLY two possible values: the real, server-verified name, or the
  // same generic fallback PR #183 introduced. Never `searchParams.get(
  // 'app_name')` — see the header comment above.
  const appName = appInfo.status === 'loaded' ? appInfo.name : GENERIC_APP_NAME;

  const requestedScopes = scope.split(' ').filter(Boolean);

  // Reached directly (bookmarked, back-button, or a malformed link) rather
  // than via GET /oauth/authorize's redirect — nothing here was validated,
  // so show a plain message instead of rendering a form that would submit
  // incomplete data. The server re-validates everything again on submit
  // regardless (see oauth-authorize.ts); this is purely a UX guard.
  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <main className="w-full max-w-[420px] text-center">
          <h1 className="text-xl font-medium text-foreground">Nothing to authorize</h1>
          <p className="mt-2 text-sm text-muted">
            This page is reached from an application&rsquo;s sign-in link, not directly.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <main className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          <img src="/icons/white/logo-128.png" alt="Ship" className="mx-auto h-12 w-12" />
          <h1 className="mt-4 text-xl font-semibold text-foreground">Authorize {appName}</h1>
          <p className="mt-2 text-sm text-muted">
            {appName} would like to access your Ship account.
          </p>
        </div>

        {/* Client/Redirect below are still shown alongside the name (not
          * replaced by it): `client_id` is what GET /oauth/app-info's name
          * lookup is actually keyed on, and `redirect_uri` is what
          * POST /oauth/authorize/decision re-validates by exact match against
          * the app's registered list (oauth-authorize.ts) before ever
          * issuing a code — showing both lets the user cross-check what
          * they're authorizing even with a trustworthy name now in place.
          * TRO-412 (PM-triaged review finding) originally added this box
          * when the name itself couldn't be trusted; TRO-550 restores the
          * name without removing it. */}
        <div className="mb-6 space-y-1 rounded-md border border-border bg-background px-4 py-3 text-xs text-muted">
          <p className="break-all">
            <span className="font-medium uppercase tracking-wider">Client:</span> {clientId}
          </p>
          <p className="break-all">
            <span className="font-medium uppercase tracking-wider">Redirect:</span> {redirectUri}
          </p>
        </div>

        {requestedScopes.length > 0 && (
          <div className="mb-6 rounded-md border border-border bg-background px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">
              This will allow {appName} to
            </p>
            <ul className="mt-2 space-y-1 text-sm text-foreground">
              {requestedScopes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        <form
          method="POST"
          action={`${API_URL}/oauth/authorize/decision`}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="response_type" value={responseType} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          {/* Omitted when empty, not submitted as "" — an absent scope/state
            * is meaningfully different from an explicit empty string on the
            * server (asString() there treats both as "not provided" today,
            * but only one of those is actually true; no reason to submit a
            * value that was never in the URL). CodeRabbit review finding,
            * TRO-412. */}
          {scope && <input type="hidden" name="scope" value={scope} />}
          {state && <input type="hidden" name="state" value={state} />}

          <button
            type="submit"
            name="decision"
            value="approve"
            className={cn(
              'w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white',
              'transition-colors hover:bg-accent-hover',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background'
            )}
          >
            Authorize
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className={cn(
              'w-full rounded-md border border-border bg-background px-4 py-2.5',
              'text-sm font-medium text-foreground transition-colors hover:bg-border/50',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background'
            )}
          >
            Cancel
          </button>
        </form>
      </main>
    </div>
  );
}
