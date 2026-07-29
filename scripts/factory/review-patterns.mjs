#!/usr/bin/env node
// Gate check for defect classes that reviewers kept catching after the gate
// had already passed.
//
// WHY THIS EXISTS
//
// `review-ledger.mjs report` over the first real day of factory operation:
//
//   type-safety   5 findings / 4 tickets   new `!` and `as unknown as`
//   test-timing   3 findings / 3 tickets   fixed sleeps in brand-new tests
//   concurrency   3 findings / 3 tickets   read-then-write races
//   docs-accuracy 4 findings / 3 tickets   CHANGES.md claims vs reality
//
// The agent brief already mentioned TS-4/TS-8 and TEST-11. It did not hold: the
// same two mechanical classes recurred on four and three tickets respectively.
// Once a rule has been stated and ignored three times, restating it louder is
// not the fix — a check is.
//
// This covers only the two classes a machine can decide. `concurrency` and
// `docs-accuracy` need judgement and stay in the brief (references/lessons.md).
// Pretending to check them here would be worse than admitting the split.
//
// ESCAPE HATCH, and why it is required
//
// A check that cannot be satisfied gets bypassed, and a bypassed check teaches
// agents that gates are advisory. Any flagged line may be allowed by putting
//     // review-pattern-ok: <reason>
// on it or the line above. That turns a silent violation into a written,
// reviewable claim — which is the actual goal.
//
// Usage: review-patterns.mjs <base-ref>

import { execSync } from 'node:child_process';

const base = process.argv[2] ?? 'main';

let diff;
try {
  diff = execSync(
    `git diff ${base}...HEAD -- 'api/**' 'web/**' 'shared/**' 'e2e/**'`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
} catch (err) {
  console.error(`review-patterns: git diff failed: ${err.message}`);
  process.exit(2);
}

const RULES = [
  {
    id: 'non-null-assertion',
    // Postfix `!` on an identifier or index, e.g. `foo!.bar`, `arr[0]!`, `x!)`.
    // Deliberately not trying to catch every form: false positives here would
    // make the check untrustworthy, and TS-4 counts the common shapes.
    re: /(?:\w|\]|\))!(?=\s*[.,;)\]}]|\s*$)/,
    why: 'new non-null assertion — TS-4 tracks 236 of these as a measured number we are graded on reducing',
    files: /\.(ts|tsx)$/,
  },
  {
    id: 'as-any',
    re: /\bas\s+any\b/,
    why: 'new `as any` — TS-7/TS-8 are open findings about exactly this',
    files: /\.(ts|tsx)$/,
  },
  {
    id: 'as-unknown-as',
    re: /\bas\s+unknown\s+as\b/,
    why: 'new `as unknown as` cast — TS-8: test casts decouple tests from the shapes they claim to verify',
    files: /\.(ts|tsx)$/,
  },
  {
    id: 'fixed-sleep',
    // Only in tests. Production code legitimately schedules timers; a test that
    // sleeps a fixed duration to wait for an event is the mechanism behind
    // TEST-11's 619 flakes.
    re: /\b(?:waitForTimeout\s*\(\s*\d|(?:await\s+)?(?:sleep|delay)\s*\(\s*\d{3,}|setTimeout\s*\(\s*(?:resolve|res)\s*,\s*\d{3,})/,
    why: 'fixed sleep in a test — TEST-11 (TRO-233): 619 of these are the known cause of this repo\'s flakes. Await an observable event instead',
    files: /\.(test|spec)\.(ts|tsx)$/,
  },
];

// Walk the diff, tracking the current file and only inspecting added lines.
const violations = [];
let file = null;
const lines = diff.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  const m = /^\+\+\+ b\/(.+)$/.exec(line);
  if (m) {
    file = m[1];
    continue;
  }
  if (!file) continue;
  if (!line.startsWith('+') || line.startsWith('+++')) continue;

  const added = line.slice(1);

  // Escape hatch: this line, or the added line immediately before it.
  const prevAdded = i > 0 && lines[i - 1].startsWith('+') ? lines[i - 1].slice(1) : '';
  if (/review-pattern-ok:/.test(added) || /review-pattern-ok:/.test(prevAdded)) continue;

  // Skip comment-only lines — a rule named in a comment is not a violation.
  const trimmed = added.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

  for (const rule of RULES) {
    if (!rule.files.test(file)) continue;
    if (rule.re.test(added)) {
      violations.push({ rule: rule.id, why: rule.why, file, text: trimmed.slice(0, 120) });
    }
  }
}

if (!violations.length) {
  console.log('review-patterns: clean');
  process.exit(0);
}

const byRule = new Map();
for (const v of violations) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}

console.error(`review-patterns: ${violations.length} violation(s) in added lines\n`);
for (const [rule, list] of byRule) {
  console.error(`  ${rule} — ${list[0].why}`);
  for (const v of list.slice(0, 8)) {
    console.error(`    ${v.file}: ${v.text}`);
  }
  if (list.length > 8) console.error(`    … and ${list.length - 8} more`);
  console.error('');
}
console.error(
  'Each of these was filed by a reviewer on an earlier ticket after the gate passed.\n' +
    'Fix them, or allow a specific line with `// review-pattern-ok: <reason>` and\n' +
    'justify it in the PR. An unexplained bypass is not acceptable.'
);
process.exit(1);
