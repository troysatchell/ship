import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

/**
 * TRO-434 / PF-905 — "committed doc; figures traceable to ledger/CI data,
 * not vibes" (ticket AC, verbatim).
 *
 * Same pattern as `architectureDocSections.test.ts` (TRO-424/PF-903) and
 * `epicWriteupsAndDiscoveries.test.ts` (TRO-437/PF-906): a pure structural
 * presence lint over a committed doc, one `it()` per mandated requirement —
 * NOT an assertion that any individual figure is technically correct. A
 * section using the right words with a stale number still passes this
 * suite; verifying the actual arithmetic is a human-review concern, same
 * limitation those two prior suites' own headers name for their docs.
 *
 * What this suite specifically guards against, because both are real
 * mistakes this ticket's own brief called out by name:
 *  1. Silently filling in the Epic-7 cost-ledger section with an estimate
 *     instead of leaving it as the mandated TODO placeholder (PR #263 /
 *     PF-704 is still open — the ticket brief is explicit that guessing
 *     here is worse than an honest gap).
 *  2. Colliding with `docs/submission/AI-COST-ANALYSIS.md`, a DIFFERENT,
 *     earlier W4-scoped doc this ticket must not overwrite.
 *
 * RED-BEFORE note: a missing `docs/submission/PF-905-AI-COST-ANALYSIS.md`
 * throwing out of `readDoc()` is not a valid red for this suite (same
 * non-diagnostic-failure class the two prior doc-lint suites warn against).
 * The valid red actually produced while writing this suite: the first draft
 * of the TODO placeholder line ended with a period the ticket's own mandated
 * text does not have ("...from estimates." vs "...from estimates" before the
 * em dash), which the exact-match assertion below caught — fixed in the doc,
 * not by loosening the assertion to `.toContain('TODO(TRO-434)')` alone.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')

const DOC_RELATIVE_PATH = 'docs/submission/PF-905-AI-COST-ANALYSIS.md'
const DOC_PATH = join(REPO_ROOT, DOC_RELATIVE_PATH)
const OLDER_W4_DOC_PATH = join(REPO_ROOT, 'docs/submission/AI-COST-ANALYSIS.md')

function readDoc(path: string, relativeLabel: string): string {
  if (!existsSync(path)) {
    throw new Error(`${relativeLabel} does not exist at ${path}. TRO-434/PF-905 must commit it before this suite can assert on its content.`)
  }
  return readFileSync(path, 'utf8')
}

describe('PF-905-AI-COST-ANALYSIS.md — required sections and provenance discipline', () => {
  const doc = readDoc(DOC_PATH, DOC_RELATIVE_PATH)

  it('does not collide with the earlier, distinct W4-scoped AI-COST-ANALYSIS.md', () => {
    // This ticket's own brief calls this out as a named trap: PF-905 is a
    // NEW, separate W6 doc, not a rewrite of the W4 audit-sprint tooling-spend
    // report. Both files must exist independently.
    expect(existsSync(OLDER_W4_DOC_PATH), 'the earlier W4 doc must not have been deleted/overwritten').toBe(true)
    expect(doc).toMatch(/AI-COST-ANALYSIS\.md/)
    expect(doc.toLowerCase()).toContain('w4')
  })

  it('states the platform-is-LLM-free premise and corrects it with real file:line citations', () => {
    expect(doc).toMatch(/LLM-free/)
    // The two real call sites this doc found — the agent path PLUGFORGE.MD
    // already names, and the second, pre-Week-6 path it does not.
    expect(doc).toContain('agent/src/graph.ts')
    expect(doc).toContain('api/src/services/ai-analysis.ts')
  })

  it('fills the Epic-7 cost-ledger section (§2.1) with the TRO-620 measured numbers, not the old TODO placeholder or an estimate', () => {
    // TRO-620 replaced the literal TODO(TRO-434) placeholder with real
    // ledger rows. Assert the measured content is present AND that the
    // placeholder line itself is gone (a doc that carries both is a doc
    // that was appended to, not corrected).
    const oldPlaceholder =
      '> TODO(TRO-434): pull real numbers from docs/submission/PF-704-COST-LEDGER-DELTA.md once PR #263 (TRO-440/PF-704) merges — do not fill this in from estimates.'
    expect(doc).not.toContain(oldPlaceholder)
    expect(doc).toContain('### 2.1 LLM spend during Epic 7 (cost-ledger before/after)')
    expect(doc).toMatch(/MEASURED \(TRO-620/)
    // The three committed ledgers the numbers come from.
    expect(doc).toContain('docs/submission/cost-ledger/tro-620-{internal,sdk,sdk-before-fix}.jsonl')
    // The headline numbers, as recorded (3 turns each): identical input
    // tokens internal vs post-fix sdk, and the pre-fix sdk collapse.
    expect(doc).toMatch(/`AGENT_PLATFORM_MODE=internal`.*\|\s*1274\s*\|\s*637\s*\|/)
    expect(doc).toMatch(/`AGENT_PLATFORM_MODE=sdk`, after TRO-620.*\|\s*1274\s*\|\s*619\s*\|\s*\*\*0\.0%\*\*/)
    expect(doc).toMatch(/`AGENT_PLATFORM_MODE=sdk`, before TRO-620.*\|\s*197\s*\|\s*323\s*\|\s*\*\*−84\.5%\*\*/)
    // The boundary of what was measured stays explicit.
    expect(doc).toContain('composeStandupDraft')
    expect(doc).toMatch(/were not run/)
  })

  it('confirms PR #263 was checked as open/unmerged rather than assumed', () => {
    expect(doc).toMatch(/#263/)
    expect(doc.toLowerCase()).toMatch(/open|unmerged/)
  })

  const REQUIRED_SUBSECTIONS = [
    'TTFE CI minutes',
    'Playwright OAuth compute',
    'Spec-gen overhead',
    'Delivery-log storage growth',
  ]
  it.each(REQUIRED_SUBSECTIONS)('has a dev-cost-tracking subsection for: %s', (label) => {
    expect(doc).toContain(label)
  })

  it('has the mandated production-projection tiers: 100 / 1,000 / 10,000 / 100,000 users', () => {
    expect(doc).toMatch(/100\s*\/\s*1,?000\s*\/\s*10,?000\s*\/\s*100,?000/)
  })

  const REQUIRED_ASSUMPTIONS = ['webhook fanout ratio', 'agent active rate', 'retention window']
  it.each(REQUIRED_ASSUMPTIONS)('explicitly names the assumption: %s', (label) => {
    expect(doc.toLowerCase()).toContain(label.toLowerCase())
  })

  it('tags every major figure as OBSERVED, DERIVED, ASSUMED, or TODO — not presented as one undifferentiated claim', () => {
    expect(doc).toMatch(/\*\*OBSERVED\*\*/)
    expect(doc).toMatch(/\*\*DERIVED\*\*/)
    expect(doc).toMatch(/\*\*ASSUMED\*\*/)
    expect(doc).toMatch(/\*\*TODO\*\*/)
  })

  it('deliberately states no dollar figures are invented from memory', () => {
    expect(doc.toLowerCase()).toMatch(/no dollar figures|no \$\/month figure|deliberately absent/)
  })

  it('cites real file:line/config evidence, not prose-only claims', () => {
    // Same heuristic-not-exhaustive density floor as epicWriteupsAndDiscoveries.test.ts:
    // catches a doc that regressed to unsupported prose without being brittle
    // to minor rewording. This doc also cites .yml/.tf files the prior pattern
    // didn't need to, so the extension list is broadened accordingly.
    const citationLikePattern = /`[\w./-]+\.(ts|tsx|sql|json|mjs|yml|tf)(:\d+(-\d+)?)?`/g
    const matches = doc.match(citationLikePattern) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(20)
  })
})
