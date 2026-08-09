# Requirements Audit — Ship (FleetGraph, Week 5)
**Commit:** 3e4a76dfbd7b · **Date:** 2026-08-09T14:00:00Z · **Docs:** W5 · **Mode:** compare (baseline `matrix.baseline-W5.json`)

## Summary

- **VERIFIED:** 6  (baseline 1)
- **IMPLEMENTED-UNVERIFIED:** 48  (baseline 45)
- **PARTIAL:** 3  (baseline 10)
- **MISSING:** 0  (baseline 1)

**`MISSING` is now zero, and nine rows improved.** W5-R36 — the only unimplemented requirement in the Week 5 brief — moved to `PARTIAL`: an automatic rollback trigger exists, is scheduled, and is tested against fakes. It is deliberately **not** credited as met, because the requirement says *"if a CI run fails"* and the trigger fires on sustained deployed-service unreadiness instead (ruling **I-03**). The four cost rows reached `VERIFIED` only after TRO-373 committed a tracked ledger snapshot, so the figures now reproduce from a clean clone rather than from one machine's gitignored cache (ruling **I-02**). Three `PARTIAL` rows remain, each with a named missing element. The most consequential outstanding item is not in the code: FLEETGRAPH.MD's Use Case 5 note claims a capability is unbuilt that has existed since 2026-08-05 and is documented as built two sections earlier in the same file (TRO-381).

## Coverage and limitations

- **No GitLab pipeline was observed.** W5-R35's fix is confirmed by reading `.gitlab-ci.yml` and by a regression test asserting its YAML placement, but no pipeline run was checked — the sweep had no GitLab API access. That is why the row is `IMPLEMENTED-UNVERIFIED` and not `VERIFIED`.
- **The rollback trigger has still never executed for real.** Both secrets were provisioned 2026-08-09 13:38 UTC; the last scheduled run (12:56 UTC) predates them and logged `configured=false`.
- **No Terraform command was run.** W5-R25's proof predates two env vars now in the config; re-demonstrating it is a live infrastructure operation needing human sign-off (TRO-382).
- **Side effect caused by this sweep:** the `pnpm test` verification TRUNCATEs 16 tables. It was pointed at the throwaway database `ship_wt_tro_371`, never the dev database.
- **48 of 57 rows are statically traced only** — the expected steady state for documentation and design requirements, not a coverage failure.
- **Working tree was dirty at sweep time** (8 paths, listed in the matrix). No row's evidence cites a dirty path.

## Delta

| ID | baseline | now | what changed |
|---|---|---|---|
| W5-R9 | PARTIAL | **IMPLEMENTED-UNVERIFIED** | The Agent Responsibility section names the actions taken without a |
| W5-R11 | PARTIAL | **IMPLEMENTED-UNVERIFIED** | The agent resolves project membership and role from Ship data, and |
| W5-R35 | PARTIAL | **IMPLEMENTED-UNVERIFIED** | Each use case maps to a named regression test that the CI suite ru |
| W5-R36 | MISSING | **PARTIAL** | CI failure triggers an automatic rollback of the deployed agent. |
| W5-R29 | PARTIAL | **VERIFIED** | A measured (not projected) cost per graph run is documented in FLE |
| W5-R46 | PARTIAL | **VERIFIED** | CHANGES.md at repo root has an entry per significant addition with |
| W5-R47 | PARTIAL | **VERIFIED** | Actual Claude spend is reported split by input and output tokens. |
| W5-R48 | PARTIAL | **VERIFIED** | A measured invocation count is reported. |
| W5-R49 | PARTIAL | **VERIFIED** | Total development spend is reported. |

Two further rows kept `PARTIAL` while their **reason changed materially** — progress, not stasis:

- **W5-R43** — baseline: *the LLM call has no timeout or retry at all*. That is fully closed. It stays `PARTIAL` only because the per-call bound is not composable with the handler's deadline or cancellation signal (TRO-379).
- **W5-R45** — the documented-retry half is closed by the new Outbound Call Resilience section; the remaining gap is only the missing record that the Architecture Defense demonstration happened.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| W5-R1 | A chat surface exists inside Ship's document/issue/sprint views an | — | web/src/pages/App.tsx:679; web/src/components/AgentChatPanel.tsx:332 | IMPLEMENTED-UNVERIFIED |
| W5-R2 | The chat's request payload carries the specific entity being viewe | — | agent/src/graph.ts:1387; e2e/agent-chat-grounded-response.spec.ts:82 | IMPLEMENTED-UNVERIFIED |
| W5-R3 | No standalone chat page exists as the primary interaction; chat is | — | web/src/main.tsx:153; web/src/pages/App.tsx:679 | IMPLEMENTED-UNVERIFIED |
| W5-R4 | Both a proactive (unattended) path and an on-demand (user-invoked) | — | agent/src/graph.ts:1939; agent/src/proactivePoll.ts:48 | IMPLEMENTED-UNVERIFIED |
| W5-R5 | The proactive path runs unattended and delivers a finding to a use | — | agent/src/index.ts:230; api/src/routes/agent.ts:358 | IMPLEMENTED-UNVERIFIED |
| W5-R6 | One graph definition serves both triggers; the trigger differs, th | — | agent/src/graph.ts:1327; agent/src/index.ts:222 | IMPLEMENTED-UNVERIFIED |
| W5-R12 | The proactive trigger fires with no session and no browser open. | — | agent/src/proactivePoll.ts:41; agent/src/index.ts:238 | IMPLEMENTED-UNVERIFIED |
| W5-R21 | The deployed agent reads a real Ship instance, not fixtures. | — | terraform/render/agent_service.tf:64; FLEETGRAPH.MD:548 | IMPLEMENTED-UNVERIFIED |
| W5-R22 | Both the chat surface and a notification surface are reachable fro | — | web/src/pages/App.tsx:679; web/src/components/InboxSidebar.tsx:92 | IMPLEMENTED-UNVERIFIED |
| W5-R57 | Restates W5-R1/W5-R3 as a hard constraint: no standalone chatbot r | — | web/src/main.tsx:153; web/src/components/AgentChatPanel.tsx:13 | IMPLEMENTED-UNVERIFIED |
| W5-R7 | FLEETGRAPH.md contains an Agent Responsibility section defining th | — | FLEETGRAPH.MD:23; FLEETGRAPH.MD:44 | IMPLEMENTED-UNVERIFIED |
| W5-R8 | The Agent Responsibility section answers what is monitored proacti | — | FLEETGRAPH.MD:46; FLEETGRAPH.MD:52 | IMPLEMENTED-UNVERIFIED |
| W5-R9 | The Agent Responsibility section names the actions taken without a | TRO-370 | FLEETGRAPH.MD:90; agent/src/shipClient.ts:511 | IMPLEMENTED-UNVERIFIED |
| W5-R10 | The Agent Responsibility section names the actions that always req | — | FLEETGRAPH.MD:103; agent/src/gate.ts:105 | IMPLEMENTED-UNVERIFIED |
| W5-R11 | The agent resolves project membership and role from Ship data, and | TRO-370, TRO-342 | FLEETGRAPH.MD:179; agent/src/roles.ts:1 | IMPLEMENTED-UNVERIFIED |
| W5-R13 | FLEETGRAPH.md's Trigger Model section states the poll/webhook/hybr | — | FLEETGRAPH.MD:440; FLEETGRAPH.MD:486 | IMPLEMENTED-UNVERIFIED |
| W5-R18 | FLEETGRAPH.md has both sections filled and the Use Cases table has | — | FLEETGRAPH.MD:402; FLEETGRAPH.MD:431 | IMPLEMENTED-UNVERIFIED |
| W5-R19 | FLEETGRAPH.md documents node types, edges and branch conditions, a | — | FLEETGRAPH.MD:191; agent/src/graph.ts:1239 | IMPLEMENTED-UNVERIFIED |
| W5-R26 | FLEETGRAPH.md's Trigger Model section is present and argued, not m | — | FLEETGRAPH.MD:440; FLEETGRAPH.MD:486 | IMPLEMENTED-UNVERIFIED |
| W5-R37 | FLEETGRAPH.md states what triggers rollback and the procedure. | TRO-367 | FLEETGRAPH.MD:972; FLEETGRAPH.MD:1060 | IMPLEMENTED-UNVERIFIED |
| W5-R52 | All seven named sections exist and are filled in FLEETGRAPH.md. | — | FLEETGRAPH.MD:23; FLEETGRAPH.MD:191 | IMPLEMENTED-UNVERIFIED |
| W5-R53 | FLEETGRAPH.md carries a graph diagram covering both modes with all | — | FLEETGRAPH.MD:225; agent/src/graph.ts:1939 | IMPLEMENTED-UNVERIFIED |
| W5-R54 | FLEETGRAPH.md's Architecture Decisions section covers framework ch | — | FLEETGRAPH.MD:783; FLEETGRAPH.MD:796 | IMPLEMENTED-UNVERIFIED |
| W5-R14 | Trace links are recorded in the submitted deliverable files. | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R15 | At least two submitted traces show materially different node paths | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R16 | One proactive detection runs from trigger through graph to a deliv | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R17 | Tracing is configured and two differing trace links are submitted. | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R20 | At least one agent action is blocked pending explicit human approv | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R31 | Every use case has a corresponding test case entry. | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R32 | Each test case names the concrete Ship state that triggers it. | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R33 | Each test case carries a trace link from a real run against its st | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R34 | The test-case table lives in FLEETGRAPH.md, not elsewhere. | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R55 | Either LangGraph is used, or equivalent manual instrumentation exi | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R56 | Tracing is wired into the agent's runtime path, not added only for | — | FLEETGRAPH.MD:569 | IMPLEMENTED-UNVERIFIED |
| W5-R23 | terraform/ declares the agent service with env config and no commi | — | terraform/render/agent_service.tf:13; terraform/render/variables.tf:236 | VERIFIED |
| W5-R24 | A saved, annotated terraform plan output for the agent deployment  | — | terraform/render/plan/tro-316-agent-plan-annotated.md:262; terraform/render/plan/tro-316-agent-plan-annotated.md:277 | IMPLEMENTED-UNVERIFIED |
| W5-R25 | A documented destroy + re-apply cycle succeeded from Terraform alo | — | terraform/render/plan/tro-316-destroy-redeploy-proof.md:1; terraform/render/plan/tro-316-destroy-redeploy-proof.md:108 | IMPLEMENTED-UNVERIFIED |
| W5-R27 | Measured latency from event creation to agent surfacing is under 5 | — | FLEETGRAPH.MD:554; FLEETGRAPH.MD:559 | IMPLEMENTED-UNVERIFIED |
| W5-R28 | The timed test is reproducible by a grader, not only by us. | — | FLEETGRAPH.MD:527; e2e/agent-detection-latency.spec.ts:128 | IMPLEMENTED-UNVERIFIED |
| W5-R35 | Each use case maps to a named regression test that the CI suite ru | TRO-369 | .gitlab-ci.yml:92; agent/src/__tests__/gitlabCiAgentTests.test.ts:1 | IMPLEMENTED-UNVERIFIED |
| W5-R36 | CI failure triggers an automatic rollback of the deployed agent. | TRO-367 | .github/workflows/agent-rollback-check.yml:1; .github/workflows/agent-rollback-check.yml:18 | PARTIAL |
| W5-R38 | E2E specs exist for both modes. | — | e2e/agent-detection-latency.spec.ts:31; e2e/agent-chat-grounded-response.spec.ts:27 | IMPLEMENTED-UNVERIFIED |
| W5-R39 | An E2E test introduces an event and asserts the agent surfaces it  | — | e2e/agent-detection-latency.spec.ts:46; e2e/agent-detection-latency.spec.ts:128 | IMPLEMENTED-UNVERIFIED |
| W5-R40 | An E2E test drives the in-context chat and asserts the answer is g | — | e2e/agent-chat-grounded-response.spec.ts:82; e2e/agent-chat-grounded-response.spec.ts:96 | IMPLEMENTED-UNVERIFIED |
| W5-R41 | Both E2E specs execute in a CI job, not merely exist. | — | .github/workflows/ci.yml:293; .gitlab-ci.yml:148 | IMPLEMENTED-UNVERIFIED |
| W5-R42 | No test performs a live Ship or LLM call; all use fakes or recorde | — | agent/src/scripts/e2e-server.ts:61; e2e/fixtures/agentEnv.ts:418 | IMPLEMENTED-UNVERIFIED |
| W5-R43 | Every outbound call path sets a timeout and retries with exponenti | TRO-368, TRO-379 | agent/src/config.ts:137; agent/src/config.ts:189 | PARTIAL |
| W5-R44 | With Ship unreachable the agent returns/degrades rather than crash | — | agent/src/health.ts:33; agent/src/resilientClient.ts:77 | IMPLEMENTED-UNVERIFIED |
| W5-R29 | A measured (not projected) cost per graph run is documented in FLE | TRO-366, TRO-373 | FLEETGRAPH.MD:1338; FLEETGRAPH.MD:1350 | VERIFIED |
| W5-R30 | An estimated runs-per-day figure is documented and defended in FLE | — | FLEETGRAPH.MD:1449; FLEETGRAPH.MD:1470 | IMPLEMENTED-UNVERIFIED |
| W5-R45 | FLEETGRAPH.md documents retry/fallback; the Architecture Defense d | TRO-368 | FLEETGRAPH.MD:1210; FLEETGRAPH.MD:1220 | PARTIAL |
| W5-R46 | CHANGES.md at repo root has an entry per significant addition with | TRO-371 | CHANGES.md:794; CHANGES.md:3025 | VERIFIED |
| W5-R47 | Actual Claude spend is reported split by input and output tokens. | TRO-366, TRO-373 | FLEETGRAPH.MD:1357; agent/src/__tests__/fleetgraphCostFigures.test.ts:118 | VERIFIED |
| W5-R48 | A measured invocation count is reported. | TRO-366, TRO-373 | FLEETGRAPH.MD:1357; FLEETGRAPH.MD:1372 | VERIFIED |
| W5-R49 | Total development spend is reported. | TRO-366, TRO-373 | FLEETGRAPH.MD:1357 | VERIFIED |
| W5-R50 | Monthly cost projections are given for 100 / 1,000 / 10,000 users. | — | FLEETGRAPH.MD:1452; FLEETGRAPH.MD:1457 | IMPLEMENTED-UNVERIFIED |
| W5-R51 | PRESEARCH.md exists at the repo root with the pre-search checklist | — | PRESEARCH.MD:73; PRESEARCH.MD:516 | IMPLEMENTED-UNVERIFIED |

## Gaps

### W5-R36 — PARTIAL
- **What is missing:** Ruling I-03 applies: readiness polling does not satisfy the literal 'CI failure triggers rollback' wording. Substantial real progress from MISSING, but two gaps keep it PARTIAL.
- **Suggested scope:** Two independent gaps. (1) SEMANTIC: nothing rolls back because a CI job failed — CI failure only blocks merge. A literal fix adds a workflow_run/post-deploy step that fires rollback on a failed CI run against a deployed commit. (2) EVIDENTIARY: as of 2026-08-09 13:48 UTC the workflow has never executed its real step — its last scheduled run (12:56) predates the secrets (13:38) and logged configured=false. Gap 2 closes on the next tick; gap 1 needs new work.

### W5-R43 — PARTIAL
- **What is missing:** Label unchanged but the REASON is entirely different — do not read as 'nothing happened'. Baseline's PARTIAL was 'the LLM call has no timeout/retry at all'; that is fully closed. It stays PARTIAL only because of a narrower, independently filed follow-up (TRO-379): the timeout exists per-call but is not composable with the handler's deadline or its cancellation signal.
- **Suggested scope:** Tracked as TRO-379: derive each attempt's timeout from the deadline remaining at call time; propagate the handler's AbortSignal into the ChatAnthropic call; validate at startup that worst-case model time plus a stated pre-model-work allowance fits inside chatHandlerTimeoutMs. Done when an integration test delays pre-model work and asserts no Anthropic request survives the handler timeout.

### W5-R45 — PARTIAL
- **What is missing:** Half of baseline's two-part gap is closed. The other half is unchanged: no record anywhere that the Architecture Defense's graceful-degradation demonstration occurred (grep for defense/defend across FLEETGRAPH.MD returns zero; memory-bank has no entry past 2026-08-07).
- **Suggested scope:** Add one dated note (FLEETGRAPH.MD or memory-bank) recording when the Architecture Defense was held and that the degradation demo was shown, or attach a transcript/recording artifact. This is the only element still missing.

## Orphan tickets

- **TRO-372** "W5 sweep's section detector miscounts CHANGES.md" — audit-tooling defect; maps to no W5 requirement
- **TRO-375** "W5 sweep artifacts carry W4 labels and stale verdicts" — audit-tooling defect; maps to no W5 requirement
- **TRO-376** "Preflight/role skills still claim 13 expected web failures" — factory tooling; maps to no W5 requirement
- **TRO-377** "gate.sh needs a vacuous-assertion check" — factory tooling; maps to no W5 requirement
- **TRO-378** "Block git stash in factory worktrees" — factory tooling; maps to no W5 requirement
- **TRO-380** "programWeeksNav flake fails CI on unrelated PRs" — test-infrastructure defect; bears on CI reliability generally, no specific W5 requirement
- **TRO-374** "resilientClient.ts docstring claims model-provider coverage it lacks" — code-comment accuracy; adjacent to W5-R43/R45 but not itself a requirement

Seven tickets, all filed by this sprint's own factory run against its tooling, audit machinery, or test infrastructure. A requirements sweep correctly reports them as mapping to no product requirement.

## Blocked / assumed

No `BLOCKED` or `ASSUMED` rows. Two ambiguities surfaced and both were ruled by the maintainer rather than assumed — recorded permanently as **I-02** (cost-figure reproducibility) and **I-03** (CI-failure vs readiness trigger) in `interpretations.md`.

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `pnpm type-check` | exit 0 — all packages clean | W5-R43, W5-R55 |
| `pnpm test  (api + web + agent)` | exit 0 — 193 test files, 0 failures (api 79, web 79, agent 35) | W5-R35, W5-R38, W5-R42, W5-R46 |
| `curl -s https://ship-agent-t0zy.onrender.com/health and /ready` | HTTP 200 / HTTP 200 at 2026-08-09T13:48:12Z | W5-R5, W5-R21, W5-R23 |
| `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` | 7 invocations, 1,860 in / 839 out, $0.006055 — matches FLEETGRAPH.MD exactly | W5-R29, W5-R47, W5-R48, W5-R49 |
| `standalone replica of web/src/lib/changesLogSections.test.ts regex logic vs CHANGES.md` | 153 entries — 0 missing rollback, 0 missing run/test, 0 missing description | W5-R46 |
| `terraform plan / terraform apply / terraform destroy` | NOT RUN | W5-R24, W5-R25 |
| `GitLab pipeline verification for the agent suite` | NOT RUN | W5-R35, W5-R41 |

**W5-R23** — `curl -s -o /dev/null -w '%{http_code}' https://ship-agent-t0zy.onrender.com/health ; .../ready`
> 2026-08-09T13:48:12Z — /health -> HTTP 200 in 0.151s {"status":"ok"}; /ready -> HTTP 200 in 0.344s {"status":"ready"}

**W5-R36** — `gh secret list --repo troysatchell/ship ; gh run list --workflow=agent-rollback-check.yml`
> Both secrets set 2026-08-09T13:38Z. Latest scheduled run 31314520420 created 12:56:01Z (BEFORE secrets) logged 'configured=false' / '::warning:: Skipping the readiness check'. Zero real executions to date.

**W5-R29** — `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl`
> Ledger: cost-ledger-snapshot.jsonl | Invocations: 7 | Input tokens: 1860 | Output tokens: 839 | Total spend: $0.006055 | composeAnswer 6 @ $0.000876 (avg 6.50 docs) | composeStandupDraft 1 @ $0.000798 — run against the TRACKED snapshot on main @ 3e4a76d, reproducing without the gitignored .cache ledger

**W5-R46** — `standalone replica of web/src/lib/changesLogSections.test.ts regex logic run against CHANGES.md (vitest not run — shared-DB constraint)`
> 153 top-level entries parsed; missing rollback = 0; missing run/test = 0; missing description = 0

**W5-R47** — `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl`
> Ledger: cost-ledger-snapshot.jsonl | Invocations: 7 | Input tokens: 1860 | Output tokens: 839 | Total spend: $0.006055 | composeAnswer 6 @ $0.000876 (avg 6.50 docs) | composeStandupDraft 1 @ $0.000798 — run against the TRACKED snapshot on main @ 3e4a76d, reproducing without the gitignored .cache ledger

**W5-R48** — `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl`
> Ledger: cost-ledger-snapshot.jsonl | Invocations: 7 | Input tokens: 1860 | Output tokens: 839 | Total spend: $0.006055 | composeAnswer 6 @ $0.000876 (avg 6.50 docs) | composeStandupDraft 1 @ $0.000798 — run against the TRACKED snapshot on main @ 3e4a76d, reproducing without the gitignored .cache ledger

**W5-R49** — `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts -- --ledger cost-ledger-snapshot.jsonl`
> Ledger: cost-ledger-snapshot.jsonl | Invocations: 7 | Input tokens: 1860 | Output tokens: 839 | Total spend: $0.006055 | composeAnswer 6 @ $0.000876 (avg 6.50 docs) | composeStandupDraft 1 @ $0.000798 — run against the TRACKED snapshot on main @ 3e4a76d, reproducing without the gitignored .cache ledger

