/**
 * Static value-import detection for source-level architecture tests.
 *
 * Three tests assert that a module is *not* statically imported, because that
 * is the only thing keeping a code-split boundary alive (TRO-197 / BUN-1,
 * TRO-198 / BUN-2, TRO-200 / BUN-4). Each of those tests originally carried its
 * own `/^import \{...\} from '...'/m` regex, and each was **vacuous against
 * most of the syntax**: a default import, a namespace import, double quotes, a
 * multi-line brace list or a re-export would all have sailed through a guard
 * whose entire job was to catch them.
 *
 * A guard that can pass while the thing it forbids is present is worse than no
 * guard, so the detection lives here, once, with `sourceImports.test.ts`
 * exercising every form it claims to catch.
 *
 * What counts as a static value import:
 *   import 'mod'                     side effect
 *   import d from 'mod'              default
 *   import * as ns from 'mod'        namespace
 *   import { a, b as c } from 'mod'  named, including multi-line
 *   import d, { a } from 'mod'       mixed
 *   import { type T, v } from 'mod'  inline type mixed with a value binding
 *   export { a } from 'mod'          re-export — also pulls the module in
 *   export * from 'mod'              star re-export
 *
 * What does not:
 *   import type { T } from 'mod'     erased at build time
 *   import type D from 'mod'         erased at build time
 *   export type { T } from 'mod'     erased at build time
 *   await import('mod')              the split boundary itself
 *
 * Limitation, stated rather than hidden: comments are stripped with a regex, so
 * a `//` inside a string literal can truncate that line. It cannot invent an
 * import, so the failure direction is a missed detection in pathological
 * source, not a false alarm. Good enough for asserting on our own files;
 * not a parser.
 */

/** Strip block and line comments so a commented-out import is not "found". */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const BARE = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
// The clause may not contain `;` or a quote, which stops the lazy match from
// running across statement boundaries. `(?!type\s)` drops erased type imports;
// `(?![\s]*\()` drops dynamic `import (...)`.
const WITH_CLAUSE = /(?:^|[\s;}])import\s+(?!type\s)(?!\s*\()([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
const RE_EXPORT = /(?:^|[\s;}])export\s+(?!type\s)([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Every module specifier `source` statically imports at value level.
 * Grouped by import form (bare imports, then default/named imports and
 * re-exports), not true source order, with duplicates collapsed. Do not
 * rely on the returned order reflecting where each import appears in the
 * file if a source mixes import forms.
 */
export function staticValueImports(source: string): string[] {
  const clean = stripComments(source);
  const found = new Set<string>();

  for (const m of clean.matchAll(BARE)) {
    const spec = m[1];
    if (spec !== undefined) found.add(spec);
  }
  for (const re of [WITH_CLAUSE, RE_EXPORT]) {
    for (const m of clean.matchAll(re)) {
      // `import { type A, type B } from 'x'` is fully erased even though it is
      // not written as `import type`. Only treat it as a value import if at
      // least one binding lacks the inline `type` marker.
      const clause = m[1] ?? '';
      const braces = clause.match(/\{([\s\S]*)\}/);
      if (braces) {
        const inner = braces[1] ?? '';
        const bindings = inner
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean);
        const outsideBraces = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
        if (bindings.length > 0 && !outsideBraces && bindings.every((b) => /^type\s/.test(b))) {
          continue;
        }
      }
      const spec = m[2];
      if (spec !== undefined) found.add(spec);
    }
  }

  return [...found];
}

/** True if `source` statically imports `specifier` at value level. */
export function importsStatically(source: string, specifier: string): boolean {
  return staticValueImports(source).includes(specifier);
}

/**
 * Static value imports that resolve into `web/src/pages`, by either the `@/`
 * alias or a relative path.
 */
export function staticPageImports(source: string): string[] {
  return staticValueImports(source).filter((s) => /(?:^@\/|(?:^|\/)\.{1,2}\/)pages\//.test(s));
}
