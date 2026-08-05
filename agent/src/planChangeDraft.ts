/**
 * The plan-change discrimination walk (TRO-336 / FG-18, "use case 4" in
 * FLEETGRAPH.MD's Use Cases table) — no model call in the GATHER half of
 * this file (`gatherPlanChange`/`alignCriteria`), matching `retroDraft.ts`
 * (FG-17), `blockerFanout.ts` (FG-19), and `standupDraft.ts` (FG-6)'s own
 * structure: `graph.ts`'s nodes stay thin wrappers around these functions.
 * The COMPOSE half (`buildPlanChangePrompt` + `parseMaterialityVerdict`)
 * is a deliberate, documented departure from every prior deep-tier chain —
 * see "Why the model decides materiality here, unlike everywhere else in
 * this package" below.
 *
 * Scope (the ticket's own Scope section, verbatim): "On a post-approval
 * edit of a weekly plan: what materially changed, before and after, side by
 * side — plus a drafted re-approval request or a drafted question back to
 * the author, routed to the approver. 'Materially' is the whole ticket. A
 * whitespace or typo change must produce nothing. A removed or weakened
 * success criterion must produce something."
 *
 * **The detection is not the missing piece — the discrimination is** (the
 * ticket's own words). Ship's own PATCH `/api/weeks/:id` handler
 * (`api/src/routes/weeks.ts:1910-1921`) already transitions
 * `properties.plan_approval.state` from `'approved'` to
 * `'changed_since_approved'` the moment `success_criteria` (or `plan`)
 * changes on an approved week — this file does not re-detect that; it reads
 * it directly off the week document (`gatherPlanChange` below) as the
 * trigger CONDITION, and its only job is deciding whether the underlying
 * edit is worth a human's attention.
 *
 * "Before and after" — VERIFIED against this worktree's own real seeded
 * database, not assumed from the ticket's own citation. The ticket's
 * "Verified" section says `document_history` "records body text only for
 * weekly plans and retros — one of the few places the history table is
 * sufficient on its own," and cites `api/src/routes/documents.ts:1074` as
 * one of the two places a post-approval edit is detected. Both citations
 * turned out not to be the reachable path for THIS use case, the same class
 * of gap TRO-335 found in its own ticket's citations:
 *  - `documents.ts:1074`'s transition fires when the CURRENT state is
 *    `'changes_requested'` (a manager asked for changes, the author
 *    resubmitted) — a real, different transition, not "approved, then
 *    edited." The transition THIS ticket needs lives in `weeks.ts`, not
 *    `documents.ts`, and operates on the SPRINT document's own
 *    `success_criteria`/`plan` properties, not a `weekly_plan` document's
 *    TipTap body.
 *  - `document_history` is real and does capture this correctly in
 *    production (`weeks.ts:1940-1952`'s own `logDocumentChange(id,
 *    'success_criteria', oldCriteria, newCriteria, userId)`, `oldCriteria`/
 *    `newCriteria` being JSON-stringified arrays) — but the reachable FG-3
 *    seed fixture (Test Case 4, `api/src/db/seed.ts:1407-1454`) never goes
 *    through that PATCH route at all; it writes `properties` directly via
 *    raw SQL (`UPDATE documents SET properties = properties || $1::jsonb`),
 *    which bypasses `logDocumentChange` entirely. A direct query against
 *    this worktree's own freshly-seeded database confirmed
 *    `document_history` has ZERO rows for the fixture's week — the ONLY
 *    place the "before" value actually lives is `properties.plan_history`'s
 *    last entry, whose `.plan` field the fixture repurposes to hold
 *    `JSON.stringify(originalCriteria)` (a JSON-encoded array), even though
 *    that field is normally free plan TEXT in real usage
 *    (`weeks.ts:1877-1894`: `plan_history` is appended to only when the
 *    free-text `plan` field changes, storing the OLD PLAIN TEXT verbatim).
 *
 * `gatherPlanChange` therefore reads BOTH sources, in preference order: a
 * real `document_history` `field: 'success_criteria'` row (via
 * `getChangeFeed`, correct for a genuine production edit) FIRST, falling
 * back to `properties.plan_history`'s last entry ONLY if its `.plan` field
 * parses as a JSON array of strings (covers the reachable seed fixture,
 * without guessing at a genuine free-text plan snapshot that happens not to
 * parse as JSON — see `parseCriteriaSnapshot` below). If neither source
 * yields a usable "before" snapshot, nothing is guessed at
 * (`diffSourceFound: false`) — same "never guess" posture as
 * `retroDraft.ts`'s `weekDatesUnavailable`.
 *
 * **Why the model decides materiality here, unlike everywhere else in this
 * package.** Every other deep-tier chain (FG-6/FG-17/FG-19) decides its own
 * skip/proceed gate deterministically and only ever asks the model to
 * PHRASE an already-decided set of facts. The first draft of this file
 * tried the same shape — a fixed Levenshtein-similarity threshold to
 * classify a criterion pair as "cosmetic" vs "materially different." It was
 * WRONG, verified empirically (not just reasoned about) by scoring real
 * example pairs before writing any test against them:
 *   similarity("CSRF protection verified on every mutating route",
 *              "CSRF protection verified on some mutating routes") = 0.875
 *   similarity("Session timeout matches the 15-minute policy",
 *              "Session timeout matches the 30-minute policy")     = 0.955
 *   similarity("Ship it", "Shipit")                                 = 0.857
 * The first two are genuine WEAKENINGS (a requirement loosened) scoring
 * HIGHER than "Ship it"/"Shipit", a trivial typo in a short string scoring
 * LOWER. No fixed threshold separates these correctly — a short typo and a
 * long sentence's one-word semantic flip land in overlapping similarity
 * ranges, because edit distance measures characters, not meaning. That is
 * exactly the naive-diff trap the ticket names ("materially is the whole
 * ticket... do not build a naive diff") — a similarity score is a
 * statistical diff with different math, not a different KIND of answer.
 *
 * The design that survives this: `alignCriteria` still does real,
 * deterministic work — EXACT match after whitespace normalization
 * (`normalizeCriterionText`) is the ONLY criterion classified "unchanged,"
 * with zero ambiguity. That is the full, provable guarantee behind "a
 * whitespace... change must produce nothing": `gatherPlanChange`/
 * `detectPlanChange` (`graph.ts`) skip BEFORE any model call when every
 * criterion aligns this way — verified in this file's own tests by
 * asserting the model is never invoked. Anything that survives past exact
 * match (a removed criterion, an added one, or a pair that plausibly
 * corresponds but reads differently) is handed to the model, which alone
 * can tell a typo from a weakening — `buildPlanChangePrompt` requires a
 * `MATERIAL`/`NOT MATERIAL` verdict as the FIRST line of its response, and
 * `parseMaterialityVerdict` reads that verdict to decide whether
 * `commitPlanChangeDraft` (`graph.ts`) writes anything at all. This makes
 * the negative case's proof TWO-TIERED, honestly: the whitespace-only case
 * is proven with zero model dependency (a real regression test asserts
 * `model.invoke` was never called); a genuine character-level typo's
 * "produces nothing" behavior is proven via a recorded, fixed model
 * response returning `NOT MATERIAL` — the same "recorded model response so
 * CI is deterministic" pattern this repo already uses for a judgment call
 * (TRO-335's Test Case 3), applied here because materiality-of-a-rewording
 * genuinely is one.
 *
 * `approverUserId` (`plan_approval.approved_by`) — VERIFIED to be a real
 * `users.id`, by reading the approval-setting route directly
 * (`weeks.ts:3269`: `approved_by: userId`, `userId` resolved from
 * `authMiddleware`/the session, the same space `owner_id` and every other
 * `*UserId` field in this package's deep-tier chains already use).
 */
import type { ApprovalTrackingLike, ChangeFeedHistoryEntry, DeepShipClientLike, ShipDocument } from './shipClient.js';

/** Below this, two criteria are not paired at all — too different to
 * plausibly be "the same criterion, reworded." This only affects how a
 * change is PRESENTED (as a "modified" pair vs. an unrelated
 * removed+added pair) — see this file's module docstring for why it does
 * NOT decide materiality; a pairing miss at the margin still correctly
 * reaches `hasAnyChange: true` either way, just described slightly
 * differently in the prompt. */
const MATCH_SIMILARITY_THRESHOLD = 0.4;

const DEFAULT_CHANGE_FEED_LIMIT = 500;

function normalizeCriterionText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Standard Levenshtein edit distance, iterative two-row DP (no recursion,
 * no external dependency — `agent/package.json` has none for string
 * similarity and criteria text is short enough that O(m*n) is negligible). */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const substCost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Non-null: every index 0..n was just populated on the previous row
      // (`prev`) or by this same loop earlier in the current row (`curr`,
      // `curr[j - 1]` always set since j starts at 1) — `noUncheckedIndexedAccess`
      // still types these as possibly undefined, so destructure explicitly
      // rather than asserting (lessons.md #16/#21).
      const del = prev[j] ?? 0;
      const ins = curr[j - 1] ?? 0;
      const sub = prev[j - 1] ?? 0;
      curr[j] = Math.min(del + 1, ins + 1, sub + substCost);
    }
    [prev, curr] = [curr, prev];
  }
  // After the final swap, the finished row is in `prev`.
  return prev[n] ?? 0;
}

/** `1` for identical strings, `0` for a maximally different pair (edit
 * distance equal to the longer string's own length), linear in between.
 * Both inputs are normalized (`normalizeCriterionText`) by the caller
 * before this is ever invoked. Used ONLY for pairing plausibility
 * (`MATCH_SIMILARITY_THRESHOLD`) — see this file's module docstring for why
 * it is never used to decide materiality. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1; // both empty — degenerate but not a divide-by-zero
  return 1 - levenshteinDistance(a, b) / maxLen;
}

export interface CriterionChange {
  oldText: string;
  newText: string;
}

export interface CriteriaAlignment {
  removed: string[];
  added: string[];
  modified: CriterionChange[];
  /** `true` iff at least one of removed/added/modified is non-empty — NOT
   * the same as "material." It means "not proven identical after
   * whitespace normalization," the ONLY thing this file decides on its
   * own. `graph.ts`'s `detectPlanChange` skips (no model call) when this is
   * `false`; when `true`, the model still decides materiality itself — see
   * this file's module docstring. */
  hasAnyChange: boolean;
}

/**
 * Aligns `oldCriteria` against `newCriteria` by GREEDY best-similarity
 * pairing (highest-similarity pair claimed first, each item usable at most
 * once). A pair is "unchanged" iff EXACTLY equal after whitespace
 * normalization — the one classification this function makes with zero
 * ambiguity. Everything else (paired-but-not-exact = "modified"; unpaired
 * old = "removed"; unpaired new = "added") is a FACT for the model to judge,
 * never a verdict this function renders — see this file's module docstring
 * for why. Deterministic for a given input: ties in similarity are broken
 * by pair discovery order (old-index-major, new-index-minor), which only
 * matters when two criteria are equally similar to the same candidate, an
 * edge case no fixture in this ticket's proof exercises.
 */
export function alignCriteria(oldCriteria: readonly string[], newCriteria: readonly string[]): CriteriaAlignment {
  const oldNorm = oldCriteria.map(normalizeCriterionText);
  const newNorm = newCriteria.map(normalizeCriterionText);

  const oldUsed = new Array<boolean>(oldNorm.length).fill(false);
  const newUsed = new Array<boolean>(newNorm.length).fill(false);

  const candidates: { i: number; j: number; sim: number }[] = [];
  for (let i = 0; i < oldNorm.length; i++) {
    for (let j = 0; j < newNorm.length; j++) {
      candidates.push({ i, j, sim: similarity(oldNorm[i] ?? '', newNorm[j] ?? '') });
    }
  }
  candidates.sort((a, b) => b.sim - a.sim);

  const modified: CriterionChange[] = [];

  for (const { i, j, sim } of candidates) {
    if (oldUsed[i] || newUsed[j] || sim < MATCH_SIMILARITY_THRESHOLD) continue;
    oldUsed[i] = true;
    newUsed[j] = true;
    if (oldNorm[i] !== newNorm[j]) {
      modified.push({ oldText: oldCriteria[i] ?? '', newText: newCriteria[j] ?? '' });
    }
    // oldNorm[i] === newNorm[j]: EXACTLY the same after whitespace
    // normalization — "unchanged," no fact recorded, no ambiguity.
  }

  const removed = oldCriteria.filter((_, i) => !oldUsed[i]);
  const added = newCriteria.filter((_, j) => !newUsed[j]);

  return {
    removed,
    added,
    modified,
    hasAnyChange: removed.length > 0 || added.length > 0 || modified.length > 0,
  };
}

/** Never throws — a document that is gone or invisible to this token is not
 * evidence of anything the walk can act on, same posture as
 * `blockerFanout.ts`'s/`retroDraft.ts`'s own `tryGetDocument`. */
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

/** Reads a `plan_history` entry's `.plan` field as a criteria snapshot —
 * ONLY if it parses as a JSON array of strings. A genuine free-text
 * `plan_history` entry (real usage: the OLD free-text plan statement,
 * `weeks.ts:1877-1894`) will not parse as an array and is correctly
 * declined here, not guessed at — see this file's module docstring. */
function parseCriteriaSnapshot(planField: unknown): string[] | undefined {
  if (typeof planField !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(planField);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) return undefined;
  return parsed as string[];
}

export interface PlanChangeSummary {
  weekId: string;
  weekTitle: string;
  weekNumber: number;
  /** Read directly off `properties.plan_approval.state` — Ship's own
   * already-implemented detection signal (see this file's module
   * docstring). `graph.ts`'s `detectPlanChange` node gates on this being
   * exactly `'changed_since_approved'`. */
  approvalState: ApprovalTrackingLike['state'];
  /** `null` when the week has no recorded approver — `commitPlanChangeDraft`
   * (`graph.ts`) has nobody to route the draft to in that case and skips. */
  approverUserId: string | null;
  /** `false` when neither `document_history` nor `properties.plan_history`
   * yielded a usable "before" snapshot — nothing below is guessed at in
   * that case (`removed`/`added`/`modified` are all `[]`, matching
   * `retroDraft.ts`'s `weekDatesUnavailable` posture exactly). */
  diffSourceFound: boolean;
  currentCriteria: string[];
  alignment: CriteriaAlignment;
}

/** Empty alignment (nothing found/nothing to compare) — the shared shape
 * every early-return in `gatherPlanChange` needs, so its body stays one
 * construction pattern rather than several ad hoc partial objects. */
function emptyAlignment(): CriteriaAlignment {
  return { removed: [], added: [], modified: [], hasAnyChange: false };
}

/**
 * Builds the full plan-change summary from `weekId` — its approval state,
 * its approver, and (when the state warrants it) the aligned diff of its
 * `success_criteria`. `undefined` when the week itself is gone, invisible
 * to this token, or is not actually a `sprint` document — nothing to
 * evaluate, not an error (same posture as `retroDraft.ts`'s
 * `gatherWeekDelivery`).
 *
 * Only attempts the `document_history`/`plan_history` lookup when
 * `plan_approval.state === 'changed_since_approved'` — the detection gate
 * this ticket explicitly says is already correct — so a week that was
 * never flagged never pays for a `getChangeFeed` call it has no use for
 * (same "don't do wasted work" posture as `retroDraft.ts` skipping
 * `getReverseAssociations` when its own window is uncomputable).
 */
export async function gatherPlanChange(
  client: Pick<DeepShipClientLike, 'getDocument' | 'getChangeFeed'>,
  weekId: string,
  options: { changeFeedLimit?: number } = {}
): Promise<PlanChangeSummary | undefined> {
  const week = await tryGetDocument(client, weekId);
  if (!week || week.document_type !== 'sprint') return undefined;

  const weekNumber = typeof week.properties.sprint_number === 'number' ? week.properties.sprint_number : 0;
  const approval = (week.properties.plan_approval ?? null) as ApprovalTrackingLike | null;
  const approvalState = approval?.state ?? null;
  const approverUserId = typeof approval?.approved_by === 'string' ? approval.approved_by : null;
  const currentCriteria = stringArray(week.properties.success_criteria);

  if (approvalState !== 'changed_since_approved') {
    return {
      weekId: week.id,
      weekTitle: week.title,
      weekNumber,
      approvalState,
      approverUserId,
      diffSourceFound: false,
      currentCriteria,
      alignment: emptyAlignment(),
    };
  }

  // Preferred source: a real `document_history` row (the production
  // mechanism, `weeks.ts:1940-1952`). Take the OLDEST `success_criteria`
  // row since approval as "before" — covers more than one edit since
  // approval, not just the latest.
  let beforeCriteria: string[] | undefined;
  if (typeof approval?.approved_at === 'string') {
    try {
      const feed = await client.getChangeFeed(approval.approved_at, options.changeFeedLimit ?? DEFAULT_CHANGE_FEED_LIMIT);
      const rows = feed.history
        .filter((h: ChangeFeedHistoryEntry) => h.document_id === weekId && h.field === 'success_criteria')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const oldest = rows[0];
      if (oldest) {
        beforeCriteria = parseCriteriaSnapshot(oldest.old_value);
      }
    } catch {
      beforeCriteria = undefined;
    }
  }

  // Fallback: `properties.plan_history`'s last entry, ONLY if it parses as
  // a criteria snapshot — see `parseCriteriaSnapshot`'s own docstring and
  // this file's module docstring for why this is the reachable seed
  // fixture's actual shape, not a guess.
  if (!beforeCriteria) {
    const planHistory = Array.isArray(week.properties.plan_history) ? week.properties.plan_history : [];
    const last = planHistory[planHistory.length - 1] as { plan?: unknown } | undefined;
    beforeCriteria = last ? parseCriteriaSnapshot(last.plan) : undefined;
  }

  if (!beforeCriteria) {
    return {
      weekId: week.id,
      weekTitle: week.title,
      weekNumber,
      approvalState,
      approverUserId,
      diffSourceFound: false,
      currentCriteria,
      alignment: emptyAlignment(),
    };
  }

  return {
    weekId: week.id,
    weekTitle: week.title,
    weekNumber,
    approvalState,
    approverUserId,
    diffSourceFound: true,
    currentCriteria,
    alignment: alignCriteria(beforeCriteria, currentCriteria),
  };
}

/**
 * Builds the text handed to `model.invoke` — every fact `gatherPlanChange`
 * found, plus explicit instructions the model must follow. Deterministic:
 * the same `PlanChangeSummary` always produces the same prompt, matching
 * `buildRetroPrompt`/`buildBlockerEscalationPrompt`'s own posture. Only
 * ever called once `alignment.hasAnyChange` is already `true`
 * (`graph.ts`'s `composePlanChangeDraft` skips otherwise). UNLIKE every
 * other `build*Prompt` in this package, this one asks the model to render
 * an explicit MATERIAL/NOT MATERIAL verdict as its first line — see this
 * file's module docstring for why materiality itself, not just phrasing,
 * has to be the model's call here.
 */
export function buildPlanChangePrompt(summary: PlanChangeSummary): string {
  const lines: string[] = [];
  const { alignment } = summary;

  lines.push(
    `Week ${summary.weekNumber}'s plan was approved, then edited afterward — Ship's own approval ` +
      'tracking already flagged this ("changed_since_approved"). Decide whether the change below is ' +
      'MATERIAL (something a manager should ask about — a removed, added, or meaningfully reworded ' +
      'success criterion) or NOT MATERIAL (only a whitespace or typo-level fix that does not change ' +
      'what any criterion means). If material, draft a short question back to the plan\'s author, for ' +
      'the approver to review and send.'
  );
  lines.push('');

  if (alignment.removed.length > 0) {
    lines.push(`Success criteria REMOVED since approval (${alignment.removed.length}):`);
    for (const c of alignment.removed) lines.push(`- "${c}"`);
    lines.push('');
  }
  if (alignment.added.length > 0) {
    lines.push(`Success criteria ADDED since approval (${alignment.added.length}):`);
    for (const c of alignment.added) lines.push(`- "${c}"`);
    lines.push('');
  }
  if (alignment.modified.length > 0) {
    lines.push(`Success criteria with DIFFERENT TEXT since approval (${alignment.modified.length}):`);
    for (const c of alignment.modified) lines.push(`- was: "${c.oldText}"\n  now: "${c.newText}"`);
    lines.push('');
  }

  lines.push('Respond in EXACTLY one of these two formats:');
  lines.push(
    '1. If material: the single word MATERIAL on its own first line, then a blank line, then the ' +
      "drafted question — written as a DRAFT the approver will edit and send themselves, never as " +
      'though it has already been sent, and never as though you (the agent) are the approver or the ' +
      'author.'
  );
  lines.push('2. If not material: the words NOT MATERIAL on their own first line, and nothing else.');
  lines.push('');
  lines.push('Rules:');
  lines.push(
    '- Use ONLY the removed/added/changed criteria listed above. Never invent a criterion, never ' +
      'reference one that was not listed, and never describe a criterion as unchanged if it is not ' +
      'listed here.'
  );
  lines.push(
    '- If material, ask the author to explain the change(s) plainly — do not accuse them or assume ' +
      'bad intent; a removed or changed criterion may have a good reason. Offer re-approval as an ' +
      'option if the approver decides the change needs no explanation.'
  );
  lines.push('- Never write a performance rating or any qualitative judgment of the author.');
  lines.push('- A whitespace-only or typo-level difference in wording that does not change what a criterion demands is NOT material.');

  return lines.join('\n');
}

export interface MaterialityVerdict {
  material: boolean;
  /** The drafted question, with the verdict line stripped. Empty when
   * `material` is `false`, or when the model marked it material but wrote
   * nothing after the verdict line (defensive — never expected in
   * practice). */
  draftText: string;
}

/**
 * Parses `buildPlanChangePrompt`'s required response format. Checks
 * `'NOT MATERIAL'` BEFORE `'MATERIAL'` since the former contains the
 * latter as a substring. A response that follows neither format degrades
 * to `material: true` with the WHOLE response as the draft text — the
 * same asymmetric-cost reasoning FLEETGRAPH.MD's own "Precision, and why
 * the bar moved" section states for this package generally: a false
 * positive here costs the approver a few seconds to dismiss; a false
 * negative silently drops a real signal, which is the exact failure this
 * ticket exists to fix. Never throws.
 */
/** Matches a first line of `NOT MATERIAL`, optionally followed by
 * punctuation/more text (`NOT MATERIAL:`, `NOT MATERIAL - ...`) — `\b`
 * after `MATERIAL` specifically so a word like "materialized" is never
 * mistaken for the verdict (`startsWith` alone would match it). */
const NOT_MATERIAL_RE = /^NOT\s+MATERIAL\b/;
/** Same word-boundary reasoning as `NOT_MATERIAL_RE`, checked second — see
 * `parseMaterialityVerdict`'s own docstring for why order matters. */
const MATERIAL_RE = /^MATERIAL\b/;

export function parseMaterialityVerdict(responseText: string): MaterialityVerdict {
  const trimmed = responseText.trimStart();
  const firstLineEnd = trimmed.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd)).trim();
  const rest = (firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1)).trim();
  const normalized = firstLine.toUpperCase();

  if (NOT_MATERIAL_RE.test(normalized)) {
    return { material: false, draftText: '' };
  }
  if (MATERIAL_RE.test(normalized)) {
    return { material: true, draftText: rest };
  }
  return { material: true, draftText: trimmed };
}
