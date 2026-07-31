import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, '../index.html'), 'utf8');
const indexCss = readFileSync(resolve(here, 'index.css'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

/**
 * TRO-205 / BUN-9 — index.html used to carry two `<link rel="preconnect">`s
 * to fonts.googleapis.com/fonts.gstatic.com plus a render-blocking
 * `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter...">`
 * ahead of the entry script: Vite/Tailwind starter boilerplate that survived
 * into production. Every other asset on this app's first-paint path is
 * self-hosted; this was the one remaining cross-origin dependency, on a
 * `.treasury.gov` deployment.
 *
 * The fix is source-level (no third-party request left in the markup, a
 * self-hosted @font-face import in its place) so these are source
 * assertions, not runtime ones — consistent with main.routes.test.ts's
 * reasoning for the code-splitting guard: the defect is "someone re-adds a
 * `<link>` to Google Fonts", and that comes back as a diff to these two
 * files, not as a behavior only observable at runtime.
 */
describe('self-hosted Inter font (TRO-205 / BUN-9)', () => {
  it('index.html no longer references the Google Fonts CDN', () => {
    expect(indexHtml).not.toMatch(/fonts\.googleapis\.com/);
    expect(indexHtml).not.toMatch(/fonts\.gstatic\.com/);
  });

  it('index.html has no <link> pointing at a fonts.* third-party host', () => {
    const linkTags = indexHtml.match(/<link[^>]*>/g) ?? [];
    expect(linkTags.length).toBeGreaterThan(0); // sanity: the file still has other <link>s (favicons, manifest)
    for (const tag of linkTags) {
      expect(tag).not.toMatch(/https?:\/\/fonts\./);
    }
  });

  it('index.css imports self-hosted @fontsource/inter CSS for the weights Google Fonts used to serve (400, 500, 600)', () => {
    const imported = [...indexCss.matchAll(/@import\s+['"]@fontsource\/inter\/(\d+)\.css['"]/g)]
      .map((m) => m[1])
      .sort();
    // The removed Google Fonts URL was `family=Inter:wght@400;500;600` (no
    // `ital` axis) — matching that set, not a superset, keeps typography
    // identical rather than merely "close".
    expect(imported).toEqual(['400', '500', '600']);
  });

  it('imports the self-hosted font CSS ahead of the @tailwind directives', () => {
    const importIndex = indexCss.indexOf("@import '@fontsource/inter/400.css';");
    const tailwindIndex = indexCss.indexOf('@tailwind base;');
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(tailwindIndex).toBeGreaterThan(importIndex);
  });

  it('declares @fontsource/inter as a real package dependency, not just an unresolved import', () => {
    expect(packageJson.dependencies).toBeDefined();
    expect(packageJson.dependencies).toHaveProperty('@fontsource/inter');
  });

  it('ships the actual woff2 font files for the imported weights', () => {
    for (const weight of ['400', '500', '600']) {
      const woff2Path = resolve(
        here,
        `../node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`
      );
      expect(existsSync(woff2Path), `expected ${woff2Path} to exist`).toBe(true);
    }
  });
});
