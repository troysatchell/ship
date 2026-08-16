#!/usr/bin/env node
/**
 * Standalone test for scripts/check-integration-deps.mjs's pure functions.
 *
 * TRO-399 (PF-003), AC-2 in the ticket's test design (ship-test-designer, Linear
 * TRO-399 comment, 2026-08-10): "integrations/* depend only on @ship/sdk" via
 * scripts/check-integration-deps.mjs, tested through checkPackageDeps(pkgJson) —
 * a pure function — with two in-memory fixtures.
 *
 * DEVIATION from the test design's literal path (`scripts/__tests__/check-integration-deps.test.ts`):
 * this repo has exactly one precedent for testing a standalone script outside any
 * package's TypeScript/vitest project — scripts/factory/lib/dependency-audit-diff.mjs
 * + its sibling .test.mjs — and that precedent's own header explains why: nothing
 * under scripts/ is covered by a tsconfig or a vitest `include`, so a `.test.ts`
 * file here would satisfy gate.sh's G6 regression-test grep (which matches
 * `*.test.ts`) while never actually being EXECUTED by any test runner gate.sh or
 * CI invokes — the exact "regression test added but never run" trap `ship-qa`
 * documents for e2e specs, recurring here one directory over. Using `.mjs` +
 * `node:test` (zero new dependencies, matches the existing precedent exactly) and
 * then explicitly wiring `node --test` for THIS file into both CI pipelines'
 * `verify` job (.gitlab-ci.yml, .github/workflows/ci.yml) closes the gap that the
 * precedent file's own header admits was left open (TRO-244 claimed to have wired
 * it into CI but never did — confirmed by grep against both CI configs' full
 * history before writing this comment). AC-1's regression test
 * (api/src/platform/__tests__/boundary-lint.test.ts) is a real `.ts` file inside
 * api/'s vitest project, so gate.sh's G6 check still finds a qualifying added test
 * case on this branch regardless of this file's extension.
 *
 * Run directly: `node --test scripts/__tests__/check-integration-deps.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackageDeps, scanIntegrations, ALLOWED_RUNTIME_DEP } from '../check-integration-deps.mjs'

// --- AC-2: checkPackageDeps(pkgJson) — pure decision logic -----------------

test('checkPackageDeps: a package depending only on @ship/sdk reports zero violations', () => {
  const pkgJson = { name: '@ship/cli', dependencies: { '@ship/sdk': '*' } }
  const { violations } = checkPackageDeps(pkgJson)
  assert.deepEqual(violations, [])
})

test('checkPackageDeps: a package with @ship/sdk PLUS express reports a violation naming express', () => {
  const pkgJson = { name: '@ship/cli', dependencies: { '@ship/sdk': '*', express: '^4' } }
  const { violations } = checkPackageDeps(pkgJson)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].dependency, 'express')
  assert.equal(violations[0].package, '@ship/cli')
})

test('checkPackageDeps: a package with no dependencies field at all reports zero violations', () => {
  const { violations } = checkPackageDeps({ name: '@ship/cli' })
  assert.deepEqual(violations, [])
})

test('checkPackageDeps: multiple disallowed runtime deps are each reported', () => {
  const pkgJson = {
    name: '@ship/slack',
    dependencies: { '@ship/sdk': '*', express: '^4', '@slack/bolt': '^3' },
  }
  const { violations } = checkPackageDeps(pkgJson)
  const names = violations.map((v) => v.dependency).sort()
  assert.deepEqual(names, ['@slack/bolt', 'express'])
})

test('checkPackageDeps: devDependencies are never flagged (runtime deps only)', () => {
  const pkgJson = {
    name: '@ship/cli',
    dependencies: { '@ship/sdk': '*' },
    devDependencies: { typescript: '^5', tsx: '^4', vitest: '^4' },
  }
  const { violations } = checkPackageDeps(pkgJson)
  assert.deepEqual(violations, [])
})

test('ALLOWED_RUNTIME_DEP is @ship/sdk', () => {
  assert.equal(ALLOWED_RUNTIME_DEP, '@ship/sdk')
})

// --- scanIntegrations(dir) — the directory-walking half --------------------
// New-package-trap note (test design, 2026-08-10): integrations/* packages don't
// exist yet, so these use a scratch fixture directory under the OS tmpdir, never
// the repo's own (currently absent) integrations/ — this proves the scanning
// logic itself, not that a real PF-600 package gets caught (that is PF-600's own
// test design's job).

test('scanIntegrations: a directory that does not exist on disk is a clean pass, not an error', () => {
  const missing = join(tmpdir(), `pf003-does-not-exist-${Date.now()}`)
  const result = scanIntegrations(missing)
  assert.equal(result.dirExists, false)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.scannedPackages, [])
})

test('scanIntegrations: an existing but empty directory is a clean pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf003-empty-'))
  try {
    const result = scanIntegrations(dir)
    assert.equal(result.dirExists, true)
    assert.deepEqual(result.violations, [])
    assert.deepEqual(result.scannedPackages, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanIntegrations: a compliant package (only @ship/sdk) scans clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf003-compliant-'))
  try {
    mkdirSync(join(dir, 'cli'))
    writeFileSync(
      join(dir, 'cli', 'package.json'),
      JSON.stringify({ name: '@ship/cli', dependencies: { '@ship/sdk': '*' } }),
    )
    const result = scanIntegrations(dir)
    assert.equal(result.dirExists, true)
    assert.deepEqual(result.scannedPackages, ['cli'])
    assert.deepEqual(result.violations, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- TRO-496 (CodeRabbit on PR #175): optionalDependencies / peerDependencies
// can smuggle a runtime dep past a `dependencies`-only check. npm installs
// `optionalDependencies` by default (unless `--omit=optional`), and
// `peerDependencies` land in the runtime graph too — both are checked now.
// devDependencies remains exempt (see next test).

test('checkPackageDeps: a package with @ship/sdk PLUS an optionalDependencies smuggled dep reports a violation', () => {
  const pkgJson = {
    name: '@ship/cli',
    dependencies: { '@ship/sdk': '*' },
    optionalDependencies: { express: '^4' },
  }
  const { violations } = checkPackageDeps(pkgJson)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].dependency, 'express')
  assert.equal(violations[0].field, 'optionalDependencies')
})

test('checkPackageDeps: a package with @ship/sdk PLUS a peerDependencies smuggled dep reports a violation', () => {
  const pkgJson = {
    name: '@ship/cli',
    dependencies: { '@ship/sdk': '*' },
    peerDependencies: { react: '^18' },
  }
  const { violations } = checkPackageDeps(pkgJson)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].dependency, 'react')
  assert.equal(violations[0].field, 'peerDependencies')
})

test('checkPackageDeps: @ship/sdk listed in optionalDependencies is still allowed (not flagged)', () => {
  const pkgJson = {
    name: '@ship/cli',
    optionalDependencies: { '@ship/sdk': '*' },
  }
  const { violations } = checkPackageDeps(pkgJson)
  assert.deepEqual(violations, [])
})

test('scanIntegrations: a package compliant on dependencies but violating via optionalDependencies is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf003-optional-violation-'))
  try {
    mkdirSync(join(dir, 'badpkg'))
    writeFileSync(
      join(dir, 'badpkg', 'package.json'),
      JSON.stringify({
        name: '@ship/badpkg',
        dependencies: { '@ship/sdk': '*' },
        optionalDependencies: { express: '^4' },
      }),
    )
    const result = scanIntegrations(dir)
    assert.equal(result.violations.length, 1)
    assert.equal(result.violations[0].dependency, 'express')
    assert.equal(result.violations[0].field, 'optionalDependencies')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanIntegrations: a violating package (this ticket AC top-line evidence, local form) is caught by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf003-violation-'))
  try {
    mkdirSync(join(dir, 'badpkg'))
    writeFileSync(
      join(dir, 'badpkg', 'package.json'),
      JSON.stringify({ name: '@ship/badpkg', dependencies: { '@ship/sdk': '*', express: '^4' } }),
    )
    const result = scanIntegrations(dir)
    assert.equal(result.dirExists, true)
    assert.equal(result.violations.length, 1)
    assert.equal(result.violations[0].dependency, 'express')
    assert.equal(result.violations[0].package, '@ship/badpkg')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
