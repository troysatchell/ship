import { Link } from 'react-router-dom';

/**
 * Catch-all for any authenticated URL that doesn't match a real route.
 *
 * TRO-219 / audit finding A11Y-5. The audit's own tooling (`audit/a11y/axe-scan.mjs`,
 * `audit/a11y/run-lighthouse.sh`) scanned `/search` and `/weeks` expecting real
 * pages, and axe reported Moderate `landmark-one-main` + `page-has-heading-one`
 * on both. But neither path has ever been a route in this app (there is no
 * `SearchPage`/`WeeksPage`, and `main.tsx` had no `path="/search"` or
 * `path="/weeks"` entry) — `/api/weeks` and `/api/search/mentions` are backend
 * endpoints the audit's route list conflated with frontend pages.
 *
 * Before this route existed, `AppRoutes`'s <Routes> had no element to fall
 * back to for an unmatched path, so the parent `path="/"` route didn't match
 * either — the whole tree rendered nothing. `audit/error-handling/raw/probe1b-routes.json`
 * shows `/weeks` and `/search` with `bodyTextLength: 0`, byte-for-byte the same
 * as a route picked because it's guaranteed not to exist
 * (`/this-route-does-not-exist`). That is a routing gap, not a landmark bug on
 * a working page — adding `<main>`/`<h1>` around that emptiness would have
 * been decoration, not a fix.
 *
 * This page is the actual fix: a real catch-all so an unmatched path renders
 * something instead of a blank screen. It supplies its own `<h1>`; the
 * surrounding `<main>` already comes from `AppLayout` (pages/App.tsx:542),
 * exactly like every other route nested under it.
 */
export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">
        There&apos;s nothing at this address. It may have moved, or the link may be out of date.
      </p>
      {/*
        text-accent-text, not text-accent: `accent` (#005ea2) is a *fill*
        color, only 2.89:1 as text (see tailwind.config.js) — the exact
        A11Y-3/TRO-217 failure mode. `accent-text` (#2491ff) is the token this
        codebase already defines for accent-colored text, at 6.08:1.
      */}
      <Link to="/docs" className="mt-2 text-sm text-accent-text hover:underline">
        Go to Documents
      </Link>
    </div>
  );
}
