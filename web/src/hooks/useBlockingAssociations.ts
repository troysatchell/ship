import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDelete } from '@/lib/api';

/**
 * Blocks / Blocked-by data access for the issue sidebar (TRO-334 / FG-16).
 *
 * `document_associations` gained a directional `blocks` relationship type in
 * migration 041 (FG-15 / TRO-333): a row `(document_id: A, related_id: B,
 * relationship_type: 'blocks')` means "A blocks B". There is deliberately no
 * second, separately-stored `blocked_by` relationship — "Blocked by" is
 * always the reverse query on that same edge (see this ticket's own scope
 * text). This file therefore has two read paths hitting two different
 * endpoints on the SAME `document_associations` row, never two tables:
 *
 *   - "Blocks" (what this issue blocks): `GET
 *     /api/documents/:id/associations?type=blocks` — rows where `:id` is
 *     `document_id` (api/src/routes/associations.ts:47-94).
 *   - "Blocked by" (what blocks this issue): `GET
 *     /api/documents/:id/reverse-associations?type=blocks` — rows where
 *     `:id` is `related_id` (api/src/routes/associations.ts:192-240). This
 *     is the endpoint FG-14/FG-15 already built for exactly this purpose;
 *     confirmed by reading the route (it joins on `da.related_id = $1`, the
 *     mirror image of the forward query's `da.document_id = $1`), not
 *     assumed.
 *
 * Add/remove both operate on the SAME edge, addressed by (source, target):
 * adding "X blocks this issue" from the Blocked-by side POSTs to
 * `/api/documents/{X}/associations` (source = X, not the open issue) — the
 * route does not care which document the caller considers "current", only
 * that the caller can access `sourceId`. Removing from either side issues
 * the identical `DELETE /api/documents/{source}/associations/{target}` call
 * regardless of which list the user clicked "remove" in, so the same edge
 * removed from either direction deletes exactly one row.
 */

export interface BlockingAssociation {
  /** The document_associations row id. */
  associationId: string;
  /** The OTHER document's id (never the currently-open issue's own id). */
  documentId: string;
  title: string;
  documentType: string;
}

export const blockingKeys = {
  blocks: (issueId: string) => ['associations', issueId, 'blocks'] as const,
  blockedBy: (issueId: string) => ['associations', issueId, 'blocked-by'] as const,
};

interface AssociationRow {
  id: string;
  related_id: string;
  related_title: string;
  related_document_type: string;
}

interface ReverseAssociationRow {
  id: string;
  document_id: string;
  document_title: string;
  document_document_type: string;
}

async function fetchBlocks(issueId: string): Promise<BlockingAssociation[]> {
  const res = await apiGet(`/api/documents/${issueId}/associations?type=blocks`);
  if (!res.ok) {
    throw new Error('Failed to load the issues this blocks');
  }
  const rows = (await res.json()) as AssociationRow[];
  return rows.map((row) => ({
    associationId: row.id,
    documentId: row.related_id,
    title: row.related_title,
    documentType: row.related_document_type,
  }));
}

async function fetchBlockedBy(issueId: string): Promise<BlockingAssociation[]> {
  const res = await apiGet(`/api/documents/${issueId}/reverse-associations?type=blocks`);
  if (!res.ok) {
    throw new Error('Failed to load the issues blocking this one');
  }
  const rows = (await res.json()) as ReverseAssociationRow[];
  return rows.map((row) => ({
    associationId: row.id,
    documentId: row.document_id,
    title: row.document_title,
    documentType: row.document_document_type,
  }));
}

export function useBlocksQuery(issueId: string) {
  return useQuery({
    queryKey: blockingKeys.blocks(issueId),
    queryFn: () => fetchBlocks(issueId),
  });
}

export function useBlockedByQuery(issueId: string) {
  return useQuery({
    queryKey: blockingKeys.blockedBy(issueId),
    queryFn: () => fetchBlockedBy(issueId),
  });
}

/** Invalidate both lists for an issue — call after any add/remove settles. */
export function useInvalidateBlockingAssociations(issueId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: blockingKeys.blocks(issueId) });
    queryClient.invalidateQueries({ queryKey: blockingKeys.blockedBy(issueId) });
  };
}

export type AddBlocksResult = { ok: true } | { ok: false; message: string };

/** Shape of the error body `POST /:id/associations` sends on a 409. */
interface AddAssociationErrorBody {
  error?: string;
}

/**
 * The message shown when adding a `blocks` edge fails because it would close
 * a cycle.
 *
 * `POST /:id/associations` (api/src/routes/associations.ts:97-155) already
 * returns a specific 400 for the two other rejectable cases before the
 * INSERT ever runs — self-reference and a missing related document — and the
 * INSERT itself upserts on conflict rather than erroring on a duplicate. The
 * only INSERT-time failure left on this route is the
 * `prevent_circular_association` trigger (migration
 * 040_prevent_circular_associations.sql). The route now recognizes that
 * trigger's distinguishing message text server-side and maps it to a
 * dedicated `409 {"error": "CIRCULAR_ASSOCIATION"}` (TRO-344), so this
 * message is shown only when that specific code comes back — no longer
 * inferred from "any 500 on this route", which is what this ticket replaced.
 */
export const CIRCULAR_BLOCKS_MESSAGE =
  "Couldn't add that — it would create a circular blocking relationship (this issue would end up blocking itself through a chain of dependencies).";

export const GENERIC_ADD_FAILURE_MESSAGE = "Couldn't add this blocking relationship. Please try again.";

/** POST sourceId blocks targetId. Never throws — always resolves to a result. */
export async function addBlocksEdge(sourceId: string, targetId: string): Promise<AddBlocksResult> {
  try {
    const res = await apiPost(`/api/documents/${sourceId}/associations`, {
      related_id: targetId,
      relationship_type: 'blocks',
    });
    if (res.ok) {
      return { ok: true };
    }
    if (res.status === 409) {
      const body = (await res.json()) as AddAssociationErrorBody;
      if (body.error === 'CIRCULAR_ASSOCIATION') {
        return { ok: false, message: CIRCULAR_BLOCKS_MESSAGE };
      }
    }
    // 400 (self-reference / invalid input), 404 (document not
    // found/inaccessible), and any other non-cycle failure (including a
    // bare 500) already carry a reasonably specific `error` string of their
    // own server-side, but none is guaranteed to be human-readable on its
    // own (e.g. "Invalid input") — fall back to a generic, still-readable
    // message rather than surfacing the raw body.
    return { ok: false, message: GENERIC_ADD_FAILURE_MESSAGE };
  } catch {
    return { ok: false, message: GENERIC_ADD_FAILURE_MESSAGE };
  }
}

/** DELETE the blocks edge sourceId -> targetId. Never throws. */
export async function removeBlocksEdge(sourceId: string, targetId: string): Promise<boolean> {
  try {
    const res = await apiDelete(`/api/documents/${sourceId}/associations/${targetId}?type=blocks`);
    return res.ok;
  } catch {
    return false;
  }
}
