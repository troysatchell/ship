/**
 * Fidelity tests for `contrast.ts` (added with TRO-217 / A11Y-3).
 *
 * The DOM resolver in `contrast.ts` is a hand-written model of a slice of Tailwind's
 * colour semantics, so a regression test built on it is only worth as much as the
 * model. These cases pin it against numbers this project did not compute: the
 * `fgColor` / `bgColor` / `contrastRatio` values axe-core itself recorded while
 * scanning the running app, stored in `audit/a11y/axe/`.
 *
 * If a case here fails, the resolver has drifted from axe and the `/my-week` contrast
 * spec should not be trusted until it is fixed.
 */
import { describe, it, expect } from 'vitest';
import tailwindConfig from '../../tailwind.config.js';
import {
  AA_NORMAL_TEXT,
  compositeOver,
  contrastRatio,
  parseHex,
  relativeLuminance,
  resolveContrastPairs,
  type ContrastPair,
} from './contrast';

const palette = tailwindConfig.theme.extend.colors;
const BG = palette.background;

function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  const first = host.firstElementChild;
  if (!first) throw new Error('fixture produced no element');
  return first;
}

function resolve(html: string) {
  return resolveContrastPairs(element(html), { colors: palette, rootBackground: BG });
}

describe('WCAG arithmetic', () => {
  it('parses both hex forms and rejects anything else', () => {
    expect(parseHex('#0d0d0d')).toEqual([13, 13, 13]);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(parseHex('rgb(1,2,3)')).toBeNull();
    expect(parseHex('cornflowerblue')).toBeNull();
  });

  it('puts black and white at the 21:1 extreme', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#0d0d0d', '#0d0d0d')).toBeCloseTo(1, 5);
  });

  it('returns null rather than a wrong number for unparseable input', () => {
    expect(relativeLuminance('surface')).toBeNull();
    expect(contrastRatio('#0d0d0d', 'surface')).toBeNull();
  });

  it('composites a translucent layer the way a browser flattens it', () => {
    // axe reported bgColor #0a1d2b for `bg-accent/20` and #0c1114 for `bg-accent/5`
    // over the page background — see audit/a11y/axe/dashboard_my_week_.json.
    expect(compositeOver(palette.accent, BG, 0.2)).toBe('#0a1d2b');
    expect(compositeOver(palette.accent, BG, 0.05)).toBe('#0c1114');
  });
});

describe('agrees with the axe-core numbers recorded in audit/a11y/axe/', () => {
  // Each expectation below quotes a node axe measured on the running app.
  it('text-muted/50 over the page background is #4c4c4c at 2.26:1', () => {
    const fg = compositeOver(palette.muted, BG, 0.5);
    expect(fg).toBe('#4c4c4c');
    expect(contrastRatio(fg, BG)).toBeCloseTo(2.26, 2);
  });

  it('text-muted under opacity-40 is #3f3f3f at ~1.84:1', () => {
    const fg = compositeOver(palette.muted, BG, 0.4);
    expect(fg).toBe('#3f3f3f');
    // axe rounds to 1.84; the unrounded value is 1.85.
    expect(contrastRatio(fg, BG)).toBeCloseTo(1.85, 2);
  });

  it('text-accent on bg-accent/20 is 2.55:1', () => {
    expect(contrastRatio(palette.accent, compositeOver(palette.accent, BG, 0.2))).toBeCloseTo(2.55, 2);
  });

  it('text-accent on bg-accent/5 is 2.82:1', () => {
    expect(contrastRatio(palette.accent, compositeOver(palette.accent, BG, 0.05))).toBeCloseTo(2.82, 2);
  });

  it('text-muted on bg-border is 4.38:1 — under AA, as axe found on the command palette', () => {
    // audit/a11y/axe/command_palette_open.json records exactly this pair on a
    // `<kbd class="bg-border ...">esc</kbd>`. It is the same pair `/my-week` renders
    // in its "Unsubmitted" badge, which is why that badge needed changing too.
    const ratio = contrastRatio(palette.muted, palette.border);
    expect(ratio).toBeCloseTo(4.38, 2);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT);
  });
});

/** Destructures the first pair and asserts it exists, so array indexing under
 * `noUncheckedIndexedAccess` doesn't force `?.` on every assertion below. */
function firstPair(pairs: ContrastPair[]): ContrastPair {
  const [pair] = pairs;
  if (!pair) throw new Error('expected at least one resolved contrast pair');
  return pair;
}

describe('DOM resolution', () => {
  it('reads a plain text token against the page background', () => {
    const { pairs } = resolve('<p class="text-foreground">hello</p>');
    expect(pairs).toHaveLength(1);
    const pair = firstPair(pairs);
    expect(pair.foreground).toBe(palette.foreground);
    expect(pair.background).toBe(BG);
  });

  it('applies an alpha modifier to the foreground', () => {
    const { pairs } = resolve('<span class="text-muted/50">1.</span>');
    const pair = firstPair(pairs);
    expect(pair.foreground).toBe('#4c4c4c');
    expect(pair.ratio).toBeCloseTo(2.26, 2);
  });

  it('inherits opacity-* down the tree and multiplies it into the text', () => {
    const { pairs } = resolve(
      '<div class="opacity-40"><span class="text-muted">Upcoming</span></div>'
    );
    expect(pairs).toHaveLength(1);
    expect(firstPair(pairs).foreground).toBe('#3f3f3f');
  });

  it('composites an ancestor fill so nested text measures against the real colour', () => {
    const { pairs } = resolve(
      '<div class="bg-accent/5"><span class="text-accent">Mon</span></div>'
    );
    const pair = firstPair(pairs);
    expect(pair.background).toBe('#0c1114');
    expect(pair.ratio).toBeCloseTo(2.82, 2);
  });

  it('measures an element against its own fill', () => {
    const { pairs } = resolve('<span class="bg-accent/20 text-accent">Current</span>');
    const pair = firstPair(pairs);
    expect(pair.background).toBe('#0a1d2b');
    expect(pair.ratio).toBeCloseTo(2.55, 2);
  });

  it('emits one pair per element that renders its own text, not per wrapper', () => {
    const { pairs } = resolve(
      '<div class="text-muted"><span>a</span><span>b</span></div>'
    );
    expect(pairs.map(p => p.text)).toEqual(['a', 'b']);
  });

  it('ignores variant-prefixed classes, which describe states the render is not in', () => {
    const { pairs } = resolve(
      '<span class="text-muted hover:text-foreground placeholder:text-muted/50">Tue</span>'
    );
    expect(firstPair(pairs).foreground).toBe(palette.muted);
  });

  it('reports a colour class it cannot resolve instead of guessing', () => {
    // `bg-surface` is used in MyWeekPage.tsx but `surface` is not a palette token, so
    // it paints nothing. Surfacing it beats silently inheriting a colour.
    const { pairs, unresolved } = resolve('<div class="bg-surface text-muted">x</div>');
    expect(unresolved).toContain('bg-surface');
    expect(firstPair(pairs).background).toBe(BG);
  });
});
