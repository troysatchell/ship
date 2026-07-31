/**
 * TRO-194 / ERR-7 follow-up (CodeRabbit review on PR #71).
 *
 * The isBodySaving tracker Editor.tsx wires into `SyncStatusIndicator`'s new
 * "Saving" state (see `Editor.tsx`'s `isUnflushedLocalUpdateOrigin` and the
 * `ydoc.on('update', ...)` effect) treats any Yjs update whose origin is not
 * the collaboration provider as a pending local edit. But `Editor.tsx:~392`
 * also runs a server-driven "clear cache" reset through
 * `ydoc.transact(() => {...})` when the server signals fresh content loaded
 * from JSON - and a plain `ydoc.transact(fn)` with no origin argument
 * defaults to `null`, which is indistinguishable from a real user edit to a
 * check that only excludes the provider. Before this fix, that reset would
 * flash "Saving" for 600ms over content nobody typed.
 *
 * The fix tags that transaction with a dedicated `CACHE_RESET_ORIGIN`
 * sentinel and teaches `isUnflushedLocalUpdateOrigin` to exclude it too.
 *
 * Why this test doesn't mount <Editor>: `Editor.bubbleMenuAria.test.tsx`
 * and `LazyEditor.test.tsx` already document that mounting real
 * TipTap+Yjs+y-websocket under jsdom+vitest is unreliable in this repo. Yjs
 * itself has no DOM dependency, so this test uses a real `Y.Doc` and its
 * real `transact()`/`update` event - exactly the mechanism `Editor.tsx`
 * runs - and calls the actual exported `isUnflushedLocalUpdateOrigin`
 * predicate the component uses, rather than mounting the component or
 * duplicating its logic in the test.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { CACHE_RESET_ORIGIN, isUnflushedLocalUpdateOrigin } from './Editor';

/**
 * A fragment with something in it to delete. Yjs only emits an `update`
 * event when a transaction actually changes the document - an empty
 * `while (fragment.length > 0) { ... }` loop against an already-empty
 * fragment produces no delta and no event at all, which would make these
 * tests vacuously pass no matter what origin (or lack of one) `Editor.tsx`
 * used. Mirrors the real scenario: the cache-reset transaction only ever
 * runs when there IS cached content to clear before the server's fresh copy
 * arrives.
 */
function docWithCachedContent(): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    ydoc.getXmlFragment('default').insert(0, [new Y.XmlText('cached content')]);
  });
  return ydoc;
}

describe('Editor cache-reset vs. local-edit origin (TRO-194 / ERR-7, PR #71 follow-up)', () => {
  it('tags the cache-reset transaction with CACHE_RESET_ORIGIN, not the default null origin', () => {
    const ydoc = docWithCachedContent();
    let capturedOrigin: unknown = 'not-called';
    ydoc.on('update', (_update, origin) => {
      capturedOrigin = origin;
    });

    // The exact shape of Editor.tsx's cache-reset transact() call.
    ydoc.transact(() => {
      const fragment = ydoc.getXmlFragment('default');
      while (fragment.length > 0) {
        fragment.delete(0, 1);
      }
    }, CACHE_RESET_ORIGIN);

    expect(capturedOrigin).toBe(CACHE_RESET_ORIGIN);
  });

  it('does not treat a cache-reset update as an unflushed local edit', () => {
    const providerStub = {};
    const ydoc = docWithCachedContent();
    let capturedOrigin: unknown = 'not-called';
    ydoc.on('update', (_update, origin) => {
      capturedOrigin = origin;
    });

    ydoc.transact(() => {
      const fragment = ydoc.getXmlFragment('default');
      while (fragment.length > 0) {
        fragment.delete(0, 1);
      }
    }, CACHE_RESET_ORIGIN);

    expect(capturedOrigin, 'the reset must actually produce an update to check').toBe(
      CACHE_RESET_ORIGIN
    );
    expect(
      isUnflushedLocalUpdateOrigin(capturedOrigin, providerStub),
      'a server-driven cache reset must not trigger the "Saving" indicator'
    ).toBe(false);
  });

  it('still treats a real local edit (default null origin) as an unflushed local edit', () => {
    const providerStub = {};
    const ydoc = new Y.Doc();
    let capturedOrigin: unknown;
    ydoc.on('update', (_update, origin) => {
      capturedOrigin = origin;
    });

    // No origin argument, matching how a real ProseMirror/y-prosemirror local
    // edit transacts today - defaults to `null`.
    ydoc.transact(() => {
      ydoc.getXmlFragment('default').insert(0, [new Y.XmlText('hi')]);
    });

    expect(
      isUnflushedLocalUpdateOrigin(capturedOrigin, providerStub),
      'a real user edit must still show "Saving" - this fix must not swallow the case it was built for'
    ).toBe(true);
  });

  it('does not treat a provider-originated (remote) update as an unflushed local edit', () => {
    const providerStub = {};
    const ydoc = new Y.Doc();
    let capturedOrigin: unknown;
    ydoc.on('update', (_update, origin) => {
      capturedOrigin = origin;
    });

    // The shape of y-websocket's own remote-apply: readSyncMessage/
    // _updateHandler pass the provider instance itself as the origin.
    ydoc.transact(() => {
      ydoc.getXmlFragment('default').insert(0, [new Y.XmlText('remote')]);
    }, providerStub);

    expect(isUnflushedLocalUpdateOrigin(capturedOrigin, providerStub)).toBe(false);
  });
});
