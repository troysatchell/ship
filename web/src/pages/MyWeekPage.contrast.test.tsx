/**
 * TRO-217 / A11Y-3 regression test: every text/background pair `/my-week` renders
 * must clear the WCAG 2.1 AA minimum of 4.5:1.
 *
 * `/` redirects to `/my-week`, so this is the landing page of a federal application
 * and it was the only key page Lighthouse failed (95, single failing audit
 * `color-contrast`). axe recorded 18-25 Serious nodes there depending on the day of
 * the week and the seeded plan/retro state.
 *
 * Why this shape of test:
 * - It asserts *resolved colours*, not class strings, so renaming or restructuring
 *   the markup cannot make it vacuously pass, and a token whose hex drifts back
 *   under 4.5:1 fails it.
 * - It renders several data states, because three of the page's contrast pairs only
 *   exist under specific data (`Current` badge, `Unsubmitted`/`Submitted`/`Due today`
 *   badges, future standup rows). A single-state check declared this page fixed while
 *   a 4.38:1 pair sat behind a common plan state.
 * - The colour tokens come from `tailwind.config.js` itself, so the test tracks the
 *   real palette rather than a copy of it.
 *
 * Fidelity of the resolver is pinned in `src/lib/contrast.test.ts` against the
 * fgColor/bgColor/contrastRatio values axe itself recorded in `audit/a11y/axe/`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import defaultColors from 'tailwindcss/colors';
import tailwindConfig from '../../tailwind.config.js';
import {
  AA_NORMAL_TEXT,
  resolveContrastPairs,
  type ContrastPair,
} from '@/lib/contrast';
import type { MyWeekResponse } from '@/hooks/useMyWeekQuery';

const mockUseMyWeekQuery = vi.fn();
vi.mock('@/hooks/useMyWeekQuery', () => ({
  useMyWeekQuery: (weekNumber?: number) => mockUseMyWeekQuery(weekNumber),
}));

// Imported after the mock so the page picks it up.
const { MyWeekPage } = await import('./MyWeekPage');

const palette = tailwindConfig.theme.extend.colors;

/**
 * Tailwind's default palette flattened to `red-400`-style keys, merged under the
 * project palette. Without the defaults, a class like `text-red-400` would fail to
 * resolve and the element would silently inherit its ancestor's colour — which can
 * turn a real failure into a false pass.
 */
function buildColorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  // Read via descriptors, not Object.entries: Tailwind exposes its renamed aliases
  // (lightBlue, warmGray, ...) as getters that log a deprecation warning when read.
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

/** UTC `YYYY-MM-DD` offset from today, so the fixtures are not a dated time bomb. */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayName(offsetDays: number): string {
  const d = new Date(isoDate(offsetDays) + 'T00:00:00Z');
  const name = DAY_NAMES[d.getUTCDay()];
  // getUTCDay() is always 0-6 and DAY_NAMES has all 7 entries; this can never
  // actually trigger, but the type checker can't derive that.
  if (name === undefined) throw new Error(`unexpected day index ${d.getUTCDay()}`);
  return name;
}

/** Yesterday (written), today (unwritten), and three future slots. */
function standupSlots(): MyWeekResponse['standups'] {
  return [
    {
      date: isoDate(-1),
      day: dayName(-1),
      standup: { id: 'su-1', title: 'Yesterday update', date: isoDate(-1), created_at: '' },
    },
    { date: isoDate(0), day: dayName(0), standup: null },
    { date: isoDate(1), day: dayName(1), standup: null },
    { date: isoDate(2), day: dayName(2), standup: null },
    { date: isoDate(3), day: dayName(3), standup: null },
  ];
}

const ITEMS = [
  { text: 'Ship the migration runner fix', checked: false },
  { text: 'Review the collaboration server auth gate', checked: false },
  { text: 'Pair on the bundle split', checked: false },
  { text: 'Write up the contrast findings', checked: false },
];

function baseData(): MyWeekResponse {
  return {
    person_id: 'p-1',
    person_name: 'Dev User',
    week: {
      week_number: 30,
      current_week_number: 30,
      start_date: isoDate(-2),
      end_date: isoDate(4),
      is_current: true,
    },
    plan: null,
    retro: null,
    previous_retro: null,
    standups: standupSlots(),
    projects: [],
  };
}

/**
 * Each state exists to render a pair that the others do not. The names match the
 * badge or region whose colours are unique to that state.
 */
const STATES: Array<{ name: string; data: MyWeekResponse }> = [
  {
    // "Current" week badge + numbered plan/retro items + "Unsubmitted" badges.
    // `projects: []` keeps isDue false so the Unsubmitted badge renders instead of
    // "Due today" — that badge carries the 4.38:1 pair axe never sampled here.
    name: 'current week, unsubmitted plan and retro with items',
    data: {
      ...baseData(),
      plan: { id: 'pl-1', title: 'Plan', submitted_at: null, items: ITEMS },
      retro: { id: 're-1', title: 'Retro', submitted_at: null, items: ITEMS },
    },
  },
  {
    // "Submitted" badges.
    name: 'submitted plan and retro',
    data: {
      ...baseData(),
      plan: { id: 'pl-1', title: 'Plan', submitted_at: '2026-07-24T00:00:00Z', items: ITEMS },
      retro: { id: 're-1', title: 'Retro', submitted_at: '2026-07-24T00:00:00Z', items: ITEMS },
    },
  },
  {
    // "Due today" badges on the create buttons + the previous-week retro nudge.
    name: 'nothing created yet, projects assigned, previous retro outstanding',
    data: {
      ...baseData(),
      projects: [{ id: 'pr-1', title: 'Ship Hardening', program_name: 'Platform' }],
      previous_retro: { id: null, title: null, submitted_at: null, week_number: 29 },
    },
  },
  {
    // "Due today" badge inside an existing-but-unsubmitted plan/retro card.
    name: 'unsubmitted plan and retro with projects assigned',
    data: {
      ...baseData(),
      projects: [{ id: 'pr-1', title: 'Ship Hardening', program_name: 'Platform' }],
      plan: { id: 'pl-1', title: 'Plan', submitted_at: null, items: ITEMS },
      retro: { id: 're-1', title: 'Retro', submitted_at: null, items: ITEMS },
    },
  },
];

const [FIRST_STATE] = STATES;
if (!FIRST_STATE) {
  throw new Error('STATES must have at least one fixture');
}

function renderState(data: MyWeekResponse): HTMLElement {
  mockUseMyWeekQuery.mockReturnValue({ data, isLoading: false, error: null });
  const { container } = render(
    <MemoryRouter>
      <MyWeekPage />
    </MemoryRouter>
  );
  const root = container.firstElementChild;
  if (!root) throw new Error('MyWeekPage rendered nothing');
  return root as HTMLElement;
}

function describePair(pair: ContrastPair): string {
  return `${pair.ratio.toFixed(2)}:1  "${pair.text.slice(0, 40)}"  fg=${pair.foreground} bg=${pair.background}  [${pair.classes}]`;
}

describe('/my-week colour contrast (TRO-217 / A11Y-3)', () => {
  it('resolves the page background from the Tailwind palette', () => {
    // Guards the premise of every assertion below: the page is painted on
    // `background`, and that token is a hex the resolver can read.
    expect(palette.background).toMatch(/^#[0-9a-f]{6}$/i);
  });

  for (const state of STATES) {
    it(`meets 4.5:1 on every text pair — ${state.name}`, () => {
      const root = renderState(state.data);
      const { pairs } = resolveContrastPairs(root, {
        colors: COLORS,
        rootBackground: palette.background,
      });

      // An empty or near-empty walk must not read as a pass (the silent-empty-test
      // failure mode): this page always renders at least the heading, the week date
      // range, four section headings and five standup rows.
      expect(
        pairs.length,
        `resolved only ${pairs.length} text pairs — the walk found nothing to check`
      ).toBeGreaterThanOrEqual(12);

      const failing = pairs.filter(p => p.ratio < AA_NORMAL_TEXT);
      expect(
        failing.map(describePair),
        `${failing.length} of ${pairs.length} text pairs are below ${AA_NORMAL_TEXT}:1`
      ).toEqual([]);
    });
  }

  it('keeps the numbered plan/retro items legible', () => {
    // The 11px ordinals were the `text-muted/50` pair axe measured at 2.26:1.
    // Asserted separately so a regression here is named, not buried in a list.
    const root = renderState(FIRST_STATE.data);
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });
    const ordinals = pairs.filter(p => /^\d+\.$/.test(p.text));
    expect(ordinals.length, 'expected the numbered plan and retro items to render').toBe(
      ITEMS.length * 2
    );
    for (const ordinal of ordinals) {
      expect(ordinal.ratio, describePair(ordinal)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('keeps future standup rows legible instead of dimming them below AA', () => {
    // Future rows carried `opacity-40`, which dragged their `text-muted` labels to
    // 1.84:1 — 12 of the 18 nodes axe reported. Opacity dims text and chrome
    // together, so this pair cannot be fixed by tuning the opacity value.
    const root = renderState(FIRST_STATE.data);
    const { pairs } = resolveContrastPairs(root, {
      colors: COLORS,
      rootBackground: palette.background,
    });
    const upcoming = pairs.filter(p => p.text === 'Upcoming');
    expect(upcoming.length, 'expected future standup rows to render').toBeGreaterThanOrEqual(3);
    for (const row of upcoming) {
      expect(row.ratio, describePair(row)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
