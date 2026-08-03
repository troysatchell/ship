#!/usr/bin/env node
/**
 * board.mjs — render the factory state as a self-contained HTML control panel.
 *
 *   node scripts/factory/board.mjs > audit/factory/board.html
 *
 * Then publish with the Artifact tool using the SAME file path each time so it
 * redeploys to one stable URL rather than minting a new one per run.
 *
 * Self-contained by necessity: the Artifact CSP blocks every external host, so
 * no CDN fonts, no remote assets, no fetch. All state is inlined at build time —
 * this is a snapshot, and it says so.
 */

import { collect } from './lib/state.mjs'

const s = collect()
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const n = (x) => Number(x || 0).toLocaleString('en-US')

const fap = s.scorecard.firstAttemptPass
const fapPct = fap ? Math.round((fap.pass / fap.of) * 100) : null
const gateFails = Object.entries(s.scorecard.gateFailures || {}).sort((a, b) => b[1] - a[1])
const maxFail = gateFails.length ? gateFails[0][1] : 0

const ciPill = (ci) => {
  const map = { green: ['ok', 'CI green'], failing: ['bad', 'CI failing'], pending: ['wait', 'CI pending'], none: ['idle', 'no checks'] }
  const [cls, label] = map[ci] || map.none
  return `<span class="pill ${cls}">${label}</span>`
}

const worktreeRows = s.worktrees.length ? s.worktrees.map((w) => {
  const g = w.gate
  const state = !g ? 'idle' : g.verdict === 'pass' ? 'ok' : 'bad'
  const verdict = !g ? 'not gated yet'
    : g.verdict === 'pass' ? 'gate pass'
    : `gate fail — ${esc(g.failed.join(', '))}`
  return `
  <li class="row ${state}">
    <div class="row-head">
      <span class="title">${esc(w.title)}</span>
      <span class="tkt">${esc(w.ticket)}</span>
      <span class="verdict">${verdict}</span>
      <span class="commits">${w.commits} commit${w.commits === 1 ? '' : 's'}</span>
    </div>
    <div class="live">${esc(w.liveAction)}</div>
    <div class="row-meta">
      <span>${esc(w.branch)}</span>
      <span>db ${esc(w.db ?? '—')}</span>
      <span>api :${esc(w.apiPort ?? '—')}</span>
      <span>web :${esc(w.webPort ?? '—')}</span>
    </div>
  </li>`
}).join('') : `<li class="empty">No ticket worktrees provisioned. The factory is idle.</li>`

const prRows = s.pullRequests.length ? s.pullRequests.map((p) => `
  <li class="row ${p.ci === 'green' ? 'ok' : p.ci === 'failing' ? 'bad' : 'wait'}">
    <div class="row-head">
      <span class="tkt">#${p.number}${p.ticket ? ' · ' + esc(p.ticket) : ''}</span>
      ${ciPill(p.ci)}
      ${p.review ? `<span class="pill idle">${esc(p.review.toLowerCase().replace(/_/g, ' '))}</span>` : ''}
    </div>
    <div class="row-meta"><span>${esc(p.title)}</span></div>
  </li>`).join('') : `<li class="empty">No open pull requests.</li>`

const warnBlock = s.warnings.length ? `
<section class="panel annunciator">
  <h2>Attention</h2>
  <ul class="warn">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
</section>` : ''

const costBlock = s.cost.available ? `
<section class="panel">
  <h2>Spend</h2>
  <p class="basis">List-rate estimate over observed token counts — <strong>not billed spend</strong>.
     On a subscription plan the marginal cost is zero and this is API-equivalent value.</p>
  <div class="tokens">
    <div><span class="k">output</span><span class="v">${n(s.cost.totals.out)}</span></div>
    <div><span class="k">cache write</span><span class="v">${n(s.cost.totals.cw)}</span></div>
    <div><span class="k">cache read</span><span class="v">${n(s.cost.totals.cr)}</span></div>
    <div><span class="k">raw input</span><span class="v">${n(s.cost.totals.in)}</span></div>
  </div>
  <div class="cachebar" role="img"
       aria-label="${Math.round(s.cost.cacheReadShare * 100)} percent of token volume is cache reads">
    <div class="fill" style="width:${(s.cost.cacheReadShare * 100).toFixed(1)}%"></div>
  </div>
  <p class="note">${Math.round(s.cost.cacheReadShare * 100)}% of all token volume is cache reads, billed at one tenth
     the input rate. The economics of this workflow are prompt-cache economics.</p>
</section>` : ''

const trendBlock = `
<section class="panel">
  <h2>Gate trend</h2>
  ${fap ? `<p class="lede"><strong>${fap.pass}/${fap.of}</strong> tickets passed the gate on their first attempt (${fapPct}%).</p>`
        : `<p class="lede muted">No scorecard rows yet — the trend appears once tickets run.</p>`}
  ${gateFails.length ? `
  <table>
    <caption>Which gate fails, and how often</caption>
    <thead><tr><th scope="col">Gate</th><th scope="col">Failures</th><th scope="col"></th></tr></thead>
    <tbody>${gateFails.map(([g, c]) => `
      <tr><th scope="row">${esc(g)}</th><td class="num">${c}</td>
      <td class="barcell"><div class="bar" style="width:${(c / maxFail) * 100}%"></div></td></tr>`).join('')}
    </tbody>
  </table>
  <p class="note">The same gate failing repeatedly is a defect in the agent brief, not three careless
     agents. That is the signal this table exists to surface.</p>` : ''}
</section>`

// --live adds a meta refresh for the local server (scripts/factory/serve.mjs).
// It is deliberately OMITTED from the published Artifact: that copy is a shared
// snapshot, and a page that reloads itself every 15s in someone else's browser
// without new data behind it is just noise.
const live = process.argv.includes('--live')

process.stdout.write(`<title>Ship Factory — control panel</title>
${live ? '<meta http-equiv="refresh" content="15">' : ''}
<style>
  /* Cream ground, British racing green ink. Every severity colour below is
     contrast-checked against its own ground for WCAG AA normal text (>=4.5:1);
     measured ratios are in the comments so a future edit cannot quietly break
     them. Severity is carried by hue AND a tinted row wash AND a border stripe,
     so it never depends on colour perception alone. */
  :root {
    --paper:#F4F0E6; --panel:#FBF8F1; --ink:#0B2E1E; --muted:#5C5847; --line:#DED7C6;
    /* Measured, not estimated — see the checker in the commit message. */
    --accent:#004225;                 /* BRG on panel ............. 10.96:1 */
    --ok:#14532D;                     /* deep green on ok-wash .....  7.61:1 */
    --bad:#8E1D22;                    /* oxblood on bad-wash .......  7.28:1 */
    --wait:#6F5300;                   /* dark amber on wait-wash ...  6.06:1 */
    --idle:#6B6455;                   /* warm grey on panel ........  5.53:1 */
    --ok-wash:#E4EDE4; --bad-wash:#F6E4E1; --wait-wash:#F3EBD6;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* SINGLE-THEME BY CHOICE, not omission. This board commits to cream and
     British racing green in every context. Both data-theme values are pinned
     to the same tokens so the viewer's theme toggle and a dark OS preference
     cannot flip it — without these two blocks the toggle would find no dark
     definition and leave the page cream anyway, but a later edit adding a dark
     media query would silently start winning. This makes the intent explicit. */
  @media (prefers-color-scheme: dark) {
    :root {
      --paper:#F4F0E6; --panel:#FBF8F1; --ink:#0B2E1E; --muted:#5C5847; --line:#DED7C6;
      --accent:#004225; --ok:#14532D; --bad:#8E1D22; --wait:#6F5300; --idle:#6B6455;
      --ok-wash:#E4EDE4; --bad-wash:#F6E4E1; --wait-wash:#F3EBD6;
    }
  }
  :root[data-theme="dark"], :root[data-theme="light"] {
    --paper:#F4F0E6; --panel:#FBF8F1; --ink:#0B2E1E; --muted:#5C5847; --line:#DED7C6;
    --accent:#004225; --ok:#14532D; --bad:#8E1D22; --wait:#6F5300; --idle:#6B6455;
    --ok-wash:#E4EDE4; --bad-wash:#F6E4E1; --wait-wash:#F3EBD6;
  }
  html, body { background:#F4F0E6; }   /* cream to the edges, above the fold and below */

  body { background:var(--paper); color:var(--ink); font-family:var(--mono);
         font-size:14px; line-height:1.5; padding:clamp(16px,4vw,44px); }
  .wrap { max-width:940px; margin:0 auto; display:flex; flex-direction:column; gap:22px; }

  header { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px;
           border-bottom:2px solid var(--ink); padding-bottom:12px; }
  h1 { font-size:19px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
  .stamp { color:var(--muted); font-size:12px; margin-left:auto; }

  .strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:2px;
           background:var(--line); border:1px solid var(--line); }
  .cell { background:var(--panel); padding:14px 16px; display:flex; flex-direction:column; gap:5px; }
  .cell .k { font-size:10.5px; letter-spacing:.13em; text-transform:uppercase; color:var(--muted); }
  .cell .v { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
  .cell .v.dim { color:var(--muted); font-weight:400; font-size:19px; }

  .panel { background:var(--panel); border:1px solid var(--line); padding:18px 20px;
           display:flex; flex-direction:column; gap:12px; }
  h2 { font-size:11px; letter-spacing:.15em; text-transform:uppercase; color:var(--accent);
       font-weight:700; }

  ul { list-style:none; display:flex; flex-direction:column; gap:2px; }
  /* Severity reads three ways at once — stripe, wash, and text colour — so a row
     needing attention is findable at a glance and without relying on hue alone. */
  .row { border-left:4px solid var(--idle); padding:9px 12px; }
  .row.ok { border-left-color:var(--ok); background:var(--ok-wash); }
  .row.bad { border-left-color:var(--bad); background:var(--bad-wash); }
  .row.wait { border-left-color:var(--wait); background:var(--wait-wash); }
  .row-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
  /* Title is the primary label — what to go read is more useful at a glance than
     which numbered bucket it's filed under. The ticket ID survives as a small
     tag so it's still there to cross-reference against Linear/PRs. */
  .title { font-family:var(--sans); font-weight:700; font-size:14.5px; flex:1 1 220px; }
  .tkt { font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:.04em;
         color:var(--muted); border:1px solid var(--line); border-radius:2px; padding:1px 7px; }
  .verdict { color:var(--muted); }
  .row.bad .verdict { color:var(--bad); }
  .row.ok .verdict { color:var(--ok); }
  .commits { margin-left:auto; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
  /* What the worktree is doing right now, not just which ticket it's on. */
  .live { font-family:var(--mono); font-size:12px; color:var(--accent); margin-top:4px; }
  .row-meta { display:flex; flex-wrap:wrap; gap:14px; color:var(--muted); font-size:12px; margin-top:3px; }
  .empty { color:var(--muted); padding:9px 0 9px 15px; }

  .pill { font-size:10.5px; letter-spacing:.07em; text-transform:uppercase; padding:2px 8px;
          border:1px solid currentColor; border-radius:2px; }
  .pill.ok{color:var(--ok);} .pill.bad{color:var(--bad);}
  .pill.wait{color:var(--wait);} .pill.idle{color:var(--idle);}

  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  caption { text-align:left; color:var(--muted); font-size:12px; padding-bottom:7px; }
  th,td { text-align:left; padding:5px 10px 5px 0; border-bottom:1px solid var(--line); font-weight:400; }
  thead th { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .num { text-align:right; width:64px; }
  .barcell { width:46%; }
  .bar { height:7px; background:var(--accent); opacity:.75; }

  .tokens { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:12px; }
  .tokens .k { display:block; font-size:10.5px; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); }
  .tokens .v { display:block; font-size:16px; font-variant-numeric:tabular-nums; }
  .cachebar { height:9px; background:var(--line); overflow:hidden; }
  .cachebar .fill { height:100%; background:var(--accent); }

  .basis, .note, .lede { font-family:var(--sans); max-width:64ch; }
  .basis, .note { color:var(--muted); font-size:12.5px; }
  .lede { font-size:15px; }
  .muted { color:var(--muted); }

  .annunciator { border-left:3px solid var(--wait); }
  .warn li { color:var(--wait); padding:3px 0; }

  footer { color:var(--muted); font-size:12px; font-family:var(--sans);
           border-top:1px solid var(--line); padding-top:12px; }
  a { color:var(--accent); }
  a:focus-visible, :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  @media (prefers-reduced-motion:reduce){ *{animation:none!important;transition:none!important} }
</style>

<div class="wrap">
  <header>
    <h1>Ship Factory</h1>
    <span class="stamp">main@${esc(s.repo.mainSha)} · ${esc(new Date(s.generatedAt).toUTCString())}</span>
  </header>

  <div class="strip">
    <div class="cell"><span class="k">In flight</span><span class="v">${s.worktrees.length}</span></div>
    <div class="cell"><span class="k">Open PRs</span><span class="v">${s.pullRequests.length}</span></div>
    <div class="cell"><span class="k">First-attempt pass</span>
      <span class="v ${fap ? '' : 'dim'}">${fap ? fap.pass + '/' + fap.of : '—'}</span></div>
    <div class="cell"><span class="k">Spend (est.)</span>
      <span class="v">${s.cost.available ? '$' + s.cost.usd.toFixed(0) : '—'}</span></div>
  </div>

  <section class="panel">
    <h2>In flight</h2>
    <ul>${worktreeRows}</ul>
  </section>

  <section class="panel">
    <h2>Open pull requests</h2>
    <ul>${prRows}</ul>
  </section>

  ${trendBlock}
  ${costBlock}
  ${warnBlock}

  <footer>
    Snapshot, not a live feed — regenerate with <code>node scripts/factory/board.mjs</code> and
    republish to the same URL. State is derived from git worktrees, gate results,
    <code>gh</code>, the scorecard and local session transcripts; there is no status file to drift.
    <strong>Linear remains authoritative for ticket status</strong> — this shows execution state.
  </footer>
</div>
`)
