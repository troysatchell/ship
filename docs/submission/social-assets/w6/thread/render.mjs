// TRO-444 W6 thread cards: renders every `.card` in cards.html to <id>.png at 2×. Run from repo root:
//   node docs/submission/social-assets/w6/thread/render.mjs [id ...]
// Needs network once (Google Fonts: Plus Jakarta Sans + JetBrains Mono).
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = dirname(fileURLToPath(import.meta.url));
const only = new Set(process.argv.slice(2));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
await p.goto('file://' + join(DIR, 'cards.html'));
await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
await p.waitForTimeout(1500);
for (const id of await p.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.id))) {
  if (only.size && !only.has(id)) continue;
  await p.locator(`[id="${id}"]`).screenshot({ path: join(DIR, `${id}.png`) });
  console.log('wrote', `${id}.png`);
}
await b.close();
