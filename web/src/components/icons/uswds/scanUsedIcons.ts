/**
 * Scans web/src for every icon name passed to `<Icon name="...">` (the USWDS
 * icon component, `web/src/components/icons/uswds/Icon.tsx`).
 *
 * Shared by two callers that must never drift from each other (TRO-201 /
 * BUN-5):
 *  - `scripts/generate-icon-types.ts`, which uses the result to write
 *    `usedIcons.generated.ts`, the static eager-import map `Icon.tsx` renders
 *    from.
 *  - `Icon.test.tsx`, which re-runs this exact scan against the live source
 *    tree and asserts every name it finds is present in that generated map
 *    and renders without throwing — the regression guard against the
 *    narrowed map silently dropping an icon that is genuinely in use.
 *
 * Deliberately scoped to the `<Icon name="...">` JSX attribute, not a
 * whole-file string-literal grep. `audit/bundle/baseline.md`'s BUN-5 finding
 * used the latter (any quoted lowercase literal matching one of the 245 icon
 * filenames) and reported "36 referenced, 209 not". Re-deriving live for this
 * ticket found the `<Icon>` component is imported by exactly one file
 * (`pages/Login.tsx`), which passes exactly 4 literal names (check, close,
 * warning, info) — independently pinned by `e2e/icons.spec.ts`, which asserts
 * precisely 4 icons render on the login page. The other ~31 matches from the
 * whole-file scan were coincidental: unrelated identifiers (status values,
 * route segments, etc.) that happen to share text with an icon filename,
 * picked up because that scan cannot distinguish a JSX prop from any other
 * quoted string. See CHANGES.md's TRO-201 entry for the full before/after.
 *
 * This module is dev/build tooling only (it does Node `fs` reads over the
 * source tree) — it must never be imported from `Icon.tsx` or
 * `usedIcons.generated.ts`, or it would pull `fs`/`path` into the browser
 * bundle. Its only importers are the generator script and this directory's
 * own test file.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ICON_TAG_RE = /<Icon\b[\s\S]*?\/>/g;
const NAME_ATTR_RE = /\bname\s*=\s*(['"])([A-Za-z0-9_]+)\1/;

function isScannableSourceFile(fileName: string): boolean {
  if (/\.test\.[tj]sx?$/.test(fileName)) return false;
  return /\.[tj]sx?$/.test(fileName);
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__mocks__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, acc);
    } else if (isScannableSourceFile(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export interface ScanOptions {
  /** Absolute file paths to skip outright (the generator's own outputs, Icon.tsx itself). */
  excludeFiles?: string[];
}

/**
 * @param srcDir absolute path to `web/src`.
 * @param validNames every icon name the USWDS sprite actually ships
 *   (`types.ts`'s `ICON_NAMES`) — used to fail loudly on a typo'd
 *   `<Icon name="...">` rather than silently omitting it.
 * @returns sorted, de-duplicated icon names actually referenced.
 */
export function scanUsedIconNames(
  srcDir: string,
  validNames: ReadonlySet<string>,
  options: ScanOptions = {},
): string[] {
  const exclude = new Set(options.excludeFiles ?? []);
  const used = new Set<string>();

  for (const file of listSourceFiles(srcDir)) {
    if (exclude.has(file)) continue;

    const contents = readFileSync(file, 'utf8');
    for (const tag of contents.matchAll(ICON_TAG_RE)) {
      const nameMatch = tag[0].match(NAME_ATTR_RE);
      if (!nameMatch) continue;

      const name = nameMatch[2];
      if (name === undefined) continue;

      if (!validNames.has(name)) {
        throw new Error(
          `${file} references unknown icon "${name}" via <Icon name="${name}">. ` +
            `Check for a typo, or confirm the SVG exists in @uswds/uswds's usa-icons directory.`,
        );
      }
      used.add(name);
    }
  }

  return [...used].sort();
}
