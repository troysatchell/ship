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
   * when it was last re-observed. */
  upsert(item: NewInboxItem): InboxItem;
  /** Removes an item by id. A no-op (returns `false`) if it doesn't exist,
   * so callers can tell a real clear from a no-op one. */
  clear(id: string): boolean;
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
    this.items.set(item.id, full);
    return full;
  }

  clear(id: string): boolean {
    return this.items.delete(id);
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
