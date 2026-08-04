/**
 * Structural authority derivation (TRO-317 / FG-5) — never read from a
 * field. `job_role` is free text and empty on all 20 seeded people;
 * `workspace_memberships.role` is authorization-only ("admin"/"member"),
 * which its own schema comment states in capitals. FLEETGRAPH.MD's
 * Director/PM/Engineer taxonomy is real but not needed by anything in this
 * ticket's scope (mention resolution + approval-blocking) — left for
 * whichever later FG ticket routes an escalation or needs to tell a
 * Director apart from a PM.
 *
 * What THIS ticket needs is narrower: who has authority to unblock a stuck
 * plan approval. That is the sprint owner's direct manager —
 * `person.properties.reports_to` — verified (not assumed) to hold the
 * manager's USER id directly, not a person-document id:
 * `api/src/routes/reports-to.test.ts` sets it to `adminUserId`/a
 * supervisor's user id, and `api/src/routes/weeks.ts`'s own
 * `getSprintOwnerReportsTo` reads it the same way for its approval
 * authorization check. `ShipClient.getPeople()`'s `reportsTo` field carries
 * this value already resolved.
 */
export interface PersonDirectoryEntry {
  user_id: string | null;
  reportsTo: string | null;
}

/**
 * Looks up `ownerUserId`'s manager in the people directory. Returns `null`
 * when the owner isn't found, or has no manager on record — FLEETGRAPH.MD
 * notes only half the people in the system have `reports_to` set, and
 * escalation "degrades gracefully when the link is absent" rather than
 * guessing.
 */
export function findManagerUserId(
  ownerUserId: string,
  people: ReadonlyArray<PersonDirectoryEntry>
): string | null {
  const owner = people.find((p) => p.user_id === ownerUserId);
  return owner?.reportsTo ?? null;
}
