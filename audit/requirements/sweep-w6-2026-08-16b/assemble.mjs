#!/usr/bin/env node
// Assemble matrix.after-w6-2026-08-16b.json from cluster-*.json + verification logs.
// Read-only w.r.t. the repo; writes only under audit/requirements/.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = '/Users/troy/repos/GAUNTLET/Ship';
const SWEEP = path.join(REPO, 'audit/requirements/sweep-w6-2026-08-16b');
const PRIOR = JSON.parse(fs.readFileSync(path.join(REPO, 'audit/requirements/matrix.after-w6-2026-08-16.json'), 'utf8'));
const priorById = Object.fromEntries(PRIOR.requirements.map(r => [r.id, r]));

// ---- vitest per-file results (✓ lines) ----
function passedFiles(listFile, prefix) {
  const p = path.join(SWEEP, listFile);
  if (!fs.existsSync(p)) return new Set();
  return new Set(fs.readFileSync(p, 'utf8').split('\n')
    .filter(l => l.startsWith('✓ ') && / \(\d+ tests?/.test(l))
    .map(l => prefix + l.slice(2).split(' (')[0]));
}
const passed = new Set([
  ...passedFiles('api-file-results.txt', 'api/'),
  ...passedFiles('web-file-results.txt', 'web/'),
  ...passedFiles('agent-file-results.txt', 'agent/'),
  ...passedFiles('sdk-file-results.txt', 'sdk/'),
  ...passedFiles('cli-file-results.txt', 'integrations/cli/'),
]);
// scripts/__tests__/*.test.mjs are not in any package suite → never "passed" here.

// ---- e2e results from progress.jsonl (spec → status) ----
const e2e = {};
const pj = path.join(REPO, 'test-results/progress.jsonl');
if (fs.existsSync(pj)) {
  for (const line of fs.readFileSync(pj, 'utf8').split('\n').filter(Boolean)) {
    try {
      const ev = JSON.parse(line);
      const b=(ev.test || ev.file || '').split('/').pop().split(':')[0]; const spec = b ? 'e2e/' + b : '';
      if (!spec) continue;
      e2e[spec] ??= { passed: 0, failed: 0, retried: 0, titles: {} };
      const t = ev.title || '';
      if (ev.status === 'passed') { e2e[spec].passed++; if (e2e[spec].titles[t] === 'failed') e2e[spec].retried++; }
      if (ev.status === 'failed') e2e[spec].failed++;
      e2e[spec].titles[t] = ev.status;
    } catch {}
  }
}
// a spec is green if every title's LAST status is passed
function specGreen(spec) {
  const s = e2e[spec]; if (!s) return null;
  const last = Object.values(s.titles);
  return last.length > 0 && last.every(v => v === 'passed');
}

// ---- load clusters ----
const rows = [];
const commands = [];
for (const f of fs.readdirSync(SWEEP).filter(f => /^cluster-[A-Z]\.json$/.test(f)).sort()) {
  const c = JSON.parse(fs.readFileSync(path.join(SWEEP, f), 'utf8'));
  for (const r of c.rows) rows.push({ ...r, _cluster: c.cluster });
  for (const cmd of (c.commands_run || [])) commands.push({ ...cmd, _cluster: c.cluster });
}
rows.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));

// ---- reconcile verification ----
const TEST_CMD = 'pnpm test (root; api suite via root chain, then test:web/test:agent/test:sdk/test:cli individually) — DATABASE_URL → scratch DB ship_req_audit_w6b_scratch (migrated fresh, dropped after)';
const E2E_CMD = 'PLAYWRIGHT_WORKERS=2 pnpm exec playwright test <7 targeted specs> (per-worker Postgres testcontainers)';
const citationReport = [];
let badCitations = 0;
for (const r of rows) {
  const tf = (r.test_files_bearing || []).filter(f => !f.startsWith('e2e/'));
  const tfPassed = tf.filter(f => passed.has(f));
  const tfMissing = tf.filter(f => !passed.has(f));
  const es = (r.e2e_specs_bearing || []);
  const esGreen = es.filter(s => specGreen(s) === true);
  const esRed = es.filter(s => specGreen(s) === false);
  const esNotRun = es.filter(s => specGreen(s) === null);
  r._verif = { tfPassed, tfMissing, esGreen, esRed, esNotRun };
  // Upgrade rule: proposed IMPLEMENTED-UNVERIFIED (or VERIFIED w/o verification) + at least one bearing test file passed and none failed → VERIFIED
  const anyGreen = tfPassed.length > 0 || esGreen.length > 0;
  const anyRed = esRed.length > 0;
  const subVerif = r.verdict === 'VERIFIED' && r.verification && r.verification.command ? r.verification : null;
  if (subVerif && !anyRed) {
    // subagent captured its own behavioral evidence (test.log lines, CI run on traced commit, read-only probes) — honor it, append local green
    const extra = [];
    if (tfPassed.length) extra.push(`local vitest this sweep: ${tfPassed.map(f => f + ' ✓').join('; ')}`);
    if (esGreen.length) extra.push(`local playwright this sweep: ${esGreen.map(s => `${s} ✓ (${e2e[s].passed} passed${e2e[s].retried?`, ${e2e[s].retried} passed-on-retry`:''})`).join('; ')}`);
    r.verification = { command: subVerif.command + (extra.length ? ' && ' + [tfPassed.length?TEST_CMD:null, esGreen.length?E2E_CMD:null].filter(Boolean).join(' && ') : ''), result_excerpt: [subVerif.result_excerpt, ...extra].filter(Boolean).join(' | ') };
  } else if (['IMPLEMENTED-UNVERIFIED', 'VERIFIED'].includes(r.verdict) && anyGreen && !anyRed) {
    r.verdict = 'VERIFIED';
    const parts = [];
    if (tfPassed.length) parts.push(`vitest: ${tfPassed.map(f => f + ' ✓').join('; ')} (see ${tf.some(f=>f.startsWith('api/'))?'test.log':''}${tf.some(f=>f.startsWith('sdk/'))?' test-sdk.log':''}${tf.some(f=>f.startsWith('agent/'))?' test-agent.log':''}${tf.some(f=>f.startsWith('web/'))?' test-web.log':''}${tf.some(f=>f.startsWith('integrations/cli/'))?' test-cli.log':''})`);
    if (esGreen.length) parts.push(`playwright: ${esGreen.map(s => `${s} ✓ (${e2e[s].passed} passed${e2e[s].retried?`, ${e2e[s].retried} passed-on-retry`:''})`).join('; ')}`);
    r.verification = { command: [tfPassed.length ? TEST_CMD : null, esGreen.length ? E2E_CMD : null].filter(Boolean).join(' && '), result_excerpt: parts.join(' | ') };
  } else if (r.verdict === 'VERIFIED') {
    // proposed VERIFIED but nothing green to back it → downgrade
    r.verdict = 'IMPLEMENTED-UNVERIFIED';
    r.verification = null;
    r.notes = (r.notes ? r.notes + ' ' : '') + '[assemble] proposed VERIFIED without a green bearing test this sweep — held at IMPLEMENTED-UNVERIFIED.';
  } else {
    r.verification = null;
  }
  if (tfMissing.length || esRed.length || esNotRun.length) {
    r._verifNote = `bearing-but-not-green: vitest ${JSON.stringify(tfMissing)} e2e-red ${JSON.stringify(esRed)} e2e-not-run ${JSON.stringify(esNotRun)}`;
  }
  // ---- citation check ----
  for (const ev of (r.evidence || [])) {
    const fp = path.join(REPO, ev.file);
    let status = 'OK', content = '';
    if (ev.file.startsWith('audit/requirements/') || ev.file === 'memory-bank/activeContext.md') status = 'FORBIDDEN-PATH';
    else if (!fs.existsSync(fp)) status = 'NO-FILE';
    else if (fs.statSync(fp).isDirectory()) status = ev.line === 1 || ev.line === 0 ? 'DIR' : 'DIR-BAD-LINE';
    else {
      const lines = fs.readFileSync(fp, 'utf8').split('\n');
      const n = ev.line;
      if (!(n >= 1 && n <= lines.length)) status = `NO-LINE(${lines.length})`;
      else content = lines[n - 1].slice(0, 160);
    }
    if (status !== 'OK' && status !== 'DIR') badCitations++;
    citationReport.push(`${r.id}\t${status}\t${ev.file}:${ev.line}\t${(ev.note||'').slice(0,90)}\t|| ${content}`);
  }
}

// ---- matrix ----
const commit = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();
const dirty = execSync('git status --porcelain', { cwd: REPO }).toString().split('\n').filter(Boolean)
  .map(l => l.slice(3).trim()).filter(p => !p.startsWith('audit/requirements/sweep-'));
const cfgHash = execSync('shasum -a 256 audit/requirements.config.yaml', { cwd: REPO }).toString().split(' ')[0];

const allTickets = fs.readFileSync(path.join(SWEEP, 'tickets.md'), 'utf8').split('\n')
  .filter(l => /^TRO-\d+ \|/.test(l)).map(l => { const [id, status, parent, ...t] = l.split(' | '); return { id, status, parent, title: t.join(' | ') }; });
const mapped = new Set(rows.flatMap(r => r.tickets || []));
const orphan = allTickets.filter(t => !mapped.has(t.id));

const matrix = {
  mode: 'compare',
  label: 'w6-2026-08-16b',
  commit, dirty: dirty.length > 0, dirty_paths: dirty,
  date: new Date().toISOString(),
  config_hash: cfgHash,
  ticket_mapping: {
    status: 'OK', provider: 'linear', team: 'TRO',
    scope: 'All 113 issues in Linear project "PlugForge — Week 6 Platform & Public API" (config tickets.project), pulled 2026-08-16 ~13:45Z via mcp__linear__list_issues (single page, hasNextPage=false). Not the whole TRO team: the team spans six projects with interleaved numbers, so an unscoped pull would report other products\' work as orphans.'
  },
  requirements: rows.map(r => ({
    id: r.id, verdict: r.verdict, tickets: r.tickets || [], evidence: r.evidence || [],
    verification: r.verification || null, interpretation: r.interpretation || (r.id === 'W6-R25' ? 'I-04' : null),
    assumption: r.assumption || null, suggested_scope: r.suggested_scope || null,
    notes: [r.notes, r._verifNote].filter(Boolean).join(' ') || null,
    plain_english: r.plain_english || null,
    test_files_bearing: r.test_files_bearing || [], e2e_specs_bearing: r.e2e_specs_bearing || [],
    delta_vs_prior: r.delta_vs_prior || null, prior_verdict: priorById[r.id]?.verdict || null,
  })),
  orphan_tickets: orphan.map(t => ({ ticket: t.id, title: t.title, status: t.status, note: /^EPIC/.test(t.title) ? 'epic-parent organizational issue — maps to no single requirement' : 'maps to no inventory requirement' })),
  needs_ruling: rows.filter(r => r.needs_ruling).map(r => ({ id: r.id, cluster: r._cluster, question: r.needs_ruling, traced_under: r.assumption })),
  commands_run: [],
  baselineRef: 'matrix.baseline-W6.json',
  compareRef: 'matrix.after-w6-2026-08-16.json',
};
fs.writeFileSync(path.join(SWEEP, 'matrix.draft.json'), JSON.stringify(matrix, null, 2));
fs.writeFileSync(path.join(SWEEP, 'citation-check.txt'), citationReport.join('\n'));
fs.writeFileSync(path.join(SWEEP, 'subagent-commands.json'), JSON.stringify(commands, null, 2));

// ---- summary to stdout ----
const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
console.log('rows:', rows.length, 'tally:', tally);
console.log('bad citations:', badCitations, '(see citation-check.txt)');
console.log('orphans:', orphan.length);
console.log('needs_ruling:', matrix.needs_ruling.length);
console.log('delta (verdict changed vs 08-16):');
for (const r of matrix.requirements) if (r.prior_verdict !== r.verdict) console.log(`  ${r.id}: ${r.prior_verdict} -> ${r.verdict}`);
console.log('rows with bearing-but-not-green:');
for (const r of rows) if (r._verifNote) console.log(`  ${r.id}: ${r._verifNote}`);
