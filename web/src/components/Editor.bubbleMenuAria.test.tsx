/**
 * TRO-216 / A11Y-2 regression test: the comment `<BubbleMenu>` in Editor.tsx
 * (~line 1008) must never leave an invalid `aria-expanded` on the plain
 * `<div>` that `@tiptap/react`'s `<EditorContent>` renders under
 * `.tiptap-wrapper` to host the ProseMirror view.
 *
 * Mechanism (see the comment above `commentBubbleMenuTippyOptions` in
 * Editor.tsx for the full trace, and CHANGES.md for the PR-level summary):
 * `@tiptap/extension-bubble-menu`'s `BubbleMenuView.createTooltip()` (2.27.2,
 * node_modules/.pnpm/@tiptap+extension-bubble-menu@2.27.2.../dist/index.js:
 * 122-136) calls
 *
 *   tippy(editorElement, {
 *     duration: 0, getReferenceClientRect: null, content: this.element,
 *     interactive: true, trigger: 'manual', placement: 'top',
 *     hideOnClick: 'toggle', ...this.tippyOptions,
 *   })
 *
 * the first time the selection or doc changes after mount, where
 * `editorElement` is `editor.options.element` - the div `<EditorContent>`
 * renders, i.e. `.tiptap-wrapper > div` in the real app. tippy's default
 * `aria.expanded: 'auto'` combined with `interactive: true` makes it call
 * `referenceEl.setAttribute('aria-expanded', ...)` on that div unconditionally
 * (tippy.js's `handleAriaExpandedAttribute`,
 * node_modules/.pnpm/tippy.js@6.3.7/node_modules/tippy.js/dist/tippy.cjs.js:
 * 801-813) - even though the div has no role and isn't itself a disclosure
 * widget; it is only tippy's positioning anchor for the floating "Comment"
 * button. axe reported this as a Critical `aria-allowed-attr` violation on
 * `.tiptap-wrapper > div`.
 *
 * This test calls the same `tippy(...)` invocation directly, with the same
 * option merge order, against a stand-in `.tiptap-wrapper > div` element,
 * importing the real `commentBubbleMenuTippyOptions` from `./Editor` (not a
 * copy) so it tracks production configuration rather than a duplicate of it.
 *
 * Why not mount the real <BubbleMenu>/<EditorContent> and drive a real
 * selection change instead: `@tiptap/extension-bubble-menu` is not a direct
 * dependency of `web` (only reachable transitively through `@tiptap/react`),
 * and its prebuilt ESM bundle's own `import tippy from 'tippy.js'` does not
 * interop cleanly through vitest's module runner when reached via that nested
 * path - confirmed by direct experiment: importing `tippy` from `tippy.js`
 * directly in a test file resolves to the callable function, but rendering
 * the real `<BubbleMenu>` and triggering an update throws `tippy is not a
 * function` from inside that package's own bundle. That is a pre-existing
 * environment/interop limitation of this dependency chain under jsdom+vitest,
 * unrelated to this fix (LazyEditor.test.tsx documents the same class of
 * problem: "mounting real TipTap + Yjs in jsdom proves ... a great deal about
 * jsdom"). Calling the real, directly-imported `tippy` with the exact
 * production options exercises the actual library behaviour this fix
 * controls, without depending on that broken chain.
 */
import { describe, it, expect } from 'vitest';
import tippy from 'tippy.js';
import { commentBubbleMenuTippyOptions } from './Editor';

describe('Editor comment BubbleMenu ARIA (TRO-216 / A11Y-2)', () => {
  it('never sets aria-expanded on the .tiptap-wrapper > div reference element', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'tiptap-wrapper';
    document.body.appendChild(wrapper);

    // `.tiptap-wrapper > div` from the axe finding: the div <EditorContent>
    // renders, which becomes `editor.options.element` once mounted.
    const editorElement = document.createElement('div');
    wrapper.appendChild(editorElement);

    const bubbleContent = document.createElement('div');

    // `duration`/`placement` are deliberately left out of this base object -
    // `commentBubbleMenuTippyOptions` supplies both, exactly as it does in the
    // real merge, and a TS-flagged "specified more than once" would just be
    // asserting the overwrite that createTooltip() already relies on.
    tippy(editorElement, {
      getReferenceClientRect: null,
      content: bubbleContent,
      interactive: true,
      trigger: 'manual',
      hideOnClick: 'toggle',
      ...commentBubbleMenuTippyOptions,
    });

    expect(wrapper.querySelector(':scope > div')).toBe(editorElement);
    // The whole point of the fix: no aria-expanded at all on this plain div,
    // regardless of role - it never expands or collapses anything itself.
    expect(editorElement).not.toHaveAttribute('aria-expanded');
  });
});
