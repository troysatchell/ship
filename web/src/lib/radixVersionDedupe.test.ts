import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * TRO-204 / BUN-8 — two Radix packages resolved to duplicate versions and both
 * copies shipped in the built entry chunk: `@radix-ui/react-primitive` at both
 * 2.1.3 *and* 2.1.4, `@radix-ui/react-slot` at both 1.2.3 *and* 1.2.4 (~2.1 kB
 * raw of redundant bytes; the only family among 124 bundled packages with more
 * than one resolved version).
 *
 * Cause: `cmdk@1.1.1` declares `"@radix-ui/react-primitive": "^2.0.2"` (a caret
 * range), which pnpm resolves to the newest match at install time (2.1.4 ->
 * react-slot 1.2.4), while `@radix-ui/react-dialog`, `-popover` and `-tooltip`
 * each pin an *exact* older version internally (2.1.3 -> 1.2.3). Neither side
 * is a range pnpm can widen on its own, so it kept both trees.
 *
 * Fixed with a `pnpm.overrides` entry in the root `package.json` (see the
 * `"// BUN-8 (TRO-204)"` comment key beside it) forcing every consumer onto
 * 2.1.4 / 1.2.4. Converging *up* rather than down was verified safe by diffing
 * the built `dist/index.mjs` of both version pairs: react-primitive is
 * byte-identical between 2.1.3 and 2.1.4, and react-slot 1.2.4 only *adds*
 * `React.lazy`-child support over 1.2.3 - a strict superset, not a behaviour
 * change.
 *
 * This test reads the real, installed `pnpm-lock.yaml` rather than asserting
 * on `package.json` intent, so it catches a *resolution* regression - e.g. a
 * new dependency bringing its own caret range on either package - even when
 * nobody touched `web/package.json` or the override. It is scoped to
 * `@radix-ui/*` specifically: BUN-8's finding was that Radix was the only
 * family with a split resolution, not a claim that no package anywhere in the
 * tree may ever have two versions (plenty legitimately do, e.g. divergent
 * `@types/*` majors).
 */
const here = dirname(fileURLToPath(import.meta.url));
const lockfile = readFileSync(resolve(here, '../../../pnpm-lock.yaml'), 'utf8');

/**
 * Matches only the top-level `packages:` registration lines
 * (`  '<name>@<version>':`), each of which appears exactly once per distinct
 * resolved version - never the later `snapshots:` section, where the same
 * (name, version) repeats once per peer-dependency combination and would
 * over-count.
 */
function resolvedVersionsFor(packageName: string): string[] {
  const escaped = packageName.replace(/[/]/g, '\\/');
  const pattern = new RegExp(`^ {2}'${escaped}@([^'(]+)':$`, 'gm');
  return [...lockfile.matchAll(pattern)].map((m) => m[1]);
}

const radixPackagesInLockfile = [
  ...new Set([...lockfile.matchAll(/^ {2}'(@radix-ui\/[a-z-]+)@[^'(]+':$/gm)].map((m) => m[1])),
];

describe('Radix dependency dedupe (TRO-204 / BUN-8)', () => {
  it('parser sanity check: finds the two packages this regression is about', () => {
    // If this fails, the lockfile format changed and the check below is not
    // actually running against real data - fix the regex, don't delete the test.
    expect(radixPackagesInLockfile).toEqual(
      expect.arrayContaining(['@radix-ui/react-primitive', '@radix-ui/react-slot'])
    );
  });

  it.each(radixPackagesInLockfile)('%s resolves to exactly one version', (pkg) => {
    const versions = resolvedVersionsFor(pkg);
    expect(
      versions.length,
      `${pkg} resolved to ${versions.length} version(s) (${versions.join(', ')}) in pnpm-lock.yaml - ` +
        `a new caret-range consumer likely split it again. Converge them via the "pnpm.overrides" ` +
        `entry in the root package.json (see BUN-8 / TRO-204), then re-run "pnpm install".`
    ).toBe(1);
  });
});
