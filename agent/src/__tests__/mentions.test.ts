import { describe, expect, it } from 'vitest';
import { extractLiteralNameMentions, extractPersonMentionDocIds } from '../mentions.js';

describe('extractPersonMentionDocIds', () => {
  it('finds a person mention node nested inside a real TipTap document shape', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hey ' },
            { type: 'mention', attrs: { id: 'person-alice', label: 'Alice Chen', mentionType: 'person' } },
            { type: 'text', text: ', can you take a look?' },
          ],
        },
      ],
    };

    expect(extractPersonMentionDocIds(content)).toEqual(['person-alice']);
  });

  it('finds multiple mentions across multiple blocks', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a', mentionType: 'person' } }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'b', mentionType: 'person' } }] },
      ],
    };

    expect(extractPersonMentionDocIds(content)).toEqual(['a', 'b']);
  });

  it('treats a mention with no explicit mentionType as a person mention (MentionExtension default)', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a' } }] }],
    };

    expect(extractPersonMentionDocIds(content)).toEqual(['a']);
  });

  it('ignores a document-type mention (mentionType: "document")', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'wiki-1', mentionType: 'document' } }] },
      ],
    };

    expect(extractPersonMentionDocIds(content)).toEqual([]);
  });

  it('returns [] for null/malformed content rather than throwing', () => {
    expect(extractPersonMentionDocIds(null)).toEqual([]);
    expect(extractPersonMentionDocIds(undefined)).toEqual([]);
    expect(extractPersonMentionDocIds('not a doc')).toEqual([]);
    expect(extractPersonMentionDocIds({ type: 'doc' })).toEqual([]);
  });

  it('returns [] for a plain paragraph document with no mentions', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nothing to see here' }] }],
    };
    expect(extractPersonMentionDocIds(content)).toEqual([]);
  });
});

describe('extractLiteralNameMentions', () => {
  const people = [
    { id: 'person-alice', name: 'Alice Chen' },
    { id: 'person-emma', name: 'Emma Johnson' },
  ];

  it('matches the exact FG-3 fixture comment text (testCase2_mention1)', () => {
    const text = "Hey @Alice Chen, can you weigh in on this before we ship? Wasn't sure who owns the final call.";
    expect(extractLiteralNameMentions(text, people)).toEqual(['person-alice']);
  });

  it('matches the second FG-3 fixture comment text (testCase2_mention2)', () => {
    const text = "@Alice Chen flagging this in case it affects your team's timeline — no action needed yet, just visibility.";
    expect(extractLiteralNameMentions(text, people)).toEqual(['person-alice']);
  });

  it('matches multiple distinct people mentioned in the same comment', () => {
    const text = '@Alice Chen and @Emma Johnson should both weigh in.';
    const matched = extractLiteralNameMentions(text, people);
    expect(matched).toContain('person-alice');
    expect(matched).toContain('person-emma');
    expect(matched).toHaveLength(2);
  });

  it('does not match a name mentioned without the leading @', () => {
    const text = 'Alice Chen already knows about this.';
    expect(extractLiteralNameMentions(text, people)).toEqual([]);
  });

  it('does not duplicate a match when the same name appears twice', () => {
    const text = '@Alice Chen — also cc @Alice Chen on the follow-up.';
    expect(extractLiteralNameMentions(text, people)).toEqual(['person-alice']);
  });

  it('returns [] for empty text', () => {
    expect(extractLiteralNameMentions('', people)).toEqual([]);
  });

  it('skips directory entries with a blank name rather than matching everything', () => {
    const withBlank = [...people, { id: 'person-pending', name: '' }];
    expect(extractLiteralNameMentions('no mentions here', withBlank)).toEqual([]);
  });
});
