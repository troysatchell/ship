import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { staticPageImports } from './test/sourceImports';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(here, 'main.tsx'), 'utf8');
const appSource = readFileSync(resolve(here, 'pages/App.tsx'), 'utf8');

/**
 * TRO-197 / BUN-1 — every page component was statically imported by main.tsx,
 * so `web/dist/index.html` referenced exactly one module script of 2,073.70 kB
 * raw / 587.93 kB gzip. An unauthenticated visitor on /login downloaded the
 * admin dashboard, the org chart, the reviews queue and the entire TipTap/Yjs
 * editor stack before the login form could paint.
 *
 * These are *source* assertions, not runtime ones, and that is deliberate:
 * the defect is a build-graph property, and the way it comes back is somebody
 * adding one more `import { SomethingPage } from '@/pages/Something'` because
 * it is the shorter thing to type. TypeScript will not object; the bundle
 * silently re-merges. Nothing else in the suite would notice.
 *
 * The behavioural half — that a lazily-loaded route does not tear down the
 * 4-panel layout while its chunk arrives — lives in
 * components/RouteFallback.test.tsx.
 */
describe('route-level code splitting (TRO-197 / BUN-1)', () => {
  // Detection lives in src/test/sourceImports.ts, which has its own test
  // covering every syntactic form it claims to catch. The regex that used to
  // sit here matched only `import { X } from '@/pages/Y';` — a default import,
  // a namespace import, double quotes or a multi-line brace list would all have
  // passed this guard while re-merging the bundle.
  const pageImports = staticPageImports(mainSource);

  const lazyPages = [...mainSource.matchAll(/React\.lazy\(\(\)\s*=>\s*import\('@\/pages\/([^']+)'\)\.then\(\(m\)\s*=>\s*\(\{\s*default:\s*m\.(\w+)\s*\}\)\)\)/g)].map(
    (m) => ({ module: m[1], exportName: m[2] })
  );

  it('statically imports only the login page, the one route an unauthenticated visitor paints first', () => {
    // Deferring Login too would trade one oversized download for two round
    // trips before the form appears — the same user-visible problem BUN-1 is
    // about. Every other page must be lazy.
    expect(pageImports).toEqual(['@/pages/Login']);
    expect(mainSource).toMatch(/import \{ LoginPage \} from '@\/pages\/Login';/);
  });

  it('lazy-loads every other page component', () => {
    // 23 page components were statically imported before this change.
    expect(lazyPages.length).toBeGreaterThanOrEqual(22);
  });

  it('names a real export for each lazily-loaded page', () => {
    // Most pages use named exports, so the loader has to unwrap them. A typo in
    // that unwrap is a blank screen at runtime on exactly one route.
    for (const { module, exportName } of lazyPages) {
      const candidates = [
        resolve(here, 'pages', `${module}.tsx`),
        resolve(here, 'pages', `${module}.ts`),
      ];
      const file = candidates.find(existsSync);
      if (!file) throw new Error(`@/pages/${module} is lazily imported by main.tsx but does not exist`);
      const src = readFileSync(file, 'utf8');
      const exported =
        new RegExp(`export\\s+(function|const|class)\\s+${exportName}\\b`).test(src) ||
        new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b`).test(src);
      expect(exported, `@/pages/${module} should export ${exportName}`).toBe(true);
    }
  });

  it('keeps the Suspense boundary for child routes inside <main>, below the 4-panel layout', () => {
    // If the boundary sat above AppLayout, every navigation would unmount the
    // Icon Rail, Contextual Sidebar and Properties Sidebar and rebuild them —
    // the layout flash the audit called out as the risk of this fix.
    const mainBlock = appSource.slice(appSource.indexOf('<main id="main-content"'));
    const suspenseIndex = mainBlock.indexOf('<Suspense');
    const outletIndex = mainBlock.indexOf('<Outlet />');
    expect(suspenseIndex).toBeGreaterThan(-1);
    expect(outletIndex).toBeGreaterThan(suspenseIndex);
  });

  it('gives the lazy boundaries a fallback rather than letting React throw', () => {
    // A React.lazy component with no enclosing Suspense is a hard error, not a
    // spinner. Both boundaries must exist.
    expect(mainSource).toContain('<React.Suspense fallback={<RouteFallback variant="screen" />}>');
    expect(appSource).toContain('<Suspense fallback={<RouteFallback variant="panel" />}>');
  });
});

/**
 * Regression test for TRO-219 / audit finding A11Y-5.
 *
 * `AppRoutes` had no `path="*"` route, so an unmatched path under `/` (the
 * audit scanned `/search` and `/weeks`, neither of which is or ever was a
 * real page - see NotFound.tsx) didn't match this parent `<Route path="/">`
 * either. `<Routes>` rendered nothing at all: no `<main>`, no `<h1>`, no
 * content - `audit/error-handling/raw/probe1b-routes.json` records
 * `bodyTextLength: 0` for both, identical to a path picked because it's
 * guaranteed not to exist (`/this-route-does-not-exist`).
 *
 * These assertions pin the catch-all as a *sibling* of the other authenticated
 * routes (`dashboard`, `my-week`, ...), inside the same parent `<Route
 * path="/">` that renders `<AppLayout />`. That placement matters: it's what
 * makes the catch-all inherit `AppLayout`'s persistent `<main id="main-content">`
 * (pages/App.tsx:542) for free, rather than needing (and risking duplicating)
 * its own landmark.
 */
describe('catch-all route for unmatched paths (A11Y-5 / TRO-219)', () => {
  const appRoutesSource = mainSource.slice(mainSource.indexOf('function AppRoutes()'));
  const authenticatedRouteBlock = appRoutesSource.slice(
    appRoutesSource.indexOf('<AppLayout />'),
    appRoutesSource.indexOf('</Routes>', appRoutesSource.indexOf('<AppLayout />'))
  );

  it('declares a wildcard route as a sibling of the other authenticated routes', () => {
    expect(authenticatedRouteBlock).toMatch(/<Route\s+path="\*"\s+element=\{<NotFoundPage\s*\/>\}\s*\/>/);
  });

  it('lazy-loads the not-found page like every other route (not statically imported)', () => {
    expect(mainSource).toMatch(
      /const NotFoundPage = React\.lazy\(\(\)\s*=>\s*import\('@\/pages\/NotFound'\)\.then\(\(m\)\s*=>\s*\(\{\s*default:\s*m\.NotFoundPage\s*\}\)\)\);/
    );
  });
});
