#!/usr/bin/env node
/**
 * dependency-audit-diff — compare a `pnpm audit --json` run against the
 * dependency-audit baseline (audit/factory/dependency-audit-baseline.json).
 *
 * Modeled directly on testdiff.mjs's approach to test regressions: compare
 * failure/advisory IDENTITIES, not raw counts, against a captured baseline.
 *
 * TRO-244 (assignment rule 4, "dependency audit (`pnpm audit`)"): at capture
 * time this repo carried 135 pre-existing advisory findings across its
 * dependency tree (10 low / 64 moderate / 58 high / 3 critical — see
 * audit/factory/dependency-audit-baseline.json and CHANGES.md for the full
 * rationale). A naive `pnpm audit --audit-level=high` step would fail on ALL
 * of them, immediately redding every PR in flight, including this one. So —
 * exactly like the test quarantine — a PR only fails this check if it
 * introduces a NEW advisory that was not already present in the baseline.
 * Fixing/upgrading away a baselined advisory is reported as "resolved," not a
 * failure; letting a resolved one regress back in (after it is removed from
 * the baseline) is treated as new again.
 *
 * Usage:
 *   node dependency-audit-diff.mjs --current audit.json \
 *     --baseline audit/factory/dependency-audit-baseline.json
 *
 * Exit 0 = no new advisories. Exit 1 = new advisory(ies) found (regression).
 * Exit 2 = could not evaluate (unreadable/unparsable input).
 *
 * If GITHUB_STEP_SUMMARY is set (true inside GitHub Actions), a markdown
 * summary is appended there so the severity counts are visible on every run,
 * not only on failure.
 */

import { readFileSync, appendFileSync } from 'node:fs'

export function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1 || i === argv.length - 1) return fallback
  return argv[i + 1]
}

export function readJson(path, what) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read ${what} at ${path}: ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${what} at ${path} is not valid JSON: ${err.message}`)
  }
}

/**
 * Extract the set of advisory identities from a `pnpm audit --json` report.
 * Identity = the GHSA id (`github_advisory_id`) when present — stable across
 * registries, and the same identifier a human would search for — falling
 * back to the numeric advisory `id` pnpm/npm always assign, prefixed so it
 * can never collide with a GHSA-shaped string.
 */
export function extractAdvisoryIds(report) {
  const advisories = report?.advisories ?? {}
  const ids = new Set()
  for (const advisory of Object.values(advisories)) {
    if (!advisory) continue
    const id = advisory.github_advisory_id || (advisory.id != null ? `pnpm-advisory-${advisory.id}` : null)
    if (id) ids.add(id)
  }
  return ids
}

/**
 * Severity counts exactly as `pnpm audit`'s own `metadata.vulnerabilities`
 * block reports them — by finding (advisory x affected dependency path), not
 * by unique advisory, which is what pnpm's own human-readable summary line
 * prints and what this repo's 135 (10/64/58/3) figure refers to.
 */
export function severityCounts(report) {
  const v = report?.metadata?.vulnerabilities ?? {}
  return {
    info: v.info ?? 0,
    low: v.low ?? 0,
    moderate: v.moderate ?? 0,
    high: v.high ?? 0,
    critical: v.critical ?? 0,
  }
}

export function diffAdvisories(currentIds, baselineIds) {
  const known = new Set(baselineIds)
  const now = new Set(currentIds)
  const newAdvisories = [...now].filter((id) => !known.has(id)).sort()
  const resolved = [...known].filter((id) => !now.has(id)).sort()
  const stillPresent = [...now].filter((id) => known.has(id)).sort()
  return { newAdvisories, resolved, stillPresent }
}

// --- CLI entry point ---------------------------------------------------
// Guarded so dependency-audit-diff.test.mjs can import the pure functions
// above without triggering file reads / process.exit / GITHUB_STEP_SUMMARY
// writes as a side effect of import.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const currentPath = arg(process.argv, 'current')
  const baselinePath = arg(process.argv, 'baseline')

  if (!currentPath || !baselinePath) {
    console.error(
      'usage: dependency-audit-diff.mjs --current <pnpm-audit.json> --baseline <dependency-audit-baseline.json>'
    )
    process.exit(2)
  }

  let current, baseline
  try {
    current = readJson(currentPath, 'current pnpm audit run')
    baseline = readJson(baselinePath, 'dependency-audit baseline')
  } catch (err) {
    console.error(`dependency-audit-diff: ${err.message}`)
    process.exit(2)
  }

  const currentIds = extractAdvisoryIds(current)
  const baselineIds = new Set(baseline?.knownAdvisories ?? [])
  const { newAdvisories, resolved, stillPresent } = diffAdvisories(currentIds, baselineIds)
  const counts = severityCounts(current)
  const verdict = newAdvisories.length === 0 ? 'pass' : 'fail'

  const result = {
    verdict,
    severityCounts: counts,
    counts: {
      baselineAdvisories: baselineIds.size,
      currentAdvisories: currentIds.size,
      newAdvisories: newAdvisories.length,
      resolved: resolved.length,
      stillPresent: stillPresent.length,
    },
    newAdvisories,
    resolved,
  }

  console.log(JSON.stringify(result, null, 2))

  if (verdict === 'fail') {
    console.error(`\ndependency-audit-diff: ${newAdvisories.length} NEW advisory(ies) not present in the baseline:`)
    for (const id of newAdvisories) console.error(`  - ${id}`)
  } else if (resolved.length > 0) {
    console.error(`\ndependency-audit-diff: ${resolved.length} previously-baselined advisory(ies) no longer present:`)
    for (const id of resolved) console.error(`  + ${id}`)
    console.error('If this was a deliberate fix, remove them from the baseline file so a regression is caught again.')
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const lines = [
      '### Dependency audit (`pnpm audit`) — baseline diff',
      '',
      '| Severity | Count |',
      '|---|---:|',
      `| Critical | ${counts.critical} |`,
      `| High | ${counts.high} |`,
      `| Moderate | ${counts.moderate} |`,
      `| Low | ${counts.low} |`,
      `| **Total** | **${counts.critical + counts.high + counts.moderate + counts.low}** |`,
      '',
      `Baseline: ${baselineIds.size} known advisories (captured ${baseline?.capturedAt ?? 'unknown'}). ` +
        `Current: ${currentIds.size}. New: ${newAdvisories.length}. Resolved since baseline: ${resolved.length}.`,
      '',
      verdict === 'pass'
        ? 'No new advisories vs. the baseline — pre-existing findings above are tracked, not gated. See CHANGES.md (TRO-244).'
        : `**FAILING**: ${newAdvisories.length} new advisory(ies) introduced — ${newAdvisories.join(', ')}`,
      '',
    ]
    appendFileSync(summaryPath, lines.join('\n') + '\n')
  }

  process.exit(verdict === 'pass' ? 0 : 1)
}
