#!/usr/bin/env node
// Restore CHANGES.md structure after a union merge.
//
// `.gitattributes` sets `CHANGES.md merge=union` so concurrent ticket branches
// stop conflicting on the append-at-top changelog. union keeps every line from
// both sides — which is what we want — but it drops the `---` separator lines
// that were common context between the two inserted entries, leaving one entry
// running straight into the next heading.
//
// This restores exactly that: a `---` and blank lines before every `## ` entry
// heading that does not already have one. It is deliberately narrow. It does
// not reorder, deduplicate, or rewrite content, because a script that edits
// changelog prose is a script that can quietly corrupt a rollback instruction.
//
// Usage:
//   node scripts/factory/normalize-changes.mjs [--check] [path]
//
//   --check  exit 1 if the file would change, without writing (for CI)
//
// Always read `git diff CHANGES.md` after running this. union plus normalize
// gets the mechanics right; only a human can confirm both entries still say
// what their authors meant.

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const path = args.find((a) => !a.startsWith('--')) ?? 'CHANGES.md';

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`normalize-changes: cannot read ${path}: ${err.message}`);
  process.exit(2);
}

const lines = text.split('\n');

// Find where the header block ends. The first `---` in the file closes the
// preamble; entry headings only appear after it. Without this guard a `## `
// inside the header would get a separator injected above it.
const headerEnd = lines.findIndex((l) => l.trim() === '---');
if (headerEnd === -1) {
  console.error(`normalize-changes: ${path} has no '---' header separator; refusing to guess`);
  process.exit(2);
}

const out = lines.slice(0, headerEnd + 1);
let inserted = 0;

for (let i = headerEnd + 1; i < lines.length; i++) {
  const line = lines[i];

  if (/^## /.test(line)) {
    // Walk back over blank lines already emitted to find the last real content.
    let j = out.length - 1;
    while (j >= 0 && out[j].trim() === '') j--;

    const prev = j >= 0 ? out[j].trim() : '';

    if (prev !== '---') {
      // Drop trailing blanks, then emit the canonical separator.
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      out.push('', '---', '');
      inserted++;
    } else {
      // Separator present: normalise to exactly one blank line after it.
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      out.push('');
    }
  }

  out.push(line);
}

const result = out.join('\n');

if (result === text) {
  console.log(`normalize-changes: ${path} already normalized`);
  process.exit(0);
}

if (check) {
  console.error(
    `normalize-changes: ${path} needs normalizing (${inserted} missing separator(s)) — ` +
      `run: node scripts/factory/normalize-changes.mjs`
  );
  process.exit(1);
}

writeFileSync(path, result);
console.log(
  `normalize-changes: ${path} updated — inserted ${inserted} separator(s). ` +
    `Now read 'git diff ${path}' before committing.`
);
