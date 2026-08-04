import { describe, expect, it, vi } from 'vitest';
import {
  buildCandidatesFromDocument,
  buildCitedSources,
  buildExpansionPrompt,
  capNoticeText,
  extractPlainText,
  fetchCommentSnippets,
  passesAskerVisibility,
  scoreCandidate,
  sortFrontierByRelevance,
  visitDocument,
  type ExpandedDocument,
  type ExpansionCandidate,
} from '../expansion.js';
import type { CommentEntry, OnDemandShipClientLike, ShipDocument } from '../shipClient.js';

function doc(overrides: Partial<ShipDocument> = {}): ShipDocument {
  return {
    id: 'doc-1',
    document_type: 'issue',
    title: 'Some issue',
    content: null,
    visibility: 'workspace',
    created_by: null,
    properties: {},
    ...overrides,
  };
}

function fakeClient(overrides: Partial<OnDemandShipClientLike> = {}): OnDemandShipClientLike {
  return {
    getDocument: vi.fn().mockResolvedValue(doc()),
    getAssociations: vi.fn().mockResolvedValue([]),
    getReverseAssociations: vi.fn().mockResolvedValue([]),
    getBacklinks: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([]),
    getIssuesByAssignee: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function comment(overrides: Partial<CommentEntry> = {}): CommentEntry {
  return {
    id: 'comment-1',
    content: 'hello',
    author: { id: 'u1', name: 'Emma Johnson', email: null },
    created_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

describe('scoreCandidate / sortFrontierByRelevance', () => {
  it('ranks a closer hop above a farther one for the same edge type', () => {
    const near: ExpansionCandidate = { documentId: 'a', reason: 'r', edgeType: 'sprint_forward', hop: 1, sourceDocumentId: 's' };
    const far: ExpansionCandidate = { documentId: 'b', reason: 'r', edgeType: 'sprint_forward', hop: 2, sourceDocumentId: 's' };
    expect(scoreCandidate(near)).toBeGreaterThan(scoreCandidate(far));
  });

  it('ranks blocks above plain containment at the same hop', () => {
    const blocks: ExpansionCandidate = { documentId: 'a', reason: 'r', edgeType: 'blocks_reverse', hop: 1, sourceDocumentId: 's' };
    const project: ExpansionCandidate = { documentId: 'b', reason: 'r', edgeType: 'project_reverse', hop: 1, sourceDocumentId: 's' };
    expect(scoreCandidate(blocks)).toBeGreaterThan(scoreCandidate(project));
  });

  it('sorts a mixed frontier highest score first, ties broken by documentId', () => {
    const frontier: ExpansionCandidate[] = [
      { documentId: 'z', reason: 'r', edgeType: 'backlink', hop: 1, sourceDocumentId: 's' },
      { documentId: 'a', reason: 'r', edgeType: 'sprint_forward', hop: 1, sourceDocumentId: 's' },
      { documentId: 'b', reason: 'r', edgeType: 'sprint_forward', hop: 1, sourceDocumentId: 's' }, // same score as 'a'
    ];

    const sorted = sortFrontierByRelevance(frontier);

    expect(sorted.map((c) => c.documentId)).toEqual(['a', 'b', 'z']);
  });

  it('is a pure function — same input always produces the same order', () => {
    const frontier: ExpansionCandidate[] = [
      { documentId: 'c', reason: 'r', edgeType: 'unknown', hop: 3, sourceDocumentId: 's' },
      { documentId: 'a', reason: 'r', edgeType: 'blocks_forward', hop: 0, sourceDocumentId: 's' },
    ];

    expect(sortFrontierByRelevance(frontier)).toEqual(sortFrontierByRelevance(frontier));
  });
});

describe('buildCandidatesFromDocument', () => {
  it('classifies forward associations with a reason naming the source document', async () => {
    const client = fakeClient({
      getAssociations: vi.fn().mockResolvedValue([
        { related_id: 'week-1', relationship_type: 'sprint' },
        { related_id: 'blocker-1', relationship_type: 'blocks' },
      ]),
    });

    const candidates = await buildCandidatesFromDocument(client, doc({ title: 'Implement burndown chart' }), 1);

    const week = candidates.find((c) => c.documentId === 'week-1');
    expect(week).toMatchObject({ edgeType: 'sprint_forward', hop: 1, sourceDocumentId: 'doc-1' });
    expect(week?.reason).toBe('is the week "Implement burndown chart" belongs to');

    const blocker = candidates.find((c) => c.documentId === 'blocker-1');
    expect(blocker).toMatchObject({ edgeType: 'blocks_forward' });
    expect(blocker?.reason).toBe('is blocked by "Implement burndown chart"');
  });

  it('classifies reverse associations — a blocking issue reads as "blocks" the source', async () => {
    const client = fakeClient({
      getReverseAssociations: vi.fn().mockResolvedValue([{ document_id: 'blocker-2', relationship_type: 'blocks' }]),
    });

    const candidates = await buildCandidatesFromDocument(client, doc({ title: 'Ship the release' }), 2);

    expect(candidates).toEqual([
      {
        documentId: 'blocker-2',
        reason: 'blocks "Ship the release"',
        edgeType: 'blocks_reverse',
        hop: 2,
        sourceDocumentId: 'doc-1',
      },
    ]);
  });

  it('gives an unrecognized relationship_type a generic, still-reasoned candidate rather than dropping it', async () => {
    const client = fakeClient({
      getAssociations: vi.fn().mockResolvedValue([{ related_id: 'future-1', relationship_type: 'depends_on' }]),
    });

    const candidates = await buildCandidatesFromDocument(client, doc({ title: 'X' }), 1);

    expect(candidates[0]).toMatchObject({ edgeType: 'unknown', reason: 'is related to "X" (depends_on)' });
  });

  it('surfaces backlinks as "mentions" candidates', async () => {
    const client = fakeClient({
      getBacklinks: vi.fn().mockResolvedValue([{ id: 'mentioner-1', document_type: 'wiki', title: 'Runbook' }]),
    });

    const candidates = await buildCandidatesFromDocument(client, doc({ title: 'Outage postmortem' }), 1);

    expect(candidates).toEqual([
      { documentId: 'mentioner-1', reason: 'mentions "Outage postmortem"', edgeType: 'backlink', hop: 1, sourceDocumentId: 'doc-1' },
    ]);
  });

  it('adds a bounded slice of the assignee\'s other issues, excluding the document itself', async () => {
    const getIssuesByAssignee = vi.fn().mockResolvedValue([
      { id: 'doc-1', title: 'self', state: 'todo', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'other-1', title: 'Other work', state: 'in_progress', updated_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const client = fakeClient({ getIssuesByAssignee });

    const candidates = await buildCandidatesFromDocument(
      client,
      doc({ id: 'doc-1', document_type: 'issue', properties: { assignee_id: 'user-emma' } }),
      1,
      { assigneeCandidateLimit: 7 }
    );

    expect(getIssuesByAssignee).toHaveBeenCalledWith('user-emma', 7);
    expect(candidates).toEqual([{ documentId: 'other-1', reason: expect.any(String), edgeType: 'assignee_other_work', hop: 1, sourceDocumentId: 'doc-1' }]);
  });

  it('never calls getIssuesByAssignee for a non-issue document or one with no assignee', async () => {
    const getIssuesByAssignee = vi.fn();
    const client = fakeClient({ getIssuesByAssignee });

    await buildCandidatesFromDocument(client, doc({ document_type: 'sprint', properties: {} }), 1);
    await buildCandidatesFromDocument(client, doc({ document_type: 'issue', properties: {} }), 1);

    expect(getIssuesByAssignee).not.toHaveBeenCalled();
  });
});

describe('buildCitedSources', () => {
  it('is a 1:1 projection of expandedDocuments — every pulled-in document is cited', () => {
    const expanded: ExpandedDocument[] = [
      { documentId: 'a', documentType: 'issue', title: 'A', reason: 'seed', hop: 0, textSnippet: '', commentSnippets: [] },
      { documentId: 'b', documentType: 'sprint', title: 'Week 1', reason: 'its week', hop: 1, textSnippet: '', commentSnippets: [] },
    ];

    expect(buildCitedSources(expanded)).toEqual([
      { documentId: 'a', documentType: 'issue', title: 'A', reason: 'seed' },
      { documentId: 'b', documentType: 'sprint', title: 'Week 1', reason: 'its week' },
    ]);
  });
});

describe('fetchCommentSnippets', () => {
  it('returns the most recent comments first, limited and truncated', async () => {
    const client = {
      getComments: vi.fn().mockResolvedValue([
        comment({ id: '1', content: 'oldest', created_at: '2026-01-01T00:00:00.000Z' }),
        comment({ id: '2', content: 'x'.repeat(300), created_at: '2026-01-03T00:00:00.000Z' }),
        comment({ id: '3', content: 'middle', created_at: '2026-01-02T00:00:00.000Z' }),
      ]),
    };

    const snippets = await fetchCommentSnippets(client, 'doc-1', 2);

    expect(snippets).toHaveLength(2);
    const [first, second] = snippets;
    expect(first).toMatch(/^Emma Johnson: x+…$/);
    expect(first?.length).toBeLessThan(300);
    expect(second).toBe('Emma Johnson: middle');
  });

  it('never throws — a failed comments fetch is treated as no evidence', async () => {
    const client = { getComments: vi.fn().mockRejectedValue(new Error('502')) };

    await expect(fetchCommentSnippets(client, 'doc-1')).resolves.toEqual([]);
  });
});

describe('extractPlainText', () => {
  it('walks a TipTap document and joins text nodes', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
      ],
    };

    expect(extractPlainText(content)).toBe('Hello world Second line');
  });

  it('truncates long content with an ellipsis', () => {
    const content = { type: 'doc', content: [{ type: 'text', text: 'a'.repeat(500) }] };

    const text = extractPlainText(content, 50);

    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBe(51);
  });

  it('returns an empty string for null/non-document content rather than throwing', () => {
    expect(extractPlainText(null)).toBe('');
    expect(extractPlainText(undefined)).toBe('');
    expect(extractPlainText('not an object')).toBe('');
  });
});

describe('buildExpansionPrompt', () => {
  it('names every expanded document with its reason, content and comments', () => {
    const expanded: ExpandedDocument[] = [
      {
        documentId: 'seed',
        documentType: 'issue',
        title: 'Implement burndown chart',
        reason: 'the document you had open',
        hop: 0,
        textSnippet: 'Burndown chart is stuck.',
        commentSnippets: [],
      },
      {
        documentId: 'week',
        documentType: 'sprint',
        title: 'Week 14',
        reason: 'is the week "Implement burndown chart" belongs to',
        hop: 1,
        textSnippet: '',
        commentSnippets: ['Emma Johnson: making progress'],
      },
    ];

    const prompt = buildExpansionPrompt('  Why is this stalled?  ', expanded);

    expect(prompt).toContain('Question: Why is this stalled?');
    expect(prompt).toContain('[1] issue "Implement burndown chart" — pulled in because: the document you had open');
    expect(prompt).toContain('content: Burndown chart is stuck.');
    expect(prompt).toContain('[2] sprint "Week 14" — pulled in because: is the week "Implement burndown chart" belongs to');
    expect(prompt).toContain('comment — Emma Johnson: making progress');
  });

  it('says plainly that nothing could be resolved when expandedDocuments is empty, rather than guessing', () => {
    const prompt = buildExpansionPrompt('What is going on?', []);

    expect(prompt).toContain('No accessible document could be resolved');
    expect(prompt).not.toContain('[1]');
  });
});

describe('capNoticeText', () => {
  it('names the configured cap', () => {
    expect(capNoticeText(12)).toContain('12-document limit');
  });
});

describe('visitDocument', () => {
  it('returns the record and raw doc on success, with comment snippets attached', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(doc({ id: 'week-1', document_type: 'sprint', title: 'Week 14' })),
      getComments: vi.fn().mockResolvedValue([comment({ content: 'on track' })]),
    });

    const result = await visitDocument(client, 'week-1', { reason: 'its week', hop: 1 }, 'user-emma');

    expect(result?.doc.id).toBe('week-1');
    expect(result?.record).toEqual({
      documentId: 'week-1',
      documentType: 'sprint',
      title: 'Week 14',
      reason: 'its week',
      hop: 1,
      textSnippet: '',
      commentSnippets: ['Emma Johnson: on track'],
    });
  });

  it('returns undefined, never throws, when getDocument fails (gone or not visible to this token)', async () => {
    const client = fakeClient({ getDocument: vi.fn().mockRejectedValue(new Error('404')) });

    await expect(visitDocument(client, 'missing', { reason: 'r', hop: 1 }, 'user-1')).resolves.toBeUndefined();
  });

  it('returns undefined when the document is fetched but fails the asker-visibility re-check', async () => {
    const client = fakeClient({
      getDocument: vi.fn().mockResolvedValue(doc({ visibility: 'private', created_by: 'someone-else' })),
    });

    const result = await visitDocument(client, 'private-doc', { reason: 'r', hop: 1 }, 'asker-user');

    expect(result).toBeUndefined();
  });
});

describe('passesAskerVisibility', () => {
  it('passes any document when no askingUserId is supplied (server-side 404 is the only gate wired so far)', () => {
    expect(passesAskerVisibility(doc({ visibility: 'private', created_by: 'someone-else' }), undefined)).toBe(true);
  });

  it('passes a workspace-visible document for any asker', () => {
    expect(passesAskerVisibility(doc({ visibility: 'workspace' }), 'asker-1')).toBe(true);
  });

  it('passes a private document for its own creator', () => {
    expect(passesAskerVisibility(doc({ visibility: 'private', created_by: 'asker-1' }), 'asker-1')).toBe(true);
  });

  it('fails a private document for anyone else', () => {
    expect(passesAskerVisibility(doc({ visibility: 'private', created_by: 'someone-else' }), 'asker-1')).toBe(false);
  });
});
