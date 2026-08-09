/**
 * Regression test for TRO-371.
 *
 * CHANGES.md's own header states its purpose: "what was added, how to run it, and
 * how to roll it back" — for the next engineer inheriting the codebase, not for
 * graders. A sweep found 13 entries missing a rollback section and 6 missing
 * run/test instructions. Reconciling that sweep against the actual file (not
 * assumed from its list — see the CHANGES.md entry for this ticket) found the
 * real numbers were different: only one entry ("Bundle TRO-330") had no rollback
 * content anywhere, and seven had no run/test content anywhere — TRO-359,
 * TRO-360, "Bundle TRO-330", TRO-325, TRO-293, TRO-294 and TRO-302. All eight
 * gaps (one entry, Bundle TRO-330, was missing both) are fixed as part of this
 * ticket.
 *
 * This test is the mechanical check that keeps that fix from decaying: every
 * entry must carry (a) a description of what was built, (b) how to run/verify it
 * locally, and (c) how to roll it back. It is deliberately e.g. more permissive
 * than `scripts/factory/merge-changes.mjs --check`, whose RUN_RE/ROLLBACK_RE only
 * recognize a handful of exact headings ("How to run it.", "Rollback.", "Roll
 * back.", "How to roll it back.") and — by that script's own header comment —
 * are known to false-positive on healthy entries that use different wording, e.g.
 * "How to verify.", "How to reproduce.", "Verification.", or a fenced command
 * block with no heading at all. That's why merge-changes.mjs treats those as
 * non-fatal warnings rather than failures. This test recognizes the real,
 * observed vocabulary this file already uses for both elements (read directly
 * out of CHANGES.md before writing this regex, not guessed at) so it does not
 * cry wolf on a legitimately-documented entry and get disabled — while still
 * catching an entry that documents neither element at all, under any heading.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const changesLogPath = resolve(here, '../../../CHANGES.md');
const changesLog = readFileSync(changesLogPath, 'utf8');

interface ChangesEntry {
  heading: string;
  body: string;
}

/** Split CHANGES.md into per-ticket entries on top-level `## ` headings. The
 * text before the first heading is the file's own preamble (the audit-baseline
 * note), not a ticket entry, and is dropped. */
function parseEntries(text: string): ChangesEntry[] {
  const headingRe = /^## .+$/gm;
  const matches = [...text.matchAll(headingRe)];
  return matches.map((m, i) => {
    const start = m.index ?? 0;
    const next = matches[i + 1];
    const end = next !== undefined ? (next.index ?? text.length) : text.length;
    return { heading: m[0], body: text.slice(start, end) };
  });
}

// A bolded heading LINE naming a rollback procedure. Observed headings in this
// file: "Rollback.", "Rollback:", "Rollback", "Roll back.", "How to roll it
// back.", "Rollback (whole bundle).". Matching on the word itself (rather than
// requiring one exact heading) covers all of them, plus any future author's
// reasonable variant, without requiring a specific phrasing. Anchored to the
// START of the line (not "anywhere in the entry") deliberately: a few entries
// mention "rollback" inside an unrelated bolded phrase mid-bullet (e.g. "**A
// deliberately broken build demonstrates rollback.**" in the Bundle TRO-330
// entry, describing what a *different* ticket proved, not this entry's own
// rollback procedure) — matching anywhere would treat that as a rollback
// section and miss the real gap it sits next to.
const ROLLBACK_RE = /^\*\*[^*]*\b(?:rollback|roll\s*(?:it\s*)?back)\b[^*]*\*\*/im;

// A bolded heading LINE naming how to run, verify, test or reproduce the
// change locally. Observed headings: "How to run it.", "How to verify.", "How
// to verify locally.", "How to reproduce.", "How to re-capture.", "How to
// run/test locally.", "Run it.", "Verification.", "Verified nothing broke",
// a dedicated "Tests:" section — or, in a few entries, no heading at all, just
// a fenced command block giving the reproduction steps directly. Anchored to
// the start of the line for the same reason as ROLLBACK_RE above.
const RUN_HEADING_RE =
  /^\*\*[^*]*\b(?:how to (?:run|verify|test|reproduce|re-?capture)|run\/test|run it|verification|verified nothing broke)\b[^*]*\*\*/im;
const RUN_TESTS_HEADING_RE = /^\*\*Tests:?\*\*/im;
const RUN_CODEBLOCK_RE = /```[\s\S]*?\b(?:pnpm|npm|npx|vitest|playwright)\b[\s\S]*?```/i;

function hasRollbackSection(entry: ChangesEntry): boolean {
  return ROLLBACK_RE.test(entry.body);
}

function hasRunInstructions(entry: ChangesEntry): boolean {
  return (
    RUN_HEADING_RE.test(entry.body) ||
    RUN_TESTS_HEADING_RE.test(entry.body) ||
    RUN_CODEBLOCK_RE.test(entry.body)
  );
}

function isProceduralBlock(block: string): boolean {
  return ROLLBACK_RE.test(block) || RUN_HEADING_RE.test(block) || RUN_TESTS_HEADING_RE.test(block);
}

// A bolded heading LINE starting a labeled sub-section, e.g. "**What changed.**"
// or "**How to run it.**" — the same convention ROLLBACK_RE/RUN_HEADING_RE key
// off of, just not restricted to those two vocabularies. Used to chop an
// entry's body into blocks so the rollback/run blocks can be excluded wholesale
// rather than only their heading line.
const BLOCK_HEADING_RE = /^\*\*[^*\n]+\*\*/gm;

/**
 * The entry's body with (a) its `## ` heading line, (b) every fenced code
 * block (commands/output — never "what was built"), and (c) every labeled
 * sub-section whose heading is a rollback or run/test heading, removed —
 * leaving only the descriptive prose that actually names what changed.
 *
 * This exists because a naive "is the body long enough" check can be
 * satisfied entirely by a long rollback paragraph or a chunky command block,
 * with zero words spent on what was built. Isolating the descriptive portion
 * is the only way to check requirement (a) independently of (b) and (c) —
 * see the negative fixture below, which is satisfied on length alone by the
 * old check and correctly rejected by this one.
 */
function descriptiveText(entry: ChangesEntry): string {
  const withoutHeading = entry.body.slice(entry.heading.length);
  const withoutCodeBlocks = withoutHeading.replace(/```[\s\S]*?```/g, '');

  const headings = [...withoutCodeBlocks.matchAll(BLOCK_HEADING_RE)];
  const firstHeading = headings[0];
  if (firstHeading === undefined) return withoutCodeBlocks;

  // Prose before the first labeled block (rare, but some entries open with an
  // unlabeled sentence) is unlabeled and therefore always descriptive.
  let description = withoutCodeBlocks.slice(0, firstHeading.index ?? 0);

  headings.forEach((heading, i) => {
    const start = heading.index ?? 0;
    const nextHeading = headings[i + 1];
    const end = nextHeading !== undefined ? (nextHeading.index ?? withoutCodeBlocks.length) : withoutCodeBlocks.length;
    const block = withoutCodeBlocks.slice(start, end);
    if (!isProceduralBlock(block)) description += block;
  });

  return description;
}

function hasDescription(entry: ChangesEntry): boolean {
  return descriptiveText(entry).trim().length >= 80;
}

describe('CHANGES.md — every entry documents all three required elements (TRO-371)', () => {
  const entries = parseEntries(changesLog);

  it('parser sanity check: finds a realistic number of entries', () => {
    // If this fails, the heading pattern stopped matching the file's real
    // format and every check below is silently checking nothing.
    expect(entries.length).toBeGreaterThan(100);
  });

  it('every entry describes what was built', () => {
    // Low bar deliberately: this element is the entry's main content and is not
    // the part that has ever gone missing in practice (1/7 CHANGES.md entries
    // were missing rollback/run instructions per the reconciled sweep; none
    // lacked a description of the change itself). This exists so the "three
    // elements" requirement is checked as three, not silently narrowed to two.
    //
    // Checks the ISOLATED descriptive portion (descriptiveText), not the raw
    // body length: a body that is 80+ characters purely of rollback/run
    // procedure and fenced commands, with no prose about what was built, must
    // still fail here. See the negative fixture below for the proof.
    const missing = entries.filter((e) => !hasDescription(e));
    expect(
      missing.map((e) => e.heading),
      `${missing.length} entr(y/ies) have little or no body content describing what was built`
    ).toEqual([]);
  });

  it('rejects an entry with procedure sections but no description (negative fixture)', () => {
    // Proves the check above actually enforces content, not just length: this
    // fixture clears the 80-character bar easily on raw body length (it has a
    // rollback paragraph and a run/test command block well past that), but
    // says nothing about what was built. The old body-length check passed
    // this shape; hasDescription must reject it.
    const fixture = [
      '## TRO-000 — fixture: procedure-only entry with no description',
      '',
      '**How to run it.**',
      '',
      '```bash',
      'pnpm --filter @ship/web exec vitest run src/lib/someFile.test.ts',
      '```',
      '',
      '**Rollback.** Revert this commit. That removes the change entirely and',
      'restores prior behavior exactly, with nothing else to undo.',
      '',
      '---',
      '',
    ].join('\n');
    const fixtureEntry = parseEntries(fixture)[0];
    if (fixtureEntry === undefined) {
      throw new Error('parseEntries produced no entries for the negative fixture');
    }
    // Sanity: this fixture DOES satisfy the other two elements, isolating the
    // description check as the one that must catch it.
    expect(hasRollbackSection(fixtureEntry)).toBe(true);
    expect(hasRunInstructions(fixtureEntry)).toBe(true);
    expect(hasDescription(fixtureEntry)).toBe(false);
  });

  it('every entry has rollback instructions', () => {
    const missing = entries.filter((e) => !hasRollbackSection(e));
    expect(
      missing.map((e) => e.heading),
      `${missing.length} entr(y/ies) have no rollback section: ${missing
        .map((e) => e.heading)
        .join(' | ')}`
    ).toEqual([]);
  });

  it('every entry has run/test instructions', () => {
    const missing = entries.filter((e) => !hasRunInstructions(e));
    expect(
      missing.map((e) => e.heading),
      `${missing.length} entr(y/ies) have no run/test instructions: ${missing
        .map((e) => e.heading)
        .join(' | ')}`
    ).toEqual([]);
  });
});
