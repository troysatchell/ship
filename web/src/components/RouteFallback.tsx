/**
 * Suspense fallback for route-level code splitting (BUN-1 / TRO-197), and —
 * as of TRO-194 / ERR-7 — the shared loading affordance for a page's own
 * top-level data fetch (a react-query `isLoading`/`isPending` state), not
 * just its JS chunk. Both are "the primary content isn't here yet", and both
 * need the same rule: stay inside the main-content column, announce to
 * assistive tech, and show up the instant the loading state is true.
 *
 * Two variants, and the difference matters:
 *
 * - `screen` fills the viewport. Used only above `AppLayout`, i.e. before the
 *   4-panel shell exists at all, and for the standalone routes (login, setup,
 *   invite, admin, public feedback) that never render inside it.
 * - `panel` fills the main-content column. Used for every route that renders
 *   into `AppLayout`'s `<Outlet />`, so the Icon Rail, Contextual Sidebar and
 *   Properties Sidebar stay on screen while the page chunk (or its data)
 *   loads. Using the `screen` variant there would tear the 4-panel layout
 *   down and rebuild it on every navigation — the flash the audit warned
 *   about.
 *
 * `role="status"` + `aria-live="polite"` is what makes a route transition (or
 * a data fetch) perceivable to a screen-reader user; without it, it's silent.
 */
export function RouteFallback({
  variant = 'panel',
  label = 'Loading…',
}: {
  variant?: 'screen' | 'panel';
  /** Page-specific loading text, e.g. "Loading week…". Defaults to a generic label. */
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        variant === 'screen'
          ? 'flex h-screen items-center justify-center bg-background'
          : 'flex h-full items-center justify-center'
      }
    >
      <span className="text-muted">{label}</span>
    </div>
  );
}
