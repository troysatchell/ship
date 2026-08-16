import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

/**
 * TRO-437 / PF-906 — "committed; claims follow CLAUDE.md provenance
 * discipline (observed vs derived, evidence linked)" (ticket AC, verbatim).
 *
 * Same spirit as `architectureDocSections.test.ts` (TRO-424/PF-903) and, one
 * level further back, `pinnedDependencies.test.ts`: a pure structural lint
 * over committed docs, one `it()` per requirement, asserting presence of
 * required shape/keywords — NOT technical accuracy of any individual claim.
 * A section that uses the right headings and cites a file that doesn't
 * exist still passes this suite; that class of error is out of scope for a
 * mechanical presence check (the same limitation
 * `architectureDocSections.test.ts`'s own header names for its doc).
 *
 * RED-BEFORE note: a missing doc file throwing out of `readDoc()` is not a
 * valid red for this suite — same non-diagnostic-failure class
 * `architectureDocSections.test.ts` warns against. The valid red actually
 * produced while writing this suite: three of the seven closed-epic
 * sections (E2, E6, E8) had used an embellished label — "**Proof — this
 * epic's real center of gravity...**", "**After — the graded metric
 * itself.**", "**Fix — all 5 committed integrations...**" — instead of the
 * plain "**Fix.**"/"**After.**"/"**Proof.**" every other section used, so
 * the shape-check `it()` failed independently for each of those three,
 * naming exactly which label was missing per epic; a fourth failure (the
 * citation-count floor) caught the regex initially undercounting real
 * citations to `.sql`/`.json`/`.mjs` files, not just `.ts`. Both were fixed
 * in the doc/test respectively, not by loosening either check to match
 * whatever the draft happened to contain.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')

const EPIC_WRITEUPS_PATH = join(REPO_ROOT, 'docs/submission/PLUGFORGE-EPIC-WRITEUPS.md')
const DISCOVERIES_PATH = join(REPO_ROOT, 'docs/submission/PLUGFORGE-DISCOVERIES.md')

function readDoc(path: string, relativeLabel: string): string {
  if (!existsSync(path)) {
    throw new Error(`${relativeLabel} does not exist at ${path}. TRO-437/PF-906 must commit it before this suite can assert on its content.`)
  }
  return readFileSync(path, 'utf8')
}

describe('PLUGFORGE-EPIC-WRITEUPS.md — per-epic before/fix/after/proof shape', () => {
  const doc = readDoc(EPIC_WRITEUPS_PATH, 'docs/submission/PLUGFORGE-EPIC-WRITEUPS.md')

  // Only epics with genuine closing proof as of writing — see the doc's own
  // intro for why E5 and E7 are excluded here (checked separately below).
  const CLOSED_EPICS = [
    'Epic E0',
    'Epic E1',
    'Epic E2',
    'Epic E3',
    'Epic E4',
    'Epic E6',
    'Epic E8',
  ]

  it.each(CLOSED_EPICS)('has a heading for %s', (epicLabel) => {
    expect(doc).toContain(epicLabel)
  })

  it.each(CLOSED_EPICS)('%s has the mandated Before/Fix/After/Proof shape', (epicLabel) => {
    const headingIdx = doc.indexOf(`## ${epicLabel}`)
    expect(headingIdx, `${epicLabel} heading not found as an H2`).toBeGreaterThan(-1)
    const nextHeadingIdx = doc.indexOf('\n## ', headingIdx + 1)
    const section = nextHeadingIdx === -1 ? doc.slice(headingIdx) : doc.slice(headingIdx, nextHeadingIdx)
    expect(section, `${epicLabel} is missing "**Before.**"`).toMatch(/\*\*Before\.\*\*/)
    expect(section, `${epicLabel} is missing "**Fix.**"`).toMatch(/\*\*Fix\.\*\*/)
    expect(section, `${epicLabel} is missing "**After.**"`).toMatch(/\*\*After\.\*\*/)
    expect(section, `${epicLabel} is missing "**Proof.**"`).toMatch(/\*\*Proof\.\*\*/)
  })

  it('explicitly defers E5 and E7 rather than silently omitting them', () => {
    // E5/E7 have no closing proof yet — PF-503 wasn't merged and PF-704 was
    // still Backlog as of writing. Omitting them without saying why would
    // read as "forgotten," not "deliberately not yet ready."
    expect(doc).toMatch(/E5.*not closed|E5.{0,80}not closed/is)
    expect(doc).toMatch(/E7.*(PF-704|Backlog|in-progress|not closed)/is)
  })

  it('cites real file:line evidence, not prose-only claims', () => {
    // Heuristic, not exhaustive: a doc built on real citations has many
    // `path/to/file.ext[:NN]`-shaped references (code files with a line
    // number, or config/migration files cited by name alone). A threshold
    // well below the actual authored count catches a doc that regressed to
    // unsupported prose without being brittle to minor rewording.
    const citationLikePattern = /`[\w/-]+\.(ts|sql|json|mjs)(:\d+(-\d+)?)?`/g
    const matches = doc.match(citationLikePattern) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(20)
  })
})

describe('PLUGFORGE-DISCOVERIES.md — three provenance-disciplined discovery essays', () => {
  const doc = readDoc(DISCOVERIES_PATH, 'docs/submission/PLUGFORGE-DISCOVERIES.md')

  it('has exactly three discovery sections', () => {
    const matches = doc.match(/^## Discovery:/gm) ?? []
    expect(matches.length).toBe(3)
  })

  it('marks claims Observed vs Derived per the provenance rule', () => {
    const observedCount = (doc.match(/\*\*Observed/g) ?? []).length
    expect(observedCount).toBeGreaterThanOrEqual(3)
  })

  it('is a distinct W6 document, not a silent edit of the stale Week-4 DISCOVERY.md', () => {
    expect(doc).toMatch(/DISCOVERY\.md/)
    expect(doc.toLowerCase()).toMatch(/leftover week-4|week-4 document|distinct.{0,40}document|new.{0,40}document/)
  })
})
