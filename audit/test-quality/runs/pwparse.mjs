// Parse a Playwright JSON report into per-test first-attempt and final outcomes.
import fs from 'fs';

const file = process.argv[2];
const d = JSON.parse(fs.readFileSync(file, 'utf8'));

const tests = []; // {id, file, title, first, final, attempts, durationMs}

function walk(suite, fileName) {
  const fn = suite.file || fileName;
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const results = t.results || [];
      const first = results.length ? results[0].status : 'unknown';
      const final = t.status; // 'expected' | 'unexpected' | 'flaky' | 'skipped'
      const dur = results.reduce((a, r) => a + (r.duration || 0), 0);
      tests.push({
        id: `${fn} :: ${spec.title}`,
        file: fn,
        title: spec.title,
        line: spec.line,
        first,
        final,
        attempts: results.length,
        statuses: results.map(r => r.status),
        durationMs: dur,
      });
    }
  }
  for (const s of suite.suites || []) walk(s, fn);
}
for (const s of d.suites || []) walk(s, s.file);

const stats = d.stats || {};
const firstFail = tests.filter(t => t.first !== 'passed' && t.first !== 'skipped');
const finalFail = tests.filter(t => t.final === 'unexpected');
const retriedButPassed = tests.filter(t => t.attempts > 1 && t.final !== 'unexpected');

const out = {
  file,
  total: tests.length,
  startTime: stats.startTime,
  durationS: +(stats.duration / 1000).toFixed(1),
  finalPassed: tests.filter(t => t.final === 'expected').length,
  finalFailed: finalFail.length,
  finalFlaky: tests.filter(t => t.final === 'flaky').length,
  skipped: tests.filter(t => t.final === 'skipped').length,
  firstAttemptFailed: firstFail.length,
  maskedByRetry: retriedButPassed.length,
};
console.log(JSON.stringify(out, null, 2));
console.log('\n--- FIRST-ATTEMPT FAILURES ---');
firstFail.forEach(t => console.log(`  [${t.statuses.join('>')}] final=${t.final}  ${t.id}`));
console.log('\n--- FINAL FAILURES ---');
finalFail.forEach(t => console.log(`  ${t.id}`));

fs.writeFileSync(file.replace(/\.json$/, '') + '.parsed.json', JSON.stringify({ summary: out, tests }, null, 2));
