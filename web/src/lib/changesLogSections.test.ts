/**
 * Regression test for TRO-371.
 *
 * CHANGES.md's own header states its purpose: "what was added, how to run it, and
 * how to roll it back" — for the next engineer inheriting the codebase, not for
 * graders. A sweep found 13 entries missing a rollback section and 6 missing
 * run/test instructions. Reconciling that sweep against the actual file (not
 * assumed from its list — see the CHANGES.md entry for this ticket) found the
 * real numbers were different: only one entry ("Bundle TRO-330") had no rollback
 * content anywhere, and six had no run/test content anywhere — TRO-360, "Bundle
 * TRO-330", TRO-325, TRO-293, TRO-294 and TRO-302. All seven gaps (one entry,
 * Bundle TRO-330, was missing both) are fixed as part of this ticket.
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

describe('CHANGES.md — every entry documents all three required elements (TRO-371)', () => {
  const entries = parseEntries(changesLog);

  it('parser sanity check: finds a realistic number of entries', () => {
    // If this fails, the heading pattern stopped matching the file's real
    // format and every check below is silently checking nothing.
    expect(entries.length).toBeGreaterThan(100);
  });

  it('every entry describes what was built', () => {
    // Low bar deliberately: this element is the entry's main content and is not
    // the part that has ever gone missing in practice (13/6 CHANGES.md entries
    // were missing rollback/run instructions per the sweep; none lacked a
    // description of the change itself). This exists so the "three elements"
    // requirement is checked as three, not silently narrowed to two.
    const missing = entries.filter((e) => e.body.replace(e.heading, '').trim().length < 80);
    expect(
      missing.map((e) => e.heading),
      `${missing.length} entr(y/ies) have little or no body content describing what was built`
    ).toEqual([]);
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
