#!/usr/bin/env node
/**
 * serve.mjs — the live operational dashboard.
 *
 *   node scripts/factory/serve.mjs          # http://localhost:7373
 *   node scripts/factory/serve.mjs --port 8080
 *
 * WHY THIS EXISTS ALONGSIDE THE PUBLISHED ARTIFACT:
 *
 *   The Artifact is republished by *an agent calling a tool*. A shell script
 *   cannot update it. So refreshing it costs a tool call and tokens, and only
 *   happens when an agent is mid-turn — which makes it a poor choice for the
 *   thing you stare at while a run is going. Use this to OPERATE; use the
 *   Artifact to SHARE a milestone.
 *
 * WHAT CHANGED, AND WHY:
 *
 *   The first version re-rendered a static page per request. It answered "which
 *   tickets exist" and left you to work out what was happening from that — which
 *   meant opening worktrees to find out. Two fixes:
 *
 *   1. PHASE, not status. Every ticket shows where it is on the path
 *      (provisioned → coding → committed → gate → PR → merged), how long it has
 *      been there, and whether that is longer than it should be. Derived from
 *      what the work produced — there is deliberately no status file, because a
 *      status file that drifts reads as authoritative while being wrong.
 *
 *   2. It streams. Server-sent events push state as it changes, and the elapsed
 *      timers tick locally every second, so the page keeps moving between polls
 *      rather than sitting frozen until you reload.
 */

import { createServer } from 'node:http'
import { collect } from './lib/state.mjs'

const portArg = process.argv.indexOf('--port')
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 7373

// Adaptive poll. `collect()` shells out to git and gh; on a big tree or a slow
// network that can take seconds, and hammering it every 3s would queue work
// behind itself. Measure, then back off.
let pollMs = 3000
const clients = new Set()
let lastJson = ''

function tick() {
  const started = Date.now()
  let payload
  try {
    payload = { ok: true, ...collect() }
  } catch (err) {
    payload = { ok: false, error: err.message, generatedAt: new Date().toISOString() }
  }
  const took = Date.now() - started
  pollMs = took > 2000 ? 8000 : took > 900 ? 5000 : 3000

  const json = JSON.stringify(payload)
  // Only push on change, but always heartbeat — a silent stream is
  // indistinguishable from a dead one, and the client shows connection state.
  const changed = json !== lastJson
  lastJson = json
  const frame = changed ? `data: ${json}\n\n` : `event: ping\ndata: {}\n\n`
  for (const res of clients) { try { res.write(frame) } catch { clients.delete(res) } }

  setTimeout(tick, pollMs)
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ship Factory</title>
<style>
:root{
  --paper:#F4F4F2; --card:#FCFCFB; --ink:#0B0B0C; --ink2:#54544F; --ink3:#8C8C86;
  --hair:rgba(11,11,12,.08); --shell:rgba(11,11,12,.035);
  --go:#1F5F54; --warn:#9A4B12; --stall:#8C2F2F; --idle:#8C8C86;
  --ease:cubic-bezier(.32,.72,0,1);
  --mono:'Geist Mono','SF Mono','JetBrains Mono',ui-monospace,monospace;
  --font:'Geist','SF Pro Display',-apple-system,'Segoe UI Variable Display',system-ui,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font);
  -webkit-font-smoothing:antialiased;padding:2rem 2.5rem 4rem}
header{display:flex;align-items:baseline;gap:1rem;margin-bottom:1.6rem;flex-wrap:wrap}
h1{font-size:1.15rem;font-weight:600;letter-spacing:-.02em;margin:0}
.conn{display:inline-flex;align-items:center;gap:.45rem;font-size:11px;color:var(--ink3);
  font-family:var(--mono);letter-spacing:.04em}
.dot{width:7px;height:7px;border-radius:50%;background:var(--go)}
.live .dot{animation:pulse 2s var(--ease) infinite}
.down .dot{background:var(--stall);animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.repo{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--ink3)}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem;margin-bottom:1.8rem}
.tile{background:var(--card);border:1px solid var(--hair);border-radius:1rem;padding:.9rem 1rem;
  box-shadow:0 1px 2px rgba(11,11,12,.03),0 10px 24px -18px rgba(11,11,12,.2)}
.tile .n{font-size:1.9rem;line-height:1;letter-spacing:-.04em;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{font-size:10px;text-transform:uppercase;letter-spacing:.16em;color:var(--ink3);margin-top:.45rem}
.tile.attn{border-color:rgba(154,75,18,.3);background:linear-gradient(180deg,rgba(154,75,18,.05),var(--card))}
.tile.attn .n{color:var(--warn)}
.tile.bad{border-color:rgba(140,47,47,.3);background:linear-gradient(180deg,rgba(140,47,47,.05),var(--card))}
.tile.bad .n{color:var(--stall)}

h2{font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:var(--ink3);
  font-weight:500;margin:0 0 .8rem}
.row{background:var(--card);border:1px solid var(--hair);border-radius:1rem;padding:.9rem 1.1rem;
  margin-bottom:.55rem;transition:box-shadow .5s var(--ease),border-color .5s var(--ease)}
.row.flash{border-color:rgba(31,95,84,.45);box-shadow:0 0 0 3px rgba(31,95,84,.1)}
.row.stalled{border-color:rgba(140,47,47,.32)}
.rhead{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}
.tick{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:-.01em}
.title{font-size:13px;color:var(--ink2);flex:1;min-width:12ch}
.age{font-family:var(--mono);font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}
.age.hot{color:var(--stall);font-weight:600}
.badge{font-size:10px;padding:.2rem .55rem;border-radius:999px;font-weight:500;letter-spacing:.02em;
  background:var(--shell);color:var(--ink2);white-space:nowrap}
.badge.go{background:rgba(31,95,84,.1);color:var(--go)}
.badge.warn{background:rgba(154,75,18,.1);color:var(--warn)}
.badge.bad{background:rgba(140,47,47,.1);color:var(--stall)}

.track{display:flex;gap:3px;margin:.7rem 0 .55rem}
.seg{height:3px;flex:1;border-radius:2px;background:rgba(11,11,12,.09);
  transition:background .6s var(--ease)}
.seg.done{background:var(--go)}
.seg.now{background:var(--go);animation:breathe 1.8s var(--ease) infinite}
.seg.bad{background:var(--stall)}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.3}}
.phases{display:flex;justify-content:space-between;font-size:9px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--ink3);font-family:var(--mono)}
.phases span.on{color:var(--go);font-weight:600}

.doing{font-size:12px;color:var(--ink2);font-family:var(--mono);margin-top:.55rem;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:11px;color:var(--ink3);font-family:var(--mono);margin-top:.35rem}

.feed{max-height:16rem;overflow-y:auto}
.ev{display:flex;gap:.7rem;font-size:12px;padding:.4rem 0;border-bottom:1px solid var(--hair);
  animation:slidein .5s var(--ease)}
@keyframes slidein{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.ev .t{font-family:var(--mono);font-size:11px;color:var(--ink3);min-width:6ch}
.empty{color:var(--ink3);font-size:13px;padding:1.4rem 0}
.warn-box{background:rgba(154,75,18,.06);border:1px solid rgba(154,75,18,.2);border-radius:.8rem;
  padding:.7rem .9rem;font-size:12px;color:var(--warn);margin-bottom:.5rem}
</style></head><body>

<header>
  <h1>Ship Factory</h1>
  <span class="conn live" id="conn"><span class="dot"></span><span id="connlabel">connecting</span></span>
  <span class="repo" id="repo"></span>
</header>

<div class="tiles" id="tiles"></div>

<h2 id="wt-h">Tickets in flight</h2>
<div id="worktrees"><div class="empty">No worktrees provisioned.</div></div>

<h2 style="margin-top:1.8rem">Activity</h2>
<div class="feed" id="feed"><div class="empty">Waiting for the first change…</div></div>

<script>
const PHASES = ['provisioned','coding','committed','ready-for-pr','in-review','merged']
const LABEL  = {provisioned:'prov',coding:'code',committed:'commit','ready-for-pr':'gated','in-review':'review','changes-requested':'changes',merged:'merged','gate-failed':'gate'}
let prev = new Map(), events = [], connected = false

const fmt = ms => {
  if (ms == null) return '—'
  const s = Math.floor(ms/1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s/60)
  if (m < 60) return m + 'm ' + (s%60) + 's'
  return Math.floor(m/60) + 'h ' + (m%60) + 'm'
}

function pushEvent(text){
  events.unshift({ t: new Date(), text })
  events = events.slice(0, 40)
  document.getElementById('feed').innerHTML = events.map(e =>
    '<div class="ev"><span class="t">' + e.t.toTimeString().slice(0,8) + '</span><span>' + e.text + '</span></div>'
  ).join('')
}

function render(s){
  document.getElementById('repo').textContent = s.repo ? s.repo.branch + ' @ ' + s.repo.mainSha : ''

  const wts = s.worktrees || []
  const stalled = wts.filter(w => w.stalled)
  const needsYou = wts.filter(w => w.phase === 'gate-failed' || w.phase === 'changes-requested')
  const moving = wts.filter(w => !w.stalled && ['coding','committed','provisioned'].includes(w.phase))
  const inReview = wts.filter(w => w.phase === 'in-review')

  document.getElementById('tiles').innerHTML = [
    ['', moving.length, 'moving'],
    ['', inReview.length, 'in review'],
    [needsYou.length ? 'attn' : '', needsYou.length, 'need a decision'],
    [stalled.length ? 'bad' : '', stalled.length, 'stalled'],
    ['', (s.pullRequests||[]).length, 'open prs'],
  ].map(([cls,n,l]) => '<div class="tile ' + cls + '"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('')

  document.getElementById('wt-h').textContent = 'Tickets in flight — ' + wts.length

  const warnHtml = (s.warnings||[]).map(w => '<div class="warn-box">' + w + '</div>').join('')

  document.getElementById('worktrees').innerHTML = warnHtml + (wts.length ? wts.map(w => {
    const idx = PHASES.indexOf(w.phase)
    const bad = w.phase === 'gate-failed' || w.phase === 'changes-requested'
    const track = PHASES.map((p,i) => {
      if (bad && i === 2) return '<div class="seg bad"></div>'
      if (i < idx) return '<div class="seg done"></div>'
      if (i === idx) return '<div class="seg now"></div>'
      return '<div class="seg"></div>'
    }).join('')
    const labels = PHASES.map((p,i) => '<span class="' + (i===idx?'on':'') + '">' + LABEL[p] + '</span>').join('')
    const badgeCls = bad ? 'bad' : w.stalled ? 'bad' : ['merged','in-review','ready-for-pr'].includes(w.phase) ? 'go' : ''
    const gate = w.gate ? ' · gate ' + w.gate.verdict + (w.gate.failed?.length ? ' (' + w.gate.failed.join(', ') + ')' : '') : ''
    return '<div class="row ' + (w.stalled?'stalled':'') + '" id="row-' + w.ticket + '">'
      + '<div class="rhead">'
      + '<span class="tick">' + w.ticket + '</span>'
      + '<span class="title">' + (w.title || w.branch || '') + '</span>'
      + '<span class="badge ' + badgeCls + '">' + (LABEL[w.phase]||w.phase) + '</span>'
      + '<span class="age ' + (w.stalled?'hot':'') + '" data-since="' + (w.lastActivityAt||'') + '">—</span>'
      + '</div>'
      + '<div class="track">' + track + '</div>'
      + '<div class="phases">' + labels + '</div>'
      + '<div class="doing">' + (w.liveAction || '') + '</div>'
      + '<div class="meta">' + w.commits + ' commit' + (w.commits===1?'':'s')
      + (w.dirtyCount ? ' · ' + w.dirtyCount + ' dirty' : '') + gate
      + (w.pr ? ' · PR #' + w.pr.number + (w.pr.ci ? ' · CI ' + w.pr.ci : '') : '') + '</div>'
      + '</div>'
  }).join('') : '<div class="empty">No worktrees provisioned. The factory is idle.</div>')

  // Diff against the previous frame so motion is visible rather than inferred.
  for (const w of wts) {
    const before = prev.get(w.ticket)
    if (!before) { pushEvent('<b>' + w.ticket + '</b> entered the factory') }
    else if (before.phase !== w.phase) {
      pushEvent('<b>' + w.ticket + '</b> ' + before.phase + ' → <b>' + w.phase + '</b>')
      const el = document.getElementById('row-' + w.ticket)
      if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2200) }
    }
    else if (before.commits !== w.commits) pushEvent('<b>' + w.ticket + '</b> committed (' + w.commits + ' total)')
    if (before && !before.stalled && w.stalled) pushEvent('<b>' + w.ticket + '</b> has not moved in ' + w.idleMinutes + 'm')
  }
  for (const [t] of prev) if (!wts.find(w => w.ticket === t)) pushEvent('<b>' + t + '</b> left the factory')
  prev = new Map(wts.map(w => [w.ticket, { phase: w.phase, commits: w.commits, stalled: w.stalled }]))
}

// Local ticker. The server polls every few seconds; these count every second, so
// the page keeps moving instead of freezing between frames.
setInterval(() => {
  const now = Date.now()
  for (const el of document.querySelectorAll('.age')) {
    const since = Number(el.dataset.since)
    el.textContent = since ? fmt(now - since) + ' idle' : '—'
  }
}, 1000)

function setConn(on, label){
  connected = on
  const c = document.getElementById('conn')
  c.className = 'conn ' + (on ? 'live' : 'down')
  document.getElementById('connlabel').textContent = label
}

function connect(){
  const es = new EventSource('/events')
  es.onopen = () => setConn(true, 'live')
  es.addEventListener('ping', () => setConn(true, 'live'))
  es.onmessage = (e) => { setConn(true, 'live'); try { render(JSON.parse(e.data)) } catch(_){} }
  es.onerror = () => { setConn(false, 'reconnecting'); es.close(); setTimeout(connect, 2000) }
}
connect()
</script></body></html>`

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end() }

  if (req.url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // Send current state immediately — a dashboard that is blank until the next
    // poll looks broken for the first three seconds.
    res.write(`data: ${lastJson || JSON.stringify({ ok: true, ...collect() })}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(PAGE)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ship Factory → http://localhost:${PORT}`)
  console.log(`  Streaming live state. Ctrl-C to stop.\n`)
  tick()
})
