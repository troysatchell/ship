import fs from 'fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
function walk(s, fn) {
  const f = s.file || fn;
  for (const spec of s.specs || []) for (const t of spec.tests || []) {
    (t.results||[]).forEach((r, i) => {
      if (r.status === 'passed' || r.status === 'skipped') return;
      const msg = (r.errors||[]).map(e => (e.message||'').replace(/\x1b\[[0-9;]*m/g,'')).join('\n---\n');
      out.push(`### ${f}:${spec.line} :: ${spec.title}\n    attempt=${i} status=${r.status} duration=${r.duration}ms\n${msg.split('\n').slice(0,14).map(l=>'    '+l).join('\n')}\n`);
    });
  }
  for (const c of s.suites || []) walk(c, f);
}
for (const s of d.suites||[]) walk(s, s.file);
console.log(out.join('\n'));
