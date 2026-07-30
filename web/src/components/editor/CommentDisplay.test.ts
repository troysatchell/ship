import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CommentMark } from './CommentMark';
import { CommentDisplayExtension } from './CommentDisplay';

/**
 * TRO-193 (ERR-6) / TRO-227 (TEST-5) regression tests.
 *
 * `comment-highlight` is a TipTap Mark — document content (CommentMark.ts:69),
 * not a decoration — so once `addComment()` sets it, only an explicit
 * `unsetComment` removes it from the persisted (and Yjs-synced) doc.
 *
 * Before this fix, the only path that ever called `unsetComment` was Escape
 * landing on the pending input's own keydown handler
 * (CommentDisplay.tsx `handleDOMEvents.keydown`, previously ~line 322), which
 * requires the input to already have focus. The input is focused in a
 * `requestAnimationFrame` after the widget mounts (CommentDisplay.tsx:259-263)
 * — a real race (TEST-5, `e2e/inline-comments.spec.ts:118` failed both
 * attempts in `audit/test-quality/runs/e2e-run1-failures.txt`). Blur/outside
 * click had **no** handler at all (ERR-6, confirmed by
 * `audit/error-handling/raw/probe8-comment-orphan-blur.json`: mark persists
 * through reload with 0 backing comment rows).
 *
 * The fix moves ownership of "abandon a pending comment" into the
 * `commentDisplay` plugin's own `view()` lifecycle in CommentDisplay.tsx:
 * document-level capture listeners for Escape/mousedown/focusout gated only
 * on `storage.pendingCommentId` (never on the event's target or on focus
 * state), plus a `destroy()` that abandons any still-pending comment when the
 * editor itself goes away (unmount / a route change that recreates it).
 *
 * These tests drive the real `CommentMark` + `CommentDisplayExtension`
 * against a bare `@tiptap/core` `Editor` (the same pattern as
 * DetailsExtension.test.ts / MentionExtension.test.ts) with a thin stand-in
 * for the wiring Editor.tsx normally provides (comments state +
 * onSubmitComment/onCancelComment) — not a mock of the extension under test.
 */

const DOC_CONTENT = '<p>The quick brown fox jumps over the lazy dog.</p>';

/** `ext` can only be looked up once the editor exists, but `onAddComment`
 * below is configured as part of building that same editor — so the closure
 * re-resolves it (and guards it) itself, rather than depending on a narrowing
 * of the outer `const ext` that TypeScript cannot carry across closures. */
function findCommentDisplayExt(editor: Editor) {
  const found = editor.extensionManager.extensions.find((e) => e.name === 'commentDisplay');
  if (!found) throw new Error('commentDisplay extension not registered');
  return found;
}

function setupEditor() {
  const submitted = new Set<string>();
  let pendingCommentId: string | null = null;

  const editor = new Editor({
    extensions: [
      StarterKit,
      CommentMark.configure({
        onAddComment: (commentId) => {
          pendingCommentId = commentId;
          findCommentDisplayExt(editor).storage.pendingCommentId = commentId;
        },
      }),
      CommentDisplayExtension,
    ],
    content: DOC_CONTENT,
  });

  const ext = findCommentDisplayExt(editor);

  // The same two callbacks Editor.tsx wires up (Editor.tsx:731-738).
  ext.storage.onSubmitComment = (commentId: string) => {
    submitted.add(commentId);
    pendingCommentId = null;
    ext.storage.pendingCommentId = null;
  };
  ext.storage.onCancelComment = (commentId: string) => {
    if (submitted.has(commentId)) return; // already a real comment — never strip its mark
    editor.commands.unsetComment(commentId);
    pendingCommentId = null;
    ext.storage.pendingCommentId = null;
  };

  return {
    editor,
    ext,
    getPendingCommentId: () => pendingCommentId,
  };
}

/** Selects the entire text of the single-paragraph fixture doc. */
function selectAllText(editor: Editor) {
  const size = editor.state.doc.content.size;
  editor.commands.setTextSelection({ from: 1, to: size - 1 });
}

function hasCommentMark(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'commentMark')) {
      found = true;
    }
  });
  return found;
}

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
});

/** Mounts the editor's DOM into `document.body` (needed for real focus /
 * event-dispatch semantics) and registers teardown. */
function mount(editor: Editor) {
  document.body.appendChild(editor.view.dom);
  cleanupFns.push(() => {
    editor.view.dom.remove();
    if (!editor.isDestroyed) editor.destroy();
  });
}

describe('CommentDisplay pending-comment lifecycle (TRO-193 / TRO-227)', () => {
  it('unsets the mark when the pending comment is dismissed by clicking away (ERR-6)', () => {
    const { editor, ext } = setupEditor();
    mount(editor);

    selectAllText(editor);
    editor.commands.addComment();

    // Sanity: the mark and the pending state both exist before dismissal.
    expect(hasCommentMark(editor)).toBe(true);
    expect(ext.storage.pendingCommentId).not.toBeNull();

    // "Clicking away": a mousedown target that is not the pending widget, and
    // not itself interactive (a plain page element, not a control) — this
    // reproduces "dismissed by blur" without relying on a blur event ever
    // having fired, and without depending on any focus() call having happened.
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(hasCommentMark(editor)).toBe(false);
    expect(ext.storage.pendingCommentId).toBeNull();
  });

  it('unsets the mark when the pending input itself loses focus to something outside the widget (blur)', () => {
    const { editor, ext } = setupEditor();
    mount(editor);

    selectAllText(editor);
    editor.commands.addComment();
    editor.view.updateState(editor.view.state);

    const pendingInput = editor.view.dom.querySelector('.comment-pending-field');
    expect(pendingInput).toBeTruthy();

    const outside = document.createElement('div');
    document.body.appendChild(outside);

    // A genuine focusout on the pending input, moving focus to an element
    // outside the widget — this exercises the focusout listener directly
    // (mousedown alone does not prove focusout's own guard is correct: it
    // must fire for the *input* losing focus, not any editor descendant).
    pendingInput?.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: outside })
    );

    expect(hasCommentMark(editor)).toBe(false);
    expect(ext.storage.pendingCommentId).toBeNull();
  });

  it('unsets the mark when Escape is pressed before the pending input receives focus (TEST-5 race)', () => {
    const { editor, ext } = setupEditor();
    mount(editor);

    selectAllText(editor);
    editor.commands.addComment();

    // Force the decorations to recompute so the pending widget really mounts
    // (mirrors Editor.tsx's forced `editor.view.updateState` after committing
    // `pendingCommentId` to React state) — this is what schedules the
    // widget's `requestAnimationFrame(() => input.focus())`.
    editor.view.updateState(editor.view.state);

    const pendingInput = editor.view.dom.querySelector('.comment-pending-field');
    expect(pendingInput).toBeTruthy();

    // The race window TEST-5 hypothesized: the widget exists, but the rAF
    // that focuses it has not been flushed, so focus has not landed yet.
    expect(document.activeElement).not.toBe(pendingInput);

    // Dispatch Escape with focus still elsewhere (document.body) — this is
    // exactly what `page.keyboard.press('Escape')` does in
    // e2e/inline-comments.spec.ts:130: it sends the key to whatever currently
    // has focus, not to the (not-yet-focused) input.
    expect(document.activeElement).toBe(document.body);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(hasCommentMark(editor)).toBe(false);
    expect(ext.storage.pendingCommentId).toBeNull();
  });

  it('keeps the mark when a comment is submitted normally (happy path is not broken)', () => {
    const { editor, ext, getPendingCommentId } = setupEditor();
    mount(editor);

    selectAllText(editor);
    editor.commands.addComment();

    const commentId = getPendingCommentId();
    if (!commentId) throw new Error('addComment() did not produce a pending comment id');

    // Submit exactly the way CommentDisplay.tsx's Enter-key handler does.
    ext.storage.onSubmitComment?.(commentId, 'looks good');

    expect(hasCommentMark(editor)).toBe(true);
    expect(ext.storage.pendingCommentId).toBeNull();

    // A submitted comment is a real comment now — a later outside click or
    // Escape must never strip its mark. This is the other half of the
    // invariant: marks may only be removed for comments that were never
    // created.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(hasCommentMark(editor)).toBe(true);
  });

  it('unsets the mark when the editor is destroyed while a comment is still pending (route change / unmount)', () => {
    const { editor } = setupEditor();
    mount(editor);

    selectAllText(editor);
    editor.commands.addComment();
    expect(hasCommentMark(editor)).toBe(true);

    editor.destroy();

    // `editor.state` (view.state) is not cleared by destroy(), so this reads
    // the document as it stood at the moment destroy() finished — after the
    // plugin's own destroy() callback abandoned the still-pending comment.
    expect(hasCommentMark(editor)).toBe(false);
  });
});
