# Ship Factory v2
Plan → Build → Review, with a self-closing loop and a blind verifier · GAUNTLET/Ship — scripts/factory/*, .claude/skills/ship-{factory,pm,architect,spec,qa-review} · profile: process

28 stages · 94 connections · 13 loops · 2 open questions

## Stages

### Plan
- **Intent** [intake] — new capability, no audit finding behind it · fan-in 0, fan-out 1, instability 1.0 · emits: intent
  Work that arrives as a wish rather than as evidence. The Week 4 factory could not start on this at all — every ticket it consumed came pre-written from AUDIT_REPORT.md, which had already done the analysis. Running Build directly on an intent produces tickets that contradict each other, because nobody decided the shape first.
- **Audit findings** [intake] — 68 findings, each with measured evidence · fan-in 0, fan-out 1, instability 1.0 · emits: finding
  The other way work enters. A finding already carries its own spec — the measurement, the file, the estimated impact — so it skips Plan entirely and goes straight to the backlog. Writing a spec for "DB-7, the index is missing" is ceremony.
  source: audit/AUDIT_REPORT.md
- **PM writes the spec** [transform] — /ship-pm + /ship-spec · fan-in 3, fan-out 1, instability 0.25 · emits: draft-spec · consumes: intent, spec-defect
  Six sections. The problem stated as what it costs someone, not as a feature — "add a change-feed endpoint" is a solution and survives no contact with an architect who knows a cheaper one. Non-goals do the most work: every spec without them grows a ticket at a time until the phase misses its deadline.
  source: .claude/skills/ship-spec/SKILL.md
- **Scope gate** [gate] — five rows, any one fails the spec · fan-in 1, fan-out 2, instability 0.67 · emits: approved-spec · consumes: draft-spec
  Problem-as-cost · observable success · explicit non-goals · every repo claim verified and marked observed-vs-derived · fits the phase. A failed gate names the row. The PM does not soften a spec to pass its own gate.
- **Architect designs** [transform] — /ship-architect · fan-in 1, fan-out 2, instability 0.67 · emits: design, question · consumes: survey
  Owns the how, which the spec deliberately withholds. Component boundaries, migrations with their numbers, where this plugs into what exists, how it degrades, and what was rejected — the last being the most-read section in six months and the cheapest to write now.
  source: .claude/skills/ship-architect/SKILL.md
- **Tier every ticket** [control] — apply or investigate · fan-in 1, fan-out 1, instability 0.5 · emits: ticket · consumes: design, acceptance-tests
  One question decides the cost of everything downstream: can you name the file, the change, and the check that proves it? Yes → an applier on haiku with one self-contained instruction. No → an investigator on sonnet with the full brief. Push work down a tier wherever honest — an investigator rediscovering what the architect already decided is this factory's most common waste.
  source: .claude/skills/ship-factory/references/model-tiering.md
- **Linear backlog** [store] — authoritative for ticket status · fan-in 5, fan-out 1, instability 0.17 · emits: eligible · consumes: ticket, finding, new-ticket, merged, rewritten
  Linear owns status; the board owns execution state. When they disagree, Linear wins and something has gone wrong — say so rather than reconciling silently. Every ticket in a batch moves to In Progress before dispatch: that is the lock, and it only works if it covers everything the branch will close.
- **Surveyor** [transform] — sonnet · answers, not source · fan-in 2, fan-out 1, instability 0.33 · emits: survey · consumes: approved-spec, question
  Finds out what is actually there so the architect does not have to read fifteen files to find out. Returns two pages of answered questions with file:line evidence, and an explicit list of what could not be determined — a question dropped by omission is how an architect ends up assuming. Same tiering argument as the applier, one level up: the architect is the most expensive context in the factory to fill, and filling it with raw source it will use once is the waste this removes.
  source: .claude/skills/ship-surveyor/SKILL.md
- **Test designer** [gate] — writes the tests before the code exists · fan-in 1, fan-out 3, instability 0.75 · emits: acceptance-tests, spec-defect · consumes: design
  Designs each acceptance test from the spec and the design, having never seen an implementation — because there isn't one yet. A test written by the agent that just decided how the code works proves that implementation behaves as intended; it does not prove the requirement is met, and it survives refactors that break what someone actually asked for. Its output becomes each ticket's definition of done — which test, and what it must assert. An acceptance criterion it cannot design a test for goes back to the PM as a spec defect rather than being quietly dropped.
  source: .claude/skills/ship-test-designer/SKILL.md

### Dispatch
- **Orchestrator** [control] — selects, batches, serializes only on real dependencies · fan-in 2, fan-out 1, instability 0.33 · emits: dispatch · consumes: eligible
  Dispatches everything eligible concurrently. Serializes only for a true blocking dependency, a same-file collision, or expensive-tier measurement ordering. Re-evaluates after every completion — a ticket whose blockers just went Done becomes eligible immediately.
  source: .claude/skills/ship-orchestrator/SKILL.md

### Isolated build
- **Isolated worktree** [transform] — worktree.sh — own branch, own database, own ports · fan-in 1, fan-out 3, instability 0.75 · emits: workspace · consumes: dispatch
  Every ticket gets its own database because the test setup TRUNCATEs 16 tables in the beforeAll of every test file — agents sharing one would corrupt each other and produce failures that look like code defects. Ports are probed and claimed, not derived from a hash: md5 % 900 collides about half the time by 36 concurrent tickets.
  source: scripts/factory/worktree.sh
- **Applier** [transform] — haiku · one instruction, no role brief · fan-in 2, fan-out 2, instability 0.5 · emits: diff, discrepancy · consumes: workspace
  Gets the file, the change, the reason, and the command that proves it — nothing else. No lessons.md, no role skill. If the instruction does not match what it finds, it STOPS and reports the discrepancy rather than improvising: a wrong instruction is information, and surfacing it costs one cheap round trip. That stop rule is what makes a small model safe here.
- **Investigator** [transform] — sonnet · contract + lessons + role skill · fan-in 6, fan-out 1, instability 0.14 · emits: diff · consumes: workspace, rule
  For work where the cause is unknown. Carries the full ~40KB brief because diagnosis needs the context. Must produce a regression test seen red first — and red for the right reason, since an import error is not a red test.
  source: .claude/skills/ship-factory/references/agent-contract.md

### Verify
- **gate.sh** [gate] — typecheck · build · tests vs quarantine · not-weakened · regression · CHANGES · patterns · fan-in 3, fan-out 5, instability 0.62 · emits: gate-result, stuck · consumes: diff, check
  Deliberately mechanical — every check passes or fails on evidence. The quarantine baseline is materialized from BASE_REF, never read from the ticket branch, so an agent cannot append its own new failures and pass. Retry cap is three; raising it to force a pass is what turns "surfaces a hard problem" into "burns tokens forever".
  source: scripts/factory/gate.sh
- **Blind verifier** [gate] — gets the finding, the diff, the gate JSON — and nothing else · fan-in 1, fan-out 3, instability 0.75 · emits: verdict, stuck · consumes: gate-result
  Checks that the right thing was built, which the gate cannot. It never sees the investigator's report, commits, or PR body — that narrative is a framing written by whoever decided what to build, and a verifier that reads it first can only check internal consistency. Reading the finding fresh and the diff cold is the only thing that makes the check independent, and independence is what makes closing without a human safe.
  source: .claude/skills/ship-factory/references/self-closing-loop.md
- **QA reviewer** [gate] — reviews the proof — would anything have failed? · fan-in 1, fan-out 2, instability 0.67 · emits: proof-verdict · consumes: gate-result
  A different job from reviewing code, and this repo has the scars: its own audit found 68 e2e tests that passed without executing a single assertion. Checks the regression test lives where the gate actually runs it, that red was seen, that the quarantine did not widen, and that every "verified" names what was run.
  source: .claude/skills/ship-qa-review/SKILL.md

### Review
- **Pull request** [release] — body is the evidence, not a summary · fan-in 2, fan-out 2, instability 0.5 · emits: pr-open · consumes: verdict, proof-verdict
  One Closes line per ticket — GitHub only auto-closes what it sees named individually, and a batched branch that closes one of three leaves two tickets open with their work already merged.
- **CodeRabbit** [external] — reviews the code — is it correct? · fan-in 1, fan-out 1, instability 0.5 · emits: code-finding · consumes: pr-open
  Finds real things and irrelevant things with equal confidence, which is why its output goes to a decider rather than straight to a fix queue.
- **PM triage** [control] — in scope? needed? efficient? · fan-in 1, fan-out 4, instability 0.8 · emits: fix-now, new-ticket, dismissal · consumes: code-finding
  The second question is the one the old mechanical triage never asked. A finding can be entirely correct and still not worth acting on — a missing index on a table holding 20 rows read once a day is a true observation about an irrelevant path. "Not important" is not a triage decision; the PM must name a row count, a call frequency, or a convention.
  source: .claude/skills/ship-pm/SKILL.md
- **Merge --no-ff** [release] — self-closes when all five hold · fan-in 1, fan-out 1, instability 0.5 · emits: merged
  Gate pass · CI green · verifier confirmed · every finding triaged with fix-now ones fixed · no open escalation. A close with no verifier verdict attached is an unreviewed merge wearing the same label. Merged --no-ff so the branch structure survives — the git log is read directly.

### Observe
- **Review ledger** [store] — every finding, every disposition · fan-in 1, fan-out 2, instability 0.67 · emits: recurrence · consumes: fix-now, new-ticket, dismissal
  Fixing findings one at a time and discarding them means a defect class can recur on four branches without anyone noticing it is the same defect four times — which is exactly what happened on day one. Also tracks dismissals: a growing pile in one category means the factory is talking itself out of real feedback.
  source: scripts/factory/review-ledger.mjs
- **Derived state** [store] — phase · lastActivityAt · idleMinutes · stalled · fan-in 3, fan-out 1, instability 0.25 · emits: live-state · consumes: workspace, gate-result, pr-open
  There is deliberately no status file. One that drifts reads as authoritative while being wrong, which is worse than none. Phase is derived from signals the work itself left: commits, dirty files, gate results, PR state. Stall is idle time in a phase that should be moving — without that qualifier every merged ticket reads as stuck.
  source: scripts/factory/lib/state.mjs·collect
- **Live dashboard** [release] — SSE · localhost:7373 · fan-in 1, fan-out 0, instability 0.0 · consumes: live-state
  Answers "what is going on" without investigation — five tiles, a phase track per ticket, and an activity feed built by diffing frames. Elapsed timers count every second client-side while the server polls every three, which is what makes it feel connected rather than static. Adaptive backoff when collect() slows.
  source: scripts/factory/serve.mjs
- **lessons.md** [store] — injected verbatim into every investigator brief · fan-in 1, fan-out 1, instability 0.5 · emits: rule · consumes: recurrence
  Two recurrences across separate tickets means a rule is missing from the brief. Only works if it stays short and specific — rules that earned their place, not a diary.
  source: .claude/skills/ship-factory/references/lessons.md
- **New gate check** [transform] — review-patterns.mjs — G7b · fan-in 1, fan-out 1, instability 0.5 · emits: check · consumes: recurrence
  Three or more recurrences means the prompt is not holding. A rule stated in the brief and ignored three times does not need restating louder — it needs a mechanical check. G7b exists because two classes crossed that line.
  source: scripts/factory/review-patterns.mjs

### Escalate
- **Escalation** [control] — parks the ticket, never the wave · fan-in 3, fan-out 3, instability 0.5 · emits: ping, stuck · consumes: stuck, discrepancy
  One test: is this work stream stopped until the person answers? A gate holds its own ticket — that worktree parks, its Linear ticket goes to blocked with the reason, and the orchestrator dispatches the next eligible ticket immediately. Never drain in-flight work to wait for an answer.
  source: .claude/skills/ship-factory/references/escalation.md
- **Slack** [external] — three triggers, batched · fan-in 1, fan-out 0, instability 0.0 · consumes: ping
  Spent retry budget · two rejected verifications · any escalation.md gate. Plus one batched summary only if an unattended run ends with unresolved items — --count 0 refuses to send, enforced in the script rather than left to a caller's discipline. There is deliberately no informational severity: adding one is how a channel stops being read, and an unread channel is worse than none because it looks like coverage.
  source: scripts/factory/notify.mjs
- **Rewrite the ticket** [transform] — PM · max 2 attempts · fan-in 1, fan-out 1, instability 0.5 · emits: rewritten · consumes: stuck
  A ticket that failed is usually not a ticket that needs a human — it is more often a ticket that was written badly: under-specified, tiered wrong, or three changes wearing one title. The PM asks whether a differently-written ticket would succeed, and if so rewrites it. Re-queued fresh, not retried: new ticket, new worktree, no inherited context — because the inherited context is what produced the failure. Cap of two. A third failure means the wording is not the problem, and that is exactly the signal worth a person's attention. This is the mechanism that makes the escalation channel rare. Anything an agent could fix given a better instruction gets one, automatically, without reaching Slack.
  source: .claude/skills/ship-factory/references/self-closing-loop.md·Rewrite before you escalate

## Connections
- Intent → PM writes the spec (intent)
- PM writes the spec → Scope gate (draft spec)
- Scope gate → Surveyor (approved — go look)
- Surveyor → Architect designs (what is actually there)
- Architect designs → Test designer (design)
- Test designer → Tier every ticket (acceptance tests per ticket)
- Tier every ticket → Linear backlog (tiered tickets)
- Audit findings → Linear backlog (finding carries its own spec)
- Linear backlog → Orchestrator (next eligible batch)
- Orchestrator → Isolated worktree (control, provision per ticket)
- Isolated worktree → Applier (specified work)
- Isolated worktree → Investigator (cause unknown)
- lessons.md → Investigator (data, verbatim)
- Applier → gate.sh (diff)
- Investigator → gate.sh (diff + regression test)
- New gate check → gate.sh (control, G7b)
- gate.sh → Blind verifier (pass)
- Blind verifier → Pull request (confirmed)
- Pull request → CodeRabbit (reviews the code)
- gate.sh → QA reviewer (pass — is the proof real?)
- CodeRabbit → PM triage (code findings)
- QA reviewer → Pull request (proof holds)
- PM triage → Review ledger (data, every finding)
- PM triage → Merge --no-ff (all triaged)
- Isolated worktree → Derived state (data, git + .factory-env)
- gate.sh → Derived state (data, gate-result.json)
- Pull request → Derived state (data, gh pr list)
- Derived state → Live dashboard (data, SSE)
- Scope gate → PM writes the spec (feedback, failed row named, polarity -, loop spec-gate)
- gate.sh → Investigator (feedback, exact gate output, polarity -, loop gate-retry)
- Blind verifier → Investigator (feedback, not-addressed — same agent, polarity -, loop verify-retry)
- PM triage → Applier (feedback, fix now — file already named, polarity -, loop fix-now)
- PM triage → Linear backlog (feedback, real, polarity +, loop backlog-growth)
- Review ledger → lessons.md (feedback, 2 recurrences — a rule is missing, polarity -, loop prompt-repair)
- Review ledger → New gate check (feedback, 3+ — the prompt is not holding, polarity -, loop mechanize)
- Merge --no-ff → Linear backlog (feedback, self-close with evidence attached, polarity -, loop close)
- gate.sh → Escalation (control, 3 failed gates)
- Blind verifier → Escalation (control, 2 rejected verifications)
- Escalation → Slack (blocked · gate · summary)
- Escalation → Orchestrator (feedback, park this ticket, polarity -, loop park)
- MISSING LINK (modelled absence): Slack → Orchestrator (gap, no defined return path for the human's answer)
- MISSING LINK (modelled absence): Blind verifier → Review ledger (gap, rejections bypass the recurrence thresholds)
- QA reviewer → Investigator (feedback, blocks-merge — test cannot run, polarity -, loop proof-repair)
- Applier → Escalation (control, instruction does not match the file)
- MISSING LINK (modelled absence): Architect designs → Scope gate (gap, no gate on the design — only the spec is reviewed)
- Escalation → Rewrite the ticket (control, would a rewrite succeed?)
- Rewrite the ticket → Linear backlog (feedback, re-queued fresh — max 2, polarity -, loop rewrite)
- Architect designs → Surveyor (feedback, follow-up question, polarity -, loop survey-followup)
- Test designer → PM writes the spec (feedback, criterion cannot be tested — spec defect, polarity -, loop spec-defect)
- Test designer → Investigator (data, the test each ticket must pass)
- Test designer → Tier every ticket (data, acceptance-tests)
- Scope gate → Surveyor (data, approved-spec)
- New gate check → gate.sh (data, check)
- CodeRabbit → PM triage (data, code-finding)
- Architect designs → Tier every ticket (data, design, inferred)
- Architect designs → Test designer (data, design)
- Applier → gate.sh (data, diff)
- Investigator → gate.sh (data, diff)
- Applier → Escalation (data, discrepancy)
- PM triage → Review ledger (data, dismissal)
- Orchestrator → Isolated worktree (data, dispatch)
- PM writes the spec → Scope gate (data, draft-spec)
- Linear backlog → Orchestrator (data, eligible)
- Audit findings → Linear backlog (data, finding)
- PM triage → Review ledger (data, fix-now)
- gate.sh → Blind verifier (data, gate-result)
- gate.sh → QA reviewer (data, gate-result)
- gate.sh → Derived state (data, gate-result)
- Intent → PM writes the spec (data, intent)
- Derived state → Live dashboard (data, live-state)
- Merge --no-ff → Linear backlog (data, merged)
- PM triage → Linear backlog (data, new-ticket)
- PM triage → Review ledger (data, new-ticket)
- Escalation → Slack (data, ping)
- Pull request → CodeRabbit (data, pr-open)
- Pull request → Derived state (data, pr-open)
- QA reviewer → Pull request (data, proof-verdict)
- Architect designs → Surveyor (data, question)
- Review ledger → lessons.md (data, recurrence)
- Review ledger → New gate check (data, recurrence)
- Rewrite the ticket → Linear backlog (data, rewritten)
- lessons.md → Investigator (data, rule)
- Test designer → PM writes the spec (data, spec-defect)
- gate.sh → Escalation (data, stuck)
- gate.sh → Rewrite the ticket (data, stuck, inferred)
- Blind verifier → Escalation (data, stuck)
- Blind verifier → Rewrite the ticket (data, stuck, inferred)
- Escalation → Rewrite the ticket (data, stuck)
- Surveyor → Architect designs (data, survey)
- Tier every ticket → Linear backlog (data, ticket)
- Blind verifier → Pull request (data, verdict)
- Isolated worktree → Applier (data, workspace)
- Isolated worktree → Investigator (data, workspace)
- Isolated worktree → Derived state (data, workspace)

## Loops
- **close** (balancing): Linear backlog → Orchestrator → Isolated worktree → Applier → gate.sh → Blind verifier → Pull request → CodeRabbit → PM triage → Merge --no-ff
- **fix-now** (balancing): Applier → gate.sh → Blind verifier → Pull request → CodeRabbit → PM triage
- **gate-retry** (balancing): Investigator → gate.sh
- **mechanize** (balancing): New gate check → gate.sh → Blind verifier → Pull request → CodeRabbit → PM triage → Review ledger
- **park** (balancing): Orchestrator → Isolated worktree → Applier → Escalation
- **prompt-repair** (balancing): lessons.md → Investigator → gate.sh → Blind verifier → Pull request → CodeRabbit → PM triage → Review ledger
- **proof-repair** (balancing): Investigator → gate.sh → QA reviewer
- **rewrite** (balancing): Linear backlog → Orchestrator → Isolated worktree → Applier → Escalation → Rewrite the ticket
- **spec-defect** (balancing): PM writes the spec → Scope gate → Surveyor → Architect designs → Test designer
- **spec-gate** (balancing): PM writes the spec → Scope gate
- **survey-followup** (balancing): Surveyor → Architect designs
- **verify-retry** (balancing): Investigator → gate.sh → Blind verifier
- **backlog-growth** (reinforcing): Linear backlog → Orchestrator → Isolated worktree → Applier → gate.sh → Blind verifier → Pull request → CodeRabbit → PM triage

## Open questions (analyzer findings)
- [high] **There is a path to “Live dashboard” that passes no gate**
  Work can reach release without crossing any verification stage. Trace the ungated path and decide whether it is intentional (a hotfix lane) or an escape hatch nobody meant to leave open.
- [medium] **1 stage(s) model only the happy path**
  Every outgoing edge from these stages is a success edge: Surveyor. What happens when each of them fails? Unmodelled failure paths are where real factories silently drop work.
