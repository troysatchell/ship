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

// =============================================================================
// Full manager-chain walk and lowest-common-manager (TRO-346/TRO-337 / FG-19)
// =============================================================================
//
// `findManagerUserId` above is single-hop by design (TRO-317's own scope —
// "who has authority to unblock a stuck plan approval" needed only the
// sprint owner's DIRECT manager). TRO-337's escalation use case is a
// genuinely different question: "the lowest-level manager with authority
// over EVERYONE blocked," which requires walking each blocked person's full
// chain to the root and intersecting them, not just comparing one hop.

/**
 * Walks `userId`'s full manager chain to the root, closest manager first —
 * repeated `findManagerUserId` hops. Does NOT include `userId` itself.
 *
 * Empty when the person has no manager on record. Per TRO-337's own verified
 * finding, this is the NORMAL case, not an edge case: "`reports_to` is set
 * on only 10 of the 20 people... the lowest-common-manager walk must handle
 * a missing link as the normal case." Also empty when `userId` isn't in the
 * directory at all — same "return an empty/absent answer rather than
 * guessing" posture `findManagerUserId` already has.
 *
 * Cycle guard: unlike `document_associations` (migration 040's BEFORE
 * trigger), nothing in Ship's schema prevents `reports_to` from forming a
 * loop (A reports to B reports to A). A `visited` set stops the walk the
 * moment it would revisit a node, rather than looping forever on malformed
 * data — same defensive posture as `expandFrontier`'s own
 * `visitedDocumentIds` guard in `graph.ts`.
 */
export function findManagerChain(userId: string, people: ReadonlyArray<PersonDirectoryEntry>): string[] {
  const chain: string[] = [];
  const visited = new Set<string>([userId]);
  let current = findManagerUserId(userId, people);
  while (current !== null && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    current = findManagerUserId(current, people);
  }
  return chain;
}

export type LowestCommonManagerReason = 'found' | 'same_reporting_line' | 'single_person' | 'no_common_manager';

export interface LowestCommonManagerResult {
  managerUserId: string | null;
  reason: LowestCommonManagerReason;
  /**
   * TRO-337's OTHER sanctioned degrade path, alongside the explicit
   * `no_common_manager` reason itself ("route to the highest reachable
   * point / say explicitly 'no common manager found'" — the ticket offers
   * both, not one over the other). Set only when `reason` is
   * `'no_common_manager'` AND at least one blocked person has SOME manager
   * on record: the manager reachable from the most blocked people's chains
   * (ties broken toward whichever sits closer to the root) — a usable
   * partial-authority target even though full authority over the group
   * could not be proven. `undefined` when nobody in the group has any
   * manager recorded at all (nothing to route to either).
   */
  highestReachableUserId?: string;
}

function directManagerOf(userId: string, people: ReadonlyArray<PersonDirectoryEntry>): string | null {
  return findManagerUserId(userId, people);
}

/**
 * True when `a` and `b` are already in the SAME reporting line — TRO-337's
 * own definition, verbatim: "one's manager chain contains the other's, or
 * they share the same direct manager." Two distinct tests, either one
 * sufficient:
 *  - Identical DIRECT (one-hop) manager — the narrower, more common case.
 *  - One is literally an ancestor manager of the other, anywhere up the
 *    chain — covers a blocked "person" who is also further up the other
 *    blocked person's reporting line.
 * When this is true there is no cross-line gap to route around: their own
 * existing manager already sees both (TRO-337 proof #3).
 */
function sameReportingLine(a: string, b: string, people: ReadonlyArray<PersonDirectoryEntry>): boolean {
  const directA = directManagerOf(a, people);
  const directB = directManagerOf(b, people);
  if (directA !== null && directA === directB) return true;

  const chainA = findManagerChain(a, people);
  const chainB = findManagerChain(b, people);
  return chainA.includes(b) || chainB.includes(a);
}

/** True only when EVERY pair among `userIds` is in the same reporting line
 * (see `sameReportingLine`) — the general-N form of TRO-337's 2-person
 * proof #3. */
function allInSameReportingLine(userIds: readonly string[], people: ReadonlyArray<PersonDirectoryEntry>): boolean {
  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const a = userIds[i];
      const b = userIds[j];
      // Unreachable given the loop bounds (i/j always index within range) —
      // an explicit guard rather than a non-null assertion, matching this
      // file's existing style under `noUncheckedIndexedAccess`.
      if (a === undefined || b === undefined) continue;
      if (!sameReportingLine(a, b, people)) return false;
    }
  }
  return true;
}

/** The fallback degrade target when no single manager provably covers every
 * blocked person (`LowestCommonManagerResult.highestReachableUserId`'s own
 * docstring). Picks whichever manager id is shared by the MOST chains,
 * tie-broken toward whichever sits closest to the root (chains are
 * closest-manager-first, so a larger index in a chain that contains it means
 * further up the tree). `undefined` when every chain is empty. */
function highestReachableManager(chains: ReadonlyArray<ReadonlyArray<string>>): string | undefined {
  const coverage = new Map<string, number>();
  for (const chain of chains) {
    for (const id of chain) {
      coverage.set(id, (coverage.get(id) ?? 0) + 1);
    }
  }
  if (coverage.size === 0) return undefined;

  const maxCoverage = Math.max(...coverage.values());
  let best: string | undefined;
  let bestDepth = -1;
  for (const [id, count] of coverage) {
    if (count !== maxCoverage) continue;
    const depth = Math.max(...chains.map((chain) => chain.indexOf(id)));
    if (depth > bestDepth) {
      best = id;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * TRO-337's own escalation arithmetic: the lowest-level manager with
 * authority over every one of `blockedUserIds` — or an explicit, typed
 * reason why none applies. Never throws; every input shape (missing links,
 * an already-connected group, too few people) is a NORMAL, handled case, not
 * an exception.
 *
 * Decision order:
 *  1. Fewer than two DISTINCT blocked people: `'single_person'` — there is
 *     no "different reporting lines" question with only one person.
 *  2. Every pair already in the same reporting line: `'same_reporting_line'`
 *     — TRO-337 proof #3, does not escalate at all (see
 *     `allInSameReportingLine`).
 *  3. Otherwise, the standard tree lowest-common-ancestor: the closest node
 *     present in EVERY blocked person's manager chain. `findManagerChain`
 *     returns each chain root-ward, closest first, so the first candidate
 *     from any one person's chain that also appears in every other chain is
 *     provably the lowest — Ship's org chart is a tree (one `reports_to`
 *     per person), so any two common ancestors of the same people lie on the
 *     same root path and are totally ordered by distance from the group.
 *  4. No node common to every chain: `'no_common_manager'` — the VERIFIED
 *     normal case per TRO-337 ("must handle a missing link as the normal
 *     case, not an exception"). A missing link anywhere upstream of any one
 *     blocked person makes a provable common authority unreachable.
 *     `highestReachableUserId` still carries a usable partial answer when
 *     one exists (see that field's own docstring) — this function always
 *     returns a typed, actionable result, never a bare `null` with nothing
 *     else to go on.
 */
export function findLowestCommonManager(
  blockedUserIds: ReadonlyArray<string>,
  people: ReadonlyArray<PersonDirectoryEntry>
): LowestCommonManagerResult {
  const distinctIds = [...new Set(blockedUserIds)];
  if (distinctIds.length < 2) {
    return { managerUserId: null, reason: 'single_person' };
  }

  if (allInSameReportingLine(distinctIds, people)) {
    return { managerUserId: null, reason: 'same_reporting_line' };
  }

  const chains = distinctIds.map((id) => findManagerChain(id, people));
  const [first, ...rest] = chains;
  // distinctIds.length >= 2 guarantees `first` exists — narrowed explicitly
  // rather than asserted (noUncheckedIndexedAccess, lessons.md #16/#21).
  if (!first) {
    return { managerUserId: null, reason: 'no_common_manager' };
  }

  for (const candidate of first) {
    if (rest.every((chain) => chain.includes(candidate))) {
      return { managerUserId: candidate, reason: 'found' };
    }
  }

  const highestReachableUserId = highestReachableManager(chains);
  return {
    managerUserId: null,
    reason: 'no_common_manager',
    ...(highestReachableUserId ? { highestReachableUserId } : {}),
  };
}
