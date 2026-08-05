import { describe, expect, it, vi } from 'vitest';
import { buildBlockerEscalationPrompt, gatherBlockerFanout } from '../blockerFanout.js';
import type { LowestCommonManagerResult } from '../roles.js';
import type { DeepShipClientLike, ShipDocument } from '../shipClient.js';

function doc(overrides: Partial<ShipDocument> & Pick<ShipDocument, 'id' | 'title'>): ShipDocument {
  return { document_type: 'issue', content: null, visibility: 'workspace', created_by: null, properties: {}, ...overrides };
}

function fakeClient(overrides: Partial<DeepShipClientLike> = {}): Pick<DeepShipClientLike, 'getDocument' | 'getAssociations'> {
  return {
    getDocument: vi.fn(),
    getAssociations: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('gatherBlockerFanout', () => {
  it(
    'Test Case 5 shape: an issue in Project A blocking two issues in Project B builds the full impact ' +
      'fan-out — issues, projects, and distinct people',
    async () => {
      const client = fakeClient({
        getDocument: vi.fn(async (id: string) => {
          if (id === 'blocker-1') return doc({ id: 'blocker-1', title: 'Vendor API is down' });
          if (id === 'project-a') return doc({ id: 'project-a', title: 'Project A', document_type: 'project' });
          if (id === 'blocked-1') return doc({ id: 'blocked-1', title: 'Ship the checkout flow', properties: { assignee_id: 'user-engineer-1' } });
          if (id === 'blocked-2') return doc({ id: 'blocked-2', title: 'Wire up billing', properties: { assignee_id: 'user-engineer-2' } });
          if (id === 'project-b') return doc({ id: 'project-b', title: 'Project B', document_type: 'project' });
          throw new Error(`404: ${id}`);
        }),
        getAssociations: vi.fn(async (id: string, type?: string) => {
          if (id === 'blocker-1' && type === 'project') return [{ related_id: 'project-a', relationship_type: 'project' }];
          if (id === 'blocker-1' && type === 'blocks') {
            return [
              { related_id: 'blocked-1', relationship_type: 'blocks' },
              { related_id: 'blocked-2', relationship_type: 'blocks' },
            ];
          }
          if ((id === 'blocked-1' || id === 'blocked-2') && type === 'project') {
            return [{ related_id: 'project-b', relationship_type: 'project' }];
          }
          return [];
        }),
      });

      const impact = await gatherBlockerFanout(client, 'blocker-1');

      expect(impact).toBeDefined();
      if (!impact) throw new Error('expected an impact');

      expect(impact.blockingIssueId).toBe('blocker-1');
      expect(impact.blockingIssueTitle).toBe('Vendor API is down');
      expect(impact.blockingIssueProjectId).toBe('project-a');
      expect(impact.blockingIssueProjectTitle).toBe('Project A');

      expect(impact.blockedIssues).toHaveLength(2);
      expect(impact.blockedIssues.map((b) => b.issueId).sort()).toEqual(['blocked-1', 'blocked-2']);
      const blocked1 = impact.blockedIssues.find((b) => b.issueId === 'blocked-1');
      expect(blocked1).toMatchObject({
        title: 'Ship the checkout flow',
        projectId: 'project-b',
        projectTitle: 'Project B',
        assigneeUserId: 'user-engineer-1',
      });

      // Two total projects — the blocking issue's own (Project A) plus the
      // one distinct blocked-side project (Project B) — matching TRO-337's
      // own trigger condition, which counts both.
      expect(impact.distinctProjectIds.sort()).toEqual(['project-a', 'project-b']);
      expect(impact.blockedPeopleUserIds.sort()).toEqual(['user-engineer-1', 'user-engineer-2']);
    }
  );

  it('returns undefined when the blocking issue itself is gone or invisible to this token — not a throw', async () => {
    const client = fakeClient({ getDocument: vi.fn().mockRejectedValue(new Error('404: gone')) });

    const impact = await gatherBlockerFanout(client, 'missing-issue');

    expect(impact).toBeUndefined();
  });

  it('skips a blocked issue that is gone/inaccessible, without failing the whole walk', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'blocker-1') return doc({ id: 'blocker-1', title: 'Blocker' });
        if (id === 'blocked-visible') return doc({ id: 'blocked-visible', title: 'Visible blocked issue' });
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string, type?: string) => {
        if (id === 'blocker-1' && type === 'blocks') {
          return [
            { related_id: 'blocked-visible', relationship_type: 'blocks' },
            { related_id: 'blocked-gone', relationship_type: 'blocks' },
          ];
        }
        return [];
      }),
    });

    const impact = await gatherBlockerFanout(client, 'blocker-1');

    expect(impact?.blockedIssues).toHaveLength(1);
    expect(impact?.blockedIssues[0]?.issueId).toBe('blocked-visible');
  });

  it('a blocked issue with no assignee contributes no one to blockedPeopleUserIds but still appears in the fan-out', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => {
        if (id === 'blocker-1') return doc({ id: 'blocker-1', title: 'Blocker' });
        if (id === 'unassigned-issue') return doc({ id: 'unassigned-issue', title: 'Nobody owns this yet' });
        throw new Error(`404: ${id}`);
      }),
      getAssociations: vi.fn(async (id: string, type?: string) =>
        id === 'blocker-1' && type === 'blocks' ? [{ related_id: 'unassigned-issue', relationship_type: 'blocks' }] : []
      ),
    });

    const impact = await gatherBlockerFanout(client, 'blocker-1');

    expect(impact?.blockedIssues).toHaveLength(1);
    expect(impact?.blockedIssues[0]?.assigneeUserId).toBeNull();
    expect(impact?.blockedPeopleUserIds).toEqual([]);
  });

  it('has no blocked issues at all when getAssociations(..., "blocks") fails — degrades rather than throwing', async () => {
    const client = fakeClient({
      getDocument: vi.fn(async (id: string) => doc({ id, title: 'Blocker' })),
      getAssociations: vi.fn().mockRejectedValue(new Error('network blip')),
    });

    const impact = await gatherBlockerFanout(client, 'blocker-1');

    expect(impact?.blockedIssues).toEqual([]);
  });
});

describe('buildBlockerEscalationPrompt', () => {
  const impact = {
    blockingIssueId: 'blocker-1',
    blockingIssueTitle: 'Vendor API is down',
    blockingIssueProjectId: 'project-a',
    blockingIssueProjectTitle: 'Project A',
    blockedIssues: [
      { issueId: 'blocked-1', title: 'Ship the checkout flow', projectId: 'project-b', projectTitle: 'Project B', assigneeUserId: 'user-engineer-1' },
      { issueId: 'blocked-2', title: 'Wire up billing', projectId: 'project-b', projectTitle: 'Project B', assigneeUserId: 'user-engineer-2' },
    ],
    distinctProjectIds: ['project-a', 'project-b'],
    blockedPeopleUserIds: ['user-engineer-1', 'user-engineer-2'],
  };

  it('names every blocked issue, its project, and instructs the model to address a confirmed manager', () => {
    const manager: LowestCommonManagerResult = { managerUserId: 'director-1', reason: 'found' };
    const prompt = buildBlockerEscalationPrompt(impact, manager);

    expect(prompt).toContain('Vendor API is down');
    expect(prompt).toContain('Project A');
    expect(prompt).toContain('Ship the checkout flow');
    expect(prompt).toContain('Wire up billing');
    expect(prompt).toContain('Project B');
    expect(prompt).toContain('authority over everyone blocked');
    expect(prompt).toContain('DRAFT');
    // The degrade-path language ("no single manager could be confirmed")
    // must NOT appear when a manager WAS confirmed.
    expect(prompt).not.toContain('No single manager could be confirmed');
  });

  it('states the degrade path plainly when no common manager was confirmed', () => {
    const manager: LowestCommonManagerResult = { managerUserId: null, reason: 'no_common_manager', highestReachableUserId: 'director-1' };
    const prompt = buildBlockerEscalationPrompt(impact, manager);

    expect(prompt).toContain('No single manager could be confirmed');
    expect(prompt).toContain('loop in whoever else needs to be involved');
  });

  it('instructs the model never to imply the message has already been sent', () => {
    const manager: LowestCommonManagerResult = { managerUserId: 'director-1', reason: 'found' };
    const prompt = buildBlockerEscalationPrompt(impact, manager);

    expect(prompt).toMatch(/never read as though it has already been sent/i);
    expect(prompt).toMatch(/do not state or imply this message has already been sent/i);
  });
});
