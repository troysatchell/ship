// API-COMPARE noise-check re-run — documents-byid ONLY, all 3 concurrencies.
// Same methodology as bench-runner-compare.mjs (itself an unmodified copy of
// baseline's bench-runner.mjs apart from documented path/port constants).
// Purpose: the primary compare run showed documents-byid P95 improving at
// c=10/c=50 but regressing at c=25 — an inconsistent pattern for the
// cheapest, smallest-payload endpoint. This supplementary run checks whether
// that c=25 result reproduces or was single-sample noise. Written to a
// separate output file so the primary run's artifact is untouched.
import autocannon from '/private/tmp/claude-501/-Users-troy-repos-GAUNTLET-Ship/359b10cb-440a-4234-9788-b0e8f685c709/scratchpad/node_modules/autocannon/autocannon.js';
import fs from 'node:fs';

const DIR = '/private/tmp/claude-501/-Users-troy-repos-GAUNTLET-Ship/359b10cb-440a-4234-9788-b0e8f685c709/scratchpad';
const OUT = '/Users/troy/repos/GAUNTLET/Ship-wt-api_compare/audit/api-perf/compare-phase2-jul30/raw';
const COOKIE = fs.readFileSync(DIR + '/API-COMPARE-cookie.txt', 'utf8').trim();
const API = 'http://localhost:3211';

const path = '/api/documents/6a8a183b-4457-4904-822c-feea67bae90e';
const CONCURRENCY = [10, 25, 50];
const BURST = 900;
const WARMUP = 80;
const NEED_REMAINING = 940;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(buckets, total, q) {
  const target = q * total;
  let cum = 0;
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) { cum += buckets.get(k); if (cum >= target) return k; }
  return 0;
}

async function probe() {
  const r = await fetch(API + '/api/weeks', { headers: { Cookie: COOKIE } });
  await r.arrayBuffer();
  return {
    status: r.status,
    remaining: Number(r.headers.get('ratelimit-remaining')),
    reset: Number(r.headers.get('ratelimit-reset')),
  };
}

async function waitForWindow(need) {
  for (let i = 0; i < 10; i++) {
    const p = await probe();
    if (p.status === 200 && p.remaining >= need) return p;
    const wait = (Number.isFinite(p.reset) ? p.reset : 60) + 2;
    process.stderr.write(`    waiting ${wait}s (remaining=${p.remaining})\n`);
    await sleep(wait * 1000);
  }
  throw new Error('never got a clean window');
}

function burst(url, connections, amount) {
  return new Promise((resolve, reject) => {
    const buckets = new Map();
    let n = 0, bytes = 0;
    const inst = autocannon(
      { url, connections, amount, headers: { Cookie: COOKIE }, timeout: 30 },
      (err, res) => (err ? reject(err) : resolve({ res, buckets, n, bytes }))
    );
    inst.on('response', (_c, _s, resBytes, responseTime) => {
      const ms = Math.round(responseTime * 1000) / 1000;
      buckets.set(ms, (buckets.get(ms) || 0) + 1);
      n++; bytes += resBytes;
    });
  });
}

const all = [];
const url = API + path;
for (const c of CONCURRENCY) {
  let row = null;
  for (let attempt = 1; attempt <= 3 && !row; attempt++) {
    process.stderr.write(`=== documents-byid-recheck c=${c} attempt ${attempt} ${new Date().toISOString()}\n`);
    await waitForWindow(NEED_REMAINING);
    if (c === 10) { await burst(url, 10, WARMUP); }
    const { res, buckets, n } = await burst(url, c, BURST);
    if (res.non2xx > 0 || res.errors > 0 || n < BURST * 0.98) {
      process.stderr.write(`    DISCARD: non2xx=${res.non2xx} errors=${res.errors}\n`);
      continue;
    }
    row = {
      concurrency: c,
      p50: pct(buckets, n, 0.50), p95: pct(buckets, n, 0.95), p99: pct(buckets, n, 0.99),
      errors: res.errors, non2xx: res.non2xx, status2xx: res['2xx'],
    };
    process.stderr.write(`    p50=${row.p50} p95=${row.p95} p99=${row.p99} 2xx=${row.status2xx}\n`);
  }
  if (!row) throw new Error(`could not get a clean measurement c=${c}`);
  all.push(row);
}
fs.writeFileSync(`${OUT}/_byid_recheck.json`, JSON.stringify(all, null, 2));
process.stderr.write(`=== DONE ${new Date().toISOString()}\n`);
