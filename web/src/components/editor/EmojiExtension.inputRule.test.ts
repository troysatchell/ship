import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EmojiExtension } from './EmojiExtension';

/**
 * CodeRabbit review finding on PR #46 (TRO-206 / TS-1): the emoji input-rule
 * handler mutated `state.tr` via `replaceWith` and then `return null;`.
 * Tiptap's InputRule runner (`@tiptap/core`'s `InputRule.ts`) checks
 * `if (handler === null || !tr.steps.length) return` — an explicit `null`
 * return skips `view.dispatch(tr)` regardless of whether the transaction has
 * steps queued. So the shortcode replacement was built but never applied:
 * typing `:smile:` left the literal text unchanged instead of becoming the
 * emoji character. This drives the input rule through the real Tiptap
 * plugin machinery (not a mocked handler) so it fails for the actual defect,
 * not an assumption about it.
 */
describe('EmojiExtension input rule (TRO-206 CodeRabbit fix)', () => {
  it('replaces :shortcode: with the emoji character once the closing colon is typed', () => {
    const editor = new Editor({
      extensions: [StarterKit, EmojiExtension],
      content: '<p>Hello :smile</p>',
    });

    const inputRulesPlugin = editor.view.state.plugins.find(
      (plugin) => (plugin.spec as { isInputRules?: boolean }).isInputRules === true
    );
    if (!inputRulesPlugin) {
      throw new Error('EmojiExtension did not register the Tiptap input-rules plugin');
    }
    expect(typeof inputRulesPlugin.props.handleTextInput).toBe('function');

    // Simulate the user typing the closing ':' that completes ":smile:".
    // `handleTextInput`'s 5th param is ProseMirror's fallback-transaction
    // factory; the input-rules plugin never calls it, but the signature
    // requires it. `.call` (rather than a detached reference) satisfies the
    // prop's declared `this: Plugin` parameter.
    const cursorPos = editor.view.state.doc.content.size - 1;
    const dispatched = inputRulesPlugin.props.handleTextInput?.call(
      inputRulesPlugin,
      editor.view,
      cursorPos,
      cursorPos,
      ':',
      () => editor.view.state.tr
    );

    expect(dispatched).toBe(true);
    expect(editor.getText()).toBe('Hello 😊 ');

    editor.destroy();
  });
});
