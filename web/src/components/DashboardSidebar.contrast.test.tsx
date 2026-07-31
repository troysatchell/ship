/**
 * TRO-298 / A11Y-10 regression test: the "My Work" / "Overview" nav items in
 * `DashboardSidebar` must clear the WCAG 2.1 AA minimum of 4.5:1 when active.
 *
 * This is the same defect class A11Y-3 (TRO-217) fixed on `/my-week`: `accent`
 * (`#005ea2`) is a *fill* colour (documented in `web/tailwind.config.js`), and using
 * it as *text* on `bg-accent/10` measures 2.74:1 here — well under AA. The sidebar
 * component itself never changed; it only became reachable once PR #53 made
 * `/search` and `/weeks` render (previously they rendered nothing, via
 * `AppLayout`'s `'dashboard'` default in `getActiveMode()`), at which point axe
 * flagged it Serious.
 *
 * Same test shape as `MyWeekPage.contrast.test.tsx`: assert *resolved colours*
 * pulled out of the rendered DOM, not class strings, so the test survives a markup
 * refactor and fails again if a palette hex drifts back under 4.5:1. Fidelity of the
 * resolver itself is pinned separately in `src/lib/contrast.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import defaultColors from 'tailwindcss/colors';
import tailwindConfig from '../../tailwind.config.js';
import { AA_NORMAL_TEXT, resolveContrastPairs, type ContrastPair } from '@/lib/contrast';
import { DashboardSidebar } from './DashboardSidebar';

const palette = tailwindConfig.theme.extend.colors;

/**
 * Tailwind's default palette flattened to `red-400`-style keys, merged under the
 * project palette. Without the defaults, a class like `text-red-400` would fail to
 * resolve and the element would silently inherit its ancestor's colour — which can
 * turn a real failure into a false pass. (Same approach as MyWeekPage.contrast.test.tsx.)
 */
function buildColorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(defaultColors))) {
    if (typeof descriptor.get === 'function') continue;
    const value: unknown = descriptor.value;
    if (typeof value === 'string') {
      map[name] = value;
    } else if (value && typeof value === 'object') {
      for (const [shade, hex] of Object.entries(value)) {
        if (typeof hex === 'string') map[`${name}-${shade}`] = hex;
      }
    }
  }
  return { ...map, ...palette };
}

const COLORS = buildColorMap();

function describePair(pair: ContrastPair): string {
  return `${pair.ratio.toFixed(2)}:1  "${pair.text.slice(0, 40)}"  fg=${pair.foreground} bg=${pair.background}  [${pair.classes}]`;
}

/** Renders DashboardSidebar with the router at `path`, so a given nav item is active. */
function renderAt(path: string): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={[path]}>
      <DashboardSidebar />
    </MemoryRouter>
  );
  const root = container.firstElementChild;
  if (!root) throw new Error('DashboardSidebar rendered nothing');
  return root as HTMLElement;
}

describe('DashboardSidebar colour contrast (TRO-298 / A11Y-10)', () => {
  it('resolves the page background from the Tailwind palette', () => {
    // Guards the premise of every assertion below.
    expect(palette.background).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('meets 4.5:1 on the active "My Work" item (default view)', () => {
    const root = renderAt('/');
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    const myWork = pairs.filter(p => p.text === 'My Work');
    expect(myWork.length, 'expected the "My Work" nav item to render').toBeGreaterThanOrEqual(1);
    for (const pair of myWork) {
      expect(pair.ratio, describePair(pair)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('meets 4.5:1 on the active "Overview" item (?view=overview)', () => {
    const root = renderAt('/?view=overview');
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });

    const overview = pairs.filter(p => p.text === 'Overview');
    expect(overview.length, 'expected the "Overview" nav item to render').toBeGreaterThanOrEqual(1);
    for (const pair of overview) {
      expect(pair.ratio, describePair(pair)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('meets 4.5:1 across every resolved text pair in both view states', () => {
    for (const path of ['/', '/?view=overview']) {
      const root = renderAt(path);
      const { pairs } = resolveContrastPairs(root, {
        colors: COLORS,
        rootBackground: palette.background,
      });

      expect(
        pairs.length,
        `resolved only ${pairs.length} text pairs for ${path} — the walk found nothing to check`
      ).toBeGreaterThanOrEqual(2);

      const failing = pairs.filter(p => p.ratio < AA_NORMAL_TEXT);
      expect(
        failing.map(describePair),
        `${failing.length} of ${pairs.length} text pairs are below ${AA_NORMAL_TEXT}:1 for ${path}`
      ).toEqual([]);
    }
  });
});
