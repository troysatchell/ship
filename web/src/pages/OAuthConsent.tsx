import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';

const API_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * `/oauth-consent` — PF-103 (TRO-412, PLUGFORGE.MD §4).
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
 * (carried here as query params, including `app_name` for display) and
 * submits the human's decision.
 *
 * Submission is a plain HTML `<form>` POST, not `fetch()` — see the header
 * comment in `oauth-authorize.ts` for the full reasoning (avoids both a CORS
 * change to `/oauth`'s public, credential-less policy, and the
 * fetch-follows-redirect / opaque-redirect problem for a cross-origin
 * `redirect_uri`). The browser's own top-level navigation is what lands the
 * user on the third-party `redirect_uri` with `?code=...` or
 * `?error=access_denied`.
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
  const appName = searchParams.get('app_name') || 'This application';

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
