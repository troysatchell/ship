// db-query-audit baseline: parse the Postgres statement log into per-flow query slices.
// Run: node audit/db-query/raw/parse-log.mjs audit/db-query/raw/pg-statements.log
import { readFileSync, writeFileSync } from 'fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split('\n');

const HEAD = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) UTC \[(\d+)\] (LOG|DETAIL|ERROR|WARNING|HINT|CONTEXT|STATEMENT|FATAL|NOTICE):  ([\s\S]*)$/;

// 1. Fold continuation lines into entries
const entries = [];
for (const line of lines) {
  const m = line.match(HEAD);
  if (m) {
    entries.push({ ts: m[1], t: Date.parse(m[1].replace(' ', 'T') + 'Z'), pid: m[2], level: m[3], body: m[4] });
  } else if (entries.length && line.length) {
    entries[entries.length - 1].body += '\n' + line;
  }
}

// 2. Classify
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const queries = []; // {t, pid, sql, kind, params, ms}
const pendingByPid = new Map();
for (const e of entries) {
  if (e.level !== 'LOG' && e.level !== 'DETAIL') continue;
  let m;
  if ((m = e.body.match(/^statement: ([\s\S]*)$/))) {
    const q = { t: e.t, ts: e.ts, pid: e.pid, sql: norm(m[1]), kind: 'simple', params: null, ms: null };
    queries.push(q); pendingByPid.set(e.pid, q);
  } else if ((m = e.body.match(/^execute [^:]*: ([\s\S]*)$/))) {
    const q = { t: e.t, ts: e.ts, pid: e.pid, sql: norm(m[1]), kind: 'execute', params: null, ms: null };
    queries.push(q); pendingByPid.set(e.pid, q);
  } else if ((m = e.body.match(/^duration: ([\d.]+) ms$/))) {
    const q = pendingByPid.get(e.pid);
    if (q && q.ms === null) { q.ms = parseFloat(m[1]); pendingByPid.delete(e.pid); }
  } else if ((m = e.body.match(/^parameters: ([\s\S]*)$/))) {
    const q = pendingByPid.get(e.pid);
    if (q && q.params === null) q.params = norm(m[1]);
  }
  // "duration: X ms  parse/bind ..." lines are protocol overhead — not counted as queries
}

// 3. Identify the marker connection and slice per flow
const markerPids = new Set(queries.filter(q => q.sql.includes('DBAUDIT_MARK')).map(q => q.pid));
const marks = queries.filter(q => q.sql.includes('DBAUDIT_MARK'))
  .map(q => {
    const m = q.sql.match(/DBAUDIT_MARK (START|END) (.*) iter(\d+)/);
    return m ? { t: q.t, edge: m[1], flow: m[2], iter: +m[3] } : null;
  }).filter(Boolean);

const appQueries = queries.filter(q => !markerPids.has(q.pid));

const flows = {};
for (let i = 0; i < marks.length; i++) {
  const s = marks[i];
  if (s.edge !== 'START') continue;
  const e = marks.slice(i + 1).find(x => x.edge === 'END' && x.flow === s.flow && x.iter === s.iter);
  if (!e) continue;
  const slice = appQueries.filter(q => q.t >= s.t && q.t <= e.t);
  flows[`${s.flow}#${s.iter}`] = slice;
}

// 4. Report
const out = {};
for (const [key, slice] of Object.entries(flows)) {
  const byTemplate = new Map();
  for (const q of slice) {
    const t = byTemplate.get(q.sql) ?? { sql: q.sql, count: 0, totalMs: 0, maxMs: 0, sampleParams: q.params };
    t.count++; t.totalMs += (q.ms ?? 0); t.maxMs = Math.max(t.maxMs, q.ms ?? 0);
    byTemplate.set(q.sql, t);
  }
  const templates = [...byTemplate.values()].sort((a, b) => b.count - a.count || b.maxMs - a.maxMs);
  const slowest = slice.slice().sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0];
  out[key] = {
    queryCount: slice.length,
    uniqueTemplates: templates.length,
    totalDbMs: +slice.reduce((s, q) => s + (q.ms ?? 0), 0).toFixed(3),
    slowestMs: slowest ? slowest.ms : null,
    slowestSql: slowest ? slowest.sql.slice(0, 220) : null,
    repeatedTemplates: templates.filter(t => t.count >= 3).map(t => ({ count: t.count, maxMs: +t.maxMs.toFixed(3), totalMs: +t.totalMs.toFixed(3), sql: t.sql.slice(0, 200) })),
    templates: templates.map(t => ({ count: t.count, maxMs: +t.maxMs.toFixed(3), totalMs: +t.totalMs.toFixed(3), sql: t.sql, sampleParams: t.sampleParams })),
  };
}

writeFileSync('audit/db-query/raw/flow-queries.json', JSON.stringify(out, null, 2));

// Console summary
console.log('flow'.padEnd(28), 'queries'.padStart(8), 'uniq'.padStart(6), 'dbMs'.padStart(9), 'slowestMs'.padStart(10));
for (const [k, v] of Object.entries(out)) {
  console.log(k.padEnd(28), String(v.queryCount).padStart(8), String(v.uniqueTemplates).padStart(6), String(v.totalDbMs).padStart(9), String(v.slowestMs).padStart(10));
}

// Global slowest statements across all flows
const all = Object.values(flows).flat();
const bySql = new Map();
for (const q of all) {
  const t = bySql.get(q.sql) ?? { sql: q.sql, n: 0, maxMs: 0, totalMs: 0, sampleParams: q.params };
  t.n++; t.maxMs = Math.max(t.maxMs, q.ms ?? 0); t.totalMs += q.ms ?? 0;
  if (!t.sampleParams) t.sampleParams = q.params;
  bySql.set(q.sql, t);
}
const top = [...bySql.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, 12);
writeFileSync('audit/db-query/raw/top-statements.json', JSON.stringify(top, null, 2));
console.log('\nTop statements by max duration:');
for (const t of top) console.log(`  ${t.maxMs.toFixed(3)} ms  (n=${t.n}, total=${t.totalMs.toFixed(1)}ms)  ${t.sql.slice(0, 150)}`);
