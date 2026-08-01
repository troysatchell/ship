import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';

// Declared with the promise-returning signature: `vi.mocked(pool.query)` resolves to
// pg's callback overload, whose return type is `void`, forcing a cast on every mocked
// result and switching off checking of the row shapes these tests assert about
// (confirmed directly against this repo's `tsc` — see routes/iterations.test.ts / TRO-213).
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(),
}));

// Mock pool before importing the module
vi.mock('../db/client.js', () => ({
  pool: {
    query: queryMock,
  },
}));

import { transformIssueLinks } from '../utils/transformIssueLinks.js';
import { pgResult } from '../test/pg-result.js';

/**
 * `transformIssueLinks` deliberately returns `Promise<unknown>` (its real source type,
 * `api/src/utils/transformIssueLinks.ts:206`) since it accepts arbitrary TipTap JSON.
 * This test file's assertions rely on a specific shape (TipTap doc nodes with optional
 * `marks`/`attrs`), which the source's own internal `TipTapNode`/`TipTapDoc` interfaces
 * are not exported for reuse. A single `as TransformedDoc` assertion off of `unknown`
 * (not `as unknown as X` — the source type already is `unknown`, so this needs no
 * intermediate hop) gives every property access below real checking instead of `as any`
 * silently accepting a typo'd field name.
 */
interface TransformedNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: TransformedNode[];
}
interface TransformedDoc {
  type: 'doc';
  content: TransformedNode[];
}

describe('transformIssueLinks', () => {
  const workspaceId = 'test-workspace-id';

  beforeEach(() => {
    // resetAllMocks, not the clear-only variant: clearing mocks leaves unconsumed
    // mockResolvedValueOnce values queued, which leak into later tests
    // (TRO-277 / TEST-12).
    vi.resetAllMocks();
  });

  describe('pattern matching and transformation', () => {
    it('transforms #123 pattern to clickable link', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'See #42 for details' }],
          },
        ],
      };

      // Mock issue lookup
      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-42', ticket_number: 42 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      expect(result.content[0]?.content).toHaveLength(3);
      expect(result.content[0]?.content?.[0]).toEqual({ type: 'text', text: 'See ' });
      expect(result.content[0]?.content?.[1]).toEqual({
        type: 'text',
        text: '#42',
        marks: [
          {
            type: 'link',
            attrs: {
              href: '/issues/issue-uuid-42',
              target: '_self',
            },
          },
        ],
      });
      expect(result.content[0]?.content?.[2]).toEqual({ type: 'text', text: ' for details' });
    });

    it('transforms "issue #123" pattern to clickable link', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Fixed in issue #100' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-100', ticket_number: 100 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      expect(result.content[0]?.content?.[1]).toEqual({
        type: 'text',
        text: 'issue #100',
        marks: [
          {
            type: 'link',
            attrs: {
              href: '/issues/issue-uuid-100',
              target: '_self',
            },
          },
        ],
      });
    });

    it('transforms "ISS-123" pattern to clickable link', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Related to ISS-500' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-500', ticket_number: 500 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      expect(result.content[0]?.content?.[1]).toEqual({
        type: 'text',
        text: 'ISS-500',
        marks: [
          {
            type: 'link',
            attrs: {
              href: '/issues/issue-uuid-500',
              target: '_self',
            },
          },
        ],
      });
    });

    it('transforms multiple issue references in same text', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'See #10, #20, and issue #30' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([
          { id: 'issue-uuid-10', ticket_number: 10 },
          { id: 'issue-uuid-20', ticket_number: 20 },
          { id: 'issue-uuid-30', ticket_number: 30 },
        ]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      // Should split into multiple text nodes with links
      const nodes = result.content[0]?.content ?? [];
      expect(nodes.some((n) => n.text === '#10' && n.marks)).toBe(true);
      expect(nodes.some((n) => n.text === '#20' && n.marks)).toBe(true);
      expect(nodes.some((n) => n.text === 'issue #30' && n.marks)).toBe(true);
    });

    it('queries database for all unique ticket numbers', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '#1 and #2 and #3' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([]));

      await transformIssueLinks(content, workspaceId);

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('ticket_number = ANY'),
        [workspaceId, expect.arrayContaining([1, 2, 3])]
      );
    });

    it('deduplicates ticket numbers in query', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '#5 and #5 and #5' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([]));

      await transformIssueLinks(content, workspaceId);

      const queryArgs = queryMock.mock.calls[0]![1];
      const ticketNumbers = queryArgs?.[1];

      // Should only query for #5 once despite appearing multiple times
      expect(ticketNumbers).toEqual([5]);
    });
  });

  describe('edge cases', () => {
    it('does not transform text that already has marks', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '#99 is already a link',
                marks: [{ type: 'link', attrs: { href: '/somewhere' } }],
              },
            ],
          },
        ],
      };

      // Mock database lookup (implementation still queries even for marked text)
      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-99', ticket_number: 99 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      // Should not transform already marked text
      expect(result.content[0]?.content?.[0]).toEqual({
        type: 'text',
        text: '#99 is already a link',
        marks: [{ type: 'link', attrs: { href: '/somewhere' } }],
      });

      // Note: Implementation does query database for ticket numbers,
      // but doesn't transform text that already has marks
      expect(queryMock).toHaveBeenCalled();
    });

    it('keeps issue reference as plain text when issue does not exist', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Non-existent #999' }],
          },
        ],
      };

      // No matching issues found
      queryMock.mockResolvedValueOnce(pgResult([]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      // When no issues are found, content is returned unchanged
      // (implementation optimization - doesn't transform if issueMap is empty)
      expect(result).toEqual(content);
      expect(result.content[0]?.content?.[0]?.text).toBe('Non-existent #999');
      expect(result.content[0]?.content?.[0]?.marks).toBeUndefined();
    });

    it('transforms existing issues but not non-existent ones', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'See #50 and #999' }],
          },
        ],
      };

      // Only #50 exists
      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-50', ticket_number: 50 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      const nodes = result.content[0]?.content ?? [];

      // #50 should have link mark
      const link50 = nodes.find((n) => n.text === '#50');
      expect(link50?.marks).toBeDefined();

      // #999 should be plain text (no marks)
      const text999 = nodes.find((n) => n.text === '#999');
      expect(text999?.marks).toBeUndefined();
    });

    it('returns unchanged content when no issue patterns found', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'No issue references here' }],
          },
        ],
      };

      const result = await transformIssueLinks(content, workspaceId);

      // Should not query database
      expect(queryMock).not.toHaveBeenCalled();

      // Should return unchanged
      expect(result).toEqual(content);
    });

    it('returns unchanged content for invalid input', async () => {
      expect(await transformIssueLinks(null, workspaceId)).toBeNull();
      expect(await transformIssueLinks(undefined, workspaceId)).toBeUndefined();
      expect(await transformIssueLinks('string', workspaceId)).toBe('string');
      expect(await transformIssueLinks(123, workspaceId)).toBe(123);
    });

    it('returns unchanged content when not a doc type', async () => {
      const content = {
        type: 'paragraph',
        content: [{ type: 'text', text: '#123' }],
      };

      const result = await transformIssueLinks(content, workspaceId);
      expect(result).toEqual(content);
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('handles empty document content', async () => {
      const content = {
        type: 'doc',
        content: [],
      };

      const result = await transformIssueLinks(content, workspaceId);
      expect(result).toEqual(content);
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe('nested content structures', () => {
    it('transforms issue links in nested paragraphs', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Item with #25' }],
                  },
                ],
              },
            ],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-25', ticket_number: 25 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      const paragraph = result.content[0]?.content?.[0]?.content?.[0];
      const link = paragraph?.content?.find((n) => n.text === '#25');
      expect(link?.marks).toBeDefined();
      expect(link?.marks?.[0]?.attrs?.href).toBe('/issues/issue-uuid-25');
    });

    it('transforms issue links in blockquotes', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Quoted text with issue #77' }],
              },
            ],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([{ id: 'issue-uuid-77', ticket_number: 77 }]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      const paragraph = result.content[0]?.content?.[0];
      const link = paragraph?.content?.find((n) => n.text === 'issue #77');
      expect(link?.marks).toBeDefined();
    });

    it('recursively transforms all nested issue references', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Top level #1' }],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Nested #2' }],
                  },
                ],
              },
            ],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([
          { id: 'issue-uuid-1', ticket_number: 1 },
          { id: 'issue-uuid-2', ticket_number: 2 },
        ]));

      await transformIssueLinks(content, workspaceId);

      // Should find both #1 and #2
      expect(queryMock).toHaveBeenCalledWith(
        expect.anything(),
        [workspaceId, expect.arrayContaining([1, 2])]
      );
    });
  });

  describe('workspace isolation', () => {
    it('only looks up issues in the specified workspace', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '#123' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([]));

      await transformIssueLinks(content, workspaceId);

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('workspace_id = $1'),
        [workspaceId, [123]]
      );
    });

    it('does not transform issues from other workspaces', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '#888' }],
          },
        ],
      };

      // Issue exists but in different workspace
      queryMock.mockResolvedValueOnce(pgResult([]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      // Should remain plain text
      const textNode = result.content[0]?.content?.[0];
      expect(textNode?.marks).toBeUndefined();
    });
  });

  describe('case variations', () => {
    it('handles "issue #" with various casings', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Issue #5 and ISSUE #6' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([
          { id: 'issue-uuid-5', ticket_number: 5 },
          { id: 'issue-uuid-6', ticket_number: 6 },
        ]));

      const result = (await transformIssueLinks(content, workspaceId)) as TransformedDoc;

      const nodes = result.content[0]?.content ?? [];

      // Both should be transformed
      expect(nodes.some((n) => n.text === 'Issue #5' && n.marks)).toBe(true);
      expect(nodes.some((n) => n.text === 'ISSUE #6' && n.marks)).toBe(true);
    });
  });

  describe('performance considerations', () => {
    it('does not query database when no patterns detected', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Just normal text without issue refs' }],
          },
        ],
      };

      const result = await transformIssueLinks(content, workspaceId);

      // Should not query when no issue patterns found
      expect(queryMock).not.toHaveBeenCalled();

      // Should return unchanged content
      expect(result).toEqual(content);
    });

    it('makes single batch query for multiple issues', async () => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '#1 #2 #3 #4 #5' }],
          },
        ],
      };

      queryMock.mockResolvedValueOnce(pgResult([]));

      await transformIssueLinks(content, workspaceId);

      // Should make exactly one query for all issues
      expect(queryMock).toHaveBeenCalledTimes(1);
    });
  });
});
