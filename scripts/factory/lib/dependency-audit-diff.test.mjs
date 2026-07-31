#!/usr/bin/env node
/**
 * Standalone test for dependency-audit-diff.mjs's pure functions.
 *
 * TRO-244: no `scripts/factory/lib/*.test.ts` pattern exists yet (nothing under
 * scripts/ has a test today), and this logic lives in a standalone CLI script
 * outside any package's TypeScript project, so a "documented node
 * script.test.mjs-style runner" (per this ticket's brief) is the right fit
 * rather than forcing it into api/ or web/'s vitest suite. It uses only
 * node:assert + node:test (built in, zero new dependencies) and is wired into
 * CI as its own step (see .github/workflows/ci.yml) so it is not orphaned:
 * `node --test scripts/factory/lib/dependency-audit-diff.test.mjs`.
 *
 * NOTE for scripts/factory/gate.sh operators: this file's added `test(...)`
 * cases are NOT picked up by gate.sh's G6 regression-test check, which only
 * greps `*.test.ts` / `*.test.tsx` / `*.spec.ts`. That is a known gap in a
 * check written before any script under scripts/ had tests — documented here
 * and in CHANGES.md rather than silently relying on it to "just work."
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractAdvisoryIds, severityCounts, diffAdvisories } from './dependency-audit-diff.mjs'

function fakeAuditReport({ advisories = {}, vulnerabilities = {} } = {}) {
  return {
    advisories,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        ...vulnerabilities,
      },
    },
  }
}

test('extractAdvisoryIds returns the GHSA id for each advisory', () => {
  const report = fakeAuditReport({
    advisories: {
      111: { id: 111, github_advisory_id: 'GHSA-aaaa-aaaa-aaaa' },
      222: { id: 222, github_advisory_id: 'GHSA-bbbb-bbbb-bbbb' },
    },
  })
  const ids = extractAdvisoryIds(report)
  assert.deepEqual([...ids].sort(), ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb'])
})

test('extractAdvisoryIds falls back to a prefixed numeric id when github_advisory_id is missing', () => {
  const report = fakeAuditReport({
    advisories: {
      333: { id: 333, github_advisory_id: null },
    },
  })
  const ids = extractAdvisoryIds(report)
  assert.deepEqual([...ids], ['pnpm-advisory-333'])
})

test('extractAdvisoryIds dedupes when two advisory entries share one GHSA id', () => {
  // Real-world case: pnpm's raw report can list the same GHSA id under two
  // different numeric advisory ids (e.g. one per affected dependency path).
  const report = fakeAuditReport({
    advisories: {
      111: { id: 111, github_advisory_id: 'GHSA-aaaa-aaaa-aaaa' },
      112: { id: 112, github_advisory_id: 'GHSA-aaaa-aaaa-aaaa' },
    },
  })
  const ids = extractAdvisoryIds(report)
  assert.equal(ids.size, 1)
})

test('extractAdvisoryIds handles an empty/missing advisories object', () => {
  assert.deepEqual([...extractAdvisoryIds({})], [])
  assert.deepEqual([...extractAdvisoryIds({ advisories: {} })], [])
})

test('severityCounts reads pnpm audit metadata.vulnerabilities verbatim', () => {
  const report = fakeAuditReport({ vulnerabilities: { low: 10, moderate: 64, high: 58, critical: 3 } })
  assert.deepEqual(severityCounts(report), { info: 0, low: 10, moderate: 64, high: 58, critical: 3 })
})

test('severityCounts defaults missing fields to 0 rather than throwing', () => {
  assert.deepEqual(severityCounts({}), { info: 0, low: 0, moderate: 0, high: 0, critical: 0 })
})

// --- the core behavior this whole script exists for ------------------------

test('diffAdvisories: a PRE-EXISTING advisory (in both current and baseline) is not reported as new', () => {
  const baseline = ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb']
  const current = new Set(['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb'])
  const { newAdvisories, resolved, stillPresent } = diffAdvisories(current, baseline)
  assert.deepEqual(newAdvisories, [])
  assert.deepEqual(resolved, [])
  assert.deepEqual(stillPresent, ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb'])
})

test('diffAdvisories: a NEW advisory not present in the baseline IS reported as new', () => {
  const baseline = ['GHSA-aaaa-aaaa-aaaa']
  const current = new Set(['GHSA-aaaa-aaaa-aaaa', 'GHSA-zzzz-zzzz-zzzz'])
  const { newAdvisories, stillPresent } = diffAdvisories(current, baseline)
  assert.deepEqual(newAdvisories, ['GHSA-zzzz-zzzz-zzzz'])
  assert.deepEqual(stillPresent, ['GHSA-aaaa-aaaa-aaaa'])
})

test('diffAdvisories: a baselined advisory absent from the current run is reported as resolved, not new', () => {
  const baseline = ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb']
  const current = new Set(['GHSA-aaaa-aaaa-aaaa'])
  const { newAdvisories, resolved } = diffAdvisories(current, baseline)
  assert.deepEqual(newAdvisories, [])
  assert.deepEqual(resolved, ['GHSA-bbbb-bbbb-bbbb'])
})

test('diffAdvisories: mixed case — one resolved, one still present, one genuinely new', () => {
  const baseline = ['GHSA-old-1', 'GHSA-old-2']
  const current = new Set(['GHSA-old-1', 'GHSA-new-1'])
  const { newAdvisories, resolved, stillPresent } = diffAdvisories(current, baseline)
  assert.deepEqual(newAdvisories, ['GHSA-new-1'])
  assert.deepEqual(resolved, ['GHSA-old-2'])
  assert.deepEqual(stillPresent, ['GHSA-old-1'])
})

test('diffAdvisories: empty current and empty baseline is a clean pass, not a crash', () => {
  const { newAdvisories, resolved, stillPresent } = diffAdvisories(new Set(), [])
  assert.deepEqual(newAdvisories, [])
  assert.deepEqual(resolved, [])
  assert.deepEqual(stillPresent, [])
})

// --- end-to-end against the actual repo baseline shape ----------------------

test('end-to-end: extractAdvisoryIds -> diffAdvisories correctly distinguishes new vs pre-existing', () => {
  const baselineIds = ['GHSA-existing-1', 'GHSA-existing-2']
  const prReport = fakeAuditReport({
    advisories: {
      1: { id: 1, github_advisory_id: 'GHSA-existing-1' }, // pre-existing, must not fail
      2: { id: 2, github_advisory_id: 'GHSA-introduced-by-this-pr' }, // new, must fail
    },
    vulnerabilities: { high: 2 },
  })
  const currentIds = extractAdvisoryIds(prReport)
  const { newAdvisories, resolved } = diffAdvisories(currentIds, baselineIds)

  assert.deepEqual(newAdvisories, ['GHSA-introduced-by-this-pr'], 'a genuinely new advisory must be flagged')
  assert.deepEqual(resolved, ['GHSA-existing-2'], 'a baselined advisory no longer present must be reported as resolved')
  assert.ok(!newAdvisories.includes('GHSA-existing-1'), 'a pre-existing advisory must never be reported as new')
})
