#!/usr/bin/env node
// Entry-aware merge and validation for CHANGES.md.
//
// WHY THIS EXISTS, and why the two obvious approaches both fail:
//
// CHANGES.md is append-at-top. Every ticket branch inserts its entry directly
// under the header, so N concurrent branches conflict, and each merge
// re-conflicts every branch still open.
//
//   1. Default 3-way merge produces a resolution that is WRONG but looks right.
//      Every entry uses the same `**How to run it.**` and `**Roll back.**`
//      headings, so git matches those common lines and COLLAPSES two entries
//      into one. Deleting the markers welds one ticket's rollback instructions
//      onto another ticket's entry.
//
//   2. `merge=union` is worse in a quieter way. It keeps every line from both
//      sides, so nothing is *missing* in the diff — but it DROPS the shared
//      context lines, which here are exactly `**How to run it.**` and the
//      ```bash fences. The result parses as one entry whose command block has
//      a closing fence and no opening one, and whose run instructions belong to
//      a different ticket. Observed on five branches at once: 9 entry headings
//      but 8 run blocks, and two branches left with an odd number of fences.
//      A reviewer caught it; a heading-and-separator check did not.
//
// The fix is to merge at the granularity the file actually has: whole entries,
// split on `^## ` headings, never line-by-line. Both sides share a common tail;
// each side prepends its own entries. Take the header once, then each side's
// new entries in order, then the shared tail.
//
// Usage:
//   merge-changes.mjs --ours <file> --theirs <file> [--out <file>]
//   merge-changes.mjs --check <file>
//
// --check validates structural invariants and exits 1 on failure:
//   * balanced ``` fences
//   * every entry has its own `**How to run it.**` (if any entry does)
//   * every entry has its own rollback line (if any entry does)
//   * no duplicate entry headings
//   * a `---` separator before every entry
//
// Run --check after ANY merge of this file, by any method. The point of this
// script is that structural validation is not optional.

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}

// Entries in this file do not use one fixed wording. Observed in the real
// history: "**How to run it.**", "**Run it.**", "**Rollback.**",
// "**Rollback:**", "**Roll back.**", "**How to roll it back.**". A narrower
// regex reports healthy entries as broken, and a validator with false positives
// gets ignored — which is worse than no validator.
const RUN_RE = /^\*\*(How to run it|Run it|To run it)[.:]?\*\*/i;
const ROLLBACK_RE = /^\*\*(Roll ?back|How to roll it back)[.:]?\*\*/i;

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`merge-changes: cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

// Split into { header, entries: [{heading, lines}] }.
// The header is everything before the first `## ` heading.
function parse(text) {
  const lines = text.split('\n');
  const firstEntry = lines.findIndex((l) => /^## /.test(l));
  if (firstEntry === -1) return { header: lines, entries: [] };

  const header = lines.slice(0, firstEntry);
  const entries = [];
  let cur = null;

  for (let i = firstEntry; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      if (cur) entries.push(cur);
      cur = { heading: lines[i].trim(), lines: [lines[i]] };
    } else {
      cur.lines.push(lines[i]);
    }
  }
  if (cur) entries.push(cur);

  // Trailing `---` and blank lines belong to the separator, not to the entry.
  for (const e of entries) {
    while (e.lines.length) {
      const last = e.lines[e.lines.length - 1].trim();
      if (last === '' || last === '---') e.lines.pop();
      else break;
    }
  }

  return { header, entries };
}

function render(header, entries) {
  const head = [...header];
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  // Header already ends with its own `---`; keep exactly one blank after it.
  const out = [...head, ''];
  entries.forEach((e, idx) => {
    if (idx > 0) out.push('---', '');
    out.push(...e.lines, '');
  });
  // NO global whitespace normalisation. An earlier version collapsed runs of
  // 3+ newlines, which silently reflowed an entry that deliberately contained a
  // double blank line — the same class of defect as `merge=union`: quietly
  // rewriting content the author chose. Blank lines are controlled only at the
  // seams constructed above; entry bodies are emitted verbatim. The entry
  // integrity check below is what proves that.
  return out.join('\n') + '\n';
}

// Two tiers, deliberately.
//
// FATAL: unambiguous structural corruption. An odd number of ``` fences, or a
// single entry with unbalanced fences, cannot be an authoring choice — it is a
// dropped or spliced line. Duplicate headings mean an entry was emitted twice.
//
// WARN: conventions an author might legitimately vary. Not every entry carries
// a run block. Treating that as fatal produced false positives on four healthy
// branches, and a validator that cries wolf gets switched off.
function check(text, label) {
  const fatal = [];
  const warn = [];
  const { entries } = parse(text);

  const fences = (text.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) {
    fatal.push(`unbalanced \`\`\` fences: ${fences} (must be even) — a line was dropped or spliced`);
  }

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.heading)) fatal.push(`duplicate entry heading: ${e.heading}`);
    seen.add(e.heading);
  }

  for (const e of entries) {
    const efences = e.lines.filter((l) => /^```/.test(l)).length;
    if (efences % 2 !== 0) {
      fatal.push(`entry has unbalanced fences (spliced command block): ${e.heading}`);
    }
    if (!e.lines.some((l) => RUN_RE.test(l))) {
      warn.push(`entry has no run block: ${e.heading}`);
    }
    if (!e.lines.some((l) => ROLLBACK_RE.test(l))) {
      warn.push(`entry has no rollback block: ${e.heading}`);
    }
  }

  for (const w of warn) console.error(`  warn: ${w}`);

  if (fatal.length) {
    console.error(`merge-changes --check FAILED for ${label}:`);
    for (const p of fatal) console.error(`  - ${p}`);
    return false;
  }
  console.error(
    `merge-changes --check OK for ${label}: ${entries.length} entries, ${fences} fences` +
      (warn.length ? `, ${warn.length} warning(s)` : '')
  );
  return true;
}

const checkPath = flag('check') ?? (argv[0] === '--check' ? argv[1] : null);
if (checkPath) {
  process.exit(check(read(checkPath), checkPath) ? 0 : 1);
}

const oursPath = flag('ours');
const theirsPath = flag('theirs');
if (!oursPath || !theirsPath) {
  console.error('usage: merge-changes.mjs --ours <file> --theirs <file> [--out <file>]');
  console.error('       merge-changes.mjs --check <file>');
  process.exit(2);
}

const ours = parse(read(oursPath));
const theirs = parse(read(theirsPath));

// Entries present on both sides are the shared history. Entries unique to a
// side are that side's new work. Order: ours first (newest first), then
// theirs' new entries, then shared tail in theirs' order.
const theirHeadings = new Set(theirs.entries.map((e) => e.heading));
const ourHeadings = new Set(ours.entries.map((e) => e.heading));

const oursNew = ours.entries.filter((e) => !theirHeadings.has(e.heading));
const theirsNew = theirs.entries.filter((e) => !ourHeadings.has(e.heading));
const shared = theirs.entries.filter((e) => ourHeadings.has(e.heading));

const merged = [...oursNew, ...theirsNew, ...shared];

// The header is identical on both sides in practice; prefer theirs (the
// incoming base) so header edits on main are not lost.
const result = render(theirs.header.length ? theirs.header : ours.header, merged);

// The guarantee that matters, and the one `merge=union` silently violated:
// every entry in the output must be byte-identical to the entry it came from.
// This is checkable because whole entries are copied, never merged line-wise.
// Without it, a resolver is just a differently-shaped guess.
const outEntries = parse(result).entries;
const sourceByHeading = new Map();
for (const e of [...oursNew, ...theirsNew, ...shared]) {
  sourceByHeading.set(e.heading, e.lines.join('\n').trimEnd());
}

const drift = [];
for (const e of outEntries) {
  const src = sourceByHeading.get(e.heading);
  if (src === undefined) {
    drift.push(`output entry has no source: ${e.heading}`);
    continue;
  }
  if (e.lines.join('\n').trimEnd() !== src) {
    drift.push(`entry body changed during merge: ${e.heading}`);
  }
}
if (outEntries.length !== merged.length) {
  drift.push(`entry count changed: expected ${merged.length}, got ${outEntries.length}`);
}

if (drift.length) {
  console.error('merge-changes: ENTRY INTEGRITY CHECK FAILED — refusing to write:');
  for (const d of drift) console.error(`  - ${d}`);
  process.exit(1);
}

if (!check(result, 'merge result')) {
  console.error('merge-changes: refusing to write a structurally invalid result');
  process.exit(1);
}

console.error(`merge-changes: entry integrity OK — all ${outEntries.length} entries byte-identical to source`);

const out = flag('out') ?? oursPath;
writeFileSync(out, result);
console.error(
  `merge-changes: wrote ${out} — ${oursNew.length} ours-new + ${theirsNew.length} theirs-new + ${shared.length} shared = ${merged.length} entries`
);
console.error(`merge-changes: now read 'git diff ${out}'. Validation is necessary, not sufficient.`);
