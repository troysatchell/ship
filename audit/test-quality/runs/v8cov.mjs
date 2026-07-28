// Approximate byte-level coverage from raw NODE_V8_COVERAGE output.
// Used because @vitest/coverage-v8 is not installed and the registry is blocked.
// Offsets refer to vitest-transformed sources, so percentages are an approximation.
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
const filter = process.argv[3]; // substring that must appear in path
const roots = process.argv[4]; // dir to enumerate all source files from
const exclude = /(\.test\.tsx?|\.spec\.tsx?|\/test\/|\/__tests__\/|\/db\/migrations\/)/;

const perFile = new Map(); // path -> {len, covered: Uint8Array}
const fnCov = new Map(); // path -> Map(fnKey -> covered bool)

for (const f of fs.readdirSync(dir)) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  for (const s of d.result || []) {
    if (!s.url || !s.url.startsWith('file://')) continue;
    const p = decodeURIComponent(s.url.replace('file://', ''));
    if (!p.includes(filter)) continue;
    if (exclude.test(p)) continue;
    if (!/\.(ts|tsx)$/.test(p)) continue;

    let len = 0;
    for (const fn of s.functions) for (const r of fn.ranges) len = Math.max(len, r.endOffset);
    if (!len) continue;

    // function coverage: a function is covered if its own root range count > 0
    let fm = fnCov.get(p); if (!fm) { fm = new Map(); fnCov.set(p, fm); }
    for (const fn of s.functions) {
      if (!fn.ranges.length) continue;
      const root = fn.ranges[0];
      if (root.startOffset === 0 && root.endOffset === len) continue; // module top-level
      const key = `${root.startOffset}:${root.endOffset}`;
      fm.set(key, (fm.get(key) || false) || root.count > 0);
    }

    // flatten this script's ranges: outer-first so inner ranges override
    const ranges = [];
    for (const fn of s.functions) for (const r of fn.ranges) ranges.push(r);
    ranges.sort((a, b) => (a.startOffset - b.startOffset) || (b.endOffset - a.endOffset));
    const local = new Uint8Array(len);
    for (const r of ranges) {
      const v = r.count > 0 ? 1 : 0;
      local.fill(v, r.startOffset, Math.min(r.endOffset, len));
    }

    let e = perFile.get(p);
    if (!e || e.len < len) {
      const nu = new Uint8Array(len);
      if (e) nu.set(e.covered.subarray(0, Math.min(e.len, len)));
      e = { len, covered: nu };
      perFile.set(p, e);
    }
    for (let i = 0; i < len; i++) if (local[i]) e.covered[i] = 1;
  }
}

// enumerate all source files under roots
function walk(d, acc) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) { if (ent.name === 'node_modules' || ent.name === 'dist') continue; walk(p, acc); }
    else if (/\.(ts|tsx)$/.test(ent.name) && !exclude.test(p) && !/\.d\.ts$/.test(p)) acc.push(p);
  }
  return acc;
}
const all = walk(roots, []);

let totBytes = 0, covBytes = 0, filesTouched = 0, filesZero = [];
let totFns = 0, covFns = 0;
const rows = [];
for (const p of all) {
  const e = perFile.get(p);
  const fm = fnCov.get(p);
  let fnTot = 0, fnCovN = 0;
  if (fm) { for (const v of fm.values()) { fnTot++; if (v) fnCovN++; } }
  totFns += fnTot; covFns += fnCovN;
  if (!e) {
    const sz = fs.statSync(p).size;
    totBytes += sz; filesZero.push(p);
    rows.push({ file: p, pct: 0, len: sz, fnPct: 0, fnTot: 0 });
    continue;
  }
  filesTouched++;
  let c = 0;
  for (let i = 0; i < e.len; i++) if (e.covered[i]) c++;
  totBytes += e.len; covBytes += c;
  rows.push({ file: p, pct: (c / e.len) * 100, len: e.len, fnPct: fnTot ? fnCovN / fnTot * 100 : 100, fnTot });
}

console.log(JSON.stringify({
  sourceFiles: all.length,
  filesExecuted: filesTouched,
  filesNeverLoaded: all.length - filesTouched,
  byteCoveragePct: +(covBytes / totBytes * 100).toFixed(1),
  functionCoveragePct: +(covFns / totFns * 100).toFixed(1),
  functionsTotal: totFns,
  functionsCovered: covFns,
}, null, 2));
console.log('\n--- 25 files by FUNCTION coverage (asc), fnTotal>=5 ---');
rows.filter(r => r.fnTot >= 5).sort((a, b) => a.fnPct - b.fnPct || b.len - a.len).slice(0, 25)
  .forEach(r => console.log(`fn ${r.fnPct.toFixed(1).padStart(5)}%  byte ${r.pct.toFixed(1).padStart(5)}%  (${String(r.fnTot).padStart(3)} fns)  ${r.file.replace(/.*\/Ship\//, '')}`));
console.log('\n--- files never loaded ---');
filesZero.forEach(f => console.log('   ' + f.replace(/.*\/Ship\//, '')));
