import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';

const API_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * `/oauth-device-verify` — PF-106 (TRO-425, PLUGFORGE.MD §4). RFC 8628's
 * device-flow verification page: a user reads a `user_code` off a
 * device/CLI screen, comes here, types (or arrives with it pre-filled via
 * `verification_uri_complete`) and approves or denies.
 *
 * **Deliberately NOT at `/oauth/device/verify`**, even though that is the
 * literal path RFC 8628 terminology (and this ticket's own architect notes)
 * use — same trap `oauth-authorize.ts`'s header already documents for why
 * PF-103's consent screen is `/oauth-consent`, not `/oauth/consent`:
 * `web/vite.config.ts`'s dev/preview proxy has a `/oauth/` (trailing slash)
 * key that forwards ANY `oauth/*` request straight to the API, before React
 * Router ever sees it — a frontend SPA route living under that prefix would
 * never render locally. The API's own routes (`POST /oauth/device/code`,
 * `POST /oauth/device/verify`) keep the RFC-shaped path; only this
 * component's own React Router path moved. See `api/src/routes/
 * oauth-device.ts`'s header for the other half of this, and CHANGES.md
 * (TRO-425) for the full account.
 *
 * A dedicated, minimal, standalone route — same reasoning as
 * `OAuthConsent.tsx`: not nested inside `AppLayout` (registered alongside
 * `/oauth-consent` in `main.tsx`), so the 4-panel layout does not apply.
 * Session-authed via `ProtectedRoute` at the route registration (bounces to
 * `/login?returnTo=...` and back, unchanged existing machinery).
 *
 * Submission is a plain HTML `<form>` POST to `${API_URL}/oauth/device/
 * verify`, not `fetch()` — same reasoning as `OAuthConsent.tsx`'s form
 * (avoids both a CORS change to `/oauth`'s public, credential-less policy,
 * and needing a CSRF token a plain form can't attach). The server always
 * responds with a redirect back to this exact page, carrying either
 * `?result=approved|denied` or `?error=<reason>` — this component is purely
 * a view over those three states (form / result / error), never calls the
 * API directly itself.
 */
export function OAuthDeviceVerifyPage() {
  const [searchParams] = useSearchParams();
  const [userCode, setUserCode] = useState(searchParams.get('user_code') ?? '');

  const result = searchParams.get('result');
  const error = searchParams.get('error');

  if (result === 'approved' || result === 'denied') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <main className="w-full max-w-[420px] text-center">
          <img src="/icons/white/logo-128.png" alt="Ship" className="mx-auto h-12 w-12" />
          <h1 className="mt-4 text-xl font-semibold text-foreground">
            {result === 'approved' ? 'Device authorized' : 'Request denied'}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {result === 'approved'
              ? 'You can return to your device — it will continue automatically.'
              : 'The device will not be signed in. You can close this page.'}
          </p>
        </main>
      </div>
    );
  }

  // Reached from an error redirect: the code was mistyped/unknown, expired,
  // or already decided (approved/denied earlier, or by another tab). Let
  // the user try again rather than dead-ending the page.
  const errorMessage: Record<string, string> = {
    invalid_code: 'That code is not valid. Check the code on your device and try again.',
    not_found: 'That code was not recognized. Check the code on your device and try again.',
    expired: 'That code has expired. Go back to your device to get a new one.',
    already_decided: 'That code has already been used.',
    server_error: 'Something went wrong. Please try again.',
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <main className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          <img src="/icons/white/logo-128.png" alt="Ship" className="mx-auto h-12 w-12" />
          <h1 className="mt-4 text-xl font-semibold text-foreground">Verify your device</h1>
          <p className="mt-2 text-sm text-muted">
            Enter the code shown on your device to sign it in to your Ship account.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-md border border-border bg-background px-4 py-3 text-sm text-foreground">
            {errorMessage[error] ?? errorMessage.server_error}
          </div>
        )}

        <form
          method="POST"
          action={`${API_URL}/oauth/device/verify`}
          className="flex flex-col gap-3"
        >
          <label htmlFor="user_code" className="text-xs font-medium uppercase tracking-wider text-muted">
            Device code
          </label>
          <input
            id="user_code"
            name="user_code"
            type="text"
            required
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="BDWJ-KXQT"
            value={userCode}
            onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            className={cn(
              'w-full rounded-md border border-border bg-background px-4 py-2.5 text-center',
              'font-mono text-lg tracking-[0.2em] text-foreground placeholder:text-muted',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background'
            )}
          />

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
            Approve
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
            Deny
          </button>
        </form>
      </main>
    </div>
  );
}
