import { describe, it, expect } from 'vitest';
import { Suspense, lazy } from 'react';
import { render, screen, act } from '@testing-library/react';
import { RouteFallback } from './RouteFallback';

/**
 * TRO-197 / BUN-1 — route-level code splitting means a navigation now has a
 * loading state where it previously had none. The audit named the specific way
 * that goes wrong: "needs a Suspense fallback that does not flash the 4-panel
 * layout".
 *
 * So the thing worth pinning down is not that a spinner exists — it is that
 * while a route chunk is in flight, the Icon Rail, Contextual Sidebar and
 * Properties Sidebar stay mounted, and the fallback occupies only the main
 * content column.
 *
 * This is a regression guard, not a red-before-green test: before the fix
 * there was no lazy route and therefore nothing to flash. It exists so that a
 * later change moving the boundary above AppLayout — which would restore the
 * flash — fails here.
 */
describe('RouteFallback (TRO-197 / BUN-1)', () => {
  it('announces the pending navigation to assistive technology', () => {
    render(<RouteFallback />);
    // Without a live region a lazy navigation is completely silent for a
    // screen-reader user: focus stays put and nothing is announced.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('fills only its column in the panel variant, and the viewport in the screen variant', () => {
    const { rerender } = render(<RouteFallback variant="panel" />);
    // h-full == the height of the <main> column it is rendered into.
    expect(screen.getByRole('status').className).toContain('h-full');
    expect(screen.getByRole('status').className).not.toContain('h-screen');

    rerender(<RouteFallback variant="screen" />);
    expect(screen.getByRole('status').className).toContain('h-screen');
  });

  it('defaults to the panel variant, so a careless call site cannot cover the layout', () => {
    render(<RouteFallback />);
    expect(screen.getByRole('status').className).toContain('h-full');
  });

  it('leaves the surrounding 4-panel chrome mounted while a lazy route loads', async () => {
    let resolveChunk!: (v: { default: () => JSX.Element }) => void;
    const LazyRoute = lazy(
      () => new Promise<{ default: () => JSX.Element }>((r) => { resolveChunk = r; })
    );

    // A miniature of pages/App.tsx: the three persistent panels, and the
    // Suspense boundary sitting *inside* <main> rather than above it.
    render(
      <div>
        <nav aria-label="Icon rail">rail</nav>
        <aside aria-label="Contextual sidebar">sidebar</aside>
        <main>
          <Suspense fallback={<RouteFallback variant="panel" />}>
            <LazyRoute />
          </Suspense>
        </main>
        <aside aria-label="Document properties" />
      </div>
    );

    // While the chunk is in flight: fallback visible, chrome still there.
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('navigation', { name: 'Icon rail' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Contextual sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Document properties' })).toBeInTheDocument();

    await act(async () => {
      resolveChunk({ default: () => <h1>Documents</h1> });
    });

    // After it lands: the page renders and the chrome was never replaced.
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Icon rail' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Document properties' })).toBeInTheDocument();
  });
});
