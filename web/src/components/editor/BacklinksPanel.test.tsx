/**
 * Regression test for TRO-220 / audit finding A11Y-6.
 *
 * A document view's only page-level heading is the title `<h1>` rendered in
 * the compact header (Editor.tsx:888). `WikiSidebar` renders nothing but
 * `<label>` property rows and this panel — so `BacklinksPanel`'s "Backlinks"
 * heading was the very next heading in DOM order, and it was an `<h3>`. With
 * no `<h2>` anywhere in the chrome, that is an h1 -> h3 skip: axe Moderate
 * `heading-order`, reproduced on the seeded wiki document
 * (`audit/a11y/axe/document_view.json`: `heading-order moderate` targeting
 * `h3`).
 *
 * This is page-chrome, not user-authored TipTap content: it reproduces on a
 * document with zero body headings, and fixing it does not touch the editor's
 * Heading extension or constrain what levels a user can type into their own
 * content (see `.claude/skills/ship-frontend/SKILL.md`).
 *
 * Fix: promote "Backlinks" from `<h3>` to `<h2>`, the first real section
 * heading under the page's single `<h1>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { BacklinksPanel } from './BacklinksPanel';

const realFetch = global.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse([])) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <BacklinksPanel documentId="doc-1" />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('BacklinksPanel — heading level (A11Y-6 / TRO-220)', () => {
  it('renders its section heading as h2, immediately below the page h1', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByText('No backlinks')).toBeInTheDocument());

    expect(screen.getByRole('heading', { level: 2, name: 'Backlinks' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Backlinks' })).not.toBeInTheDocument();
  });

  it('keeps the same heading level while backlinks are loading', () => {
    // Never resolves during this assertion — pins the loading-state heading too.
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    renderPanel();

    expect(screen.getByRole('heading', { level: 2, name: 'Backlinks' })).toBeInTheDocument();
  });
});
