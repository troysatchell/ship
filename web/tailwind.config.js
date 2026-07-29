/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Linear-inspired neutral palette.
        // Ratios below are against `background` (#0d0d0d) unless stated, computed with
        // the WCAG 2.1 formula in src/lib/contrast.ts. Add the ratio when adding a
        // color — a bare hex is how this palette drifts back under 4.5:1.
        background: '#0d0d0d',
        foreground: '#f5f5f5', // 17.83:1
        // Changed from #737373 (4.09:1) to #8a8a8a, which is 5.63:1 — the previous
        // comment here said 5.1:1, which did not match the arithmetic.
        // CAVEAT: on a `bg-border` fill (#262626) this is only 4.38:1 and FAILS AA.
        // axe found that pair on the command palette's `esc` key; ~109 places in
        // web/src put text-muted on bg-border. Reported as a separate finding.
        muted: '#8a8a8a', // 5.63:1
        border: '#262626',
        // `accent` is a *fill* color: white/foreground text on top of it is fine, but
        // as text on a dark background it is only 2.89:1 (2.55:1 on a bg-accent/20
        // badge, 2.82:1 on bg-accent/5) — the A11Y-3 / TRO-217 failure. Use
        // `accent-text` for accent-colored text and keep this for backgrounds.
        accent: '#005ea2', // USWDS blue-60v ("logo blue"). Fill only — 2.89:1 as text.
        'accent-hover': '#0071bc', // Lighter blue for hover. 3.78:1 — also fill only.
        // USWDS blue-40v: the lightest step of the same vivid-blue ramp that clears AA
        // as small text on this palette's dark surfaces. blue-50v (#0076d6) does not
        // (4.22:1 on background, 3.73:1 on a bg-accent/20 badge).
        // 6.08:1 on background · 5.37:1 on bg-accent/20 · 5.94:1 on bg-accent/5
        'accent-text': '#2491ff',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
