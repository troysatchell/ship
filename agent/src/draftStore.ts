/**
 * The deep tier's own draft store (TRO-319 / FG-6) — where a composed
 * standup draft's full text and any proposed issue transitions live.
 *
 * Kept SEPARATE from `itemStore.ts`'s `ItemStore`, deliberately:
 *  - `ItemStore`'s lifecycle is "upsert while a condition holds, clear when
 *    it ends" (a mention exists until seen; a blocking approval exists until
 *    resolved). A draft's lifecycle is different in kind — unseen -> viewed
 *    -> dismissed/posted — and nothing about it is "the underlying condition
 *    ended," so forcing it through `clear()` would be a lie about what
 *    happened.
 *  - A draft carries data no other `InboxItem` needs (full prose text,
 *    a list of `ProposedTransition`s with their evidence) — widening
 *    `InboxItem` itself to carry these for exactly one item type would bloat
 *    every other item's shape for a case that does not apply to them.
 *  - The ticket's own quality-survival requirement ("record it from day
 *    one") needs the ORIGINAL composed text to stay retrievable,
 *    untouched, indefinitely — a different retention shape than an inbox
 *    item, which normally exists only until its condition resolves.
 *
 * `itemStore.ts` still gets a lightweight `standup_draft` `InboxItem` per
 * draft (see that file's own reasoning) — this store is what that item's
 * `draftId` points at. Same in-memory implementation choice as
 * `itemStore.ts`, same reasoning (single agent process today, no
 * cross-instance state to share; see that file's docstring — not repeated
 * here).
 */

export type DraftStatus = 'unseen' | 'viewed' | 'dismissed' | 'posted';

/** A proposed transition's own accept/reject state (TRO-321 / FG-8) —
 * separate from `StandupDraft.status`, deliberately: a draft's status is
 * about the DRAFT TEXT (has it been posted?), while this is about ONE
 * transition among possibly several the same draft carries. "Rejecting one
 * proposed transition and accepting another applies exactly one" (the
 * ticket's proof #5) needs per-transition state, not per-draft state, or
 * accepting one would have no way to leave its siblings untouched. Absent
 * (`undefined`) on a freshly-built `ProposedTransition` (e.g.
 * `standupDraft.ts`'s `buildProposedTransitions`, which predates this ticket
 * and does not set it) is normalized to `'pending'` by
 * `InMemoryDraftStore.upsert` — see that method. */
export type ProposedTransitionStatus = 'pending' | 'accepted' | 'rejected';

/**
 * An issue state transition the agent OBSERVED (via `document_history`) or
 * inferred, attached to a draft with its evidence — never applied by the
 * agent itself (TRO-319's hard limit: "It may propose one with its evidence
 * attached; a person accepts it. It never applies one."). Nothing in this
 * package ever calls a Ship endpoint that would apply one — see
 * `shipClient.ts`'s `DeepShipClientLike` docstring: the type this path reads
 * through has no write method to call in the first place. `gate.ts`
 * (TRO-321 / FG-8) is the one place downstream that DOES apply one, via the
 * separate, explicitly write-capable `GateShipClientLike` — never through
 * this type.
 */
export interface ProposedTransition {
  issueId: string;
  issueTitle: string;
  field: string;
  fromState: string | null;
  toState: string | null;
  evidence: {
    /** Always `'history'` today — the only evidence source this ticket
     * builds (a real `document_history` row, via the change feed). Kept as
     * a tag rather than a bare object so a future evidence source (e.g. a
     * comment implying readiness with no history row yet) is additive. */
    kind: 'history';
    changedAt: string;
    changedBy: string | null;
  };
  /** Optional so every existing `ProposedTransition` producer (just
   * `standupDraft.ts`'s `buildProposedTransitions` today) keeps compiling
   * unchanged — see this field's own type docstring for how the gap is
   * closed once a transition is inside the store. */
  status?: ProposedTransitionStatus;
}

export interface StandupDraft {
  /** Stable per (person, window) — `standup-draft:{personUserId}:{windowDate}`
   * (`graph.ts`'s `commitStandupDraft`). Re-composing the same window is an
   * upsert, mirroring `itemStore.ts`'s own idempotency contract. */
  id: string;
  personUserId: string;
  /** YYYY-MM-DD — the day this draft was composed for. */
  windowDate: string;
  /** The model's ORIGINAL composed text, never mutated after creation —
   * the quality-survival signal's groundwork ("how much of a draft survives
   * to the posted version"). Whatever a person edits to before posting is a
   * DIFFERENT string that FG-8's accept-flow owns capturing; diffing the two
   * is explicitly FG-8's concern (or later), not built here — see this
   * file's module docstring and TRO-319's own scope note. Immutability is
   * what makes that future diff possible at all: if `upsert` ever
   * overwrote this field, the "original" would already be gone by the time
   * anything tried to compare against it. */
  draftText: string;
  proposedTransitions: ProposedTransition[];
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  /** What was actually posted to Ship, set once by `markPosted` at accept
   * time and never touched again (TRO-338 / FG-20). `undefined` until then
   * — most drafts never reach `'posted'` at all (dismissed, or still
   * sitting unseen), and this field has nothing to hold in those cases.
   * Together with `draftText` (the immutable original), this is what makes
   * the draft-survival metric possible with zero labelling effort: both
   * versions are already sitting here the moment a person accepts —
   * `draftSurvival.ts`'s `computeDraftSurvival` is a pure comparison of the
   * two, no human ever asked to score anything. */
  finalText?: string;
}

export type NewStandupDraft = Pick<StandupDraft, 'id' | 'personUserId' | 'windowDate' | 'draftText' | 'proposedTransitions'>;

export interface DraftStore {
  /** Insert or update by `draft.id`. An update REPLACES `draftText`/
   * `proposedTransitions` (a re-composed same-window draft is a fresh
   * draft) but preserves `createdAt` and — deliberately — does NOT reset
   * `status` back to `'unseen'` if the caller already marked it viewed;
   * see `upsert`'s implementation comment for why that specific case
   * doesn't arise in practice yet. */
  upsert(draft: NewStandupDraft): StandupDraft;
  markViewed(id: string): boolean;
  markDismissed(id: string): boolean;
  /** FG-8's own call, from `gate.ts`'s `acceptDraft` — the one place in
   * this package that actually posts a draft. `finalText` is REQUIRED
   * (TRO-338 / FG-20): the whole point of this method retaining it is that
   * the draft-survival comparison (`draftSurvival.ts`) needs both the
   * original `draftText` and whatever was actually posted, and there is no
   * legitimate call to "mark posted" without knowing what was posted. */
  markPosted(id: string, finalText: string): boolean;
  /** Accepts or rejects ONE proposed transition on a draft, by its index
   * within `proposedTransitions` — never any other transition on the same
   * draft (TRO-321 / FG-8 proof #5). Returns `false`, and changes nothing,
   * if: the draft doesn't exist, `index` is out of range, or that
   * transition is not currently `'pending'` (already accepted/rejected —
   * acting on it twice is refused, not silently repeated or overwritten).
   * `gate.ts` is the only caller that applies the actual Ship write for
   * `'accepted'`; this method only ever records the outcome, it never
   * performs one itself. */
  setProposedTransitionStatus(draftId: string, index: number, status: 'accepted' | 'rejected'): boolean;
  get(id: string): StandupDraft | undefined;
  /** Every draft for one person, newest window first. */
  listForPerson(personUserId: string): StandupDraft[];
  /**
   * The waste-control stop condition (TRO-319, "cost cliff #3"): false once
   * the person's unbroken run of most-recent UNSEEN drafts has spanned
   * `thresholdDays` — "if a person ignores their drafts for two weeks, stop
   * generating them and let them ask." A single `viewed`/`dismissed`/
   * `posted` draft anywhere in that run resets it; only an unbroken run of
   * ignored drafts, run from the most recent backward, counts. Time-based
   * (using each draft's `createdAt`) rather than a draft COUNT, so the
   * check stays correct even if a window is occasionally skipped (no
   * assigned issues that day, etc.) rather than assuming exactly one draft
   * per calendar day.
   */
  shouldGenerateDraftFor(personUserId: string, thresholdDays?: number): boolean;
}

const DEFAULT_IGNORE_THRESHOLD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export class InMemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, StandupDraft>();

  /** Injected clock — tests never depend on real wall-clock time
   * (lessons.md #17, matching `itemStore.ts`'s own convention). */
  constructor(private readonly now: () => Date = () => new Date()) {}

  upsert(draft: NewStandupDraft): StandupDraft {
    const nowIso = this.now().toISOString();
    const existing = this.drafts.get(draft.id);
    const full: StandupDraft = {
      ...draft,
      // TRO-321 / FG-8: normalize every incoming transition's `status` to
      // 'pending' when the producer didn't set one — `standupDraft.ts`'s
      // `buildProposedTransitions` predates this field and never does. Once a
      // transition is inside the store it always has a concrete status; only
      // the producer-facing type leaves it optional (see that field's own
      // docstring).
      proposedTransitions: draft.proposedTransitions.map((t) => ({ ...t, status: t.status ?? 'pending' })),
      // A re-composed draft for the SAME window is fresh content — status
      // is not reset to 'unseen' on top of an already-viewed/dismissed/
      // posted draft, because nothing in this ticket ever re-composes a
      // window after it was acted on (`gatherStandupActivity` only ever
      // runs for TODAY's window, once). Kept as a real preservation rather
      // than an assumption baked into `commitStandupDraft`, so a future
      // caller that DOES re-run a window mid-day inherits safe behavior
      // instead of silently un-dismissing something a person already
      // dealt with.
      status: existing?.status ?? 'unseen',
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    this.drafts.set(draft.id, full);
    return full;
  }

  setProposedTransitionStatus(draftId: string, index: number, status: 'accepted' | 'rejected'): boolean {
    const existing = this.drafts.get(draftId);
    if (!existing) return false;
    const transition = existing.proposedTransitions[index];
    // `status` is always normalized by `upsert` above, but a defensive
    // fallback keeps this correct even against a hand-built fixture in a
    // test that skips `upsert` — same defensive posture as this file's other
    // `?? 'pending'`/`?? 'unseen'` normalizations.
    if (!transition || (transition.status ?? 'pending') !== 'pending') return false;

    const updated = [...existing.proposedTransitions];
    updated[index] = { ...transition, status };
    this.drafts.set(draftId, { ...existing, proposedTransitions: updated, updatedAt: this.now().toISOString() });
    return true;
  }

  private setStatus(id: string, status: DraftStatus): boolean {
    const existing = this.drafts.get(id);
    if (!existing) return false;
    this.drafts.set(id, { ...existing, status, updatedAt: this.now().toISOString() });
    return true;
  }

  markViewed(id: string): boolean {
    return this.setStatus(id, 'viewed');
  }

  markDismissed(id: string): boolean {
    return this.setStatus(id, 'dismissed');
  }

  markPosted(id: string, finalText: string): boolean {
    const existing = this.drafts.get(id);
    if (!existing) return false;
    // Not just `setStatus` — this is the one place `finalText` is ever
    // written (TRO-338 / FG-20), and it is written exactly once: nothing
    // in this class re-posts an already-`posted` draft (`gate.ts`'s
    // `acceptDraft` refuses that before this is ever called), so there is
    // no "second post" case that would need to decide whether to overwrite
    // an existing `finalText`.
    this.drafts.set(id, { ...existing, status: 'posted', finalText, updatedAt: this.now().toISOString() });
    return true;
  }

  get(id: string): StandupDraft | undefined {
    return this.drafts.get(id);
  }

  listForPerson(personUserId: string): StandupDraft[] {
    return [...this.drafts.values()]
      .filter((d) => d.personUserId === personUserId)
      .sort((a, b) => b.windowDate.localeCompare(a.windowDate));
  }

  shouldGenerateDraftFor(personUserId: string, thresholdDays = DEFAULT_IGNORE_THRESHOLD_DAYS): boolean {
    // Newest first (see listForPerson) — walk backward from the most recent
    // draft, stopping at the first one that was ever acted on. `oldestUnseen`
    // ends up holding the CREATION time of the oldest draft in that unbroken
    // ignored run.
    const drafts = this.listForPerson(personUserId);
    let oldestUnseenCreatedAt: string | undefined;
    for (const draft of drafts) {
      if (draft.status !== 'unseen') break;
      oldestUnseenCreatedAt = draft.createdAt;
    }

    if (!oldestUnseenCreatedAt) return true; // no unbroken ignored run — generate normally

    const streakAgeMs = this.now().getTime() - new Date(oldestUnseenCreatedAt).getTime();
    return streakAgeMs < thresholdDays * DAY_MS;
  }
}
