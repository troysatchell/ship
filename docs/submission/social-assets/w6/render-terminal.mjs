// TRO-444: renders a captured CLI transcript (.txt) to a dark terminal-window PNG. Run from repo root:
//   node docs/submission/social-assets/w6/render-terminal.mjs <in.txt> <out.png> "<window title>"
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [,, txtPath, pngPath, title] = process.argv;
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const lines = readFileSync(txtPath, 'utf8').replace(/\n$/, '').split('\n').map((l) => {
  if (l.startsWith('$ ')) return `<div class="l"><span class="p">$</span> <span class="cmd">${esc(l.slice(2))}</span></div>`;
  if (l.startsWith('✓ verified')) return `<div class="l ok">${esc(l)}</div>`;
  if (l.startsWith('✗ rejected')) return `<div class="l bad">${esc(l)}</div>`;
  if (l === '') return `<div class="l">&nbsp;</div>`;
  return `<div class="l dim">${esc(l)}</div>`;
}).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#0b0f14;}
.win{width:1180px;margin:32px;border-radius:12px;background:#0d1117;box-shadow:0 20px 60px rgba(0,0,0,.6);border:1px solid #21262d;overflow:hidden;font-family:"SF Mono",Menlo,"JetBrains Mono",ui-monospace,monospace;}
.bar{height:38px;background:#161b22;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid #21262d;}
.dot{width:12px;height:12px;border-radius:50%;margin-right:8px;}
.t{flex:1;text-align:center;color:#8b949e;font-size:13px;margin-right:60px;}
.body{padding:22px 26px 26px;font-size:17px;line-height:1.55;color:#c9d1d9;white-space:pre;}
.p{color:#58a6ff;font-weight:600}.cmd{color:#f0f6fc;font-weight:600}
.dim{color:#8b949e}.ok{color:#3fb950;font-weight:700;background:rgba(63,185,80,.10);margin:2px -10px;padding:2px 10px;border-radius:6px}
.bad{color:#f85149;font-weight:700}
.foot{padding:10px 26px 14px;color:#6e7681;font-size:12px;border-top:1px solid #21262d;font-family:-apple-system,system-ui,sans-serif}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span><span class="t">${esc(title)}</span></div><div class="body">${lines}</div><div class="foot">Real @ship/cli output rendered to an image (not a photo) — Ship @ b68da413, 2026-08-16. Signature checked live with @ship/sdk verifyWebhook().</div></div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1244, height: 400 }, deviceScaleFactor: 2 });
await page.setContent(html);
const win = page.locator('.win');
await win.screenshot({ path: pngPath, omitBackground: false });
await browser.close();
console.log('wrote', pngPath);
