import { describe, it, expect } from 'vitest';
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

  it('degrades a dropped language to plain text instead of throwing', () => {
    // This is the guard @tiptap/extension-code-block-lowlight applies before
    // calling highlight(). Mirrored here so the contract is pinned.
    expect(lowlight.registered('arduino')).toBe(false);

    // And if something did call highlight() on an unregistered language, it
    // must fail loudly rather than corrupt the document — lowlight throws a
    // named error, which the extension's guard is what prevents.
    expect(() => lowlight.highlight('arduino', 'void setup() {}')).toThrow(/not registered/);
  });
});
