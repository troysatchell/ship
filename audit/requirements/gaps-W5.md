# Requirements gaps — Ship (2026-08-08T22:18:39Z, commit 85598041c438)

Ticket coverage below is live Linear data. Each gap lists the tickets that map to it, or says none does — a gap with no ticket is the one most likely to be forgotten.

## Unticketed requirements

### W5-R9 — PARTIAL
- **Quote:** "What can it do autonomously?"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Meaning in code:** The Agent Responsibility section names the actions taken without approval.
- **Tickets:** TRO-321
- **What is missing:** 3 of the 4 named autonomous actions (mention resolution, writing own drafts/items, clearing own items) are implemented and verified to stay outside the gate, matching the doc. The 4th — "linking a document to the issue or week it refers to, when the reference is unambiguous" — has no implementation anywhere in agent/src (grep for link/createAssociation/postAssociation/unambiguous across the whole directory found nothing but an unrelated docstring use of the word "unambiguous"). Unlike other undone work in this document (Graph Diagram Note 1, Use Case 5's notes), this gap is not flagged as aspirational where it is stated.
- **Suggested scope:** Either implement the second "acts" bullet ("linking a document to the issue or week it refers to, when the reference is unambiguous" — a query-proved association write) as a graph node, or add the same explicit not-yet-built caveat this file already applies elsewhere (e.g. the Graph Diagram's Note 1, or Use Case 5's "its agent side has not [shipped]") to that bullet instead of presenting it as a live capability.
- **Existing partial evidence:** `FLEETGRAPH.MD:82`, `FLEETGRAPH.MD:87`, `agent/src/graph.ts:1258`, `agent/src/graph.ts:1274`

### W5-R11 — PARTIAL
- **Quote:** "How does it know who is on a project and what their role is?"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Meaning in code:** The agent resolves project membership and role from Ship data, and the mechanism is documented.
- **Tickets:** TRO-317
- **What is missing:** Two gaps, not one. (1) Project membership lookup is real code (blockerFanout.ts's getAssociations(issueId,'project')), but the Director/PM/Engineer role-derivation table is documentation only — roles.ts's own docstring admits the taxonomy is unimplemented. (2) The earlier-flagged single-shared-token concern is confirmed still true, but only partially: TRO-342 fixed the on-demand path to use each asker's own token (graph.ts:1048-1057, requireAskingUserToken), but the proactive/steady/deep tiers — the paths that actually do the continuous project/people scanning this requirement is about — still run under one shared admin-minted token (index.ts:173-183) by explicit, intentional design. FLEETGRAPH.MD's blanket "no service account... nothing you could not [reach]" claim (line 817-821) does not carry this per-tier distinction, and it is not disclosed at all in the section that answers W5-R11 (lines 151-172).
- **Suggested scope:** Either implement the Director/PM/Engineer role derivation the table describes (a function analogous to roles.ts's existing manager-chain walk, deriving role from reporting-depth/ownership as tabulated) or narrow this section's claim to what's built (project membership + single-hop manager lookup for escalation only); separately, add one sentence disclosing that proactive/deep-tier polling runs under one shared account's visibility (agent/src/index.ts:173-183) while only on-demand chat runs under the asking person's own token (agent/src/graph.ts:1048-1057) — the current "each person's own token... nothing you could not [reach]" framing in the Deployment model section is not qualified by tier, and this section (where the membership/role question is actually answered) does not mention the distinction at all.
- **Existing partial evidence:** `FLEETGRAPH.MD:151`, `agent/src/blockerFanout.ts:88`, `agent/src/roles.ts:1`, `FLEETGRAPH.MD:817`

### W5-R29 — PARTIAL
- **Quote:** "Cost per graph run"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Meaning in code:** A measured (not projected) cost per graph run is documented in FLEETGRAPH.md.
- **Tickets:** TRO-324, TRO-331, TRO-339
- **What is missing:** The figure is reported per-node/per-tier (respond vs. composeAnswer), not as one aggregate "cost per graph run" number — a defensible reading given the graph has multiple distinct paths (bare chat vs. expansion vs. standup draft) that genuinely cost different amounts, rather than a gap. Distinct from this, FLEETGRAPH.MD's "Production Cost Projections" section (line 1320) separately gives PROJECTED per-tier costs ($0.021/$0.015/$0.052/$0.065), explicitly under an "Assumptions" heading and never merged into the measured table above — this is exactly the measured-vs-projected separation the audit brief asks to check for, and it is done correctly here: the measured figures are labeled "not an estimate" and cross-checked against LangSmith; the projected figures are clearly scoped to "Production Cost Projections" > "Assumptions." The measured-cost METHOD is sound and correctly labelled 'not an estimate' — a real per-invocation ledger written by graph.ts's recordInvocation and cross-checked against LangSmith. The published FIGURES are stale. Controller re-ran the exact command FLEETGRAPH.MD cites as its own reproduction method (`pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts`) on 2026-08-08 and got composeAnswer $0.000876/run over 6 invocations and composeStandupDraft $0.000798/run over 1 invocation, against the document's $0.000852 and an explicit claim of zero composeStandupDraft invocations. Smallest fix: re-run the command and paste its current output.
- **Suggested scope:** Re-run `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` and paste its current output into FLEETGRAPH.MD's per-tier cost table. The instrument is correct; only the transcribed figures are old.
- **Existing partial evidence:** `FLEETGRAPH.MD:1162`, `FLEETGRAPH.MD:1175`, `FLEETGRAPH.MD:1213`, `FLEETGRAPH.MD:1215`

### W5-R35 — PARTIAL
- **Quote:** "Every agent behaviour defined in your use cases must have a corresponding regression test."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** Each use case maps to a named regression test that the CI suite runs.
- **Tickets:** TRO-322, TRO-330, TRO-346
- **What is missing:** Mapping itself is complete: all 6 FLEETGRAPH.MD use cases have a named, real regression test (0 uncovered). Missing: on GitLab CI — this repo's own .gitlab-ci.yml states GitLab is 'the actual submission target' — the agent package's unit-test suite (which holds every one of these regression tests) is never invoked; .gitlab-ci.yml only builds the agent package for its e2e-agent job, never runs `pnpm --filter @ship/agent test`. Only GitHub Actions currently executes this suite. `scripts/factory/gate.sh` also runs it (CHANGES.md:2253) but that is a local factory eval gate, not either platform's CI.
- **Suggested scope:** Add a `pnpm --filter @ship/agent test` invocation (with DATABASE_URL/NODE_ENV=test, mirroring .github/workflows/ci.yml lines 131-135) to .gitlab-ci.yml's `verify` job, so the same 6-use-case regression coverage that already runs on GitHub Actions also runs on the platform the assignment names as the actual submission target.
- **Existing partial evidence:** `FLEETGRAPH.MD:388`, `agent/src/__tests__/standupDraft.test.ts:116`, `agent/src/__tests__/graph.test.ts:689`, `FLEETGRAPH.MD:389`

### W5-R36 — MISSING
- **Quote:** "If a CI run fails, the deployment must be rolled back automatically — do not allow a failing build to remain deployed."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** CI failure triggers an automatic rollback of the deployed agent.
- **Tickets:** TRO-322, TRO-330
- **What is missing:** Nothing in the repo makes a CI failure automatically roll back the deployed agent. What exists instead: (1) CI gates merge, so a failing commit never reaches `main` and is therefore never deployed at all (prevention, not rollback of a live deployment) — the repo's own FLEETGRAPH.MD says so explicitly; (2) a corrective CLI (check-readiness-and-rollback.ts) that CAN redeploy a prior commit via the Render API, fully tested (deployReadiness.test.ts, check-readiness-and-rollback.test.ts) and proven by local simulation, but is dry-run by default and, per its own docstring, deliberately not wired to any automatic trigger against the live service.
- **Suggested scope:** Wire check-readiness-and-rollback.ts --execute into an automatic trigger (a scheduled job or a CI post-deploy step) so a sustained CI/deploy failure actually redeploys the previous known-good commit without a human running the CLI by hand — this is explicitly named as not-yet-done in both the script's own docstring and FLEETGRAPH.MD.
- **Existing partial evidence:** `agent/src/scripts/check-readiness-and-rollback.ts:11`, `agent/src/scripts/check-readiness-and-rollback.ts:178`, `FLEETGRAPH.MD:947`, `FLEETGRAPH.MD:1020`

### W5-R43 — PARTIAL
- **Quote:** "All outbound calls from the agent (to Ship APIs, LLM providers, and any external tools) must implement explicit timeouts and retry logic with exponential backoff."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** Every outbound call path sets a timeout and retries with exponential backoff.
- **Tickets:** TRO-315, TRO-326
- **What is missing:** Ship API calls (via ResilientClient, shared by every ShipClient/GateShipClient instance in the package) fully satisfy this requirement: explicit timeoutMs, exponential backoff with jitter, and a circuit breaker on top. The LLM provider call (ChatAnthropic, agent/src/index.ts:162) has no explicit timeout or retry/backoff configured anywhere in this codebase — it relies entirely on whatever @langchain/anthropic's internal defaults are, which the requirement's own wording ('must implement explicit timeouts and retry logic') does not credit. There are no other external-tool outbound clients in the package.
- **Suggested scope:** Route the ChatAnthropic call in agent/src/index.ts through the same explicit-timeout + exponential-backoff discipline ResilientClient already gives Ship API calls — either pass ChatAnthropic's own `timeout`/`maxRetries` constructor options explicitly (documenting the chosen values, not relying on library defaults) or wrap model.invoke() in an equivalent bounded-retry helper.
- **Existing partial evidence:** `agent/src/resilientClient.ts:168`, `agent/src/resilientClient.ts:226`, `agent/src/resilientClient.ts:263`, `agent/src/server.ts:91`

### W5-R45 — PARTIAL
- **Quote:** "Document the retry strategy and fallback behaviour in FLEETGRAPH.md, and demonstrate graceful degradation in your Architecture Defense."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** FLEETGRAPH.md documents retry/fallback; the Architecture Defense demonstrated degradation.
- **Tickets:** TRO-315
- **What is missing:** Missing two things. (1) FLEETGRAPH.MD's retry/fallback documentation is scattered across the Rollback and Reliability subsections and covers only Ship-reachability degradation — it never mentions that the LLM provider call has no explicit timeout/backoff (the W5-R43 gap), so the documentation is incomplete relative to what the code actually does. (2) 'a record of the defense demonstration': memory-bank/progress.md:369 (dated 2026-08-03) flags the Architecture Defense's graceful-degradation demo as an open, unresolved item at that time ('FG-4's graceful-degradation demo must exist by then'), and no later memory-bank or CHANGES.md entry records that the defense itself was actually held or that a demonstration record was captured — only the underlying local-simulation evidence (FLEETGRAPH.MD:1012-1019) exists, which is preparation for a defense, not a record that one occurred.
- **Suggested scope:** Add a dedicated 'retry strategy and fallback behaviour' subsection to FLEETGRAPH.MD that names ALL outbound call classes explicitly (Ship API AND the LLM provider) and their respective timeout/backoff coverage — including disclosing the LLM-provider gap found under W5-R43 rather than leaving it undocumented — and capture a record (transcript, screenshot, or a dated memory-bank note) that the Architecture Defense's graceful-degradation demo actually happened.
- **Existing partial evidence:** `FLEETGRAPH.MD:942`, `FLEETGRAPH.MD:477`, `FLEETGRAPH.MD:1012`

### W5-R46 — PARTIAL
- **Quote:** "Maintain a CHANGES.md at the repo root documenting every significant addition: what was built, how to run and test it locally, and how to roll it back if it fails."
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Meaning in code:** CHANGES.md at repo root has an entry per significant addition with run/test/rollback.
- **Tickets:** TRO-325, TRO-326, TRO-327, TRO-328, TRO-329, TRO-330, TRO-331
- **What is missing:** Of 144 top-level entries, 124 (~86%) carry a recognizable heading/instruction for both 'how to run and test it locally' and 'how to roll it back' (in addition to the narrative 'what was built' every entry has by construction). 13 entries have run/test instructions but no rollback section — confirming the trace-rules' expectation that rollback is the most-omitted element. 6 entries have a rollback section but no explicit run/test instructions. 1 entry ('Bundle TRO-330') has neither on its own, but it is an EPIC status rollup that explicitly defers to the two complete entries immediately following it, not an undocumented addition in its own right. This is a heuristic text-pattern count (bolded headings + inline pnpm/tsx/curl commands), not an exhaustive manual read of all 144 entries — a few borderline classifications are possible at the margins, but the overall proportions (large majority complete, rollback the more commonly missing element) should hold.
- **Suggested scope:** Add explicit 'How to roll it back' sections to the 13 entries identified as missing one (e.g. TRO-232, TRO-210, TRO-280, TRO-180, TRO-298, TRO-218+TRO-222, TRO-286, TRO-216, TRO-282, TRO-223, TRO-226, TRO-173+TRO-182, TRO-201, TRO-305, TRO-294, TRO-302, TRO-203+TRO-204), and a 'How to run/test it locally' description to the 6 entries missing that instead.
- **Existing partial evidence:** `CHANGES.md:1`, `CHANGES.md:2292`, `CHANGES.md:2306`, `CHANGES.md:2136`

### W5-R47 — PARTIAL
- **Quote:** "Claude API costs (input and output token breakdown)"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Meaning in code:** Actual Claude spend is reported split by input and output tokens.
- **Tickets:** TRO-331, TRO-339
- **What is missing:** The breakdown IS measured, not projected -- real methodology (cost-ledger.jsonl instrumentation, cross-reconciled against LangSmith's own usage API at FLEETGRAPH.MD:1175-1178). But it is stale, verified by actually running the script the document itself cites as its own reproduction method: current ledger totals are input=1,860 / output=839 tokens across 7 invocations / $0.006055 total, not the 567/271/3/$0.001922 the document's most current table reports. This is not an old-snapshot problem -- the ledger's newest entry (a real composeStandupDraft invocation, 2026-08-07T14:36:16.889Z) postdates the document's own 'Last updated: August 7, 2026' banner (FLEETGRAPH.MD:19), so the correct figures were available before the document's final state and were not folded in. Controller confirmed the staleness by direct re-run rather than inference. Reported: 3 invocations / 567 input / 271 output / $0.001922. Actual at HEAD: 7 invocations / 1,860 input / 839 output / $0.006055 — roughly 3x. The ledger's newest entry (agent/.cache/cost-ledger.jsonl, node=composeStandupDraft, timestamp 2026-08-07T14:36:16.889Z) postdates the document's own 'Last updated: August 7, 2026' banner, so this was available and unreconciled rather than a stale snapshot. Directly contradicts FLEETGRAPH.MD:1223's 'composeStandupDraft still has zero real invocations'.
- **Suggested scope:** Same single action as W5-R29 — one command, then replace the three development-spend figures (invocations, input/output tokens, total) with what it prints, and delete the 'composeStandupDraft still has zero real invocations' sentence, which the ledger contradicts.
- **Existing partial evidence:** `FLEETGRAPH.MD:1162`, `FLEETGRAPH.MD:1168`, `FLEETGRAPH.MD:1210`, `FLEETGRAPH.MD:1216`

### W5-R48 — PARTIAL
- **Quote:** "Number of graph agent invocations during development"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Meaning in code:** A measured invocation count is reported.
- **Tickets:** TRO-331, TRO-339
- **What is missing:** A measured invocation count IS reported (methodology is real, not fabricated), but it under-counts by more than half: the ledger holds 7 records, not 3, and one of the missing 4 is the composeStandupDraft invocation the document explicitly and currently claims does not exist (line 1223). Verified live by re-running the exact script FLEETGRAPH.MD cites for this figure (see suggested_verification) -- this is not an inference from the file alone, the command was actually run and printed 'Invocations: 7'. Invocation count reported as 3; the ledger holds 7 (verified by the controller both by parsing agent/.cache/cost-ledger.jsonl directly and by re-running cost-report.ts). Same single fix as W5-R47.
- **Suggested scope:** Covered by the W5-R29 re-run: the invocation count comes from the same command.
- **Existing partial evidence:** `FLEETGRAPH.MD:1172`, `FLEETGRAPH.MD:1216`, `FLEETGRAPH.MD:1223`, `agent/.cache/cost-ledger.jsonl:7`

### W5-R49 — PARTIAL
- **Quote:** "Total development spend"
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Meaning in code:** Total development spend is reported.
- **Tickets:** TRO-331, TRO-339
- **What is missing:** Total development spend is reported and the reporting method is genuinely measured (not a projection), but the figure is stale by more than 3x: the document's own most current number is $0.001922, while re-running the document's own cited reproduction command against the current ledger returns $0.006055. This was directly verified, not inferred -- the command was executed as part of this audit. Total development spend reported as $0.001922; re-run gives $0.006055. Same single fix as W5-R47 — the instrument is right, the transcription is old.
- **Suggested scope:** Covered by the W5-R29 re-run: total spend comes from the same command.
- **Existing partial evidence:** `FLEETGRAPH.MD:1173`, `FLEETGRAPH.MD:1216`, `agent/.cache/cost-ledger.jsonl:1`

## Orphan tickets

- TRO-332 "[FG-14] A-blocks-B-blocks-A is insertable today — any graph traversal will loop forever" (Done) — maps to no W4 requirement.
- TRO-333 "[FG-15] Ship cannot express "issue A blocks issue B" — it has a containment tree and an org chart but no dependency graph" (Done) — maps to no W4 requirement.
- TRO-334 "[FG-16] A blocking relationship nobody can see or set is not a feature — blocks/blocked-by in the issue sidebar" (Done) — maps to no W4 requirement.
- TRO-335 "[FG-17] At week's end someone reconstructs from memory what they delivered — Ship already holds the answer" (Done) — maps to no W4 requirement.
- TRO-336 "[FG-18] The "plan changed after approval" flag trips on typo fixes, so managers ignore it — and a quiet scope cut looks identical" (Done) — maps to no W4 requirement.
- TRO-337 "[FG-19] When one issue holds up work across reporting lines, no page in Ship joins the two — the use case only a graph can serve" (Done) — maps to no W4 requirement.
- TRO-338 "[FG-20] Recorded model responses pin the output, so a prompt rewrite can break production while every test stays green" (Done) — maps to no W4 requirement.
- TRO-343 "React Query cache is never cleared on login/logout/impersonation — cross-user data leakage on shared browsers" (Done) — maps to no W4 requirement.
- TRO-344 "Circular-blocks error message is inferred from a bare 500, not a dedicated error code" (Done) — maps to no W4 requirement.
- TRO-355 "No UI exists to add/delete table rows or columns — 4 e2e tests were silently vacuous, converted to test.fixme()" (Backlog) — maps to no W4 requirement.
- TRO-361 "FG: auto_deploy on the graded Render services has silently failed 3 times — root-cause it or replace it with an explicit post-merge deploy step" (Backlog) — maps to no W4 requirement.

