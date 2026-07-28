// Find Playwright tests whose every expect() sits inside a conditional branch,
// i.e. tests that can pass with zero assertions executed.
// Heuristic brace scanner; identical pattern must be reused in compare mode.
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] || 'e2e';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.spec.ts'));

let totalTests = 0, vacuousTests = 0, noExpectTests = 0;
const vacuous = [];
const noExpect = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = src.split('\n');
  // locate test starts
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:await\s+)?test(?:\.only|\.skip|\.fixme)?\s*\(\s*['"`](.+?)['"`]/);
    if (!m) continue;
    if (/test\.describe/.test(lines[i])) continue;
    totalTests++;
    const title = m[1];
    // scan forward with brace depth from this line
    let depth = 0, started = false;
    const condStack = []; // depths at which a conditional block was opened
    let expectsTotal = 0, expectsUnconditional = 0;
    let j = i;
    for (; j < lines.length; j++) {
      const line = lines[j];
      const code = line.replace(/\/\/.*$/, '');
      // detect conditional opening on this line
      const opensCond = /(^|[^\w.])(if|else if)\s*\(/.test(code) || /\?\s*$/.test(code);
      let lineStartDepth = depth;
      for (const ch of code) {
        if (ch === '{') {
          depth++;
          if (opensCond && depth === lineStartDepth + 1) condStack.push(depth);
        } else if (ch === '}') {
          if (condStack.length && condStack[condStack.length - 1] === depth) condStack.pop();
          depth--;
        }
      }
      if (!started && depth > 0) started = true;
      const nExpect = (code.match(/\bexpect\s*\(/g) || []).length;
      if (nExpect) {
        expectsTotal += nExpect;
        if (condStack.length === 0) expectsUnconditional += nExpect;
      }
      if (started && depth <= 0) break;
    }
    if (expectsTotal === 0) { noExpectTests++; noExpect.push(`${f}:${i + 1} :: ${title}`); }
    else if (expectsUnconditional === 0) { vacuousTests++; vacuous.push(`${f}:${i + 1} :: ${title} (${expectsTotal} expects, all conditional)`); }
  }
}

console.log(JSON.stringify({ testBlocksScanned: totalTests, testsWithZeroExpects: noExpectTests, testsWithOnlyConditionalExpects: vacuousTests }, null, 2));
console.log('\n--- tests with ZERO expect() ---');
noExpect.forEach(x => console.log('  ' + x));
console.log('\n--- tests where every expect() is inside a conditional ---');
vacuous.forEach(x => console.log('  ' + x));
