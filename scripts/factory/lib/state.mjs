/**
 * state.mjs — reconstruct the factory's live state from sources of truth.
 *
 * DESIGN RULE: derive, never duplicate. There is deliberately no state file the
 * orchestrator has to keep updated, because a status file that drifts is worse
 * than no status file — it reads as authoritative while being wrong. Everything
 * here is read from something that is already the truth:
 *
 *   git worktrees      -> which tickets are provisioned right now
 *   .factory-env       -> the ticket/branch/db each worktree owns
 *   .factory/*.json    -> the last gate verdict and which gates failed
 *   gh pr list         -> PR number, CI rollup, review decision
 *   scorecard.jsonl    -> attempt history and the first-attempt-pass trend
 *   ~/.claude sessions -> token usage, for cost
 *
 * Linear is NOT read here: it needs auth a shell script does not have. Linear
 * remains authoritative for ticket status; this shows execution state. Where
 * they disagree, Linear wins and something has gone wrong — surfaced as a warning.
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim()
  } catch {
    return ''
  }
}

/** Published $/token. Update when rates change — this is the one hardcoded fact here. */
const RATES = {
  'claude-opus-5':      { in: 5 / 1e6, out: 25 / 1e6, cw: 6.25 / 1e6, cr: 0.50 / 1e6 },
  'claude-sonnet-5':    { in: 3 / 1e6, out: 15 / 1e6, cw: 3.75 / 1e6, cr: 0.30 / 1e6 },
  'claude-haiku-4-5':   { in: 1 / 1e6, out: 5 / 1e6,  cw: 1.25 / 1e6, cr: 0.10 / 1e6 },
}
const rateFor = (model) => {
  if (!model) return RATES['claude-opus-5']
  const key = Object.keys(RATES).find((k) => model.startsWith(k))
  return RATES[key] ?? RATES['claude-opus-5']
}

export function repoRoot() {
  return sh('git rev-parse --show-toplevel') || process.cwd()
}

/** Worktrees currently provisioned, with the gate verdict each last produced. */
export function worktrees(root) {
  const out = []
  const porcelain = sh('git worktree list --porcelain', { cwd: root })
  for (const block of porcelain.split('\n\n')) {
    const m = block.match(/^worktree (.+)$/m)
    if (!m) continue
    const path = m[1]
    if (path === root) continue                       // the main checkout is not a ticket
    const envPath = join(path, '.factory-env')
    if (!existsSync(envPath)) continue                // not a factory worktree

    const env = Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split('\n')
        .map((l) => l.replace(/^export\s+/, '').split('='))
        .filter((p) => p.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
    )

    let gate = null
    const gatePath = join(path, '.factory', 'gate-result.json')
    if (existsSync(gatePath)) {
      try { gate = JSON.parse(readFileSync(gatePath, 'utf8')) } catch { /* unreadable */ }
    }

    const branch = env.FACTORY_BRANCH || sh(`git -C "${path}" branch --show-current`)
    const ahead = sh(`git -C "${path}" rev-list --count ${env.FACTORY_BASE_REF || 'main'}..HEAD`)

    out.push({
      ticket: env.FACTORY_TICKET || basename(path),
      path, branch,
      db: env.FACTORY_DB_NAME || null,
      apiPort: env.API_PORT || null,
      webPort: env.WEB_PORT || null,
      commits: Number(ahead || 0),
      gate: gate && {
        verdict: gate.verdict,
        ranAt: gate.ranAt,
        failed: (gate.gates || []).filter((g) => g.status === 'fail').map((g) => g.id),
        skipped: (gate.gates || []).filter((g) => g.status === 'skip').map((g) => g.id),
      },
    })
  }
  return out
}

/** Open PRs, with CI rollup and review decision. Empty if gh cannot resolve the repo. */
export function pullRequests() {
  const raw = sh(
    'gh pr list --state open --limit 50 --json number,title,headRefName,statusCheckRollup,reviewDecision,isDraft,url'
  )
  if (!raw) return []
  let prs
  try { prs = JSON.parse(raw) } catch { return [] }
  return prs.map((p) => {
    const checks = p.statusCheckRollup || []
    const concl = (c) => c.conclusion || c.state || 'PENDING'
    const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED'].includes(concl(c)))
    const pending = checks.filter((c) => ['PENDING', 'IN_PROGRESS', 'QUEUED', ''].includes(concl(c)))
    return {
      number: p.number, title: p.title, branch: p.headRefName, url: p.url, draft: p.isDraft,
      ci: failing.length ? 'failing' : pending.length ? 'pending' : checks.length ? 'green' : 'none',
      failingChecks: failing.map((c) => c.name || c.context),
      review: p.reviewDecision || null,
      // The ticket a PR serves, by convention: the branch names it.
      ticket: (p.headRefName.match(/TRO-\d+/i) || p.title.match(/TRO-\d+/i) || [null])[0],
    }
  })
}

/** Attempt history. One row per gate run — see references/evals.md. */
export function scorecard(root) {
  const p = join(root, 'audit', 'factory', 'scorecard.jsonl')
  if (!existsSync(p)) return { rows: [], firstAttemptPass: null }
  const rows = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const first = rows.filter((r) => r.attempt === 1)
  return {
    rows,
    firstAttemptPass: first.length
      ? { pass: first.filter((r) => r.verdict === 'pass').length, of: first.length }
      : null,
    gateFailures: rows.flatMap((r) => r.failedGates || [])
      .reduce((acc, g) => ({ ...acc, [g]: (acc[g] || 0) + 1 }), {}),
  }
}

/**
 * Token spend from Claude Code transcripts.
 *
 * IMPORTANT: this is list-rate arithmetic over observed token counts. It is NOT
 * billed spend. On a subscription plan the marginal cost is zero and this figure
 * represents API-equivalent value. Any report built on it must say which it means.
 */
export function cost(projectSlug = '-Users-troy-repos-GAUNTLET-Ship') {
  const dir = join(homedir(), '.claude', 'projects', projectSlug)
  const totals = { in: 0, out: 0, cw: 0, cr: 0 }
  const byModel = {}
  let sessions = 0, messages = 0, usd = 0
  if (!existsSync(dir)) return { available: false }

  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    sessions++
    let text
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const u = o?.message?.usage
      if (!u) continue
      const model = o?.message?.model || 'claude-opus-5'
      const r = rateFor(model)
      const t = {
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
        cw: u.cache_creation_input_tokens || 0,
        cr: u.cache_read_input_tokens || 0,
      }
      messages++
      for (const k of ['in', 'out', 'cw', 'cr']) totals[k] += t[k]
      usd += t.in * r.in + t.out * r.out + t.cw * r.cw + t.cr * r.cr
      byModel[model] = (byModel[model] || 0) + 1
    }
  }
  const totalTokens = totals.in + totals.out + totals.cw + totals.cr
  return {
    available: true, sessions, messages, totals, byModel, usd,
    cacheReadShare: totalTokens ? totals.cr / totalTokens : 0,
    basis: 'list-rate estimate over observed token counts; NOT billed spend',
  }
}

export function collect() {
  const root = repoRoot()
  const wts = worktrees(root)
  const prs = pullRequests()
  const sc = scorecard(root)
  const branch = sh(`git -C "${root}" branch --show-current`)
  const mainSha = sh(`git -C "${root}" rev-parse main`).slice(0, 7)

  const warnings = []
  if (!prs.length && !sh('gh auth status') && wts.length) {
    warnings.push('gh returned no PRs — if that is unexpected, export GH_REPO=troysatchell/ship')
  }
  for (const w of wts) {
    if (w.commits === 0) warnings.push(`${w.ticket}: worktree provisioned but no commits yet`)
    if (w.gate?.verdict === 'fail') warnings.push(`${w.ticket}: last gate FAILED on ${w.gate.failed.join(', ')}`)
  }

  return {
    generatedAt: new Date().toISOString(),
    repo: { root, branch, mainSha },
    worktrees: wts,
    pullRequests: prs,
    scorecard: sc,
    cost: cost(),
    warnings,
  }
}
