import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { within } from '@testing-library/react';

/**
 * TRO-194 / ERR-7 — under Fast 3G throttling the audit measured
 * `loadingAffordanceInFirst2s=false` on EVERY flow (audit/error-handling/baseline.md):
 *
 *   "Load main page   idle= 61090ms  loadingAffordanceInFirst2s=false ..."
 *
 * Root cause: `web/index.html` mounted an *empty* `<div id="root"></div>`.
 * Nothing painted until the app's JS bundle had downloaded, parsed, and
 * executed - on a slow link (or a slow third-party dependency, or any future
 * bundle-size regression) that first paint can take arbitrarily long, and
 * until then the page is a blank tab regardless of how correct any
 * individual page's `isLoading` branch is.
 *
 * The fix puts a real, accessible loading affordance directly in the static
 * HTML inside `#root`, so it paints the instant the browser has the HTML
 * document itself - before a single byte of the JS bundle or CSS has to
 * arrive. `ReactDOM.createRoot(...).render(...)` replaces `#root`'s children
 * automatically once the real app mounts.
 *
 * This test parses the real `index.html` and renders only the markup that
 * exists BEFORE the `<script>` tag - i.e. exactly what a browser paints
 * before any JS has run - and asserts an accessible loading status is
 * present in it. This is an observed check of the static markup shipped to
 * the browser, not a simulation of network timing: it proves the affordance
 * exists independent of the bundle, not that a real Fast-3G load clears 2s
 * (that would need a real throttled-network run, e.g. via Chrome DevTools).
 */
function staticBodyMarkupBeforeScript(): string {
  const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf-8');
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch || !bodyMatch[1]) {
    throw new Error('Could not find <body>...</body> in web/index.html');
  }
  const scriptIndex = bodyMatch[1].indexOf('<script');
  return scriptIndex === -1 ? bodyMatch[1] : bodyMatch[1].slice(0, scriptIndex);
}

describe('web/index.html static loading affordance (TRO-194 / ERR-7)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('paints an accessible loading status before any script has had a chance to run', () => {
    document.body.innerHTML = staticBodyMarkupBeforeScript();

    // Query by role/accessible name, not class or id: this must be reachable
    // the same way a screen reader (or the audit's own probe) would find it.
    const status = within(document.body).getByRole('status');
    expect(status.textContent, 'must actually say something is loading').toMatch(/loading/i);
  });

  it('is announced live, so assistive tech is not left silent during the wait', () => {
    document.body.innerHTML = staticBodyMarkupBeforeScript();

    const status = within(document.body).getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('lives inside #root so React replaces it the instant the app mounts', () => {
    document.body.innerHTML = staticBodyMarkupBeforeScript();

    const root = document.getElementById('root');
    expect(root, '#root must exist for React to mount into').not.toBeNull();
    const status = within(root as HTMLElement).getByRole('status');
    expect(status).toBeInTheDocument();
  });
});
