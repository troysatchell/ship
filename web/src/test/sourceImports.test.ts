import { describe, it, expect } from 'vitest';
import { staticValueImports, importsStatically, staticPageImports } from './sourceImports';

/**
 * The guard behind the guards.
 *
 * `main.routes.test.ts`, `EmojiPicker.test.tsx` and `LazyEditor.test.tsx` assert
 * that certain modules are never statically imported — that assertion is the
 * only thing keeping the BUN-1/2/4 code-split boundaries from silently
 * re-merging. Each of those tests originally used its own narrow regex that
 * matched exactly one syntactic form, so the guard could pass with a static
 * import sitting in the file in any other form.
 *
 * CodeRabbit flagged two of them (findings 3 and 4). Rather than widen two
 * regexes and hope, every form the detector claims to catch is exercised here.
 * If `staticValueImports` stops catching a form, this fails — not the far more
 * expensive silent bundle regression three tests downstream.
 */
describe('staticValueImports', () => {
  const CAUGHT: Array<[string, string]> = [
    ['side-effect, single quotes', "import 'emoji-picker-react';"],
    ['side-effect, double quotes', 'import "emoji-picker-react";'],
    ['default import', "import EmojiPicker from 'emoji-picker-react';"],
    ['default import, double quotes', 'import EmojiPicker from "emoji-picker-react";'],
    ['namespace import', "import * as picker from 'emoji-picker-react';"],
    ['named import', "import { Theme } from 'emoji-picker-react';"],
    ['named import, double quotes', 'import { Theme } from "emoji-picker-react";'],
    ['named import, no semicolon', "import { Theme } from 'emoji-picker-react'"],
    [
      'named import spanning multiple lines',
      "import {\n  Theme,\n  EmojiClickData,\n} from 'emoji-picker-react';",
    ],
    ['mixed default and named', "import EmojiPicker, { Theme } from 'emoji-picker-react';"],
    ['mixed default and namespace', "import EmojiPicker, * as ns from 'emoji-picker-react';"],
    ['renamed binding', "import { Theme as T } from 'emoji-picker-react';"],
    ['inline type mixed with a value binding', "import { type EmojiClickData, Theme } from 'emoji-picker-react';"],
    ['re-export', "export { Theme } from 'emoji-picker-react';"],
    ['star re-export', "export * from 'emoji-picker-react';"],
    ['extra whitespace', "import   {  Theme  }   from   'emoji-picker-react' ;"],
    ['not at start of line', "const a = 1; import { Theme } from 'emoji-picker-react';"],
  ];

  it.each(CAUGHT)('catches a static value import written as %s', (_form, source) => {
    expect(importsStatically(source, 'emoji-picker-react')).toBe(true);
  });

  const IGNORED: Array<[string, string]> = [
    ['a type-only named import', "import type { EmojiClickData } from 'emoji-picker-react';"],
    ['a type-only default import', "import type Picker from 'emoji-picker-react';"],
    ['a type-only re-export', "export type { EmojiClickData } from 'emoji-picker-react';"],
    ['an all-inline-type import', "import { type Theme, type EmojiClickData } from 'emoji-picker-react';"],
    ['a dynamic import', "const m = await import('emoji-picker-react');"],
    ['a lazy dynamic import', "const P = lazy(() => import('emoji-picker-react'));"],
    ['a line-commented import', "// import { Theme } from 'emoji-picker-react';"],
    [
      'a block-commented import',
      "/*\n * import { Theme } from 'emoji-picker-react';\n */",
    ],
    ['a doc comment merely naming the package', "/** Do not import emoji-picker-react here. */"],
    ['a different module with a shared prefix', "import x from 'emoji-picker-react-extra';"],
  ];

  it.each(IGNORED)('does not treat %s as a static value import', (_form, source) => {
    expect(importsStatically(source, 'emoji-picker-react')).toBe(false);
  });

  it('returns every specifier in source order without duplicates', () => {
    const src = [
      "import { a } from './a';",
      "import 'b';",
      "import { a2 } from './a';",
      "export { c } from './c';",
    ].join('\n');
    expect(staticValueImports(src)).toEqual(['b', './a', './c']);
  });

  it('recognises page modules through the alias and through relative paths', () => {
    const src = [
      "import { LoginPage } from '@/pages/Login';",
      "import { AppLayout } from './pages/App';",
      "import { Foo } from '../pages/Foo';",
      "import { cn } from '@/lib/cn';",
      "import { Bar } from '@/components/pages-helper';",
    ].join('\n');
    expect(staticPageImports(src)).toEqual(['@/pages/Login', './pages/App', '../pages/Foo']);
  });

  it('does not count a lazily-imported page as a static page import', () => {
    const src = "const P = React.lazy(() => import('@/pages/Documents').then((m) => ({ default: m.DocumentsPage })));";
    expect(staticPageImports(src)).toEqual([]);
  });
});
