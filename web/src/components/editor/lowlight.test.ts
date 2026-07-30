import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { lowlight, SUPPORTED_CODE_LANGUAGES } from './lowlight';

/**
 * TRO-199 / BUN-3 — `Editor.tsx` built its lowlight instance from lowlight's
 * `common` bundle, registering 37 highlight.js grammars (176.3 kB raw /
 * 64.0 kB gzip, the largest single npm package in the bundle) so that a
 * project-management wiki could highlight Arduino, VBNet, Objective-C, R, Lua,
 * Perl and WebAssembly.
 *
 * Two things have to stay true after trimming the list, and only one of them
 * is about size:
 *
 *  1. The languages we kept still highlight. Losing highlighting on the
 *     languages people actually paste in would be a regression, not a win.
 *  2. A language we dropped degrades to plain text rather than throwing.
 *     `@tiptap/extension-code-block-lowlight` guards its call with
 *     `languages.includes(language) || registered(language)`, so an
 *     unregistered language is a no-op — but that is a property of a
 *     third-party package, so it is asserted here rather than assumed. If a
 *     lowlight or TipTap upgrade turns it into a throw, this test fails
 *     instead of the editor.
 */
describe('editor code-block grammars (TRO-199 / BUN-3)', () => {
  const KEPT = [
    'bash',
    'css',
    'diff',
    'javascript',
    'json',
    'markdown',
    'python',
    'shell',
    'sql',
    'typescript',
    'xml',
    'yaml',
  ];

  // A representative sample of what lowlight's `common` bundle used to drag in.
  const DROPPED = ['arduino', 'vbnet', 'objectivec', 'r', 'lua', 'perl', 'wasm'];

  it('registers exactly the curated language set', () => {
    expect(Object.keys(SUPPORTED_CODE_LANGUAGES).sort()).toEqual([...KEPT].sort());
    expect(lowlight.listLanguages().sort()).toEqual([...KEPT].sort());
  });

  it.each(KEPT)('still highlights %s', (language) => {
    expect(lowlight.registered(language)).toBe(true);
  });

  it('actually produces highlight nodes for a kept language', () => {
    // javascript is the language the e2e syntax-highlighting spec asserts on
    // (`language-javascript`), so it is the one that must not silently break.
    const tree = lowlight.highlight('javascript', 'const answer = 42;');
    const classes = JSON.stringify(tree.children);
    expect(tree.children.length).toBeGreaterThan(1);
    expect(classes).toContain('hljs-keyword');
  });

  it('highlights a fenced sql block, the other language this app expects', () => {
    const tree = lowlight.highlight('sql', 'SELECT id FROM documents;');
    expect(JSON.stringify(tree.children)).toContain('hljs-keyword');
  });

  it.each(DROPPED)('no longer ships the %s grammar', (language) => {
    expect(lowlight.registered(language)).toBe(false);
  });

  it('would throw if the extension called highlight() on a dropped language directly', () => {
    // Recorded because it is *why* the extension's guard matters, not because
    // it is the path the editor takes. See the integration block below for what
    // actually happens.
    expect(() => lowlight.highlight('arduino', 'void setup() {}')).toThrow(/not registered/);
  });
});

/**
 * The tests above exercise the lowlight instance. That is the size claim, but
 * it is not the integration BUN-3 changed: what renders a code block is
 * `@tiptap/extension-code-block-lowlight`, and nothing above proves it ever
 * reaches our registry (CodeRabbit finding 2).
 *
 * It matters, because reading the extension's source
 * (node_modules/@tiptap/extension-code-block-lowlight/dist/index.js,
 * `getDecorations`) shows the guard is:
 *
 *   const nodes = language && (languages.includes(language)
 *                              || registered(language)
 *                              || lowlight.registered?.(language))
 *     ? getHighlightNodes(lowlight.highlight(language, text))
 *     : getHighlightNodes(lowlight.highlightAuto(text));
 *
 * Two things follow that a raw-lowlight test cannot see. `registered()` consults
 * highlight.js's own singleton bundled inside the extension — not our instance —
 * so `languages.includes()` off `lowlight.listLanguages()` is the check that
 * actually carries our curated list. And the fallback is **highlightAuto, not
 * plain text**: a dropped language is still highlighted, by auto-detection
 * among the grammars we kept.
 */
describe('CodeBlockLowlight integration (TRO-199 / BUN-3)', () => {
  const editors: Editor[] = [];

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy();
  });

  /** Render one code block through the production extension configuration. */
  function renderCodeBlock(language: string | null, code: string): string {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      // Mirrors Editor.tsx: StarterKit's own codeBlock off, CodeBlockLowlight on.
      extensions: [
        StarterKit.configure({ history: false, dropcursor: false, codeBlock: false }),
        CodeBlockLowlight.configure({
          lowlight,
          HTMLAttributes: { class: 'code-block-lowlight' },
        }),
      ],
      content: {
        type: 'doc',
        content: [
          { type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: code }] },
        ],
      },
    });
    editors.push(editor);
    return editor.view.dom.innerHTML;
  }

  it('reaches the registered grammars — javascript highlights through the extension', () => {
    const html = renderCodeBlock('javascript', 'const answer = 42;');
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-number">42</span>');
  });

  it('uses the explicitly requested grammar, not auto-detection', () => {
    // The discriminating case. For this input, the `diff` grammar produces
    // hljs-addition; auto-detection produces hljs-selector-tag (it guesses
    // CSS). If the extension ever stopped reaching our registry and silently
    // fell through to highlightAuto, this is the assertion that would catch it
    // — a language-class-only check would not.
    const explicit = renderCodeBlock('diff', '+added line\n-removed line');
    expect(explicit).toContain('class="hljs-addition"');

    const auto = renderCodeBlock(null, '+added line\n-removed line');
    expect(auto).not.toContain('class="hljs-addition"');
  });

  it('highlights sql, the other language this codebase writes in documents', () => {
    const html = renderCodeBlock('sql', 'SELECT id FROM documents WHERE archived_at IS NULL;');
    expect(html).toContain('<span class="hljs-keyword">SELECT</span>');
    expect(html).toContain('<span class="hljs-keyword">FROM</span>');
  });

  it('renders a dropped language without throwing, and never loses the code', () => {
    // This is the real regression risk of BUN-3: someone's existing Arduino
    // snippet. It must survive intact.
    const source = 'void setup() { pinMode(13, OUTPUT); }';
    let html = '';
    expect(() => {
      html = renderCodeBlock('arduino', source);
    }).not.toThrow();

    // The author's language tag is preserved even though we no longer ship the
    // grammar, so re-adding it later restores exact highlighting.
    expect(html).toContain('class="language-arduino"');

    // And the text is byte-for-byte intact once markup is stripped.
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toBe(source);
  });

  it('still highlights a dropped language via auto-detection rather than going flat', () => {
    // Correcting a claim this branch originally made. The extension's fallback
    // is highlightAuto, so degradation is better than "plain monospace":
    // C-like Arduino source is detected as one of the grammars we kept.
    const html = renderCodeBlock('arduino', 'void setup() { pinMode(13, OUTPUT); }');
    expect(html).toContain('hljs-');
  });

  it('leaves a code block with no language attribute working', () => {
    const source = 'just some text';
    const html = renderCodeBlock(null, source);
    expect(html.replace(/<[^>]*>/g, '')).toBe(source);
  });
});
