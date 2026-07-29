#!/usr/bin/env node
/**
 * status.mjs — one-screen view of what the factory is doing right now.
 *
 *   node scripts/factory/status.mjs          # terminal
 *   node scripts/factory/status.mjs --json   # machine-readable (feeds board.mjs)
 *
 * Reads only sources of truth; see lib/state.mjs.
 */

import { collect } from './lib/state.mjs'

const state = collect()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(state, null, 2))
  process.exit(0)
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}
const n = (x) => x.toLocaleString('en-US')

console.log()
console.log(C.bold('  SHIP FACTORY') + C.dim(`   main@${state.repo.mainSha}   ${new Date(state.generatedAt).toLocaleTimeString()}`))
console.log(C.dim('  ' + '─'.repeat(72)))

// --- in flight --------------------------------------------------------------
console.log()
console.log(C.bold('  IN FLIGHT'))
if (!state.worktrees.length) {
  console.log(C.dim('    no ticket worktrees provisioned'))
} else {
  for (const w of state.worktrees) {
    const g = w.gate
    let verdict = C.dim('not gated yet')
    if (g?.verdict === 'pass') verdict = C.green('gate pass')
    else if (g?.verdict === 'fail') verdict = C.red(`gate fail → ${g.failed.join(', ')}`)
    console.log(
      `    ${C.cyan(w.ticket.padEnd(10))} ${String(w.commits).padStart(2)} commit(s)  ${verdict}`
    )
    console.log(C.dim(`      ${w.branch}   db=${w.db}   api:${w.apiPort} web:${w.webPort}`))
  }
}

// --- open PRs ---------------------------------------------------------------
console.log()
console.log(C.bold('  OPEN PRs'))
if (!state.pullRequests.length) {
  console.log(C.dim('    none'))
} else {
  for (const p of state.pullRequests) {
    const ci =
      p.ci === 'green' ? C.green('CI green') :
      p.ci === 'failing' ? C.red(`CI FAIL (${p.failingChecks.join(', ')})`) :
      p.ci === 'pending' ? C.yellow('CI pending') : C.dim('no checks')
    console.log(`    ${C.cyan('#' + p.number)} ${p.ticket ? C.bold(p.ticket) + ' ' : ''}${ci}${p.draft ? C.dim(' [draft]') : ''}`)
    console.log(C.dim(`      ${p.title.slice(0, 66)}`))
  }
}

// --- trend ------------------------------------------------------------------
console.log()
console.log(C.bold('  TREND'))
const fap = state.scorecard.firstAttemptPass
if (fap) {
  const pct = Math.round((fap.pass / fap.of) * 100)
  console.log(`    first-attempt gate pass  ${C.bold(`${fap.pass}/${fap.of}`)} (${pct}%)`)
} else {
  console.log(C.dim('    no scorecard rows yet'))
}
const gf = Object.entries(state.scorecard.gateFailures || {}).sort((a, b) => b[1] - a[1])
if (gf.length) {
  console.log(C.dim(`    most-failed gates: ${gf.slice(0, 3).map(([g, c]) => `${g}×${c}`).join(', ')}`))
  console.log(C.dim('    (the same gate failing repeatedly is a prompt defect, not careless agents)'))
}

// --- spend ------------------------------------------------------------------
if (state.cost.available) {
  const c = state.cost
  console.log()
  console.log(C.bold('  SPEND') + C.dim('  (list-rate estimate, NOT billed spend)'))
  console.log(`    ${C.bold('$' + c.usd.toFixed(2))}  across ${c.sessions} session(s), ${n(c.messages)} messages`)
  console.log(C.dim(`    out ${n(c.totals.out)} · cache-write ${n(c.totals.cw)} · cache-read ${n(c.totals.cr)} · in ${n(c.totals.in)}`))
  console.log(C.dim(`    ${Math.round(c.cacheReadShare * 100)}% of token volume is cache reads (billed at 1/10 rate)`))
}

// --- warnings ---------------------------------------------------------------
if (state.warnings.length) {
  console.log()
  console.log(C.bold(C.yellow('  ATTENTION')))
  for (const w of state.warnings) console.log(C.yellow(`    • ${w}`))
}

console.log()
console.log(C.dim('  Linear is authoritative for ticket status; this is execution state.'))
console.log()
