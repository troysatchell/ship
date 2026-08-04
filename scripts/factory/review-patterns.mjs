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
    `git diff ${base}...HEAD -- 'api/**' 'web/**' 'shared/**' 'e2e/**' 'agent/**' 'Dockerfile*' '**/Dockerfile*' '**/.npmrc'`,
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
    // Also catches `!` immediately before a colon — TRO-230's CodeRabbit review
    // caught this checker missing `let resolveFetch!: (res: Response) => void;`
    // (a definite-assignment assertion) entirely, since `:` wasn't in the
    // followed-by set. The same `!(?=\s*:)` shape also catches a non-null
    // assertion in a ternary's consequent (`cond ? x! : y`), which is a second,
    // independently valid case this addition covers.
    // Deliberately not trying to catch every form: false positives here would
    // make the check untrustworthy, and TS-4 counts the common shapes.
    re: /(?:\w|\]|\))!(?=\s*[.,;)\]}:]|\s*$)/,
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
    // Added after this checker MISSED a Major finding: a reviewer flagged
    // `function extractIssueListItemFromRow(row: any)` on TRO-173 while G7b
    // reported clean, because the original rule only matched `as any`. An
    // annotation is the more consequential form — `as any` silences one
    // expression, `: any` silences every use of the value, so a projection
    // change stops being type-checked at all.
    id: 'any-annotation',
    re: /:\s*any\b(?!\s*\[\s*\]\s*\)\s*=>)/,
    why: 'new `: any` annotation — silences every use of the value, so schema/projection drift stops being type-checked (TS-2)',
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
  {
    // Added after TRO-316's CodeRabbit review caught `strict-ssl=false` in
    // agent/Dockerfile disabling TLS certificate validation for every npm/pnpm
    // install step — undetected by this checker at the time because it doesn't
    // silence a type, it silences the entire transport's authenticity check.
    // Only one occurrence on file (this checker's usual bar is three), but a
    // disabled certificate check is a severe-enough single class to gate on
    // immediately rather than wait for a recurrence — same reasoning as why G7b
    // exists at all, applied a bar earlier for a security-class defect.
    id: 'tls-bypass',
    re: /strict-ssl\s*=\s*false|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|(?:curl|wget)\b[^\n]*(?:\s-k\b|--insecure|--no-check-certificate)|ssl_verify(?:_peer)?\s*=\s*false|verify\s*=\s*False/,
    why: 'disables TLS/SSL certificate validation — TRO-316: strict-ssl=false in agent/Dockerfile let npm install traffic go unverified',
    files: /(^|\/)(Dockerfile[^/]*|\.npmrc)$|\.(ts|tsx|js|mjs|cjs|sh|py)$/,
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
      // `full` is the untruncated line, used for the net-new count below;
      // `text` is truncated for display only.
      violations.push({ rule: rule.id, why: rule.why, file, text: trimmed.slice(0, 120), full: trimmed });
    }
  }
}

// NET-NEW ONLY, and why this is not optional.
//
// git marks a line "+" when its *position* changed, not when its content is new.
// De-indenting a block — exactly what happens when an `if`-guard is removed and
// its body promoted — re-adds every line inside it. So a branch that DELETES
// violations can be reported as adding several.
//
// Observed on TRO-286: converting 62 conditional-only e2e tests into real
// assertions de-indented their bodies, and this checker flagged 15 fixed sleeps
// as new. That branch in fact went from 610 `waitForTimeout` calls to 607 — it
// removed three and added none.
//
// G5 learned the same lesson first, and its comment says it best: a false
// positive that suppresses real work is the worst outcome, because the honest
// responses (annotate a dozen pre-existing lines, or abandon the improvement)
// are both worse than the thing being checked for. So compare counts, not diff
// markers: a violation counts only if the file now holds MORE occurrences of
// that exact line than the base did.
const showFile = (ref, f) => {
  try {
    return execSync(`git show ${ref}:${JSON.stringify(f)}`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return ''; // new file — everything in it is genuinely new
  }
};

const countOf = (content, text) => {
  let n = 0;
  for (const l of content.split('\n')) if (l.trim() === text) n++;
  return n;
};

const fileCache = new Map();
const netViolations = [];
const emittedFor = new Map(); // `${file} ${full}` -> count already emitted

for (const v of violations) {
  if (!fileCache.has(v.file)) {
    fileCache.set(v.file, {
      base: showFile(base, v.file),
      head: showFile('HEAD', v.file),
    });
  }
  const { base: baseSrc, head: headSrc } = fileCache.get(v.file);
  const budget = Math.max(0, countOf(headSrc, v.full) - countOf(baseSrc, v.full));
  const key = `${v.file} ${v.full}`;
  const already = emittedFor.get(key) ?? 0;
  if (already < budget) {
    emittedFor.set(key, already + 1);
    netViolations.push(v);
  }
}

const suppressed = violations.length - netViolations.length;
violations.length = 0;
violations.push(...netViolations);

if (!violations.length) {
  if (suppressed > 0) {
    console.log(
      `review-patterns: clean — ${suppressed} flagged line(s) were pre-existing ` +
        '(moved or re-indented; net count unchanged or lower)'
    );
  } else {
    console.log('review-patterns: clean');
  }
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
