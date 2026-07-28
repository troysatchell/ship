// Independent axe-core + keyboard + a11y-tree scan of Ship's key pages and interactive states.
// Reports ALL impact levels (existing repo specs assert only impact==critical).
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'fs';

const CHROME = '/Users/troy/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://localhost:5173';
// Export SESSION_ID from a fresh login (dev@ship.local/admin123) before running — see
// audit/shipshape.config.yaml `auth:`. WIKI_DOC_ID: any seeded wiki doc id.
const SESSION = process.env.SESSION_ID || '';
const WIKI = process.env.WIKI_DOC_ID || '442f288a-ad31-47df-bbb7-17303fb291e1';
if (!SESSION) { console.error('Set SESSION_ID (fresh session_id cookie) before running.'); process.exit(1); }
const OUT = 'audit/a11y/axe';
mkdirSync(OUT, { recursive: true });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
const isMac = process.platform === 'darwin';

const results = [];
const keyboard = [];

async function scan(page, label) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = r.violations.map(x => ({
    id: x.id, impact: x.impact, help: x.help,
    nodes: x.nodes.length,
    targets: x.nodes.slice(0, 4).map(n => n.target.join(' ')),
  }));
  const bySev = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const x of v) bySev[x.impact ?? 'minor'] += 1;
  results.push({ label, url: page.url(), counts: bySev, violations: v });
  writeFileSync(`${OUT}/${label.replace(/[^\w]+/g, '_')}.json`, JSON.stringify(r.violations, null, 2));
  console.log(`  [axe] ${label.padEnd(28)} C${bySev.critical} S${bySev.serious} M${bySev.moderate} m${bySev.minor}  (${page.url()})`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'session_id', value: SESSION, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

// The seeded dev user has an overdue action item, so an "Action Items" role=dialog
// auto-opens on every navigation and traps focus. Dismiss it so page scans/keyboard
// probes measure the actual page, not the modal. Record whether Escape works.
const modalDismiss = { escapeClosed: null, hadModal: 0 };
async function dismissActionItemsModal() {
  const sel = '[role="dialog"][aria-labelledby], [role="dialog"]';
  const present = await page.locator(sel).filter({ hasText: 'Action Items' }).count().catch(() => 0);
  if (!present) return;
  modalDismiss.hadModal++;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  let stillOpen = await page.locator(sel).filter({ hasText: 'Action Items' }).count().catch(() => 0);
  if (modalDismiss.escapeClosed === null) modalDismiss.escapeClosed = stillOpen === 0;
  if (stillOpen) {
    // fall back to an explicit close/dismiss button
    for (const b of ['button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]', '[role="dialog"] button']) {
      const btn = page.locator(b).first();
      if (await btn.count()) { await btn.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300); }
      stillOpen = await page.locator(sel).filter({ hasText: 'Action Items' }).count().catch(() => 0);
      if (!stillOpen) break;
    }
  }
}
async function goto(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1200);
  await dismissActionItemsModal();
}

try {
  // ---- static page scans ----
  await goto('/my-week');       await scan(page, 'dashboard (my-week)');
  await goto('/issues');        await scan(page, 'issues list');
  await goto('/weeks');         await scan(page, 'weeks board');
  await goto('/search');        await scan(page, 'search');
  await goto(`/documents/${WIKI}`); await page.waitForTimeout(1500); await scan(page, 'document view');

  // ---- interactive states ----
  // editor focused
  try { await page.locator('.ProseMirror, [contenteditable="true"]').first().click({ timeout: 4000 }); await page.waitForTimeout(400); await scan(page, 'document editor focused'); } catch (e) { console.log('  (editor focus skipped:', e.message, ')'); }

  // command palette (Cmd/Ctrl+K)
  try {
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    await page.waitForTimeout(700);
    const open = await page.locator('[role="dialog"], [cmdk-root], input[placeholder*="Search" i]').count();
    if (open) { await scan(page, 'command palette open'); await page.keyboard.press('Escape'); }
    else console.log('  (command palette did not open)');
  } catch (e) { console.log('  (palette skipped:', e.message, ')'); }

  // issues: open a row / any menu button state
  await goto('/issues');
  try {
    const menuBtn = page.locator('button[aria-haspopup], [aria-expanded]').first();
    if (await menuBtn.count()) { await menuBtn.click({ timeout: 3000 }).catch(()=>{}); await page.waitForTimeout(500); await scan(page, 'issues menu/expanded state'); }
  } catch {}

  // login page (unauth) — separate context, no cookie
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const lp = await anon.newPage();
  await lp.goto(BASE + '/login', { waitUntil: 'networkidle' }).catch(()=>{});
  await lp.waitForTimeout(800);
  { const r = await new AxeBuilder({ page: lp }).withTags(TAGS).analyze();
    const bySev = { critical:0, serious:0, moderate:0, minor:0 };
    r.violations.forEach(x => bySev[x.impact ?? 'minor']++);
    results.push({ label: 'login (unauth)', url: lp.url(), counts: bySev, violations: r.violations.map(x=>({id:x.id,impact:x.impact,help:x.help,nodes:x.nodes.length,targets:x.nodes.slice(0,4).map(n=>n.target.join(' '))})) });
    writeFileSync(`${OUT}/login_unauth.json`, JSON.stringify(r.violations, null, 2));
    console.log(`  [axe] ${'login (unauth)'.padEnd(28)} C${bySev.critical} S${bySev.serious} M${bySev.moderate} m${bySev.minor}`);
  }
  await anon.close();

  // ---- keyboard nav probes ----
  // focus-visible styles present? tab order length + reachable interactive count on issues + my-week
  for (const [label, path] of [['issues','/issues'], ['dashboard','/my-week']]) {
    await goto(path);
    const kb = await page.evaluate(() => {
      const focusables = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')].filter(el => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      return { focusableCount: focusables.length };
    });
    // walk Tab up to 40 times, record whether a visible focus outline appears
    let tabbed = 0, ringSeen = 0, lastActive = '';
    const seen = new Set();
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const tag = el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : (el.textContent ? `:${el.textContent.trim().slice(0,20)}` : ''));
        const hasRing = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
        return { tag, hasRing };
      });
      if (info) { tabbed++; if (info.hasRing) ringSeen++; seen.add(info.tag); if (info.tag === lastActive) break; lastActive = info.tag; }
    }
    keyboard.push({ page: label, path, focusableCount: kb.focusableCount, tabStops: tabbed, uniqueStops: seen.size, focusRingSeen: ringSeen, focusRingRatio: tabbed ? +(ringSeen / tabbed).toFixed(2) : 0 });
    console.log(`  [kbd] ${label.padEnd(12)} focusable=${kb.focusableCount} tabStops=${tabbed} unique=${seen.size} focusRing=${ringSeen}/${tabbed}`);
  }

  // ---- a11y tree structure on document view ----
  await goto(`/documents/${WIKI}`);
  const tree = await page.evaluate(() => {
    const landmarks = [...document.querySelectorAll('[role], main, nav, header, footer, aside')].map(e => e.getAttribute('role') || e.tagName.toLowerCase());
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1]);
    const imgsNoAlt = [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt') && i.getAttribute('aria-hidden') !== 'true').length;
    const svgNoLabel = [...document.querySelectorAll('svg')].filter(s => s.getAttribute('aria-hidden') !== 'true' && !s.getAttribute('aria-label') && !s.querySelector('title')).length;
    const inputsNoLabel = [...document.querySelectorAll('input,textarea,select')].filter(inp => {
      const id = inp.id; const hasFor = id && document.querySelector(`label[for="${id}"]`);
      return !hasFor && !inp.getAttribute('aria-label') && !inp.getAttribute('aria-labelledby') && !inp.closest('label');
    }).length;
    const liveRegions = document.querySelectorAll('[aria-live],[role="status"],[role="alert"]').length;
    const h1 = document.querySelectorAll('h1').length;
    return { landmarks, headings, h1Count: h1, imgsNoAlt, svgNoLabel, inputsNoLabel, liveRegions };
  });
  console.log('  [tree] document view:', JSON.stringify(tree));

  writeFileSync(`${OUT}/_summary.json`, JSON.stringify({ results, keyboard, tree, modalDismiss }, null, 2));
  console.log('\nWROTE audit/a11y/axe/_summary.json');
} finally {
  await browser.close();
}
