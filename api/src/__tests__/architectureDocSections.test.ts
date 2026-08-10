import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

/**
 * TRO-424 / PF-903 — "Doc committed with all mandated sections present
 * (checklist in PR)" (ticket Proof line, verbatim).
 *
 * `docs/architecture.md` is a **living doc**: PF-903 starts it Day 1 as a
 * skeleton and it grows as later epics land (ticket's own instruction:
 * "Start Day 1 skeleton, update as epics land; final pass near submission").
 * This is a pure section-presence lint, in the same spirit as
 * `pinnedDependencies.test.ts` — it reads a repo file and asserts required
 * content is present, one `it()` per mandated requirement from the ticket's
 * "Architect notes" block. It does NOT assert technical accuracy, diagram
 * correctness, or file-path freshness — only that the required keywords /
 * headings exist. A doc using the right words in a wrong diagram still
 * passes; catching that is the human PR checklist the ticket's Proof line
 * already names (see the test-design comment on TRO-424, 2026-08-10).
 *
 * RED-BEFORE note (do not skip this on a re-read): a missing
 * `docs/architecture.md` throwing `ENOENT` out of `readDoc()` is NOT a valid
 * red for this suite — it is the same failure class as an import error and
 * fails every `it()` below for one identical, undiagnostic reason instead of
 * naming which section is missing. The valid red (see TRO-424's PR
 * description / CHANGES.md entry for the captured run) was produced against
 * a deliberately partial `docs/architecture.md` — some mandated sections
 * present, most absent — so each `it()` failed independently with its own
 * message naming the missing section.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')
const DOC_RELATIVE_PATH = 'docs/architecture.md'
const DOC_PATH = join(REPO_ROOT, DOC_RELATIVE_PATH)
// PF-902's IAM adaptation memo — landed at this path on branch docs/pf-902-iam-memo
// (not yet merged to main as of this writing). Cross-ticket fact relayed by the
// orchestrator, not independently verified by reading that file from this
// worktree (CLAUDE.md provenance: derived, not observed).
const IAM_MEMO_PATH = 'docs/IAM-ADAPTATION-RENDER.md'

function readDoc(): string {
  if (!existsSync(DOC_PATH)) {
    throw new Error(
      `${DOC_RELATIVE_PATH} does not exist at ${DOC_PATH}. Create the PF-903 Day-1 skeleton ` +
        '(TRO-424) before this suite can assert on its section content.'
    )
  }
  return readFileSync(DOC_PATH, 'utf8')
}

function indicesOf(haystack: string, needle: string): number[] {
  const idxs: number[] = []
  if (!needle) return idxs
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    idxs.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return idxs
}

/** True if `termA` and (any of) `termsB` occur within `windowChars` characters of each other, anywhere in `text`. */
function isNearAny(text: string, termA: string, termsB: string[], windowChars: number): boolean {
  const lower = text.toLowerCase()
  const aIdxs = indicesOf(lower, termA.toLowerCase())
  return termsB.some((termB) => {
    const bIdxs = indicesOf(lower, termB.toLowerCase())
    return aIdxs.some((a) => bIdxs.some((b) => Math.abs(a - b) <= windowChars))
  })
}

function headingLines(text: string): string[] {
  return text.split('\n').filter((line) => /^#{1,6}\s/.test(line))
}

describe('docs/architecture.md — mandated sections present (PF-903 / TRO-424)', () => {
  it('exists at docs/architecture.md', () => {
    expect(existsSync(DOC_PATH), `${DOC_RELATIVE_PATH} should exist — create the PF-903 Day-1 skeleton`).toBe(true)
  })

  it('1. Module layout tree — a heading for the module layout, listing api/src/platform/, sdk/, integrations/', () => {
    const text = readDoc()
    const hasHeading = headingLines(text).some((h) => /module\s*layout/i.test(h))
    expect(hasHeading, 'Expected a heading mentioning "Module Layout" (or equivalent)').toBe(true)

    const missingPaths = ['api/src/platform/', 'sdk/', 'integrations/'].filter((p) => !text.includes(p))
    expect(missingPaths, `Module layout tree should list these paths: ${missingPaths.join(', ')}`).toEqual([])
  })

  it('2a. SOLID rationale — ScopeRegistry near OCP / Open/Closed', () => {
    const text = readDoc()
    expect(text.includes('ScopeRegistry'), 'Expected "ScopeRegistry" to appear in the SOLID rationale').toBe(true)
    expect(
      isNearAny(text, 'ScopeRegistry', ['OCP', 'Open/Closed', 'Open-Closed'], 400),
      'Expected "ScopeRegistry" to appear near "OCP" / "Open/Closed" (within 400 chars)'
    ).toBe(true)
  })

  it('2b. SOLID rationale — IEventBus near DIP / Dependency Inversion', () => {
    const text = readDoc()
    expect(text.includes('IEventBus'), 'Expected "IEventBus" to appear in the SOLID rationale').toBe(true)
    expect(
      isNearAny(text, 'IEventBus', ['DIP', 'Dependency Inversion'], 400),
      'Expected "IEventBus" to appear near "DIP" / "Dependency Inversion" (within 400 chars)'
    ).toBe(true)
  })

  it('2c. SOLID rationale — SDK resource clients near ISP / Interface Segregation', () => {
    const text = readDoc()
    const hasTerm = /SDK resource clients/i.test(text)
    expect(hasTerm, 'Expected "SDK resource clients" (or similar) to appear in the SOLID rationale').toBe(true)
    expect(
      isNearAny(text, 'SDK resource clients', ['ISP', 'Interface Segregation'], 400),
      'Expected "SDK resource clients" to appear near "ISP" / "Interface Segregation" (within 400 chars)'
    ).toBe(true)
  })

  it('3. Composition-root pseudo-code — mentions app.ts, a fenced code block, and "in-memory" test wiring', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!text.includes('app.ts')) missing.push('mention of app.ts')
    if (!/```/.test(text)) missing.push('a fenced code block')
    if (!/in-memory/i.test(text)) missing.push('mention of "in-memory" (test wiring sibling)')
    expect(missing, `Composition-root section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('4. Public/internal boundary sequence diagram — a heading mentioning "boundary" and "sequence"', () => {
    const text = readDoc()
    const hasHeading = headingLines(text).some((h) => /boundary/i.test(h) && /sequence/i.test(h))
    expect(
      hasHeading,
      'Expected a heading mentioning both "boundary" and "sequence" (the public/internal boundary sequence diagram)'
    ).toBe(true)
  })

  it('5. OAuth flow diagrams — mentions PKCE, rotation, and Device Authorization Grant', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!/PKCE/i.test(text)) missing.push('PKCE')
    if (!/rotation/i.test(text)) missing.push('rotation')
    if (!/Device Authorization Grant/i.test(text)) missing.push('Device Authorization Grant')
    expect(missing, `OAuth flow section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('6. Webhook pipeline — mentions signature and Idempotency-Key', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!/signature/i.test(text)) missing.push('signature')
    if (!/Idempotency-Key/i.test(text)) missing.push('Idempotency-Key')
    expect(missing, `Webhook pipeline section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('7. SDK surface — mentions stable and pre-1.0 marks', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!/stable/i.test(text)) missing.push('stable')
    if (!/pre-?1\.0/i.test(text)) missing.push('pre-1.0 (or "pre 1.0")')
    expect(missing, `SDK surface section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('8. Agent before/after — mentions before, after, and audit', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!/before/i.test(text)) missing.push('before')
    if (!/after/i.test(text)) missing.push('after')
    if (!/audit/i.test(text)) missing.push('audit')
    expect(missing, `Agent before/after section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('9. Failure modes — corrupted token store, secret rotation, deliverer crash, OpenAPI generator boot-throw', () => {
    const text = readDoc()
    const missing: string[] = []
    if (!/corrupted token store/i.test(text)) missing.push('"corrupted token store"')
    if (!/secret rotation/i.test(text)) missing.push('"secret rotation"')
    if (!/deliverer crash/i.test(text)) missing.push('"deliverer crash"')
    if (!/OpenAPI generator/i.test(text)) missing.push('"OpenAPI generator"')
    if (!/(boot-throw|boot throw|throws on boot)/i.test(text)) missing.push('"boot-throw" (or "boot throw" / "throws on boot")')
    expect(missing, `Failure modes section missing: ${missing.join(', ')}`).toEqual([])
  })

  it('10. Deviation 1 — signing secret encrypted-not-hashed', () => {
    const text = readDoc()
    const hasSigningSecret = /signing/i.test(text) && /secret/i.test(text)
    expect(hasSigningSecret, 'Expected "signing" and "secret" to appear').toBe(true)
    const hasEncryptedNearHash = isNearAny(text, 'hash', ['encrypted', 'encryption'], 400)
    expect(
      hasEncryptedNearHash,
      'Expected "encrypted"/"encryption" to appear near "hash" (the encrypted-not-hashed deviation)'
    ).toBe(true)
  })

  it('11. Deviation 2 — collab-persist event exclusion', () => {
    const text = readDoc()
    const hasCollab = /collab(oration)?/i.test(text)
    const hasPersist = /persist/i.test(text)
    const hasExclusion = /exclu(de|ded|sion)/i.test(text)
    const missing: string[] = []
    if (!hasCollab) missing.push('"collab"/"collaboration"')
    if (!hasPersist) missing.push('"persist"')
    if (!hasExclusion) missing.push('"exclude"/"excluded"/"exclusion"')
    expect(missing, `Collab-persist exclusion deviation missing: ${missing.join(', ')}`).toEqual([])
  })

  // 12. Cross-ticket (PF-902) — tightened to the real committed filename now that
  // PF-902 has landed at IAM_MEMO_PATH (see the constant above for provenance).
  // The test-design comment originally specced this item as a deferred marker
  // pending that filename. It is written as a real, always-run assertion rather
  // than a disabled test modifier: gate.sh's G5 check unconditionally fails a
  // newly added skip or todo test modifier in a *.test.ts diff (deliberately —
  // unlike a fixme-style modifier, which this repo reserves for Playwright e2e
  // specs and which vitest's `it` does not implement at all).
  it('12. references the PF-902 IAM adaptation memo by its committed filename', () => {
    const text = readDoc()
    expect(
      text.includes(IAM_MEMO_PATH),
      `Expected a reference to the PF-902 IAM adaptation memo at ${IAM_MEMO_PATH}`
    ).toBe(true)
  })
})
