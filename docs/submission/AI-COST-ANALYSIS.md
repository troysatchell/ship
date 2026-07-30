> **DRAFT / SKELETON** — structure and everything derivable from the repo is filled in and cited.
> `[FILL: ...]` marks the only slots that need real spend figures only Troy has (Anthropic console /
> billing). Personalize the voice before submitting; keep the citations if you edit the numbers.

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

[FILL: exact ticket/PR count as of submission, recounted directly in Linear rather than from the log]

## 2. Spend

| | |
|---|---|
| Total Anthropic API spend, full sprint (audit + remediation) | `[FILL: $___]` |
| Tickets completed | `[FILL: ___]` (recount against Linear; log estimate ≈40 of 68 as of 2026-07-30 night) |
| PRs merged | `[FILL: ___]` (≥32 on 2026-07-30 alone, per above; total across the sprint needs a `git log --merges` count) |
| Cost per completed ticket | `[FILL: $___ / ___ tickets = $___]` |
| Cost per merged PR | `[FILL: $___ / ___ PRs = $___]` |
| Orchestrator session time vs. ticket-agent compute (rough split, if billing separates them) | `[FILL]` |

[FILL: any note on where the spend concentrated — e.g., did retries/re-runs from the GitHub webhook
outage or CodeRabbit rate-limiting (both logged below) burn a disproportionate share, or was it flat
per ticket?]

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
- [FILL: anything about spend efficiency once the real numbers are in — e.g., was Sonnet-per-ticket
  actually cheaper than fewer, larger sessions on a stronger model, given the retries logged above?]

> — Zim: "I must go, my planet needs me."
