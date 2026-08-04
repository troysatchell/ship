/**
 * The agent's own inbox-item store (TRO-317 / FG-5).
 *
 * "Design decision, already made, do not re-litigate" (the ticket's words):
 * agent items live in the agent's store, never in Ship's `documents` table
 * — the agent never creates a Ship document. This file is the store that
 * decision requires.
 *
 * Implementation choice: in-memory, not persistent. `agent/package.json`
 * has no DB/storage dependency today (checked before writing this file —
 * only `@langchain/*`, `dotenv`, `express`), and the ticket explicitly
 * allows either choice for THIS ticket. Reasons for in-memory over adding
 * one:
 *  - FLEETGRAPH.MD's own "Deployment model" section describes exactly one
 *    agent process (a single Render docker web service — `agent_service.tf`
 *    — with no mention of horizontal scaling or multiple replicas), so
 *    there is no cross-instance state to share yet.
 *  - Every item this store holds is RE-DERIVABLE from Ship's own state on
 *    the next poll — mentions and blocking approvals are computed fresh
 *    from `change-feed`/`documents`/`team/people` each cycle, never from
 *    agent-local history. Losing the store on a restart costs at most one
 *    poll cycle's delay (<=60s), not a permanently lost item — a
 *    restart-shaped version of the same "self-correcting" property
 *    FLEETGRAPH.MD already relies on for polling in general.
 *  - Adding a real DB dependency (SQLite via better-sqlite3, or a dedicated
 *    Postgres database/schema — never Ship's own) is the natural next step
 *    once multi-instance or across-restart durability actually matters.
 *    Deliberately deferred rather than adding a production dependency this
 *    ticket doesn't need.
 *
 * `ItemStore` is the seam: everything above this file depends only on the
 * interface, so swapping the implementation later touches one file.
 */

/** `standup_draft` (TRO-319 / FG-6): the deep tier's own producer, alongside
 * FG-5's `mention`/`blocking_approval` — "your drafts should probably also
 * produce items into this same shared inbox concept" (the ticket's own
 * framing). One shared list per person is the whole point of this store
 * (FLEETGRAPH.MD: "one list per person: what needs you," item #4 of which is
 * literally "drafts the agent has prepared for them") — a second,
 * parallel "drafts inbox" would fragment exactly the surface FG-5 built.
 * The full draft text and any proposed transitions do NOT live here,
 * though (see `draftId` below) — this record is a lightweight pointer into
 * `draftStore.ts`'s `DraftStore`, not a duplicate of it. */
export type InboxItemType = 'mention' | 'blocking_approval' | 'standup_draft';

export interface InboxItemEvidence {
  /** The Ship document this item is evidenced by. The never-surface check
   * (`visibility.ts`) is run against THIS document before an item carrying
   * it is ever built — see `proactive.ts` — never after.
   *
   * Optional as of TRO-319 / FG-6: a `standup_draft` item is not always
   * evidenced by an EXISTING Ship document — the agent never creates one
   * (hard limit), and a person's very first-ever draft has no prior standup
   * to point at either. Every existing producer (`proactive.ts`) still
   * always sets both fields; this widening is additive and changes no
   * existing behavior. */
  documentId?: string;
  documentType?: string;
  /** Present for comment-sourced mentions. */
  commentId?: string;
}

export interface InboxItemAction {
  label: string;
  /** Where acting on this item takes the person — a concrete Ship
   * document/route, never a vague "review this" (ticket: "every item
   * carries a direct action, not a description"). */
  href: string;
}

export interface InboxItem {
  /** Stable across polls for the SAME underlying fact — e.g.
   * `mention:document:{documentId}:{recipientUserId}` or
   * `blocking-approval:{sprintId}:{field}`. Writing with the same `id`
   * again is an upsert: FG-5 proof #1 requires that re-polling the same
   * window not duplicate an item, and this is the mechanism that
   * guarantees it structurally rather than by test-timing luck. */
  id: string;
  recipientUserId: string;
  type: InboxItemType;
  summary: string;
  evidence: InboxItemEvidence;
  action: InboxItemAction;
  /** Ranking signal (ticket: "ranking is by who else is blocked and for
   * how long") — populated for `blocking_approval` items; how many OTHER
   * people are currently blocked on the same recipient's action. */
  blockedCount?: number;
  /** ISO 8601 — when the blocking condition first appeared (the
   * `document_history` row's own timestamp), not when this item was last
   * (re-)observed. */
  blockedSince?: string;
  /** Present for `standup_draft` items — the id of the full record in
   * `draftStore.ts`'s `DraftStore` (draft text, proposed transitions,
   * accept/dismiss status). Kept out of `InboxItem` itself so this store's
   * shape stays the same for every other item type; FG-8's accept-flow
   * reads the full draft via this pointer, never off `InboxItem` directly. */
  draftId?: string;
  createdAt: string;
  updatedAt: string;
}

export type NewInboxItem = Omit<InboxItem, 'createdAt' | 'updatedAt'>;

export interface ItemStore {
  /** Insert or update by `item.id`. Preserves the original `createdAt` on
   * an update — an item's age is when the condition FIRST appeared, not
   * when it was last re-observed.
   *
   * A no-op — the item is NOT (re-)stored — when `item.id` was previously
   * `dismiss()`ed at the SAME content version (`versionKeyFor`, this file).
   * This is what makes `dismiss` mean something: without it, a dismissed id
   * reappearing in a later poll's output (e.g. an agent restart re-scanning
   * an overlapping lookback window) would resurrect it, since plain
   * `clear()` forgets a dismissal ever happened the instant the id leaves the
   * map. See `dismiss`'s own docstring for why the check is scoped to a
   * VERSION of the id, not the id forever. */
  upsert(item: NewInboxItem): InboxItem;
  /** Removes an item by id, with NO memory of the removal — a later
   * `upsert()` of the same id recreates it normally. This is the mechanism
   * `commitInboxItems` (`graph.ts`) uses when a condition ENDS (proof #2: a
   * resolved approval), where recreation is impossible by construction (the
   * condition is gone, so nothing will ever re-derive that id again) and
   * "no memory" costs nothing. It is deliberately NOT what a person's own
   * "dismiss this" action should call — see `dismiss`, which remembers.
   * Returns `false` (no-op) if the id doesn't exist, so callers can tell a
   * real clear from a no-op one. */
  clear(id: string): boolean;
  /** A person dismissing one item from their own inbox (TRO-321 / FG-8,
   * "Snooze/dismiss semantics": "dismissing clears the item; the agent must
   * not immediately re-create it on the next tick"). Removes the item (like
   * `clear`) AND records the CONTENT VERSION it was dismissed at
   * (`versionKeyFor`), so a future `upsert()` carrying an item at that exact
   * version is silently dropped instead of resurrecting it — while a
   * genuinely NEW occurrence of the same id (e.g. a blocking approval
   * re-entering `changes_requested` after a fresh review cycle, which
   * carries a new `blockedSince`) is not permanently suppressed, only the
   * specific thing that was dismissed. Returns `false` if no such item
   * currently exists (nothing to dismiss). */
  dismiss(id: string): boolean;
  get(id: string): InboxItem | undefined;
  /** Every current item for one person, ranked: `blocking_approval` first
   * (ticket / FLEETGRAPH.MD Test Case 2: "approval first because another
   * person's week cannot start"), highest `blockedCount` first within
   * that, ties broken by longest-waiting (`blockedSince` ascending); then
   * `mention` items, oldest first; then `standup_draft` items, oldest
   * first (TRO-319 / FG-6 — FLEETGRAPH.MD's own enumerated inbox list puts
   * "drafts prepared for them" last, item #4 of 4, behind mentions and
   * blocking approvals — reacting to someone ELSE's need outranks a
   * person's own not-yet-urgent paperwork). */
  list(recipientUserId: string): InboxItem[];
  /** Every item currently stored, for tests/inspection. */
  all(): InboxItem[];
}

/** Type rank, lowest sorts first. `blocking_approval` before `mention`
 * before `standup_draft` — see `list()`'s own docstring for why. */
const TYPE_RANK: Record<InboxItemType, number> = {
  blocking_approval: 0,
  mention: 1,
  standup_draft: 2,
};

/**
 * The best available "is this the SAME occurrence" signal for an item's id
 * (TRO-321 / FG-8's "dedupe on document + content version"). Deliberately
 * per-type, using whatever field on `InboxItem` already differentiates a
 * genuinely new occurrence from a replay of the same one, rather than
 * inventing a new field this ticket would have to thread through every
 * producer:
 *  - `blocking_approval`: `blockedSince` is the underlying
 *    `document_history` row's own timestamp (`proactive.ts`'s
 *    `buildBlockingApprovalItems`) — it only changes when a NEW state-change
 *    event creates a new occurrence for the same (document, field) id, so
 *    dismissing one `blockedSince` never suppresses a later, genuinely new
 *    one.
 *  - `mention` (comment-sourced): `evidence.commentId` is the change-feed's
 *    own per-comment identity. A different comment already produces a
 *    DIFFERENT item id in the first place (`mention:comment:{comment.id}:...`
 *    — see `proactive.ts`), so this is mostly redundant with `id` for this
 *    type; kept for consistency and so the fallback below is never reached
 *    for it.
 *  - Everything else (document-sourced `mention`, `standup_draft`): no
 *    finer-grained version signal exists on `InboxItem` than the id itself —
 *    a documented, pre-existing limitation (see `itemStore.ts`'s own id
 *    docstring on what an id already represents), not something this ticket
 *    solves. Dismissing by id alone is the best available answer; for
 *    `standup_draft` specifically this is moot in practice, since FG-6's own
 *    `commitStandupDraft` never re-composes the same window twice.
 */
function versionKeyFor(item: Pick<InboxItem, 'blockedSince' | 'evidence'>): string {
  return item.blockedSince ?? item.evidence.commentId ?? '';
}

function compareInboxItems(a: InboxItem, b: InboxItem): number {
  if (a.type !== b.type) {
    return TYPE_RANK[a.type] - TYPE_RANK[b.type];
  }
  if (a.type === 'blocking_approval') {
    const countDiff = (b.blockedCount ?? 0) - (a.blockedCount ?? 0);
    if (countDiff !== 0) return countDiff;
    return (a.blockedSince ?? a.createdAt).localeCompare(b.blockedSince ?? b.createdAt);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

export class InMemoryItemStore implements ItemStore {
  private readonly items = new Map<string, InboxItem>();
  /** id -> the content version it was dismissed at. See `dismiss`/`upsert`
   * and `versionKeyFor`'s own docstrings. */
  private readonly dismissedVersions = new Map<string, string>();

  /** Injected clock — tests never depend on real wall-clock time
   * (lessons.md #17, already the convention `resilientClient.test.ts`
   * follows). */
  constructor(private readonly now: () => Date = () => new Date()) {}

  upsert(item: NewInboxItem): InboxItem {
    const nowIso = this.now().toISOString();
    const existing = this.items.get(item.id);
    const full: InboxItem = {
      ...item,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const dismissedAt = this.dismissedVersions.get(item.id);
    if (dismissedAt !== undefined && dismissedAt === versionKeyFor(full)) {
      // Exact replay of what was dismissed — proof #4 (TRO-321 / FG-8): do
      // NOT resurrect it. Still returns the constructed record (informational
      // — matches this method's normal return shape for any caller that
      // inspects it) but never stores it, so get()/list()/all() do not see it.
      return full;
    }

    this.items.set(item.id, full);
    return full;
  }

  clear(id: string): boolean {
    return this.items.delete(id);
  }

  dismiss(id: string): boolean {
    const existing = this.items.get(id);
    if (!existing) return false;
    this.dismissedVersions.set(id, versionKeyFor(existing));
    this.items.delete(id);
    return true;
  }

  get(id: string): InboxItem | undefined {
    return this.items.get(id);
  }

  list(recipientUserId: string): InboxItem[] {
    return this.all()
      .filter((item) => item.recipientUserId === recipientUserId)
      .sort(compareInboxItems);
  }

  all(): InboxItem[] {
    return [...this.items.values()];
  }
}
