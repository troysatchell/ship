import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

/**
 * W4-R38 — "Dependency versions must be pinned in package.json and lockfiles
 * committed."
 *
 * A caret (`^x.y.z`) or tilde (`~x.y.z`) range means a plain `pnpm install`
 * can resolve a different, newer dependency than the one this repo was built
 * and tested against, even with a committed lockfile present (a fresh
 * `pnpm-lock.yaml` regeneration, or any flow that doesn't pass
 * `--frozen-lockfile`, can move the range forward). This test is the
 * regression net for the manifest-only fix in this ticket: it fails the
 * moment any of the five workspace manifests regains an unpinned range.
 *
 * `workspace:*` internal references are exempt (not a version range at all),
 * as are ranges pnpm.overrides intentionally keeps open on a direct
 * dependency (see the root package.json `pnpm.overrides` block and the
 * `postcss` note in CHANGES.md's W4-R38 entry) — both are legitimate,
 * deliberate exceptions rather than un-pinning.
 *
 * `research/configs/package.json` is deliberately NOT covered here: it is
 * not a member of the root `pnpm-workspace.yaml` and is never installed by
 * this repo's `pnpm install` (see CHANGES.md's W4-R38 entry for the ruling).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')

const MANIFESTS = ['package.json', 'api/package.json', 'web/package.json', 'shared/package.json', 'agent/package.json']

const OVERRIDDEN_PACKAGE_NAMES = new Set(
  Object.keys(
    (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).pnpm?.overrides ?? {}) as Record<
      string,
      string
    >,
  ),
)

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8')) as PackageManifest
}

describe('dependency versions stay pinned (W4-R38)', () => {
  for (const manifestPath of MANIFESTS) {
    it(`${manifestPath} has no caret/tilde ranges outside pnpm.overrides`, () => {
      const manifest = readManifest(manifestPath)
      const offenders: string[] = []

      for (const section of ['dependencies', 'devDependencies'] as const) {
        const entries = manifest[section]
        if (!entries) continue

        for (const [name, spec] of Object.entries(entries)) {
          if (spec === 'workspace:*') continue
          if (OVERRIDDEN_PACKAGE_NAMES.has(name)) continue
          if (spec.startsWith('^') || spec.startsWith('~')) {
            offenders.push(`${section}.${name}: ${spec}`)
          }
        }
      }

      expect(offenders).toEqual([])
    })
  }
})
