import { describe, it, expect, expectTypeOf } from 'vitest';
import * as Y from 'yjs';
import { yjsToJson, jsonToYjs, loadContentFromYjsState } from '../yjsConverter.js';
import type { TipTapDoc, TipTapNode } from '../../types/tiptap.js';

/**
 * TS-3 — the Yjs <-> TipTap converter is the persistence path for every
 * document's content (`collaboration/index.ts`'s `persistDocument()` and
 * `routes/documents.ts`'s content-over-REST reads both go through it) and it
 * used to be `any` end to end. This file has two independent jobs:
 *
 * 1. Prove the exported signatures are real types, not `any` (compile-time —
 *    these `expectTypeOf` assertions are checked by `tsc`/`vitest`'s type
 *    checker, not at runtime; see the PR description for the red-before-green
 *    proof against the unfixed signatures).
 * 2. Prove the type change didn't alter runtime behavior, by pinning an
 *    actual conversion round-trip.
 */
describe('yjsConverter exported signatures are typed (TS-3)', () => {
  it('yjsToJson does not return `any`', () => {
    expectTypeOf(yjsToJson).returns.not.toBeAny();
    expectTypeOf(yjsToJson).returns.toEqualTypeOf<TipTapDoc>();
  });

  it('jsonToYjs does not accept an untyped `content` parameter', () => {
    expectTypeOf(jsonToYjs).parameter(2).not.toBeAny();
    expectTypeOf(jsonToYjs).parameter(2).toEqualTypeOf<TipTapNode>();
  });

  it('loadContentFromYjsState does not return `any`', () => {
    expectTypeOf(loadContentFromYjsState).returns.not.toBeAny();
    expectTypeOf(loadContentFromYjsState).returns.toEqualTypeOf<TipTapDoc | null>();
  });
});

describe('yjsToJson / jsonToYjs round-trip (runtime behavior, pinned)', () => {
  it('preserves a heading, marked text, and a nested bullet list through JSON -> Yjs -> JSON', () => {
    // Representative document: a heading (numeric `level` attr), a paragraph
    // with bold text and a link mark, and a 2-item nested bullet list.
    const original: TipTapDoc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Some ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              text: 'a link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }],
            },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First item' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second item' }] }],
            },
          ],
        },
      ],
    };

    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    jsonToYjs(doc, fragment, original);

    const roundTripped = yjsToJson(fragment);

    // Not a plain `toEqual(original)`: `jsonToYjs` writes marks via Yjs's
    // native `YXmlText.format()`, and `YXmlText.toString()` (which
    // `yjsToJson`'s read side calls) serializes format-delta attributes back
    // as literal pseudo-XML wrapped around the text
    // (node_modules/yjs/src/types/YXmlText.js's `toString()`), not as a
    // TipTap `marks` array. That is a pre-existing quirk of this conversion
    // path, not something this ticket's types-only fix changes — pinned here
    // exactly as observed so a types refactor can't silently alter it.
    expect(roundTripped).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Some ' },
            { type: 'text', text: '<bold>bold</bold>' },
            { type: 'text', text: ' and ' },
            { type: 'text', text: '<link href="https://example.com" target="_blank">a link</link>' },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First item' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second item' }] }],
            },
          ],
        },
      ],
    });
  });

  it('round-trips through a binary Yjs update via loadContentFromYjsState', () => {
    const original: TipTapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain paragraph' }] }],
    };

    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    jsonToYjs(doc, fragment, original);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));

    const loaded = loadContentFromYjsState(state);

    if (!loaded) throw new Error('expected loadContentFromYjsState to return content, got null');
    expect(loaded).toEqual(original);
  });
});
