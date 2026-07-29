/**
 * WCAG 2.1 contrast arithmetic, plus a small resolver that reads the effective
 * text/background colour pairs out of a rendered DOM subtree.
 *
 * Added for TRO-217 / A11Y-3 (`/my-week` failed `color-contrast` on 18-25 nodes).
 * The point of resolving *colours* rather than asserting *class strings* is that a
 * regression test built on this keeps working when the markup is refactored, and
 * fails when a token's hex — or an opacity modifier — drops a pair under 4.5:1.
 *
 * Scope and honesty about it: jsdom does not run Tailwind, so `getComputedStyle`
 * cannot answer "what colour is this text". `resolveContrastPairs` therefore models
 * the subset of Tailwind semantics that actually produces colour on this codebase:
 * `text-<token>`, `bg-<token>`, the `/<alpha>` modifier, and `opacity-<n>`
 * inheritance. It is not a Tailwind implementation. Its fidelity is pinned by
 * `contrast.test.ts`, which reproduces the exact fgColor/bgColor/ratio values axe
 * recorded in `audit/a11y/axe/`.
 *
 * Known duplication, deliberately left alone: `getContrastTextColor` in `./cn.ts`
 * carries its own copy of the same luminance formula. Collapsing the two is a
 * behaviour-affecting refactor of a shipped helper (it renders the program/project
 * colour chips) and is out of scope for TRO-217; it is reported as a follow-up.
 */

const CHANNEL_THRESHOLD = 0.03928;

function channelLuminance(value8bit: number): number {
  const s = value8bit / 255;
  return s <= CHANNEL_THRESHOLD ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Parses `#rgb` / `#rrggbb` into 8-bit channels. Returns null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return [r, g, b];
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex(channels: [number, number, number]): string {
  return `#${channels.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.1 relative luminance. Returns null if the colour is not a hex literal. */
export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

/**
 * WCAG 2.1 contrast ratio between two opaque colours, 1..21.
 * Returns null if either colour is unparseable.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Alpha-composites `top` over the opaque colour `bottom`, the way a browser
 * flattens a translucent layer before measuring contrast.
 */
export function compositeOver(top: string, bottom: string, alpha: number): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  if (!t || !b) return bottom;
  const clamped = Math.min(1, Math.max(0, alpha));
  return toHex([
    clamped * t[0] + (1 - clamped) * b[0],
    clamped * t[1] + (1 - clamped) * b[1],
    clamped * t[2] + (1 - clamped) * b[2],
  ]);
}

/** WCAG 2.1 AA minimum for normal-size text. */
export const AA_NORMAL_TEXT = 4.5;

export interface ContrastPair {
  /** Trimmed text rendered directly by the element. */
  text: string;
  /** Effective foreground after alpha modifier and inherited `opacity-*`. */
  foreground: string;
  /** Effective background after compositing every ancestor's fill. */
  background: string;
  ratio: number;
  /** The element's own class list, so a failure message can point at the source. */
  classes: string;
}

export interface ResolveOptions {
  /** token name -> hex. Typically the Tailwind palette merged with defaults. */
  colors: Record<string, string>;
  /** Opaque colour painted behind the subtree (the page background). */
  rootBackground: string;
}

export interface ResolveResult {
  pairs: ContrastPair[];
  /** Colour classes present in the DOM that `colors` could not resolve. */
  unresolved: string[];
}

const COLOR_CLASS = /^(text|bg)-(.+?)(?:\/(\d{1,3}))?$/;
const OPACITY_CLASS = /^opacity-(\d{1,3})$/;

interface Frame {
  background: string;
  foreground: string;
  foregroundAlpha: number;
  opacity: number;
}

/**
 * Walks `root` and returns one pair per element that renders its own text.
 *
 * Modelling notes, chosen to match what axe reports:
 * - `opacity-*` multiplies down the tree and dims text and fills alike.
 * - a `bg-*` fill is composited over whatever the ancestors already painted, so a
 *   translucent badge measures against the real page colour behind it.
 * - only elements with a direct non-whitespace text node produce a pair, so wrapper
 *   `<div>`s are not counted twice.
 * - a class naming a colour that `options.colors` does not know is *skipped* and
 *   reported in `unresolved` rather than guessed at.
 */
export function resolveContrastPairs(root: Element, options: ResolveOptions): ResolveResult {
  const pairs: ContrastPair[] = [];
  const unresolved = new Set<string>();

  const lookup = (name: string): string | null => {
    const hex = options.colors[name];
    if (typeof hex === 'string' && parseHex(hex)) return hex;
    return null;
  };

  const visit = (element: Element, inherited: Frame): void => {
    const classes = typeof element.className === 'string' ? element.className : '';
    const tokens = classes.split(/\s+/).filter(Boolean);

    const frame: Frame = { ...inherited };

    for (const token of tokens) {
      const opacityMatch = OPACITY_CLASS.exec(token);
      if (opacityMatch) {
        frame.opacity = inherited.opacity * (Number(opacityMatch[1]) / 100);
      }
    }

    for (const token of tokens) {
      // Ignore variant-prefixed classes (hover:, focus:, placeholder:, ...) — they
      // describe states the static render is not in.
      if (token.includes(':')) continue;
      const match = COLOR_CLASS.exec(token);
      if (!match) continue;
      const [, channel, name, alphaRaw] = match;
      const hex = lookup(name);
      if (!hex) {
        unresolved.add(token);
        continue;
      }
      const alpha = alphaRaw === undefined ? 1 : Number(alphaRaw) / 100;
      if (channel === 'bg') {
        frame.background = compositeOver(hex, frame.background, alpha * frame.opacity);
      } else {
        frame.foreground = hex;
        frame.foregroundAlpha = alpha;
      }
    }

    const ownText = Array.from(element.childNodes)
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent ?? '')
      .join('')
      .trim();

    if (ownText.length > 0) {
      const effectiveForeground = compositeOver(
        frame.foreground,
        frame.background,
        frame.foregroundAlpha * frame.opacity
      );
      const ratio = contrastRatio(effectiveForeground, frame.background);
      if (ratio !== null) {
        pairs.push({
          text: ownText,
          foreground: effectiveForeground,
          background: frame.background,
          ratio,
          classes,
        });
      }
    }

    for (const child of Array.from(element.children)) visit(child, frame);
  };

  const rootForeground = lookup('foreground') ?? '#ffffff';
  visit(root, {
    background: options.rootBackground,
    foreground: rootForeground,
    foregroundAlpha: 1,
    opacity: 1,
  });

  return { pairs, unresolved: Array.from(unresolved).sort() };
}
