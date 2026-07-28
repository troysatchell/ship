import { chromium } from '/Users/troy/repos/GAUNTLET/Ship/node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/index.mjs';

const WEB = 'http://localhost:5173';
const results = {};
let current = 'boot';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const timings = new Map();
page.on('request', (r) => { timings.set(r, Date.now()); });
page.on('requestfinished', async (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/')) return;
  const t0 = timings.get(r) ?? Date.now();
  const dur = Date.now() - t0;
  let status = null, size = null;
  try { const resp = await r.response(); if (resp) { status = resp.status(); const b = await resp.body().catch(() => null); size = b ? b.length : null; } } catch {}
  (results[current] ??= []).push({ method: r.method(), path: u.pathname + (u.search || ''), status, ms: dur, bytes: size });
});

async function flow(name, fn) {
  current = name;
  results[name] ??= [];
  await fn();
  await page.waitForTimeout(3500);
}

// --- login ---
await flow('login', async () => {
  await page.goto(WEB + '/login', { waitUntil: 'networkidle' }).catch(() => {});
  await page.fill('input[type="email"]', 'dev@ship.local').catch(() => {});
  await page.fill('input[type="password"]', 'admin123').catch(() => {});
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForTimeout(4000);
});
console.error('after login url=', page.url());

await flow('Load main page', async () => {
  await page.goto(WEB + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
});

await flow('Dashboard', async () => {
  await page.goto(WEB + '/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
});

await flow('Docs list', async () => {
  await page.goto(WEB + '/docs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
});

// grab a real doc id
const docId = process.env.DOC_ID;
await flow('View a document', async () => {
  await page.goto(WEB + '/documents/' + docId, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
});

await flow('List issues', async () => {
  await page.goto(WEB + '/issues', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
});

await flow('Load sprint board', async () => {
  await page.goto(WEB + '/team/allocation', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
});

await flow('Search content', async () => {
  // try the in-app search UI (cmd+k style) then fall back
  await page.keyboard.press('Meta+k').catch(() => {});
  await page.waitForTimeout(600);
  const box = await page.$('input[placeholder*="earch" i]');
  if (box) { await box.fill('sprint'); await page.waitForTimeout(2500); }
  else { console.error('NO SEARCH BOX FOUND'); }
});

console.log(JSON.stringify(results, null, 2));
await browser.close();
