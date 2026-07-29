#!/usr/bin/env node
/**
 * testdiff — compare a vitest JSON run against the quarantine baseline.
 *
 * The factory's core safety property: an agent's branch is only "green" if it
 * introduces NO test failure that wasn't already failing on main. Comparing raw
 * pass/fail counts is not enough — an agent could fix one test and break another
 * and the totals would match. So we compare failure *identities*.
 *
 * Usage:
 *   node testdiff.mjs --package api --current run.json --baseline audit/factory/quarantine.json
 *
 * Exit 0 = no new failures. Exit 1 = regression. Exit 2 = could not evaluate.
 */

import { readFileSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || i === process.argv.length - 1) return fallback
  return process.argv[i + 1]
}

const pkg = arg('package')
const currentPath = arg('current')
const baselinePath = arg('baseline')
const repoRoot = arg('repo-root', process.cwd())

if (!pkg || !currentPath || !baselinePath) {
  console.error('usage: testdiff.mjs --package <api|web> --current <run.json> --baseline <quarantine.json>')
  process.exit(2)
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`testdiff: cannot read ${what} at ${path}: ${err.message}`)
    process.exit(2)
  }
}

/**
 * Build the set of failing test identities from a vitest JSON report.
 * Identity = "<repo-relative file>::<full test name>", which is stable across
 * machines and worktrees (absolute paths are not — every worktree has its own).
 */
function failureSet(report) {
  const failures = new Set()
  const suites = report.testResults ?? []
  for (const suite of suites) {
    const file = isAbsolute(suite.name) ? relative(repoRoot, suite.name) : suite.name
    const assertions = suite.assertionResults ?? []
    if (assertions.length === 0 && suite.status === 'failed') {
      // Whole-file failure (import error, schema build error, collection crash).
      // There are no per-test results to key on, so the file itself is the identity.
      failures.add(`${file}::<file-level failure>`)
      continue
    }
    for (const a of assertions) {
      if (a.status === 'failed') {
        const full = a.fullName || [...(a.ancestorTitles ?? []), a.title].join(' > ')
        failures.add(`${file}::${full}`)
      }
    }
  }
  return failures
}

const current = readJson(currentPath, 'current run')
const baseline = readJson(baselinePath, 'quarantine baseline')

const known = new Set(baseline?.packages?.[pkg]?.knownFailing ?? [])
const now = failureSet(current)

const newFailures = [...now].filter((t) => !known.has(t)).sort()
const stillFailing = [...now].filter((t) => known.has(t)).sort()
const fixed = [...known].filter((t) => !now.has(t)).sort()

const verdict = newFailures.length === 0 ? 'pass' : 'fail'

const result = {
  package: pkg,
  verdict,
  counts: {
    knownFailing: known.size,
    currentlyFailing: now.size,
    newFailures: newFailures.length,
    fixed: fixed.length,
  },
  newFailures,
  fixed,
  stillFailing,
}

console.log(JSON.stringify(result, null, 2))

if (verdict === 'fail') {
  console.error(`\ntestdiff: ${newFailures.length} NEW failure(s) in ${pkg} not present on the baseline:`)
  for (const t of newFailures) console.error(`  - ${t}`)
  process.exit(1)
}

if (fixed.length > 0) {
  console.error(`\ntestdiff: ${fixed.length} previously-quarantined test(s) now pass in ${pkg}:`)
  for (const t of fixed) console.error(`  + ${t}`)
  console.error('If this branch fixed them deliberately, remove them from the quarantine baseline.')
}

process.exit(0)
