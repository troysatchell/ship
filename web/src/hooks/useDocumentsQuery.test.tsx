/**
 * TRO-304 (API-3) — `GET /api/documents` now defaults to a bounded page
 * (100 rows) instead of the full corpus (see `api/src/routes/documents.ts`).
 *
 * `useDocumentsQuery` backs the wiki document tree (`buildDocumentTree` in
 * `lib/documentTree.ts`, consumed via `DocumentsContext`/`Documents.tsx` and
 * the sidebar). A tree needs every node of the type it renders — a document
 * whose parent fell on a later page would render as an orphaned root, or
 * disappear entirely, and neither is close to correct. This hook was
 * therefore updated to request an explicit `limit=500` so its "every
 * matching document" behavior is unchanged after the server-side default
 * became bounded.
 *
 * This test proves the fetch URL still asks for completeness, not a page.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Real Response instances (TS-8: a hand-rolled `as any` stub can drift out of
// sync with the real fetch contract without failing).
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const apiGet = vi.fn(async (_path: string): Promise<Response> => jsonResponse([]));

vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => apiGet(path),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

// Imported after the mock so the hook's query function hits the stub.
import { useDocumentsQuery } from './useDocumentsQuery';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useDocumentsQuery — explicit full-corpus fetch after TRO-304 default pagination', () => {
  beforeEach(() => {
    apiGet.mockClear();
  });

  it('requests the wiki type with an explicit large limit, not the new bounded default', async () => {
    const { result } = renderHook(() => useDocumentsQuery('wiki'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/documents?type=wiki&limit=500');
  });

  it('requests any other document type with the same explicit large limit', async () => {
    const { result } = renderHook(() => useDocumentsQuery('project'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));

    expect(apiGet).toHaveBeenCalledWith('/api/documents?type=project&limit=500');
  });
});
