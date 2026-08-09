# Requirements Audit — Ship (GAUNTLET)

**Commit:** 85598041c438 (dirty tree) · **Date:** 2026-08-08T22:18:39Z · **Docs:** W4 `GFA_Week_4_ShipShape_Updated.pdf` (14 pp.; requirements p.2–11, orientation appendix p.12–13) · **Mode:** baseline

## Summary

- **VERIFIED:** 1
- **IMPLEMENTED-UNVERIFIED:** 45
- **PARTIAL:** 10
- **MISSING:** 1

All 57 active W5 requirements are represented below. 1 carries green behavioural evidence, 45 are traced to file:line without a behavioural check, and 11 fall short — 1 `MISSING`, 10 `PARTIAL`.

**The findings a reader must act on, worst first:**

- **W5-R36** (`MISSING`) — Wire check-readiness-and-rollback.ts --execute into an automatic trigger (a scheduled job or a CI post-deploy step) so a sustained CI/deploy failure actually redeploys the previous known-good commit without a human running the CLI by hand — this is explicit...
- **W5-R9** (`PARTIAL`) — Either implement the second "acts" bullet ("linking a document to the issue or week it refers to, when the reference is unambiguous" — a query-proved association write) as a graph node, or add the same explicit not-yet-built caveat this file already applies...
- **W5-R11** (`PARTIAL`) — Either implement the Director/PM/Engineer role derivation the table describes (a function analogous to roles.ts's existing manager-chain walk, deriving role from reporting-depth/ownership as tabulated) or narrow this section's claim to what's built (project...
- **W5-R29** (`PARTIAL`) — Re-run `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` and paste its current output into FLEETGRAPH.MD's per-tier cost table.
- **W5-R35** (`PARTIAL`) — Add a `pnpm --filter @ship/agent test` invocation (with DATABASE_URL/NODE_ENV=test, mirroring .github/workflows/ci.yml lines 131-135) to .gitlab-ci.yml's `verify` job, so the same 6-use-case regression coverage that already runs on GitHub Actions also runs...
- **W5-R43** (`PARTIAL`) — Route the ChatAnthropic call in agent/src/index.ts through the same explicit-timeout + exponential-backoff discipline ResilientClient already gives Ship API calls — either pass ChatAnthropic's own `timeout`/`maxRetries` constructor options explicitly (docum...
- …and 5 further `PARTIAL` row(s); all of them, with the smallest change that would close each, are in the Gaps section below and in `gaps-W5.md`.

## Coverage and limitations

What this sweep did and did not check. Read this before treating any row below as proof.

- **The e2e suite never ran.** `pnpm test:e2e` was not executed this sweep (600+ Playwright tests requiring the `/e2e-test-runner` protocol and Docker). W4-R21, W4-R36 and W4-R37 lean on suites that were traced but not executed: their evidence is the specs' existence and prior recorded runs, not a live result. No claim is made about the e2e suite in either direction.
- **Ticket mapping ran against live Linear data.** Scope: The 123 issues in Linear project "ShipShape Audit Remediation" (TRO-164..249, TRO-276..311, TRO-354). Scoped by project, not by number range: the TRO team is a personal catch-all spanning six projects, and the Ship numbers are interleaved with them — TRO-250..275 belong to Clavira Pilot Readiness and TRO-312..365 mostly to FleetGraph (Week 5, same repo, different assignment). Sweeping the whole team would report ~200 false orphans from work this brief never covered. 3 of 57 requirements have no ticket covering them and 11 in-scope tickets map to no requirement; both lists are below. A requirement without a ticket is not necessarily unfinished — much of this brief is process work that was done without being ticketed.
- **This sweep wrote to the developer's database, which a read-only audit should not have done.** W4-R13's `VERIFIED` excerpt came from `pnpm db:seed && npx tsx audit/seed-augment.ts` run against the working database `ship_standup` rather than a throwaway one. `pnpm test` (W4-R10, W4-R35) then ran with that same `DATABASE_URL` exported, and `api/src/test/setup.ts:93-98` `TRUNCATE`s 15 tables — including `documents`, `users` and `workspaces` — in every api test file's `beforeAll`. So the audit reseeded the database and then destroyed it. It was re-seeded afterwards and is back at 500 documents / 255 issues / 20 users / 35 sprints, but the state behind W4-R13's excerpt no longer exists in that exact form; the excerpt is a true record of what was observed, not something re-runnable today.
- **45 of 57 rows are `IMPLEMENTED-UNVERIFIED`** — statically traced to file:line with no behavioral check run against them. 1 rows are `VERIFIED` on captured command output. 0 rows rest on a recorded interpretation ruling rather than on the requirement text alone; none is left un-ruled. Every command that did run this sweep is listed under "Verification performed" at the end of this report.
- **The swept tree was dirty** — 21 path(s) did not match commit `85598041c438`. None of them is cited as evidence by any row. The rest are this sweep's own in-flight output and unrelated working files; the full list is `dirty_paths` in `matrix.baseline.json`. Where volatility made a citation unusable (W4-R35, `memory-bank/activeContext.md`) it was dropped and the claim moved into that row's notes with the reason.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| W5-R1 | A chat surface exists inside Ship's document/issue/sprint views and receive... | TRO-318, TRO-320, TRO-328, TRO-363 | `web/src/pages/App.tsx:679`<br>`web/src/pages/App.tsx:237`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R2 | The chat's request payload carries the specific entity being viewed, and th... | TRO-318, TRO-320, TRO-363 | `web/src/components/AgentChatPanel.tsx:331`<br>`agent/src/graph.ts:1298`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R3 | No standalone chat page exists as the primary interaction; chat is reachabl... | TRO-320 | `web/src/main.tsx:153`<br>`web/src/main.tsx:234`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R4 | Both a proactive (unattended) path and an on-demand (user-invoked) path exi... | TRO-317, TRO-318, TRO-327 | `agent/src/graph.ts:1850`<br>`agent/src/server.ts:316`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R5 | The proactive path runs unattended and delivers a finding to a user-visible... | TRO-312, TRO-317, TRO-325 | `agent/src/index.ts:221`<br>`agent/src/graph.ts:1274`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R6 | One graph definition serves both triggers; the trigger differs, the graph d... | TRO-313, TRO-317, TRO-318, TRO-327 | `agent/src/graph.ts:1231`<br>`agent/src/graph.ts:1850`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R7 | FLEETGRAPH.md contains an Agent Responsibility section defining the agent's... | — | `FLEETGRAPH.MD:23`<br>`FLEETGRAPH.MD:25`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R8 | The Agent Responsibility section answers what is monitored proactively. | — | `FLEETGRAPH.MD:46`<br>`FLEETGRAPH.MD:52`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R9 | The Agent Responsibility section names the actions taken without approval. | TRO-321 | `FLEETGRAPH.MD:82`<br>`FLEETGRAPH.MD:87`<br>+4 more | `PARTIAL` |
| W5-R10 | The Agent Responsibility section names the actions that always require conf... | TRO-321 | `FLEETGRAPH.MD:94`<br>`FLEETGRAPH.MD:97`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R11 | The agent resolves project membership and role from Ship data, and the mech... | TRO-317 | `FLEETGRAPH.MD:151`<br>`agent/src/blockerFanout.ts:88`<br>+4 more | `PARTIAL` |
| W5-R12 | The proactive trigger fires with no session and no browser open. | TRO-312, TRO-313 | `agent/src/proactivePoll.ts:41`<br>`agent/src/index.ts:229`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R13 | FLEETGRAPH.md's Trigger Model section states the poll/webhook/hybrid choice... | TRO-351 | `FLEETGRAPH.MD:420`<br>`FLEETGRAPH.MD:453`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R14 | Trace links are recorded in the submitted deliverable files. | TRO-324, TRO-331, TRO-356 | `FLEETGRAPH.MD:333`<br>`FLEETGRAPH.MD:335`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R15 | At least two submitted traces show materially different node paths. | TRO-318, TRO-324, TRO-356 | `FLEETGRAPH.MD:335`<br>`FLEETGRAPH.MD:336`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R16 | One proactive detection runs from trigger through graph to a delivered result. | TRO-312, TRO-317, TRO-323, TRO-325, TRO-327 | `agent/src/graph.ts:1245`<br>`agent/src/index.ts:190`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R17 | Tracing is configured and two differing trace links are submitted. | TRO-313, TRO-324, TRO-326 | `agent/src/config.ts:18`<br>`agent/src/config.ts:99`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R18 | FLEETGRAPH.md has both sections filled and the Use Cases table has >= 5 rows. | TRO-351 | `FLEETGRAPH.MD:23`<br>`FLEETGRAPH.MD:382`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R19 | FLEETGRAPH.md documents node types, edges and branch conditions, and matche... | TRO-324, TRO-349, TRO-351 | `FLEETGRAPH.MD:175`<br>`agent/src/graph.ts:1239`<br>+6 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R20 | At least one agent action is blocked pending explicit human approval, in code. | TRO-321, TRO-348, TRO-352, TRO-353 | `agent/src/gate.ts:105`<br>`agent/src/__tests__/graphWriteBoundary.test.ts:148`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R21 | The deployed agent reads a real Ship instance, not fixtures. | TRO-341, TRO-347, TRO-358 | `terraform/render/agent_service.tf:64`<br>`agent/src/config.ts:97`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R22 | Both the chat surface and a notification surface are reachable from Ship's UI. | TRO-320, TRO-323, TRO-353, TRO-362, TRO-363 | `web/src/pages/App.tsx:679`<br>`web/src/pages/App.tsx:447`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R23 | terraform/ declares the agent service with env config and no committed secr... | TRO-313, TRO-316, TRO-326, TRO-347 | `terraform/render/agent_service.tf:13`<br>`terraform/render/agent_service.tf:89`<br>+4 more | `VERIFIED` |
| W5-R24 | A saved, annotated terraform plan output for the agent deployment exists. | — | `terraform/render/plan/tro-316-agent-plan-annotated.md:1`<br>`terraform/render/plan/tro-316-agent-plan-annotated.md:96`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R25 | A documented destroy + re-apply cycle succeeded from Terraform alone. | TRO-316, TRO-326, TRO-347 | `terraform/render/plan/tro-316-destroy-redeploy-proof.md:1`<br>`terraform/render/plan/tro-316-destroy-redeploy-proof.md:70`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R26 | FLEETGRAPH.md's Trigger Model section is present and argued, not merely sta... | TRO-351 | `FLEETGRAPH.MD:420`<br>`FLEETGRAPH.MD:453`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R27 | Measured latency from event creation to agent surfacing is under 5 minutes. | TRO-317, TRO-324, TRO-341 | `FLEETGRAPH.MD:528`<br>`FLEETGRAPH.MD:534`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R28 | The timed test is reproducible by a grader, not only by us. | TRO-317, TRO-324, TRO-341 | `FLEETGRAPH.MD:507`<br>`FLEETGRAPH.MD:516`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R29 | A measured (not projected) cost per graph run is documented in FLEETGRAPH.md. | TRO-324, TRO-331, TRO-339 | `FLEETGRAPH.MD:1162`<br>`FLEETGRAPH.MD:1175`<br>+3 more | `PARTIAL` |
| W5-R30 | An estimated runs-per-day figure is documented and defended in FLEETGRAPH.md. | TRO-324, TRO-331, TRO-339 | `FLEETGRAPH.MD:1227`<br>`FLEETGRAPH.MD:1307`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R31 | Every use case has a corresponding test case entry. | TRO-331, TRO-340, TRO-345, TRO-346, TRO-356 | `FLEETGRAPH.MD:386`<br>`FLEETGRAPH.MD:707` | `IMPLEMENTED-UNVERIFIED` |
| W5-R32 | Each test case names the concrete Ship state that triggers it. | TRO-314, TRO-340, TRO-341, TRO-345, TRO-357 | `FLEETGRAPH.MD:709`<br>`FLEETGRAPH.MD:710`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R33 | Each test case carries a trace link from a real run against its state. | TRO-340, TRO-345, TRO-346, TRO-356 | `FLEETGRAPH.MD:709`<br>`FLEETGRAPH.MD:710`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R34 | The test-case table lives in FLEETGRAPH.md, not elsewhere. | TRO-331, TRO-340, TRO-356 | `FLEETGRAPH.MD:549`<br>`FLEETGRAPH.MD:707` | `IMPLEMENTED-UNVERIFIED` |
| W5-R35 | Each use case maps to a named regression test that the CI suite runs. | TRO-322, TRO-330, TRO-346 | `FLEETGRAPH.MD:388`<br>`agent/src/__tests__/standupDraft.test.ts:116`<br>+18 more | `PARTIAL` |
| W5-R36 | CI failure triggers an automatic rollback of the deployed agent. | TRO-322, TRO-330 | `agent/src/scripts/check-readiness-and-rollback.ts:11`<br>`agent/src/scripts/check-readiness-and-rollback.ts:178`<br>+4 more | `MISSING` |
| W5-R37 | FLEETGRAPH.md states what triggers rollback and the procedure. | TRO-322, TRO-330 | `FLEETGRAPH.MD:942`<br>`FLEETGRAPH.MD:943`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R38 | E2E specs exist for both modes. | TRO-322, TRO-330, TRO-359 | `e2e/agent-detection-latency.spec.ts:31`<br>`e2e/agent-chat-grounded-response.spec.ts:27` | `IMPLEMENTED-UNVERIFIED` |
| W5-R39 | An E2E test introduces an event and asserts the agent surfaces it inside th... | TRO-322, TRO-330, TRO-359 | `e2e/agent-detection-latency.spec.ts:46`<br>`e2e/agent-detection-latency.spec.ts:87`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R40 | An E2E test drives the in-context chat and asserts the answer is grounded i... | TRO-322, TRO-330, TRO-359 | `e2e/agent-chat-grounded-response.spec.ts:40`<br>`e2e/agent-chat-grounded-response.spec.ts:52`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R41 | Both E2E specs execute in a CI job, not merely exist. | TRO-322, TRO-330, TRO-359 | `.github/workflows/ci.yml:290`<br>`.gitlab-ci.yml:134` | `IMPLEMENTED-UNVERIFIED` |
| W5-R42 | No test performs a live Ship or LLM call; all use fakes or recorded fixtures. | TRO-318, TRO-319, TRO-322, TRO-330 | `agent/src/scripts/e2e-server.ts:61`<br>`e2e/fixtures/agentEnv.ts:418`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R43 | Every outbound call path sets a timeout and retries with exponential backoff. | TRO-315, TRO-326 | `agent/src/resilientClient.ts:168`<br>`agent/src/resilientClient.ts:226`<br>+5 more | `PARTIAL` |
| W5-R44 | With Ship unreachable the agent returns/degrades rather than crashing or ha... | TRO-315, TRO-326 | `agent/src/health.ts:33`<br>`agent/src/resilientClient.ts:77`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R45 | FLEETGRAPH.md documents retry/fallback; the Architecture Defense demonstrat... | TRO-315 | `FLEETGRAPH.MD:942`<br>`FLEETGRAPH.MD:477`<br>+1 more | `PARTIAL` |
| W5-R46 | CHANGES.md at repo root has an entry per significant addition with run/test... | TRO-325, TRO-326, TRO-327, TRO-328, TRO-329, TRO-330, TRO-331 | `CHANGES.md:1`<br>`CHANGES.md:2292`<br>+3 more | `PARTIAL` |
| W5-R47 | Actual Claude spend is reported split by input and output tokens. | TRO-331, TRO-339 | `FLEETGRAPH.MD:1162`<br>`FLEETGRAPH.MD:1168`<br>+3 more | `PARTIAL` |
| W5-R48 | A measured invocation count is reported. | TRO-331, TRO-339 | `FLEETGRAPH.MD:1172`<br>`FLEETGRAPH.MD:1216`<br>+2 more | `PARTIAL` |
| W5-R49 | Total development spend is reported. | TRO-331, TRO-339 | `FLEETGRAPH.MD:1173`<br>`FLEETGRAPH.MD:1216`<br>+1 more | `PARTIAL` |
| W5-R50 | Monthly cost projections are given for 100 / 1,000 / 10,000 users. | TRO-331 | `FLEETGRAPH.MD:1301`<br>`FLEETGRAPH.MD:1303`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R51 | PRESEARCH.md exists at the repo root with the pre-search checklist completed. | TRO-360 | `PRESEARCH.MD:6`<br>`PRESEARCH.MD:73`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R52 | All seven named sections exist and are filled in FLEETGRAPH.md. | TRO-324, TRO-331, TRO-340, TRO-349, TRO-351 | `FLEETGRAPH.MD:23`<br>`FLEETGRAPH.MD:175`<br>+5 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R53 | FLEETGRAPH.md carries a graph diagram covering both modes with all nodes, e... | TRO-324, TRO-331, TRO-349 | `FLEETGRAPH.MD:205`<br>`agent/src/graph.ts:1239`<br>+2 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R54 | FLEETGRAPH.md's Architecture Decisions section covers framework choice, nod... | TRO-313, TRO-340, TRO-342, TRO-350 | `FLEETGRAPH.MD:763`<br>`FLEETGRAPH.MD:767`<br>+4 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R55 | Either LangGraph is used, or equivalent manual instrumentation exists. | TRO-313, TRO-326 | `agent/src/graph.ts:387`<br>`agent/src/graph.ts:1238`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R56 | Tracing is wired into the agent's runtime path, not added only for submission. | TRO-313, TRO-326 | `agent/src/index.ts:5`<br>`agent/src/index.ts:83`<br>+3 more | `IMPLEMENTED-UNVERIFIED` |
| W5-R57 | Restates W5-R1/W5-R3 as a hard constraint: no standalone chatbot route exists. | TRO-320, TRO-328 | `web/src/main.tsx:153`<br>`web/src/components/AgentChatPanel.tsx:13`<br>+1 more | `IMPLEMENTED-UNVERIFIED` |

## Gaps

### W5-R9 — `PARTIAL`
- **Requirement:** The Agent Responsibility section names the actions taken without approval.
- **Partial evidence:** `FLEETGRAPH.MD:82`, `FLEETGRAPH.MD:87`, `agent/src/graph.ts:1258`
- **Missing:** 3 of the 4 named autonomous actions (mention resolution, writing own drafts/items, clearing own items) are implemented and verified to stay outside the gate, matching the doc. The 4th — "linking a document to the issue or week it refers to, when the reference is unambiguous" — has no implementation anywhere in agent/src (grep for link/createAssociation/postAssociation/unambiguous across the whole directory found nothing but an unrelated docstring use of the word "unambiguous"). Unlike other undone work in this document (Graph Diagram Note 1, Use Case 5's notes), this gap is not flagged as aspirational where it is stated.

### W5-R11 — `PARTIAL`
- **Requirement:** The agent resolves project membership and role from Ship data, and the mech...
- **Partial evidence:** `FLEETGRAPH.MD:151`, `agent/src/blockerFanout.ts:88`, `agent/src/roles.ts:1`
- **Missing:** Two gaps, not one. (1) Project membership lookup is real code (blockerFanout.ts's getAssociations(issueId,'project')), but the Director/PM/Engineer role-derivation table is documentation only — roles.ts's own docstring admits the taxonomy is unimplemented. (2) The earlier-flagged single-shared-token concern is confirmed still true, but only partially: TRO-342 fixed the on-demand path to use each asker's own token (graph.ts:1048-1057, requireAskingUserToken), but the proactive/steady/deep tiers — the paths that actually do the continuous project/people scanning this requirement is about — still run under one shared admin-minted token (index.ts:173-183) by explicit, intentional design. FLEETGRAPH.MD's blanket "no service account... nothing you could not [reach]" claim (line 817-821) does not carry this per-tier distinction, and it is not disclosed at all in the section that answers W5-R11 (lines 151-172).

### W5-R29 — `PARTIAL`
- **Requirement:** A measured (not projected) cost per graph run is documented in FLEETGRAPH.md.
- **Partial evidence:** `FLEETGRAPH.MD:1162`, `FLEETGRAPH.MD:1175`, `FLEETGRAPH.MD:1213`
- **Missing:** The figure is reported per-node/per-tier (respond vs. composeAnswer), not as one aggregate "cost per graph run" number — a defensible reading given the graph has multiple distinct paths (bare chat vs. expansion vs. standup draft) that genuinely cost different amounts, rather than a gap. Distinct from this, FLEETGRAPH.MD's "Production Cost Projections" section (line 1320) separately gives PROJECTED per-tier costs ($0.021/$0.015/$0.052/$0.065), explicitly under an "Assumptions" heading and never merged into the measured table above — this is exactly the measured-vs-projected separation the audit brief asks to check for, and it is done correctly here: the measured figures are labeled "not an estimate" and cross-checked against LangSmith; the projected figures are clearly scoped to "Production Cost Projections" > "Assumptions." The measured-cost METHOD is sound and correctly labelled 'not an estimate' — a real per-invocation ledger written by graph.ts's recordInvocation and cross-checked against LangSmith. The published FIGURES are stale. Controller re-ran the exact command FLEETGRAPH.MD cites as its own reproduction method (`pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts`) on 2026-08-08 and got composeAnswer $0.000876/run over 6 invocations and composeStandupDraft $0.000798/run over 1 invocation, against the document's $0.000852 and an explicit claim of zero composeStandupDraft invocations. Smallest fix: re-run the command and paste its current output.

### W5-R35 — `PARTIAL`
- **Requirement:** Each use case maps to a named regression test that the CI suite runs.
- **Partial evidence:** `FLEETGRAPH.MD:388`, `agent/src/__tests__/standupDraft.test.ts:116`, `agent/src/__tests__/graph.test.ts:689`
- **Missing:** Mapping itself is complete: all 6 FLEETGRAPH.MD use cases have a named, real regression test (0 uncovered). Missing: on GitLab CI — this repo's own .gitlab-ci.yml states GitLab is 'the actual submission target' — the agent package's unit-test suite (which holds every one of these regression tests) is never invoked; .gitlab-ci.yml only builds the agent package for its e2e-agent job, never runs `pnpm --filter @ship/agent test`. Only GitHub Actions currently executes this suite. `scripts/factory/gate.sh` also runs it (CHANGES.md:2253) but that is a local factory eval gate, not either platform's CI.

### W5-R36 — `MISSING`
- **Requirement:** CI failure triggers an automatic rollback of the deployed agent.
- **Partial evidence:** `agent/src/scripts/check-readiness-and-rollback.ts:11`, `agent/src/scripts/check-readiness-and-rollback.ts:178`, `FLEETGRAPH.MD:947`
- **Missing:** Nothing in the repo makes a CI failure automatically roll back the deployed agent. What exists instead: (1) CI gates merge, so a failing commit never reaches `main` and is therefore never deployed at all (prevention, not rollback of a live deployment) — the repo's own FLEETGRAPH.MD says so explicitly; (2) a corrective CLI (check-readiness-and-rollback.ts) that CAN redeploy a prior commit via the Render API, fully tested (deployReadiness.test.ts, check-readiness-and-rollback.test.ts) and proven by local simulation, but is dry-run by default and, per its own docstring, deliberately not wired to any automatic trigger against the live service.

### W5-R43 — `PARTIAL`
- **Requirement:** Every outbound call path sets a timeout and retries with exponential backoff.
- **Partial evidence:** `agent/src/resilientClient.ts:168`, `agent/src/resilientClient.ts:226`, `agent/src/resilientClient.ts:263`
- **Missing:** Ship API calls (via ResilientClient, shared by every ShipClient/GateShipClient instance in the package) fully satisfy this requirement: explicit timeoutMs, exponential backoff with jitter, and a circuit breaker on top. The LLM provider call (ChatAnthropic, agent/src/index.ts:162) has no explicit timeout or retry/backoff configured anywhere in this codebase — it relies entirely on whatever @langchain/anthropic's internal defaults are, which the requirement's own wording ('must implement explicit timeouts and retry logic') does not credit. There are no other external-tool outbound clients in the package.

### W5-R45 — `PARTIAL`
- **Requirement:** FLEETGRAPH.md documents retry/fallback; the Architecture Defense demonstrat...
- **Partial evidence:** `FLEETGRAPH.MD:942`, `FLEETGRAPH.MD:477`, `FLEETGRAPH.MD:1012`
- **Missing:** Missing two things. (1) FLEETGRAPH.MD's retry/fallback documentation is scattered across the Rollback and Reliability subsections and covers only Ship-reachability degradation — it never mentions that the LLM provider call has no explicit timeout/backoff (the W5-R43 gap), so the documentation is incomplete relative to what the code actually does. (2) 'a record of the defense demonstration': memory-bank/progress.md:369 (dated 2026-08-03) flags the Architecture Defense's graceful-degradation demo as an open, unresolved item at that time ('FG-4's graceful-degradation demo must exist by then'), and no later memory-bank or CHANGES.md entry records that the defense itself was actually held or that a demonstration record was captured — only the underlying local-simulation evidence (FLEETGRAPH.MD:1012-1019) exists, which is preparation for a defense, not a record that one occurred.

### W5-R46 — `PARTIAL`
- **Requirement:** CHANGES.md at repo root has an entry per significant addition with run/test...
- **Partial evidence:** `CHANGES.md:1`, `CHANGES.md:2292`, `CHANGES.md:2306`
- **Missing:** Of 144 top-level entries, 124 (~86%) carry a recognizable heading/instruction for both 'how to run and test it locally' and 'how to roll it back' (in addition to the narrative 'what was built' every entry has by construction). 13 entries have run/test instructions but no rollback section — confirming the trace-rules' expectation that rollback is the most-omitted element. 6 entries have a rollback section but no explicit run/test instructions. 1 entry ('Bundle TRO-330') has neither on its own, but it is an EPIC status rollup that explicitly defers to the two complete entries immediately following it, not an undocumented addition in its own right. This is a heuristic text-pattern count (bolded headings + inline pnpm/tsx/curl commands), not an exhaustive manual read of all 144 entries — a few borderline classifications are possible at the margins, but the overall proportions (large majority complete, rollback the more commonly missing element) should hold.

### W5-R47 — `PARTIAL`
- **Requirement:** Actual Claude spend is reported split by input and output tokens.
- **Partial evidence:** `FLEETGRAPH.MD:1162`, `FLEETGRAPH.MD:1168`, `FLEETGRAPH.MD:1210`
- **Missing:** The breakdown IS measured, not projected -- real methodology (cost-ledger.jsonl instrumentation, cross-reconciled against LangSmith's own usage API at FLEETGRAPH.MD:1175-1178). But it is stale, verified by actually running the script the document itself cites as its own reproduction method: current ledger totals are input=1,860 / output=839 tokens across 7 invocations / $0.006055 total, not the 567/271/3/$0.001922 the document's most current table reports. This is not an old-snapshot problem -- the ledger's newest entry (a real composeStandupDraft invocation, 2026-08-07T14:36:16.889Z) postdates the document's own 'Last updated: August 7, 2026' banner (FLEETGRAPH.MD:19), so the correct figures were available before the document's final state and were not folded in. Controller confirmed the staleness by direct re-run rather than inference. Reported: 3 invocations / 567 input / 271 output / $0.001922. Actual at HEAD: 7 invocations / 1,860 input / 839 output / $0.006055 — roughly 3x. The ledger's newest entry (agent/.cache/cost-ledger.jsonl, node=composeStandupDraft, timestamp 2026-08-07T14:36:16.889Z) postdates the document's own 'Last updated: August 7, 2026' banner, so this was available and unreconciled rather than a stale snapshot. Directly contradicts FLEETGRAPH.MD:1223's 'composeStandupDraft still has zero real invocations'.

### W5-R48 — `PARTIAL`
- **Requirement:** A measured invocation count is reported.
- **Partial evidence:** `FLEETGRAPH.MD:1172`, `FLEETGRAPH.MD:1216`, `FLEETGRAPH.MD:1223`
- **Missing:** A measured invocation count IS reported (methodology is real, not fabricated), but it under-counts by more than half: the ledger holds 7 records, not 3, and one of the missing 4 is the composeStandupDraft invocation the document explicitly and currently claims does not exist (line 1223). Verified live by re-running the exact script FLEETGRAPH.MD cites for this figure (see suggested_verification) -- this is not an inference from the file alone, the command was actually run and printed 'Invocations: 7'. Invocation count reported as 3; the ledger holds 7 (verified by the controller both by parsing agent/.cache/cost-ledger.jsonl directly and by re-running cost-report.ts). Same single fix as W5-R47.

### W5-R49 — `PARTIAL`
- **Requirement:** Total development spend is reported.
- **Partial evidence:** `FLEETGRAPH.MD:1173`, `FLEETGRAPH.MD:1216`, `agent/.cache/cost-ledger.jsonl:1`
- **Missing:** Total development spend is reported and the reporting method is genuinely measured (not a projection), but the figure is stale by more than 3x: the document's own most current number is $0.001922, while re-running the document's own cited reproduction command against the current ledger returns $0.006055. This was directly verified, not inferred -- the command was executed as part of this audit. Total development spend reported as $0.001922; re-run gives $0.006055. Same single fix as W5-R47 — the instrument is right, the transcription is old.

## Orphan tickets

11 in-scope tickets map to no W4 requirement. That is expected rather than alarming: the sprint did work this brief never asked for, and review follow-ups rarely trace to a requirement of their own. Listed so nothing is invisible.

| Ticket | Status | Title |
|---|---|---|
| TRO-332 | Done | [FG-14] A-blocks-B-blocks-A is insertable today — any graph traversal will loop forever |
| TRO-333 | Done | [FG-15] Ship cannot express "issue A blocks issue B" — it has a containment tree and an org chart but no dependency graph |
| TRO-334 | Done | [FG-16] A blocking relationship nobody can see or set is not a feature — blocks/blocked-by in the issue sidebar |
| TRO-335 | Done | [FG-17] At week's end someone reconstructs from memory what they delivered — Ship already holds the answer |
| TRO-336 | Done | [FG-18] The "plan changed after approval" flag trips on typo fixes, so managers ignore it — and a quiet scope cut looks identical |
| TRO-337 | Done | [FG-19] When one issue holds up work across reporting lines, no page in Ship joins the two — the use case only a graph can serve |
| TRO-338 | Done | [FG-20] Recorded model responses pin the output, so a prompt rewrite can break production while every test stays green |
| TRO-343 | Done | React Query cache is never cleared on login/logout/impersonation — cross-user data leakage on shared browsers |
| TRO-344 | Done | Circular-blocks error message is inferred from a bare 500, not a dedicated error code |
| TRO-355 | Backlog | No UI exists to add/delete table rows or columns — 4 e2e tests were silently vacuous, converted to test.fixme() |
| TRO-361 | Backlog | FG: auto_deploy on the graded Render services has silently failed 3 times — root-cause it or replace it with an explicit post-merge deploy step |

## Blocked / assumed

_No individually blocked requirements_ (the ticket dimension is blocked globally — see Summary).

## PM handoff

Config `pm_skill: ship-pm` resolved to `.claude/skills/ship-pm/SKILL.md` and the handoff ran actively: the gaps above were passed through that skill's scope gate. The resulting disposition per gap — what ships now, what is deferred with which condition, and what is an owner action rather than engineering work — is in [`pm-triage.md`](pm-triage.md). This audit opened no tickets and modified no application source; the triage is a judgement, not a work order.

## Verification performed

Every command run against this repo during the sweep, and its real result — including the ones whose results are asserted as fact in the rows above without producing a `VERIFIED` verdict, and the one suite that was deliberately not run. Anything not in this table was not executed.

| Command | Result | Bears on |
|---|---|---|
| `curl -sS https://ship-agent-t0zy.onrender.com/health` | HTTP 200 in 13.37s — {"status":"ok"}<br>_Live probe of the deployed agent, 2026-08-08. Long first-byte time is a free-tier cold start._ | W5-R23 |
| `curl -sS https://ship-agent-t0zy.onrender.com/ready` | HTTP 200 in 0.23s — {"status":"ready"} | W5-R23 |
| `pnpm --filter @ship/agent exec tsx src/scripts/cost-report.ts` | 7 invocations / 1,860 input / 839 output / $0.006055; composeAnswer 6 runs @ $0.000876, composeStandupDraft 1 run @ $0.000798<br>_The command FLEETGRAPH.MD names as its own reproduction method. Read-only. Its output contradicts the figures the document publishes._ | W5-R29, W5-R47, W5-R48, W5-R49 |
| `pnpm test / pnpm test:e2e (agent + e2e suites)` | NOT RUN<br>_Not executed this sweep. The e2e suite needs Docker and the /e2e-test-runner protocol, and the api suite TRUNCATEs whatever DATABASE_URL points at. Rows leaning on these are traced, not verified, and say so._ | W5-R35, W5-R38, W5-R39, W5-R40, W5-R41, W5-R42 |
| `timed detection-latency test` | NOT RUN<br>_Not re-run by this sweep. The repo records a 42.6s measurement against the deployed site (FLEETGRAPH.MD:539, commit 02f1bf0, 2026-08-07) and a CI-wired spec asserting the 5-minute bound; that is the evidence, and it is historical rather than freshly observed._ | W5-R27, W5-R28 |

Captured output for the 1 row(s) a command carried all the way to `VERIFIED`:

- **W5-R23** — `curl https://ship-agent-t0zy.onrender.com/health  and  /ready`

  ```
  /health -> HTTP 200 in 13.365544s  {"status":"ok"}
  /ready  -> HTTP 200 in 0.231733s  {"status":"ready"}
  ```

