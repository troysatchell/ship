import { describe, expect, it, vi } from 'vitest';
import {
  buildProposedTransitions,
  buildStandupPrompt,
  findStandupAnchor,
  gatherPersonActivity,
  type MovedIssueActivity,
  type PersonActivitySummary,
} from '../standupDraft.js';
import type {
  AssigneeIssueSummary,
  ChangeFeedResponse,
  DeepShipClientLike,
  DocumentListItem,
  ShipDocument,
} from '../shipClient.js';

/**
 * Fixture ids/titles/content below are REAL rows in this worktree's seeded
 * dev database (`pnpm db:seed`'s FG-3 "Test Case 1" fixture block,
 * `api/src/db/seed.ts` — verified by querying `ship_wt_tro_327` directly on
 * 2026-08-04, not guessed): engineer Emma Johnson, her 3 assigned issues
 * (`Build issue assignment flow` moved to `in_review`, `Create sprint
 * retrospective view` commented on, `Implement burndown chart` stale for 7
 * days), and the standup fixture their FG-3 anchor is measured against.
 * `DeepShipClientLike` is still a FAKE here (per this package's own testing
 * convention — no live DB/HTTP call from any test, see `graph.test.ts`'s
 * own on-demand describe block for the identical posture) but every
 * id/title/value is grounded in real seeded data.
 */
const EMMA_USER_ID = '6e6d2906-6e53-4a8c-a166-ca3661029363';
const STANDUP_ID = 'bf55a6c9-83ba-498f-9778-ae7697ea1bdb';
const ANCHOR_ISO = '2026-08-01T14:34:49.637Z'; // the FG-3 standup's real created_at
const MOVED_ISSUE_ID = '9c862982-c6a0-4795-b710-05da50a94623'; // "Build issue assignment flow"
const COMMENTED_ISSUE_ID = '09f9b549-e60f-434b-b741-6ca78a507d65'; // "Create sprint retrospective view"
const STALE_ISSUE_ID = '2bea5768-22fa-4c33-bdfa-fc500819f0ea'; // "Implement burndown chart"

function issue(overrides: Partial<AssigneeIssueSummary> & Pick<AssigneeIssueSummary, 'id' | 'title'>): AssigneeIssueSummary {
  return { state: 'in_progress', updated_at: '2026-08-04T00:00:00.000Z', ...overrides };
}

function emptyFeed(overrides: Partial<ChangeFeedResponse> = {}): ChangeFeedResponse {
  return {
    next_cursor: '2026-08-05T00:00:00.000Z',
    documents: [],
    documents_truncated: false,
    history: [],
    history_truncated: false,
    comments: [],
    comments_truncated: false,
    ...overrides,
  };
}

function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
  return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
}

function fakeClient(overrides: Partial<DeepShipClientLike> = {}): DeepShipClientLike {
  return {
    getIssuesByAssignee: vi.fn().mockResolvedValue([]),
    getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
    getAssociations: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn(async (id: string) => doc({ id, title: `doc ${id}` })),
    listDocuments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function standupRow(overrides: Partial<DocumentListItem> = {}): DocumentListItem {
  return {
    id: STANDUP_ID,
    document_type: 'standup',
    properties: { author_id: EMMA_USER_ID },
    created_at: ANCHOR_ISO,
    updated_at: ANCHOR_ISO,
    ...overrides,
  };
}

describe('findStandupAnchor', () => {
  it('anchors on the real FG-3 fixture standup\'s created_at (not properties.date, which that fixture omits)', async () => {
    const client = fakeClient({ listDocuments: vi.fn().mockResolvedValue([standupRow()]) });

    const anchor = await findStandupAnchor(client, EMMA_USER_ID, () => new Date('2026-08-04T14:34:49.000Z'));

    expect(anchor).toEqual({ anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID });
  });

  it('ignores other authors\' standups when picking the most recent', async () => {
    const client = fakeClient({
      listDocuments: vi.fn().mockResolvedValue([
        standupRow({ id: 'other-1', properties: { author_id: 'someone-else' }, created_at: '2026-08-04T00:00:00.000Z' }),
        standupRow({ id: 'mine-older', created_at: '2026-07-30T00:00:00.000Z' }),
        standupRow(), // the real fixture row, newest of Emma's own
      ]),
    });

    const anchor = await findStandupAnchor(client, EMMA_USER_ID, () => new Date('2026-08-04T14:34:49.000Z'));

    expect(anchor.lastStandupId).toBe(STANDUP_ID);
  });

  it('falls back to a default lookback window with isFirstStandup=true when the person has no prior standup', async () => {
    const client = fakeClient({ listDocuments: vi.fn().mockResolvedValue([]) });
    const now = () => new Date('2026-08-04T12:00:00.000Z');

    const anchor = await findStandupAnchor(client, EMMA_USER_ID, now, 3 * 24 * 60 * 60 * 1000);

    expect(anchor.isFirstStandup).toBe(true);
    expect(anchor.lastStandupId).toBeUndefined();
    expect(anchor.anchorISO).toBe('2026-08-01T12:00:00.000Z');
  });
});

describe('gatherPersonActivity — Test Case 1 (FLEETGRAPH.MD / TRO-319 proof #1)', () => {
  it('classifies one moved, one commented, one stale issue exactly as the real FG-3 fixture is shaped', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([
        issue({ id: MOVED_ISSUE_ID, title: 'Build issue assignment flow', state: 'in_review', updated_at: '2026-08-03T14:34:49.638Z' }),
        issue({ id: COMMENTED_ISSUE_ID, title: 'Create sprint retrospective view', state: 'in_progress', updated_at: '2026-08-03T14:34:49.639Z' }),
        issue({ id: STALE_ISSUE_ID, title: 'Implement burndown chart', state: 'todo', updated_at: '2026-07-28T14:34:49.640Z' }),
      ]),
      getChangeFeed: vi.fn().mockResolvedValue(
        emptyFeed({
          history: [
            {
              id: 212,
              document_id: MOVED_ISSUE_ID,
              field: 'state',
              old_value: 'in_progress',
              new_value: 'in_review',
              changed_by: EMMA_USER_ID,
              automated_by: null,
              created_at: '2026-08-03T14:34:49.638Z',
              dedupe_key: 'history:212',
            },
          ],
          comments: [
            {
              id: 'efa909fd-3ec8-421b-967d-9665ef3031be',
              document_id: COMMENTED_ISSUE_ID,
              comment_id: '06b7f1da-478d-4c6b-9414-40cac3dfbda6',
              parent_id: null,
              author_id: EMMA_USER_ID,
              content: 'Making progress on Create sprint retrospective view — should land by end of week.',
              resolved_at: null,
              created_at: '2026-08-03T14:34:49.639Z',
              updated_at: '2026-08-03T14:34:49.639Z',
              dedupe_key: 'comment:efa909fd:2026-08-03T14:34:49.639Z',
            },
          ],
        })
      ),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID };

    // 1ms past exactly 7×24h after the stale issue's updated_at
    // (2026-07-28T14:34:49.640Z) — avoids a floor()-rounds-down-to-6 flake
    // from landing a hair under the 7-day boundary.
    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, {
      now: () => new Date('2026-08-04T14:34:49.641Z'),
    });

    expect(summary.hasAnyActivity).toBe(true);

    expect(summary.moved).toHaveLength(1);
    expect(summary.moved[0]).toMatchObject({
      issueId: MOVED_ISSUE_ID,
      title: 'Build issue assignment flow',
      fromState: 'in_progress',
      toState: 'in_review',
      changedBy: EMMA_USER_ID,
    });

    expect(summary.commented).toHaveLength(1);
    expect(summary.commented[0]).toMatchObject({
      issueId: COMMENTED_ISSUE_ID,
      title: 'Create sprint retrospective view',
      commentSnippet: 'Making progress on Create sprint retrospective view — should land by end of week.',
    });

    expect(summary.stale).toHaveLength(1);
    expect(summary.stale[0]).toMatchObject({
      issueId: STALE_ISSUE_ID,
      title: 'Implement burndown chart',
      daysSinceUpdate: 7,
    });
  });

  it('proof #1: a proposed transition, with its evidence, is produced for the moved issue', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([
        issue({ id: MOVED_ISSUE_ID, title: 'Build issue assignment flow', updated_at: '2026-08-03T14:34:49.638Z' }),
      ]),
      getChangeFeed: vi.fn().mockResolvedValue(
        emptyFeed({
          history: [
            {
              id: 212,
              document_id: MOVED_ISSUE_ID,
              field: 'state',
              old_value: 'in_progress',
              new_value: 'in_review',
              changed_by: EMMA_USER_ID,
              automated_by: null,
              created_at: '2026-08-03T14:34:49.638Z',
              dedupe_key: 'history:212',
            },
          ],
        })
      ),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID };
    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, {
      now: () => new Date('2026-08-04T14:34:49.000Z'),
    });

    const transitions = buildProposedTransitions(summary.moved);

    expect(transitions).toEqual([
      {
        issueId: MOVED_ISSUE_ID,
        issueTitle: 'Build issue assignment flow',
        field: 'state',
        fromState: 'in_progress',
        toState: 'in_review',
        evidence: { kind: 'history', changedAt: '2026-08-03T14:34:49.638Z', changedBy: EMMA_USER_ID },
      },
    ]);
  });
});

describe('gatherPersonActivity — zero-activity case (TRO-319 proof #2)', () => {
  it('reports no activity and no stale issues for a person with zero assigned issues, rather than inventing content', async () => {
    const client = fakeClient({ getIssuesByAssignee: vi.fn().mockResolvedValue([]) });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor);

    expect(summary.hasAnyActivity).toBe(false);
    expect(summary.moved).toEqual([]);
    expect(summary.commented).toEqual([]);
    expect(summary.stale).toEqual([]);
  });

  it('hasAnyActivity is false when every assigned issue is merely stale — staleness alone is not "activity"', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([issue({ id: STALE_ISSUE_ID, title: 'Implement burndown chart', updated_at: '2026-07-28T00:00:00.000Z' })]),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, { now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(summary.hasAnyActivity).toBe(false);
    expect(summary.stale).toHaveLength(1);
  });
});

describe('gatherPersonActivity — classification priority and blockers', () => {
  it('an issue with BOTH a state change and a comment classifies as moved (the higher-signal fact)', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([issue({ id: MOVED_ISSUE_ID, title: 'Both things happened' })]),
      getChangeFeed: vi.fn().mockResolvedValue(
        emptyFeed({
          history: [
            { id: 1, document_id: MOVED_ISSUE_ID, field: 'state', old_value: 'todo', new_value: 'in_progress', changed_by: EMMA_USER_ID, automated_by: null, created_at: '2026-08-02T00:00:00.000Z', dedupe_key: 'h1' },
          ],
          comments: [
            { id: 'c1', document_id: MOVED_ISSUE_ID, comment_id: 'c1', parent_id: null, author_id: EMMA_USER_ID, content: 'also commented', resolved_at: null, created_at: '2026-08-02T01:00:00.000Z', updated_at: '2026-08-02T01:00:00.000Z', dedupe_key: 'c1' },
          ],
        })
      ),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor);

    expect(summary.moved).toHaveLength(1);
    expect(summary.commented).toHaveLength(0);
  });

  it('ignores a comment authored by someone else on the person\'s own issue', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([issue({ id: COMMENTED_ISSUE_ID, title: 'Someone else weighed in', updated_at: '2026-08-01T00:00:00.000Z' })]),
      getChangeFeed: vi.fn().mockResolvedValue(
        emptyFeed({
          comments: [
            { id: 'c1', document_id: COMMENTED_ISSUE_ID, comment_id: 'c1', parent_id: null, author_id: 'someone-else', content: 'not emma', resolved_at: null, created_at: '2026-08-02T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z', dedupe_key: 'c1' },
          ],
        })
      ),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, { now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(summary.commented).toEqual([]);
    expect(summary.stale).toHaveLength(1); // the comment doesn't count — it wasn't the person's own
  });

  it('attaches blockedBy when a live "blocks" association resolves to a real document', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([issue({ id: STALE_ISSUE_ID, title: 'Blocked issue', updated_at: '2026-07-28T00:00:00.000Z' })]),
      getAssociations: vi.fn().mockResolvedValue([{ related_id: 'blocker-1', relationship_type: 'blocks' }]),
      getDocument: vi.fn().mockResolvedValue(doc({ id: 'blocker-1', title: 'The blocking issue' })),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, { now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(summary.stale[0]?.blockedBy).toEqual({ issueId: 'blocker-1', title: 'The blocking issue' });
  });

  it('never throws when the blocker lookup fails — omits blockedBy instead', async () => {
    const client = fakeClient({
      getIssuesByAssignee: vi.fn().mockResolvedValue([issue({ id: STALE_ISSUE_ID, title: 'Blocked issue', updated_at: '2026-07-28T00:00:00.000Z' })]),
      getAssociations: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const anchor = { anchorISO: ANCHOR_ISO, isFirstStandup: false };

    const summary = await gatherPersonActivity(client, EMMA_USER_ID, anchor, { now: () => new Date('2026-08-04T00:00:00.000Z') });

    expect(summary.stale[0]?.blockedBy).toBeUndefined();
  });
});

describe('buildStandupPrompt', () => {
  function summary(overrides: Partial<PersonActivitySummary> = {}): PersonActivitySummary {
    return {
      anchor: { anchorISO: ANCHOR_ISO, isFirstStandup: false, lastStandupId: STANDUP_ID },
      moved: [],
      commented: [],
      stale: [],
      hasAnyActivity: false,
      ...overrides,
    };
  }

  it('instructs the model to say plainly that nothing moved, when hasAnyActivity is false (proof #2)', () => {
    const prompt = buildStandupPrompt(summary());
    expect(prompt).toContain('Nothing moved in this window');
  });

  it('does NOT include the "nothing moved" instruction when something did move', () => {
    const moved: MovedIssueActivity = {
      kind: 'moved',
      issueId: MOVED_ISSUE_ID,
      title: 'Build issue assignment flow',
      field: 'state',
      fromState: 'in_progress',
      toState: 'in_review',
      changedAt: '2026-08-03T14:34:49.638Z',
      changedBy: EMMA_USER_ID,
    };
    const prompt = buildStandupPrompt(summary({ moved: [moved], hasAnyActivity: true }));
    expect(prompt).not.toContain('Nothing moved in this window');
    expect(prompt).toContain('Build issue assignment flow');
    expect(prompt).toContain('in_progress');
    expect(prompt).toContain('in_review');
  });

  it('names each stale issue and how many days it has been sitting', () => {
    const prompt = buildStandupPrompt(
      summary({
        stale: [{ kind: 'stale', issueId: STALE_ISSUE_ID, title: 'Implement burndown chart', daysSinceUpdate: 7, lastUpdatedAt: '2026-07-28T14:34:49.640Z' }],
      })
    );
    expect(prompt).toContain('Implement burndown chart');
    expect(prompt).toContain('7 days');
  });

  it('says plainly that no issues are assigned when every category is empty', () => {
    const prompt = buildStandupPrompt(summary());
    expect(prompt).toContain('No issues are currently assigned to this person.');
  });

  it('explicitly instructs the model never to write a performance rating or claim the draft was already posted (hard limits, as prompt rules)', () => {
    const prompt = buildStandupPrompt(summary({ hasAnyActivity: true }));
    expect(prompt.toLowerCase()).toContain('never write a performance rating');
    expect(prompt.toLowerCase()).toContain('you are not posting this');
  });
});
