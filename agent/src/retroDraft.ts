/**
 * The retro-delivery drafting walk (TRO-335 / FG-17, "use case 3" in
 * FLEETGRAPH.MD's Use Cases table) — deterministic, no model call anywhere
 * in this file, matching `standupDraft.ts` (FG-6) and `blockerFanout.ts`
 * (FG-19)'s own structure: `graph.ts`'s nodes stay thin wrappers around
 * these functions.
 *
 * Scope (the ticket's own Scope section, verbatim): "When the retro window
 * opens for a week whose plan carries at least one success criterion:
 * pre-fill the delivered section from issues that actually closed in that
 * week, mapped against each criterion, and call out the criteria with no
 * matching closed work so they can be explained rather than silently
 * dropped."
 *
 * "The week" is a `sprint` document (`shared/src/types/document.ts`'s
 * `WeekProperties` — Ship's UI calls this a "week"; the `document_type`
 * column and every API route still say `sprint`, a pre-existing naming split
 * this file does not attempt to unify). Its `properties.success_criteria`
 * carries the structured plan this ticket reads — a DIFFERENT thing from the
 * per-person `weekly_plan`/`weekly_retro` DOCUMENT types
 * (`api/src/routes/weekly-plans.ts`), which are free-text journal entries
 * keyed by `(person_id, week_number)` with no `success_criteria` field of
 * their own. `gatherWeekDelivery` reads the week/sprint document directly.
 *
 * "Issues that actually closed in that week" is read as: associated to the
 * week via a forward `sprint` edge (`document_associations`,
 * `relationship_type = 'sprint'` — an issue points AT its week, so this file
 * reads the REVERSE direction, `getReverseAssociations(weekId, 'sprint')`),
 * currently in the `done` state, AND `completed_at` falling inside the
 * week's own calendar window (`computeWeekWindow` below).
 *
 * The first draft of this file used a SIMPLER definition — associated +
 * `done`, no date window — matching `GET /api/weeks/:id`'s own
 * `completed_count` correlated subquery (`api/src/routes/weeks.ts:1189-
 * 1191`) exactly. **That definition is wrong, verified against this
 * worktree's own real seeded database (`pnpm db:seed`), not merely
 * reasoned about.** The seed's FG-3 Test Case 3 fixture reuses an existing
 * "Ship Core" sprint document that the base load-testing template already
 * associates with several 'done' issues from WEEKS earlier — a real query
 * against a freshly-seeded worktree DB (`SELECT ... FROM document_associations
 * da JOIN documents d ... WHERE da.related_id = '<TC3 week id>' AND
 * da.relationship_type = 'sprint'`) returned 6 `done` issues for that week,
 * not the 3 the fixture actually closed within it — 3 pre-existing ones
 * with `completed_at` dated 2026-06-29 through 2026-07-10, a full month-plus
 * before the week's own computed window (`2026-08-03T00:00:00Z` to
 * `2026-08-10T00:00:00Z`, confirmed by direct computation against the real
 * `workspaces.sprint_start_date`). The associated+done definition is exactly
 * right for `completed_count`'s OWN purpose (a rough all-time completion
 * tally for a sprint) and exactly wrong for this ticket's: a retro that
 * silently attributed a month-old, already-retro'd closure to THIS week
 * would be a confidently wrong draft, worse than no draft. Fixed by adding
 * the date-window filter — `getWeekDates` (new, `shipClient.ts`) fetches
 * `workspace.sprint_start_date` (never exposed by `GET /api/documents/:id`),
 * and `computeWeekWindow` reproduces the EXACT half-open 7-day window
 * `api/src/db/seed.ts` itself uses to generate `completed_at` values for its
 * own fixtures (`currentWeekStart`/`currentWeekEnd`, `seed.ts:1276-1279`) —
 * not `weeks.ts`'s own `calculateSprintDates`, which computes an INCLUSIVE
 * `startDate + 6 days` for a different purpose ("has this sprint's start
 * date passed"). An issue whose `completed_at` cannot be verified to fall
 * inside the window (absent, or outside it) is excluded, not guessed at —
 * see `ClosedIssueDelivery.completedAt`'s own docstring.
 *
 * `week.properties.owner_id` — VERIFIED (not assumed) to be a real
 * `users.id`, not a person-document id, by reading the sprint creation
 * route directly: `api/src/routes/weeks.ts:1350-1364` validates it against
 * `SELECT u.id FROM users u JOIN workspace_memberships ... WHERE u.id = $1`
 * before ever writing it to `properties.owner_id`. This matters because a
 * DIFFERENT query in the same file (`getSprintOwnerReportsTo`,
 * `weeks.ts:328`) joins the same field against `documents` where
 * `document_type = 'person'` instead — an apparent pre-existing
 * inconsistency in Ship's own code, not something this ticket resolves.
 * Treating `owner_id` as a `users.id` here is the creation-time-verified
 * reading, and it is also the ONLY reading that lines up with
 * `DraftStore.personUserId`/`ItemStore.recipientUserId`'s own expectation
 * (both are `ShipPerson.user_id`-shaped elsewhere in this package).
 *
 * Trust boundary: `getReverseAssociations`' own docstring (`shipClient.ts`)
 * warns it checks access on the ANCHOR document only, never on each joined
 * `document_id` — a private document's id can leak through. Every candidate
 * here is re-fetched through `getDocument` (which DOES check per-document
 * access) before anything about it is trusted, exactly matching
 * `blockerFanout.ts`'s `gatherBlockerFanout` and `standupDraft.ts`'s
 * `findBlocker`.
 *
 * What this file deliberately does NOT do: decide whether "the retro window
 * has opened" for a given week. Same posture as `standupDraft.ts`/
 * `blockerFanout.ts` — "there is deliberately no scheduler in this file (or
 * anywhere in this package) that decides WHOSE window is open and WHEN";
 * `graph.ts`'s `gatherRetroActivity` node requires `weekId` as an explicit,
 * required trigger argument (mirroring `targetPersonUserId`/
 * `blockingIssueId`), and a real trigger route is a future ticket's job.
 */
import type { AssociationReverseEdge, DeepShipClientLike, ShipDocument } from './shipClient.js';

/** Sprint/week length, matching `api/src/db/seed.ts`'s own `sprintDuration`
 * constant and `weeks.ts`'s own `calculateSprintDates` — this codebase has
 * no configurable sprint length today; hardcoded there, hardcoded here. */
const SPRINT_DURATION_DAYS = 7;

/**
 * Computes a week's own half-open calendar window `[start, end)` — see this
 * file's module docstring for why this must match `seed.ts`'s
 * `currentWeekStart`/`currentWeekEnd` formula exactly, not `weeks.ts`'s
 * `calculateSprintDates` (a different, inclusive-end formula for a
 * different purpose). Parses only the first 10 characters of
 * `workspaceSprintStartDateISO` (the calendar date) and reconstructs at UTC
 * midnight — the same defensive parsing convention `weeks.ts`'s own
 * multiple call sites use for a `DATE` column value that has round-tripped
 * through JSON, so a stray time-of-day component never shifts the computed
 * day.
 */
function computeWeekWindow(sprintNumber: number, workspaceSprintStartDateISO: string): { startISO: string; endISO: string } {
  const datePart = workspaceSprintStartDateISO.slice(0, 10);
  const base = new Date(`${datePart}T00:00:00Z`);
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() + (sprintNumber - 1) * SPRINT_DURATION_DAYS);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + SPRINT_DURATION_DAYS);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export interface ClosedIssueDelivery {
  issueId: string;
  title: string;
  /** ISO 8601 — always present and always inside the week's own computed
   * window (see this file's module docstring for why an issue whose
   * `completed_at` is absent or outside the window is excluded entirely
   * rather than included with a `null`/unverified date). */
  completedAt: string;
}

export interface WeekDeliverySummary {
  weekId: string;
  weekTitle: string;
  /** `0` when `properties.sprint_number` is absent/non-numeric — defensive
   * fallback only, never expected against a real `sprint` document
   * (`WeekProperties.sprint_number` is required by that type), same
   * defensive posture as `weeks.ts`'s own `props.sprint_number || 1`. */
  weekNumber: number;
  /** `null` when the week has no recorded owner — `commitRetroDraft`
   * (`graph.ts`) has nobody to draft FOR in that case and skips, same
   * "check before spending" posture as every other skip reason in this
   * package. See this file's module docstring for why this is read as a
   * `users.id`. */
  ownerUserId: string | null;
  successCriteria: string[];
  closedIssues: ClosedIssueDelivery[];
  /** `true` when the week's own calendar window could not be computed (the
   * workspace's sprint-cadence lookup failed or returned nothing usable) —
   * `closedIssues` is `[]` in this case NOT because nothing closed, but
   * because "closed IN this week" could not be verified at all.
   * `gatherRetroActivity` (`graph.ts`) reads this to skip drafting
   * entirely rather than compose a delivered section from a set it cannot
   * vouch for — same "check before spending" posture as every other skip
   * reason in this package. */
  weekDatesUnavailable: boolean;
}

/** Never throws — a document that is gone or invisible to this token is not
 * evidence of anything the walk can act on, same posture as
 * `blockerFanout.ts`'s `tryGetDocument`. */
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Builds the full week-delivery summary from `weekId` — the week's success
 * criteria, its owner, and every issue that closed within it. `undefined`
 * when the week itself is gone, invisible to this token, or is not actually
 * a `sprint` document — nothing to draft from, not an error (same posture as
 * `blockerFanout.ts`'s `gatherBlockerFanout` returning `undefined` for a
 * gone blocking issue).
 *
 * Fetches the week document and its calendar window FIRST (the closed-issue
 * filter below depends on the window; nothing here depends on the issues),
 * then every associated issue CONCURRENTLY (`Promise.all`, matching
 * `gatherBlockerFanout`'s own concurrency shape and its own documented
 * reasoning: unbounded because a single week's issue count is expected to
 * stay small in practice — this ticket adds no page-size limit, same
 * trade-off `blockerFanout.ts` already made and documented).
 */
export async function gatherWeekDelivery(
  client: Pick<DeepShipClientLike, 'getDocument' | 'getReverseAssociations' | 'getWeekDates'>,
  weekId: string
): Promise<WeekDeliverySummary | undefined> {
  const week = await tryGetDocument(client, weekId);
  if (!week || week.document_type !== 'sprint') return undefined;

  const successCriteria = stringArray(week.properties.success_criteria);
  const ownerUserId = typeof week.properties.owner_id === 'string' ? week.properties.owner_id : null;
  const weekNumber = typeof week.properties.sprint_number === 'number' ? week.properties.sprint_number : 0;

  let workspaceSprintStartDate: string | undefined;
  try {
    const dates = await client.getWeekDates(weekId);
    workspaceSprintStartDate =
      typeof dates.workspace_sprint_start_date === 'string' ? dates.workspace_sprint_start_date : undefined;
  } catch {
    workspaceSprintStartDate = undefined;
  }

  if (!workspaceSprintStartDate) {
    // See `WeekDeliverySummary.weekDatesUnavailable`'s own docstring — no
    // closed-issue set can be trusted without a real calendar window, so
    // none is guessed at.
    return {
      weekId: week.id,
      weekTitle: week.title,
      weekNumber,
      ownerUserId,
      successCriteria,
      closedIssues: [],
      weekDatesUnavailable: true,
    };
  }

  const { startISO, endISO } = computeWeekWindow(weekNumber, workspaceSprintStartDate);

  let edges: AssociationReverseEdge[];
  try {
    edges = await client.getReverseAssociations(weekId, 'sprint');
  } catch {
    edges = [];
  }

  const resolved = await Promise.all(edges.map((edge) => tryGetDocument(client, edge.document_id)));

  const closedIssues: ClosedIssueDelivery[] = resolved
    .filter(
      (doc): doc is ShipDocument & { completed_at: string } =>
        doc !== undefined &&
        doc.document_type === 'issue' &&
        doc.properties.state === 'done' &&
        typeof doc.completed_at === 'string' &&
        doc.completed_at >= startISO &&
        doc.completed_at < endISO
    )
    .map((doc) => ({ issueId: doc.id, title: doc.title, completedAt: doc.completed_at }));

  return {
    weekId: week.id,
    weekTitle: week.title,
    weekNumber,
    ownerUserId,
    successCriteria,
    closedIssues,
    weekDatesUnavailable: false,
  };
}

/**
 * Builds the text handed to `model.invoke` — every fact `gatherWeekDelivery`
 * found, plus explicit instructions the model must follow. Deterministic:
 * the same `WeekDeliverySummary` always produces the same prompt, matching
 * `buildStandupPrompt`/`buildBlockerEscalationPrompt`'s own posture. The
 * "call out the criteria with no matching closed work" instruction (the
 * ticket's own proof condition) is asserted directly in the prompt text
 * itself, not left implicit — same as `buildStandupPrompt`'s "nothing moved"
 * case.
 */
export function buildRetroPrompt(summary: WeekDeliverySummary): string {
  const lines: string[] = [];

  lines.push(
    `Draft the "What I delivered this week" section of a weekly retro for Week ${summary.weekNumber}, ` +
      'using ONLY the facts listed below. This is a DRAFT the person will review, edit, and submit ' +
      'themselves — it must never read as though it has already been submitted.'
  );
  lines.push('');
  lines.push(`Success criteria for this week (${summary.successCriteria.length}):`);
  summary.successCriteria.forEach((criterion, i) => lines.push(`${i + 1}. ${criterion}`));
  lines.push('');

  if (summary.closedIssues.length > 0) {
    lines.push(`Issues closed this week (${summary.closedIssues.length}):`);
    for (const issue of summary.closedIssues) {
      const when = issue.completedAt ? ` (closed ${issue.completedAt})` : '';
      lines.push(`- "${issue.title}"${when}`);
    }
    lines.push('');
  } else {
    lines.push('No issues closed this week.');
    lines.push('');
  }

  lines.push('Rules:');
  lines.push(
    '- Map each closed issue to the success criterion or criteria it demonstrates progress on. Use ' +
      'only the issues and criteria listed above — never invent one.'
  );
  lines.push(
    '- For every success criterion with no closed issue mapped to it, explicitly call it out as not ' +
      'yet delivered so it can be explained, rather than silently dropping it.'
  );
  lines.push(
    '- Write in first person ("I"), as a draft the person will edit before submitting — never as ' +
      'though it has already been submitted.'
  );
  lines.push('- Never write a performance rating or any qualitative judgment of how the week went.');
  lines.push(
    '- This draft covers only observed closed work. It does not include unplanned work — the person ' +
      'will add that themselves.'
  );
  if (summary.closedIssues.length === 0) {
    lines.push(
      '- No issues closed this week: say so plainly, and note that every success criterion below is ' +
        'unmet so it can be explained.'
    );
  }

  return lines.join('\n');
}
