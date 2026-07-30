/**
 * Suspense fallback for route-level code splitting (BUN-1 / TRO-197).
 *
 * Two variants, and the difference matters:
 *
 * - `screen` fills the viewport. Used only above `AppLayout`, i.e. before the
 *   4-panel shell exists at all, and for the standalone routes (login, setup,
 *   invite, admin, public feedback) that never render inside it.
 * - `panel` fills the main-content column. Used for every route that renders
 *   into `AppLayout`'s `<Outlet />`, so the Icon Rail, Contextual Sidebar and
 *   Properties Sidebar stay on screen while the page chunk loads. Using the
 *   `screen` variant there would tear the 4-panel layout down and rebuild it
 *   on every navigation — the flash the audit warned about.
 *
 * `role="status"` + `aria-live="polite"` is what makes a route transition
 * perceivable to a screen-reader user; without it a lazy navigation is silent.
 */
export function RouteFallback({ variant = 'panel' }: { variant?: 'screen' | 'panel' }) {
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
      <span className="text-muted">Loading…</span>
    </div>
  );
}
