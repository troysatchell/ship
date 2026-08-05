import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  addBlocksEdge,
  CIRCULAR_BLOCKS_MESSAGE,
  GENERIC_ADD_FAILURE_MESSAGE,
} from './useBlockingAssociations';
import { apiPost } from '@/lib/api';

/**
 * Regression tests for TRO-344: `addBlocksEdge` used to infer "this must be
 * the circular-blocks trigger" from ANY 500 on `POST /:id/associations`, by
 * elimination (every other rejection path on that route was already a
 * distinct 4xx). `api/src/routes/associations.ts` now returns a dedicated
 * `409 {"error": "CIRCULAR_ASSOCIATION"}` for the cycle guard specifically,
 * so this file asserts the message-selection logic matches on that code —
 * not on status alone.
 *
 * `apiPost` is mocked with a real `Response` instance (same convention as
 * IssueBlockingSection.test.tsx's `jsonResponse` helper) rather than a
 * partial object cast, so `.ok`/`.status`/`.json()` all behave exactly as
 * the real fetch Response they stand in for.
 */
vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
}));

const mockApiPost = vi.mocked(apiPost);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockApiPost.mockReset();
});

describe('addBlocksEdge — message selection (TRO-344)', () => {
  it('a 409 with the CIRCULAR_ASSOCIATION code renders the circular-blocks message', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(409, { error: 'CIRCULAR_ASSOCIATION' }));

    const result = await addBlocksEdge('doc-a', 'doc-b');

    expect(result).toEqual({ ok: false, message: CIRCULAR_BLOCKS_MESSAGE });
  });

  it('an unrelated forced 500 (e.g. a mocked DB error) renders the generic failure message, never the circular-blocks message', async () => {
    // Exactly the shape api/src/routes/associations.ts's catch-all still
    // returns for a non-cycle failure (a plain DB error, or anything else
    // the route's isCircularAssociationError() does not recognize).
    mockApiPost.mockResolvedValue(jsonResponse(500, { error: 'Failed to create association' }));

    const result = await addBlocksEdge('doc-a', 'doc-b');

    expect(result).toEqual({ ok: false, message: GENERIC_ADD_FAILURE_MESSAGE });
    expect(result).not.toEqual({ ok: false, message: CIRCULAR_BLOCKS_MESSAGE });
  });

  it('a 409 whose body does not carry the CIRCULAR_ASSOCIATION code falls back to the generic message', async () => {
    // Guards against matching on "any 409" the same way the old code matched
    // on "any 500" — the code itself, not the status alone, is what selects
    // the circular-blocks message.
    mockApiPost.mockResolvedValue(jsonResponse(409, { error: 'SOME_OTHER_CONFLICT' }));

    const result = await addBlocksEdge('doc-a', 'doc-b');

    expect(result).toEqual({ ok: false, message: GENERIC_ADD_FAILURE_MESSAGE });
  });

  it('a successful add resolves ok: true', async () => {
    mockApiPost.mockResolvedValue(
      jsonResponse(201, { id: 'assoc-1', document_id: 'doc-a', related_id: 'doc-b', relationship_type: 'blocks' })
    );

    const result = await addBlocksEdge('doc-a', 'doc-b');

    expect(result).toEqual({ ok: true });
  });

  it('a 400 (self-reference / invalid input) renders the generic failure message', async () => {
    mockApiPost.mockResolvedValue(jsonResponse(400, { error: 'Cannot create self-referencing association' }));

    const result = await addBlocksEdge('doc-a', 'doc-a');

    expect(result).toEqual({ ok: false, message: GENERIC_ADD_FAILURE_MESSAGE });
  });
});
