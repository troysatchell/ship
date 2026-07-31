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

    // TRO-296: this used to NOT be a plain `toEqual(original)`. `jsonToYjs`
    // writes marks via Yjs's native `YXmlText.format()`, and `yjsToJson`'s
    // read side used to call `YXmlText.toString()`, which serializes
    // format-delta attributes back as literal pseudo-XML wrapped around the
    // text (node_modules/yjs/src/types/YXmlText.js's `toString()`) instead of
    // a TipTap `marks` array — `bold` text round-tripped as the literal
    // string `<bold>bold</bold>`. `yjsToJson` now decodes `.toDelta()`
    // directly instead, so the round trip is symmetric: a plain `toEqual`
    // against the original document.
    expect(roundTripped).toEqual(original);
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

/**
 * TRO-296 — reachability.
 *
 * The finding was filed as "observed at function level, not via live app":
 * calling `jsonToYjs` then `yjsToJson` directly (the test above) proves the
 * two functions disagree with each other, but not that a real editing
 * session ever produces the shape that trips the disagreement.
 *
 * Traced (not assumed) via the actual dependency shipped in this repo's
 * `node_modules`, not documentation: the live collaborative editor never
 * calls this file's `jsonToYjs` for a user's keystrokes. TipTap's
 * `@tiptap/extension-collaboration` delegates to `y-prosemirror`, and
 * `y-prosemirror/src/plugins/sync-plugin.js`'s `createTypeFromTextNodes`
 * builds each run of a paragraph's inline content as one `Y.XmlText` and
 * calls `.applyDelta([{ insert, attributes: marksToAttributes(node.marks, meta) }])`
 * — Yjs's native text-formatting API, the same one this converter's
 * `jsonToYjs` calls via `.format()`. `YXmlText.toString()`
 * (`yjs/src/types/YXmlText.js:68-100`) serializes both identically, so
 * `yjsToJson`'s bug fires on ANY live-typed mark, not only on content that
 * happened to pass through `jsonToYjs`.
 *
 * `jsonToYjs` itself IS also live-reachable, just on a narrower path:
 * `collaboration/index.ts`'s `loadDoc()` calls it once, the first time a
 * document with JSON `content` but no `yjs_state` yet is opened in the
 * collaborative editor (documents created via `PATCH /:id/content`, which
 * explicitly nulls `yjs_state`, or seeded content like
 * `api/src/db/welcomeDocument.ts`'s "Welcome to Ship" document — which uses
 * `bold`/`italic` marks throughout). `persistDocument()` then writes the
 * `yjsToJson(fragment)` result back into `documents.content` ~2 seconds
 * later, on every edit for the life of the document.
 *
 * The test below reproduces the LIVE-EDITOR path specifically: it builds the
 * Yjs tree the way `createTypeFromTextNodes` does (`Y.XmlText.applyDelta`
 * with mark attributes), never calling this converter's own `jsonToYjs` at
 * all, then runs the real `yjsToJson` against it — proving the bug is not an
 * artifact of this converter's own writer.
 */
describe('yjsToJson decodes marks the live editor actually writes (TRO-296)', () => {
  it('reconstructs marks from a Y.XmlText built via applyDelta(), mirroring y-prosemirror\'s live binding (not this converter\'s jsonToYjs)', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const paragraph = new Y.XmlElement('paragraph');
    fragment.push([paragraph]);

    // Mirrors y-prosemirror's `createTypeFromTextNodes`
    // (y-prosemirror/src/plugins/sync-plugin.js): one Y.XmlText per run,
    // `.applyDelta()` carrying each run's marks as `attributes`. This is
    // exactly what fires when a real user selects text and clicks Bold, or
    // types over a link, in the live browser editor.
    const text = new Y.XmlText();
    paragraph.push([text]);
    text.applyDelta([
      { insert: 'Some ' },
      { insert: 'bold', attributes: { bold: {} } },
      { insert: ' and ' },
      { insert: 'a link', attributes: { link: { href: 'https://example.com', target: '_blank' } } },
      { insert: '.' },
    ]);

    const result = yjsToJson(fragment);

    expect(result).toEqual({
      type: 'doc',
      content: [
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
      ],
    });
  });

  it('drops a delta-attribute mark type this converter does not recognize, rather than corrupting the surrounding text', () => {
    // TipTap's custom `commentMark` (web/src/components/editor/CommentMark.ts)
    // is a genuine ProseMirror mark, so a live comment on selected text would
    // reach the Y.Doc via this exact same applyDelta mechanism — but it isn't
    // in this file's MARK_TYPES, so it isn't reconstructed. That is a
    // pre-existing limitation of this converter (comments are not part of
    // TRO-296's scope), not something this fix introduces; documented here so
    // the "unrecognized mark" behavior is a defined outcome (drop the mark,
    // keep the text) rather than an accident.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const text = new Y.XmlText();
    fragment.push([text]);
    text.applyDelta([{ insert: 'flagged', attributes: { commentMark: { commentId: 'abc-123' } } }]);

    const result = yjsToJson(fragment);

    expect(result).toEqual({
      type: 'doc',
      content: [{ type: 'text', text: 'flagged' }],
    });
  });

  it('strips y-prosemirror\'s overlapping-mark hash suffix from a delta attribute key', () => {
    // y-prosemirror hashes the delta-attribute key (`markname--<8 chars>`) for
    // a mark type configured to allow overlapping instances of itself
    // (`marksToAttributes`'s `isOverlapping`, y-prosemirror/src/plugins/sync-plugin.js).
    // None of this app's marks are configured that way today, so this exact
    // key shape is derived from reading y-prosemirror's source, not observed
    // against this app's live schema — asserted here defensively so a future
    // schema change can't silently make a mark vanish.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const text = new Y.XmlText();
    fragment.push([text]);
    text.applyDelta([{ insert: 'italic', attributes: { 'italic--Ab12cD3=': {} } }]);

    const result = yjsToJson(fragment);

    expect(result).toEqual({
      type: 'doc',
      content: [{ type: 'text', text: 'italic', marks: [{ type: 'italic' }] }],
    });
  });
});
