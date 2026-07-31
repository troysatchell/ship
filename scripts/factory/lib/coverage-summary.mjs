#!/usr/bin/env node
/**
 * coverage-summary — read vitest's `json-summary` coverage reporter output for
 * one or more packages and append a markdown table to $GITHUB_STEP_SUMMARY
 * (or print to stdout when that's unset, e.g. run locally).
 *
 * TRO-244: kept out of ci.yml's `run:` blocks on purpose. An inline `node -e`
 * one-liner that embeds a JS template literal (backticks) inside a YAML
 * `run: |` bash block is exactly the kind of shell-quoting trap this ticket's
 * own dependency-audit-diff.mjs work ran into first — better as its own file.
 *
 * This script only REPORTS; it does not enforce anything. The actual coverage
 * floor is enforced by `coverage.thresholds` in api/vitest.config.ts and
 * web/vitest.config.ts (vitest fails `test:coverage` itself if under). The
 * floor numbers passed here are for the human-readable "Status" column only —
 * keep them in sync with those two config files by hand; there is no shared
 * source of truth for both today (YAGNI: two numbers, changed rarely).
 *
 * Usage:
 *   node coverage-summary.mjs --pkg api:api/coverage/coverage-summary.json:43 \
 *                              --pkg web:web/coverage/coverage-summary.json:20
 */

import { readFileSync, appendFileSync } from 'node:fs'

export function parsePkgArgs(argv) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pkg' && argv[i + 1] != null) {
      const [name, file, floorRaw] = argv[i + 1].split(':')
      out.push({ name, file, floor: Number(floorRaw) })
    }
  }
  return out
}

export function buildRow({ name, file, floor }, readFn = readFileSync) {
  try {
    const j = JSON.parse(readFn(file, 'utf8'))
    const pct = j?.total?.statements?.pct
    if (typeof pct !== 'number') {
      return { name, pct: null, floor, status: 'no statements.pct in report' }
    }
    return { name, pct, floor, status: pct >= floor ? 'ok' : 'BELOW FLOOR' }
  } catch (err) {
    return { name, pct: null, floor, status: `no report (${err.message})` }
  }
}

export function renderMarkdown(rows) {
  return [
    '### Test coverage (statements)',
    '',
    '| Package | Coverage | Floor | Status |',
    '|---|---:|---:|---|',
    ...rows.map((r) => `| ${r.name} | ${r.pct == null ? 'n/a' : r.pct + '%'} | ${r.floor}% | ${r.status} |`),
    '',
  ].join('\n')
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const pkgs = parsePkgArgs(process.argv.slice(2))
  if (pkgs.length === 0) {
    console.error('usage: coverage-summary.mjs --pkg <name>:<coverage-summary.json path>:<floor>')
    process.exit(2)
  }

  const rows = pkgs.map((p) => buildRow(p))
  const markdown = renderMarkdown(rows)

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, markdown + '\n')
  }
  // Always also print to the job log, summary or not — this is diagnostic
  // output, not something that should only exist inside the GH UI.
  console.log(markdown)
}
