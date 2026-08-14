/**
 * TRO-426 / PF-301 AC, verbatim: "no publish calls exist in any route layer
 * (lint/grep check)."
 *
 * `IEventBus.publish()` is meant to live in exactly one place —
 * `api/src/services/documentService.ts` — so that every `documents` write goes
 * through the same event-derivation logic. This test is the grep: it walks
 * every route-layer source file (`api/src/routes/**` — the four consolidated
 * resource routers plus every sibling route file — and
 * `api/src/platform/api/v1/resources/**`, the v1 API's equivalent route layer)
 * and fails if any of them call `.publish(` or reach the event bus module
 * directly (`getEventBus`, or an import from `eventBus.js`).
 *
 * Deliberately a plain source-text scan, not an AST/ESLint rule (contrast
 * `platform/__tests__/boundary-lint.test.ts`, which does use real ESLint for an
 * import-path rule) — a call-site pattern like this doesn't need type
 * information or import resolution, and a plain scan is easy to verify by
 * inspection: read the regex, read what it matched.
 *
 * A grep with nothing to find proves nothing. The last test below is the
 * positive control: it asserts `documentService.ts` — the one file that is
 * SUPPOSED to call `publish()` — actually does, so a change that silently
 * stops calling `publish()` there (or a regex that stopped matching anything)
 * fails loudly instead of this whole test suite going quietly vacuous.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// api/src/platform/webhooks/__tests__ -> api/src
const API_SRC = join(__dirname, '../../..')

/** Recursively lists `.ts` files under `dir`, skipping `*.test.ts`. */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(fullPath))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

/** A call to `IEventBus.publish(...)`, or reaching the bus module directly. */
const PUBLISH_CALL_PATTERN = /\.publish\s*\(/
const EVENT_BUS_REACH_PATTERN = /getEventBus\s*\(|from\s+['"][^'"]*eventBus(\.js)?['"]/

function findViolations(files: string[]): Array<{ file: string; line: number; text: string }> {
  const violations: Array<{ file: string; line: number; text: string }> = []
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')
    lines.forEach((lineText, index) => {
      if (PUBLISH_CALL_PATTERN.test(lineText) || EVENT_BUS_REACH_PATTERN.test(lineText)) {
        violations.push({ file: relative(API_SRC, file), line: index + 1, text: lineText.trim() })
      }
    })
  }
  return violations
}

describe('TRO-426 / PF-301: publish() boundary — route layer must never call IEventBus directly', () => {
  it('api/src/routes/**/*.ts (excluding *.test.ts) contains zero publish()/getEventBus() call sites', () => {
    const files = listSourceFiles(join(API_SRC, 'routes'))
    // Sanity check on the walk itself: if this is 0, the glob is broken and
    // the assertion below is vacuous, not a real pass.
    expect(files.length).toBeGreaterThan(20)

    const violations = findViolations(files)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('api/src/platform/api/v1/resources/**/*.ts (excluding *.test.ts) contains zero publish()/getEventBus() call sites', () => {
    const files = listSourceFiles(join(API_SRC, 'platform/api/v1/resources'))
    expect(files.length).toBeGreaterThan(0)

    const violations = findViolations(files)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('positive control: documentService.ts DOES call publish() (the regex is not vacuous)', () => {
    const file = join(API_SRC, 'services/documentService.ts')
    const violations = findViolations([file])
    expect(violations.length).toBeGreaterThan(0)
  })
})
