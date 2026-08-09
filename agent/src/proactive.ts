/**
 * The fast tier's detection logic (TRO-317 / FG-5) — deterministic, no
 * model call anywhere in this file. Composed of small, independently
 * testable functions so `graph.ts`'s nodes stay thin wrappers around them.
 *
 * Scope (the ticket's Scope section): resolve mentions to people to user
 * accounts, and detect approvals a person is blocking. Both are "a
 * structured lookup with no interpretation" (FLEETGRAPH.MD).
 */
import type { ChangeFeedResponse, ShipClientLike, ShipDocument, ShipPerson } from './shipClient.js';
import { extractLiteralNameMentions, extractPersonMentionDocIds } from './mentions.js';
import { isDocumentVisibleTo } from './visibility.js';
import { findManagerUserId } from './roles.js';
import type { NewInboxItem } from './itemStore.js';

export interface ProactivePollResult {
  feed: ChangeFeedResponse;
  nextCursor: string;
}

/** Fetches one change-feed page. Thin on purpose — `graph.ts`'s
 * `pollChangeFeed` node is the only caller, and it also needs the people
 * directory fetched the same run; this function stays single-purpose so
 * each half is independently testable. */
export async function pollChangeFeed(
  client: ShipClientLike,
  since: string,
  limit?: number
): Promise<ProactivePollResult> {
  const feed = await client.getChangeFeed(since, limit);
  return { feed, nextCursor: feed.next_cursor };
}

function directoryByDocId(people: readonly ShipPerson[]): Map<string, ShipPerson> {
  return new Map(people.map((p) => [p.id, p]));
}

/**
 * Builds mention inbox items from one change-feed page — never writes them
 * (that's `commitInboxItems` in graph.ts, via `ItemStore`). Every candidate
 * is checked against the RECIPIENT's own visibility, not the polling
 * token's, before being included (proof #4: "an item evidenced only by a
 * document the recipient cannot see is not created").
 *
 * Two independent sources, per `mentions.ts`'s docstring:
 *  - Comments (`feed.comments[].content`) — literal `@Full Name` text,
 *    already present in the feed page, no extra fetch needed.
 *  - Document bodies (`feed.documents[]`) — the feed only carries
 *    id/title/timestamp, not content, so each candidate needs one
 *    `getDocument` fetch to walk its TipTap `content` for structured
 *    mention nodes. Acceptable at this tier's ~60s cadence (this ticket
 *    implements the poll-based steady tier only — see the ticket's
 *    "Performance requirement" section: the save-hook fast path is a
 *    future optimization on top of this correct baseline, not something
 *    this ticket's scope depends on).
 */
export async function buildMentionItems(
  client: ShipClientLike,
  feed: ChangeFeedResponse,
  people: readonly ShipPerson[]
): Promise<NewInboxItem[]> {
  const byDocId = directoryByDocId(people);
  const items: NewInboxItem[] = [];

  for (const comment of feed.comments) {
    const mentionedDocIds = extractLiteralNameMentions(
      comment.content,
      people.map((p) => ({ id: p.id, name: p.name }))
    );
    if (mentionedDocIds.length === 0) continue;

    const parentDoc = await tryGetDocument(client, comment.document_id);
    if (!parentDoc) continue; // gone/unreachable — nothing to evidence the item with

    for (const personDocId of mentionedDocIds) {
      const recipient = byDocId.get(personDocId);
      if (!recipient?.user_id) continue; // no linked account — nothing to notify
      if (!isDocumentVisibleTo(parentDoc, recipient.user_id)) continue;

      items.push({
        id: `mention:comment:${comment.id}:${recipient.user_id}`,
        recipientUserId: recipient.user_id,
        type: 'mention',
        summary: `Mentioned in a comment on "${parentDoc.title}"`,
        evidence: {
          documentId: parentDoc.id,
          documentType: parentDoc.document_type,
          commentId: comment.comment_id,
        },
        action: { label: 'View comment', href: `/documents/${parentDoc.id}` },
      });
    }
  }

  for (const doc of feed.documents) {
    const fullDoc = await tryGetDocument(client, doc.id);
    if (!fullDoc) continue;

    const mentionedDocIds = extractPersonMentionDocIds(fullDoc.content);
    if (mentionedDocIds.length === 0) continue;

    for (const personDocId of mentionedDocIds) {
      const recipient = byDocId.get(personDocId);
      if (!recipient?.user_id) continue;
      if (!isDocumentVisibleTo(fullDoc, recipient.user_id)) continue;

      items.push({
        id: `mention:document:${fullDoc.id}:${recipient.user_id}`,
        recipientUserId: recipient.user_id,
        type: 'mention',
        summary: `Mentioned in "${fullDoc.title}"`,
        evidence: { documentId: fullDoc.id, documentType: fullDoc.document_type },
        action: { label: 'View document', href: `/documents/${fullDoc.id}` },
      });
    }
  }

  return items;
}

async function tryGetDocument(client: ShipClientLike, id: string): Promise<ShipDocument | undefined> {
  try {
    return await client.getDocument(id);
  } catch {
    // Deleted, unreachable, or the polling token can no longer see it — none
    // of these are evidence of anything the agent can act on, so the
    // candidate is skipped rather than surfaced on a guess.
    return undefined;
  }
}

const APPROVAL_FIELDS = new Set(['plan_approval', 'review_approval']);

export interface BlockingApprovalResult {
  items: NewInboxItem[];
  /** Item ids whose blocking condition has ended this poll (state moved to
   * 'approved') — the caller clears these from the store (proof #2: "an
   * item is cleared automatically when its condition ends"). */
  resolvedIds: string[];
}

/**
 * Builds blocking-approval inbox items (and the ids of items whose
 * condition just ended) from one change-feed page's `history` entries.
 *
 * Routing decision (the ticket leaves the exact recipient open — this is
 * this ticket's call, made against verified code, not guessed):
 *  - `state === 'changes_requested'`: the OWNER must revise and resubmit —
 *    mirrors `api/src/services/accountability.ts`'s existing
 *    `checkChangesRequested`, but delivered PROACTIVELY here instead of
 *    only when the owner happens to ask their own accountability check.
 *  - `state` is null/pending or `'changed_since_approved'`: the
 *    structurally-derived APPROVER (the owner's manager, `roles.ts`)
 *    hasn't (re-)approved yet. This is the actual gap the ticket's cost
 *    section describes — nothing today tells an approver that plans are
 *    sitting in their queue blocking other people's weeks; only the owner
 *    ever finds out anything, and only reactively.
 *  - `state === 'approved'` (or the field was cleared, `new_value` null):
 *    the condition ended — queued for clearing, never for (re)writing.
 */
export async function buildBlockingApprovalItems(
  client: ShipClientLike,
  feed: ChangeFeedResponse,
  people: readonly ShipPerson[]
): Promise<BlockingApprovalResult> {
  const items: NewInboxItem[] = [];
  const resolvedIds: string[] = [];

  const relevant = feed.history.filter((h) => APPROVAL_FIELDS.has(h.field));

  // Only the LATEST transition per (document, field) matters for "is this
  // blocked right now" — a window can carry several transitions for the
  // same sprint (e.g. submitted then changes-requested in one poll cycle).
  const latestByKey = new Map<string, (typeof relevant)[number]>();
  for (const entry of relevant) {
    const key = `${entry.document_id}:${entry.field}`;
    const prior = latestByKey.get(key);
    if (!prior || entry.created_at > prior.created_at) {
      latestByKey.set(key, entry);
    }
  }

  for (const entry of latestByKey.values()) {
    const itemId = `blocking-approval:${entry.document_id}:${entry.field}`;

    let approval: { state: string | null } | null;
    try {
      approval = entry.new_value ? (JSON.parse(entry.new_value) as { state: string | null }) : null;
    } catch {
      continue; // malformed history payload — nothing structured to act on
    }

    if (!approval || approval.state === 'approved') {
      resolvedIds.push(itemId);
      continue;
    }

    const sprint = await tryGetDocument(client, entry.document_id);
    if (!sprint) continue;

    // Ground truth, not the generic route's assignee_ids[0]-derived alias
    // — see shipClient.ts's docstring for why that alias is a trap here.
    const ownerUserId = typeof sprint.properties.owner_id === 'string' ? sprint.properties.owner_id : null;
    if (!ownerUserId) continue;

    const recipientUserId =
      approval.state === 'changes_requested' ? ownerUserId : findManagerUserId(ownerUserId, people);
    if (!recipientUserId) continue; // no manager on record — degrades gracefully (FLEETGRAPH.MD)

    if (!isDocumentVisibleTo(sprint, recipientUserId)) continue;

    items.push({
      id: itemId,
      recipientUserId,
      type: 'blocking_approval',
      summary:
        approval.state === 'changes_requested'
          ? `Changes requested on "${sprint.title}" — revise and resubmit`
          : `"${sprint.title}" is waiting on your plan approval`,
      evidence: { documentId: sprint.id, documentType: sprint.document_type },
      action: { label: 'Review plan', href: `/documents/${sprint.id}` },
      blockedSince: entry.created_at,
    });
  }

  return { items, resolvedIds };
}
