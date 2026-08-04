/**
 * The deep tier's activity-gathering and prompt-assembly (TRO-319 / FG-6) —
 * deterministic, no model call anywhere in this file, matching `proactive.ts`
 * (FG-5) and `expansion.ts` (FG-7)'s own structure: `graph.ts`'s nodes stay
 * thin wrappers around these functions.
 *
 * Scope (the ticket's Scope section): "Composition runs once per person per
 * window ... Draft content, assembled from observed activity since the
 * person's last standup: issues that changed state, comments they wrote,
 * documents they edited, blockers hit. Where nothing moved, say so plainly
 * and name what has been sitting and for how long."
 *
 * What this file does NOT cover, and why:
 *  - "documents they edited" (body edits with no state change and no
 *    comment) has no reliable per-editor signal in Ship's API today — a
 *    document's `updated_at` moving is a complete signal that ITS BODY
 *    changed (FLEETGRAPH.MD's own polling rationale), but nothing exposed
 *    here attributes WHO made that specific edit; `created_by` is who
 *    originally created the row, not who last touched it, and Yjs
 *    collaborative saves carry no per-edit author field reachable through
 *    this agent's read surface. Folding an unattributed "something in your
 *    world changed" into a person's OWN standup would risk claiming
 *    activity that was not verifiably theirs — exactly the
 *    derived-vs-observed distinction this repo's provenance rules exist
 *    for. State-change history (`changed_by`) and comments (`author_id`)
 *    both DO carry real attribution, which is why those two are load-bearing
 *    here. A real per-editor signal is a Ship API gap, same class as FG-7's
 *    documented forward-`document_links` gap — not solved in this ticket.
 *  - "blockers hit" is read as CURRENT blocking status (a live `blocks`
 *    forward association on an assigned issue), not "became blocked since
 *    the anchor" — no endpoint exposes when an association was created, so
 *    there is no reliable "since" signal for it the way there is for state
 *    changes (`document_history`) or comments (`created_at`). A currently
 *    blocked issue is still real, useful signal even without that
 *    timestamp, so it is attached to whichever classification the issue
 *    already has (moved/commented/stale) rather than withheld.
 */
import type { ChangeFeedHistoryEntry, DeepShipClientLike } from './shipClient.js';
import type { ProposedTransition } from './draftStore.js';

// ============================================================================
// The "since their last standup" anchor
// ============================================================================

export interface StandupAnchor {
  /** ISO 8601 — the timestamp activity is gathered "since." The prior
   * standup's own `created_at` when one exists; otherwise `now - lookback`. */
  anchorISO: string;
  /** True when this person has never posted a standup Ship has a record of
   * — the anchor is a default lookback window, not a real prior document. */
  isFirstStandup: boolean;
  lastStandupId?: string;
}

/** How far back a first-ever draft looks when there is no prior standup to
 * anchor against. Chosen to match Ship's own sprint length (`standups.ts`'s
 * `sprintDuration = 7`) rather than the proactive tier's 24h catch-up
 * (`graph.ts`'s `DEFAULT_INITIAL_LOOKBACK_MS`) — a brand-new person's FIRST
 * draft is meant to cover "what has happened in my current sprint so far,"
 * not just the last day, or it would silently omit everything that happened
 * before this particular morning. DERIVED from the sprint-length convention
 * already used elsewhere in this codebase, not measured against real usage
 * (there is none yet to measure against). */
export const DEFAULT_FIRST_STANDUP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** `GET /api/documents?type=standup` has no author filter (see
 * `shipClient.ts`'s `listDocuments` docstring for why) — this is how many
 * rows of the workspace-wide list are scanned client-side to find one
 * person's most recent entry. Generous (matches `documents.ts`'s own
 * `MAX_DOCUMENTS_LIST_LIMIT` ceiling) rather than the list route's smaller
 * default, because a quiet person's most recent standup could otherwise
 * fall off a smaller page as OTHER people keep posting. Still a real,
 * documented scaling limit at large workspace size — same class of
 * limitation FG-5 already accepts on the change feed's own default limit —
 * not solved here. */
const DEFAULT_STANDUP_LIST_LIMIT = 500;

/**
 * Finds the anchor timestamp for one person's draft: their most recently
 * created `standup` document, or a default lookback window if they have
 * none. Reads `properties.author_id` (verified against `standups.ts`'s own
 * `POST /`/`GET /` handlers — the property key that route uses, not
 * guessed) and `created_at`, deliberately NOT `properties.date`: that field
 * is set by `standups.ts`'s own create route today, but is not guaranteed
 * present on every standup row (the FG-3 seed fixture's Test Case 1 standup
 * omits it — verified directly against this worktree's seeded database),
 * so anchoring on the row's real `created_at` timestamp is both more
 * precise (an exact instant, not a date) and does not depend on a property
 * that can be absent.
 */
export async function findStandupAnchor(
  client: Pick<DeepShipClientLike, 'listDocuments'>,
  personUserId: string,
  now: () => Date,
  initialLookbackMs = DEFAULT_FIRST_STANDUP_LOOKBACK_MS,
  listLimit = DEFAULT_STANDUP_LIST_LIMIT
): Promise<StandupAnchor> {
  const standups = await client.listDocuments('standup', listLimit);
  const authored = standups.filter((d) => d.properties.author_id === personUserId);

  if (authored.length === 0) {
    return {
      anchorISO: new Date(now().getTime() - initialLookbackMs).toISOString(),
      isFirstStandup: true,
    };
  }

  const latest = authored.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return { anchorISO: latest.created_at, isFirstStandup: false, lastStandupId: latest.id };
}

// ============================================================================
// Activity gathering
// ============================================================================

interface IssueActivityBase {
  issueId: string;
  title: string;
  /** A live `blocks` association found on this issue — see this file's
   * module docstring for why this is CURRENT status, not "since the
   * anchor." Present on whichever of moved/commented/stale this issue
   * classified as. */
  blockedBy?: { issueId: string; title: string };
}

export interface MovedIssueActivity extends IssueActivityBase {
  kind: 'moved';
  field: string;
  fromState: string | null;
  toState: string | null;
  changedAt: string;
  changedBy: string | null;
}

export interface CommentedIssueActivity extends IssueActivityBase {
  kind: 'commented';
  commentSnippet: string;
  commentedAt: string;
}

export interface StaleIssueActivity extends IssueActivityBase {
  kind: 'stale';
  daysSinceUpdate: number;
  lastUpdatedAt: string;
}

export type PersonActivityItem = MovedIssueActivity | CommentedIssueActivity | StaleIssueActivity;

export interface PersonActivitySummary {
  anchor: StandupAnchor;
  moved: MovedIssueActivity[];
  commented: CommentedIssueActivity[];
  stale: StaleIssueActivity[];
  /** True iff anything actually moved (state changed OR a comment was
   * written) — staleness is the ABSENCE of activity, so it never counts
   * toward this on its own. This is the flag `composeStandupDraft`
   * (`graph.ts`) and `buildStandupPrompt` (below) use for proof #2:
   * "the draft states nothing moved rather than inventing content." */
  hasAnyActivity: boolean;
}

const DEFAULT_CHANGE_FEED_LIMIT = 500;
const COMMENT_SNIPPET_MAX_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function truncate(text: string, maxLen = COMMENT_SNIPPET_MAX_CHARS): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** Never throws — a blocker lookup failing is not evidence of anything the
 * draft can act on, same posture as `proactive.ts`'s `tryGetDocument` and
 * `expansion.ts`'s `visitDocument`. Reads the blocking issue back through
 * `getDocument` rather than trusting `getAssociations`' own `related_id`
 * alone — `shipClient.ts`'s `AssociationForwardEdge` docstring: that route
 * checks access on the ANCHOR document only, not each related id, so the
 * title is never trusted until re-fetched through a call that DOES check
 * per-document access. */
async function findBlocker(
  client: Pick<DeepShipClientLike, 'getAssociations' | 'getDocument'>,
  issueId: string
): Promise<{ issueId: string; title: string } | undefined> {
  let edges;
  try {
    edges = await client.getAssociations(issueId, 'blocks');
  } catch {
    return undefined;
  }
  const first = edges[0];
  if (!first) return undefined;

  try {
    const blocker = await client.getDocument(first.related_id);
    return { issueId: blocker.id, title: blocker.title };
  } catch {
    return undefined;
  }
}

function latestByCreatedAt<T extends { created_at: string }>(rows: readonly T[]): T | undefined {
  return rows.reduce<T | undefined>((latest, row) => {
    if (!latest || row.created_at > latest.created_at) return row;
    return latest;
  }, undefined);
}

export interface GatherActivityOptions {
  now?: () => Date;
  changeFeedLimit?: number;
}

/**
 * Gathers one person's activity since `anchor`, classifying each of their
 * currently assigned issues into exactly one of moved / commented / stale
 * (in that priority order — an issue that both changed state AND received a
 * comment reports as "moved," the higher-signal fact; the comment is not
 * lost information so much as a secondary detail this ticket's proof cases
 * do not require surfacing separately). Blocker status is orthogonal and
 * attached to whichever classification applies.
 *
 * Fetches the assignee's issue list and the change feed in parallel — they
 * are independent — then resolves each issue's blocker sequentially
 * (bounded by the person's own issue count, not the workspace).
 */
export async function gatherPersonActivity(
  client: DeepShipClientLike,
  personUserId: string,
  anchor: StandupAnchor,
  options: GatherActivityOptions = {}
): Promise<PersonActivitySummary> {
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

  const [issues, feed] = await Promise.all([
    client.getIssuesByAssignee(personUserId),
    client.getChangeFeed(anchor.anchorISO, options.changeFeedLimit ?? DEFAULT_CHANGE_FEED_LIMIT),
  ]);

  const moved: MovedIssueActivity[] = [];
  const commented: CommentedIssueActivity[] = [];
  const stale: StaleIssueActivity[] = [];

  for (const issue of issues) {
    const stateChanges: ChangeFeedHistoryEntry[] = feed.history.filter(
      (h) => h.document_id === issue.id && h.field === 'state'
    );
    const latestStateChange = latestByCreatedAt(stateChanges);

    const issueComments = feed.comments.filter((c) => c.document_id === issue.id && c.author_id === personUserId);
    const latestComment = latestByCreatedAt(issueComments);

    const blockedBy = await findBlocker(client, issue.id);

    if (latestStateChange) {
      moved.push({
        kind: 'moved',
        issueId: issue.id,
        title: issue.title,
        field: latestStateChange.field,
        fromState: latestStateChange.old_value,
        toState: latestStateChange.new_value,
        changedAt: latestStateChange.created_at,
        changedBy: latestStateChange.changed_by,
        ...(blockedBy ? { blockedBy } : {}),
      });
    } else if (latestComment) {
      commented.push({
        kind: 'commented',
        issueId: issue.id,
        title: issue.title,
        commentSnippet: truncate(latestComment.content),
        commentedAt: latestComment.created_at,
        ...(blockedBy ? { blockedBy } : {}),
      });
    } else {
      const updatedAtMs = new Date(issue.updated_at).getTime();
      stale.push({
        kind: 'stale',
        issueId: issue.id,
        title: issue.title,
        daysSinceUpdate: Math.max(0, Math.floor((nowMs - updatedAtMs) / DAY_MS)),
        lastUpdatedAt: issue.updated_at,
        ...(blockedBy ? { blockedBy } : {}),
      });
    }
  }

  return {
    anchor,
    moved,
    commented,
    stale,
    hasAnyActivity: moved.length > 0 || commented.length > 0,
  };
}

// ============================================================================
// Proposed transitions
// ============================================================================

/**
 * Every observed state change becomes a `ProposedTransition` (`draftStore.ts`'s
 * type — both files agree on one shape, since `graph.ts`'s
 * `commitStandupDraft` writes this function's output straight into a
 * `StandupDraft`), evidenced by the `document_history` row that recorded it
 * — "attaches a proposed transition ... with its evidence" (TRO-319's proof
 * #1). This is true even though the transition already committed in Ship:
 * the agent's draft never asserts a state change as settled narrative on its
 * own say-so — every transition-shaped fact it surfaces goes through this
 * SAME evidenced, accept-required structure, whether the underlying fact is
 * a real commit (this ticket's only source today) or, in the future, an
 * inference from other evidence. Nothing here — or anywhere in this file —
 * calls a Ship write endpoint; `DeepShipClientLike` has none to call (see
 * that type's own docstring).
 */
export function buildProposedTransitions(moved: readonly MovedIssueActivity[]): ProposedTransition[] {
  return moved.map((m) => ({
    issueId: m.issueId,
    issueTitle: m.title,
    field: m.field,
    fromState: m.fromState,
    toState: m.toState,
    evidence: { kind: 'history', changedAt: m.changedAt, changedBy: m.changedBy },
  }));
}

// ============================================================================
// Prompt assembly
// ============================================================================

/**
 * Builds the text handed to `model.invoke` — every fact `gatherPersonActivity`
 * found, plus explicit instructions the model must follow. Deterministic:
 * the same `PersonActivitySummary` always produces the same prompt. The
 * "nothing moved" instruction (proof #2) is asserted directly in the prompt
 * text itself when `hasAnyActivity` is false, rather than left implicit —
 * matching `expansion.ts`'s `buildExpansionPrompt` posture for its own
 * zero-document case.
 */
export function buildStandupPrompt(summary: PersonActivitySummary): string {
  const lines: string[] = [];

  lines.push(
    "Draft this person's standup update using ONLY the observed activity listed below, since " +
      (summary.anchor.isFirstStandup
        ? "the start of their look-back window (they have no prior standup on record)."
        : `their last standup (${summary.anchor.anchorISO}).`)
  );
  lines.push('');
  lines.push('Rules:');
  lines.push('- Use only the facts listed below. Never invent activity that is not listed here.');
  lines.push(
    '- Write in first person ("I"), as a DRAFT this person will review and edit before posting ' +
      'themselves. You are not posting this, and it must never read as though it has already been ' +
      'posted or attributed to them.'
  );
  lines.push('- Never write a performance rating or any qualitative judgment of how well they are doing.');
  lines.push(
    "- Never state or imply that you changed an issue's state — only describe what was already " +
      'observed; any state change you list is a fact you noticed, not something you did.'
  );
  if (!summary.hasAnyActivity) {
    lines.push('- Nothing moved in this window. Say so plainly, in one sentence. Do not invent progress.');
  }
  lines.push('');

  if (summary.moved.length > 0) {
    lines.push('Moved:');
    for (const m of summary.moved) {
      const blocked = m.blockedBy ? ` (currently blocked by "${m.blockedBy.title}")` : '';
      lines.push(`- "${m.title}" — ${m.field} changed from ${m.fromState ?? '(none)'} to ${m.toState ?? '(none)'} on ${m.changedAt}${blocked}`);
    }
    lines.push('');
  }

  if (summary.commented.length > 0) {
    lines.push('Commented on:');
    for (const c of summary.commented) {
      const blocked = c.blockedBy ? ` (currently blocked by "${c.blockedBy.title}")` : '';
      lines.push(`- "${c.title}" — "${c.commentSnippet}" (${c.commentedAt})${blocked}`);
    }
    lines.push('');
  }

  if (summary.stale.length > 0) {
    lines.push('No activity observed — name these plainly and how long each has been sitting:');
    for (const s of summary.stale) {
      const blocked = s.blockedBy ? ` (currently blocked by "${s.blockedBy.title}")` : '';
      const dayWord = s.daysSinceUpdate === 1 ? 'day' : 'days';
      lines.push(`- "${s.title}" — no activity in ${s.daysSinceUpdate} ${dayWord}${blocked}`);
    }
    lines.push('');
  }

  if (summary.moved.length === 0 && summary.commented.length === 0 && summary.stale.length === 0) {
    lines.push('No issues are currently assigned to this person.');
  }

  return lines.join('\n');
}
