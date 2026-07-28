// db-query-audit baseline: per-flow query capture harness.
// Brackets each user flow with a distinctive SQL marker so the Postgres statement log
// can be sliced per flow. Runs each flow twice (iter 1 = cold, iter 2 = steady state).
//
// Run: node audit/db-query/raw/flow-capture.mjs > audit/db-query/raw/flow-requests.json
import { chromium } from '/Users/troy/repos/GAUNTLET/Ship/node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/index.mjs';
import pg from '/Users/troy/repos/GAUNTLET/Ship/api/node_modules/pg/lib/index.js';

const WEB = 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID;
const CONN = 'postgresql://ship:ship_dev_password@localhost:5433/ship_dev';

const marker = new pg.Client({ connectionString: CONN });
await marker.connect();
const mark = async (s) => { await marker.query(`SELECT 'DBAUDIT_MARK ${s}' AS m`); };

const results = {};
let current = 'boot';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const timings = new Map();
page.on('request', (r) => timings.set(r, Date.now()));
page.on('requestfinished', async (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/')) return;
  const t0 = timings.get(r) ?? Date.now();
  const dur = Date.now() - t0;
  let status = null, size = null;
  try {
    const resp = await r.response();
    if (resp) { status = resp.status(); const b = await resp.body().catch(() => null); size = b ? b.length : null; }
  } catch { /* ignore */ }
  (results[current] ??= []).push({ method: r.method(), path: u.pathname + (u.search || ''), status, ms: dur, bytes: size });
});

// --- login once; not measured ---
await page.goto(WEB + '/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.fill('input[type="email"]', 'dev@ship.local').catch(() => {});
await page.fill('input[type="password"]', 'admin123').catch(() => {});
await page.click('button[type="submit"]').catch(() => {});
await page.waitForTimeout(5000);
console.error('after login url=', page.url());

const FLOWS = [
  ['Load main page',   async () => { await page.goto(WEB + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4000); }],
  ['View a document',  async () => { await page.goto(WEB + '/documents/' + DOC_ID, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000); }],
  ['List issues',      async () => { await page.goto(WEB + '/issues', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4500); }],
  ['Load sprint board',async () => { await page.goto(WEB + '/team/allocation', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4500); }],
  // Not in config.userFlows; added to capture the /api/weeks -> per-week standups
  // fan-out that api-perf flagged as suspected N+1 (API-4) at the SQL layer.
  ['Load week dashboard', async () => { await page.goto(WEB + '/dashboard', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4500); }],
  ['Search content',   async () => {
      await page.goto(WEB + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await page.keyboard.press('Meta+k').catch(() => {});
      await page.waitForTimeout(800);
      const box = await page.$('input[placeholder*="earch" i]');
      if (box) { await box.fill('sprint'); await page.waitForTimeout(3000); }
      else { console.error('NO SEARCH BOX FOUND'); }
  }],
];

for (const iter of [1, 2]) {
  for (const [name, fn] of FLOWS) {
    // quiesce: park on about:blank so the previous page issues nothing during the slice
    await page.goto('about:blank').catch(() => {});
    await page.waitForTimeout(2500);
    current = `${name}#${iter}`;
    results[current] ??= [];
    await mark(`START ${name} iter${iter}`);
    await fn();
    await mark(`END ${name} iter${iter}`);
    await page.waitForTimeout(500);
  }
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
await marker.end();
