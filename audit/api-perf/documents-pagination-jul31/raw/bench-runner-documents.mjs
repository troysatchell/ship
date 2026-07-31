// TRO-304 (API-3) — before/after P95 measurement for pagination on
// `GET /api/documents`, reusing bench-runner-compare.mjs's exact methodology
// (which itself reuses the original audit/api-perf/raw/bench-runner.mjs
// unmodified in methodology): rate-limit-window-synchronised bursts,
// autocannon 8.0.0, BURST=900 / WARMUP=80, concurrency [10,25,50], identical
// percentile computation from raw per-response latencies.
//
// This is a COPY, not an edit, of bench-runner-compare.mjs — same reasoning
// as that file's own header: hardcoded paths/ports/ids from a prior session
// cannot resolve in this one. Only the constants below differ; the
// measurement logic (bursts, window sync, percentile math, discard/retry
// rule) is byte-for-byte the same. Diff against
// ../../compare-phase2-jul30/raw/bench-runner-compare.mjs to verify.
//
// Scoped to ONE endpoint (`GET /api/documents`, no params — the exact call
// the pagination fix changes) rather than all 6 keyEndpoints, because this is
// a single-endpoint fix, not a repeat of the phase2 compare. Run once against
// the pre-fix code (`--label before`) and once against the post-fix code
// (`--label after`), same server, same seeded database, only the route
// source toggled between runs (see documents-pagination-jul31.md for exact
// steps — no git stash used, per factory rule 9).
import autocannon from '/private/tmp/claude-501/-Users-troy-repos-GAUNTLET-Ship/28790b2f-d965-45fb-9a4b-51fb667b30ba/scratchpad/node_modules/autocannon/autocannon.js';
import fs from 'node:fs';

const DIR = '/private/tmp/claude-501/-Users-troy-repos-GAUNTLET-Ship/28790b2f-d965-45fb-9a4b-51fb667b30ba/scratchpad';
const OUT = '/Users/troy/repos/GAUNTLET/Ship-wt-tro_304/audit/api-perf/documents-pagination-jul31/raw';
fs.mkdirSync(OUT, { recursive: true });
const COOKIE = fs.readFileSync(DIR + '/TRO304-cookie.txt', 'utf8').trim();
const API = 'http://localhost:3813';

const LABEL = process.argv[2]; // 'before' or 'after'
if (LABEL !== 'before' && LABEL !== 'after') {
  console.error("usage: node bench-runner-documents.mjs <before|after>");
  process.exit(1);
}

const ENDPOINTS = [
  ['documents-all', 'GET /api/documents', '/api/documents'],
];
const CONCURRENCY = [10, 25, 50];
const BURST = 900;         // measured requests per window
const WARMUP = 80;         // discarded, shares the c=10 window (probe 1 + 80 + 900 = 981 < 1000)
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
    limit: Number(r.headers.get('ratelimit-limit')),
    remaining: Number(r.headers.get('ratelimit-remaining')),
    reset: Number(r.headers.get('ratelimit-reset')), // seconds until window reset
  };
}

// Block until a fresh limiter window with enough budget.
async function waitForWindow(need) {
  for (let i = 0; i < 10; i++) {
    const p = await probe();
    if (p.status === 200 && p.remaining >= need) return p;
    const wait = (Number.isFinite(p.reset) ? p.reset : 60) + 2;
    process.stderr.write(`    waiting ${wait}s for limiter window (status=${p.status} remaining=${p.remaining})\n`);
    await sleep(wait * 1000);
  }
  throw new Error('never got a clean rate-limit window');
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
for (const [name, label, path] of ENDPOINTS) {
  const url = API + path;
  for (const c of CONCURRENCY) {
    let row = null;
    for (let attempt = 1; attempt <= 3 && !row; attempt++) {
      process.stderr.write(`=== ${LABEL} ${name} c=${c} attempt ${attempt} ${new Date().toISOString()}\n`);
      await waitForWindow(NEED_REMAINING);
      if (c === 10) {
        process.stderr.write(`    warmup ${WARMUP} reqs (discarded)\n`);
        await burst(url, 10, WARMUP);
      }
      const { res, buckets, n, bytes } = await burst(url, c, BURST);
      if (res.non2xx > 0 || res.errors > 0 || n < BURST * 0.98) {
        process.stderr.write(`    DISCARD: non2xx=${res.non2xx} errors=${res.errors} samples=${n} codes=${JSON.stringify(res.statusCodeStats)}\n`);
        continue;
      }
      row = {
        label: LABEL, endpoint: label, name, path, concurrency: c,
        p50: pct(buckets, n, 0.50), p95: pct(buckets, n, 0.95), p99: pct(buckets, n, 0.99),
        mean: Math.round(res.latency.mean * 1000) / 1000, max: res.latency.max, min: res.latency.min,
        rps: Math.round(res.requests.average * 100) / 100,
        totalRequests: res.requests.total, latencySamples: n,
        errors: res.errors, timeouts: res.timeouts, non2xx: res.non2xx,
        status2xx: res['2xx'], statusCodeStats: res.statusCodeStats,
        meanBytesPerResponse: n ? Math.round(bytes / n) : 0,
        throughputBytesPerSec: Math.round(res.throughput.average),
        durationSec: res.duration,
        autocannonLatency: res.latency,
      };
      fs.writeFileSync(`${OUT}/${LABEL}-${name}-c${c}.json`, JSON.stringify({ raw: res, computed: row }, null, 2));
      process.stderr.write(`    p50=${row.p50} p95=${row.p95} p99=${row.p99} rps=${row.rps} 2xx=${row.status2xx} bytes/res=${row.meanBytesPerResponse} dur=${row.durationSec}s\n`);
    }
    if (!row) throw new Error(`could not get a clean measurement for ${name} c=${c}`);
    all.push(row);
    fs.writeFileSync(`${OUT}/_progress-${LABEL}.json`, JSON.stringify(all, null, 2));
  }
}
fs.writeFileSync(`${OUT}/_all-${LABEL}.json`, JSON.stringify(all, null, 2));
process.stderr.write(`=== DONE ${LABEL} ${new Date().toISOString()}\n`);
