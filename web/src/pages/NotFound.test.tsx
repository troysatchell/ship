/**
 * Regression test for TRO-219 / audit finding A11Y-5.
 *
 * See NotFound.tsx's own comment for the full diagnosis: `/search` and
 * `/weeks` were never real pages, and the catch-all this test covers is the
 * actual fix (a routing gap), not a landmark patch on an empty page.
 *
 * `NotFoundPage` deliberately does NOT render its own `<main>` - it's always
 * mounted inside `AppLayout`'s `<Outlet />`, which already sits in a `<main
 * id="main-content">` (pages/App.tsx:542). A second `<main>` here would be a
 * duplicate/nested landmark, its own axe violation. This test pins both
 * halves: the `<h1>` this page is responsible for, and the *absence* of a
 * second `<main>`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundPage } from './NotFound';

describe('NotFoundPage (A11Y-5 / TRO-219)', () => {
  it('renders a single top-level heading', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { level: 1, name: /page not found/i })).toBeInTheDocument();
  });

  it('offers a way back to real content', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: /go to documents/i })).toHaveAttribute('href', '/docs');
  });

  it('does not render its own <main> — AppLayout already supplies one', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });
});
