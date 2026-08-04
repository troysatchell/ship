/**
 * Never-surface check (TRO-317 / FG-5's proof #4): "an item evidenced only
 * by a document the recipient cannot see is not created."
 *
 * Mirrors `api/src/middleware/visibility.ts`'s own rule exactly (verified
 * there, not re-derived):
 *
 *   (visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE)
 *
 * Deliberately no admin branch here. FleetGraph's deployment model
 * (FLEETGRAPH.MD: "no service account... every API token belongs to a real
 * user") means the proactive poll's own token does not necessarily belong
 * to an item's RECIPIENT — evidence the poller can see is not proof the
 * recipient can. Without a per-recipient admin lookup on hand, treating
 * "possibly admin" as "not visible" is the safe direction to be wrong in:
 * it costs a delayed item (the recipient sees it once they open the
 * document directly, or a later ticket adds the admin check), never a
 * wrongly-surfaced one. All 523 documents in the current database are
 * workspace-visible (FLEETGRAPH.MD, "Private documents are currently
 * hypothetical") — this only changes behavior once a private document
 * exists, exactly the case the proof targets.
 */
export interface VisibilityCheckDocument {
  visibility: string;
  created_by: string | null;
}

export function isDocumentVisibleTo(doc: VisibilityCheckDocument, recipientUserId: string): boolean {
  return doc.visibility === 'workspace' || doc.created_by === recipientUserId;
}
