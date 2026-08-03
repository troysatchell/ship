# ShipShape Ticket Factory
Autonomous audit-remediation pipeline — Linear backlog to merged main, with its self-improvement loops · GAUNTLET/Ship @ 791380a — scripts/factory/*, .claude/skills/ship-factory + ship-orchestrator · profile: process

22 stages · 55 connections · 11 loops · 4 open questions

## Stages

### Intake
- **Audit findings** [intake] — shipshape-audit · 68 findings · fan-in 0, fan-out 1, instability 1.0 · emits: finding
  The 7-category baseline audit (type safety, bundle, API perf, DB queries, tests, error handling, a11y) produced AUDIT_REPORT.md with 68 findings. Every finding became a Linear ticket (TRO-164..239). The 68 number is submitted and fixed — CodeRabbit-derived tickets are never counted into it.
  source: audit/AUDIT_REPORT.md, audit/shipshape.config.yaml
- **Linear backlog** [store] — project ShipShape Audit Remediation · fan-in 4, fan-out 1, instability 0.2 · emits: ticket · consumes: finding, new-ticket
  Authoritative for ticket STATUS (the board only shows execution state — when they disagree, Linear wins and something is wrong). "In Progress" is the dispatch lock: the whole batch is reserved before any agent starts, or a second worker can pick up a ticket already being fixed in someone else's branch. Scope guardrail: the same workspace holds three unrelated projects; the factory never dispatches outside this one.
  source: .claude/skills/ship-factory/SKILL.md·1. Select the next ticket

### Dispatch
- **Orchestrator** [orchestrator] — ship-factory run loop · Sonnet · fan-in 2, fan-out 4, instability 0.67 · consumes: ticket
  Select → provision → dispatch → gate → measure → PR → triage → merge. Orders by unblock-first, then priority; batches shared root causes (DB-4 ⇄ API-4/5/ERR-7, BUN-1 ⇄ 2/3/4/6) onto one branch. Runs everything in parallel except real blockers, same-file collisions, and measurement ordering (db-query-audit after api-perf-audit). Runs the gate ITSELF — an agent reporting green is a claim, not a result. Checkpoints the session between waves: orchestration was ~75% of sprint spend, dominated by re-reading context, so no unbroken multi-day sessions.
  source: .claude/skills/ship-factory/SKILL.md·The loop, .claude/skills/ship-orchestrator/SKILL.md·2. Decide what runs in parallel
- **Brief assembly** [transform] — contract + lessons + role skill · fan-in 3, fan-out 1, instability 0.25 · emits: brief
  The agent contract (domain-blind, non-negotiables: scope, locked quarantine, provenance, keep-working) + lessons.md verbatim + the role skill(s) routed by finding prefix. Every brief also carries ship-qa's regression-test placement rule regardless of category, because the gate's regression check can be satisfied by a test the gate never runs.
  source: .claude/skills/ship-factory/references/agent-contract.md, .claude/skills/ship-orchestrator/SKILL.md·1. Route the ticket to a role brief
- **lessons.md** [store] — standing rules, earned per incident · fan-in 1, fan-out 1, instability 0.5
  The prompt-level self-improvement mechanism. A rule lands here when a review finding recurs on a 2nd ticket — a defect class recurring means the brief is missing a rule, not that agents need louder restating. Injected verbatim into every subsequent brief. Kept short and specific: rules that earned their place, not a diary.
  source: .claude/skills/ship-factory/references/lessons.md, .claude/skills/ship-factory/SKILL.md
- **Role skills** [store] — ship-frontend · ship-backend · ship-qa · fan-in 0, fan-out 1, instability 1.0
  Routing table (ship-orchestrator §1): TS-*/BUN-*/A11Y-* → frontend, API-*/DB-*/ERR-* → backend, TEST-* → qa (plus the package's role skill), TF-* → none yet (escalation gate 2, irreversible infra). Multi-role tickets get both briefs — two briefs is fine, a vague brief is not.
  source: .claude/skills/ship-frontend/SKILL.md, .claude/skills/ship-backend/SKILL.md, .claude/skills/ship-qa/SKILL.md

### Isolated build
- **worktree.sh** [transform] — worktree + DB + ports + .factory-env · fan-in 1, fan-out 2, instability 0.67
  Provisions ../Ship-wt-<ticket>: a git worktree on its own branch, an EXCLUSIVE database (DROP/CREATE ship_wt_<ticket> WITH FORCE — retries start clean, not half-migrated), and ports probed upward from an md5 starting point (the hash alone collides ~50% by 36 concurrent tickets). Writes .factory-env (exported so DATABASE_URL actually reaches pnpm) and never touches .git/info/exclude — in a linked worktree .git is a FILE, and that write once aborted provisioning before migration under set -e.
  source: scripts/factory/worktree.sh, scripts/factory/worktree.sh·find_free_port, scripts/factory/worktree.sh
- **ship-audit-pg** [store] — one Postgres container · :5433 · fan-in 1, fan-out 1, instability 0.5
  Docker Postgres holding every worktree's database. Isolation exists because api/src/test/setup.ts TRUNCATEs 16 tables in beforeAll of every test file — two agents sharing a database silently destroy each other's fixtures and produce failures that look like code defects. The container is also the factory's real concurrency ceiling: gates share its connection limit and CPU, so gate runs are staggered even when agent dispatch is broad.
  source: scripts/factory/worktree.sh, api/src/test/setup.ts
- **Coding sub-agent** [transform] — Sonnet · one ticket, one branch · fan-in 7, fan-out 1, instability 0.12 · emits: diff · consumes: brief
  Dispatched on Sonnet (maintainer policy 2026-07-29): the brief carries the knowledge, not the model. By dispatch time it holds the role skill, standing rules, the finding's measured evidence, escalation boundaries, and the gate to check itself against — a well-specified task, not a derived one. Model is raised per-ticket only for genuinely open-ended calls (e.g. TRO-197, where the right bundle metric had to be invented).
  source: .claude/skills/ship-factory/SKILL.md·3. Dispatch the coding sub-agent, .claude/skills/ship-orchestrator/SKILL.md·2a. Dispatch ticket agents — and the orchestrator itself — on Sonnet

### Verify
- **gate.sh** [gate] — G1–G9 · mechanical, evidence out · fan-in 4, fan-out 5, instability 0.56 · emits: gate-verdict, scorecard-row · consumes: diff
  The cheap-tier eval. G1 typecheck · G2 build · G3/G4 unit tests vs the quarantine baseline (failure IDENTITIES, not counts — fixing one test while breaking another keeps totals equal) · G5 tests not weakened (net adds vs dels; .skip/.todo is an unconditional fail) · G6 regression test ADDED (not just touched) · G7 CHANGES.md entry + structural check · G7b recurring review patterns (review-patterns.mjs) · G8 diff bounded · G9 CodeRabbit CLI under a hard timeout, never overwriting a real review with a rate-limit stub. New test failures are auto-re-run standalone to separate load noise (TRO-277) from real regressions — verdict stays fail, operator gets the diagnosis free. Writes .factory/gate-result.json, which becomes the PR body's evidence block.
  source: scripts/factory/gate.sh·G1 type check / G2 build, scripts/factory/gate.sh·G3/G4 unit tests vs quarantine baseline, scripts/factory/gate.sh·G5 tests were not weakened, scripts/factory/gate.sh·G6 regression test present, scripts/factory/gate.sh·G7 CHANGES.md / G7b recurring review patterns, scripts/factory/gate.sh·G8 scope discipline / G9 CodeRabbit, scripts/factory/gate.sh
- **quarantine.json** [store] — known-failing baseline · fan-in 1, fan-out 1, instability 0.5
  The 13 known-failing web tests (TEST-1/TRO-223). The gate materializes it FROM BASE_REF, never from the ticket branch — reading the branch copy would let an agent append its own failures and pass. The file may only shrink: removing genuinely fixed tests is legitimate (reported as "fixed", informational); widening it to get green is gaming the gate.
  source: audit/factory/quarantine.json, scripts/factory/gate.sh
- **scorecard.jsonl** [store] — one row per gate run · fan-in 1, fan-out 1, instability 0.5 · consumes: scorecard-row
  Appended after EVERY gate run — pass or fail, including each retry. Success-only rows would erase failed attempts and the first-attempt-pass trend (the whole point) would read as 100%. cr* fields are filled in at triage.
  source: audit/factory/scorecard.jsonl, scripts/factory/lib/state.mjs·scorecard
- **Compare-mode evals** [gate] — vs audit-baseline tag · fan-in 1, fan-out 2, instability 0.67 · emits: evidence · consumes: gate-verdict
  The expensive tier: for findings with a measurable target, a compare-mode run of the category audit skill against the audit-baseline git tag proves the delta. Cheap categories run per ticket; expensive ones batch per category (db-query-audit strictly after api-perf-audit — statement logging skews timings). A perf or bundle ticket without a measured delta is not done; measurable improvement is 40% of the grade.
  source: .claude/skills/ship-factory/references/evals.md, .claude/skills/ship-factory/SKILL.md·5. Measure (findings with a target)

### Review & ship
- **PR + CI** [gate] — GitHub · required checks · fan-in 1, fan-out 4, instability 0.8 · emits: review-request, green-pr · consumes: evidence
  Push + PR-open is pre-authorized for gate-passed factory branches. The PR body IS the evidence (gate JSON, measurement), not a summary; a batched branch lists every ticket it closes. Branch protection on main: typecheck/build/unit, source inventory, CodeQL — strict, admins bound. gh needs GH_REPO=troysatchell/ship because origin's fetch URL is GitLab.
  source: .claude/skills/ship-factory/SKILL.md·6. Open the PR, .claude/skills/ship-factory/SKILL.md
- **CodeRabbit** [external] — reviewer · input, never a verdict · fan-in 1, fan-out 1, instability 0.5 · emits: review-finding · consumes: review-request
  Reviews every PR (and pre-PR via the CLI in G9). Findings never fail the gate on their own — a reviewer's opinion is input to triage, not a verdict. It has caught real bugs: the half-open concurrency race in TRO-311's circuit breaker was a genuine critical find.
  source: scripts/factory/gate.sh·G9 CodeRabbit review
- **Triage** [gate] — fix-now · new-ticket · dismissed · fan-in 1, fan-out 4, instability 0.8 · emits: disposition, new-ticket · consumes: review-finding
  Every finding is classified, none merely received. Fix-now findings get fixed and re-reviewed on the branch; ticket-worthy ones are filed to Linear automatically (labelled coderabbit, never counted in the 68); dismissals need a written reason. A growing dismissed pile in one category means the factory is talking itself out of real feedback.
  source: .claude/skills/ship-factory/references/triage.md, .claude/skills/ship-factory/SKILL.md·7. Triage the review — and record every finding
- **Review ledger** [store] — review-findings.jsonl · fan-in 1, fan-out 2, instability 0.67 · consumes: disposition
  Every finding recorded whatever its disposition (review-ledger.mjs). Exists because fixing findings one at a time and discarding them let a defect class recur on four branches unnoticed on day one. The report's recurrence thresholds drive the two self-improvement loops: 2 tickets → a lessons.md rule; 3+ tickets → a mechanical gate.sh check.
  source: scripts/factory/review-ledger.mjs, audit/factory/review-findings.jsonl, scripts/factory/review-patterns.mjs
- **Merge --no-ff** [release] — auto once green · policy 2026-07-29 · fan-in 2, fan-out 3, instability 0.6 · emits: merged-main · consumes: green-pr, disposition
  Standing policy: merges without per-PR confirmation once all four hold — gate pass, CI green, every review finding triaged (fix-now ones fixed and re-reviewed), no open escalation. --no-ff so branch structure survives (10% of the grade reads off the git log). Non-ticket content (tooling, skills, docs, CI) may merge on gate + CI alone — but the review still gets read and triaged after the fact. Never merge to clear a queue.
  source: .claude/skills/ship-factory/SKILL.md·8. Merge — auto-merge once the review is green, scripts/factory/merge-changes.mjs
- **GitLab + GitHub main** [external] — GitLab is the graded remote · fan-in 1, fan-out 0, instability 0.0 · consumes: merged-main
  One push updates both, but origin FETCHES from GitLab while CI, PRs and merges happen on GitHub — a GitHub merge must be pulled down before the next push or the remotes diverge (verified on PR #1: GitLab was one commit behind). Verify with git ls-remote against both, never assume.
  source: .claude/skills/ship-factory/SKILL.md, .claude/skills/ship-factory/SKILL.md·9. Close the loop back into the factory

### Operate & observe
- **state.mjs** [transform] — derive, never duplicate · fan-in 3, fan-out 1, instability 0.25 · emits: snapshot
  Reconstructs live state from sources of truth on every read: worktrees + .factory-env, .factory/gate-result.json, gh pr list, scorecard.jsonl, and Claude session transcripts for token cost (list-rate estimate, explicitly NOT billed spend). There is deliberately no status file to update — a status file that drifts reads as authoritative while wrong.
  source: scripts/factory/lib/state.mjs·collect, scripts/factory/lib/state.mjs·worktrees, scripts/factory/lib/state.mjs·cost
- **Board surfaces** [release] — serve.mjs :7373 · status.mjs · board.html · fan-in 1, fan-out 1, instability 0.5 · consumes: snapshot
  Two kinds on purpose: OPERATE (serve.mjs rebuilds from live state per request, free to refresh; status.mjs is the terminal view) and SHARE (board.mjs → board.html, republished as a Claude Artifact at stable URL only at milestones — a shell script cannot republish an Artifact, so every refresh costs an agent tool call).
  source: scripts/factory/serve.mjs, scripts/factory/status.mjs, scripts/factory/board.mjs, audit/factory/board.html
- **Maintainer** [external] — human · escalation gates · policy · fan-in 2, fan-out 1, instability 0.33
  The factory runs unattended between defined human gates. Escalation blocks the TICKET, not the run: questions are held and batched so one answer resumes the factory. Standing policies set here (auto-merge on green, Sonnet dispatch, pre-authorized PR pushes) are what let the loop run without per-action approval.
  source: .claude/skills/ship-factory/references/escalation.md, .claude/skills/ship-factory/SKILL.md·Running unattended

## Connections
- Audit findings → Linear backlog (68 findings → tickets)
- Linear backlog → Orchestrator (next eligible batch)
- Orchestrator → worktree.sh (control, provision per ticket)
- Orchestrator → Brief assembly (control, compose per ticket)
- lessons.md → Brief assembly (data, verbatim)
- Role skills → Brief assembly (data, routed by prefix)
- Brief assembly → Coding sub-agent (the brief)
- Orchestrator → Coding sub-agent (control, dispatch (Sonnet))
- worktree.sh → ship-audit-pg (data, DROP/CREATE ship_wt_*)
- worktree.sh → Coding sub-agent (worktree + .factory-env)
- Coding sub-agent → gate.sh (diff (self-report ≠ done))
- ship-audit-pg → gate.sh (data, exclusive test DB (TRUNCATEd))
- quarantine.json → gate.sh (data, baseline from BASE_REF)
- gate.sh → scorecard.jsonl (data, row per run)
- gate.sh → Compare-mode evals (pass)
- Compare-mode evals → PR + CI (evidence-backed PR)
- PR + CI → CodeRabbit (review)
- CodeRabbit → Triage (findings)
- Triage → Review ledger (data, every finding)
- Triage → Merge --no-ff (review green)
- PR + CI → Merge --no-ff (CI green)
- Merge --no-ff → GitLab + GitHub main (push)
- Merge --no-ff → Linear backlog (feedback, Done + evidence, polarity -, loop B10)
- gate.sh → state.mjs (data, gate-result.json)
- scorecard.jsonl → state.mjs (data, attempt history)
- PR + CI → state.mjs (data, gh pr list)
- state.mjs → Board surfaces (snapshot + failure warnings)
- Board surfaces → Maintainer (board · artifact)
- Orchestrator → Maintainer (control, escalation)
- gate.sh → Coding sub-agent (feedback, gate output back, polarity -, loop B1)
- gate.sh → Linear backlog (feedback, 3 fails → blocked, polarity -, loop B2)
- Triage → Coding sub-agent (feedback, fix-now → re-review, polarity -, loop B3)
- Triage → Linear backlog (feedback, new tickets (coderabbit label), polarity +, loop R1)
- Review ledger → lessons.md (feedback, 2nd recurrence → standing rule, polarity -, loop B4)
- Review ledger → gate.sh (feedback, 3rd+ → mechanical check (G7b), polarity -, loop B5)
- Maintainer → Orchestrator (feedback, batched answers · policy, polarity -, loop B6)
- Merge --no-ff → quarantine.json (feedback, fixed tests shrink baseline, polarity -, loop B7)
- Compare-mode evals → Coding sub-agent (feedback, no measured delta → not done, polarity -, loop B8)
- PR + CI → Coding sub-agent (feedback, CI red → fix on branch, polarity -, loop B9)
- MISSING LINK (modelled absence): Linear backlog → state.mjs (gap, board cannot read ticket status)
  state.mjs deliberately does not read Linear (it needs auth a shell script does not have), so the board shows execution state only. Linear stays authoritative; disagreement is surfaced as a warning, not reconciled silently. Deliberate — but it means no single surface shows both halves.
- Brief assembly → Coding sub-agent (data, brief)
- Coding sub-agent → gate.sh (data, diff)
- Triage → Review ledger (data, disposition)
- Triage → Merge --no-ff (data, disposition)
- Compare-mode evals → PR + CI (data, evidence)
- Audit findings → Linear backlog (data, finding)
- gate.sh → Compare-mode evals (data, gate-verdict)
- PR + CI → Merge --no-ff (data, green-pr)
- Merge --no-ff → GitLab + GitHub main (data, merged-main)
- Triage → Linear backlog (data, new-ticket)
- CodeRabbit → Triage (data, review-finding)
- PR + CI → CodeRabbit (data, review-request)
- gate.sh → scorecard.jsonl (data, scorecard-row)
- state.mjs → Board surfaces (data, snapshot)
- Linear backlog → Orchestrator (data, ticket)

## Loops
- **B1** (balancing): Coding sub-agent → gate.sh
- **B10** (balancing): Linear backlog → Orchestrator → Coding sub-agent → gate.sh → Compare-mode evals → PR + CI → Merge --no-ff
- **B2** (balancing): Linear backlog → Orchestrator → Coding sub-agent → gate.sh
- **B3** (balancing): Coding sub-agent → gate.sh → Compare-mode evals → PR + CI → CodeRabbit → Triage
- **B4** (balancing): lessons.md → Brief assembly → Coding sub-agent → gate.sh → Compare-mode evals → PR + CI → CodeRabbit → Triage → Review ledger
- **B5** (balancing): gate.sh → Compare-mode evals → PR + CI → CodeRabbit → Triage → Review ledger
- **B6** (balancing): Orchestrator → Maintainer
- **B7** (balancing): quarantine.json → gate.sh → Compare-mode evals → PR + CI → Merge --no-ff
- **B8** (balancing): Coding sub-agent → gate.sh → Compare-mode evals
- **B9** (balancing): Coding sub-agent → gate.sh → Compare-mode evals → PR + CI
- **R1** (reinforcing): Linear backlog → Orchestrator → Coding sub-agent → gate.sh → Compare-mode evals → PR + CI → CodeRabbit → Triage

## Open questions (analyzer findings)
- [high] **The regression-test gate is satisfiable by a test that never runs**
  G6 requires an added test case anywhere in the diff; whether the gate's own suites execute that file is enforced only by the ship-qa placement rule carried in every brief. Both skills state this openly — it is the known soft spot of the evidence gate, and the reason the rule is injected into every brief regardless of ticket category.
- [medium] **The shared board artifact only refreshes via an agent tool call**
  serve.mjs/status.mjs are free and always current; the published Artifact is a milestone snapshot because a shell script cannot republish it. The mitigation is labelling, not automation — the board says it is a snapshot.
- [medium] **One Postgres container bounds the whole factory's concurrency**
  Databases isolate correctness, but every gate's test run shares ship-audit-pg's connection limit and CPU — beyond a handful of simultaneous gates, test timings stop being comparable. Playwright sizing from free memory alongside gate runs once produced a 90GB over-subscription and a system crash. Dispatch is broad; gates stagger.
- [low] **CodeRabbit CLI is unbounded and its allowance is shared**
  The CLI has no internal deadline (observed 11+ min wall against 2.6s CPU under concurrent worktrees) and its free allowance exhausts, returning a JSON error stub. G9 mitigates both — hard timeout, and never promoting a stub over a completed review — but the PR-level review remains the authoritative fallback.
