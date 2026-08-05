/**
 * The human-in-the-loop gate (TRO-321 / FG-8) — the module that makes
 * FLEETGRAPH.MD's rule structural instead of a hope: "Every output is either
 * an action a query proved, or a draft a human confirms. The agent never has
 * an opinion it expects you to act on."
 *
 * Everything FG-5/FG-7/FG-6 built stops at Ship's own front door: mentions
 * and blocking approvals live in `ItemStore`, standup drafts and their
 * proposed transitions live in `DraftStore`, and nothing upstream of this
 * file ever writes to Ship (see `graph.ts`'s module docstring and
 * `agent/src/__tests__/graphWriteBoundary.test.ts` for the proof). This file
 * is where a human's own decision — expressed through their own token, never
 * the agent's — turns a draft or a proposal into a real Ship write.
 *
 * Every function here takes the ACTING PERSON'S OWN TOKEN as an explicit
 * parameter, never reads one from `AgentConfig`/env — see `shipClient.ts`'s
 * "gate's write-capable client" section for why that is structural, not a
 * convention. There is no code path in this file — or anywhere in this
 * package — that can perform a Ship write under the agent's own identity,
 * because `GateShipClientLike` has no token to fall back to in the first
 * place.
 *
 * Scope, per the ticket:
 *  - Accept a draft: the real Ship write (`POST /api/standups` then
 *    `PATCH /api/standups/:id` to set its content), attributed to the
 *    accepting person, then `draftStore.markPosted` — which, as of TRO-338 /
 *    FG-20, also retains exactly what was posted (`finalText`) so the
 *    draft-survival metric ("how much of a draft survives to the posted
 *    version") can be computed and recorded here with zero labelling
 *    effort — both texts (the original composition and what was actually
 *    posted) are already in hand at this exact point.
 *  - Discard: writes nothing to Ship. Any draft-backed item (`standup_draft`,
 *    and `blocker_escalation` as of TRO-346/TRO-337 / FG-19) additionally
 *    marks its draft `dismissed`; every item type is removed from the
 *    person's own inbox via `itemStore.dismiss` (not `clear` — see that
 *    method's own docstring for why the distinction is proof #4).
 *  - Accept ONE proposed transition (by index): the one Ship write
 *    (`PATCH /api/issues/:id`), attributed to the accepting person, and no
 *    other transition on the same draft is touched.
 *  - Reject ONE proposed transition: no write, just recorded so it is not
 *    re-offered.
 */
import type { DraftStore, ProposedTransition } from './draftStore.js';
import type { InboxItem, ItemStore } from './itemStore.js';
import type { GateShipClientLike } from './shipClient.js';
import { computeDraftSurvival, type DraftSurvivalTracker } from './draftSurvival.js';

export interface GateDeps {
  shipClient: GateShipClientLike;
  itemStore: ItemStore;
  draftStore: DraftStore;
  /** TRO-338 / FG-20's production signal — "how much of a draft survives
   * to the posted version." Optional, same injection pattern as
   * `graph.ts`'s `costTracker`: omitted, `acceptDraft` behaves exactly as
   * it did before this ticket; passed, every real accept records one
   * survival measurement. Nothing currently constructs the production
   * `FileDraftSurvivalTracker` in `index.ts` for the same reason nothing
   * calls `acceptDraft` from a real route yet (FG-8 has no HTTP surface
   * wired up today) — the seam is real and tested; wiring it to a live
   * caller is that future ticket's job, not this one's. */
  draftSurvivalTracker?: DraftSurvivalTracker;
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

export interface AcceptDraftResult {
  standupId: string;
}

/**
 * Accepts a standup draft: performs the real Ship write, attributed to
 * `accepterToken`'s own owner — never the agent — then marks the draft
 * `posted` and removes its inbox item.
 *
 * `finalText` is what an accepting person actually posts. It is almost
 * always the draft's own `draftText`, but not necessarily: `draftStore.ts`'s
 * own docstring is explicit that "whatever a person edits to before posting
 * is a DIFFERENT string that FG-8's accept-flow owns capturing" — this
 * parameter is that capture point. `draftText` itself is never mutated (it
 * stays the model's original composition, per that same docstring); only
 * `finalText` — defaulting to `draftText` when the person changed nothing —
 * is what gets posted to Ship.
 *
 * Never touches `proposedTransitions` — those are accepted/rejected
 * individually via `acceptProposedTransition`/`rejectProposedTransition`
 * (proof #5), deliberately independent of whether the draft text itself has
 * been posted yet.
 */
export async function acceptDraft(
  deps: GateDeps,
  draftId: string,
  accepterToken: string,
  finalText?: string
): Promise<AcceptDraftResult> {
  const draft = deps.draftStore.get(draftId);
  if (!draft) throw new GateError(`no such draft: ${draftId}`);
  if (draft.status === 'posted') throw new GateError(`draft ${draftId} was already posted`);

  const textToPost = finalText ?? draft.draftText;
  const created = await deps.shipClient.postStandup(accepterToken, draft.windowDate);
  await deps.shipClient.setStandupContent(accepterToken, created.id, textToPost);

  // finalText is REQUIRED as of TRO-338 / FG-20: this is the one moment
  // this package ever learns what a person actually posted, and it must be
  // retained now or it is gone — `draftStore.ts`'s own docstring on
  // `finalText` explains why the comparison this ticket adds needs both
  // versions captured here, not reconstructed later.
  const marked = deps.draftStore.markPosted(draftId, textToPost);
  if (!marked) {
    // The Ship write above already succeeded — this would be an internal
    // inconsistency (the draft existed a few lines up), not a user-facing
    // failure to retry. Fails loudly rather than silently leaving the draft
    // stuck 'unseen'/'viewed' after a real post already happened.
    throw new GateError(`Ship write for draft ${draftId} succeeded, but markPosted failed unexpectedly`);
  }

  // TRO-338 / FG-20's production signal, recorded on every accepted draft:
  // "how much of a draft survives to the posted version." Computed from
  // exactly the two strings already in hand — draft.draftText (the
  // immutable original) and textToPost (what was actually posted) — zero
  // labelling effort, per the ticket. Non-fatal by construction, same
  // posture as graph.ts's recordInvocation: a tracker failure must never
  // undo or fail a Ship write that already succeeded.
  if (deps.draftSurvivalTracker) {
    try {
      await deps.draftSurvivalTracker.record(
        computeDraftSurvival(draftId, draft.personUserId, draft.draftText, textToPost)
      );
    } catch (err) {
      console.warn(`[agent] draft survival tracker failed to record draft ${draftId} (non-fatal):`, err);
    }
  }

  // The item pointing at this draft (same id, per graph.ts's
  // commitStandupDraft) has nothing left to review — remove it from the
  // active inbox. dismiss(), not clear(): a re-poll of an overlapping window
  // should not be able to resurrect a POSTED draft's inbox item either.
  deps.itemStore.dismiss(draftId);

  return { standupId: created.id };
}

/**
 * Discards one inbox item — writes NOTHING to Ship (proof #3). Dispatches on
 * whether the item points at a draft, not on its `type` literal:
 *  - Draft-backed items (`item.draftId` set — `standup_draft` FG-6, and
 *    `blocker_escalation` TRO-346/TRO-337 / FG-19, the second producer of
 *    this shape) also mark the underlying draft `dismissed`
 *    (`draftStore.markDismissed`) — the ticket's own words ("Discard a
 *    draft: calls draftStore.markDismissed(id)"). Checking `draftId`'s
 *    presence rather than enumerating item types by name means a future
 *    third draft-backed item type needs no edit here to get the same
 *    correct behavior.
 *  - `mention` / `blocking_approval` (no `draftId`): no draft to touch; "the
 *    equivalent for a non-draft inbox item ... they just get dismissed from
 *    the inbox" (the ticket's own words) — `itemStore.dismiss` alone.
 *
 * Either way, `itemStore.dismiss(itemId)` runs last, so the item is removed
 * from the inbox AND the dismissal is remembered at its current content
 * version (proof #4 — see `itemStore.ts`'s `dismiss`/`versionKeyFor`).
 */
export function discardItem(deps: GateDeps, itemId: string): void {
  const item: InboxItem | undefined = deps.itemStore.get(itemId);
  if (!item) throw new GateError(`no such inbox item: ${itemId}`);

  if (item.draftId) {
    const draftDismissed = deps.draftStore.markDismissed(item.draftId);
    if (!draftDismissed) {
      throw new GateError(`no such draft: ${item.draftId} (referenced by item ${itemId})`);
    }
  }

  const dismissed = deps.itemStore.dismiss(itemId);
  if (!dismissed) {
    // Unreachable in practice (deps.itemStore.get(itemId) above already
    // confirmed it exists), kept as an explicit guard rather than a silent
    // assumption — same posture as graph.ts's own "unreachable" guards.
    throw new GateError(`failed to dismiss inbox item: ${itemId}`);
  }
}

function requirePendingTransition(
  draft: { proposedTransitions: ProposedTransition[] } | undefined,
  draftId: string,
  index: number
): ProposedTransition {
  if (!draft) throw new GateError(`no such draft: ${draftId}`);
  const transition = draft.proposedTransitions[index];
  if (!transition) throw new GateError(`no proposed transition at index ${index} on draft ${draftId}`);
  const status = transition.status ?? 'pending';
  if (status !== 'pending') {
    throw new GateError(`proposed transition ${index} on draft ${draftId} was already ${status}`);
  }
  return transition;
}

/**
 * Accepts ONE proposed transition on a draft, by its index within
 * `proposedTransitions` — performs that one issue-state-change write,
 * attributed to the accepting person via `accepterToken`, and touches no
 * other transition on the same draft (proof #5).
 *
 * Only `field: 'state'` is supported today — the only field
 * `standupDraft.ts`'s `buildProposedTransitions` ever produces (it reads
 * `document_history` rows filtered to `field === 'state'`; see
 * `standupDraft.ts`'s `gatherPersonActivity`). Any other field fails loudly
 * rather than silently guessing which Ship endpoint/body shape would apply
 * it — the same "fails loudly rather than silently" posture `graph.ts`
 * already uses for its own required-dependency checks.
 */
export async function acceptProposedTransition(
  deps: GateDeps,
  draftId: string,
  index: number,
  accepterToken: string
): Promise<void> {
  const draft = deps.draftStore.get(draftId);
  const transition = requirePendingTransition(draft, draftId, index);

  if (transition.field !== 'state') {
    throw new GateError(
      `gate only knows how to apply "state" transitions, got field "${transition.field}" ` +
        `(transition ${index} on draft ${draftId})`
    );
  }
  if (transition.toState === null) {
    throw new GateError(`proposed transition ${index} on draft ${draftId} has no target state to apply`);
  }

  await deps.shipClient.applyIssueTransition(accepterToken, transition.issueId, transition.toState);

  const recorded = deps.draftStore.setProposedTransitionStatus(draftId, index, 'accepted');
  if (!recorded) {
    // The Ship write above already succeeded — same "don't silently drop a
    // completed write" posture as acceptDraft's own markPosted guard.
    throw new GateError(
      `Ship write for transition ${index} on draft ${draftId} succeeded, but recording acceptance failed unexpectedly`
    );
  }
}

/**
 * Rejects ONE proposed transition — no Ship write, ever (this function does
 * not even take a token). Only marks it `rejected` so it is not re-offered
 * (and, per `setProposedTransitionStatus`'s own contract, can never later be
 * accepted either — a rejected transition is terminal, not a toggle).
 */
export function rejectProposedTransition(deps: Pick<GateDeps, 'draftStore'>, draftId: string, index: number): void {
  const draft = deps.draftStore.get(draftId);
  requirePendingTransition(draft, draftId, index);

  const recorded = deps.draftStore.setProposedTransitionStatus(draftId, index, 'rejected');
  if (!recorded) {
    throw new GateError(`failed to record rejection for transition ${index} on draft ${draftId}`);
  }
}
