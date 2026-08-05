/**
 * The golden set (TRO-338 / FG-20) — real Ship activity states paired with
 * human-written reference drafts, and the comparison logic that scores an
 * actual model output against them.
 *
 * Answers a DIFFERENT question than the regression suite (TRO-322 / FG-12):
 * that suite uses recorded model responses to prove "did the code change
 * behaviour," deterministically, on every CI run. Recorded responses replay
 * regardless of what the real prompt says, so that suite structurally
 * cannot detect a prompt/context-assembly regression that makes real output
 * worse while every recording still matches. This file is what answers "did
 * the drafts get worse" instead — real activity, scored against a human
 * reference, run when the prompt or model changes, not on every commit
 * (`agent/src/scripts/golden-set-compare.ts` is the on-demand runner; this
 * file holds the fixtures and the pure scoring logic, which IS exercised in
 * CI, via `goldenSet.test.ts` — see that file for why: it proves the SCORER
 * itself can detect degradation, using a stable fake model, without ever
 * making this file part of the CI gate's own verdict).
 *
 * Fixture 1 is the SAME real seeded row ids `graph.test.ts`'s own "Test
 * Case 1" describes (`standupDraft.test.ts`'s header explains how these
 * were verified against this worktree's seeded database) — reused rather
 * than re-derived, so this file's "real activity state" claim is checked,
 * not asserted. Fixtures 2/3 are the same real shape (moved/commented/
 * stale, `PersonActivitySummary`) built from realistic, seed-convention
 * titles rather than a second live row lookup — marked as such below,
 * per this repo's provenance rules (observed vs. modeled-on-observed).
 */
import type { PersonActivitySummary } from './standupDraft.js';
import { computeTextSimilarity } from './textSimilarity.js';

export interface GoldenFixture {
  id: string;
  /** What makes this fixture worth having, and its provenance. */
  description: string;
  activity: PersonActivitySummary;
  /** Written by a human (this ticket) as what a good standup update reads
   * like for this exact activity — not generated, not edited from a model
   * draft. This is the "small set of ... human-written reference drafts"
   * the ticket's Scope section asks for. */
  referenceDraft: string;
}

const ANCHOR: PersonActivitySummary['anchor'] = {
  anchorISO: '2026-08-01T14:34:49.637Z',
  isFirstStandup: false,
  lastStandupId: 'bf55a6c9-83ba-498f-9778-ae7697ea1bdb',
};

/**
 * Fixture 1 — REAL seeded row ids, titles, and comment text. Identical to
 * `graph.test.ts`'s own "Test Case 1" fixture (`EMMA_USER_ID` etc.),
 * verified there against this worktree's seeded dev database's FG-3
 * fixture block. One person, one moved issue, one commented issue, one
 * stale issue — the exact shape FLEETGRAPH.MD's Test Cases table names.
 */
const engineerThreeIssues: GoldenFixture = {
  id: 'engineer-three-issues',
  description:
    'Real seeded activity (graph.test.ts\'s "Test Case 1" / Emma Johnson): one issue moved to ' +
    'In Review, one commented on, one stale for 7 days.',
  activity: {
    anchor: ANCHOR,
    moved: [
      {
        kind: 'moved',
        issueId: '9c862982-c6a0-4795-b710-05da50a94623',
        title: 'Build issue assignment flow',
        field: 'state',
        fromState: 'in_progress',
        toState: 'in_review',
        changedAt: '2026-08-03T14:34:49.638Z',
        changedBy: '6e6d2906-6e53-4a8c-a166-ca3661029363',
      },
    ],
    commented: [
      {
        kind: 'commented',
        issueId: '09f9b549-e60f-434b-b741-6ca78a507d65',
        title: 'Create sprint retrospective view',
        commentSnippet: 'Making progress on Create sprint retrospective view — should land by end of week.',
        commentedAt: '2026-08-03T14:34:49.639Z',
      },
    ],
    stale: [
      {
        kind: 'stale',
        issueId: '2bea5768-22fa-4c33-bdfa-fc500819f0ea',
        title: 'Implement burndown chart',
        daysSinceUpdate: 7,
        lastUpdatedAt: '2026-07-28T14:34:49.640Z',
      },
    ],
    hasAnyActivity: true,
  },
  referenceDraft:
    'Moved "Build issue assignment flow" to In Review — implementation is done and it is ready for ' +
    'someone to look at. Left a comment on "Create sprint retrospective view" letting the team know ' +
    'I am making progress and expect to land it by end of week. "Implement burndown chart" has not ' +
    'moved in 7 days — I have not been able to get to it yet.',
};

/**
 * Fixture 2 — zero-activity case (FLEETGRAPH.MD's proof #2 shape: "where
 * nothing moved, it says so and names what has been sitting"). Same real
 * SHAPE as the seed's own stale-issue rows; not a live row lookup — modeled
 * on the seed's title/timing conventions (`isolated-env.ts`'s own fixture
 * issue list uses the identical "Refactor notification system"-style
 * naming), not independently re-verified against a specific live row id.
 */
const zeroActivity: GoldenFixture = {
  id: 'zero-activity',
  description:
    'No state changes or comments since the anchor — one assigned issue, untouched for 3 days ' +
    '(modeled on the seed\'s own stale-issue shape, not a live row lookup).',
  activity: {
    anchor: ANCHOR,
    moved: [],
    commented: [],
    stale: [
      {
        kind: 'stale',
        issueId: 'fixture-refactor-auth-middleware',
        title: 'Refactor authentication middleware',
        daysSinceUpdate: 3,
        lastUpdatedAt: '2026-08-01T14:34:49.640Z',
      },
    ],
    hasAnyActivity: false,
  },
  referenceDraft:
    'Nothing moved since my last standup. "Refactor authentication middleware" has been sitting for ' +
    '3 days — I have not picked it back up yet.',
};

/**
 * Fixture 3 — a moved issue that is CURRENTLY blocked (`blockedBy` set).
 * Exercises `buildStandupPrompt`'s blocked-issue annotation, which neither
 * fixture 1 nor 2 does. Same provenance note as fixture 2: real shape,
 * modeled titles.
 */
const blockedIssue: GoldenFixture = {
  id: 'blocked-issue',
  description:
    'A moved issue that is currently blocked by another — exercises the blockedBy annotation ' +
    'buildStandupPrompt adds (modeled on the seed\'s own shape, not a live row lookup).',
  activity: {
    anchor: ANCHOR,
    moved: [
      {
        kind: 'moved',
        issueId: 'fixture-api-gateway-rate-limits',
        title: 'Add per-tenant API gateway rate limits',
        field: 'state',
        fromState: 'todo',
        toState: 'in_progress',
        changedAt: '2026-08-03T09:00:00.000Z',
        changedBy: 'fixture-user',
        blockedBy: { issueId: 'fixture-tenant-model-migration', title: 'Multi-tenant data model migration' },
      },
    ],
    commented: [],
    stale: [],
    hasAnyActivity: true,
  },
  referenceDraft:
    'Started "Add per-tenant API gateway rate limits" — moved it to In Progress. It is currently ' +
    'blocked by "Multi-tenant data model migration" though, so I cannot go much further until that ' +
    'lands.',
};

export const GOLDEN_FIXTURES: readonly GoldenFixture[] = [engineerThreeIssues, zeroActivity, blockedIssue];

export interface GoldenScoreResult {
  fixtureId: string;
  /** `computeTextSimilarity(actualDraftText, fixture.referenceDraft)`. */
  score: number;
}

/** Scores one fixture's actual model output against its reference draft. */
export function scoreGoldenFixture(fixture: GoldenFixture, actualDraftText: string): GoldenScoreResult {
  return { fixtureId: fixture.id, score: computeTextSimilarity(actualDraftText, fixture.referenceDraft) };
}

export interface GoldenSetSummary {
  results: GoldenScoreResult[];
  meanScore: number;
}

/** Aggregates a full run's per-fixture scores into one mean — what
 * `golden-set-compare.ts` prints as the headline number, and what a human
 * decides a pass/fail threshold against when the prompt or model changes. */
export function summarizeGoldenScores(results: readonly GoldenScoreResult[]): GoldenSetSummary {
  const meanScore = results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / results.length;
  return { results: [...results], meanScore };
}
