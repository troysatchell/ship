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
    // CodeRabbit (PR #261): the two checks above only prove deferral TEXT
    // exists — they'd still pass if a half-written "## Epic E5" section were
    // added alongside it. A real H2 heading for either must not exist while
    // they're deferred; when one lands for real, this line (not the prose
    // checks above) is what should be updated to reflect the new epic.
    expect(doc).not.toMatch(/^## Epic E5\b/m)
    expect(doc).not.toMatch(/^## Epic E7\b/m)
  })

  it('cites real file:line evidence, not prose-only claims', () => {
    // CodeRabbit (PR #261): the line-number suffix was optional, so 20
    // filename-only references (real or invented) could satisfy the
    // threshold without pointing at a specific, checkable line. Code
    // citations (`.ts`) now REQUIRE `:NN`; config/migration/data files
    // (`.sql`/`.json`/`.mjs`) are legitimately cited whole-file (a migration
    // has no single "line" the way a claim about a function does), so those
    // stay optional on the line suffix.
    const codeCitationPattern = /`[\w/-]+\.ts:\d+(-\d+)?`/g
    const fileCitationPattern = /`[\w/-]+\.(sql|json|mjs)(:\d+(-\d+)?)?`/g
    const codeMatches = doc.match(codeCitationPattern) ?? []
    const fileMatches = doc.match(fileCitationPattern) ?? []
    expect(codeMatches.length, 'expected real file:line citations for .ts claims').toBeGreaterThanOrEqual(14)
    expect(codeMatches.length + fileMatches.length).toBeGreaterThanOrEqual(20)
  })
})

describe('PLUGFORGE-DISCOVERIES.md — three provenance-disciplined discovery essays', () => {
  const doc = readDoc(DISCOVERIES_PATH, 'docs/submission/PLUGFORGE-DISCOVERIES.md')

  function discoverySections(): string[] {
    const headingIdxs = [...doc.matchAll(/^## Discovery:.*$/gm)].map((m) => m.index ?? -1)
    return headingIdxs.map((idx, i) => doc.slice(idx, headingIdxs[i + 1] ?? doc.length))
  }

  it('has exactly three discovery sections', () => {
    expect(discoverySections().length).toBe(3)
  })

  it('marks claims Observed vs Derived in EVERY discovery, not just document-wide', () => {
    // CodeRabbit (PR #261): a document-wide count of 3 could all come from a
    // single well-cited section while the other two carried no provenance
    // markers at all. Require each section to carry its own.
    for (const section of discoverySections()) {
      const heading = section.split('\n', 1)[0]
      expect(section, `${heading} has no "**Observed" marker`).toMatch(/\*\*Observed/)
    }
  })

  it('is a distinct W6 document, not a silent edit/copy of the stale Week-4 DISCOVERY.md', () => {
    const staleDoc = readDoc(
      join(REPO_ROOT, 'docs/submission/DISCOVERY.md'),
      'docs/submission/DISCOVERY.md'
    )
    expect(doc).toMatch(/DISCOVERY\.md/)
    expect(doc.toLowerCase()).toMatch(/leftover week-4|week-4 document|distinct.{0,40}document|new.{0,40}document/)
    // CodeRabbit (PR #261): the two checks above only look for self-descriptive
    // WORDS in the new doc — a copy of the stale doc with those words pasted
    // in would still pass. Actually load the stale doc and assert the new
    // one's headings don't overlap with it, i.e. this is genuinely different
    // content, not a relabeled copy.
    const newHeadings = new Set((doc.match(/^##.*$/gm) ?? []).map((h) => h.trim()))
    const staleHeadings = new Set((staleDoc.match(/^##.*$/gm) ?? []).map((h) => h.trim()))
    const overlap = [...newHeadings].filter((h) => staleHeadings.has(h))
    expect(overlap, 'new discoveries doc shares headings verbatim with the stale Week-4 doc').toEqual([])
  })
})
