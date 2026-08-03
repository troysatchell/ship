# AI Cost Analysis

## 1. Tooling used

This project ran on a two-layer "factory" pattern rather than one long freeform session:

- **Orchestrator:** Claude Code, driving the audit, the Linear ticket backlog, and the remediation
  loop end to end — reading the codebase, writing the 68-finding audit report, filing tickets,
  dispatching agents, verifying gates, and merging.
- **Ticket agents:** one Claude agent per ticket, dispatched on **Sonnet**, each working in an
  isolated git worktree against a single Linear ticket. Standing decision, recorded in
  `memory-bank/progress.md` (2026-07-29 entry): *"ticket agents run on Sonnet (the brief carries the
  knowledge, not the model)"* — the model doesn't need to be the frontier one if the brief it's
  given is specific enough (exact files, exact finding, exact acceptance bar).
- **Evidence gates, not self-report:** every ticket's "done" claim was checked independently —
  typecheck, build, test suites, and a `regression-test` requirement per fix — before a merge, per
  `.claude/skills/ship-factory` and `scripts/factory/gate.sh`. `memory-bank/progress.md`'s wave-3
  entry is explicit that results are "verified by the orchestrator directly against the integrated
  `main`... not self-reported by the ticket agents."

**Throughput, as logged (not re-derived from Linear at time of writing):** on 2026-07-30 alone the
factory merged PRs in three separate batches recorded in `memory-bank/progress.md` — 16 PRs (the
"wave 3" entry, `main` `4d74602 → 319e1af`), 3 PRs (the factory-recovery entry, `#40/#42/#43`), and
13 PRs (the night entry) — **32 PRs merged in one day**, taking the audit's Done-ticket count from
5 to **≈40 of 68** (`memory-bank/activeContext.md`, 2026-07-30 night). That "≈40" is the log's own
figure — `activeContext.md` flags it should be **recounted directly against Linear before quoting
precisely** in the final submission, which is worth doing before this number goes in a deck.

**Recounted 2026-07-30 (submission-eve), directly against the sources:** **65 tickets Done** in the
Linear project (46 of the 68 audit findings, plus 19 rules/deploy/post-baseline tickets), and
**75 unique PRs merged** into `main` (`git log --merges`, unique `Merge #N` / `Merge pull request #N`
references).

## 2. Spend

**Method — measured, not estimated.** Every Claude Code session logs per-request token usage to
local transcripts. All 91 transcript files for this project (2026-07-27 → 2026-07-30, **21,413 API
requests** — orchestrator sessions and every ticket agent) were parsed and summed by model, then
priced at Anthropic's current list rates (cache reads at 0.1× input; cache writes at 1.25× for the
standard 5-minute TTL, with the 2× 1-hour-TTL rate shown as the upper bound; Claude Sonnet 5 at its
introductory $2/$10 per MTok, in effect through 2026-08-31).

| Model | Output tokens | Cache writes | Cache reads | API-equivalent cost |
|---|---:|---:|---:|---:|
| Claude Opus 5 (orchestrator, most sessions) | 7.00M | 54.0M | 1,580.6M | **$1,303** |
| Claude Sonnet 5 (ticket agents) | 4.30M | 49.0M | 2,106.7M | **$587** |
| Claude Fable 5 (final-day orchestrator) | 1.27M | 4.6M | 252.1M | **$373** |
| Claude Opus 4.8 (earlier sessions) | 0.94M | 5.0M | 132.5M | **$121** |
| **Total** | **13.5M** | **112.6M** | **4,071.9M** | **≈ $2,385** (upper bound ≈ $2,714 at 1-hour cache-write rates) |

| | |
|---|---|
| Total API-equivalent cost, full sprint (audit + remediation) | **≈ $2,385–$2,714** at list rates |
| Actual out-of-pocket | **Claude Max subscription** — a flat monthly fee, no per-token billing. The ≈$2,385–2,714 above is therefore the *API-equivalent value* consumed in four days: on its own a multiple of the monthly subscription price, which is the real economics headline of this sprint. |
| Tickets completed | **65** (46 of the 68 audit findings + 19 rules/post-baseline) |
| PRs merged | **75** |
| Cost per completed ticket | ≈ $2,385 / 65 = **~$37** (upper bound ~$42) |
| Cost per merged PR | ≈ $2,385 / 75 = **~$32** (upper bound ~$36) |
| Sonnet ticket-agent share vs. Opus-tier orchestration | Sonnet ≈ $587 (25%) did the ticket implementation; Opus-tier + Fable orchestration ≈ $1,797 (75%) — the orchestrator's cost is dominated by re-reading context across 21k requests, not by writing code |

**Where the spend concentrated:** cache reads — **~$1,530 of ~$2,385 (64%)** — which is the cost
signature of the factory pattern itself: many parallel agents each re-reading large shared context
(the audit report, the lessons file, the role briefs) on every request. Raw output tokens were only
~$305 (13%). By day: 2026-07-30 (the big remediation push) accounts for 13,506 of 21,413 requests
(63%). The GitHub webhook outage and CodeRabbit rate-limiting cost wall-clock time and re-dispatched
CI runs, but their token cost was noise against the cache-read baseline.

## 3. Effectiveness — what the AI did well, and where it didn't replace a human

### What it did well

**Evidence-gated parallel remediation actually held up under load.** The factory ran up to ~8 agents
concurrently across isolated worktrees, each gated independently before merge — and the gate itself
was *negative-tested* before being trusted (a forged vitest report with one new failure and one
false fix was confirmed to still fail the gate — `memory-bank/progress.md`, 2026-07-29 "Day 3" entry).
That's the difference between "the agent said it passed" and "something that isn't the agent
confirmed it passed."

**It caught its own tooling and its own audit being wrong, repeatedly, which is the part worth
keeping:**

- **The audit's own tracked type-safety metric had a bug.** `count.sh`'s non-null-assertion pattern
  had a BSD-grep bracket bug that never counted the 236 `req.userId!` sites at all, and the *live*
  total kept growing with the codebase during remediation (1747 vs. a 1535 baseline) — so a naive
  "re-run the script and compare" would have shown backwards progress. The fix agent caught this and
  the log now states plainly: category progress can only be shown as **controlled per-ticket diffs**,
  never a live re-count (`memory-bank/activeContext.md`, TS-4 entry).
- **A "fixed" number had quietly drifted between when it was measured and when it was fixed.** The
  TS-1 ticket's own audited baseline said 102 latent type errors; by the time the fix agent actually
  ran the check, the real count was **156** — the codebase had moved in between (`memory-bank/progress.md`,
  2026-07-30 night entry, PR #46). It reported the drift instead of quietly closing the ticket against
  the stale number.
- **ERR-14 was reproduced, not just reasoned about, before being called a finding.** Rather than
  inferring from reading the code that a window-focus refetch on a deleted document would blow away
  in-progress editor state, the agent wrote a jsdom test against the app's *real* `queryClient`
  singleton, fired a real `visibilitychange` event, and watched the editor actually unmount and
  discard the mock draft text before writing up the root cause (`CHANGES.md:655-676`, TRO-290). That
  reproduce-first discipline is exactly what this project's own `CLAUDE.md` asks for, and it's the
  difference between "probably happens" and "watched it happen."

Other corrections of the same shape are in the log if more examples are useful: the stored-XSS test
that passed because TipTap silently produced zero `<a>` elements rather than because anything was
sanitized; the API-2 estimate that applied a database-share percentage to a JSON-payload percentage
and was off by nearly 2×; and DB-12 itself (see `DISCOVERY.md` #3) — a security-relevant race
disconfirmed once, then actually measured and found real.

### Where humans stayed essential

- **Screen-reader verification.** Every accessibility fix in this sprint was validated by
  Lighthouse/axe-core — static and DOM-level tools. Nobody has actually *listened* to VoiceOver read
  the fixed sidebar or the project-context lists (`TRO-215`, `TRO-281`) — that's still logged as owed
  to a human, because it's the one category of correctness no automated tool in this pipeline can
  confirm.
- **Merge and scope policy.** Auto-merge-on-green, push/PR pre-authorization, and cutting Phase 2's
  scope to the 4 Criticals plus the assignment's implementation rules (not all 68 findings) were all
  maintainer calls recorded in `memory-bank/progress.md` (2026-07-29 "Decisions" entry) — judgment
  calls about risk tolerance and priority, not something the agents decided for themselves.
- **Escalation / apply gates on infrastructure.** Terraform changes were held for a human decision
  before anything destructive or account-affecting ran: PR #41 (deleting a duplicate `environments/prod`),
  PR #47 (a security-group change paired with the trust-proxy fix, gated on an AWS quota check first),
  and PR #57 (import-vs-apply for the Render provider config) all shipped as code + a written
  recommendation, not as an executed `terraform apply`.
- **The trust-proxy hop count depended on a fact only the operator could confirm.** The correct value
  for `TRUST_PROXY_HOPS` on Render is asserted in `api/src/app.ts:144` as "maintainer-confirmed
  2026-07-30" — the actual live network path (client → Render's own proxy → Express, one hop) isn't
  something derivable from this repo's code; it's a fact about the deployment platform that had to
  come from the person who could see it.

## 4. What I'd change

[FILL: this is Troy's call, but a few candidates the log surfaced that are worth considering —
edit freely]

- **Bake the concurrency check into the audit methodology itself**, rather than discovering
  "idempotent DDL isn't safe under a race" as a follow-on ticket found by a code reviewer mid-fix
  (DB-12). If a category's whole premise is "does this hold up under real conditions," the first pass
  should include a deliberate concurrent-load run, not just a single-process read of the code.
- **Fix the ticket taxonomy before the backlog grows, not after.** One class of finding (implicit
  `any`, unsafe casts, unsafe type casts, test casts) got filed under four different slugs and hid
  that it was really one recurring class of 14 until someone aggregated the review ledger by hand.
- **Don't let a single degraded external service (CodeRabbit rate-limiting, or the ~10-minute GitHub
  webhook outage) become the day's critical path without a documented fallback decided in advance** —
  both were worked around in the moment (`workflow_dispatch`, merging on the documented "degraded
  service" judgment), but that was improvised, not planned.
- **The Sonnet-for-ticket-agents call was validated by the numbers.** Ticket implementation (the
  majority of merged code) consumed ~25% of total spend; the expensive part was orchestration
  context, not agent intelligence. The next optimization target is cache-read volume — tighter
  briefs and smaller shared-context footprints per agent — not a cheaper model.

