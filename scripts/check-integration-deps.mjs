#!/usr/bin/env node
/**
 * check-integration-deps — enforce PLUGFORGE.MD §2.1's `integrations/*` boundary
 * rule (PF-003 / TRO-399): a package under `integrations/` may declare
 * `@ship/sdk` as its only RUNTIME dependency — never `api/src`, never any other
 * npm package as a runtime dep. This is what makes "the agent is a platform
 * citizen" (§1.3) structurally true: PF-702 later gives `agent/` the exact same
 * `@ship/sdk`-only constraint (deliberately NOT enforced by this script — see
 * the note below), so every third-party integration is held to the identical
 * rule the first-party one will be.
 *
 * `integrations/*` packages don't exist yet (PLUGFORGE.MD §2.1's tree is
 * aspirational for this ticket — cli/, browser-demo/, slack/ land in E6/E8).
 * This script is Day-1 infrastructure: it MUST be a clean, silent pass against
 * an absent or empty `integrations/` directory, and only start finding
 * violations once a real package lands there and declares one.
 *
 * Scope, deliberately:
 * - Only `dependencies` (runtime) is checked — never `devDependencies` or
 *   `peerDependencies`. The brief mandates `strict: true` tsconfigs for every
 *   integrations/* package, and each one needs its own dev tooling
 *   (typescript, a bundler, a test runner, ...); the constraint this ticket
 *   enforces is about what ships in the runtime dependency graph, not what
 *   builds/tests the package.
 * - Only `integrations/*` (one level deep) is scanned. `agent/` is NOT in
 *   scope for this script — PF-702 makes `agent/` a permitted `@ship/sdk`
 *   consumer with its OWN existing dependency graph (express-adjacent tooling
 *   etc.), and this ticket's own spec says explicitly not to write a rule that
 *   forbids it.
 *
 * Usage:
 *   node scripts/check-integration-deps.mjs [--dir integrations]
 *
 * Exit 0 = no runtime-dependency violations (including: integrations/ absent
 *          or contains no packages yet — Day 1's expected state).
 * Exit 1 = at least one integrations/* package declares a runtime dependency
 *          other than @ship/sdk.
 * Exit 2 = could not evaluate (e.g. a package.json that isn't valid JSON).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ALLOWED_RUNTIME_DEP = '@ship/sdk'

/**
 * Pure decision logic (TRO-399 test design, AC-2): given a parsed package.json
 * object, return every declared RUNTIME dependency that is not `@ship/sdk`.
 * Never throws on a malformed/partial object — a missing `dependencies` field
 * is "no runtime deps", not an error.
 */
export function checkPackageDeps(pkgJson) {
  const name = pkgJson && typeof pkgJson.name === 'string' ? pkgJson.name : '(unnamed package)'
  const deps = (pkgJson && typeof pkgJson.dependencies === 'object' && pkgJson.dependencies) || {}
  const violations = Object.entries(deps)
    .filter(([depName]) => depName !== ALLOWED_RUNTIME_DEP)
    .map(([depName, version]) => ({ package: name, dependency: depName, version: String(version) }))
  return { violations }
}

/**
 * Scan `<dir>/*\/package.json` (one level deep — each immediate subdirectory
 * is treated as one workspace package) and run checkPackageDeps on each.
 *
 * An ABSENT or EMPTY `dir` is not a violation — it is Day 1, before any real
 * package exists (PF-600 is the first one, E6) — and reports a clean pass via
 * `dirExists`, never throws for that reason. Throws only on a genuine
 * evaluation failure (a package.json that exists but isn't valid JSON) so
 * that a broken fixture is never silently read as "compliant."
 */
export function scanIntegrations(dir) {
  if (!existsSync(dir)) {
    return { violations: [], scannedPackages: [], dirExists: false }
  }

  const violations = []
  const scannedPackages = []
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const entry of entries) {
    const pkgJsonPath = join(dir, entry.name, 'package.json')
    if (!existsSync(pkgJsonPath)) continue

    let pkgJson
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    } catch (err) {
      throw new Error(`${pkgJsonPath} is not valid JSON: ${err.message}`)
    }

    scannedPackages.push(entry.name)
    violations.push(...checkPackageDeps(pkgJson).violations)
  }

  return { violations, scannedPackages, dirExists: true }
}

// --- CLI entry point ---------------------------------------------------
// Guarded so check-integration-deps.test.mjs can import the pure functions
// above without triggering filesystem reads / process.exit as a side effect
// of import (same convention as scripts/factory/lib/dependency-audit-diff.mjs).
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const argv = process.argv.slice(2)
  const dirFlagIndex = argv.indexOf('--dir')
  const dir = dirFlagIndex !== -1 && argv[dirFlagIndex + 1] ? argv[dirFlagIndex + 1] : 'integrations'

  let result
  try {
    result = scanIntegrations(dir)
  } catch (err) {
    console.error(`check-integration-deps: ${err.message}`)
    process.exit(2)
  }

  const { violations, scannedPackages, dirExists } = result

  if (!dirExists) {
    console.log(`check-integration-deps: OK — '${dir}/' does not exist yet (nothing to check).`)
    process.exit(0)
  }
  if (scannedPackages.length === 0) {
    console.log(`check-integration-deps: OK — '${dir}/' has no packages yet (nothing to check).`)
    process.exit(0)
  }

  if (violations.length === 0) {
    console.log(
      `check-integration-deps: OK — ${scannedPackages.length} package(s) checked ` +
        `(${scannedPackages.join(', ')}), all depend only on ${ALLOWED_RUNTIME_DEP}.`,
    )
    process.exit(0)
  }

  console.error(
    `check-integration-deps: FAIL — ${violations.length} runtime-dependency violation(s) found. ` +
      `integrations/* may declare only "${ALLOWED_RUNTIME_DEP}" as a runtime dependency (PLUGFORGE.MD §2.1):`,
  )
  for (const v of violations) {
    console.error(`  - ${v.package}: "${v.dependency}": "${v.version}"`)
  }
  process.exit(1)
}
