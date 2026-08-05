/**
 * The blocker-escalation fan-out walk (TRO-346/TRO-337 / FG-19, "use case 5"
 * in FLEETGRAPH.MD's Use Cases table) — deterministic, no model call
 * anywhere in this file, matching `proactive.ts` (FG-5) and
 * `standupDraft.ts` (FG-6)'s own structure: `graph.ts`'s nodes stay thin
 * wrappers around these functions.
 *
 * Scope (TRO-337's own Scope section, verbatim): "When an issue blocks work
 * in two or more projects whose blocked people sit in different reporting
 * lines: the full impact (which issues, which projects, which people), the
 * lowest-level manager with authority over everyone blocked, and a drafted
 * message to that person."
 *
 * `gatherBlockerFanout` builds the impact fan-out ONLY — which issues,
 * projects, and people are touched. It never decides whether to escalate;
 * that arithmetic is `roles.ts`'s `findLowestCommonManager`, called from
 * `graph.ts`'s `detectBlockerFanout` node once the fan-out is known (the
 * escalation decision needs BOTH the fan-out's project count and its
 * people's reporting lines, so it belongs one level up, where both are
 * available).
 *
 * Association direction, verified against `api/src/db/migrations/
 * 041_add_blocks_relationship.sql`'s own comment ("Directional by
 * construction... document_id blocks related_id") and
 * `api/src/routes/associations.ts`: a FORWARD `blocks` edge from the
 * blocking issue (`getAssociations(blockingIssueId, 'blocks')`) returns the
 * issues it blocks. Containment (which project an issue belongs to) is the
 * SAME forward direction, one hop, relationship_type `'project'` — verified
 * against `associations.ts`'s own `/:id/context` `belongsToQuery`, which
 * reads it identically (`da.document_id = issue`, `da.relationship_type =
 * 'project'`, joined to `d.id = da.related_id`).
 *
 * Trust boundary: `getAssociations`' own docstring (`shipClient.ts`) warns
 * it checks access on the ANCHOR document only, never on each joined
 * `related_id` — a private document's id/title can leak through. Every
 * candidate here is re-fetched through `getDocument` (which DOES check
 * per-document access) before anything about it is trusted, exactly matching
 * `standupDraft.ts`'s `findBlocker` and `expansion.ts`'s `visitDocument`.
 */
import type { AssociationForwardEdge, DeepShipClientLike, ShipDocument } from './shipClient.js';
import type { LowestCommonManagerResult } from './roles.js';

export interface BlockedIssueImpact {
  issueId: string;
  title: string;
  projectId: string | null;
  projectTitle: string | null;
  /** `null` when the blocked issue has no assignee — it still appears in
   * the fan-out (the impact is real either way), but contributes no one to
   * the escalation's "blocked people" set (nobody to notify on its behalf). */
  assigneeUserId: string | null;
}

export interface BlockerFanoutImpact {
  blockingIssueId: string;
  blockingIssueTitle: string;
  blockingIssueProjectId: string | null;
  blockingIssueProjectTitle: string | null;
  blockedIssues: BlockedIssueImpact[];
  /** Every distinct project touched, INCLUDING the blocking issue's own —
   * TRO-337's trigger condition counts both ("an issue blocks work in two or
   * more projects"), not just the blocked side; Test Case 5's own shape (an
   * issue in Project A blocking two issues in Project B) is exactly one
   * blocking-side project plus one blocked-side project, two total. */
  distinctProjectIds: string[];
  /** Distinct assignee user ids among blocked issues, deduplicated. */
  blockedPeopleUserIds: string[];
}

/** Never throws — a document that is gone or invisible to this token is not
 * evidence of anything the walk can act on, same posture as `proactive.ts`'s
 * `tryGetDocument` and `standupDraft.ts`'s `findBlocker`. */
async function tryGetDocument(
  client: Pick<DeepShipClientLike, 'getDocument'>,
  id: string
): Promise<ShipDocument | undefined> {
  try {
    return await client.getDocument(id);
  } catch {
    return undefined;
  }
}

/** The project an issue belongs to, re-verified through `getDocument` before
 * its title is trusted (see this file's module docstring). `null` when the
 * issue has no `project` association, or when the association's target
 * turns out to be gone/inaccessible. */
async function resolveProjectRef(
  client: Pick<DeepShipClientLike, 'getAssociations' | 'getDocument'>,
  issueId: string
): Promise<{ id: string; title: string } | null> {
  let edges: AssociationForwardEdge[];
  try {
    edges = await client.getAssociations(issueId, 'project');
  } catch {
    return null;
  }
  const first = edges[0];
  if (!first) return null;

  const project = await tryGetDocument(client, first.related_id);
  return project ? { id: project.id, title: project.title } : null;
}

function assigneeIdOf(doc: ShipDocument): string | null {
  return typeof doc.properties.assignee_id === 'string' ? doc.properties.assignee_id : null;
}

/**
 * Builds the full impact fan-out from `blockingIssueId` — which issues it
 * blocks, which projects those touch (plus its own), and which people are
 * blocked. `undefined` when the blocking issue itself is gone or invisible
 * to this token — nothing to fan out from, not an error.
 *
 * Fetches the blocking issue and its `blocks` edges first (sequentially —
 * the edges depend on nothing else), then every blocked edge concurrently
 * (`Promise.all`, order preserved by index — each edge's own document fetch
 * and project resolution also start together rather than one waiting on the
 * other, since neither reads the other's result), matching
 * `standupDraft.ts`'s `gatherPersonActivity` concurrency shape. CodeRabbit
 * (TRO-346 PR review): the original sequential per-edge loop paid up to
 * 3 round trips × N blocked issues in series; this is unbounded (no
 * `documentCap`-style limit) because `blocks` fan-out is expected to stay
 * small in practice (TRO-337's own use case is 2 blocked issues) — a page
 * with dozens of blocked issues would need a bound this ticket doesn't add.
 */
export async function gatherBlockerFanout(
  client: Pick<DeepShipClientLike, 'getDocument' | 'getAssociations'>,
  blockingIssueId: string
): Promise<BlockerFanoutImpact | undefined> {
  const blockingIssue = await tryGetDocument(client, blockingIssueId);
  if (!blockingIssue) return undefined;

  const blockingProject = await resolveProjectRef(client, blockingIssueId);

  let edges: AssociationForwardEdge[];
  try {
    edges = await client.getAssociations(blockingIssueId, 'blocks');
  } catch {
    edges = [];
  }

  const resolvedEdges = await Promise.all(
    edges.map(async (edge) => {
      const [blockedDoc, project] = await Promise.all([
        tryGetDocument(client, edge.related_id),
        resolveProjectRef(client, edge.related_id),
      ]);
      if (!blockedDoc) return null; // gone/inaccessible — not real, verified impact
      const impact: BlockedIssueImpact = {
        issueId: blockedDoc.id,
        title: blockedDoc.title,
        projectId: project?.id ?? null,
        projectTitle: project?.title ?? null,
        assigneeUserId: assigneeIdOf(blockedDoc),
      };
      return impact;
    })
  );
  const blockedIssues: BlockedIssueImpact[] = resolvedEdges.filter(
    (issue): issue is BlockedIssueImpact => issue !== null
  );

  const distinctProjectIds = [
    ...new Set([blockingProject?.id, ...blockedIssues.map((b) => b.projectId)].filter((id): id is string => id !== null && id !== undefined)),
  ];
  const blockedPeopleUserIds = [
    ...new Set(blockedIssues.map((b) => b.assigneeUserId).filter((id): id is string => id !== null)),
  ];

  return {
    blockingIssueId: blockingIssue.id,
    blockingIssueTitle: blockingIssue.title,
    blockingIssueProjectId: blockingProject?.id ?? null,
    blockingIssueProjectTitle: blockingProject?.title ?? null,
    blockedIssues,
    distinctProjectIds,
    blockedPeopleUserIds,
  };
}

/**
 * Builds the text handed to `model.invoke` — every fan-out fact
 * `gatherBlockerFanout` found, plus the LCA outcome, plus explicit
 * instructions the model must follow. Deterministic: the same inputs always
 * produce the same prompt (matching `standupDraft.ts`'s `buildStandupPrompt`
 * and `expansion.ts`'s `buildExpansionPrompt`).
 *
 * Two shapes, driven by `manager.reason`:
 *  - `'found'`: address the message to the confirmed lowest common manager.
 *  - `'no_common_manager'`: TRO-337's own degrade path — the draft says so
 *    plainly rather than asserting authority the walk could not prove, and
 *    names the best-available partial contact when one exists
 *    (`highestReachableUserId`).
 * `composeBlockerEscalation` (`graph.ts`) never calls this for
 * `'single_person'`/`'same_reporting_line'` — those mean no escalation is
 * warranted at all, so no prompt (and no model call) is ever built for them.
 */
export function buildBlockerEscalationPrompt(impact: BlockerFanoutImpact, manager: LowestCommonManagerResult): string {
  const lines: string[] = [];

  lines.push(
    'Draft a short message escalating a cross-project blocker to a manager. This is a DRAFT the ' +
      'recipient will review and decide whether to send, or step in directly instead — it must never ' +
      'read as though it has already been sent.'
  );
  lines.push('');
  lines.push(
    `Blocking issue: "${impact.blockingIssueTitle}"` +
      (impact.blockingIssueProjectTitle ? ` (project: "${impact.blockingIssueProjectTitle}")` : '')
  );
  lines.push('');
  lines.push(`Impact — ${impact.blockedIssues.length} blocked issue(s) across ${impact.distinctProjectIds.length} project(s):`);
  for (const b of impact.blockedIssues) {
    const project = b.projectTitle ? ` in project "${b.projectTitle}"` : '';
    const assignee = b.assigneeUserId ? ' (assigned)' : ' (unassigned)';
    lines.push(`- "${b.title}"${project}${assignee}`);
  }
  lines.push('');

  if (manager.reason === 'found') {
    lines.push('Address the message to the manager who has authority over everyone blocked.');
  } else {
    lines.push(
      'No single manager could be confirmed to have authority over everyone blocked — the recorded ' +
        'reporting-chain data does not fully connect for this group. State this plainly in the draft, ' +
        'and ask the recipient to loop in whoever else needs to be involved.'
    );
  }
  lines.push('');
  lines.push('Rules:');
  lines.push('- Do not state or imply this message has already been sent.');
  lines.push('- Never write a performance rating or any qualitative judgment of anyone involved.');
  lines.push('- State only the facts listed above. Never invent an issue, project, or person not listed.');

  return lines.join('\n');
}
