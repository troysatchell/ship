/**
 * Regression test for a CodeRabbit finding on PR #120 (TRO-323 / FG-10
 * follow-up): `useInboxQuery` parsed `GET /api/agent/inbox`'s JSON response
 * and returned `{ status: 'ok', items }` without validating the shape first
 * — it trusted `res.json()`'s inferred type.
 *
 * This is defense-in-depth on an already-validated boundary, not closing an
 * open hole: `api/src/routes/agent.ts`'s `GET /inbox` handler already runs
 * `isAgentInboxSuccessBody` (which validates every item field-by-field via
 * `isAgentInboxItem`/`isAgentInboxEvidence`/`isAgentInboxAction`, defined at
 * api/src/routes/agent.ts:193-231) over the agent service's response before
 * ever relaying it to the browser — confirmed by reading that file. A
 * malformed item cannot actually reach this hook today through that route.
 * Still worth doing cheaply here too, mirroring the same field-by-field
 * check rather than trusting the response shape blindly.
 *
 * `apiGet` (web/src/lib/api.ts) is mocked with real `Response` instances
 * throughout, matching useDocumentsQuery.test.tsx's own pattern.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const apiGet = vi.fn(async (_path: string): Promise<Response> => jsonResponse(200, { items: [] }));

vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => apiGet(path),
}));

// Imported after the mock so the hook's queryFn hits the stub.
import { useInboxQuery } from './useInboxQuery';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const VALID_ITEM = {
  id: 'mention:doc-9:user-1',
  type: 'mention',
  summary: 'You were mentioned in Week 12 planning',
  evidence: { documentId: 'doc-9', documentType: 'sprint' },
  action: { label: 'View mention', href: '/documents/doc-9' },
};

describe('useInboxQuery — response shape validation (CodeRabbit review, PR #120)', () => {
  beforeEach(() => {
    apiGet.mockClear();
  });

  it('returns status "ok" with the items when the response validates', async () => {
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [VALID_ITEM] }));

    const { result } = renderHook(() => useInboxQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ status: 'ok', items: [VALID_ITEM] });
  });

  it('does not crash and does not render as a successful state when an item is missing action.href', async () => {
    const malformedItem = {
      ...VALID_ITEM,
      action: { label: 'View mention' }, // href missing
    };
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [malformedItem] }));

    const { result } = renderHook(() => useInboxQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe('degraded');
  });

  it('treats a response with no items array at all as degraded, not a crash', async () => {
    apiGet.mockResolvedValueOnce(jsonResponse(200, { notItems: [] }));

    const { result } = renderHook(() => useInboxQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe('degraded');
  });

  it('treats an item with a type outside the known union as degraded', async () => {
    const malformedItem = { ...VALID_ITEM, type: 'not_a_real_type' };
    apiGet.mockResolvedValueOnce(jsonResponse(200, { items: [malformedItem] }));

    const { result } = renderHook(() => useInboxQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe('degraded');
  });
});
