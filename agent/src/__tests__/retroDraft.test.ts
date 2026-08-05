import { describe, expect, it, vi } from 'vitest';
import { buildRetroPrompt, gatherWeekDelivery, type WeekDeliverySummary } from '../retroDraft.js';
import type { DeepShipClientLike, ShipDocument } from '../shipClient.js';

// Week window for every test below (except the ones that override
// `getWeekDates` themselves): sprint_number 1, workspace_sprint_start_date
// '2026-01-01' → computed window [2026-01-01T00:00:00.000Z,
// 2026-01-08T00:00:00.000Z). Chosen as round numbers specifically so the
// window boundaries can be reasoned about by inspection rather than
// hand-computed sprint-cadence arithmetic.
const WEEK_START_ISO = '2026-01-01T00:00:00.000Z';
const WEEK_END_ISO = '2026-01-08T00:00:00.000Z'; // exclusive

function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
  return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
}

function fakeClient(
  overrides: Partial<DeepShipClientLike> = {}
): Pick<DeepShipClientLike, 'getDocument' | 'getReverseAssociations' | 'getWeekDates'> {
  return {
    getDocument: vi.fn(),
    getReverseAssociations: vi.fn().mockResolvedValue([]),
    getWeekDates: vi.fn().mockResolvedValue({ workspace_sprint_start_date: '2026-01-01' }),
    ...overrides,
  };
}

describe('gatherWeekDelivery', () => {
  it(
    'Test Case 3 shape: a week with 4 success criteria and 3 closed issues (mapping to 2 of them) builds ' +
      'the full delivery summary — criteria, owner, and closed issues, excluding a non-done one',
    async () => {
      const client = fakeClient({
        getDocument: vi.fn(async (id: string) => {
          if (id === 'week-1') {
            return doc({
              id: 'week-1',
              title: 'Week 1',
              document_type: 'sprint',
              properties: {
                sprint_number: 1,
                owner_id: 'user-owner-1',
                success_criteria: [
                  'Sprint management flows end-to-end with no manual DB edits',
                  'Sprint timeline UI renders for every active week',
                  'Progress chart reflects real issue counts within 1 minute',
                  'Issue assignment flow ships behind a feature flag',
                ],
              },
            });
          }
          if (id === 'issue-1') {
            return doc({
              id: 'issue-1',
              title: 'Wire sprint management CRUD end-to-end',
              properties: { state: 'done' },
              completed_at: '2026-01-02T10:00:00.000Z',
            });
          }
          if (id === 'issue-2') {
            return doc({
              id: 'issue-2',
              title: 'Remove last manual DB edit from sprint close-out',
              properties: { state: 'done' },
              completed_at: '2026-01-03T10:00:00.000Z',
            });
          }
          if (id === 'issue-3') {
            return doc({
              id: 'issue-3',
              title: 'Ship sprint timeline UI for active weeks',
              properties: { state: 'done' },
              completed_at: '2026-01-04T10:00:00.000Z',
            });
          }
          if (id === 'issue-not-done') {
            return doc({ id: 'issue-not-done', title: 'Still in progress', properties: { state: 'in_progress' } });
          }
          // A 'done' issue associated with the SAME sprint but closed a month
          // before the week's own window — the real bug this design was
          // corrected for (verified against a real seeded database, see
          // this file's module docstring): a stale done issue must NOT leak
          // into a much later week's draft just because it shares the same
          // sprint association.
          if (id === 'issue-stale-done') {
            return doc({
              id: 'issue-stale-done',
              title: 'Old work closed long before this week',
              properties: { state: 'done' },
              completed_at: '2025-11-15T10:00:00.000Z',
            });
          }
          throw new Error(`404: ${id}`);
        }),
        getReverseAssociations: vi.fn(async (id: string, type?: string) => {
          if (id === 'week-1' && type === 'sprint') {
            return [
              { document_id: 'issue-1', relationship_type: 'sprint' },
              { document_id: 'issue-2', relationship_type: 'sprint' },
              { document_id: 'issue-3', relationship_type: 'sprint' },
              { document_id: 'issue-not-done', relationship_type: 'sprint' },
              { document_id: 'issue-stale-done', relationship_type: 'sprint' },
            ];
          }
          return [];
        }),
      });

      const summary = await gatherWeekDelivery(client, 'week-1');

      expect(summary).toBeDefined();
      if (!summary) throw new Error('expected a summary');

      expect(summary.weekId).toBe('week-1');
      expect(summary.weekNumber).toBe(1);
      expect(summary.ownerUserId).toBe('user-owner-1');
      expect(summary.successCriteria).toHaveLength(4);
      expect(summary.weekDatesUnavailable).toBe(false);

      // Exactly the 3 done-and-in-window issues — the still-in-progress one
      // AND the stale done-but-out-of-window one are both excluded.
      expect(summary.closedIssues).toHaveLength(3);
      expect(summary.closedIssues.map((i) => i.issueId).sort()).toEqual(['issue-1', 'issue-2', 'issue-3']);
      const issue1 = summary.closedIssues.find((i) => i.issueId === 'issue-1');
      expect(issue1).toMatchObject({
        title: 'Wire sprint management CRUD end-to-end',
        completedAt: '2026-01-02T10:00:00.000Z',
      });
    }
  );

  it('returns undefined when the week itself is gone or invisible to this token — not a throw', async () => {
    const client = fakeClient({ getDocument: vi.fn().mockRejectedValue(new Error('404: gone')) });

    const summary = await gatherWeekDelivery(client, 'missing-week');

    expect(summary).toBeUndefined();
  });

  it('returns undefined when the id resolves to a document that is not actually a "sprint" — not a real week trigger', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(doc({ id: 'not-a-week', title: 'Some issue', document_type: 'issue' })),
    });

    const summary = await gatherWeekDelivery(client, 'not-a-week');

    expect(summary).toBeUndefined();
  });

  it('a week with no success_criteria at all reports an empty array, not undefined/null', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'week-2', title: 'Week 2', document_type: 'sprint', properties: { sprint_number: 2, owner_id: 'user-owner-2' } })
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-2');

    expect(summary?.successCriteria).toEqual([]);
  });

  it('a week with no recorded owner reports ownerUserId: null rather than throwing or guessing', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'week-3', title: 'Week 3', document_type: 'sprint', properties: { sprint_number: 3, success_criteria: ['Ship it'] } })
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-3');

    expect(summary?.ownerUserId).toBeNull();
  });

  it('skips an associated issue that is gone/inaccessible, without failing the whole gather', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'week-4') return doc({ id: 'week-4', title: 'Week 4', document_type: 'sprint', properties: { sprint_number: 1, owner_id: 'user-owner-3', success_criteria: ['Ship it'] } });
        if (id === 'issue-visible') return doc({ id: 'issue-visible', title: 'Visible done issue', properties: { state: 'done' }, completed_at: '2026-01-02T00:00:00.000Z' });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'week-4' && type === 'sprint'
          ? [
              { document_id: 'issue-visible', relationship_type: 'sprint' },
              { document_id: 'issue-gone', relationship_type: 'sprint' },
            ]
          : []
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-4');

    expect(summary?.closedIssues).toHaveLength(1);
    expect(summary?.closedIssues[0]?.issueId).toBe('issue-visible');
  });

  it('has no closed issues at all when getReverseAssociations fails — degrades rather than throwing', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'week-5', title: 'Week 5', document_type: 'sprint', properties: { sprint_number: 5, owner_id: 'user-owner-4', success_criteria: ['Ship it'] } })
      ),
      getReverseAssociations: vi.fn().mockRejectedValue(new Error('network blip')),
    });

    const summary = await gatherWeekDelivery(client, 'week-5');

    expect(summary?.closedIssues).toEqual([]);
    expect(summary?.weekDatesUnavailable).toBe(false);
  });

  it('excludes a done issue whose completed_at is absent — cannot be verified to have closed in this week', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'week-6') return doc({ id: 'week-6', title: 'Week 6', document_type: 'sprint', properties: { sprint_number: 6, owner_id: 'user-owner-5', success_criteria: ['Ship it'] } });
        if (id === 'issue-no-date') return doc({ id: 'issue-no-date', title: 'Closed with no backfilled date', properties: { state: 'done' } });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'week-6' && type === 'sprint' ? [{ document_id: 'issue-no-date', relationship_type: 'sprint' }] : []
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-6');

    expect(summary?.closedIssues).toEqual([]);
  });

  it('excludes a done issue whose completed_at falls just BEFORE the week window starts', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'week-7') return doc({ id: 'week-7', title: 'Week 1', document_type: 'sprint', properties: { sprint_number: 1, owner_id: 'user-owner-6', success_criteria: ['Ship it'] } });
        if (id === 'issue-before') return doc({ id: 'issue-before', title: 'Closed one second too early', properties: { state: 'done' }, completed_at: '2025-12-31T23:59:59.999Z' });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'week-7' && type === 'sprint' ? [{ document_id: 'issue-before', relationship_type: 'sprint' }] : []
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-7');

    expect(summary?.closedIssues).toEqual([]);
  });

  it('excludes a done issue whose completed_at falls exactly AT the week window end (half-open, exclusive)', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'week-8') return doc({ id: 'week-8', title: 'Week 1', document_type: 'sprint', properties: { sprint_number: 1, owner_id: 'user-owner-7', success_criteria: ['Ship it'] } });
        if (id === 'issue-at-end') return doc({ id: 'issue-at-end', title: 'Closed exactly at the boundary', properties: { state: 'done' }, completed_at: WEEK_END_ISO });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'week-8' && type === 'sprint' ? [{ document_id: 'issue-at-end', relationship_type: 'sprint' }] : []
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-8');

    expect(summary?.closedIssues).toEqual([]);
  });

  it('includes a done issue whose completed_at falls exactly AT the week window start (inclusive)', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'week-9') return doc({ id: 'week-9', title: 'Week 1', document_type: 'sprint', properties: { sprint_number: 1, owner_id: 'user-owner-8', success_criteria: ['Ship it'] } });
        if (id === 'issue-at-start') return doc({ id: 'issue-at-start', title: 'Closed exactly at the window start', properties: { state: 'done' }, completed_at: WEEK_START_ISO });
        throw new Error(`404: ${id}`);
      }),
      getReverseAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'week-9' && type === 'sprint' ? [{ document_id: 'issue-at-start', relationship_type: 'sprint' }] : []
      ),
    });

    const summary = await gatherWeekDelivery(client, 'week-9');

    expect(summary?.closedIssues.map((i) => i.issueId)).toEqual(['issue-at-start']);
  });

  it('reports weekDatesUnavailable: true and no closed issues when getWeekDates fails — never guesses a window', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(
        doc({ id: 'week-10', title: 'Week 10', document_type: 'sprint', properties: { sprint_number: 10, owner_id: 'user-owner-9', success_criteria: ['Ship it'] } })
      ),
      getWeekDates: vi.fn().mockRejectedValue(new Error('Ship unreachable')),
      getReverseAssociations: vi.fn(), // must never be called — no point walking issues without a window
    });

    const summary = await gatherWeekDelivery(client, 'week-10');

    expect(summary?.weekDatesUnavailable).toBe(true);
    expect(summary?.closedIssues).toEqual([]);
    // Success criteria/owner are still reported — only the closed-issue set is withheld.
    expect(summary?.successCriteria).toEqual(['Ship it']);
    expect(summary?.ownerUserId).toBe('user-owner-9');
    expect(client.getReverseAssociations).not.toHaveBeenCalled();
  });
});

describe('buildRetroPrompt', () => {
  function testCase3Summary(): WeekDeliverySummary {
    return {
      weekId: 'week-1',
      weekTitle: 'Week 1',
      weekNumber: 1,
      ownerUserId: 'user-owner-1',
      successCriteria: [
        'Sprint management flows end-to-end with no manual DB edits',
        'Sprint timeline UI renders for every active week',
        'Progress chart reflects real issue counts within 1 minute',
        'Issue assignment flow ships behind a feature flag',
      ],
      closedIssues: [
        { issueId: 'issue-1', title: 'Wire sprint management CRUD end-to-end', completedAt: '2026-01-02T10:00:00.000Z' },
        { issueId: 'issue-2', title: 'Remove last manual DB edit from sprint close-out', completedAt: '2026-01-03T10:00:00.000Z' },
        { issueId: 'issue-3', title: 'Ship sprint timeline UI for active weeks', completedAt: '2026-01-04T10:00:00.000Z' },
      ],
      weekDatesUnavailable: false,
    };
  }

  it('names every success criterion and every closed issue, and instructs the model to map issues to criteria', () => {
    const prompt = buildRetroPrompt(testCase3Summary());

    for (const criterion of testCase3Summary().successCriteria) {
      expect(prompt).toContain(criterion);
    }
    expect(prompt).toContain('Wire sprint management CRUD end-to-end');
    expect(prompt).toContain('Remove last manual DB edit from sprint close-out');
    expect(prompt).toContain('Ship sprint timeline UI for active weeks');
    expect(prompt).toContain('Map each closed issue to the success criterion');
    expect(prompt).toContain('DRAFT');
  });

  it('instructs the model to call out criteria with no matching closed work (Test Case 3\'s own proof condition)', () => {
    const prompt = buildRetroPrompt(testCase3Summary());

    expect(prompt).toMatch(/explicitly call it out as not\s+yet delivered/i);
    expect(prompt).toMatch(/rather than silently dropping/i);
  });

  it('says plainly when no issues closed this week, rather than omitting the fact', () => {
    const summary: WeekDeliverySummary = { ...testCase3Summary(), closedIssues: [] };
    const prompt = buildRetroPrompt(summary);

    expect(prompt).toContain('No issues closed this week');
    expect(prompt).toMatch(/say so plainly/i);
  });

  it('instructs the model never to include unplanned work', () => {
    const prompt = buildRetroPrompt(testCase3Summary());

    expect(prompt).toMatch(/does not include unplanned work/i);
  });
});
