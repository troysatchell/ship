/**
 * TRO-304 (API-3) — `GET /api/documents` now defaults to a bounded page
 * (100 rows) instead of the full corpus (see `api/src/routes/documents.ts`).
 *
 * CommandPalette fetches the document list once on open and searches it
 * entirely client-side (`groupedDocuments`, filtered by `cmdk`'s own
 * search). It needs the *complete* corpus to be a correct "search
 * everything" surface — a bounded page would make some documents
 * unfindable via Cmd+K with no indication anything was missing. This test
 * proves the palette still asks for completeness (an explicit large
 * `limit`) rather than silently searching over just the first page.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/Tooltip';

// cmdk measures its list via ResizeObserver (not implemented in jsdom) and
// calls scrollIntoView on the active item. Same shim as Combobox.test.tsx.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});

// Real Response instances (TS-8: a hand-rolled `as any` stub can drift out of
// sync with the real fetch contract without failing).
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DOCUMENTS = [
  { id: 'wiki-1', title: 'Runbook', document_type: 'wiki' },
  { id: 'issue-1', title: 'Fix login bug', document_type: 'issue', ticket_number: 42 },
];

const apiGet = vi.fn(async (_path: string): Promise<Response> => jsonResponse(DOCUMENTS));
const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => apiGet(path),
  apiPost: (path: string, body: unknown) => apiPost(path, body),
}));

// Imported after the mock so the component's fetch hits the stub.
import { CommandPalette } from './CommandPalette';

function renderPalette() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CommandPalette open onOpenChange={vi.fn()} />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('CommandPalette — explicit full-corpus fetch after TRO-304 default pagination', () => {
  beforeEach(() => {
    apiGet.mockClear();
    apiPost.mockClear();
  });

  it('requests the document list with an explicit large limit, not the new bounded default', async () => {
    renderPalette();

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/documents?limit=500'));
  });

  it('still shows documents from the full response once loaded', async () => {
    renderPalette();

    expect(await screen.findByText('Runbook')).toBeInTheDocument();
    expect(await screen.findByText('#42: Fix login bug')).toBeInTheDocument();
  });
});
