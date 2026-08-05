import { describe, expect, it, vi } from 'vitest';
import {
  alignCriteria,
  buildPlanChangePrompt,
  gatherPlanChange,
  parseMaterialityVerdict,
  type PlanChangeSummary,
} from '../planChangeDraft.js';
import type { ChangeFeedResponse, DeepShipClientLike, ShipDocument } from '../shipClient.js';

// Test Case 4's own real text (FLEETGRAPH.MD / api/src/db/seed.ts:1414-1420) —
// 4 original criteria, one (CSRF) removed after approval.
const ORIGINAL_CRITERIA = [
  'All auth endpoints covered by integration tests',
  'Password reset flow ships behind a feature flag',
  'Session timeout matches the 15-minute policy',
  'CSRF protection verified on every mutating route',
];
const EDITED_CRITERIA = ORIGINAL_CRITERIA.slice(0, 3);

function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
  return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
}

function emptyFeed(): ChangeFeedResponse {
  return {
    next_cursor: '2026-01-01T00:01:00.000Z',
    documents: [],
    documents_truncated: false,
    history: [],
    history_truncated: false,
    comments: [],
    comments_truncated: false,
  };
}

function fakeClient(
  overrides: Partial<DeepShipClientLike> = {}
): Pick<DeepShipClientLike, 'getDocument' | 'getChangeFeed'> {
  return {
    getDocument: vi.fn(),
    getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
    ...overrides,
  };
}

describe('alignCriteria', () => {
  it(
    'Test Case 4 shape: one criterion removed entirely, the rest exact matches — reports exactly one ' +
      'removed criterion, nothing added or modified',
    () => {
      const alignment = alignCriteria(ORIGINAL_CRITERIA, EDITED_CRITERIA);

      expect(alignment.removed).toEqual(['CSRF protection verified on every mutating route']);
      expect(alignment.added).toEqual([]);
      expect(alignment.modified).toEqual([]);
      expect(alignment.hasAnyChange).toBe(true);
    }
  );

  it('a pure whitespace difference (double space, trailing space) produces NO facts at all', () => {
    const oldCriteria = ['Session timeout matches the 15-minute policy', 'Ship it'];
    const newCriteria = ['Session  timeout matches the 15-minute policy  ', ' Ship it'];

    const alignment = alignCriteria(oldCriteria, newCriteria);

    expect(alignment.removed).toEqual([]);
    expect(alignment.added).toEqual([]);
    expect(alignment.modified).toEqual([]);
    expect(alignment.hasAnyChange).toBe(false);
  });

  it('reordering with no textual difference produces no facts', () => {
    const oldCriteria = ['A criterion', 'Another criterion', 'A third one'];
    const newCriteria = ['A third one', 'A criterion', 'Another criterion'];

    const alignment = alignCriteria(oldCriteria, newCriteria);

    expect(alignment.hasAnyChange).toBe(false);
  });

  it(
    'a genuine character-level typo fix produces a MODIFIED fact — the deterministic layer never ' +
      'auto-classifies it as cosmetic (see this file\'s own module docstring for why a similarity ' +
      'threshold cannot do that job correctly)',
    () => {
      const oldCriteria = ['Session timeout matches the 15-minute policy'];
      const newCriteria = ['Sesion timeout matches the 15-minute policy']; // typo fix, one char

      const alignment = alignCriteria(oldCriteria, newCriteria);

      expect(alignment.removed).toEqual([]);
      expect(alignment.added).toEqual([]);
      expect(alignment.modified).toEqual([
        { oldText: 'Session timeout matches the 15-minute policy', newText: 'Sesion timeout matches the 15-minute policy' },
      ]);
      expect(alignment.hasAnyChange).toBe(true);
    }
  );

  it('a weakened criterion (word substitution) also produces a MODIFIED fact, correctly not silently matched as unchanged', () => {
    const oldCriteria = ['CSRF protection verified on every mutating route'];
    const newCriteria = ['CSRF protection verified on some mutating routes'];

    const alignment = alignCriteria(oldCriteria, newCriteria);

    expect(alignment.modified).toHaveLength(1);
    expect(alignment.hasAnyChange).toBe(true);
  });

  it('an added criterion with no old counterpart is reported as added', () => {
    const alignment = alignCriteria(['A'], ['A', 'A brand new criterion with nothing similar before']);

    expect(alignment.added).toEqual(['A brand new criterion with nothing similar before']);
    expect(alignment.removed).toEqual([]);
    expect(alignment.hasAnyChange).toBe(true);
  });

  it('two empty lists produce no facts', () => {
    const alignment = alignCriteria([], []);

    expect(alignment).toEqual({ removed: [], added: [], modified: [], hasAnyChange: false });
  });
});

describe('gatherPlanChange', () => {
  function weekDoc(overrides: Partial<ShipDocument['properties']> = {}): ShipDocument {
    return doc({
      id: 'week-1',
      title: 'Week 13',
      document_type: 'sprint',
      properties: {
        sprint_number: 13,
        success_criteria: EDITED_CRITERIA,
        plan_approval: {
          state: 'changed_since_approved',
          approved_by: 'user-approver-1',
          approved_at: '2026-07-30T18:07:58.245Z',
          approved_version_id: null,
          comment: 'Approved — clear goals for the week.',
        },
        // The reachable seed fixture's actual shape (TRO-345/FG-3's Test
        // Case 4, verified against this worktree's own seeded database —
        // see this file's module docstring): plan_history's last entry's
        // `.plan` field holds the OLD success_criteria, JSON-encoded.
        plan_history: [
          {
            plan: JSON.stringify(ORIGINAL_CRITERIA),
            timestamp: '2026-07-30T18:07:58.245Z',
            author_id: 'user-owner-1',
            author_name: 'Dev User',
          },
        ],
        ...overrides,
      },
    });
  }

  it(
    'Test Case 4 shape: reads the "before" snapshot from plan_history (the reachable seed fixture\'s ' +
      'actual mechanism) and aligns it against the current success_criteria',
    async () => {
      const client = fakeClient({ getDocument: vi.fn().mockResolvedValue(weekDoc()) });

      const summary = await gatherPlanChange(client, 'week-1');

      expect(summary).toBeDefined();
      if (!summary) throw new Error('expected a summary');
      expect(summary.weekNumber).toBe(13);
      expect(summary.approvalState).toBe('changed_since_approved');
      expect(summary.approverUserId).toBe('user-approver-1');
      expect(summary.diffSourceFound).toBe(true);
      expect(summary.alignment.removed).toEqual(['CSRF protection verified on every mutating route']);
      expect(summary.alignment.hasAnyChange).toBe(true);
    }
  );

  it('prefers a real document_history row over plan_history when both are present', async () => {
    // document_history says only ONE criterion existed before (a different,
    // more authoritative story than plan_history's snapshot below) —
    // gatherPlanChange must use THIS, not plan_history, confirming the
    // documented preference order.
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(weekDoc()),
      getChangeFeed: vi.fn().mockResolvedValue({
        ...emptyFeed(),
        history: [
          {
            id: 1,
            document_id: 'week-1',
            field: 'success_criteria',
            old_value: JSON.stringify(['Only one criterion existed, per document_history']),
            new_value: JSON.stringify(EDITED_CRITERIA),
            changed_by: 'user-owner-1',
            automated_by: null,
            created_at: '2026-07-31T00:00:00.000Z',
            dedupe_key: 'history:1',
          },
        ],
      }),
    });

    const summary = await gatherPlanChange(client, 'week-1');

    expect(summary?.diffSourceFound).toBe(true);
    expect(summary?.alignment.removed).toEqual(['Only one criterion existed, per document_history']);
  });

  it('takes the OLDEST document_history success_criteria row since approval, not just the latest', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(weekDoc()),
      getChangeFeed: vi.fn().mockResolvedValue({
        ...emptyFeed(),
        history: [
          {
            id: 2,
            document_id: 'week-1',
            field: 'success_criteria',
            old_value: JSON.stringify(['Middle edit — should NOT be used as "before"']),
            new_value: JSON.stringify(EDITED_CRITERIA),
            changed_by: 'user-owner-1',
            automated_by: null,
            created_at: '2026-08-01T00:00:00.000Z',
            dedupe_key: 'history:2',
          },
          {
            id: 1,
            document_id: 'week-1',
            field: 'success_criteria',
            old_value: JSON.stringify(ORIGINAL_CRITERIA),
            new_value: JSON.stringify(['Middle edit — should NOT be used as "before"']),
            changed_by: 'user-owner-1',
            automated_by: null,
            created_at: '2026-07-31T00:00:00.000Z',
            dedupe_key: 'history:1',
          },
        ],
      }),
    });

    const summary = await gatherPlanChange(client, 'week-1');

    expect(summary?.alignment.removed).toEqual(['CSRF protection verified on every mutating route']);
  });

  it('returns undefined when the week itself is gone or invisible to this token', async () => {
    const client = fakeClient({ getDocument: vi.fn().mockRejectedValue(new Error('404: gone')) });

    const summary = await gatherPlanChange(client, 'missing-week');

    expect(summary).toBeUndefined();
  });

  it('returns undefined when the id resolves to a document that is not actually a "sprint"', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(doc({ id: 'not-a-week', title: 'Some issue', document_type: 'issue' })),
    });

    const summary = await gatherPlanChange(client, 'not-a-week');

    expect(summary).toBeUndefined();
  });

  it('reports diffSourceFound: false and never calls getChangeFeed when approval state is not "changed_since_approved"', async () => {
    const getChangeFeed = vi.fn().mockResolvedValue(emptyFeed());
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(weekDoc({ plan_approval: { state: 'approved', approved_by: 'user-approver-1', approved_at: null, approved_version_id: null } })),
      getChangeFeed,
    });

    const summary = await gatherPlanChange(client, 'week-1');

    expect(summary?.approvalState).toBe('approved');
    expect(summary?.diffSourceFound).toBe(false);
    expect(summary?.alignment.hasAnyChange).toBe(false);
    expect(getChangeFeed).not.toHaveBeenCalled();
  });

  it('reports diffSourceFound: false when neither document_history nor plan_history yields a usable snapshot', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(weekDoc({ plan_history: [] })),
      getChangeFeed: vi.fn().mockResolvedValue(emptyFeed()),
    });

    const summary = await gatherPlanChange(client, 'week-1');

    expect(summary?.diffSourceFound).toBe(false);
    expect(summary?.alignment).toEqual({ removed: [], added: [], modified: [], hasAnyChange: false });
  });

  it(
    'a plan_history entry whose .plan is genuine free text (real usage, not the seed fixture\'s JSON-encoded ' +
      'array) is correctly declined as a diff source, not guessed at',
    async () => {
      const client = fakeClient({
        getDocument: vi.fn().mockResolvedValue(
          weekDoc({
            plan_history: [{ plan: 'We will focus on shipping the auth rewrite this week.', timestamp: '2026-07-30T00:00:00.000Z', author_id: 'user-owner-1' }],
          })
        ),
      });

      const summary = await gatherPlanChange(client, 'week-1');

      expect(summary?.diffSourceFound).toBe(false);
    }
  );

  it('reports approverUserId: null when the week has no recorded approver, rather than throwing or guessing', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(
        weekDoc({ plan_approval: { state: 'changed_since_approved', approved_by: null, approved_at: null, approved_version_id: null } })
      ),
    });

    const summary = await gatherPlanChange(client, 'week-1');

    expect(summary?.approverUserId).toBeNull();
  });

  it('degrades to diffSourceFound: false when getChangeFeed fails, then still tries the plan_history fallback', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(weekDoc()),
      getChangeFeed: vi.fn().mockRejectedValue(new Error('Ship unreachable')),
    });

    const summary = await gatherPlanChange(client, 'week-1');

    // The fallback still resolves it — getChangeFeed failing is not fatal.
    expect(summary?.diffSourceFound).toBe(true);
    expect(summary?.alignment.removed).toEqual(['CSRF protection verified on every mutating route']);
  });
});

describe('buildPlanChangePrompt', () => {
  function testCase4Summary(): PlanChangeSummary {
    return {
      weekId: 'week-1',
      weekTitle: 'Week 13',
      weekNumber: 13,
      approvalState: 'changed_since_approved',
      approverUserId: 'user-approver-1',
      diffSourceFound: true,
      currentCriteria: EDITED_CRITERIA,
      alignment: {
        removed: ['CSRF protection verified on every mutating route'],
        added: [],
        modified: [],
        hasAnyChange: true,
      },
    };
  }

  it('names the removed criterion and requires a MATERIAL/NOT MATERIAL verdict as the first line', () => {
    const prompt = buildPlanChangePrompt(testCase4Summary());

    expect(prompt).toContain('CSRF protection verified on every mutating route');
    expect(prompt).toContain('REMOVED');
    expect(prompt).toContain('MATERIAL');
    expect(prompt).toContain('NOT MATERIAL');
  });

  it('lists added and modified criteria when present', () => {
    const summary: PlanChangeSummary = {
      ...testCase4Summary(),
      alignment: {
        removed: [],
        added: ['A brand new criterion'],
        modified: [{ oldText: 'Old wording', newText: 'New wording' }],
        hasAnyChange: true,
      },
    };
    const prompt = buildPlanChangePrompt(summary);

    expect(prompt).toContain('A brand new criterion');
    expect(prompt).toContain('Old wording');
    expect(prompt).toContain('New wording');
  });

  it('instructs the model to treat whitespace/typo-level wording as not material', () => {
    const prompt = buildPlanChangePrompt(testCase4Summary());

    expect(prompt).toMatch(/whitespace-only or typo-level/i);
  });

  it('instructs the model never to write a performance rating', () => {
    const prompt = buildPlanChangePrompt(testCase4Summary());

    expect(prompt).toMatch(/never write a performance rating/i);
  });
});

describe('parseMaterialityVerdict', () => {
  it('parses a MATERIAL verdict, returning the text after the verdict line as the draft', () => {
    const verdict = parseMaterialityVerdict('MATERIAL\n\nHi — I noticed the CSRF criterion was removed, can you explain?');

    expect(verdict.material).toBe(true);
    expect(verdict.draftText).toBe('Hi — I noticed the CSRF criterion was removed, can you explain?');
  });

  it('parses a NOT MATERIAL verdict with an empty draft, case-insensitively', () => {
    expect(parseMaterialityVerdict('not material').material).toBe(false);
    expect(parseMaterialityVerdict('not material').draftText).toBe('');
    expect(parseMaterialityVerdict('NOT MATERIAL\nfixed a typo, nothing to ask').material).toBe(false);
  });

  it('checks NOT MATERIAL before MATERIAL, since the latter is a substring of the former', () => {
    const verdict = parseMaterialityVerdict('NOT MATERIAL');

    expect(verdict.material).toBe(false);
  });

  it('does not mistake a word starting with "material" (e.g. "materialized") for the verdict', () => {
    const verdict = parseMaterialityVerdict('Materialized the question below:\nWhat changed?');

    // Falls through to the malformed-response degrade path (material: true,
    // whole text as the draft) — never silently treated as a valid verdict
    // it did not actually give.
    expect(verdict.material).toBe(true);
    expect(verdict.draftText).toBe('Materialized the question below:\nWhat changed?');
  });

  it('degrades to material: true with the whole response as the draft when the format is not followed', () => {
    const verdict = parseMaterialityVerdict("I think you should ask about the removed criterion.");

    expect(verdict.material).toBe(true);
    expect(verdict.draftText).toBe('I think you should ask about the removed criterion.');
  });
});
